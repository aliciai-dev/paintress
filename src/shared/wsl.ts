import { readFileSync, existsSync } from 'node:fs';
import { networkInterfaces } from 'node:os';

/**
 * WSL 判定与宿主侧探测的公共工具。
 *
 * 为什么单列一层：这个事实被两处消费者需要 ——
 * - `web/open-browser.ts`：决定浏览器往哪开（WSL 里必须走 Windows interop）；
 * - `web/bind.ts`：决定要不要做「Windows 侧能不能访问」的体检。
 * 判据只能有一份，复制第二份必然漂移。
 */

export interface PlatformContext {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  /** WSL 判定的第二判据；不传则读 /proc/sys/kernel/osrelease */
  osrelease?: string | null;
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
export function isWsl(ctx: PlatformContext = {}): boolean {
  if ((ctx.platform ?? process.platform) !== 'linux') return false;
  const env = ctx.env ?? process.env;
  if ((env['WSL_DISTRO_NAME'] ?? '') !== '' || (env['WSL_INTEROP'] ?? '') !== '') return true;
  const rel = ctx.osrelease !== undefined ? ctx.osrelease : readOsrelease();
  return rel !== null && /microsoft/i.test(rel);
}

/**
 * Windows 侧系统目录（`/mnt/c/Windows/System32`）。找不到返回 null：
 * 这是「能不能调 Windows 程序」的前提，null 时所有宿主探测都跳过。
 */
export function windowsSystem32(): string | null {
  const drive = process.env['SystemDrive']?.replace(/\0/g, '').toLowerCase();
  const candidates: string[] = [];
  if (drive !== undefined && /^[a-z]:$/.test(drive)) candidates.push(`/mnt/${drive[0]}/Windows/System32`);
  candidates.push('/mnt/c/Windows/System32');
  for (const letter of 'cdefg') candidates.push(`/mnt/${letter}/Windows/System32`);
  for (const c of candidates) {
    try {
      if (existsSync(c)) return c;
    } catch {
      /* 挂载点不可读：试下一个 */
    }
  }
  return null;
}

/** binfmt 注册项在不在：在 = interop 可执行（比试运行一条命令便宜得多） */
export function interopEnabled(): boolean {
  return existsSync('/proc/sys/fs/binfmt_misc/WSLInterop') || existsSync('/proc/sys/fs/binfmt_misc/WSLInterop-late');
}

/**
 * 默认路由所在网卡的 IPv4（WSL 里就是 eth0）。
 * 绑 0.0.0.0 时，Windows 要访问的就是这个地址 —— 不能随便取一张网卡，
 * 否则会拿到 docker0 之类的内网地址，给出去的 URL 直接不可用。
 */
export function defaultRouteIpv4(): string | null {
  const iface = defaultRouteInterface();
  const ifaces = networkInterfaces();
  const pick = (name: string | null): string | null => {
    if (name === null) return null;
    for (const addr of ifaces[name] ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
    }
    return null;
  };
  const fromRoute = pick(iface);
  if (fromRoute !== null) return fromRoute;
  // 没有默认路由（离线容器、CI）：退回第一张非回环网卡
  for (const name of Object.keys(ifaces)) {
    const hit = pick(name);
    if (hit !== null) return hit;
  }
  return null;
}

/** /proc/net/route：Destination 为 0 且带 RTF_GATEWAY 的那一行就是默认路由 */
export function defaultRouteInterface(): string | null {
  try {
    const lines = readFileSync('/proc/net/route', 'utf8').split('\n').slice(1);
    for (const line of lines) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 4) continue;
      const [, dest, , flags] = cols;
      if (dest !== '00000000') continue;
      const numeric = Number.parseInt(flags ?? '', 16);
      if ((numeric & 0x2) === 0) continue;
      return cols[0] ?? null;
    }
  } catch {
    /* 非 Linux 或无 /proc */
  }
  return null;
}
