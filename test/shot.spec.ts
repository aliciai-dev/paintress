import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { screenshotPen, findBrowser, planShotScale, selectBoard, MAX_SHOT_EDGE } from '../src/shot/screenshot.js';
import type { BoardBox } from '../src/render/index.js';

/** PNG IHDR 里的宽高（字节 16/20，大端） */
function pngSize(buf: Buffer): { width: number; height: number } {
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

describe('倍率决策（纯函数）', () => {
  it('缺省 0.8：agent 自审图的默认值', () => {
    expect(planShotScale(undefined, 800, 600)).toEqual({ scale: 0.8, clamped: false, capped: false });
  });

  it('夹进 0.2–2：3x 会被压到 2x 并标记 clamped', () => {
    expect(planShotScale(3, 200, 200)).toEqual({ scale: 2, clamped: true, capped: false });
    expect(planShotScale(0.05, 200, 200).scale).toBe(0.2);
  });

  it('单边超过 8192 时等比压回，1x 的定义是画板设计尺寸', () => {
    const plan = planShotScale(2, 5000, 1000);
    expect(plan.scale).toBeCloseTo(MAX_SHOT_EDGE / 5000, 6);
    expect(plan.capped).toBe(true);
    // 压回后两边都不超上限
    expect(5000 * plan.scale).toBeLessThanOrEqual(MAX_SHOT_EDGE + 1e-6);
    expect(2 * 1000).toBeLessThanOrEqual(MAX_SHOT_EDGE);
  });

  it('本来就在范围内时不动它', () => {
    expect(planShotScale(0.5, 1600, 900)).toEqual({ scale: 0.5, clamped: false, capped: false });
  });
});

describe('画板选择子（纯函数）', () => {
  const boards: BoardBox[] = [
    { id: 'home', name: '首页', x: 0, y: 0, w: 800, h: 600 },
    { id: 'detail', name: '详情', x: 900, y: 0, w: 400, h: 300 },
    { id: 'ghost', x: 900, y: 400, w: 200, h: 200 },
  ];

  it('id 精确命中', () => {
    expect(selectBoard(boards, 'detail').id).toBe('detail');
  });

  it('name 精确命中（中文）', () => {
    expect(selectBoard(boards, '详情').id).toBe('detail');
  });

  it('模糊命中唯一时直接选中', () => {
    expect(selectBoard(boards, '首').id).toBe('home');
  });

  it('模糊命中多个报歧义并列候选，不猜', () => {
    expect(() => selectBoard(boards, 'o')).toThrow(/命中 2 个画板/); // home + ghost
    expect(() => selectBoard(boards, 'o')).toThrow(/home.*ghost|ghost.*home/);
  });

  it('无命中时列出可选画板', () => {
    expect(() => selectBoard(boards, 'zzz')).toThrow(/没有匹配/);
    expect(() => selectBoard(boards, 'zzz')).toThrow(/首页/);
  });

  it('空画布 / 空查询报错', () => {
    expect(() => selectBoard([], 'x')).toThrow(/没有画板/);
    expect(() => selectBoard(boards, '  ')).toThrow(/不能为空/);
  });
});

/**
 * 每个截图用例都要**启动一个 chromium**；CI runner 上的首次启动是冷启动
 * （下载解包后磁盘缓存为空），2026-11-12 实测约 26s。默认 5s / 旧的 30s 预算太紧，
 * 给到 60s：这只抬高「卡住」的上限，不改变用例自身的等待逻辑。
 */
const BROWSER_TIMEOUT_MS = 60_000;

const hasBrowser = findBrowser() !== null;
const d = describe;
if (!hasBrowser) {
  d.skip('截图（无浏览器，跳过）', () => it('noop', () => {}));
} else {
  let tmp: string;
  let penFile: string;
  let boardsPen: string;
  let pngFile: string;

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'paintress-shot-test-'));
    penFile = join(tmp, 'w.pen');
    boardsPen = join(tmp, 'boards.pen');
    pngFile = join(tmp, 'out.png');
    copyFileSync(join(import.meta.dirname, 'fixtures/basic.pen'), penFile);
    copyFileSync(join(import.meta.dirname, 'fixtures/boards.pen'), boardsPen);
  });
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  d('截图', () => {
    it('整画布 PNG：文件存在且为 PNG 魔数，尺寸 = 画布 × scale', async () => {
      const res = await screenshotPen(penFile, pngFile, { scale: 2, settleMs: 200 });
      expect(res.canvas).toEqual({ width: 800, height: 600 });
      expect(existsSync(pngFile)).toBe(true);
      const buf = readFileSync(pngFile);
      expect(buf.length).toBeGreaterThan(1000);
      // PNG 魔数 89 50 4E 47
      expect(buf[0]).toBe(0x89);
      expect(buf[1]).toBe(0x50);
      expect(buf[2]).toBe(0x4e);
      expect(buf[3]).toBe(0x47);
    }, BROWSER_TIMEOUT_MS);

    it('不给 scale → 0.8x（agent 默认审图规格）', async () => {
      const out = join(tmp, 'out-default.png');
      const res = await screenshotPen(penFile, out, { settleMs: 200 });
      expect(res.scale).toBe(0.8);
      expect(pngSize(readFileSync(out))).toEqual({ width: 640, height: 480 });
    }, BROWSER_TIMEOUT_MS);

    it('scale=1 时产物更小', async () => {
      const png1 = join(tmp, 'out1.png');
      await screenshotPen(penFile, png1, { scale: 1, settleMs: 200 });
      expect(readFileSync(png1).length).toBeLessThan(readFileSync(pngFile).length);
    }, BROWSER_TIMEOUT_MS);

    it('按画板 id 截图：产物尺寸 = 画板尺寸 × scale', async () => {
      const out = join(tmp, 'board-detail.png');
      const res = await screenshotPen(boardsPen, out, { board: 'detail', scale: 1, settleMs: 200 });
      expect(res.board).toEqual({ id: 'detail', name: '详情', x: 900, y: 0, width: 400, height: 300 });
      expect(res.canvas).toEqual({ width: 1300, height: 600 }); // 整张画布仍是三个画板的并集
      expect(pngSize(readFileSync(out))).toEqual({ width: 400, height: 300 });
    }, BROWSER_TIMEOUT_MS);

    it('按画板 name 截图（中文）', async () => {
      const out = join(tmp, 'board-home.png');
      const res = await screenshotPen(boardsPen, out, { board: '首页', scale: 1, settleMs: 200 });
      expect(res.board?.id).toBe('home');
      expect(pngSize(readFileSync(out))).toEqual({ width: 800, height: 600 });
    }, BROWSER_TIMEOUT_MS);

    it('未命名画板用 id 选中', async () => {
      const out = join(tmp, 'board-ghost.png');
      const res = await screenshotPen(boardsPen, out, { board: 'ghost', scale: 2, settleMs: 200 });
      expect(res.board).toMatchObject({ id: 'ghost', width: 200, height: 200 });
      expect(pngSize(readFileSync(out))).toEqual({ width: 400, height: 400 }); // 2x
    }, BROWSER_TIMEOUT_MS);

    it('画板名歧义时报错，不产出文件', async () => {
      const out = join(tmp, 'board-ambiguous.png');
      await expect(screenshotPen(boardsPen, out, { board: 'o', settleMs: 200 })).rejects.toThrow(/命中/);
      expect(existsSync(out)).toBe(false);
    }, BROWSER_TIMEOUT_MS);
  });
}
