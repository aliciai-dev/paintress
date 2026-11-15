import { existsSync, readdirSync, readFileSync, statSync, type Stats } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { COMPONENTS_FILE, PRESET_FILE } from '../doc/project.js';

/**
 * 设计根解析：**在注册项目之前**决定「设计稿的家」是哪个目录。
 *
 * 背景：MCP server 启动时用 `process.cwd()` 自动注册项目，而 agent 的 cwd 往往是代码仓库根；
 * 注册会顺手 scaffold 出 `__preset.ptr` / `__components.ptr`，于是仓库根长出两份空文件
 * （`findProjectRootStrict` 的注释里管这叫「脏数据的来源」）。写路径早就有严格解析，
 * 注册路径没有——这里补上同一份纪律。
 *
 * 三层依据，从硬到软：
 * 1. 显式指定（工具参数 / `--dir`）——调用方说了算，一律照办；
 * 2. 声明式 `paintress.json` 的 `{ "root": "design" }`——人写进仓库的约定，向上就近查找；
 * 3. 候选打分——cwd 自己 + 直接子目录，看目录名、设计稿数量、已有项目文件；
 *    「像代码仓库根」的目录在不含设计稿时一票否决。
 *
 * 一律只读：这里不建目录、不写文件，探测失败就当没看见。
 */

/** 设计稿扩展名：与 registry.listDesigns 的 DESIGN_EXT 同义（此处独立一份，避免 web→web 循环依赖） */
const DESIGN_EXT = new Set(['.ptr', '.pen']);

/** 项目根的标志文件：命中任意一个，说明这是代码/文档仓库的根，不是设计目录 */
export const PROJECT_ROOT_MARKERS: readonly { file: string; what: string }[] = [
  { file: 'AGENTS.md', what: 'agent 说明书' },
  { file: 'CLAUDE.md', what: 'agent 说明书' },
  { file: '.git', what: 'git 仓库根' },
  { file: 'package.json', what: 'Node 项目清单' },
  { file: 'pnpm-workspace.yaml', what: 'monorepo 工作区' },
  { file: 'pyproject.toml', what: 'Python 项目清单' },
  { file: 'Cargo.toml', what: 'Rust 项目清单' },
  { file: 'go.mod', what: 'Go 模块' },
  { file: 'pom.xml', what: 'Maven 项目' },
  { file: 'build.gradle', what: 'Gradle 项目' },
  { file: 'composer.json', what: 'PHP 项目清单' },
  { file: 'Gemfile', what: 'Ruby 项目清单' },
];

/** 扫描时跳过的目录：依赖与构建产物，设计稿不会住在里面 */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  'target',
  '.venv',
  'venv',
  '__pycache__',
  '.cache',
  'coverage',
]);

/** 设计目录常见名：命中就是「人特意为设计留的位置」 */
const DESIGN_DIR_NAME =
  /^(design|designs|ui|ux|ui-?kit|mockups?|mocks?|screens?|sketches?|wireframes?|artboards?|layouts?|prototypes?|protos?|visuals?|pen|paintress)$/i;

/** 声明式设计根：仓库里的一份小配置，人写的，比任何猜测都硬 */
export const CONFIG_FILE = 'paintress.json';

export interface RootMarker {
  file: string;
  what: string;
}

/** 目录里命中的项目根标志（只读探测；读不到就当没有） */
export function projectRootMarkers(dir: string): RootMarker[] {
  const out: RootMarker[] = [];
  for (const marker of PROJECT_ROOT_MARKERS) {
    try {
      if (existsSync(join(dir, marker.file))) out.push({ file: marker.file, what: marker.what });
    } catch {
      /* 权限/竞态：当作没有 */
    }
  }
  return out;
}

/** 数设计稿：`depth` 是往下多走几层（0 = 只看本层） */
function countDesigns(dir: string, depth: number): number {
  let count = 0;
  const walk = (current: string, level: number): void => {
    let names: string[];
    try {
      names = readdirSync(current);
    } catch {
      return;
    }
    for (const name of names) {
      if (name.startsWith('.')) continue;
      const abs = join(current, name);
      let st: Stats;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (level < depth && !SKIP_DIRS.has(name)) walk(abs, level + 1);
        continue;
      }
      // `__preset.ptr` / `__components.ptr` 是项目文件，不算设计稿
      if (!name.startsWith('__') && DESIGN_EXT.has(extname(name).toLowerCase())) count++;
    }
  };
  walk(dir, 0);
  return count;
}

function hasScaffold(dir: string): boolean {
  try {
    return existsSync(join(dir, PRESET_FILE)) || existsSync(join(dir, COMPONENTS_FILE));
  } catch {
    return false;
  }
}

/** 声明查找的结果：配置有问题也算一个结论，不能静默退回猜测 */
type DeclaredRoot = { root: string } | { error: string } | null;

/** 仓库边界：软提示（AGENTS.md / CLAUDE.md）可以出现在子目录，不能截断向上查找 */
function isRepositoryBoundary(dir: string): boolean {
  return projectRootMarkers(dir).some((m) => m.file !== 'AGENTS.md' && m.file !== 'CLAUDE.md');
}

/** cwd 及以上的 `paintress.json` 里声明的设计根（就近优先；不越过仓库根） */
function declaredRoot(from: string, maxUp = 8): DeclaredRoot {
  let dir = resolve(from);
  for (let hop = 0; hop < maxUp; hop++) {
    const cfg = join(dir, CONFIG_FILE);
    if (existsSync(cfg)) {
      let raw: { root?: unknown };
      try {
        raw = JSON.parse(readFileSync(cfg, 'utf8')) as { root?: unknown };
      } catch (cause) {
        return {
          error: `${CONFIG_FILE} 不是合法 JSON：${cfg}（${cause instanceof Error ? cause.message : String(cause)}）。修正后再注册，或显式传 dir。`,
        };
      }
      if (raw.root !== undefined) {
        if (typeof raw.root !== 'string' || raw.root.trim() === '') {
          return { error: `${CONFIG_FILE} 的 root 必须是非空目录字符串：${cfg}。修正后再注册，或显式传 dir。` };
        }
        const target = resolve(dir, raw.root.trim());
        try {
          if (!statSync(target).isDirectory()) {
            return { error: `${CONFIG_FILE} 声明的 root 不是目录：${target}（配置：${cfg}）。修正后再注册，或显式传 dir。` };
          }
        } catch {
          return { error: `${CONFIG_FILE} 声明的 root 不存在或不可读：${target}（配置：${cfg}）。修正后再注册，或显式传 dir。` };
        }
        return { root: target };
      }
    }
    // 配置属于当前仓库；越过仓库根去读上级目录的 paintress.json 会把别的项目的约定套进来
    if (isRepositoryBoundary(dir)) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export interface RootCandidate {
  /** 绝对路径 */
  dir: string;
  /** 展示名：相对 `from` 的路径，cwd 自己用 `.` */
  name: string;
  score: number;
  /** 目录里的设计稿数量（cwd 只看本层，子目录看两层） */
  designFiles: number;
  hasScaffold: boolean;
  /** 若像项目根，这里是依据 */
  markers: RootMarker[];
  /** 人读的加分/否决理由 */
  notes: string[];
}

export type RootReason = 'explicit' | 'declared' | 'child' | 'cwd' | 'none';

export interface DesignRootDecision {
  /** 建议注册的目录（没有把握时是 cwd，但 confident=false） */
  root: string;
  reason: RootReason;
  /** false = 不要自作主张注册，交给调用方指定 */
  confident: boolean;
  /** 参与打分的候选（按分数从高到低） */
  candidates: RootCandidate[];
  /** 一句话解释，可直接给 CLI / stderr / 工具返回值 */
  message: string;
}

/** 单个目录的打分：本层看设计稿数，子目录看两层 */
function evaluate(dir: string, name: string, depth: number): RootCandidate {
  const designFiles = countDesigns(dir, depth);
  const scaffold = hasScaffold(dir);
  const markers = projectRootMarkers(dir);
  const notes: string[] = [];
  let score = 0;

  if (designFiles > 0) {
    const add = Math.min(designFiles, 4);
    score += add;
    notes.push(`${designFiles} 个设计稿`);
  }
  if (scaffold) {
    // 只有空脚手架、却没有设计稿的目录，多半是上次误注册留下的占位文件——别把它当强证据
    const add = designFiles > 0 ? 5 : 1;
    score += add;
    notes.push(designFiles > 0 ? `已有 ${PRESET_FILE} / ${COMPONENTS_FILE}` : `只有空的 ${PRESET_FILE} / ${COMPONENTS_FILE}`);
  }
  if (DESIGN_DIR_NAME.test(name)) {
    score += 3;
    notes.push('目录名像设计目录');
  }
  if (markers.length > 0) {
    if (designFiles === 0) {
      // 代码仓库根 \+ 没有设计稿 = 一票否决：这里注册就会在仓库根建项目文件
      score = 0;
      notes.push(`像项目根（${markers.map((m) => m.file).join('、')}），不是设计目录`);
    } else {
      notes.push(`也像项目根（${markers.map((m) => m.file).join('、')}），但本层就有设计稿`);
    }
  }
  return { dir, name, score, designFiles, hasScaffold: scaffold, markers, notes };
}

/** 直接子目录（跳过隐藏目录与依赖/构建产物，最多 100 个） */
function childDirs(from: string): { dir: string; name: string }[] {
  let names: string[];
  try {
    names = readdirSync(from).sort();
  } catch {
    return [];
  }
  const out: { dir: string; name: string }[] = [];
  for (const name of names) {
    if (out.length >= 100) break;
    if (name.startsWith('.') || SKIP_DIRS.has(name)) continue;
    const abs = join(from, name);
    try {
      if (!statSync(abs).isDirectory()) continue;
    } catch {
      continue;
    }
    out.push({ dir: abs, name });
  }
  return out;
}

function describe(root: string, reason: RootReason, from: string): string {
  const where = root === from ? '当前目录' : `${root}（cwd 下的 ${basename(root)}/）`;
  switch (reason) {
    case 'explicit':
      return `用显式指定的目录注册：${root}`;
    case 'declared':
      return `${CONFIG_FILE} 声明了设计根：${where}`;
    case 'child':
      return `当前目录像项目根，设计稿在 ${basename(root)}/（${root}）`;
    case 'cwd':
      return `用${where}注册`;
    case 'none':
      return '没找到像设计目录的地方，需要显式指定';
  }
}

/**
 * 解析设计根。**只读**，不创建任何东西。
 *
 * `explicit` 给了就完全照办（调用方明确知道自己在干什么，包括 `--force` 的场景）。
 */
export function resolveDesignRoot(from: string, explicit?: string): DesignRootDecision {
  const base = resolve(from);
  if (explicit !== undefined && explicit !== '') {
    const root = resolve(explicit);
    return { root, reason: 'explicit', confident: true, candidates: [], message: describe(root, 'explicit', base) };
  }

  const declared = declaredRoot(base);
  if (declared !== null && 'error' in declared) {
    return { root: base, reason: 'none', confident: false, candidates: [], message: declared.error };
  }
  if (declared !== null) {
    return { root: declared.root, reason: 'declared', confident: true, candidates: [], message: describe(declared.root, 'declared', base) };
  }

  const candidates: RootCandidate[] = [evaluate(base, '.', 0)];
  for (const child of childDirs(base)) candidates.push(evaluate(child.dir, child.name, 2));
  candidates.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

  const best = candidates[0] as RootCandidate;
  const tied = candidates.filter((c) => c.score === best.score && c.score > 0);
  if (best.score < 1 || tied.length > 1) {
    return {
      root: base,
      reason: 'none',
      confident: false,
      candidates,
      message:
        tied.length > 1
          ? `有 ${tied.length} 个同样像设计目录的候选（${tied.map((c) => c.name).join('、')}），需要显式指定`
          : '没找到像设计目录的地方（没有设计稿、也没有 design/ui 这类目录），需要显式指定',
    };
  }

  const reason: RootReason = best.dir === base ? 'cwd' : 'child';
  // 命中目录名或已有设计稿就算有把握；只有空脚手架撑起来的结论不算
  const nameForMatch = best.name === '.' ? basename(base) : best.name;
  return {
    root: best.dir,
    reason,
    confident: best.designFiles > 0 || DESIGN_DIR_NAME.test(nameForMatch),
    candidates,
    message: describe(best.dir, reason, base),
  };
}

export interface RootGuard {
  ok: boolean;
  markers: RootMarker[];
  /** 被拦下时的说明（含怎么改） */
  error?: string;
  hint?: string;
}

/**
 * 硬性门槛：**这个目录是不是「项目根」，却又要被当成设计根注册？**
 *
 * 判定只有两条：命中项目根标志（AGENTS.md / package.json / .git …），且本层一个设计稿都没有。
 * 本层就有设计稿的目录放行——那可能就是专门放设计的仓库。
 */
export function guardProjectRoot(dir: string): RootGuard {
  const abs = resolve(dir);
  const markers = projectRootMarkers(abs);
  if (markers.length === 0) return { ok: true, markers };
  const designs = countDesigns(abs, 0);
  if (designs > 0) return { ok: true, markers };

  const names = markers.map((m) => `${m.file}（${m.what}）`).join('、');
  return {
    ok: false,
    markers,
    error: `当前 watch 目录像项目根：${abs} 有 ${names}，本层没有设计稿。`,
    hint:
      '不建议把设计稿建在项目根：换到仓库里的设计目录（如 design/），或让 paintress 自己挑（paintress_viewer 不传 dir，' +
      `或在本目录写 ${CONFIG_FILE}：{"root": "design"}）。确实要注册这里，加 --force（工具调用传 force: true）。`,
  };
}
