import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright-core';
import { findBrowser } from '../src/shot/screenshot.js';
import { startDaemon, type DaemonHandle } from '../src/web/daemon.js';
import { sendRequest } from '../src/web/client.js';

/**
 * 自动关窗回归（真实 Chromium + 构建产物 ui/dist）。
 *
 * 规矩来自 operator 2026-11-14：全收工了就该倒计时把窗口自己关掉，人要做的只是走开。
 * 关窗只有对「**只有一条历史**的标签」才被浏览器允许，所以这里不走 `browser.newPage()`
 * （它先停在 about:blank，history 已经是 2），而是照 daemon 的真实路径：
 * 让浏览器自己按 URL 打开，再用 CDP 接管。倒计时的 1s tick 注入成 200ms，用例不用真等 10s。
 */

const browserPath = findBrowser();
const uiDist = join(import.meta.dirname, '../ui/dist/index.html');
const canRun = browserPath !== null && existsSync(uiDist);
const browserDescribe = canRun ? describe : describe.skip;

const PROJECT = 'leave-test';
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let home: string;
let dir: string;

/** 每个用例一份干净的 daemon：上一个用例会把它关掉（这正是被测行为） */
interface Fixture {
  daemon: DaemonHandle;
  base: string;
  close: () => Promise<void>;
}

async function boot(): Promise<Fixture> {
  const daemon = await startDaemon({
    port: 0,
    idleTimeoutMs: 10 * 60_000,
    // daemon 侧兜底要晚于前端 10s 倒计时，否则它会先退出，前端就没机会自己关窗
    emptyBrowserMs: 60_000,
    idleCheckMs: 1_000,
    quiet: true,
  });
  await sendRequest({ kind: 'watch', project: PROJECT, dir });
  return {
    daemon,
    base: `http://127.0.0.1:${daemon.port}`,
    close: async () => {
      await daemon.close().catch(() => {});
    },
  };
}

interface LiveTab {
  page: Page;
  cleanup: () => Promise<void>;
}

/** 让浏览器自己打开查看器（标签只有一条历史），再接管它 */
async function openTab(url: string): Promise<LiveTab> {
  if (browserPath === null) throw new Error('没有 Chromium');
  const profile = mkdtempSync(join(tmpdir(), 'paintress-leave-chrome-'));
  const port = 9200 + Math.floor(Math.random() * 600);
  const proc = spawn(
    browserPath,
    [
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${port}`,
      '--headless=new',
      '--no-first-run',
      '--no-default-browser-check',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      url,
    ],
    { stdio: 'ignore', detached: true },
  );
  proc.unref();

  let browser: Browser | null = null;
  for (let i = 0; i < 60 && browser === null; i++) {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    } catch {
      await sleep(200);
    }
  }
  if (browser === null) throw new Error('Chrome 的 CDP 端口没有起来');

  let page: Page | null = null;
  for (let i = 0; i < 40 && page === null; i++) {
    for (const ctx of browser.contexts()) {
      for (const candidate of ctx.pages()) {
        if (candidate.url().startsWith('http://127.0.0.1:')) page = candidate;
      }
    }
    if (page === null) await sleep(150);
  }
  if (page === null) throw new Error('没有找到查看器标签');

  return {
    page,
    cleanup: async () => {
      await browser?.close().catch(() => {});
      if (proc.pid !== undefined) {
        try {
          process.kill(-proc.pid, 'SIGKILL'); // detached 起的，杀掉整个进程组
        } catch {
          /* 已经退了 */
        }
      }
      rmSync(profile, { recursive: true, force: true });
    },
  };
}

/**
 * 关窗倒计时是 1s tick：注入成 200ms，用例才不用真等 10s。
 * 这些回调在浏览器里跑，而本仓 tsconfig 是 Node-only（lib 无 DOM）——
 * 所以取页面全局对象时就地断言成 any，类型在序列化前就被擦掉了。
 */
async function speedUpCountdown(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = globalThis as any;
    const real = w.setInterval.bind(w);
    w.setInterval = (fn: () => void, ms?: number) => real(fn, ms === 1000 ? 200 : ms);
  });
}

browserDescribe('查看器自动关窗', () => {
  beforeAll(() => {
    if (!canRun) return;
    home = mkdtempSync(join(tmpdir(), 'paintress-leave-home-'));
    process.env['PAINTRESS_HOME'] = home;
    dir = mkdtempSync(join(tmpdir(), 'paintress-leave-proj-'));
    copyFileSync(join(import.meta.dirname, 'fixtures/basic.pen'), join(dir, 'design.ptr'));
  }, 60_000);

  afterAll(() => {
    if (!canRun) return;
    rmSync(home, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
    delete process.env['PAINTRESS_HOME'];
  });

  it('daemon 自己关掉 → 倒计时卡片 → 标签自己关掉', async () => {
    const fx = await boot();
    const tab = await openTab(`${fx.base}/${PROJECT}?file=design.ptr`);
    try {
      await tab.page.waitForSelector('.toolbar', { timeout: 15_000 });
      await speedUpCountdown(tab.page);
      const closed = tab.page.waitForEvent('close', { timeout: 10_000 });

      await fetch(`${fx.base}/api/shutdown`, { method: 'POST', headers: { 'x-paintress': '1' } });

      // 卡片先出现（服务已关闭），再自己关窗
      await tab.page.waitForSelector('.countdown', { timeout: 3_000 });
      expect(await tab.page.locator('.countdown h3').textContent()).toMatch(/Server stopped|服务已关闭/);
      await closed;
    } finally {
      await tab.cleanup();
      await fx.close();
    }
  }, 30_000);

  it('最后一个项目被收走 → 倒计时卡片 → 标签自己关掉', async () => {
    const fx = await boot();
    const tab = await openTab(`${fx.base}/${PROJECT}?file=design.ptr`);
    try {
      await tab.page.waitForSelector('.toolbar', { timeout: 15_000 });
      await speedUpCountdown(tab.page);
      const closed = tab.page.waitForEvent('close', { timeout: 10_000 });

      await fetch(`${fx.base}/api/projects/${encodeURIComponent(PROJECT)}`, {
        method: 'DELETE',
        headers: { 'x-paintress': '1' },
      });

      await tab.page.waitForSelector('.countdown', { timeout: 3_000 });
      expect(await tab.page.locator('.countdown h3').textContent()).toMatch(/No active projects|无激活项目/);
      await closed;
      // 人走开了，进程也不该留着
      await fx.daemon.close();
    } finally {
      await tab.cleanup();
      await fx.close();
    }
  }, 30_000);

  it('标签有浏览历史（关不掉）→ 停在说明态并说清原因', async () => {
    const fx = await boot();
    const tab = await openTab(`${fx.base}/${PROJECT}?file=design.ptr`);
    try {
      await tab.page.waitForSelector('.toolbar', { timeout: 15_000 });
      // 把 history 顶到 2：浏览器从此不允许脚本关它（这正是「关不掉」的真实原因）
      await tab.page.evaluate(() => (globalThis as any).history.pushState(null, '', '/elsewhere'));
      expect(await tab.page.evaluate(() => (globalThis as any).history.length as number)).toBeGreaterThan(1);
      await speedUpCountdown(tab.page);

      await fetch(`${fx.base}/api/shutdown`, { method: 'POST', headers: { 'x-paintress': '1' } });

      // 倒计时跑完 → 关窗失败 → 换成说明态（600ms 后才换文案，等等它）
      await tab.page.waitForSelector('.countdown.closed', { timeout: 6_000 });
      await tab.page.waitForFunction(
        () => {
          const doc = (globalThis as any).document as {
            querySelector: (sel: string) => { textContent: string | null } | null;
          };
          return /浏览器不允许|blocked the automatic close/.test(
            doc.querySelector('.countdown.closed .modal-body')?.textContent ?? '',
          );
        },
        undefined,
        { timeout: 6_000 },
      );
      // 页面还活着（关不掉是预期，不是 bug），而且已经说清了原因
      expect(await tab.page.evaluate(() => (globalThis as any).document.title as string)).not.toBe('');
    } finally {
      await tab.cleanup();
      await fx.close();
    }
  }, 30_000);
});
