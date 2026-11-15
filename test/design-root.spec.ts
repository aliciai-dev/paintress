import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CONFIG_FILE, guardProjectRoot, projectRootMarkers, resolveDesignRoot } from '../src/web/design-root.js';
import { COMPONENTS_FILE, PRESET_FILE } from '../src/doc/project.js';
import { startDaemon, type DaemonHandle } from '../src/web/daemon.js';
import { sendRequest } from '../src/web/client.js';
import { autoRegister, closeViewerHandles } from '../src/web/autoregister.js';
import { TOOLS } from '../src/mcp/tools.js';

/**
 * 设计根解析与项目根硬门槛。
 *
 * 背景：MCP server 启动时按 cwd 自动注册，而 cwd 常常是代码仓库根；注册会顺手 scaffold
 * 出 `__preset.ptr` / `__components.ptr`，于是仓库根长出两份空文件。这组用例锁住两件事：
 * 1. 解析器会挑设计目录而不是仓库根（含 `paintress.json` 声明、cwd 只剩下空脚手架的情况）；
 * 2. daemon 对「像项目根又没设计稿」的目录直接拒绝注册，且不留任何文件。
 */

const roots: string[] = [];
function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `paintress-root-${prefix}-`));
  roots.push(dir);
  return dir;
}

const pen = (id: string): string =>
  JSON.stringify({ version: '2.22', fileToken: `00000000-0000-4000-8000-0000000000${id}`, children: [] });

afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

describe('resolveDesignRoot', () => {
  it('显式目录一律照办，不做任何猜测', () => {
    const repo = tmp('explicit');
    mkdirSync(join(repo, 'design'));
    writeFileSync(join(repo, 'package.json'), '{}');
    const decision = resolveDesignRoot(repo, join(repo, 'design'));
    expect(decision.reason).toBe('explicit');
    expect(decision.confident).toBe(true);
    expect(decision.root).toBe(join(repo, 'design'));
  });

  it('paintress.json 声明的设计根优先于后面的所有启发式', () => {
    const repo = tmp('declared');
    writeFileSync(join(repo, 'package.json'), '{}');
    // 名字更像设计目录的那个不该赢
    mkdirSync(join(repo, 'design'));
    writeFileSync(join(repo, 'design', 'a.ptr'), pen('aa'));
    mkdirSync(join(repo, 'artwork'));
    writeFileSync(join(repo, 'artwork', 'b.ptr'), pen('bb'));
    writeFileSync(join(repo, CONFIG_FILE), JSON.stringify({ root: 'artwork' }));

    const decision = resolveDesignRoot(repo);
    expect(decision.reason).toBe('declared');
    expect(decision.confident).toBe(true);
    expect(decision.root).toBe(join(repo, 'artwork'));
  });

  it('子目录的 paintress.json 向上也能被找到（从设计稿所在子目录启动）', () => {
    const repo = tmp('declared-up');
    writeFileSync(join(repo, CONFIG_FILE), JSON.stringify({ root: 'ui' }));
    mkdirSync(join(repo, 'ui', 'inner'), { recursive: true });
    expect(resolveDesignRoot(join(repo, 'ui', 'inner')).root).toBe(join(repo, 'ui'));
  });

  it('声明的 root 不存在时 fail closed，不回退去猜另一个目录', () => {
    const repo = tmp('declared-missing');
    writeFileSync(join(repo, 'package.json'), '{}');
    writeFileSync(join(repo, CONFIG_FILE), JSON.stringify({ root: 'missing' }));
    mkdirSync(join(repo, 'design'));
    writeFileSync(join(repo, 'design', 'a.ptr'), pen('ab'));

    const decision = resolveDesignRoot(repo);
    expect(decision.confident).toBe(false);
    expect(decision.message).toContain('不存在或不可读');
    expect(decision.candidates).toEqual([]);
  });

  it('坏 JSON 同样 fail closed，不静默忽略人的配置', () => {
    const repo = tmp('declared-invalid');
    writeFileSync(join(repo, CONFIG_FILE), '{');
    const decision = resolveDesignRoot(repo);
    expect(decision.confident).toBe(false);
    expect(decision.message).toContain('不是合法 JSON');
  });

  it('向上找配置不越过仓库根，避免套用上级项目的约定', () => {
    const parent = tmp('declared-boundary');
    const outside = join(parent, 'outside');
    const repo = join(parent, 'repo');
    mkdirSync(outside);
    mkdirSync(join(repo, '.git'), { recursive: true });
    writeFileSync(join(parent, CONFIG_FILE), JSON.stringify({ root: 'outside' }));

    const decision = resolveDesignRoot(repo);
    expect(decision.reason).not.toBe('declared');
    expect(decision.confident).toBe(false);
  });

  it('仓库根 + design/ 子目录：挑 design/，仓库根没有 package.json 也不选它', () => {
    const repo = tmp('child');
    mkdirSync(join(repo, 'design'));
    writeFileSync(join(repo, 'design', 'calculator.ptr'), pen('cc'));
    // 上次误注册留下的空脚手架：不能把它当强证据
    writeFileSync(join(repo, PRESET_FILE), '{}');
    writeFileSync(join(repo, COMPONENTS_FILE), '{}');
    writeFileSync(join(repo, 'AGENTS.md'), '# repo\n');

    const decision = resolveDesignRoot(repo);
    expect(decision.reason).toBe('child');
    expect(decision.confident).toBe(true);
    expect(decision.root).toBe(join(repo, 'design'));
  });

  it('代码仓库根（有 AGENTS.md / package.json）且本层没有设计稿 → 不选它', () => {
    const repo = tmp('repo-root');
    writeFileSync(join(repo, 'package.json'), '{}');
    writeFileSync(join(repo, 'AGENTS.md'), '# agent\n');
    mkdirSync(join(repo, 'src'));
    writeFileSync(join(repo, 'src', 'a.ts'), 'export {};\n');

    const decision = resolveDesignRoot(repo);
    expect(decision.confident).toBe(false);
    expect(decision.reason).toBe('none');
    expect(decision.root).toBe(repo);
  });

  it('两个同样像设计目录的候选并列 → 不猜，两个都交回去', () => {
    const repo = tmp('tie');
    for (const [dir, file] of [
      ['design', 'a.ptr'],
      ['mockups', 'b.ptr'],
    ] as const) {
      mkdirSync(join(repo, dir));
      writeFileSync(join(repo, dir, file), pen('dd'));
    }
    const decision = resolveDesignRoot(repo);
    expect(decision.confident).toBe(false);
    const names = decision.candidates.filter((c) => c.score > 0).map((c) => c.name);
    expect(names).toContain('design');
    expect(names).toContain('mockups');
  });

  it('cwd 本身就是设计目录（本层有稿）→ 用 cwd', () => {
    const dir = tmp('cwd-design');
    writeFileSync(join(dir, 'screen.ptr'), pen('ee'));
    const decision = resolveDesignRoot(dir);
    expect(decision.reason).toBe('cwd');
    expect(decision.confident).toBe(true);
    expect(decision.root).toBe(dir);
  });

  it('空目录：既不猜也不报错，只说明没有把握并要求先问用户', () => {
    const dir = tmp('empty');
    const decision = resolveDesignRoot(dir);
    expect(decision.confident).toBe(false);
    expect(decision.message).toContain('问用户');
  });
});

describe('guardProjectRoot', () => {
  it('项目根 + 没设计稿 → 拒绝，并说清怎么改', () => {
    const repo = tmp('guard-repo');
    writeFileSync(join(repo, 'package.json'), '{}');
    const guard = guardProjectRoot(repo);
    expect(guard.ok).toBe(false);
    expect(guard.error).toContain('像项目根');
    expect(guard.hint).toContain('--force');
    expect(guard.markers.map((m) => m.file)).toContain('package.json');
  });

  it('项目根里本层就有设计稿 → 放行（可能就是专门放设计的仓库）', () => {
    const repo = tmp('guard-design-repo');
    writeFileSync(join(repo, 'AGENTS.md'), '# design repo\n');
    writeFileSync(join(repo, 'home.ptr'), pen('ff'));
    expect(guardProjectRoot(repo).ok).toBe(true);
  });

  it('普通目录（没有任何项目根标志）→ 放行，不打扰人', () => {
    const dir = tmp('guard-plain');
    mkdirSync(join(dir, 'design'));
    expect(guardProjectRoot(dir).ok).toBe(true);
    expect(projectRootMarkers(dir)).toEqual([]);
  });

  it('.git 算项目根标志', () => {
    const repo = tmp('guard-dotgit');
    mkdirSync(join(repo, '.git'));
    expect(guardProjectRoot(repo).ok).toBe(false);
  });
});

describe('daemon 注册门槛（回归：仓库根不再长项目文件）', () => {
  let home: string;
  let daemon: DaemonHandle;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'paintress-guard-home-'));
    process.env['PAINTRESS_HOME'] = home;
    daemon = await startDaemon({ port: 0, idleTimeoutMs: 10 * 60_000, idleCheckMs: 5_000, quiet: true });
  });

  afterAll(async () => {
    closeViewerHandles();
    await daemon.close();
    rmSync(home, { recursive: true, force: true });
    delete process.env['PAINTRESS_HOME'];
  });

  it('像项目根的目录：拒绝注册，且一个文件都不建', async () => {
    const repo = tmp('daemon-refuse');
    writeFileSync(join(repo, 'package.json'), '{}');
    mkdirSync(join(repo, 'design'));
    writeFileSync(join(repo, 'design', 'a.ptr'), pen('11'));

    const res = await sendRequest({ kind: 'watch', project: 'guard-refuse', dir: repo });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.hint).toContain('--force');
    expect(existsSync(join(repo, PRESET_FILE))).toBe(false);
    expect(existsSync(join(repo, COMPONENTS_FILE))).toBe(false);

    const status = await sendRequest({ kind: 'status' });
    if (status.ok && 'projects' in status && Array.isArray(status.projects)) {
      expect(status.projects.map((p) => p.name)).not.toContain('guard-refuse');
    }
  });

  it('force: true 时照办，并建好项目文件', async () => {
    const repo = tmp('daemon-force');
    writeFileSync(join(repo, 'package.json'), '{}');

    const res = await sendRequest({ kind: 'watch', project: 'guard-force', dir: repo, force: true });
    expect(res.ok).toBe(true);
    expect(existsSync(join(repo, PRESET_FILE))).toBe(true);
    expect(existsSync(join(repo, COMPONENTS_FILE))).toBe(true);
  });

  it('scaffold: false（自动注册的默认）注册成功但不建项目文件', async () => {
    const dir = tmp('daemon-noscaffold');
    writeFileSync(join(dir, 'a.ptr'), pen('22'));

    const res = await sendRequest({ kind: 'watch', project: 'guard-noscaffold', dir, scaffold: false });
    expect(res.ok).toBe(true);
    expect(existsSync(join(dir, PRESET_FILE))).toBe(false);
    expect(existsSync(join(dir, COMPONENTS_FILE))).toBe(false);
  });

  it('autoRegister(cwd) 以传入目录为起点选设计根，且不在仓库根建文件', async () => {
    const repo = tmp('autoregister-cwd');
    writeFileSync(join(repo, 'package.json'), '{}');
    mkdirSync(join(repo, 'design'));
    writeFileSync(join(repo, 'design', 'a.ptr'), pen('33'));

    const info = await autoRegister(repo);
    expect(info).not.toBeNull();
    expect(info?.root).toBe(join(repo, 'design'));
    expect(info?.designRoot.reason).toBe('child');
    expect(existsSync(join(repo, PRESET_FILE))).toBe(false);
    expect(existsSync(join(repo, COMPONENTS_FILE))).toBe(false);
  });

  it('paintress_viewer 没找到设计根时，回 next 引导先问用户再建目录', async () => {
    const dir = tmp('ask-user');
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(dir);
    try {
      const out = (await TOOLS['paintress_viewer']!.run({})) as Record<string, unknown>;
      expect(out['ok']).toBe(false);
      const next = String(out['next'] ?? '');
      expect(next).toContain('Ask the user');
      expect(next).toContain('design/');
      expect(next.toLowerCase()).toContain('do not create a directory');
      // 不允许的业务动作必须在提示里明确排除
      expect(next.toLowerCase()).toContain('force');
      expect(existsSync(join(dir, 'design'))).toBe(false);
      expect(existsSync(join(dir, PRESET_FILE))).toBe(false);
    } finally {
      cwd.mockRestore();
    }
  });

  it('paintress_viewer 的 force: true 能注册没有可信候选的当前目录（与错误提示一致）', async () => {
    const repo = tmp('force-unresolved');
    writeFileSync(join(repo, 'package.json'), '{}');
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(repo);
    try {
      const out = (await TOOLS['paintress_viewer']!.run({ force: true })) as Record<string, unknown>;
      expect(out['ok']).toBe(true);
      expect(out['root']).toBe(repo);
      expect(out['designRoot']).toMatchObject({ reason: 'cwd', confident: true });
      // MCP 工具与旧行为一致：成功打开项目后保证项目文件存在
      expect(existsSync(join(repo, PRESET_FILE))).toBe(true);
      expect(existsSync(join(repo, COMPONENTS_FILE))).toBe(true);
    } finally {
      cwd.mockRestore();
    }
  });
});
