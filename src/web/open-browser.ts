import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

/**
 * 在**人所在那台机器**的浏览器里打开查看器。
 *
 * 设计前提（operator 2026-11-13）：界面状态由 agent 侧驱动，
 * 人不需要去记「进程起没起、项目绑没绑」—— agent 第一次把项目交给 web 时，
 * 浏览器就该自己弹出来，并且直接落在那个项目上。**开窗口是程序的事，不是 agent 的事**：
 * 提示词里只说「跑 paintress web」，一句也不提浏览器（见 skills/paintress/SKILL.md）。
 *
 * 因此这里的唯一职责是「别开错地方」：
 * - **WSL（2026-11-14 修）**：DISPLAY 由 WSLg 提供，`xdg-open` 会拉起 WSL 里的 Linux 浏览器，
 *   窗口虽然能看见，但那不是宿主（Windows）的浏览器。必须走 Windows interop：
 *   `wslview` → `powershell.exe Start-Process` → `cmd.exe start` → `explorer.exe`。
 * - 原生 Linux：`xdg-open`；无图形环境（无 DISPLAY / WAYLAND_DISPLAY）直接跳过。
 * - macOS：`open`；Windows：`cmd /c start`。
 *
 * 关闭方式：`PAINTRESS_NO_OPEN=1`（CI、远程服务器、或在 SSH 里跑 agent 时用）。
 */

export interface BrowserLauncher {
  cmd: string;
  args: string[];
}

export interface LauncherContext {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  /** WSL 判定的第二判据；不传则读 /proc/sys/kernel/osrelease */
  osrelease?: string | null;
  /** 命令是否存在（测试注入）；默认按 PATH 查找 */
  has?: (cmd: string) => boolean;
}

/** 按 PATH 找可执行文件（不 shell out，避免和 shell 引号规则纠缠） */
export function onPath(cmd: string): boolean {
  if (cmd.includes('/')) return existsSync(cmd);
  for (const dir of (process.env['PATH'] ?? '').split(':')) {
    if (dir !== '' && existsSync(`${dir}/${cmd}`)) return true;
  }
  return false;
}

function readOsrelease(): string | null {
  try {
    return readFileSync('/proc/sys/kernel/osrelease', 'utf8');
  } catch {
    return null;
  }
}

/**
 * 是否跑在 WSL 里。环境变量优先（WSL_DISTRO_NAME / WSL_INTEROP），
 * 内核 release 里带 "microsoft" 是兜底（detached 子进程可能继承不到变量）。
 */
export function isWsl(ctx: LauncherContext = {}): boolean {
  if ((ctx.platform ?? process.platform) !== 'linux') return false;
  const env = ctx.env ?? process.env;
  if ((env['WSL_DISTRO_NAME'] ?? '') !== '' || (env['WSL_INTEROP'] ?? '') !== '') return true;
  const rel = ctx.osrelease !== undefined ? ctx.osrelease : readOsrelease();
  return rel !== null && /microsoft/i.test(rel);
}

/** Windows 侧打开 URL 的候选命令，按可靠度排序 */
function windowsLaunchers(url: string): BrowserLauncher[] {
  // PowerShell 的单引号字符串里 URL 的 % & ? 都是字面量，最稳；单引号本身转义成两个
  const ps = `Start-Process '${url.replace(/'/g, "''")}'`;
  return [
    { cmd: 'wslview', args: [url] },
    { cmd: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', ps] },
    { cmd: 'cmd.exe', args: ['/c', 'start', '', url] },
    { cmd: 'explorer.exe', args: [url] },
  ];
}

/**
 * 选出「在宿主浏览器里打开」的启动命令；返回 null 表示这台机器上没有可用的浏览器入口
 * （无图形环境、或 WSL 里一个 interop 命令都没有 —— 此时宁可不弹，也不要弹到错的浏览器）。
 */
export function browserLauncher(url: string, ctx: LauncherContext = {}): BrowserLauncher | null {
  const platform = ctx.platform ?? process.platform;
  const env = ctx.env ?? process.env;
  const has = ctx.has ?? onPath;

  if (isWsl(ctx)) {
    // 绝不回退到 xdg-open：在 WSLg 下它会开 WSL 内的 Linux 浏览器
    return windowsLaunchers(url).find((l) => has(l.cmd)) ?? null;
  }
  if (platform === 'darwin') return has('open') ? { cmd: 'open', args: [url] } : null;
  if (platform === 'win32') return { cmd: 'cmd', args: ['/c', 'start', '', url] };
  if ((env['DISPLAY'] ?? '') === '' && (env['WAYLAND_DISPLAY'] ?? '') === '') return null;
  return has('xdg-open') ? { cmd: 'xdg-open', args: [url] } : null;
}

export function openBrowser(url: string, ctx: LauncherContext = {}): boolean {
  const env = ctx.env ?? process.env;
  if (env['PAINTRESS_NO_OPEN'] === '1') return false;
  if (env['CI'] === '1' || env['CI'] === 'true') return false;

  const launcher = browserLauncher(url, ctx);
  if (launcher === null) return false;

  try {
    const child = spawn(launcher.cmd, launcher.args, { detached: true, stdio: 'ignore' });
    // 失败（没装、interop 没开、无权限）不能影响 daemon/MCP
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/** 顶层页面地址（项目列表）；项目深链见 projectUrl */
export function baseUrl(port: number): string {
  return `http://localhost:${port}/`;
}

/** 项目深链：项目 key 本身就带 `/`（`c-thun/raybend`），URL 里不需要转义 */
export function projectUrl(port: number, project?: string, file?: string): string {
  if (!project) return baseUrl(port);
  const path = project
    .split('/')
    .filter((s) => s !== '')
    .map(encodeURIComponent)
    .join('/');
  const qs = file ? `?file=${encodeURIComponent(file)}` : '';
  return `http://localhost:${port}/${path}${qs}`;
}
