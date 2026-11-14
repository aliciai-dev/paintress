import { createServer, type Server as HttpServer } from 'node:http';
import { createServer as createNetServer, type Server as NetServer } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  bindWithFallback,
  DEFAULT_PORT,
  PORT_CANDIDATES,
  type BindOptions,
  type LadderSeams,
  type WindowsReport,
} from '../src/web/bind.js';

/**
 * 端口阶梯的判据（2026-11-15）：WSL 里 daemon 自己能连、宿主浏览器连不上，
 * 原因是宿主侧绑不上这个端口（Hyper-V 保留段）→ wslrelay 不落地转发。
 *
 * 这里全部走注入接缝：测试机可能就在 WSL 里，但测试**绝不真的调用 Windows**，
 * 也绝不占用 6033/6133/6233 这三个真实候选端口。
 */

const create = (): HttpServer =>
  createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, pong: true }));
  });

const opened: HttpServer[] = [];
const extra: Array<HttpServer | NetServer> = [];

afterEach(async () => {
  await Promise.all(
    [...opened, ...extra].map((s) => new Promise<void>((resolve) => (s.listening ? s.close(() => resolve()) : resolve()))),
  );
  opened.length = 0;
  extra.length = 0;
});

/** 取 n 个互不相同的空闲端口（临时 listener 拿号后立刻释放） */
async function freePorts(n: number): Promise<number[]> {
  const ports: number[] = [];
  for (let i = 0; i < n; i++) {
    const srv = createNetServer();
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', () => resolve()));
    const addr = srv.address();
    const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
    await new Promise<void>((resolve) => srv.close(() => resolve()));
    if (port === 0 || ports.includes(port)) {
      i--;
      continue;
    }
    ports.push(port);
  }
  return ports;
}

async function occupy(port: number): Promise<NetServer> {
  const srv = createNetServer();
  await new Promise<void>((resolve) => srv.listen(port, '127.0.0.1', () => resolve()));
  extra.push(srv);
  return srv;
}

const bind = (opts: BindOptions): ReturnType<typeof bindWithFallback> => bindWithFallback(opts);

describe('端口阶梯', () => {
  it('默认端口与候选序：6033 → 6133 → 6233', () => {
    expect(DEFAULT_PORT).toBe(6033);
    expect([...PORT_CANDIDATES]).toEqual([6033, 6133, 6233]);
  });

  it('all 模式的项目 URL 用网卡地址，不写死 localhost/0.0.0.0', async () => {
    const { baseUrl, projectUrl } = await import('../src/web/open-browser.js');
    const origin = { port: 6033, host: '172.24.47.146' };
    expect(baseUrl(origin)).toBe('http://172.24.47.146:6033/');
    expect(projectUrl(origin, 'acme/shop')).toBe('http://172.24.47.146:6033/acme/shop');
  });

  it('第一个候选能用就只试一次；非 WSL 不做宿主探测', async () => {
    const [p1, p2] = await freePorts(2);
    const probe = vi.fn(async () => true);
    const seams: LadderSeams = { isWsl: () => false, probe };
    const res = await bind({ create, nonce: 'nonce-a', ports: [p1 as number, p2 as number], seams });
    opened.push(res.server);
    expect(res.endpoint.port).toBe(p1);
    expect(res.access.url).toBe(`http://localhost:${String(p1)}/`);
    expect(res.access.windows).toBe('skipped');
    expect(res.access.jumped).toBe(false);
    expect(res.access.attempts).toHaveLength(1);
    expect(probe).not.toHaveBeenCalled();
  });

  it('端口在 Windows 保留段：不 listen，直接跳下一个', async () => {
    const [p1, p2] = await freePorts(2);
    const report: WindowsReport = { excluded: [[p1 as number, p1 as number]], bindable: {} };
    const res = await bind({
      create,
      nonce: 'nonce-b',
      ports: [p1 as number, p2 as number],
      seams: { isWsl: () => true, report: async () => report, probe: async () => true },
    });
    opened.push(res.server);
    expect(res.endpoint.port).toBe(p2);
    expect(res.access.jumped).toBe(true);
    expect(res.access.windows).toBe('ok');
    expect(res.access.attempts[0]?.result).toBe('windows-reserved');
  });

  it('端口在 Windows 侧已被别的进程占用：同样跳下一个', async () => {
    const [p1, p2] = await freePorts(2);
    const res = await bind({
      create,
      nonce: 'nonce-c',
      ports: [p1 as number, p2 as number],
      seams: {
        isWsl: () => true,
        report: async () => ({ excluded: [], bindable: { [String(p1)]: false } }),
        probe: async () => true,
      },
    });
    opened.push(res.server);
    expect(res.endpoint.port).toBe(p2);
    expect(res.access.attempts[0]).toMatchObject({ result: 'in-use', detail: 'Windows 侧不可绑（已被占用或已转发）' });
  });

  it('WSL 内端口已被占用（EADDRINUSE）：跳下一个', async () => {
    const [p1, p2] = await freePorts(2);
    await occupy(p1 as number);
    const res = await bind({ create, nonce: 'nonce-d', ports: [p1 as number, p2 as number], seams: { isWsl: () => false } });
    opened.push(res.server);
    expect(res.endpoint.port).toBe(p2);
    expect(res.access.attempts[0]).toMatchObject({ result: 'in-use', detail: 'EADDRINUSE' });
    expect(res.access.jumped).toBe(true);
    expect(res.access.requestedPort).toBe(p1);
  });

  it('loopback 三连宿主都连不上 → 落 0.0.0.0 的第一个候选，且探测带 nonce', async () => {
    const [p1, p2, p3] = await freePorts(3);
    const urls: string[] = [];
    const res = await bind({
      create,
      nonce: 'nonce-e',
      ports: [p1 as number, p2 as number, p3 as number],
      seams: {
        isWsl: () => true,
        hostIpv4: () => '10.9.9.9',
        report: async () => ({ excluded: [], bindable: { [String(p1)]: true, [String(p2)]: true, [String(p3)]: true } }),
        // 只有绑 0.0.0.0 时宿主（经网卡地址）才连得上 —— 正是本机 2026-11-15 的实况
        probe: async (url) => {
          urls.push(url);
          return url.startsWith('http://10.9.9.9:');
        },
      },
    });
    opened.push(res.server);
    expect(res.endpoint).toMatchObject({ port: p1, bind: 'all', host: '0.0.0.0' });
    expect(res.access.bind).toBe('all');
    expect(res.access.url).toBe(`http://10.9.9.9:${String(p1)}/`);
    expect(res.access.windows).toBe('ok');
    expect(res.access.attempts.map((a) => a.result)).toEqual([
      'windows-unreachable',
      'windows-unreachable',
      'windows-unreachable',
      'ok',
    ]);
    expect(urls.every((u) => u.includes('nonce=nonce-e'))).toBe(true);
  });

  it('六个候选全灭：报错带完整尝试表', async () => {
    const [p1, p2, p3] = await freePorts(3);
    const ports = [p1 as number, p2 as number, p3 as number];
    await expect(
      bind({
        create,
        nonce: 'nonce-f',
        ports,
        seams: {
          isWsl: () => true,
          report: async () => ({ excluded: [[p1 as number, p3 as number]], bindable: {} }),
          probe: async () => false,
        },
      }),
    ).rejects.toThrow(/6 个候选全部失败/);
  });

  it('显式 --port：不跳级，被占用直接报错', async () => {
    const [p1, p2] = await freePorts(2);
    await occupy(p1 as number);
    await expect(
      bind({ create, nonce: 'nonce-g', requestedPort: p1 as number, ports: [p1 as number, p2 as number], seams: { isWsl: () => false } }),
    ).rejects.toThrow(/显式 --port 不跳级/);
  });

  it('显式 --port + --bind all：绑 0.0.0.0，url 用网卡地址', async () => {
    const [p1] = await freePorts(1);
    const res = await bind({
      create,
      nonce: 'nonce-h',
      requestedPort: p1 as number,
      bind: 'all',
      seams: { isWsl: () => true, hostIpv4: () => '10.9.9.9', report: async () => ({ excluded: [], bindable: {} }), probe: async () => true },
    });
    opened.push(res.server);
    expect(res.endpoint).toMatchObject({ port: p1, bind: 'all' });
    expect(res.access.url).toBe(`http://10.9.9.9:${String(p1)}/`);
  });

  it('WSL 无可用网卡地址时，all 候选不能拿 0.0.0.0 冒充可访问 URL', async () => {
    const [p1, p2] = await freePorts(2);
    const probe = vi.fn(async () => true);
    await expect(
      bind({
        create,
        nonce: 'nonce-j',
        bind: 'all',
        ports: [p1 as number, p2 as number],
        seams: { isWsl: () => true, hostIpv4: () => null, probe },
      }),
    ).rejects.toThrow(/2 个候选全部失败/);
    expect(probe).not.toHaveBeenCalled();
  });

  it('port 0（内核分配）：整段宿主校验跳过，端口取自实际监听', async () => {
    const probe = vi.fn(async () => false);
    const res = await bind({ create, nonce: 'nonce-i', requestedPort: 0, seams: { isWsl: () => true, probe } });
    opened.push(res.server);
    expect(res.endpoint.port).toBeGreaterThan(0);
    expect(res.access.windows).toBe('skipped');
    expect(res.access.jumped).toBe(false);
    expect(res.access.url).toBe(`http://localhost:${String(res.endpoint.port)}/`);
    expect(probe).not.toHaveBeenCalled();
  });
});
