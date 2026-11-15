import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startDaemon, type DaemonHandle } from '../src/web/daemon.js';
import { sendRequest } from '../src/web/client.js';
import { CHANGE_TTL_MS, ChangesStore } from '../src/web/changes.js';
import { loadDoc } from '../src/doc/io.js';
import { collectIds } from '../src/doc/id.js';

/**
 * 写工具的通知是非阻塞的，测试不能再猜一个睡眠时长，也不能靠反复写来碰运气。
 * 这里只包装测试进程里的 sendRequest：保留真实 socket 往返，同时捕获通知 Promise，
 * 并把测试通知的超时放宽到 10s（生产端仍保持原有的 2s 尽力而为语义）。
 */
const sentNotifications = vi.hoisted(() => ({ changes: [] as Promise<unknown>[] }));
vi.mock('../src/web/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/web/client.js')>();
  const wrapped: typeof actual.sendRequest = (req, timeoutMs) => {
    const pending = actual.sendRequest(req, req.kind === 'changes' ? 10_000 : timeoutMs);
    if (req.kind === 'changes') sentNotifications.changes.push(pending);
    return pending;
  };
  return { ...actual, sendRequest: wrapped };
});

let home: string;
let daemon: DaemonHandle;
let baseUrl: string;
let projectDir: string;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'paintress-changes-'));
  process.env['PAINTRESS_HOME'] = home;
  projectDir = mkdtempSync(join(tmpdir(), 'paintress-changes-proj-'));
  copyFileSync(join(import.meta.dirname, 'fixtures/basic.pen'), join(projectDir, 'design.pen'));
  daemon = await startDaemon({ port: 0, idleTimeoutMs: 10 * 60_000, idleCheckMs: 60_000, quiet: true });
  baseUrl = `http://127.0.0.1:${daemon.port}`;
  await sendRequest({ kind: 'watch', project: 'chg', dir: projectDir });
});

afterAll(async () => {
  await daemon.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
  delete process.env['PAINTRESS_HOME'];
});

/**
 * 轮询直到条件成立（返回非 null），超时报错。
 * 写工具的通知是非阻塞的（notifyChanges 有 2s 超时），固定等待会在慢机器上偶发失败。
 */
async function until<T>(probe: () => Promise<T | null>, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const got = await probe();
    if (got !== null) return got;
    if (Date.now() > deadline) throw new Error(`等待超时：条件未在 ${timeoutMs}ms 内成立`);
    await new Promise((r) => setTimeout(r, 30));
  }
}

async function readChanges(path: string): Promise<{ ids: string[]; at: number }> {
  const http = await fetch(`${baseUrl}/api/changes?project=chg&path=${encodeURIComponent(path)}`);
  return (await http.json()) as { ids: string[]; at: number };
}

describe('socket changes → HTTP /api/changes', () => {
  it('绝对路径写入后，HTTP 能读到对应 ids', async () => {
    const res = await sendRequest({
      kind: 'changes',
      path: join(projectDir, 'design.pen'),
      ids: ['title', 'card'],
    });
    expect(res.ok).toBe(true);
    if (res.ok && 'recorded' in res) expect(res.recorded).toBe(2);

    const http = await fetch(`${baseUrl}/api/changes?project=chg&path=design.pen`);
    const body = (await http.json()) as { ok: boolean; ids: string[]; at: number };
    expect(body.ok).toBe(true);
    expect(body.ids.sort()).toEqual(['card', 'title']);
    expect(body.at).toBeGreaterThan(0);
  });

  it('clear-changes 按路径撤掉记录，HTTP 随即返回空', async () => {
    await sendRequest({ kind: 'changes', path: join(projectDir, 'design.pen'), ids: ['title'] });
    const before = await readChanges('design.pen');
    expect(before.ids).toContain('title');

    const cleared = await sendRequest({ kind: 'clear-changes', path: join(projectDir, 'design.pen') });
    expect(cleared.ok).toBe(true);
    if (cleared.ok && 'cleared' in cleared) expect(cleared.cleared).toBe(1);
    expect((await readChanges('design.pen')).ids).toEqual([]);
  });

  it('clear-changes 只清指定文件，同项目其它文件的高亮还在', async () => {
    await sendRequest({ kind: 'watch', project: 'chg', dir: projectDir });
    await sendRequest({ kind: 'changes', path: join(projectDir, 'design.pen'), ids: ['title'] });
    const other = join(projectDir, 'other.pen');
    copyFileSync(join(projectDir, 'design.pen'), other);
    await sendRequest({ kind: 'changes', path: other, ids: ['card'] });

    await sendRequest({ kind: 'clear-changes', path: join(projectDir, 'design.pen') });
    expect((await readChanges('design.pen')).ids).toEqual([]);
    expect((await readChanges('other.pen')).ids).toContain('card');
  });

  it('clear-changes 会向正在看这一页的浏览器推 changes-cleared', async () => {
    await sendRequest({ kind: 'changes', path: join(projectDir, 'design.pen'), ids: ['title'] });
    const controller = new AbortController();
    const stream = await fetch(
      `${baseUrl}/events?project=chg&path=${encodeURIComponent('design.pen')}`,
      { signal: controller.signal },
    );
    expect(stream.status).toBe(200);
    const reader = stream.body!.getReader();

    await sendRequest({ kind: 'clear-changes', path: join(projectDir, 'design.pen') });

    let seen = '';
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !seen.includes('changes-cleared')) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<{ value?: Uint8Array; done: boolean }>((r) => setTimeout(() => r({ done: true }), 500)),
      ]);
      if (chunk.value) seen += new TextDecoder().decode(chunk.value);
    }
    controller.abort();
    expect(seen).toContain('changes-cleared');
  });

  it('项目外的路径被忽略', async () => {
    const res = await sendRequest({ kind: 'changes', path: '/etc/passwd', ids: ['x'] });
    expect(res.ok).toBe(true);
    if (res.ok && 'recorded' in res) expect(res.recorded).toBe(0);
  });

  it('嵌套项目时记到最深根，而不是外层项目', async () => {
    // 外层项目 root=projectDir，内层项目 root=projectDir/sub
    const sub = join(projectDir, 'sub');
    const fs = await import('node:fs/promises');
    await fs.mkdir(sub, { recursive: true });
    copyFileSync(join(projectDir, 'design.pen'), join(sub, 'inner.pen'));
    await sendRequest({ kind: 'watch', project: 'chg-outer', dir: projectDir });
    await sendRequest({ kind: 'watch', project: 'chg-inner', dir: sub });

    const res = await sendRequest({ kind: 'changes', path: join(sub, 'inner.pen'), ids: ['title'] });
    expect(res.ok).toBe(true);

    const inner = (await (await fetch(`${baseUrl}/api/changes?project=chg-inner&path=inner.pen`)).json()) as { ids: string[] };
    const outer = (await (await fetch(`${baseUrl}/api/changes?project=chg-outer&path=sub/inner.pen`)).json()) as { ids: string[] };
    expect(inner.ids).toContain('title');
    expect(outer.ids).not.toContain('title'); // 不应落到外层项目
  });
});

describe('ChangesStore 合并与过期', () => {
  it('合并窗口内 ids 合并，不重复', () => {
    const store = new ChangesStore();
    store.record('p', 'a.ptr', ['a', 'b']);
    store.record('p', 'a.ptr', ['b', 'c']);
    expect(store.get('p', 'a.ptr')?.ids.sort()).toEqual(['a', 'b', 'c']);
  });

  it('过期后 get 返回 undefined', () => {
    const store = new ChangesStore();
    const rec = store.record('p', 'a.ptr', ['a']);
    rec.at = Date.now() - (CHANGE_TTL_MS + 60_000); // 越过 TTL（3 分钟）一分钟
    expect(store.get('p', 'a.ptr')).toBeUndefined();
  });

  it('未到 TTL 仍然可用（3 分钟窗口内刷新页面还能重新画上金边）', () => {
    const store = new ChangesStore();
    const rec = store.record('p', 'a.ptr', ['a']);
    rec.at = Date.now() - (CHANGE_TTL_MS - 60_000);
    expect(store.get('p', 'a.ptr')?.ids).toEqual(['a']);
  });

  it('clearFile 只清一个文件，不动同项目其它文件', () => {
    const store = new ChangesStore();
    store.record('p', 'a.ptr', ['a']);
    store.record('p', 'b.ptr', ['b']);
    expect(store.clearFile('p', 'a.ptr')).toBe(true);
    expect(store.get('p', 'a.ptr')).toBeUndefined();
    expect(store.get('p', 'b.ptr')?.ids).toEqual(['b']);
    expect(store.clearFile('p', 'a.ptr')).toBe(false);
  });

  it('prune 清理过期条目，保留新鲜条目', () => {
    const store = new ChangesStore();
    const old = store.record('p', 'old.ptr', ['a']);
    old.at = Date.now() - (CHANGE_TTL_MS + 60_000);
    store.record('p', 'fresh.ptr', ['b']);
    expect(store.prune()).toBe(1);
    expect(store.get('p', 'old.ptr')).toBeUndefined();
    expect(store.get('p', 'fresh.ptr')?.ids).toEqual(['b']);
  });
});


describe('MCP 写工具回传变更', () => {
  it('batch 插入的新节点 id 也会被记录（不依赖调用方先知道 id）', async () => {
    const { TOOLS } = await import('../src/mcp/tools.js');
    const tool = TOOLS['paintress_batch'];
    expect(tool).toBeDefined();

    const beforeIds = new Set(collectIds(loadDoc(join(projectDir, 'design.pen')).doc.children));
    const notificationCount = sentNotifications.changes.length;
    const res = (await tool!.run({
      path: join(projectDir, 'design.pen'),
      ops: [{ op: 'insert', parent: 'root', node: { type: 'note', name: 'BatchNote', content: 'x' } }],
    })) as { ok: boolean; result: { inserted: number } };

    expect(res.ok).toBe(true);
    expect(res.result.inserted).toBe(1);
    expect(sentNotifications.changes.length).toBe(notificationCount + 1);
    await sentNotifications.changes[notificationCount];

    // 调用方事先不知道生成 id；写完后从磁盘找新增节点，再验证它被通知。
    // 不能比较 ids.length：1.5s 合并窗口过后新记录会替换旧记录，数量可能反而变小。
    const insertedId = collectIds(loadDoc(join(projectDir, 'design.pen')).doc.children).find((id) => !beforeIds.has(id));
    expect(insertedId).toBeDefined();
    await until(async () => {
      const now = await readChanges('design.pen');
      return now.ids.includes(insertedId!) ? now : null;
    });
    const after = await readChanges('design.pen');
    expect(after.ids).toContain(insertedId);
    // 全量跑会并行启动多个 Chromium；给轮询留出高于默认 5s 的用例余量
  }, 15_000);

  it('update 只记录被更新的那一个 id', async () => {
    const { TOOLS } = await import('../src/mcp/tools.js');
    const notificationCount = sentNotifications.changes.length;
    await TOOLS['paintress_update']!.run({
      path: join(projectDir, 'design.pen'),
      id: 'title',
      patch: { content: 'changed by test' },
    });
    expect(sentNotifications.changes.length).toBe(notificationCount + 1);
    await sentNotifications.changes[notificationCount];
    await until(async () => {
      const body = await readChanges('design.pen');
      return body.ids.includes('title') ? body : null;
    });
    const body = await readChanges('design.pen');
    expect(body.ids).toContain('title');
  }, 15_000);
});
