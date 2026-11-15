import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startDaemon, type DaemonHandle } from '../src/web/daemon.js';
import { sendRequest } from '../src/web/client.js';

/**
 * daemon 的日志出口必须扛得住「stderr 已经断开」。
 *
 * 后台 daemon 由 CLI 用 `stdio: [ignore, ignore, pipe]` 拉起，读端就是那个 CLI 进程；
 * 它退出之后，daemon 再写 stderr 会拿到 EPIPE。未处理的 error 事件会把常驻进程直接打死：
 * 表现就是「在查看器里点一下解绑，整个 web 进程就没了」，而且没有日志文件，事后无从查证。
 */

/** stderr 上有兜底监听时，error 事件只是被吞掉；没有监听就是一次未捕获异常 */
const emitStderrError = (): void => {
  process.stderr.emit('error', new Error('EPIPE'));
};

describe('daemon 日志出口（进程内）', () => {
  let home: string;
  let daemon: DaemonHandle;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'paintress-log-home-'));
    process.env['PAINTRESS_HOME'] = home;
    daemon = await startDaemon({ port: 0, idleTimeoutMs: 10 * 60_000, idleCheckMs: 5_000, quiet: true });
  });

  afterAll(async () => {
    await daemon.close();
    rmSync(home, { recursive: true, force: true });
    delete process.env['PAINTRESS_HOME'];
  });

  it('启动 daemon 后 stderr 的 error 事件不会再抛到进程外', () => {
    expect(() => emitStderrError()).not.toThrow();
  });
});

const CLI = join(import.meta.dirname, '../dist/cli.js');
const spawnDescribe = existsSync(CLI) ? describe : describe.skip;

/** 拿一个当下空闲的端口（daemon 不认 `--port 0`：显式端口必须真的用上） */
async function freePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      srv.close(() => (port > 0 ? resolve(port) : reject(new Error('拿不到空闲端口'))));
    });
  });
}

/** 删除临时目录；daemon 可能还在写日志，撞上 ENOTEMPTY 就重试几次 */
async function rmWithRetry(dir: string, attempts = 20): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  // 实在删不掉也不该让测试变红：临时目录会被系统回收
}

spawnDescribe('后台 daemon：父进程退出后 stderr 断开', () => {
  let home: string;
  let projectDir: string;
  let child: ReturnType<typeof spawn> | undefined;
  let exitNote: string | null = null;
  let stderrText = '';

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'paintress-log-spawn-'));
    projectDir = mkdtempSync(join(tmpdir(), 'paintress-log-proj-'));
    // sendRequest 走控制面 socket，它按这个环境变量找 socket
    process.env['PAINTRESS_HOME'] = home;
    writeFileSync(
      join(projectDir, 'a.ptr'),
      JSON.stringify({ version: '2.22', fileToken: '00000000-0000-4000-8000-0000000000aa', children: [] }),
    );
  });

  afterAll(async () => {
    try {
      await sendRequest({ kind: 'shutdown' }, 2000);
    } catch {
      /* 已经退出 */
    }
    if (child !== undefined && exitNote === null) {
      child.kill('SIGKILL');
      // 等到真正 exit 再结束：否则 worker 收尾之后子进程才死，
      // 会变成「文件级失败但用例全过」的假红
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 3000);
        child?.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    // daemon 退出时会补写一行 web.log；与 rmSync 抢文件会得到 ENOTEMPTY。
    // 临时目录清理重试几次，别让收尾竞态把整轮测试判成失败。
    await rmWithRetry(home);
    await rmWithRetry(projectDir);
    delete process.env['PAINTRESS_HOME'];
  });

  it('后台 daemon：拉起它的进程退出后，写日志不再打死进程，且日志落进 web.log', async () => {
    const port = await freePort();
    // --idle 拉长：空仓 3s 自动关停是另一条合法路径，不能让它混进这条回归用例
    child = spawn(process.execPath, [CLI, 'web', '--no-open', '--port', String(port), '--idle', '600000'], {
      env: { ...process.env, PAINTRESS_HOME: home },
      detached: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrText += chunk.toString('utf8');
    });
    child.once('exit', (code, signal) => {
      exitNote = `exit code=${code} signal=${signal}`;
    });

    const ping = async (timeoutMs = 800): Promise<{ ok: boolean; pid?: number }> => {
      try {
        const res = await sendRequest({ kind: 'ping' }, timeoutMs);
        return res.ok && 'pid' in res ? { ok: true, pid: res.pid } : { ok: false };
      } catch {
        return { ok: false };
      }
    };

    // 等真正那个 daemon 就绪：`paintress web` 自己只是拉起器，拿到 pid 后立刻退
    const deadline = Date.now() + 15_000;
    let daemonPid: number | undefined;
    while (Date.now() < deadline) {
      const res = await ping();
      if (res.ok) {
        daemonPid = res.pid;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(daemonPid, `daemon 没起来（${exitNote ?? '无退出事件'}）${stderrText}`).toBeTypeOf('number');

    // 拉起器退场 = daemon 的 stderr 读端消失（后台启动的常态）
    const wrapperDeadline = Date.now() + 10_000;
    while (exitNote === null && Date.now() < wrapperDeadline) await new Promise((r) => setTimeout(r, 50));
    expect(exitNote, '拉起器应当自行退出').not.toBeNull();

    // 这条请求会让 daemon 写一行日志（给项目建脚手架）——正是打死的触发路径
    const watched = await sendRequest({ kind: 'watch', project: 'log-probe', dir: projectDir }, 8000);
    expect(watched.ok).toBe(true);

    await new Promise((r) => setTimeout(r, 500));
    const after = await ping(2000);
    expect(after.ok, `daemon 在写日志后没了（pid ${daemonPid}）`).toBe(true);
    expect(after.pid).toBe(daemonPid); // 还是同一个进程，不是重拉起来的

    // 直接覆盖这次事故的操作：查看器「解绑」走的就是这个控制面请求
    const unwatched = await sendRequest({ kind: 'unwatch', project: 'log-probe' }, 2000);
    expect(unwatched.ok).toBe(true);
    const afterUnwatch = await ping(2000);
    expect(afterUnwatch.ok, '解绑项目后 daemon 不应退出').toBe(true);
    expect(afterUnwatch.pid).toBe(daemonPid);

    // stderr 断了，日志文件里仍然可查
    const log = join(home, 'web.log');
    expect(existsSync(log)).toBe(true);
    const logText = readFileSync(log, 'utf8');
    expect(logText).toContain('项目 log-probe 初始化');
    expect(logText).toContain('解绑项目 log-probe');
  }, 40_000);
});
