import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright-core';
import { findBrowser } from '../src/shot/screenshot.js';
import { startDaemon, type DaemonHandle } from '../src/web/daemon.js';
import { sendRequest } from '../src/web/client.js';
import { COMPONENTS_FILE, PRESET_FILE, setPreset } from '../src/doc/project.js';

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
      // 回到「全部」→ 控件收起
      await page.locator('.boardbar .board').nth(0).click();
      await page.waitForSelector('.boardbar-export', { state: 'detached' });
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
});
