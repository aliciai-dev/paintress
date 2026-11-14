import { existsSync, mkdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { readdirSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { renderDocument, type BoardBox } from '../render/index.js';
import { loadDoc } from '../doc/io.js';
import { applyProjectPresets, findProjectRoot, projectFontRegistry } from '../doc/project.js';
import { isGenericFamily, planFonts, splitFontStack } from '../doc/fonts.js';
import { pathToFileURL } from 'node:url';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

/**
 * 截图层：渲染 → 临时 HTML → headless Chromium → PNG（决策 3：两个消费者分开，AI 要 PNG）。
 * 浏览器探测：PTR_BROWSER 环境变量 → 系统 chrome → playwright 浏览器缓存。
 */

export function findBrowser(): string | null {
  const env = process.env['PTR_BROWSER'];
  if (env && existsSync(env)) return env;
  const candidates = [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  const cacheDir = join(homedir(), '.cache', 'ms-playwright');
  if (existsSync(cacheDir)) {
    const dirs = readdirSync(cacheDir)
      .filter((d) => d.startsWith('chromium-'))
      .sort((a, b) => b.localeCompare(a)); // 版本号大者优先（取最新）
    for (const d of dirs) {
      for (const rel of ['chrome-linux/chrome', 'chrome-linux64/chrome', 'chrome-headless-shell-linux64/chrome-headless-shell']) {
        const p = join(cacheDir, d, rel);
        if (existsSync(p)) return p;
      }
    }
  }
  return null;
}

export interface ShotOptions {
  /** 像素倍率：0.2–2，缺省 0.8（给 agent 自审图：看得清又不至于太大） */
  scale?: number;
  /** 等待毫秒（字体/图片加载），默认 120 */
  settleMs?: number;
  /** 只截某个画板（id 或 name；匹配规则见 selectBoard） */
  board?: string;
}

/** 单边像素上限：超出按比例压回，只为不把内存/临时文件吃爆 */
export const MAX_SHOT_EDGE = 8192;
/** agent 自审图的默认倍率 */
export const DEFAULT_SHOT_SCALE = 0.8;
/** 倍率下限：再小就看不清字了 */
export const MIN_SHOT_SCALE = 0.2;
/** 倍率上限：与查看器导出的 2x 对齐 */
export const MAX_SHOT_SCALE = 2;

export interface ScalePlan {
  /** 实际使用的倍率 */
  scale: number;
  /** 请求值被 [0.2, 2] 夹过 */
  clamped: boolean;
  /** 因 8192 上限被压过 */
  capped: boolean;
}

/**
 * 倍率决策：先夹进 [0.2, 2]，再按画布/画板的**设计尺寸**（1x 像素数）等比压进 8192。
 * 1x 的定义就是查看器里的 `1:1`——画板自身的像素尺寸，所以这里量的是 CSS px。
 */
export function planShotScale(requested: number | undefined, width: number, height: number): ScalePlan {
  const asked = requested !== undefined && Number.isFinite(requested) ? requested : DEFAULT_SHOT_SCALE;
  const clampedValue = Math.min(MAX_SHOT_SCALE, Math.max(MIN_SHOT_SCALE, asked));
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  const fit = Math.min(MAX_SHOT_EDGE / w, MAX_SHOT_EDGE / h);
  const scale = Math.min(clampedValue, fit);
  return { scale, clamped: clampedValue !== asked, capped: scale < clampedValue };
}

export interface ShotBoard {
  id: string;
  name?: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ShotResult {
  out: string;
  canvas: { width: number; height: number };
  /** 实际使用的倍率（请求值被夹/压后的结果） */
  scale: number;
  /** 按画板截图时命中的画板（未指定时为 undefined） */
  board?: ShotBoard;
  warnings: string[];
  browser: string;
  /** 字体加载状态（与本次截图同一个浏览器）：missing 为探针判定不可用的 family */
  fonts?: { status: string; checked: string[]; missing: string[]; substituted: string[] };
}

function boardLabel(b: BoardBox): string {
  return b.name !== undefined && b.name !== '' ? `${b.name}(id=${b.id})` : b.id;
}

/**
 * 画板选择子：id 精确 → name 精确 → name/id 模糊（不区分大小写）。
 * 模糊命中多个时报歧义并列出候选，不猜——猜错会让 AI 以为看到了另一页。
 */
export function selectBoard(boards: readonly BoardBox[], query: string): BoardBox {
  if (boards.length === 0) throw new Error('设计稿没有画板（顶层节点为空），无法按画板截图');
  const q = query.trim();
  if (q === '') throw new Error('board 参数不能为空');

  const byId = boards.filter((b) => b.id === q);
  if (byId.length === 1) return byId[0] as BoardBox;
  const byName = boards.filter((b) => b.name === q);
  if (byName.length === 1) return byName[0] as BoardBox;

  const lower = q.toLowerCase();
  const fuzzy = boards.filter(
    (b) => b.id.toLowerCase().includes(lower) || (b.name ?? '').toLowerCase().includes(lower),
  );
  if (fuzzy.length === 1) return fuzzy[0] as BoardBox;
  const all = boards.map(boardLabel).join('、');
  if (fuzzy.length === 0) throw new Error(`没有匹配「${q}」的画板；可选：${all}`);
  throw new Error(`「${q}」命中 ${fuzzy.length} 个画板，请写更精确的名字或 id：${fuzzy.map(boardLabel).join('、')}`);
}

/** 渲染并截图整张画布；指定 board 时只裁该画板（走同一套渲染与浏览器） */
export async function screenshotPen(penPath: string, outPng: string, opts: ShotOptions = {}): Promise<ShotResult> {
  const browserPath = findBrowser();
  if (!browserPath) {
    throw new Error('未找到可用浏览器：安装 Chromium/Chrome，或设置 PTR_BROWSER 指向可执行文件');
  }
  const loaded = loadDoc(penPath);
  // 项目预设与字体：截图必须与查看器看到的一致（字体走 file://，不需要起 HTTP 服务）
  const root = findProjectRoot(penPath) ?? dirname(resolve(penPath));
  const { registry: fontRegistry } = projectFontRegistry(penPath);
  const fontPlan = planFonts(fontRegistry, (source) =>
    source.target === undefined ? null : pathToFileURL(resolve(root, source.target)).href,
  );
  const rendered = renderDocument(applyProjectPresets(loaded.doc, penPath).doc, { fonts: fontPlan });
  const probeFamilies = [
    ...new Set([
      ...Object.keys(fontRegistry.families),
      ...splitFontStack(fontPlan.defaultStack).filter((family) => !isGenericFamily(family)),
    ]),
  ];
  const target = opts.board !== undefined ? selectBoard(rendered.boards, opts.board) : undefined;
  // 只有「显式存了尺寸」的画板才能在开浏览器前判定为 0；自动尺寸的板子要进去量了才知道
  const tmpDir = mkdtempSync(join(tmpdir(), 'paintress-shot-'));
  const htmlPath = join(tmpDir, 'page.html');
  writeFileSync(htmlPath, rendered.html, 'utf8');
  let clip: { x: number; y: number; width: number; height: number };
  let measuredBoard: BoardBox | undefined;
  let usedScale: number = DEFAULT_SHOT_SCALE;
  let fontsReport: { status: string; checked: string[]; missing: string[] } | undefined;
  const extraWarnings: string[] = [];
  // 字体分片只下一次：给 Chromium 一个持久磁盘缓存，而不是每次截图重建上下文重拉
  const cacheDir = join(process.env['PAINTRESS_HOME'] ?? join(homedir(), '.paintress'), 'chromium-cache');
  try {
    mkdirSync(cacheDir, { recursive: true });
  } catch {
    /* 缓存目录建不了就退回默认 */
  }
  try {
    const browser = await chromium.launch({
      executablePath: browserPath,
      args: [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        `--disk-cache-dir=${cacheDir}`,
        '--disk-cache-size=67108864',
      ],
    });
    try {
      // 倍率先按声明尺寸估一版（自动尺寸的板子要进去量了才知道），量完再按真实 clip 收口
      const initial = planShotScale(opts.scale, rendered.canvas.width || 1, rendered.canvas.height || 1);
      // 先给一个够大的视野：自动尺寸的板子（h 未存）只有浏览器知道真实大小
      const page = await browser.newPage({
        viewport: {
          width: Math.max(800, rendered.canvas.width, target !== undefined ? Math.ceil(target.x + 3200) : 0),
          height: Math.max(600, rendered.canvas.height, target !== undefined ? Math.ceil(target.y + 3200) : 0),
        },
        deviceScaleFactor: initial.scale,
      });
      await page.goto(`file://${htmlPath}`);
      // 字体先就绪（3s 超时）：网络字体没加载完就测量/截图会抖
      const fontsScript = `(async () => {
        const families = ${JSON.stringify(probeFamilies)};
        const wait = new Promise((r) => setTimeout(r, 3000));
        if (window.__paintressFontsReady) await Promise.race([window.__paintressFontsReady, wait]);
        else if (document.fonts && document.fonts.ready) await Promise.race([document.fonts.ready, wait]);
        if (!document.fonts) return { status: 'n/a', checked: families, missing: [] };
        const c = document.createElement('canvas').getContext('2d');
        const text = '漢字Abc123 光伴';
        const w = (f, b) => { c.font = '32px "' + f + '", ' + b; return c.measureText(text).width; };
        const sb = w('__paintress_missing__', 'serif');
        const mb = w('__paintress_missing__', 'monospace');
        const missing = families.filter((f) => Math.abs(w(f, 'serif') - sb) < 0.5 && Math.abs(w(f, 'monospace') - mb) < 0.5);
        return { status: document.fonts.status, checked: families, missing };
      })()`;
      fontsReport = (await page.evaluate(fontsScript)) as { status: string; checked: string[]; missing: string[] };
      await page.waitForTimeout(opts.settleMs ?? 120);
      // 用字符串表达式：src 侧没有 DOM 类型库，也不需要为测量引入一份
      const measuredScript = `(() => {
        const canvasEl = document.querySelector('.ptr-canvas');
        const cr = canvasEl ? canvasEl.getBoundingClientRect() : null;
        const nodes = Array.from(document.querySelectorAll('[data-board]'));
        const boards = nodes.map((el) => {
          const r = el.getBoundingClientRect();
          return {
            id: el.getAttribute('data-node-id') || '',
            name: el.getAttribute('data-board-name') || undefined,
            x: cr ? r.left - cr.left : 0,
            y: cr ? r.top - cr.top : 0,
            w: r.width,
            h: r.height
          };
        });
        // 自动尺寸的设计稿常常撑出 .ptr-canvas 的固定宽高：以真实内容盒为准
        let contentW = cr ? cr.width : 0;
        let contentH = cr ? cr.height : 0;
        for (const b of boards) {
          contentW = Math.max(contentW, b.x + b.w);
          contentH = Math.max(contentH, b.y + b.h);
        }
        return { width: Math.ceil(contentW), height: Math.ceil(contentH), boards };
      })()`;
      const measured = (await page.evaluate(measuredScript)) as {
        width: number;
        height: number;
        boards: { id: string; name?: string; x: number; y: number; w: number; h: number }[];
      };

      const realTarget =
        target === undefined
          ? undefined
          : (measured.boards.find((b) => b.id === target.id) ?? undefined);
      if (realTarget !== undefined && target !== undefined) {
        if (realTarget.w <= 0 || realTarget.h <= 0) {
          throw new Error(`画板 ${boardLabel(target)} 尺寸为 0（${realTarget.w}×${realTarget.h}），无法截图`);
        }
        measuredBoard = {
          id: target.id,
          ...(target.name !== undefined ? { name: target.name } : {}),
          x: Math.round(realTarget.x),
          y: Math.round(realTarget.y),
          w: realTarget.w,
          h: realTarget.h,
        };
      } else if (target !== undefined) {
        if (target.w <= 0 || target.h <= 0) {
          throw new Error(`画板 ${boardLabel(target)} 尺寸为 0（${target.w}×${target.h}），无法截图`);
        }
        measuredBoard = { id: target.id, ...(target.name !== undefined ? { name: target.name } : {}), x: target.x, y: target.y, w: target.w, h: target.h };
      }

      const box = measuredBoard ?? { x: 0, y: 0, w: measured.width, h: measured.height };
      clip = {
        x: Math.max(0, Math.floor(box.x)),
        y: Math.max(0, Math.floor(box.y)),
        width: Math.max(1, Math.ceil(box.w)),
        height: Math.max(1, Math.ceil(box.h)),
      };
      // Playwright 的 clip 必须落在 viewport 内：量出来的内容比预估大时先扩视口
      const vp = page.viewportSize();
      const needW = clip.x + clip.width;
      const needH = clip.y + clip.height;
      if (vp === null || vp.width < needW || vp.height < needH) {
        await page.setViewportSize({
          width: Math.max(vp?.width ?? 0, needW),
          height: Math.max(vp?.height ?? 0, needH),
        });
        await page.waitForTimeout(20);
      }
      const plan = planShotScale(opts.scale, clip.width, clip.height);
      usedScale = plan.scale;
      if (plan.clamped) {
        extraWarnings.push(`倍率 ${String(opts.scale)} 超出 0.2–2，已按 ${plan.scale}x 输出`);
      }
      if (plan.capped) {
        extraWarnings.push(
          `画板 ${clip.width}×${clip.height}（1x）按 ${plan.scale.toFixed(2)}x 输出：单边超过 ${MAX_SHOT_EDGE} 上限，已等比压回`,
        );
      }
      if (Math.abs(plan.scale - initial.scale) > 1e-6) {
        // deviceScaleFactor 是 context 级的，改不了——换一页按收口后的倍率重截
        const finalVp = page.viewportSize();
        await page.close();
        const fitted = await browser.newPage({
          viewport: {
            width: Math.max(1, Math.ceil(finalVp?.width ?? clip.x + clip.width)),
            height: Math.max(1, Math.ceil(finalVp?.height ?? clip.y + clip.height)),
          },
          deviceScaleFactor: plan.scale,
        });
        try {
          await fitted.goto(`file://${htmlPath}`);
          await fitted.waitForTimeout(opts.settleMs ?? 120);
          await fitted.screenshot({ path: outPng, clip });
        } finally {
          await fitted.close();
        }
      } else {
        await page.screenshot({ path: outPng, clip });
      }
    } finally {
      await browser.close();
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
  const size = statSync(outPng).size;
  if (size === 0) throw new Error('截图产物为空文件');
  const canvas = { width: Math.max(rendered.canvas.width, clip.x + clip.width), height: Math.max(rendered.canvas.height, clip.y + clip.height) };
  const substituted = (fontsReport?.missing ?? []).filter((family) => fontPlan.previews[family] !== undefined);
  if (fontsReport !== undefined && fontsReport.missing.length > 0) {
    extraWarnings.push(
      `字体缺失：${fontsReport.missing.join('、')}${substituted.length > 0 ? `（用替代：${substituted.join('、')}）` : ''}`,
    );
  }
  const result: ShotResult = {
    out: outPng,
    canvas,
    scale: usedScale,
    warnings: [...rendered.warnings, ...extraWarnings],
    browser: browserPath,
    ...(fontsReport !== undefined ? { fonts: { ...fontsReport, substituted } } : {}),
  };
  if (measuredBoard !== undefined) {
    result.board = {
      id: measuredBoard.id,
      ...(measuredBoard.name !== undefined ? { name: measuredBoard.name } : {}),
      x: measuredBoard.x,
      y: measuredBoard.y,
      width: measuredBoard.w,
      height: measuredBoard.h,
    };
  }
  return result;
}
