import { copyFileSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findBrowser } from '../src/shot/screenshot.js';
import { startDaemon, type DaemonHandle } from '../src/web/daemon.js';
import { sendRequest } from '../src/web/client.js';

/**
 * 单帧导出（`GET /api/export`）回归：真实 Chromium + 真实 daemon。
 * 倍率只有 2x / 1x / 0.5x；1x 就是画板的设计像素（查看器里的 1:1）。
 * 没有浏览器就整组 skip（与其他截图用例一致）。
 */

const hasBrowser = findBrowser() !== null;
const d = hasBrowser ? describe : describe.skip;
const PROJECT = 'export-test';
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

/** PNG IHDR 的宽高（字节 16/20，大端） */
function pngSize(buf: Buffer): { width: number; height: number } {
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

d('单帧导出接口', () => {
  let home: string;
  let dir: string;
  let daemon: DaemonHandle;
  let base: string;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'paintress-export-home-'));
    process.env['PAINTRESS_HOME'] = home;
    dir = mkdtempSync(join(tmpdir(), 'paintress-export-proj-'));
    // boards.pen：home 800×600、detail(详情) 400×300、ghost 200×200
    copyFileSync(join(import.meta.dirname, 'fixtures/boards.pen'), join(dir, 'design.pen'));
    daemon = await startDaemon({ port: 0, idleTimeoutMs: 10 * 60_000, quiet: true });
    base = `http://127.0.0.1:${daemon.port}`;
    await sendRequest({ kind: 'watch', project: PROJECT, dir });
  }, 60_000);

  afterAll(async () => {
    await daemon?.close().catch(() => {});
    if (home !== undefined) rmSync(home, { recursive: true, force: true });
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    delete process.env['PAINTRESS_HOME'];
  });

  function exportUrl(params: string): string {
    return `${base}/api/export?${params}`;
  }

  it('2x：像素 = 画板 × 2，文件名带画板名与倍率', async () => {
    const res = await fetch(exportUrl(`project=${PROJECT}&path=design.pen&board=detail&scale=2`));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('image/png');
    expect(res.headers.get('content-disposition')).toContain('@2x.png');
    expect(res.headers.get('content-disposition')).toContain('%E8%AF%A6%E6%83%85'); // 「详情」的 utf-8 变体
    expect(res.headers.get('x-paintress-scale')).toBe('2');
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.subarray(0, 4).equals(PNG_MAGIC)).toBe(true);
    expect(pngSize(buf)).toEqual({ width: 800, height: 600 });
  }, 60_000);

  it('0.5x：像素 = 画板 × 0.5', async () => {
    const res = await fetch(exportUrl(`project=${PROJECT}&path=design.pen&board=detail&scale=0.5`));
    expect(res.status).toBe(200);
    const buf = Buffer.from(await res.arrayBuffer());
    expect(pngSize(buf)).toEqual({ width: 200, height: 150 });
  }, 60_000);

  it('倍率只认三档，其他值直接 400', async () => {
    const res = await fetch(exportUrl(`project=${PROJECT}&path=design.pen&board=detail&scale=1.5`));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/0\.5 \/ 1 \/ 2/);
  });

  it('画板不存在 → 400，并列出候选（不猜）', async () => {
    const res = await fetch(exportUrl(`project=${PROJECT}&path=design.pen&board=zzz&scale=1`));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/没有匹配/);
  });

  it('导出不碰设计稿（mtime 不变）', async () => {
    const file = join(dir, 'design.pen');
    const before = statSync(file).mtimeMs;
    const res = await fetch(exportUrl(`project=${PROJECT}&path=design.pen&board=home&scale=1`));
    expect(res.status).toBe(200);
    expect(statSync(file).mtimeMs).toBe(before);
  }, 60_000);
});
