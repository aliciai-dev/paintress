import { readdirSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { ProjectInfo } from './protocol.js';
import { resolveProjectDir, sanitizeProjectName } from './paths.js';

/**
 * 项目注册表（daemon 内存态）。
 * - attach 用「连接」而非 PID：连接断开即 agent 死亡（OS 保证），无需轮询
 * - 每项目独立 socket 集合，idle 判定综合 agent 与浏览器连接
 */

export interface ProjectEntry {
  name: string;
  /** 人看的展示名：与 key 一致（目录层级原样，如 `c-thun/raybend`） */
  label: string;
  root: string;
  rootReal: string;
  /** 列举设计稿的最大目录深度（默认 3，上限 6） */
  depth: number;
  /** agent 连接（attach），断开即移除 */
  agents: Set<symbol>;
  /** 浏览器 SSE 连接 */
  browsers: Set<symbol>;
  /**
   * 谁注册的：`agent` = MCP 自动注册（连接归零后可由 daemon 自动退场）；
   * `manual` = 人显式 watch（人显式绑的，只能人显式解）。
   * 手动 watch 永远覆盖自动标记，反向不成立。
   */
  owner: 'agent' | 'manual';
  lastAccess: number;
  createdAt: number;
}

export const DEFAULT_DEPTH = 3;
export const MAX_DEPTH = 6;

/** 深度夹取：非法/缺省回默认，超限封顶 */
function clampDepth(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return DEFAULT_DEPTH;
  const n = Math.trunc(raw);
  if (n < 1) return 1;
  return Math.min(n, MAX_DEPTH);
}

export const DESIGN_EXT = new Set(['.ptr', '.pen']);

export interface DesignFileStat {
  /** 相对项目根，统一用 `/` */
  path: string;
  mtimeMs: number;
  size: number;
}

/**
 * 项目内设计稿的相对路径与 stat；侧栏与预设变更通知共用同一份目录边界。
 * 遍历时本来就要 stat 每个条目（判目录 / 判扩展名），mtime 顺手带出来，不额外付 IO。
 * 返回相对路径统一用 `/`，调用方再按自己的用途 join 成绝对路径或拼 URL。
 */
export function listDesignFilesWithStat(root: string, maxDepth = DEFAULT_DEPTH): DesignFileStat[] {
  const out: DesignFileStat[] = [];
  const skip = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'target', '.venv', 'venv', '__pycache__']);
  const walk = (dir: string, rel: string, depth: number): void => {
    if (depth > maxDepth) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries.sort((a, b) => a.localeCompare(b))) {
      if (name.startsWith('.')) continue;
      const abs = join(dir, name);
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      const relPath = rel === '' ? name : `${rel}/${name}`;
      if (st.isDirectory()) {
        if (skip.has(name)) continue;
        walk(abs, relPath, depth + 1);
      } else if (DESIGN_EXT.has(extname(name).toLowerCase())) {
        // `__preset.ptr` / `__components.ptr` 是项目级基础设施，走各自的接口，
        // 不在设计稿列表里出现（否则侧栏和文件数都会被它们污染）
        if (!name.startsWith('__')) out.push({ path: relPath, mtimeMs: st.mtimeMs, size: st.size });
      }
    }
  };
  walk(root, '', 0);
  return out;
}

/** 只要路径的既有调用方（文件数、MCP 的 designFilesOf）走这里 */
export function listDesignFiles(root: string, maxDepth = DEFAULT_DEPTH): string[] {
  return listDesignFilesWithStat(root, maxDepth).map((file) => file.path);
}

export class Registry {
  private readonly projects = new Map<string, ProjectEntry>();

  /** 注册（或复用）项目目录；同名不同目录视为冲突。depth 默认 3、上限 6 */
  watch(
    projectNameRaw: string,
    dir: string,
    depth?: number,
    opts: { owner?: ProjectEntry['owner'] } = {},
  ): ProjectEntry {
    const name = sanitizeProjectName(projectNameRaw);
    const { root, rootReal } = resolveProjectDir(dir);
    const wanted = clampDepth(depth);
    const existing = this.projects.get(name);
    if (existing) {
      if (existing.rootReal !== rootReal) {
        throw new Error(`项目名 "${name}" 已被 ${existing.root} 占用，请换一个名字（--name）`);
      }
      if (depth !== undefined) existing.depth = wanted;
      existing.lastAccess = Date.now();
      // 手动 watch 覆盖自动标记；自动注册不动已存在的手动项目
      if (opts.owner === 'manual') existing.owner = 'manual';
      return existing;
    }
    const entry: ProjectEntry = {
      name,
      label: name,
      root,
      rootReal,
      depth: wanted,
      agents: new Set(),
      browsers: new Set(),
      owner: opts.owner ?? 'manual',
      lastAccess: Date.now(),
      createdAt: Date.now(),
    };
    this.projects.set(name, entry);
    return entry;
  }

  get(name: string): ProjectEntry | undefined {
    return this.projects.get(sanitizeProjectName(name));
  }

  remove(name: string): boolean {
    return this.projects.delete(sanitizeProjectName(name));
  }

  all(): ProjectEntry[] {
    return [...this.projects.values()];
  }

  /** 列出项目内设计稿（路径 + stat；深度由 entry.depth 控制，默认 3、上限 6） */
  listDesignStats(entry: ProjectEntry): DesignFileStat[] {
    return listDesignFilesWithStat(entry.rootReal, entry.depth);
  }

  /** 列出项目内设计稿相对路径 */
  listDesigns(entry: ProjectEntry): string[] {
    return this.listDesignStats(entry).map((file) => file.path);
  }

  info(entry: ProjectEntry): ProjectInfo {
    return {
      name: entry.name,
      label: entry.label,
      root: entry.root,
      depth: entry.depth,
      fileCount: this.listDesigns(entry).length,
      agentConns: entry.agents.size,
      browserConns: entry.browsers.size,
      lastAccess: entry.lastAccess,
    };
  }

  /** 存活判定：有 agent 或浏览器连接即活跃 */
  isIdle(entry: ProjectEntry): boolean {
    return entry.agents.size === 0 && entry.browsers.size === 0;
  }
}
