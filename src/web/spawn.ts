import { spawn } from 'node:child_process';
import { daemonPid, queryDaemon, type DaemonInfo } from './client.js';
import type { AccessInfo, BindPreference } from './bind.js';

/**
 * 拉起后台 daemon（唯一实例）。
 *
 * **幂等**：已经在跑就直接返回它的 pid/端口，绝不起第二个进程。
 * 这条保证是「agent 想画就先把 web 拉起来」的前提 —— 调用方可以每次都无条件调用。
 * 并发启动也安全：单实例锁保证只有一个 daemon 活下来，输掉竞争的一方复用它。
 *
 * 子进程跑的是 `paintress web --foreground`：裸 `paintress web` 已经是「ensure 完就返回」的
 * 幂等形式，再拿它当子进程命令会递归。窗口由这个子进程自己弹（openBrowser）。
 */

export interface EnsureDaemonResult {
  /** 本次调用是否真的拉起了进程（false = 复用了已有的 daemon） */
  started: boolean;
  pid: number;
  /** 监听端口（来自 daemon 自己，端口冲突/自定义端口时也准确） */
  port: number;
  /** 最终监听地址与宿主可达性（端口跳级、绑 0.0.0.0 都体现在这里） */
  access: AccessInfo;
}

export interface EnsureDaemonOptions {
  port?: number;
  bind?: BindPreference;
  idleTimeoutMs?: number;
  /** 拉起进程时不自动打开浏览器（CI、远程、只想拿 URL 给人） */
  noOpen?: boolean;
}

const START_TIMEOUT_MS = 15_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * 复用已在运行的 daemon；显式指定的端口/绑定与运行中的不一致时抛错
 * （幂等不等于「悄悄忽略你的参数」：要换端口或绑定得先 `paintress stop`）。
 */
export async function reuseDaemon(port?: number, bind?: BindPreference): Promise<DaemonInfo | null> {
  const info = await queryDaemon();
  if (info === null) return null;
  if (port !== undefined && port !== info.port) {
    throw new Error(
      `paintress web 已在运行（pid ${info.pid}，端口 ${info.port}），与请求的端口 ${port} 不同；如需换端口请先 paintress stop`,
    );
  }
  if (bind !== undefined && bind !== 'auto' && bind !== info.access.bind) {
    throw new Error(
      `paintress web 已在运行（pid ${info.pid}，绑定 ${info.access.bind}），与请求的绑定 ${bind} 不同；如需换绑定请先 paintress stop`,
    );
  }
  return info;
}

/** 启动超时的诊断信息：区分「进程没起来」与「进程在但控制面不通」 */
function timeoutHint(): string {
  const pid = daemonPid();
  if (pid !== null) {
    try {
      process.kill(pid, 0);
      return `；进程 ${pid} 仍在运行但控制面无响应，先运行 paintress stop（或 kill ${pid}）后重试`;
    } catch {
      /* 进程已死：锁/端口残留，重试一次通常就过 */
    }
  }
  return '；可能是锁或端口残留，先 paintress ping 看状态，或前台跑 paintress web 看报错';
}

export async function ensureDaemon(opts: EnsureDaemonOptions = {}): Promise<EnsureDaemonResult> {
  const running = await reuseDaemon(opts.port, opts.bind);
  if (running !== null) return { started: false, pid: running.pid, port: running.port, access: running.access };

  const entry = process.argv[1];
  if (!entry) throw new Error('无法确定 CLI 入口路径，不能后台启动 daemon');
  const args = [entry, 'web', '--foreground'];
  if (opts.port !== undefined) args.push('--port', String(opts.port));
  if (opts.bind !== undefined) args.push('--bind', opts.bind);
  if (opts.idleTimeoutMs !== undefined) args.push('--idle', String(opts.idleTimeoutMs));
  if (opts.noOpen === true) args.push('--no-open');

  const child = spawn(process.execPath, args, { detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
  child.unref();
  // 后台模式的详细失败原因（保留段、六个候选明细）只在子进程 stderr 里；
  // 必须带回来，否则「显式端口被占」会退化成一句没有诊断价值的退出码。
  // 成功后继续 drain、但不再累积，避免常驻 daemon 的日志把管道塞满。
  let startupStderr = '';
  let ready = false;
  child.stderr?.on('data', (chunk: Buffer) => {
    if (ready) return;
    startupStderr = `${startupStderr}${chunk.toString('utf8')}`.slice(-32 * 1024);
  });
  // unref 管道：后台 CLI 返回后能正常退出，不会被 daemon 的长命 stderr 拖住。
  // SAFETY: stdio 'pipe' 的 stderr 在运行时是可 unref 的 Socket；ChildProcess 类型只暴露 Readable。
  (child.stderr as unknown as { unref?: () => void } | null)?.unref?.();
  // 子进程失败（端口被占、锁被活进程占着）时它会自己退出：早发现比等满超时好
  let exitCode: number | null = null;
  child.once('error', (cause) => {
    startupStderr = `${startupStderr}\n${cause.message}`;
    exitCode = -1;
  });
  child.once('exit', (code) => {
    exitCode = code;
  });

  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const info = await queryDaemon(500);
    if (info !== null) {
      // 端口/绑定按 daemon 自己报的为准：并发启动时输掉竞争的可能是我们这个子进程
      if (opts.port !== undefined && info.port !== opts.port) {
        throw new Error(`daemon 起在端口 ${info.port} 而不是请求的 ${opts.port}；先 paintress stop 再重试`);
      }
      if (opts.bind !== undefined && opts.bind !== 'auto' && info.access.bind !== opts.bind) {
        throw new Error(`daemon 起在绑定 ${info.access.bind} 而不是请求的 ${opts.bind}；先 paintress stop 再重试`);
      }
      ready = true;
      // 并发启动的输家也走这里；只有胜者就是本次子进程时才算 started。
      return { started: info.pid === child.pid, pid: info.pid, port: info.port, access: info.access };
    }
    if (exitCode !== null) {
      const detail = startupStderr.trim();
      // 单实例锁可能发生在胜者的控制面 socket 就绪之前（宿主体检要花几百毫秒）。
      // 这时继续轮询复用胜者，而不是把正常的并发启动报成失败。
      if (/已在运行|单实例锁/.test(detail)) {
        await sleep(100);
        continue;
      }
      const suffix = detail === '' ? timeoutHint() : `：\n${detail}`;
      throw new Error(`后台 daemon 启动失败（退出码 ${exitCode}）${suffix}`);
    }
    await sleep(100);
  }
  const detail = startupStderr.trim();
  throw new Error(`后台启动 daemon 超时（${START_TIMEOUT_MS}ms）${detail === '' ? timeoutHint() : `：\n${detail}`}`);
}
