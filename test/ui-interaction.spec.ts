import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright-core';
import { findBrowser } from '../src/shot/screenshot.js';
import { startDaemon, type DaemonHandle } from '../src/web/daemon.js';
import { sendRequest } from '../src/web/client.js';
import { COMPONENTS_FILE, PRESET_FILE, setPreset } from '../src/doc/project.js';
import { TOOLS } from '../src/mcp/tools.js';

/**
 * 查看器交互回归（真实 Chromium + 构建产物 ui/dist）：
 * 笔记抽屉、浮动工具条、预设面板、组件画廊——都是纯前端行为，只能真点一遍。
 * 没有 Chromium 或没构建前端时 skip（CI 会先 pnpm build）。
 */

const browserPath = findBrowser();
const uiDist = join(import.meta.dirname, '../ui/dist/index.html');
const canRun = browserPath !== null && existsSync(uiDist);
const browserDescribe = canRun ? describe : describe.skip;

const PROJECT = 'ui-test';

let home: string;
let dir: string;
let daemon: DaemonHandle;
let browser: Browser | undefined;

beforeAll(async () => {
  if (!canRun) return;
  home = mkdtempSync(join(tmpdir(), 'paintress-ui-home-'));
  process.env['PAINTRESS_HOME'] = home;
  dir = mkdtempSync(join(tmpdir(), 'paintress-ui-proj-'));
  copyFileSync(join(import.meta.dirname, 'fixtures/basic.pen'), join(dir, 'design.ptr'));
  writeFileSync(join(dir, 'design.md'), '# 设计说明\n\n这一版把**主色**压暗了一档。\n\n- 待定：图标\n');
  // 快速切换要至少两份设计稿
  copyFileSync(join(import.meta.dirname, 'fixtures/basic.pen'), join(dir, 'second.ptr'));
  // 多画板稿：画板条与单帧导出控件
  copyFileSync(join(import.meta.dirname, 'fixtures/boards.pen'), join(dir, 'boards.ptr'));
  // 负坐标 + 自动高度画板：画布盒子装不下内容时的剪切回归
  copyFileSync(join(import.meta.dirname, 'fixtures/offscreen.pen'), join(dir, 'offscreen.ptr'));
  // ref.descendants 是对象映射：属性面板要统计覆写条数
  writeFileSync(
    join(dir, 'refs.ptr'),
    JSON.stringify({
      version: '2.22',
      fileToken: '00000000-0000-4000-8000-0000000000dd',
      children: [
        {
          type: 'frame', id: 'button', reusable: true, x: 0, y: 0, width: 100, height: 40,
          children: [{ type: 'text', id: 'label', content: 'Button', fontSize: 14 }],
        },
        {
          type: 'ref', id: 'instance', ref: 'button', x: 160, y: 0, width: 100, height: 40,
          descendants: { label: { content: 'Go' } },
        },
      ],
    }),
  );
  daemon = await startDaemon({ port: 0, idleTimeoutMs: 10 * 60_000, idleCheckMs: 5_000, quiet: true });
  await sendRequest({ kind: 'watch', project: PROJECT, dir });
  setPreset(dir, { key: 'color-brand', type: 'color', value: '#3B82F6', name: '主色' });
  writeFileSync(
    join(dir, COMPONENTS_FILE),
    JSON.stringify(
      {
        version: '2.22',
        fileToken: '00000000-0000-4000-8000-000000000003',
        variables: {},
        children: [
          { type: 'frame', id: 'cmp-btn', name: 'Button / Primary', reusable: true, width: 120, height: 40, fill: '$color-brand' },
        ],
        'x-paintress': { spec: '1', components: { version: 1 } },
      },
      null,
      2,
    ),
  );
  browser = await chromium.launch({
    executablePath: browserPath!,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  if (daemon !== undefined) await daemon.close();
  if (home !== undefined) rmSync(home, { recursive: true, force: true });
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  delete process.env['PAINTRESS_HOME'];
});

async function openViewer(): Promise<Page> {
  if (browser === undefined) throw new Error('浏览器未就绪（beforeAll 未完成）');
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`http://127.0.0.1:${daemon.port}/${PROJECT}?file=design.ptr`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.notes-toggle', { timeout: 15_000 });
  return page;
}

async function widthOf(page: Page, selector: string): Promise<number> {
  const box = await page.locator(selector).boundingBox();
  if (box === null) throw new Error(`找不到元素：${selector}`);
  return box.width;
}

async function until(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (check()) return;
    if (Date.now() > deadline) throw new Error(`等待超时（${timeoutMs}ms）`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** 等标签页标题变成期望值；超时就把实际标题返回给断言，失败信息里能直接看出差在哪 */
async function titleBecomes(page: Page, want: string, timeoutMs = 15_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let seen = await page.title();
  while (seen !== want && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
    seen = await page.title();
  }
  return seen;
}

browserDescribe('查看器交互（真实浏览器）', () => {
  it('笔记抽屉：打开收窄画布、图标消失、关闭恢复', async () => {
    const page = await openViewer();
    try {
      const before = await widthOf(page, '.canvas-wrap');
      await page.locator('.notes-toggle').click();
      await page.waitForSelector('.notes-panel');
      await page.waitForSelector('.markdown h1');
      expect(await page.locator('.markdown h1').innerText()).toContain('设计说明');
      // 抽屉固定 380 + gap 12：画布明显收窄
      const after = await widthOf(page, '.canvas-wrap');
      expect(after).toBeLessThan(before - 300);
      expect(await page.locator('.notes-toggle').count()).toBe(0);

      await page.locator('.notes-panel .panel-close').click();
      await page.waitForSelector('.notes-toggle');
      const restored = await widthOf(page, '.canvas-wrap');
      expect(restored).toBeGreaterThan(after + 300);
    } finally {
      await page.close();
    }
  });

  it('属性面板：点节点出只读字段，点空白收起', async () => {
    const page = await openViewer();
    try {
      await page.frameLocator('.preview').locator('[data-node-id="title"]').click();
      await page.waitForSelector('.inspector-panel');
      const text = await page.locator('.inspector-panel').innerText();
      // 标识 + 文本 + 变量解引用都要看得见
      expect(text).toContain('title');
      expect(text).toContain('Paintress');
      expect(text).toContain('$accent');
      expect(text).toContain('#6BA3FF');
      // 只读：面板里不该有输入控件
      expect(await page.locator('.inspector-panel input, .inspector-panel textarea, .inspector-panel select').count()).toBe(0);
      // 面板与选中同步：换选 card，内容跟着换（圆角四元组是数组，要能读出来）
      await page.frameLocator('.preview').locator('[data-node-id="card"]').click();
      await page.waitForFunction(
        () => ((globalThis as any).document.querySelector('.inspector-panel')?.textContent ?? '').includes('cornerRadius'),
        undefined,
        { timeout: 5000 },
      );
      expect(await page.locator('.inspector-panel').innerText()).toContain('card');
      // 点空白：选中清空、面板收起
      await page.frameLocator('.preview').locator('body').click({ position: { x: 2, y: 2 } });
      await page.waitForSelector('.inspector-panel', { state: 'detached' });
    } finally {
      await page.close();
    }
  });

  it('属性面板：ref.descendants 按对象键数显示覆写条数', async () => {
    if (browser === undefined) throw new Error('浏览器未就绪');
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    try {
      await page.goto(`http://127.0.0.1:${daemon.port}/${PROJECT}?file=refs.ptr`, { waitUntil: 'domcontentloaded' });
      await page.frameLocator('.preview').locator('[data-node-id="instance"]').click();
      await page.waitForSelector('.inspector-panel .insp-note');
      expect(await page.locator('.inspector-panel .insp-note').innerText()).toMatch(/1/);
    } finally {
      await page.close();
    }
  });

  it('快速切换：Ctrl+K 过滤 + Enter 打开，不新增浏览历史', async () => {
    const page = await openViewer();
    try {
      const before = await page.evaluate(() => (globalThis as any).history.length as number);
      await page.keyboard.press('Control+k');
      await page.waitForSelector('.qs-input');
      await page.locator('.qs-input').fill('second');
      await page.locator('.qs-input').press('Enter');
      await page.waitForSelector('.qs-list', { state: 'detached' });
      expect(page.url()).toContain('second.ptr');
      // 单历史标签才允许页面自己关窗：切换不能 push 历史
      expect(await page.evaluate(() => (globalThis as any).history.length as number)).toBe(before);
      // 侧栏选中态跟着走
      expect(await page.locator('.files .item.active').innerText()).toContain('second.ptr');

      // Esc 关掉，不切换
      await page.keyboard.press('Control+k');
      await page.waitForSelector('.qs-input');
      await page.keyboard.press('Escape');
      await page.waitForSelector('.qs-list', { state: 'detached' });
      expect(page.url()).toContain('second.ptr');

      // 无匹配时给空态，Enter 不误开
      await page.keyboard.press('Control+k');
      await page.locator('.qs-input').fill('zzzz');
      await page.waitForSelector('.qs-empty');
      await page.locator('.qs-input').press('Enter');
      expect(page.url()).toContain('second.ptr');

      // 焦点在 iframe 文档里时，Ctrl+K 仍然打开（事件不会冒泡到父 window）
      await page.keyboard.press('Escape');
      await page.frameLocator('.preview').locator('body').click({ position: { x: 2, y: 2 } });
      await page.keyboard.press('Control+k');
      await page.waitForSelector('.qs-input');

      // Tab 到结果按钮后，↑↓ / Enter 仍由容器接管，不是只在输入框可用
      await page.locator('.qs-input').fill('design');
      await page.keyboard.press('Tab');
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
      await page.waitForSelector('.qs-list', { state: 'detached' });
      expect(page.url()).toContain('design.ptr');
    } finally {
      await page.close();
    }
  });

  it('单帧导出：选中具体画板才出现倍率与导出按钮', async () => {
    if (browser === undefined) throw new Error('浏览器未就绪');
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
    try {
      await page.goto(`http://127.0.0.1:${daemon.port}/${PROJECT}?file=boards.ptr`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.boardbar');
      // 「全部」选中时不出导出控件（导出的是某一帧，不是整张画布）
      expect(await page.locator('.boardbar-export').count()).toBe(0);
      await page.locator('.boardbar .board').nth(1).click();
      await page.waitForSelector('.boardbar-export');
      const scale = page.locator('.boardbar-export select');
      expect(await scale.inputValue()).toBe('1');
      expect(await scale.locator('option').count()).toBe(3); // 0.5 / 1 / 2
      await scale.selectOption('2');
      expect(await page.evaluate(() => (globalThis as any).localStorage.getItem('paintress:export-scale'))).toBe('2');

      // 真下载一次：Content-Disposition 让浏览器保存文件，不导航、不加历史
      const historyBefore = await page.evaluate(() => (globalThis as any).history.length as number);
      const downloadEvent = page.waitForEvent('download');
      await page.locator('.boardbar-export button').click();
      const download = await downloadEvent;
      expect(download.suggestedFilename()).toContain('@2x.png');
      expect(await page.evaluate(() => (globalThis as any).history.length as number)).toBe(historyBefore);

      // 回到「全部」→ 控件收起
      await page.locator('.boardbar .board').nth(0).click();
      await page.waitForSelector('.boardbar-export', { state: 'detached' });
    } finally {
      await page.close();
    }
  });

  it('单画板文件：画板条与导出控件仍然在，只省掉「全部」', async () => {
    if (browser === undefined) throw new Error('浏览器未就绪');
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
    try {
      await page.goto(`http://127.0.0.1:${daemon.port}/${PROJECT}?file=design.ptr`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.boardbar');
      // 唯一的画板自动选中：条上只有它一个，「全部」不出现
      expect(await page.locator('.boardbar .board').count()).toBe(1);
      expect(await page.locator('.board-all').count()).toBe(0);
      expect(await page.locator('.boardbar .board.active').count()).toBe(1);
      // 导出倍率与按钮常驻，不需要先点一下画板
      await page.waitForSelector('.boardbar-export');
      expect(await page.locator('.boardbar-export select option').count()).toBe(3);

      const downloadEvent = page.waitForEvent('download');
      await page.locator('.boardbar-export button').click();
      const download = await downloadEvent;
      expect(download.suggestedFilename()).toMatch(/\.png$/);
    } finally {
      await page.close();
    }
  });

  it('负坐标 / 自动高度画板：平移进来的画板不被切掉，适配覆盖全部画板', async () => {
    if (browser === undefined) throw new Error('浏览器未就绪');
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      await page.goto(`http://127.0.0.1:${daemon.port}/${PROJECT}?file=offscreen.ptr`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.boardbar');

      // 剪切盒只能由根元素提供：body 的盒子就是 .ptr-canvas 的盒子（负坐标 / 自动高度上装不下内容），
      // 让它继续承担 overflow:hidden 就会把平移进视野的画板切掉。
      const overflow = await page.evaluate(() => {
        const w = globalThis as any;
        const doc = w.document.querySelector('iframe.preview').contentDocument;
        const overflowOf = (el: any): string => w.getComputedStyle(el).overflow;
        return [overflowOf(doc.documentElement), overflowOf(doc.body)];
      });
      expect(overflow[0]).toBe('hidden'); // 根元素吃掉溢出 → 不出滚动条
      expect(overflow[1]).not.toBe('hidden');

      // 「全部」按画板实测盒的并集适配：负坐标那块也要落在视野内
      await page.locator('.board-all').click();
      await page.waitForTimeout(300);
      const fitted = await page.evaluate(() => {
        const w = globalThis as any;
        const doc = w.document.querySelector('iframe.preview').contentDocument;
        const view = { w: doc.documentElement.clientWidth as number, h: doc.documentElement.clientHeight as number };
        const boards = Array.from(doc.querySelectorAll('[data-board]')) as any[];
        return boards.map((el) => {
          const r = el.getBoundingClientRect();
          return {
            name: (el.dataset['nodeName'] ?? '') as string,
            inside: r.left >= -1 && r.top >= -1 && r.right <= view.w + 1 && r.bottom <= view.h + 1,
          };
        });
      });
      expect(fitted.map((b) => b.name)).toEqual(['负坐标画板', '自动高度画板']);
      expect(fitted.every((b) => b.inside)).toBe(true);

      // 聚焦负坐标画板：整块都能命中 —— 被切掉的部分连 elementFromPoint 都取不到
      await page.locator('.boardbar .board').nth(1).click();
      await page.waitForTimeout(400);
      const hits = await page.evaluate(() => {
        const w = globalThis as any;
        const doc = w.document.querySelector('iframe.preview').contentDocument;
        const board = doc.querySelector('[data-board]') as any;
        const r = board.getBoundingClientRect();
        return [0.5, 0.9, 0.98].map((f: number) => {
          const hit = doc.elementFromPoint(r.left + r.width / 2, r.top + r.height * f);
          return hit !== null && (board.contains(hit) as boolean);
        });
      });
      expect(hits).toEqual([true, true, true]);
    } finally {
      await page.close();
    }
  });

  it('浮动工具条：预设面板改值写回文件，组件画廊显示 tile', async () => {
    const page = await openViewer();
    try {
      const rail = page.locator('.rail-btn');
      expect(await rail.count()).toBe(3); // 属性 / 预设 / 组件

      await rail.nth(1).click();
      await page.waitForSelector('.preset-panel');
      const input = page.locator('.preset-panel .preset-value').first();
      await input.fill('#908030');
      await input.press('Enter');
      await until(() => readFileSync(join(dir, PRESET_FILE), 'utf8').includes('#908030'));

      // 工具条互斥：点组件 → 预设面板收起
      await rail.nth(2).click();
      await page.waitForSelector('.components-panel');
      expect(await page.locator('.preset-panel').count()).toBe(0);
      await page.waitForSelector('.components-panel .tile');
      expect(await page.locator('.components-panel .tile').count()).toBe(1);
      expect(await page.locator('.components-panel figcaption').first().innerText()).toContain('Button');

      // Esc 收起浮层
      await page.keyboard.press('Escape');
      await page.waitForSelector('.components-panel', { state: 'detached' });
    } finally {
      await page.close();
    }
  });

  it('变更高亮：agent 收工后撒高亮，金边立刻消失且不重渲染', async () => {
    // 先记一次变更，页面加载时 applyChanges 会把它画上
    await sendRequest({ kind: 'changes', path: join(dir, 'design.ptr'), ids: ['title'] });
    const page = await openViewer();
    try {
      const frame = page.frameLocator('.preview');
      let painted = false;
      for (let i = 0; i < 100 && !painted; i++) {
        painted = (await frame.locator('[data-node-id="title"][data-ptr-changed]').count()) > 0;
        if (!painted) await new Promise((r) => setTimeout(r, 100));
      }
      expect(painted, '页面加载后应该画上变更高亮').toBe(true);

      const out = (await TOOLS['paintress_clear_changes']!.run({ path: join(dir, 'design.ptr') })) as Record<string, unknown>;
      expect(out['ok']).toBe(true);

      let gone = false;
      for (let i = 0; i < 100 && !gone; i++) {
        gone = (await frame.locator('[data-ptr-changed]').count()) === 0;
        if (!gone) await new Promise((r) => setTimeout(r, 100));
      }
      expect(gone, '清除后金边应消失').toBe(true);
    } finally {
      await page.close();
    }
  }, 20_000);

  it('设计稿列表：改过的稿出金点，撒高亮后点灭、时间留下', async () => {
    // 先把上一轮遗留的写入记录清掉，免得「金点从哪来」说不清
    await sendRequest({ kind: 'clear-changes', project: PROJECT });
    // refs.ptr 退到两天前：超过 24 小时窗口，它的行不该有相对时间
    const stale = join(dir, 'refs.ptr');
    const twoDaysAgo = new Date(Date.now() - 48 * 3600_000);
    utimesSync(stale, twoDaysAgo, twoDaysAgo);

    const page = await openViewer();
    try {
      const row = (file: string) => page.locator('.section.files li', { hasText: file });
      expect(await page.locator('.section.files .dot.fresh').count()).toBe(0);
      await row('second.ptr').locator('.item-time').waitFor({ state: 'visible', timeout: 10_000 });
      expect(await row('refs.ptr').locator('.item-time').count()).toBe(0);

      // 不刷新页面：改一份老稿，它自己长出时间（目录 change → designs 事件）
      writeFileSync(stale, readFileSync(stale));
      await row('refs.ptr').locator('.item-time').waitFor({ state: 'visible', timeout: 10_000 });
      expect(await row('refs.ptr').locator('.item-time').innerText()).toMatch(/刚刚|just now/);

      // 写入记录 → 金点出现，与画布金边同源同 TTL
      await sendRequest({ kind: 'changes', path: join(dir, 'second.ptr'), ids: ['title'] });
      await row('second.ptr').locator('.dot.fresh').waitFor({ state: 'visible', timeout: 5000 });
      expect(await page.locator('.section.files .dot.fresh').count()).toBe(1);
      expect(await row('second.ptr').locator('.item-time.fresh').count()).toBe(1);

      // 撤高亮：点没了，时间文字还在（文件确实被写过）
      await sendRequest({ kind: 'clear-changes', project: PROJECT });
      await row('second.ptr').locator('.dot.fresh').waitFor({ state: 'detached', timeout: 5000 });
      expect(await row('second.ptr').locator('.item-time').count()).toBe(1);
      expect(await row('second.ptr').locator('.item-time.fresh').count()).toBe(0);
    } finally {
      await page.close();
    }
  }, 30_000);

  it('标签页标题：跟着当前设计稿走，不再只有 paintress', async () => {
    const page = await openViewer();
    try {
      // 默认壳的标题在打开设计稿后被客户端改写（多标签页里能认出是哪一张）
      expect(await titleBecomes(page, 'design.ptr · paintress')).toBe('design.ptr · paintress');
      await page.goto(`http://127.0.0.1:${daemon.port}/${PROJECT}?file=second.ptr`, { waitUntil: 'domcontentloaded' });
      expect(await titleBecomes(page, 'second.ptr · paintress')).toBe('second.ptr · paintress');
    } finally {
      await page.close();
    }
  });
});
