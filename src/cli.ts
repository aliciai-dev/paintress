#!/usr/bin/env node
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { TOOLS, type ToolOutput } from './mcp/tools.js';
import { runStdioServer } from './mcp/server.js';
import { startDaemon, type DaemonHandle } from './web/daemon.js';
import { isDaemonRunning, sendRequest, attachPersistent, queryDaemon } from './web/client.js';
import { findProjectRoot, projectFilesInfo, setProjectRoots } from './doc/project.js';
import { ensureDaemon, reuseDaemon } from './web/spawn.js';
import { diagnoseNetwork, type AccessInfo } from './web/bind.js';
import {
  CLIENTS,
  findClient,
  isClientDetected,
  jsonSnippet,
  resolveLaunchCommand,
  tomlSnippet,
  type LaunchCommand,
} from './integrations/clients.js';
import { applyPlan, planJsonMerge, readConfig } from './integrations/install.js';
import { VERSION } from './shared/version.js';

/**
 * paintress CLI —— 与 MCP 共享同一套工具 handler。
 * 用法：
 *   paintress mcp                                    启动 stdio MCP server
 *   paintress new <file> [--name n] [--width n] [--height n] [--fill c] [--layout l] [--force]
 *   paintress convert <file.pen> [out.ptr] [--force]   把 .pen 转成 .ptr（源文件不动）
 *   paintress project [dir]                          项目根与两个关键文件（按需创建）
 *   paintress info <file>
 *   paintress query <file> [--type t] [--name n] [--regex] [--id i] [--reusable]
 *   paintress get <file> <id> [--depth n]
 *   paintress update <file> <id> '<patch-json>'
 *   paintress insert <file> <parent> '<node-json>' [--index n]
 *   paintress delete <file> <id>
 *   paintress move <file> <id> <parent> [--index n]
 *   paintress batch <file> '<ops-json>'
 *   paintress render <file> <out.html> [--embed-fonts]
 *   paintress shot <file> <out.png> [--scale 0.2..2] [--board id|name]   (缺省 0.8)
 *   paintress validate <file>
 *   paintress audit <file>                            画谱审计（只读）
 *   paintress establish <file> [--apply] [--min-uses n]  提取候选（默认只给建议）
 *   paintress adjust <file> --key k --value v [--apply]  改 token；或 --group g --prop p
 *   paintress preset list [dir]                       项目预设列表
 *   paintress preset set <dir> <key> <type> <value>   写一条预设（type: color|radius|spacing|fontSize|font）
 *   paintress preset seed <dir> [--apply]             补齐整套尺度（默认 dry-run）
 *   paintress preset groups [dir]                     列出 preset 组（谱式）
 *   paintress preset set-group <dir> <组名> <target> '<props-json>'
 *   paintress preset remove-group <dir> <组名>
 *   paintress preset remove <dir> <key>               删一条预设
 *   paintress component list [dir]                    项目组件库列表
 *   paintress component insert <file> <id>            把组件复制进设计稿
 *   paintress component add <file> <id>               把设计稿子树上收为组件
 *   paintress web [--port n] [--bind auto|loopback|all] [--idle ms] [--foreground]  确保 web 在跑，立刻返回（幂等）
 *   paintress web --foreground                       占住终端跑（日志直接可见）
 *   paintress ping                                    检查 web 是否在运行
 *   paintress status                                  查看已注册项目
 *   paintress watch <name> <dir>                      注册要跟踪的目录
 *   paintress unwatch <name>                          移除项目
 *   paintress attach <name>                           保持连接作为存活信号
 *   paintress stop                                    停止 web
 *   paintress mcp-config <client>                     打印某客户端的 MCP 配置片段
 *   paintress install [client...] [--dry-run]         把 paintress 写进各客户端配置
 *   paintress doctor                                  检查各客户端配置状态
 */

export interface ParsedCommand {
  cmd: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
}

const NO_OPEN_FLAG = 'no-open';

const FLAG_KEYS = new Set(['type', 'name', 'regex', 'id', 'reusable', 'depth', 'index', 'scale', 'port', 'bind', 'idle', 'foreground', 'daemon', 'dry-run', 'opencode-layout', 'width', 'height', 'fill', 'layout', 'padding', 'gap', 'force', 'board', 'parent', 'apply', 'min-uses', 'key', 'group', 'prop', 'value', 'preview', 'note', 'metrics', 'embed-fonts', NO_OPEN_FLAG]);
/** `daemon` 只是历史别名：默认行为已经是后台，留着不报错 */
const BOOLEAN_FLAGS = new Set(['regex', 'reusable', 'foreground', 'daemon', 'dry-run', 'force', 'apply', 'embed-fonts', NO_OPEN_FLAG]);

/** 纯函数：argv → 命令 + 位置参数 + 标志（可单测） */
export function parseArgv(argv: string[]): ParsedCommand | null {
  const [cmd, ...rest] = argv;
  if (!cmd) return null;
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i] as string;
    if (tok.startsWith('--')) {
      const key = tok.slice(2);
      if (!FLAG_KEYS.has(key)) return null; // 未知标志直接判非法
      const next = rest[i + 1];
      if (BOOLEAN_FLAGS.has(key)) {
        flags[key] = true;
      } else if (typeof next === 'string' && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positionals.push(tok);
    }
  }
  return { cmd, positionals, flags };
}

/** 写进客户端配置的启动命令：全局安装用裸命令，否则回退绝对路径 */
function currentLaunchCommand(): LaunchCommand {
  return resolveLaunchCommand({
    scriptPath: process.argv[1] ?? fileURLToPath(import.meta.url),
    pathEnv: process.env['PATH'],
    platform: process.platform,
    exists: (p) => existsSync(p),
    realpath: (p) => realpathSync(p),
  });
}

/** CLI 输出的 `http` 字段保持历史形态（不带结尾斜杠）；`access.url` 仍带斜杠作为基地址 */
function httpOf(access: AccessInfo): string {
  return access.url.replace(/\/$/, '');
}

/** `paintress doctor` 的「当前 daemon 实况」：没跑就是 null，不拉起进程 */
async function daemonSnapshot(): Promise<{ pid: number; port: number; url: string; bind: string; windows: string; jumped: boolean } | null> {
  const info = await queryDaemon(500);
  if (info === null) return null;
  return {
    pid: info.pid,
    port: info.port,
    url: info.access.url,
    bind: info.access.bind,
    windows: info.access.windows,
    jumped: info.access.jumped,
  };
}

/** `--bind` 只接受三种取值：auto（默认，走端口阶梯）、loopback、all */
function parseBind(v: string | undefined): 'auto' | 'loopback' | 'all' | undefined {
  if (v === undefined) return undefined;
  if (v === 'auto' || v === 'loopback' || v === 'all') return v;
  throw new Error(`--bind 只接受 auto|loopback|all，收到：${v}`);
}

function flagStr(f: Record<string, string | boolean>, key: string): string | undefined {
  const v = f[key];
  return typeof v === 'string' && v !== '' ? v : undefined;
}

function flagNum(f: Record<string, string | boolean>, key: string): number | undefined {
  const v = flagStr(f, key);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`--${key} 需要非负整数，收到：${v}`);
  return n;
}

/** 连续数值参数（截图倍率 0.2–2）；与整数参数分开，不能把 0.8 当成非法 */
function flagDecimal(f: Record<string, string | boolean>, key: string): number | undefined {
  const v = flagStr(f, key);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`--${key} 需要数字，收到：${v}`);
  return n;
}

function parseJson<T>(text: string, what: string): T {
  try {
    return JSON.parse(text) as T;
  } catch (cause) {
    throw new Error(`${what} 不是合法 JSON：${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

async function call(tool: string, args: Record<string, unknown>): Promise<ToolOutput> {
  const def = TOOLS[tool];
  if (!def) throw new Error(`未知工具：${tool}`);
  return await def.run(args);
}

/** 入口：返回退出码（可单测） */
/** 当前目录所在项目里两个关键文件的现状（只报告，不创建） */
function cwdDesignSystem(): ReturnType<typeof projectFilesInfo> | null {
  try {
    const root = findProjectRoot(process.cwd());
    return root === null ? null : projectFilesInfo(root);
  } catch {
    return null;
  }
}

/** CLI 进程也要用「注册根」解析项目文件：从 daemon 拉一次项目表即可 */
async function syncProjectRoots(): Promise<void> {
  if (!isDaemonRunning()) return;
  try {
    const res = await sendRequest({ kind: 'status' }, 2000);
    if (res.ok && 'projects' in res && Array.isArray(res.projects)) {
      setProjectRoots(res.projects.map((p) => p.root));
    }
  } catch {
    /* best-effort */
  }
}

export async function main(argv: string[]): Promise<number> {
  if (argv[0] === '--version' || argv[0] === '-v' || argv[0] === 'version') {
    console.log(`paintress ${VERSION}`);
    return 0;
  }
  const parsed = parseArgv(argv);
  if (!parsed) {
    console.error('用法：paintress <mcp|web|ping|status|watch|unwatch|attach|stop|new|info|query|get|update|insert|delete|move|batch|render|shot|validate|audit|establish|adjust|install|doctor|mcp-config> ...（版本：paintress --version）');
    return 2;
  }
  const { cmd, positionals, flags } = parsed;
  await syncProjectRoots();
  const [file, a1, a2] = positionals as (string | undefined)[];

  try {
    if (cmd === 'mcp') {
      await runStdioServer();
      return 0;
    }

    // ---- web 控制面（不需要 <file>）----
    if (cmd === 'ping') {
      if (!isDaemonRunning()) {
        console.log(JSON.stringify({ ok: false, running: false, hint: '未运行：paintress web' }));
        return 1;
      }
      const res = await sendRequest({ kind: 'ping' });
      console.log(JSON.stringify(res, null, 2));
      return res.ok ? 0 : 1;
    }
    if (cmd === 'status') {
      if (!isDaemonRunning()) {
        console.log(JSON.stringify({ ok: false, running: false }));
        return 1;
      }
      console.log(JSON.stringify(await sendRequest({ kind: 'status' }), null, 2));
      return 0;
    }
    if (cmd === 'watch') {
      if (!file || !a1) throw new Error('用法：paintress watch <name> <dir> [--depth 1..6]');
      const depth = flagNum(flags, 'depth');
      // 目录要按“调用者的 cwd”解析成绝对路径：daemon 是常驻进程，
      // 它的 cwd 和人在哪个目录敲命令无关
      const dir = resolve(a1);
      console.log(
        JSON.stringify(
          await sendRequest({ kind: 'watch', project: file, dir, ...(depth !== undefined ? { depth } : {}) }, 8000),
          null,
          2,
        ),
      );
      return 0;
    }
    if (cmd === 'unwatch') {
      if (!file) throw new Error('用法：paintress unwatch <name>');
      console.log(JSON.stringify(await sendRequest({ kind: 'unwatch', project: file }), null, 2));
      return 0;
    }
    if (cmd === 'stop') {
      if (!isDaemonRunning()) {
        console.log(JSON.stringify({ ok: true, shutdown: true, already: true }));
        return 0;
      }
      console.log(JSON.stringify(await sendRequest({ kind: 'shutdown' }), null, 2));
      return 0;
    }
    // ---- 多客户端接入（不需要 <file>）----
    if (cmd === 'mcp-config') {
      const id = file ?? 'claude';
      const spec = findClient(id);
      if (spec === undefined) throw new Error(`未知客户端：${id}（可选：${CLIENTS.map((c) => c.id).join(' / ')}）`);
      const launch = currentLaunchCommand();
      console.log(spec.format === 'toml' ? tomlSnippet(launch) : jsonSnippet(spec, launch));
      return 0;
    }
    if (cmd === 'install' || cmd === 'doctor') {
      const home = homedir();
      const launch = currentLaunchCommand();
      const detected = (spec: (typeof CLIENTS)[number]): boolean =>
        isClientDetected(spec, home, process.platform, process.env, existsSync);
      // install 未点名时只写「检测到」的客户端；doctor 则列出全部并标注 detected。
      let ids: string[];
      if (positionals.length > 0) ids = positionals;
      else if (cmd === 'doctor') ids = CLIENTS.map((c) => c.id);
      else ids = CLIENTS.filter(detected).map((c) => c.id);
      const unknown = ids.filter((id) => findClient(id) === undefined);
      if (unknown.length > 0) {
        throw new Error(`未知客户端：${unknown.join(', ')}（可选：${CLIENTS.map((c) => c.id).join(' / ')}）`);
      }
      const dryRun = cmd === 'doctor' || flags['dry-run'] === true;
      const layoutFlag = flagStr(flags, 'opencode-layout') ?? 'auto';
      if (layoutFlag !== 'auto' && layoutFlag !== 'legacy' && layoutFlag !== 'v2') {
        throw new Error(`--opencode-layout 只接受 auto / legacy / v2，收到：${layoutFlag}`);
      }
      const results: Record<string, unknown>[] = [];
      for (const id of ids) {
        const spec = findClient(id);
        if (spec === undefined) continue;
        const path = spec.configPath(home, process.platform, process.env);
        const existing = readConfig(path);
        const plan = planJsonMerge(spec, path, existing, launch, { opencodeLayout: layoutFlag });
        if (cmd === 'doctor') {
          results.push({
            client: spec.id,
            label: spec.label,
            path,
            detected: detected(spec),
            exists: existing !== null,
            status: plan.status,
            detail: plan.detail,
          });
          continue;
        }
        if (plan.status === 'invalid' || plan.next === null) {
          results.push({
            client: spec.id,
            path,
            status: plan.status,
            detail: plan.detail,
            ...(spec.format === 'toml' ? { snippet: tomlSnippet(launch) } : {}),
          });
          continue;
        }
        const backup = plan.status === 'noop' ? null : applyPlan(path, plan.next, dryRun).backup;
        results.push({ client: spec.id, path, status: plan.status, detail: plan.detail, backup, dryRun });
      }
      console.log(
        JSON.stringify(
          cmd === 'doctor'
            ? { ok: true, launch, results, net: await diagnoseNetwork(), daemon: await daemonSnapshot() }
            : { ok: true, launch, results },
          null,
          2,
        ),
      );
      return 0;
    }
    if (cmd === 'attach') {
      if (!file) throw new Error('用法：paintress attach <name>');
      const handle = await attachPersistent(file);
      console.log(JSON.stringify({ ok: true, attached: true, project: file, note: '连接保持中，断开即视为退出' }));
      // 保持前台，直到被信号终止或被 daemon 关掉
      await new Promise<void>((resolve) => {
        handle.onClose(() => resolve());
        const bye = (): void => {
          handle.close();
          resolve();
        };
        process.once('SIGINT', bye);
        process.once('SIGTERM', bye);
      });
      return 0;
    }
    if (cmd === 'web') {
      const port = flagNum(flags, 'port');
      const idle = flagNum(flags, 'idle');
      const bind = parseBind(flagStr(flags, 'bind'));
      // --no-open：不想被弹浏览器时用（CI、远程、只想拿 URL 给人）
      const noOpen = flags[NO_OPEN_FLAG] === true || process.env['PAINTRESS_NO_OPEN'] === '1';
      // http 一律取 daemon 自报的 access.url：端口可能被跳级、绑定可能是 0.0.0.0
      // 幂等：已经在跑就复用它（打印 pid/端口/URL 后立刻返回），绝不起第二个进程。
      const running = await reuseDaemon(port, bind);
      if (running !== null) {
        console.log(
          JSON.stringify(
            {
              ok: true,
              daemon: true,
              reused: true,
              pid: running.pid,
              port: running.port,
              http: httpOf(running.access),
              access: running.access,
              designSystem: cwdDesignSystem(),
            },
            null,
            2,
          ),
        );
        return 0;
      }
      // 默认形态 = 「打开查看器」：拉起后台 daemon，打印 pid/端口/URL，立刻返回。
      // 窗口由 daemon 自己弹（openBrowser：WSL 里落到 Windows 宿主浏览器），
      // 调用方（人也好 agent 也好）不需要知道浏览器在哪、也不用再补任何 flag。
      if (flags['foreground'] !== true) {
        const res = await ensureDaemon({
          ...(port !== undefined ? { port } : {}),
          ...(bind !== undefined ? { bind } : {}),
          ...(idle !== undefined ? { idleTimeoutMs: idle } : {}),
          noOpen,
        });
        console.log(
          JSON.stringify(
            {
              ok: true,
              daemon: true,
              reused: !res.started,
              pid: res.pid,
              port: res.port,
              http: httpOf(res.access),
              access: res.access,
              designSystem: cwdDesignSystem(),
            },
            null,
            2,
          ),
        );
        return 0;
      }
      // --foreground：占住终端，解绑/退出原因等日志直接可见（daemon 的子进程就是这么跑的）。
      let handle: DaemonHandle;
      try {
        handle = await startDaemon({
          ...(port !== undefined ? { port } : {}),
          ...(bind !== undefined ? { bind } : {}),
          ...(idle !== undefined ? { idleTimeoutMs: idle } : {}),
          // 人手动起的实例给一分钟窗口去 watch；agent 自动起的走默认的 3s 快速收尾
          emptyGraceMs: 60_000,
          updateCheck: true,
        });
      } catch (cause) {
        // 并发启动输给了别人：复用活下来的那个，而不是报「已在运行」
        const again = await queryDaemon();
        if (again === null) throw cause;
        console.log(
          JSON.stringify(
            { ok: true, daemon: true, reused: true, pid: again.pid, port: again.port, http: httpOf(again.access), access: again.access },
            null,
            2,
          ),
        );
        return 0;
      }
      console.log(JSON.stringify({ ok: true, pid: handle.pid, port: handle.port, http: httpOf(handle.access), access: handle.access }, null, 2));
      if (!noOpen) {
        const { openBrowser } = await import('./web/open-browser.js');
        openBrowser(handle.access.url);
      }
      // 不返回：server 保持打开，事件循环非空 → 进程常驻
      await new Promise<void>((resolve) => {
        process.once('SIGINT', () => void handle.close().then(() => resolve()));
        process.once('SIGTERM', () => void handle.close().then(() => resolve()));
      });
      return 0;
    }

    let out: ToolOutput;

    // ---- 项目预设 / 组件库（与 MCP 同一套 handler；不依赖 daemon）----
    if (cmd === 'preset') {
      const action = file ?? 'list';
      if (action === 'list') {
        out = await call('paintress_preset', { action: 'list', ...(a1 !== undefined ? { path: a1 } : {}) });
      } else if (action === 'groups') {
        const full = (await call('paintress_preset', {
          action: 'list',
          ...(a1 !== undefined ? { path: a1 } : {}),
        })) as { path?: string | null; groups?: unknown };
        out = { ok: true, path: full.path ?? null, groups: full.groups ?? {} };
      } else if (action === 'seed') {
        out = await call('paintress_preset', {
          action: 'seed',
          ...(a1 !== undefined ? { path: a1 } : {}),
          ...(flags['apply'] === true ? { apply: true } : {}),
        });
      } else if (action === 'set-group') {
        if (!a1 || !a2 || !positionals[3] || !positionals[4]) {
          throw new Error("用法：paintress preset set-group <dir> <组名> <target> '<props-json>'");
        }
        let props: Record<string, string>;
        try {
          props = JSON.parse(positionals[4]) as Record<string, string>;
        } catch {
          throw new Error(`props 不是合法 JSON：${positionals[4]}`);
        }
        out = await call('paintress_preset', { action: 'set-group', path: a1, group: a2, target: positionals[3], props });
      } else if (action === 'remove-group') {
        if (!a1 || !a2) throw new Error('用法：paintress preset remove-group <dir> <组名>');
        out = await call('paintress_preset', { action: 'remove-group', path: a1, group: a2 });
      } else if (action === 'set') {
        if (!a1 || !a2 || !positionals[3] || !positionals[4]) {
          throw new Error('用法：paintress preset set <dir> <key> <color|radius|spacing|fontSize|font> <value> [--name 名称]');
        }
        out = await call('paintress_preset', {
          action: 'set',
          path: a1,
          key: a2,
          type: positionals[3],
          value: positionals[4],
          ...(flagStr(flags, 'name') !== undefined ? { name: flagStr(flags, 'name') } : {}),
        });
      } else if (action === 'remove') {
        if (!a1 || !a2) throw new Error('用法：paintress preset remove <dir> <key>');
        out = await call('paintress_preset', { action: 'remove', path: a1, key: a2 });
      } else {
        throw new Error(`未知 preset 动作：${action}（list / set / remove / seed / set-group / remove-group）`);
      }
      console.log(JSON.stringify(out, null, 2));
      return 0;
    }
    if (cmd === 'component') {
      const action = file ?? 'list';
      if (action === 'list') {
        out = await call('paintress_component', { action: 'list', ...(a1 !== undefined ? { path: a1 } : {}) });
      } else if (action === 'insert') {
        if (!a1 || !a2) throw new Error('用法：paintress component insert <file> <id> [--parent p] [--index n]');
        out = await call('paintress_component', {
          action: 'insert',
          path: a1,
          id: a2,
          ...(flagStr(flags, 'parent') !== undefined ? { parent: flagStr(flags, 'parent') } : {}),
          ...(flagNum(flags, 'index') !== undefined ? { index: flagNum(flags, 'index') } : {}),
        });
      } else if (action === 'add') {
        if (!a1 || !a2) throw new Error('用法：paintress component add <file> <id> [--name 名称] [--parent p] [--index n]');
        out = await call('paintress_component', {
          action: 'add',
          path: a1,
          id: a2,
          ...(flagStr(flags, 'name') !== undefined ? { name: flagStr(flags, 'name') } : {}),
          ...(flagStr(flags, 'parent') !== undefined ? { parent: flagStr(flags, 'parent') } : {}),
          ...(flagNum(flags, 'index') !== undefined ? { index: flagNum(flags, 'index') } : {}),
        });
      } else {
        throw new Error(`未知 component 动作：${action}（list / insert / add）`);
      }
      console.log(JSON.stringify(out, null, 2));
      return 0;
    }

    if (cmd === 'font') {
      const action = file ?? 'list';
      if (action === 'list') {
        out = await call('paintress_font', { action: 'list', ...(a1 !== undefined ? { path: a1 } : {}) });
      } else if (action === 'remove') {
        if (!a1 || !a2) throw new Error('用法：paintress font remove <dir> <family>');
        out = await call('paintress_font', { action: 'remove', path: a1, family: a2 });
      } else if (action === 'default') {
        if (!a1 || !a2) throw new Error('用法：paintress font default <dir> <token-or-family>');
        out = await call('paintress_font', { action: 'default', path: a1, value: a2 });
      } else if (action === 'add') {
        if (!a1 || !a2 || !positionals[3]) {
          throw new Error(
            "用法：paintress font add <dir> <family> <web|css|file|system|bundle> [source] [--preview x] [--note n] [--metrics '{\"sizeAdjust\":\"96%\"}']",
          );
        }
        const metricsRaw = flagStr(flags, 'metrics');
        let metrics: Record<string, string> | undefined;
        if (metricsRaw !== undefined) {
          try {
            metrics = JSON.parse(metricsRaw) as Record<string, string>;
          } catch {
            throw new Error(`metrics 不是合法 JSON：${metricsRaw}`);
          }
        }
        const preview = flagStr(flags, 'preview');
        const note = flagStr(flags, 'note');
        out = await call('paintress_font', {
          action: 'add',
          path: a1,
          family: a2,
          kind: positionals[3],
          ...(positionals[4] !== undefined ? { source: positionals[4] } : {}),
          ...(preview !== undefined ? { preview } : {}),
          ...(note !== undefined ? { note } : {}),
          ...(metrics !== undefined ? { metrics } : {}),
        });
      } else {
        throw new Error(`未知 font 动作：${action}（list / add / remove / default）`);
      }
      console.log(JSON.stringify(out, null, 2));
      return 0;
    }

    if (cmd === 'project') {
      out = await call('paintress_project', {
        ...(file !== undefined ? { path: file } : {}),
      });
      console.log(JSON.stringify(out, null, 2));
      return 0;
    }

    if (cmd === 'convert') {
      out = await call('paintress_convert', {
        path: file,
        ...(a1 !== undefined ? { out: a1 } : {}),
        ...(flags['force'] === true ? { overwrite: true } : {}),
      });
      console.log(JSON.stringify(out, null, 2));
      return 0;
    }

    if (!file) throw new Error('缺少 <file> 参数');

    switch (cmd) {
      case 'new': {
        const name = flagStr(flags, 'name');
        const width = flagNum(flags, 'width');
        const height = flagNum(flags, 'height');
        const fill = flagStr(flags, 'fill');
        const layout = flagStr(flags, 'layout');
        const padding = flagNum(flags, 'padding');
        const gap = flagNum(flags, 'gap');
        out = await call('paintress_new', {
          path: file,
          ...(name !== undefined ? { name } : {}),
          ...(width !== undefined ? { width } : {}),
          ...(height !== undefined ? { height } : {}),
          ...(fill !== undefined ? { fill } : {}),
          ...(layout !== undefined ? { layout } : {}),
          ...(padding !== undefined ? { padding } : {}),
          ...(gap !== undefined ? { gap } : {}),
          ...(flags['force'] === true ? { overwrite: true } : {}),
        });
        break;
      }
      case 'info':
        out = await call('paintress_doc_info', { path: file });
        break;
      case 'query':
        out = await call('paintress_query', {
          path: file,
          ...(flagStr(flags, 'type') !== undefined ? { type: flagStr(flags, 'type') } : {}),
          ...(flagStr(flags, 'name') !== undefined ? { name: flagStr(flags, 'name') } : {}),
          ...(flags['regex'] === true ? { nameRegex: true } : {}),
          ...(flagStr(flags, 'id') !== undefined ? { id: flagStr(flags, 'id') } : {}),
          ...(flags['reusable'] === true ? { reusable: true } : {}),
        });
        break;
      case 'get': {
        if (!a1) throw new Error('缺少 <id> 参数');
        out = await call('paintress_get', { path: file, id: a1, ...(flagNum(flags, 'depth') !== undefined ? { depth: flagNum(flags, 'depth') } : {}) });
        break;
      }
      case 'update': {
        if (!a1) throw new Error('缺少 <id> 参数');
        const patch = parseJson<Record<string, unknown>>(a2 ?? '', 'patch');
        out = await call('paintress_update', { path: file, id: a1, patch });
        break;
      }
      case 'insert': {
        if (!a1) throw new Error("缺少 <parent> 参数（节点 id 或 'root'）");
        const node = parseJson<Record<string, unknown>>(a2 ?? '', 'node');
        out = await call('paintress_insert', {
          path: file,
          parent: a1,
          node,
          ...(flagNum(flags, 'index') !== undefined ? { index: flagNum(flags, 'index') } : {}),
        });
        break;
      }
      case 'delete':
        if (!a1) throw new Error('缺少 <id> 参数');
        out = await call('paintress_delete', { path: file, id: a1 });
        break;
      case 'move':
        if (!a1 || !a2) throw new Error('缺少 <id> 或 <parent> 参数');
        out = await call('paintress_move', {
          path: file,
          id: a1,
          parent: a2,
          ...(flagNum(flags, 'index') !== undefined ? { index: flagNum(flags, 'index') } : {}),
        });
        break;
      case 'batch': {
        const ops = parseJson<unknown[]>(a1 ?? '', 'ops');
        out = await call('paintress_batch', { path: file, ops });
        break;
      }
      case 'validate':
        out = await call('paintress_validate', { path: file });
        break;
      case 'render': {
        if (!a1) throw new Error('缺少 <out.html> 参数');
        out = await call('paintress_render', {
          path: file,
          out: a1,
          ...(flags['embed-fonts'] === true ? { embedFonts: true } : {}),
        });
        break;
      }
      case 'audit': {
        out = await call('paintress_audit', { path: file });
        break;
      }
      case 'establish': {
        out = await call('paintress_establish', {
          path: file,
          ...(flags['apply'] === true ? { apply: true } : {}),
          ...(flagNum(flags, 'min-uses') !== undefined ? { minUses: flagNum(flags, 'min-uses') } : {}),
        });
        break;
      }
      case 'adjust': {
        const key = flagStr(flags, 'key');
        const group = flagStr(flags, 'group');
        const prop = flagStr(flags, 'prop');
        const value = flagStr(flags, 'value');
        if (value === undefined) throw new Error('adjust 需要 --value');
        out = await call('paintress_adjust', {
          path: file,
          value,
          ...(key !== undefined ? { key } : {}),
          ...(group !== undefined ? { group } : {}),
          ...(prop !== undefined ? { prop } : {}),
          ...(flags['apply'] === true ? { apply: true } : {}),
        });
        break;
      }
      case 'shot': {
        if (!a1) throw new Error('缺少 <out.png> 参数');
        if (flags['board'] === true) throw new Error('--board 需要画板 id 或 name');
        const board = flagStr(flags, 'board');
        out = await call('paintress_screenshot', {
          path: file,
          out: a1,
          ...(flagDecimal(flags, 'scale') !== undefined ? { scale: flagDecimal(flags, 'scale') } : {}),
          ...(board !== undefined ? { board } : {}),
        });
        break;
      }
      default:
        console.error(`未知子命令：${cmd}`);
        return 2;
    }
    console.log(JSON.stringify(out, null, 2));
    return 0;
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause));
    return 1;
  }
}

// 直接执行时（bin）启动；被 import 时不执行。
// 不能用 argv[1].endsWith('cli.js') 判断：npm 安装后的 bin 是指向 dist/cli.js 的符号链接，
// argv[1] 变成 `.../node_modules/.bin/paintress`，后缀匹配会失败 → 静默退出 0。
// 改用 realpath 比较：符号链接、`node dist/cli.js`、直接执行三种情况下都能正确识别。
export function isDirectExecution(entry = process.argv[1], moduleUrl = import.meta.url): boolean {
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  void main(process.argv.slice(2)).then((code) => {
    if (code !== 0) process.exitCode = code;
  });
}
