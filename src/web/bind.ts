import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { Server as HttpServer } from 'node:http';
import { defaultRouteIpv4, interopEnabled, isWsl, windowsSystem32 } from '../shared/wsl.js';

/**
 * 监听地址的选取策略（端口阶梯）。
 *
 * 为什么需要它（2026-11-15 实测）：WSL2 的 `localhost` 转发由宿主侧 `wslrelay.exe`
 * 落地 —— Windows 上绑不上这个端口，转发就不存在，宿主浏览器只会看到「连接失败」。
 * 最常见的一类不可绑是 **Hyper-V 保留端口段**（`netsh int ipv4 show excludedportrange`），
 * 而保留段每次开机在动态端口范围内重新划分，位置会漂：同一个默认端口今天能开、明天不能开。
 * 这一类故障在 WSL 内部完全看不出来（daemon 自己 `curl 127.0.0.1` 永远是 200）。
 *
 * 因此顺序是「先定端口、再起服务、最后复核」：
 *   1. 宿主体检（一次 interop 调用）：哪些候选端口在 Windows 上绑得上；
 *   2. WSL 侧试绑（瞬时）：把内外两侧的冲突都筛掉；
 *   3. 真正 listen（此时几乎不会失败）；
 *   4. 端到端复核：从 Windows 侧取 `/api/ping`，校验 nonce —— 只信身份，不信 200。
 *
 * 阶梯：127.0.0.1 × [6033, 6133, 6233] → 0.0.0.0 × [6033, 6133, 6233]，最多 6 次。
 * 兜底的 0.0.0.0 之所以有效：Windows 直连 WSL 网卡地址不经过 wslrelay，端口被宿主保留也不影响
 * （实测保留端口上 localhost 连不通、WSL IP 返回 200）。
 */

/** 默认端口：60 号肉身成圣远征队 + 33 号远征队 */
export const DEFAULT_PORT = 6033;

/** 跳级候选（顺序即优先级） */
export const PORT_CANDIDATES = [DEFAULT_PORT, 6133, 6233] as const;

/** 探测端点：回显 nonce，供从宿主侧确认「应答的是不是本次进程」 */
export const PROBE_PATH = '/api/ping';

export type BindMode = 'loopback' | 'all';
export type BindPreference = 'auto' | BindMode;
export type AttemptResult = 'ok' | 'in-use' | 'windows-reserved' | 'windows-unreachable';
export type WindowsVerdict = 'ok' | 'unavailable' | 'skipped';

/** 一次候选尝试的结论（失败时原样进错误信息，不再靠猜） */
export interface BindAttempt {
  port: number;
  bind: BindMode;
  result: AttemptResult;
  detail?: string;
}

/**
 * 人/agent 要用到的「这个查看器从哪儿能打开」。
 * agent 的控制面是 Unix socket，本结构与它无关；它只回答「给人打开的地址是哪个」。
 */
export interface AccessInfo {
  /** 完整登入地址（含协议与端口） */
  url: string;
  /** URL 里的主机名：loopback 是 localhost，all 是 WSL 网卡地址 */
  host: string;
  bind: BindMode;
  /** Windows 侧可达性：ok=实测可达，unavailable=interop 不可用（未验证），skipped=不在 WSL */
  windows: WindowsVerdict;
  /** 实际端口是否偏离了期望端口（默认 6033 或显式 --port） */
  jumped: boolean;
  /** 期望端口（默认值或 --port 原值） */
  requestedPort: number;
  attempts: BindAttempt[];
}

export interface Endpoint {
  port: number;
  host: string;
  bind: BindMode;
}

/** 宿主体检结果：保留段 + 每个候选端口能不能在 127.0.0.1 上独占绑定 */
export interface WindowsReport {
  excluded: Array<[number, number]>;
  bindable: Record<string, boolean>;
}

/** 可注入的接缝：测试里全部走假的，绝不真的去调 Windows */
export interface LadderSeams {
  isWsl?: () => boolean;
  report?: (ports: number[]) => Promise<WindowsReport | null>;
  probe?: (url: string, budgetMs: number) => Promise<boolean>;
  hostIpv4?: () => string | null;
}

export interface BindOptions {
  /** 每次尝试新建一个 server（handler 闭包复用），失败的那个直接丢弃 */
  create: () => HttpServer;
  /** 身份校验用随机串：`/api/ping` 回显它，探测只认它 */
  nonce: string;
  /** 显式 --port：只试这一个端口、一种绑定，失败直接报错（不跳级） */
  requestedPort?: number;
  bind?: BindPreference;
  /** 候选端口列表（默认 PORT_CANDIDATES；测试用它把多个候选挤到空闲端口上） */
  ports?: readonly number[];
  log?: (line: string) => void;
  seams?: LadderSeams;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 单个候选的探测预算：loopback 要走 wslrelay 接管（实测 300ms–1.06s），all 是直连 */
const PROBE_BUDGET_MS: Record<BindMode, number> = { loopback: 2000, all: 600 };
/** 整条阶梯的硬上限：超过就带着已试记录报错，绝不让启动无限拖 */
const LADDER_BUDGET_MS = 9000;
const PROBE_INTERVAL_MS = 150;
const INTEROP_TIMEOUT_MS = 4000;

function inRange(ranges: Array<[number, number]>, port: number): boolean {
  return ranges.some(([start, end]) => port >= start && port <= end);
}

const hostOf = (mode: BindMode): string => (mode === 'loopback' ? '127.0.0.1' : '0.0.0.0');

function candidatesFor(opts: BindOptions): Endpoint[] {
  const pref = opts.bind ?? 'auto';
  // 显式 --port：只试这一个端口、一种绑定 —— 「显式就不跳级」，被占直接报错
  if (opts.requestedPort !== undefined) {
    const mode: BindMode = pref === 'all' ? 'all' : 'loopback';
    return [{ port: opts.requestedPort, host: hostOf(mode), bind: mode }];
  }
  const modes: BindMode[] = pref === 'auto' ? ['loopback', 'all'] : [pref];
  return modes.flatMap((mode) =>
    (opts.ports ?? PORT_CANDIDATES).map((port) => ({ port, host: hostOf(mode), bind: mode })),
  );
}

/** 运行一条 Windows 命令，收集 stdout（超时/不存在都返回 null） */
async function runWindows(exe: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    let out = '';
    const child = spawn(exe, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve(null);
    }, INTEROP_TIMEOUT_MS);
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
    });
    child.once('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.once('close', () => {
      clearTimeout(timer);
      resolve(out);
    });
  });
}

function system32(): string | null {
  if (!interopEnabled()) return null;
  return windowsSystem32();
}

/**
 * 宿主体检：一次 PowerShell 调用同时拿回「保留段」与「候选端口可否独占绑定」。
 * 为什么不分开调：每次 interop 都是新进程（热 70–260ms，冷启动可达 2s），启动路径上能省则省。
 */
async function windowsReport(ports: number[]): Promise<WindowsReport | null> {
  const sys32 = system32();
  if (sys32 === null) return null;
  const ps = `${sys32}/WindowsPowerShell/v1.0/powershell.exe`;
  if (!existsSync(ps)) return null;
  const script = [
    '$ex = @()',
    "$null = netsh.exe int ipv4 show excludedportrange protocol=tcp | ForEach-Object { if ($_ -match '^\\s*(\\d+)\\s+(\\d+)\\s*$') { $ex += ,@([int]$Matches[1],[int]$Matches[2]) } }",
    '$b = @{}',
    `foreach ($p in @(${ports.join(',')})) {`,
    '  $s = New-Object System.Net.Sockets.Socket([System.Net.Sockets.AddressFamily]::InterNetwork,[System.Net.Sockets.SocketType]::Stream,[System.Net.Sockets.ProtocolType]::Tcp)',
    '  try { $s.ExclusiveAddressUse = $true',
    '        $s.Bind((New-Object System.Net.IPEndPoint([System.Net.IPAddress]::Loopback,$p)))',
    '        $b["$p"] = $true } catch { $b["$p"] = $false } finally { $s.Close() }',
    '}',
    '@{ excluded = $ex; bindable = $b } | ConvertTo-Json -Compress -Depth 4',
  ].join('; ');
  const raw = await runWindows(ps, ['-NoProfile', '-NonInteractive', '-Command', script]);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw.trim()) as { excluded?: unknown; bindable?: unknown };
    const excluded = Array.isArray(parsed.excluded)
      ? (parsed.excluded as unknown[])
          .filter((r): r is [number, number] => Array.isArray(r) && r.length === 2)
          .map((r) => [Number(r[0]), Number(r[1])] as [number, number])
      : [];
    const bindable: Record<string, boolean> = {};
    if (parsed.bindable !== null && typeof parsed.bindable === 'object') {
      for (const [k, v] of Object.entries(parsed.bindable as Record<string, unknown>)) bindable[k] = v === true;
    }
    return { excluded: excluded.filter(([s, e]) => Number.isFinite(s) && Number.isFinite(e)), bindable };
  } catch {
    return null;
  }
}

/**
 * 端到端探测：从 Windows 侧取 `/api/ping`，正文里必须出现本次 nonce。
 * 只认身份不认状态码 —— 端口上蹲着别的程序（甚至另一个 distro 的 paintress）时，200 也是假的。
 */
async function windowsProbe(url: string, budgetMs: number): Promise<boolean> {
  const sys32 = system32();
  if (sys32 === null) return false;
  let nonce = '';
  try {
    nonce = new URL(url).searchParams.get('nonce') ?? '';
  } catch {
    return false;
  }
  if (nonce === '') return false;
  const deadline = Date.now() + budgetMs;
  const curl = `${sys32}/curl.exe`;
  if (existsSync(curl)) {
    while (Date.now() < deadline) {
      const out = await runWindows(curl, ['-s', '--noproxy', '*', '-m', '2', url]);
      if (out !== null && out.includes(nonce)) return true;
      await sleep(PROBE_INTERVAL_MS);
    }
    return false;
  }
  const ps = `${sys32}/WindowsPowerShell/v1.0/powershell.exe`;
  if (!existsSync(ps)) return false;
  const script = `try { (Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 -Uri '${url}').Content } catch { '' }`;
  while (Date.now() < deadline) {
    const out = await runWindows(ps, ['-NoProfile', '-NonInteractive', '-Command', script]);
    if (out !== null && out.includes(nonce)) return true;
    await sleep(PROBE_INTERVAL_MS);
  }
  return false;
}

function listenOn(server: HttpServer, endpoint: Endpoint): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException): void => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(endpoint.port, endpoint.host);
  });
}

function closeQuietly(server: HttpServer): void {
  try {
    server.closeAllConnections?.();
    server.close();
  } catch {
    /* 没起来就没有要关的 */
  }
}

function ladderError(attempts: BindAttempt[], explicit: boolean): Error {
  const reason: Record<AttemptResult, string> = {
    ok: 'ok',
    'in-use': '端口已被占用',
    'windows-reserved': '落在 Windows 保留端口段',
    'windows-unreachable': 'Windows 侧连不上（转发未建立）',
  };
  const rows = attempts.map((a) => `  ${a.bind === 'all' ? '0.0.0.0' : '127.0.0.1'}:${a.port}  ${reason[a.result]}${a.detail ? `（${a.detail}）` : ''}`);
  const hint = explicit
    ? '显式 --port 不跳级：换一个端口（--port <n>），或在 WSL 里用 --bind all 绑 0.0.0.0 让宿主直连。'
    : '可用 --port <n> 指定端口、--bind all 直接绑 0.0.0.0，或把 Windows 动态端口段恢复默认（见 README「端口与宿主访问」）。';
  return new Error(`paintress web 没有可用端口，${attempts.length} 个候选全部失败：\n${rows.join('\n')}\n${hint}`);
}


/** 宿主预检：能提前判死的就别去 listen（保留段 / 宿主占用）。返回 null = 继续尝试 */
function predictSkip(cand: Endpoint, report: WindowsReport | null, wsl: boolean, log: (line: string) => void): BindAttempt | null {
  if (!wsl || cand.bind !== 'loopback' || report === null) return null;
  if (inRange(report.excluded, cand.port)) {
    log(`${cand.port} 落在 Windows 保留端口段，跳过`);
    return { port: cand.port, bind: cand.bind, result: 'windows-reserved' };
  }
  if (report.bindable[String(cand.port)] === false) {
    log(`${cand.port} 在 Windows 侧绑不上（已被占用或已被转发），跳过`);
    return { port: cand.port, bind: cand.bind, result: 'in-use', detail: 'Windows 侧不可绑（已被占用或已转发）' };
  }
  return null;
}

interface ProbeContext {
  wsl: boolean;
  canProbe: boolean;
  ipv4: string | null;
  nonce: string;
  probe: (url: string, budgetMs: number) => Promise<boolean>;
}

/**
 * 端到端复核：从宿主侧取 `/api/ping`，只认本次进程的 nonce。
 * 返回 'unreachable' 表示「本机起得来、宿主连不上」—— 正是 WSL 转发没落地的那种失败。
 */
async function verifyCandidate(cand: Endpoint, ctx: ProbeContext): Promise<WindowsVerdict | 'unreachable'> {
  if (!ctx.wsl) return 'skipped';
  if (!ctx.canProbe) return 'unavailable';
  let target: string | null = null;
  if (cand.bind === 'loopback') target = `127.0.0.1:${cand.port}`;
  else if (ctx.ipv4 !== null) target = `${ctx.ipv4}:${cand.port}`;
  if (target === null) return 'unavailable';
  const ok = await ctx.probe(`http://${target}${PROBE_PATH}?nonce=${ctx.nonce}`, PROBE_BUDGET_MS[cand.bind]);
  return ok ? 'ok' : 'unreachable';
}

/**
 * 走完阶梯并返回**已经 listen 成功且复核通过**的 server。
 * 调用方只需要接管返回值，不必关心中间换过几个候选。
 */
export async function bindWithFallback(opts: BindOptions): Promise<{ server: HttpServer; endpoint: Endpoint; access: AccessInfo }> {
  const seams = opts.seams ?? {};
  const log = opts.log ?? ((): void => {});
  const explicit = opts.requestedPort !== undefined;
  // 端口 0 = 让内核分配（测试 / 嵌入）。既然端口是随机的，宿主转发校验就没有对象可验：整段跳过。
  const ephemeral = opts.requestedPort === 0;
  const wsl = !ephemeral && (seams.isWsl ?? isWsl)();
  const requestedPort = opts.requestedPort ?? opts.ports?.[0] ?? DEFAULT_PORT;
  const plan = candidatesFor(opts);
  const attempts: BindAttempt[] = [];
  const startedAt = Date.now();
  const ipv4 = (seams.hostIpv4 ?? defaultRouteIpv4)();
  const probe = seams.probe ?? windowsProbe;

  // 能不能从宿主侧探测：注入的 probe 视为可用；否则要求 interop 与 Windows 系统盘都在
  const canProbe = wsl && (seams.probe !== undefined || (interopEnabled() && windowsSystem32() !== null));
  // 宿主预检（保留段 / 宿主占用）只有 loopback 候选需要，一次 interop 搞定三个端口
  let report: WindowsReport | null = null;
  if (canProbe && plan.some((c) => c.bind === 'loopback')) {
    report = await (seams.report ?? windowsReport)(plan.filter((c) => c.bind === 'loopback').map((c) => c.port));
    if (report === null) log('Windows 侧体检失败，跳过宿主预检（仍做端到端复核）');
  } else if (wsl && !canProbe) {
    log('Windows interop 不可用：跳过宿主预检与复核');
  }

  const probeCtx: ProbeContext = { wsl, canProbe, ipv4, nonce: opts.nonce, probe };

  for (const cand of plan) {
    if (Date.now() - startedAt > LADDER_BUDGET_MS) {
      attempts.push({ port: cand.port, bind: cand.bind, result: 'windows-unreachable', detail: '超出阶梯时间预算，未尝试' });
      break;
    }

    // 1. 宿主预检：保留段 / 宿主占用
    const skip = predictSkip(cand, report, wsl, log);
    if (skip !== null) {
      attempts.push(skip);
      continue;
    }

    // 2. 真 listen（WSL 内冲突在这里暴露）
    const server = opts.create();
    try {
      await listenOn(server, cand);
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code;
      if (code === 'EADDRINUSE' || code === 'EACCES') {
        attempts.push({ port: cand.port, bind: cand.bind, result: 'in-use', detail: String(code) });
        log(`${cand.port} (${cand.bind}) 本机不可用（${code}），换下一个`);
        continue;
      }
      throw cause;
    }

    // 3. 端到端复核：能连不等于连对了，应答里必须有本次 nonce
    const verdict = await verifyCandidate(cand, probeCtx);
    if (verdict === 'unreachable') {
      closeQuietly(server);
      attempts.push({ port: cand.port, bind: cand.bind, result: 'windows-unreachable' });
      log(`${cand.port} (${cand.bind}) 已监听但 Windows 侧连不上，换下一个`);
      continue;
    }

    attempts.push({ port: cand.port, bind: cand.bind, result: 'ok' });
    // port 0 = 内核分配（测试/嵌入场景）：以实际地址为准，不算跳级
    const resolved = server.address();
    const actualPort = typeof resolved === 'object' && resolved !== null ? resolved.port : cand.port;
    const host = cand.bind === 'loopback' ? 'localhost' : (ipv4 ?? cand.host);
    const access: AccessInfo = {
      url: `http://${host}:${actualPort}/`,
      host,
      bind: cand.bind,
      windows: verdict,
      jumped: !ephemeral && actualPort !== requestedPort,
      requestedPort: ephemeral ? actualPort : requestedPort,
      attempts,
    };
    if (access.jumped) log(`端口 ${requestedPort} 不可用，已改用 ${actualPort}`);
    if (cand.bind === 'all') log(`已绑定 0.0.0.0:${actualPort} —— 宿主浏览器用 ${access.url}（localhost 走不通）`);
    return { server, endpoint: { ...cand, port: actualPort }, access };
  }

  throw ladderError(attempts, explicit);
}

/** `paintress doctor` 的网络体检：把上面这套判据摊开给人看 */
export interface NetworkDiagnostics {
  wsl: boolean;
  interop: boolean;
  system32: string | null;
  hostIpv4: string | null;
  defaultPort: number;
  candidates: Array<{ port: number; excluded: boolean; windowsBindable: boolean | null }>;
  report: WindowsReport | null;
}

export async function diagnoseNetwork(seams: LadderSeams = {}): Promise<NetworkDiagnostics> {
  const wsl = (seams.isWsl ?? isWsl)();
  const ports = [...PORT_CANDIDATES];
  const report = wsl ? await (seams.report ?? windowsReport)(ports) : null;
  return {
    wsl,
    interop: interopEnabled(),
    system32: windowsSystem32(),
    hostIpv4: (seams.hostIpv4 ?? defaultRouteIpv4)(),
    defaultPort: DEFAULT_PORT,
    candidates: ports.map((port) => ({
      port,
      excluded: report === null ? false : inRange(report.excluded, port),
      windowsBindable: report === null ? null : report.bindable[String(port)] === true,
    })),
    report,
  };
}
