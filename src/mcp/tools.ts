import { z } from 'zod';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { loadDoc, saveDoc, type DocFlavor } from '../doc/io.js';
import { createDoc } from '../doc/create.js';
import { collectIds, genId } from '../doc/id.js';
import { validateDoc } from '../doc/validate.js';
import { auditDoc, auditInputFrom } from '../doc/audit.js';
import { applyAdjust, applyEstablish, nodesAffectedByPreset, planAdjust, planEstablish, readPresetDoc, type PresetBlast } from '../doc/album.js';
import {
  applyProjectPresets,
  COMPONENTS_FILE,
  componentsPathFor,
  ensureProjectScaffold,
  findProjectRoot,
  findProjectRootStrict,
  projectFilesInfo,
  projectFontRegistry,
  setProjectRoots,
  projectPresetNames,
  findNodeIn,
  isPresetType,
  listComponents,
  listPresets,
  listPresetGroups,
  readPresetFile,
  setPresetGroup,
  removePresetGroup,
  presetPathFor,
  readComponentsFile,
  removeFontEntry,
  removePreset,
  seedDesignSystem,
  setDefaultFont,
  setFontEntry,
  setPreset,
} from '../doc/project.js';
import { isGenericFamily, planFonts, splitFontStack, textFontGaps } from '../doc/fonts.js';
import { PROP_TOKEN_KIND } from '../doc/presets.js';
import { query as q, get as g, update as u, insert as i, remove as rm, move as mv, batch as bt, type BatchOp } from '../ops/index.js';
import { expandRefs, renderDocument } from '../render/index.js';
import { screenshotPen, findBrowser } from '../shot/screenshot.js';
import { isDaemonRunning, sendRequest } from '../web/client.js';
import { ensureViewer, DesignRootUnresolvedError } from '../web/autoregister.js';
import type { PenDocument } from '../schema/index.js';

/**
 * 工具层：MCP 与 CLI 共享同一套 handler（无状态）。
 * 读工具：load → 返回。写工具：load → 操作 → 校验（错误不落盘）→ 原子保存（mtime 防覆盖）。
 * 命名 paintress_*（偏离 technical-plan 的 ptr_* 简写，与产品名一致）。
 */

/** 工具输出：JSON 对象或数组（MCP 序列化为文本，CLI 直接打印） */
export type ToolOutput = Record<string, unknown> | unknown[];

export interface ToolDef {
  description: string;
  inputSchema: z.ZodRawShape;
  run(args: Record<string, unknown>): ToolOutput | Promise<ToolOutput>;
}

function reqStr(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== 'string' || v === '') throw new Error(`缺少必填参数：${key}`);
  return v;
}

function optStr(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === 'string' && v !== '' ? v : undefined;
}

function optNum(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function optBool(args: Record<string, unknown>, key: string): boolean | undefined {
  const v = args[key];
  return typeof v === 'boolean' ? v : undefined;
}

function objArg(args: Record<string, unknown>, key: string): Record<string, unknown> {
  const v = args[key];
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`参数 ${key} 必须是对象`);
  return v as Record<string, unknown>;
}

/** 读：load 后执行，直接返回负载 */
function read<T>(path: string, fn: (ctx: ReturnType<typeof loadDoc>) => T): T {
  const loaded = loadDoc(path);
  return fn(loaded);
}

/**
 * 把「本次写操作动到的节点 id」告知 daemon，供前端做变更高亮。
 * 先转绝对路径：daemon 的 cwd 未必与调用方一致，不能让 daemon 替我们 resolve 相对路径。
 * 非阻塞发送（写路径性能语义不变）；socket 默认有 ref，进程不会在响应前提前退出。
 */
function notifyChanges(path: string, ids: string[]): void {
  if (ids.length === 0 || !isDaemonRunning()) return;
  void sendRequest({ kind: 'changes', path: resolve(path), ids }, 2000).catch(() => {
    /* 高亮是尽力而为，失败不影响写入结果 */
  });
}

/** 设计稿文件：传文件就是它自己，传目录就是根目录下那些设计稿（`__` 开头的是项目文件，不算） */
function designFilesOf(from: string): string[] {
  const abs = resolve(from);
  try {
    if (!statSync(abs).isDirectory()) return [abs];
  } catch {
    return [];
  }
  return readdirSync(abs)
    .filter((name) => /\.(ptr|pen)$/i.test(name) && !name.startsWith('__'))
    .map((name) => join(abs, name));
}

/**
 * 预设文件写完后：把「这次会连带改变哪些节点」记成变更，查看器刷新后据此画金边。
 * 页面刷新本身不用管：daemon 的浏览器 SSE 同时监听 `__preset.ptr`。
 * 传进来的是目录时，项目里每个设计稿各算一遍（人可能开着其中任意一张）。
 */
function notifyPresetBlast(from: string, blast: PresetBlast): void {
  if (!isDaemonRunning()) return;
  for (const file of designFilesOf(from)) {
    try {
      const loaded = loadDoc(file);
      notifyChanges(file, nodesAffectedByPreset(loaded.doc, readPresetDoc(file), blast));
    } catch {
      /* 单张读不了不影响其余；高亮也不值得让写操作报错 */
    }
  }
}

/** 最近一次字体探针报告（viewer + 截图都写进 daemon）；daemon 没跑就返回空 */
async function fetchFontReports(path: string): Promise<{ path: string; checked: string[]; missing: string[] }[]> {
  if (!isDaemonRunning()) return [];
  // 项目名与自动注册一致：目录的最后两段（web/paths.ts#deriveProjectName）
  const root = findProjectRoot(path) ?? resolve(path);
  const parts = root.split('/');
  const name = parts.slice(-2).join('/');
  try {
    const res = (await sendRequest({ kind: 'fonts', project: name }, 2000)) as {
      ok: boolean;
      reports?: { path: string; checked: string[]; missing: string[] }[];
    };
    if (!res.ok) return [];
    return (res.reports ?? []).map((r) => ({ path: r.path, checked: r.checked, missing: r.missing }));
  } catch {
    return [];
  }
}

/** 当前设计系统概览：token 计数、preset 组、字体、组件、字体缺口 */
function designSystemFor(path: string, doc: PenDocument): Record<string, unknown> {
  const presets = listPresets(path);
  const groups = listPresetGroups(path).groups;
  const fonts = projectFontRegistry(path).registry;
  const compPath = componentsPathFor(path);
  const components = compPath === null ? [] : listComponents(compPath);
  const gaps = textFontGaps(doc, fonts);
  const tokens: Record<string, number> = { color: 0, radius: 0, spacing: 0, fontSize: 0, font: 0 };
  for (const item of presets.items) tokens[item.type] = (tokens[item.type] ?? 0) + 1;
  const empty = presets.items.length === 0 && components.length === 0;
  return {
    presetPath: presets.path,
    tokens,
    groups: Object.entries(groups).map(([name, group]) => ({ name, target: group.target, props: group.props })),
    fonts: { default: fonts.default ?? null, families: Object.keys(fonts.families) },
    components: components.length,
    gaps: { textNodes: gaps.textNodes, ids: gaps.ids, unregistered: gaps.unregistered },
    ...(empty
      ? { next: '项目还没有设计系统：用 paintress_preset seed 建立尺度，再 paintress_font list 看字体' }
      : {}),
  };
}

/** 写完给 agent 的提示：等值 token、没写字体、未登记字体（最多 3 条，不阻断） */
function collectHints(path: string, doc: PenDocument, ids: string[]): string[] {
  const items = listPresets(path).items;
  const colorByValue = new Map<string, string>();
  const numberByKind = new Map<string, string>();
  const familyByValue = new Map<string, string>();
  for (const item of items) {
    if (item.type === 'color') colorByValue.set(item.value.toUpperCase(), item.key);
    else if (item.type === 'font') familyByValue.set(item.value, item.key);
    else numberByKind.set(`${item.type}:${item.value}`, item.key);
  }
  const registry = projectFontRegistry(path).registry;
  const hints: string[] = [];
  for (const id of [...new Set(ids)]) {
    const node = findNodeIn(doc.children, id);
    if (node === null) continue;
    if (node['type'] === 'text') {
      const ff = node['fontFamily'];
      if (typeof ff !== 'string' || ff.trim() === '') {
        hints.push(`${id}: text 没有 fontFamily，正在用默认字体；补一个 $font-* 或 family`);
      } else if (!ff.startsWith('$')) {
        for (const family of splitFontStack(ff)) {
          if (!isGenericFamily(family) && registry.families[family] === undefined) {
            hints.push(`${id}: 字体 ${family} 未登记（paintress_font add）`);
          }
        }
      }
    }
    for (const [prop, value] of Object.entries(node)) {
      if (prop === 'children') continue;
      const kind = PROP_TOKEN_KIND[prop];
      if (kind === undefined) continue;
      if (typeof value === 'string' && value.startsWith('$')) continue;
      if (kind === 'color' && typeof value === 'string') {
        const hit = colorByValue.get(value.toUpperCase());
        if (hit !== undefined) hints.push(`${id}.${prop} 写了裸色值 ${value}，可写 $${hit}`);
      } else if ((kind === 'radius' || kind === 'spacing' || kind === 'fontSize') && typeof value === 'number') {
        const hit = numberByKind.get(`${kind}:${String(value)}`);
        if (hit !== undefined) hints.push(`${id}.${prop} 写了裸值 ${value}，可写 $${hit}`);
      } else if (kind === 'font' && typeof value === 'string') {
        const hit = familyByValue.get(value);
        if (hit !== undefined) hints.push(`${id}.${prop} 写了字体族 ${value}，可写 $${hit}`);
      }
    }
  }
  return [...new Set(hints)].slice(0, 3);
}

/**
 * 写：load → 变更 → 校验（结构错误不落盘）→ 原子保存（保持原风味）。
 * fn 可通过 mark() 登记受影响的节点 id，写成功后统一通知 daemon。
 */
async function write(
  path: string,
  fn: (doc: ReturnType<typeof loadDoc>['doc'], mark: (ids: string[]) => void) => unknown,
): Promise<{ ok: true; result: unknown; warnings: unknown[]; hints: string[] }> {
  const loaded = loadDoc(path);
  const touched: string[] = [];
  const mark = (ids: string[]): void => {
    touched.push(...ids);
  };
  const result = fn(loaded.doc, mark);
  // 校验看「合并项目预设后」的文档，保存写回未合并的原文档：
  // 否则一次 update 就会把预设值烤进设计稿，人再调预设就不生效了。
  const presetNames = projectPresetNames(path);
  const v = validateDoc(loaded.doc, {
    knownVars: presetNames,
    presetVars: presetNames,
    presetGroups: listPresetGroups(path).groups,
    presetKinds: Object.fromEntries(listPresets(path).items.map((item) => [item.key, item.type])),
    fontRegistry: projectFontRegistry(path).registry,
  });
  if (!v.ok) {
    throw new Error(`变更后结构校验失败，未落盘：\n${v.errors.map((e) => `  ${e.path}: ${e.message}`).join('\n')}`);
  }
  saveDoc(path, loaded.doc, { expectedMtimeMs: loaded.mtimeMs, flavor: loaded.flavor });
  notifyChanges(path, touched);
  return { ok: true, result, warnings: v.warnings, hints: collectHints(path, loaded.doc, touched) };
}

function countByType(children: unknown[]): Record<string, number> {
  const counts: Record<string, number> = {};
  const walk = (nodes: unknown[]): void => {
    for (const n of nodes) {
      if (!n || typeof n !== 'object') continue;
      const rec = n as Record<string, unknown>;
      const t = typeof rec['type'] === 'string' ? rec['type'] : '?';
      counts[t] = (counts[t] ?? 0) + 1;
      const kids = rec['children'];
      if (Array.isArray(kids)) walk(kids);
    }
  };
  walk(children);
  return counts;
}

/**
 * 新建设计稿。path 不带扩展名时补默认扩展名；调用方显式写 `.pen` 时按兼容格式产出
 * （不替用户转换已有文件）。
 */
function newDoc(args: Record<string, unknown>): ToolOutput {
  const raw = reqStr(args, 'path');
  const path = /\.(pen|ptr)$/i.test(raw) ? raw : `${raw}.ptr`;
  const flavor: DocFlavor = path.toLowerCase().endsWith('.pen') ? 'pen' : 'ptr';
  if (existsSync(path) && optBool(args, 'overwrite') !== true) {
    throw new Error(`文件已存在，未覆盖：${path}（确需覆盖传 overwrite=true）`);
  }

  const width = optNum(args, 'width');
  const height = optNum(args, 'height');
  if (width !== undefined && width <= 0) throw new Error(`width 必须大于 0，收到：${width}`);
  if (height !== undefined && height <= 0) throw new Error(`height 必须大于 0，收到：${height}`);

  const layoutArg = optStr(args, 'layout');
  if (layoutArg !== undefined && !['vertical', 'horizontal', 'none'].includes(layoutArg)) {
    throw new Error(`layout 仅支持 vertical / horizontal / none，收到：${layoutArg}`);
  }
  const { doc, boardId } = createDoc({
    name: optStr(args, 'name'),
    width,
    height,
    fill: optStr(args, 'fill'),
    layout: layoutArg === 'vertical' || layoutArg === 'horizontal' || layoutArg === 'none' ? layoutArg : undefined,
    padding: optNum(args, 'padding'),
    gap: optNum(args, 'gap'),
  });

  const check = validateDoc(doc);
  if (!check.ok) {
    throw new Error(`新建文档结构校验失败，未落盘：\n${check.errors.map((e) => `  ${e.path}: ${e.message}`).join('\n')}`);
  }

  // 连带建父目录：允许直接写到还不存在的设计稿目录
  mkdirSync(dirname(path), { recursive: true });
  saveDoc(path, doc, { flavor, createOnly: optBool(args, 'overwrite') !== true });
  const board = doc.children[0] as Record<string, unknown> | undefined;
  return {
    ok: true,
    path,
    flavor,
    version: doc.version,
    boardId,
    canvas: { width: Number(board?.['width'] ?? 0), height: Number(board?.['height'] ?? 0) },
    designSystem: designSystemFor(path, doc),
    warnings: check.warnings,
  };
}


/** 摘掉整棵子树的 `reusable`：复制件是实例，不是组件定义 */
function stripReusableDeep(node: unknown): void {
  if (!node || typeof node !== 'object') return;
  const rec = node as Record<string, unknown>;
  delete rec['reusable'];
  const kids = rec['children'];
  if (Array.isArray(kids)) for (const k of kids) stripReusableDeep(k);
}

/** 按 name 找节点（组件同名提示用）；返回前 5 个 */
function findNodesByName(nodes: unknown[], name: string): { id: string; name: string }[] {
  const out: { id: string; name: string }[] = [];
  const walk = (list: unknown[]): void => {
    for (const raw of list) {
      if (!raw || typeof raw !== 'object') continue;
      const rec = raw as Record<string, unknown>;
      if (rec['name'] === name && typeof rec['id'] === 'string') out.push({ id: rec['id'], name });
      const kids = rec['children'];
      if (Array.isArray(kids)) walk(kids);
    }
  };
  walk(nodes);
  return out.slice(0, 5);
}

/** 复制进设计稿前给整棵子树换新 id：组件库与目标文件的 id 空间互不相干 */
function remapIds(node: unknown, taken: Set<string>): void {
  if (!node || typeof node !== 'object') return;
  const rec = node as Record<string, unknown>;
  if (typeof rec['id'] === 'string') {
    const fresh = genId(taken);
    taken.add(fresh);
    rec['id'] = fresh;
  }
  const kids = rec['children'];
  if (Array.isArray(kids)) for (const k of kids) remapIds(k, taken);
}

export const TOOLS: Record<string, ToolDef> = {
  paintress_viewer: {
    description:
      'Ensure the local viewer is running and register the project that holds the design. Idempotent: reuse the running process (returns its pid/port, never starts a second one). Call it before drawing, editing or showing a design, without waiting to be asked. Without `dir` it registers the design root (declared in paintress.json, else a design/ ui/ mockups/ style directory, else the cwd when designs live there) — never a code repository root on a guess. When no design root exists yet it returns ok:false with candidates and a `next` instruction: ask the user where designs should live and create it only with their agreement.',
    inputSchema: {
      dir: z.string().optional().describe('Directory to register. Omit it to let paintress pick the design root; pass it only for a non-standard layout'),
      project: z.string().optional().describe('Project name (the URL segment); defaults to parent/dir'),
      depth: z.number().int().min(1).max(6).optional().describe('Max depth when listing designs; default 3'),
      force: z
        .boolean()
        .optional()
        .describe('Register even when the directory looks like a project root (AGENTS.md / package.json / .git) and holds no designs'),
    },
    run: async (a) => {
      const dir = optStr(a, 'dir');
      const project = optStr(a, 'project');
      const depth = optNum(a, 'depth');
      let info;
      try {
        info = await ensureViewer({
          ...(dir !== undefined ? { dir } : {}),
          ...(project !== undefined ? { project } : {}),
          ...(depth !== undefined ? { depth } : {}),
          ...(a['force'] === true ? { force: true } : {}),
        });
      } catch (cause) {
        // 设计根没把握：不猜、不注册，把候选目录交回去让调用方决定
        if (cause instanceof DesignRootUnresolvedError) {
          return {
            ok: false,
            error: cause.message,
            // 给 agent 的下一步：没有设计目录时先问用户，不要自己建、也不要直接 force
            next:
              'Ask the user where design files should live (offer a new `design/` directory inside the project) and create it only after they agree; ' +
              'then call this tool again with that directory as `dir`. Do not create a directory on your own, and do not fall back to `force`.',
            designRoot: {
              root: cause.decision.root,
              reason: cause.decision.reason,
              confident: false,
              candidates: cause.decision.candidates
                .filter((c) => c.score > 0)
                .map((c) => ({ name: c.name, dir: c.dir, score: c.score, notes: c.notes })),
            },
          };
        }
        throw cause;
      }
      // 项目根与两个关键文件：agent 不需要自己找、更不该自己另建
      const designSystem = projectFilesInfo(info.root, { ensure: true });
      // 端口/绑定若与默认不同，必须明说：agent 会把人引到这个 url 上
      let note: string | undefined;
      if (info.access.bind === 'all') {
        note = `宿主 localhost 转发不可用，查看器已绑 0.0.0.0；给人打开的地址用返回的 url（${info.url}），不要用 localhost。`;
      } else if (info.access.jumped) {
        note = `默认端口 ${info.access.requestedPort} 不可用，查看器起在 ${info.port}；给人打开的地址是 ${info.url}。`;
      }
      return {
        ok: true,
        project: info.project,
        root: info.root,
        url: info.url,
        pid: info.pid,
        port: info.port,
        access: info.access,
        // 注册的是哪个目录、凭什么选的：agent 下一步的路径都该相对它
        designRoot: {
          root: info.designRoot.root,
          reason: info.designRoot.reason,
          confident: info.designRoot.confident,
          message: info.designRoot.message,
        },
        ...(note !== undefined ? { note } : {}),
        started: info.startedDaemon,
        designSystem,
      };
    },
  },

  paintress_project: {
    description:
      'Resolve the project root for a path and report its design-system files (creating them if missing, flagging nested duplicates). paintress_viewer already returns the same block after registering, so call this only when you have a file path and no viewer.',
    inputSchema: {
      path: z.string().optional().describe('Design file or project directory; defaults to the current working directory'),
      ensure: z.boolean().optional().describe('Create the two files when missing (default true)'),
    },
    run: async (a) => {
      const from = resolve(optStr(a, 'path') ?? process.cwd());
      let project: string | null = null;
      let root: string | null = null;
      if (isDaemonRunning()) {
        try {
          const res = await sendRequest({ kind: 'status' }, 2000);
          if (res.ok && 'projects' in res && Array.isArray(res.projects)) {
            // 注册根是唯一权威：顺手把 doc 层的解析表刷新
            setProjectRoots(res.projects.map((p) => p.root));
            const abs = resolve(from);
            const hits = res.projects
              .filter((p) => abs === p.root || abs.startsWith(`${p.root}${sep}`))
              .sort((x, y) => y.root.length - x.root.length);
            const hit = hits[0];
            if (hit !== undefined) {
              root = hit.root;
              project = hit.name;
            }
          }
        } catch {
          /* daemon 半死不活：退回本地解析 */
        }
      }
      if (root === null) root = findProjectRoot(from) ?? findProjectRootStrict(from);
      const info = projectFilesInfo(root, { ensure: optBool(a, 'ensure') !== false });
      return { ok: true, project, ...info };
    },
  },

  paintress_new: {
    description:
      'Create a design file: a minimal document with one empty board, ready to render/screenshot and fill with insert. Refuses to overwrite unless overwrite=true. A path without an extension gets the default one.',
    inputSchema: {
      path: z.string().describe('New document path; a missing extension gets the default one'),
      name: z.string().optional().describe('Board name (default Board)'),
      width: z.number().positive().optional().describe('Board width (default 900)'),
      height: z.number().positive().optional().describe('Board height (default 600)'),
      fill: z.string().optional().describe('Board background (default #FFFFFF)'),
      layout: z.enum(['vertical', 'horizontal', 'none']).optional().describe('Child layout (default vertical)'),
      padding: z.number().optional().describe('Board padding (default 0)'),
      gap: z.number().optional().describe('Main-axis gap (default 0)'),
      overwrite: z.boolean().optional().describe('Overwrite when the file exists (default false)'),
    },
    run: (a) => newDoc(a),
  },

  paintress_doc_info: {
    description: 'Document summary: version, flavor, node counts, variables, top-level nodes, and a design-system overview including font gaps.',
    inputSchema: { path: z.string().describe('Design file path') },
    run: (a) => {
      const path = reqStr(a, 'path');
      return read(path, (ctx) => ({
        flavor: ctx.flavor,
        version: ctx.doc.version,
        fileToken: ctx.doc.fileToken,
        variables: ctx.doc.variables ? Object.keys(ctx.doc.variables) : [],
        projectPresets: (() => {
          const { path: presetPath, items } = listPresets(path);
          return { path: presetPath, count: items.length };
        })(),
        topLevel: ctx.doc.children.map((c) => ({ id: (c as Record<string, unknown>)['id'], name: (c as Record<string, unknown>)['name'], type: (c as Record<string, unknown>)['type'] })),
        nodeCount: Object.values(countByType(ctx.doc.children)).reduce((s, n) => s + n, 0),
        byType: countByType(ctx.doc.children),
        designSystem: designSystemFor(path, ctx.doc),
        warnings: ctx.validation.warnings,
      }));
    },
  },

  paintress_query: {
    description: 'Find nodes by type / name (exact or regex) / id / reusable.',
    inputSchema: {
      path: z.string(),
      type: z.string().optional(),
      name: z.string().optional(),
      nameRegex: z.boolean().optional().describe('Interpret name as a regex'),
      id: z.string().optional(),
      reusable: z.boolean().optional(),
    },
    run: (a) =>
      read(reqStr(a, 'path'), (ctx) =>
        q(ctx.doc, {
          type: optStr(a, 'type'),
          name: optStr(a, 'name'),
          nameRegex: optBool(a, 'nameRegex'),
          id: optStr(a, 'id'),
          reusable: optBool(a, 'reusable'),
        }),
      ),
  },

  paintress_get: {
    description: 'Read one node subtree; depth controls how far down (0 = this node only, children elided as ...).',
    inputSchema: { path: z.string(), id: z.string(), depth: z.number().int().min(0).optional() },
    run: (a) =>
      read(reqStr(a, 'path'), (ctx) => {
        const filePath = reqStr(a, 'path');
        const res = g(ctx.doc, reqStr(a, 'id'), optNum(a, 'depth') ?? Infinity);
        if (!res) throw new Error(`节点不存在：${reqStr(a, 'id')}`);
        // 文本节点没写字体：给一条 hint，让 agent 决定要不要补（不阻断）
        if (res !== null && typeof res === 'object' && !Array.isArray(res)) {
          const rec = res as Record<string, unknown>;
          if (rec['type'] === 'text' && (typeof rec['fontFamily'] !== 'string' || rec['fontFamily'].trim() === '')) {
            const fonts = listPresets(filePath).items.filter((item) => item.type === 'font').map((item) => item.key);
            const suggest = fonts.length > 0 ? fonts.map((key) => `$${key}`).join(' / ') : '先 paintress_preset set 一个 font token';
            return { ...rec, hint: `这个 text 节点没有 fontFamily，正在用默认字体；补一个 ${suggest} 或 family` };
          }
        }
        return res;
      }),
  },

  paintress_update: {
    description: 'Shallow-merge attributes on one node (id and type are immutable).',
    inputSchema: { path: z.string(), id: z.string(), patch: z.record(z.unknown()) },
    run: (a) =>
      write(reqStr(a, 'path'), (doc, mark) => {
        const id = reqStr(a, 'id');
        const res = u(doc, id, objArg(a, 'patch'));
        mark([id]);
        return res;
      }),
  },

  paintress_insert: {
    description: 'Insert a child node (an id is generated when missing; returns the new id).',
    inputSchema: {
      path: z.string(),
      parent: z.string().describe("父节点 id，或 'root'"),
      node: z.record(z.unknown()),
      index: z.number().int().min(0).optional(),
    },
    run: (a) =>
      write(reqStr(a, 'path'), (doc, mark) => {
        const newId = i(doc, reqStr(a, 'parent'), objArg(a, 'node'), optNum(a, 'index'));
        mark([newId]);
        return newId;
      }),
  },

  paintress_delete: {
    description: 'Delete a node and its subtree.',
    inputSchema: { path: z.string(), id: z.string() },
    run: (a) =>
      write(reqStr(a, 'path'), (doc, mark) => {
        const id = reqStr(a, 'id');
        const node = rm(doc, id) as Record<string, unknown>;
        mark([id]);
        return { deleted: { id: node['id'], name: node['name'], type: node['type'] } };
      }),
  },

  paintress_move: {
    description: 'Reparent or reorder a node (cycle-checked).',
    inputSchema: { path: z.string(), id: z.string(), parent: z.string(), index: z.number().int().min(0).optional() },
    run: (a) =>
      write(reqStr(a, 'path'), (doc, mark) => {
        const id = reqStr(a, 'id');
        mv(doc, id, reqStr(a, 'parent'), optNum(a, 'index'));
        mark([id]);
        return { moved: id, to: reqStr(a, 'parent') };
      }),
  },

  paintress_batch: {
    description: 'Atomic batch: an array of update/insert/delete/move ops; one failure discards the whole batch.',
    inputSchema: { path: z.string(), ops: z.array(z.record(z.unknown())) },
    run: (a) =>
      write(reqStr(a, 'path'), (doc, mark) => {
        const raw = a['ops'];
        if (!Array.isArray(raw)) throw new Error('ops 必须是数组');
        const ops = raw.map((op, idx) => {
          const rec = op as Record<string, unknown>;
          const kind = rec['op'];
          if (kind === 'update') return { op: 'update', id: String(rec['id']), patch: (rec['patch'] ?? {}) as Record<string, unknown> } as BatchOp;
          if (kind === 'insert') return { op: 'insert', parent: String(rec['parent']), node: rec['node'], index: typeof rec['index'] === 'number' ? rec['index'] : undefined } as BatchOp;
          if (kind === 'delete') return { op: 'delete', id: String(rec['id']) } as BatchOp;
          if (kind === 'move') return { op: 'move', id: String(rec['id']), parent: String(rec['parent']), index: typeof rec['index'] === 'number' ? rec['index'] : undefined } as BatchOp;
          throw new Error(`ops[${idx}] 的 op 必须是 update|insert|delete|move`);
        });
        // batch 是克隆语义（返回新文档），但四类 op 只改 children 树；回填后走统一的写路径
        const before = new Set(collectIds(doc.children));
        const out = bt(doc, ops);
        doc.children = out.children;
        // 显式操作的 id + 本次真正新增的节点 id（insert 由 ops 层生成，只能事后对比）
        const insertedIds = collectIds(doc.children).filter((id) => !before.has(id));
        mark([...ops.flatMap((op) => (op.op === 'insert' ? [] : [op.id])), ...insertedIds]);
        return { applied: ops.length, inserted: insertedIds.length };
      }),
  },

  paintress_validate: {
    description: 'Validate a document: structural errors plus semantic warnings (duplicate ids, dangling refs, unknown types, undefined variables, wrong token kinds, font gaps). Project presets count as defined.',
    inputSchema: { path: z.string() },
    run: (a) => {
      const path = reqStr(a, 'path');
      const loaded = loadDoc(path);
      // 校验看的是「文档自己有什么变量」+「项目预设提供了哪些名字」：
      // 不能拿合并后的文档来校验，否则每个预设变量都会被误判成本地覆盖。
      const presetNames = projectPresetNames(path);
      return validateDoc(loaded.doc, {
        knownVars: presetNames,
        presetVars: presetNames,
        presetGroups: listPresetGroups(path).groups,
        presetKinds: Object.fromEntries(listPresets(path).items.map((item) => [item.key, item.type])),
        fontRegistry: projectFontRegistry(path).registry,
      });
    },
  },

  paintress_preset: {
    description:
      'Project tokens and preset groups in __preset.ptr: designs reference a token as $key. list shows everything; set/remove write one token; seed fills a whole scale (dry-run unless apply:true); set-group defines properties for one node type (values must be $token) that nodes opt into with preset:"<group>".',
    inputSchema: {
      action: z.enum(['list', 'set', 'remove', 'seed', 'set-group', 'remove-group']),
      apply: z.boolean().optional().describe('seed only: true writes; default false returns created/skipped only'),
      path: z.string().optional().describe('Design file or project directory; defaults to the current working directory'),
      key: z.string().optional().describe('Token key, referenced as $key; required for set/remove'),
      type: z.enum(['color', 'radius', 'spacing', 'fontSize', 'font']).optional().describe('Token type; required for set'),
      name: z.string().optional().describe('Human-readable name; defaults to the key'),
      value: z.string().optional().describe("值：颜色 #RRGGBB（或 #RGB / #RRGGBBAA），倒角/间距写非负数字，字体写字体族；set 必填"),
      group: z.string().optional().describe('Preset group name; required for set-group/remove-group'),
      target: z.string().optional().describe('Node type the group applies to (frame/text/rectangle...); required for set-group'),
      props: z.record(z.string()).optional().describe('Group properties mapped to $tokens, e.g. {"fill":"$color-brand"}; required for set-group'),
    },
    run: (a) => {
      const from = resolve(optStr(a, 'path') ?? process.cwd());
      const action = optStr(a, 'action') ?? 'list';
      if (action === 'seed') {
        return { ok: true, ...seedDesignSystem(from, { apply: a['apply'] === true }) };
      }
      if (action === 'list') {
        const { path, items } = listPresets(from);
        return { ok: true, path, items, groups: listPresetGroups(from).groups };
      }
      if (action === 'set-group') {
        const props = a['props'];
        if (props === null || typeof props !== 'object' || Array.isArray(props)) {
          throw new Error('props 必须是对象：属性 → $token 引用');
        }
        const clean: Record<string, string> = {};
        for (const [k, v] of Object.entries(props as Record<string, unknown>)) {
          if (typeof v !== 'string') throw new Error(`props.${k} 必须是 $token 字符串`);
          clean[k] = v;
        }
        const res = setPresetGroup(from, { name: reqStr(a, 'group'), target: reqStr(a, 'target'), props: clean });
        notifyPresetBlast(from, { group: reqStr(a, 'group') });
        return { ok: true, ...res };
      }
      if (action === 'remove-group') {
        const group = reqStr(a, 'group');
        const res = removePresetGroup(from, group);
        notifyPresetBlast(from, { group });
        return { ok: true, ...res };
      }
      const key = reqStr(a, 'key');
      if (action === 'remove') {
        const items = removePreset(from, key);
        notifyPresetBlast(from, { token: key });
        return { ok: true, path: presetPathFor(from), items, groups: listPresetGroups(from).groups };
      }
      const type = optStr(a, 'type');
      if (!isPresetType(type)) throw new Error('type 必须是 color / radius / spacing / fontSize / font');
      const name = optStr(a, 'name');
      const items = setPreset(from, {
        key,
        type,
        value: reqStr(a, 'value'),
        ...(name !== undefined ? { name } : {}),
      });
      notifyPresetBlast(from, { token: key });
      return { ok: true, path: presetPathFor(from), items, groups: listPresetGroups(from).groups };
    },
  },

  paintress_font: {
    description:
      'Project font registry in __preset.ptr: list, add a family, remove, or set the default used by text nodes without fontFamily. system/bundle need a preview fallback; css/file are project-relative paths that must exist; web is a CSS URL.',
    inputSchema: {
      action: z.enum(['list', 'add', 'remove', 'default']),
      path: z.string().optional().describe('Design file or project directory; defaults to the current working directory'),
      family: z.string().optional().describe('Real font family name; required for add/remove'),
      kind: z.enum(['web', 'css', 'file', 'system', 'bundle']).optional().describe('Source kind; required for add'),
      source: z.string().optional().describe('web: a CSS URL; css/file: a project-relative path'),
      preview: z.string().optional().describe('Design-time substitute font; required for system/bundle'),
      note: z.string().optional(),
      metrics: z
        .object({
          sizeAdjust: z.string().optional(),
          ascentOverride: z.string().optional(),
          descentOverride: z.string().optional(),
          lineGapOverride: z.string().optional(),
        })
        .optional()
        .describe('Metrics overrides for the substitute (CSS font metrics overrides)'),
      value: z.string().optional().describe('For default: a font token key or a family'),
    },
    run: async (a) => {
      const from = resolve(optStr(a, 'path') ?? process.cwd());
      const action = optStr(a, 'action') ?? 'list';
      if (action === 'list') {
        const { path, registry } = projectFontRegistry(from);
        const reports = await fetchFontReports(from);
        const missing = new Set(reports.flatMap((r) => r.missing));
        const families = Object.fromEntries(
          Object.entries(registry.families).map(([family, entry]) => [
            family,
            {
              ...entry,
              status: missing.has(family) ? 'missing' : 'loaded',
              missingIn: reports.filter((r) => r.missing.includes(family)).map((r) => r.path),
            },
          ]),
        );
        return { ok: true, path, ...registry, families, reports };
      }
      if (action === 'remove') {
        return { ok: true, ...removeFontEntry(from, reqStr(a, 'family')) };
      }
      if (action === 'default') {
        return { ok: true, ...setDefaultFont(from, reqStr(a, 'value')) };
      }
      const kind = reqStr(a, 'kind');
      const source = optStr(a, 'source');
      const preview = optStr(a, 'preview');
      const note = optStr(a, 'note');
      const metrics = a['metrics'];
      return {
        ok: true,
        ...setFontEntry(from, {
          family: reqStr(a, 'family'),
          source: { kind, ...(source !== undefined ? { target: source } : {}) },
          ...(preview !== undefined ? { preview } : {}),
          ...(note !== undefined ? { note } : {}),
          ...(metrics !== null && typeof metrics === 'object' ? { metrics: metrics as Record<string, string> } : {}),
        }),
      };
    },
  },

  paintress_audit: {
    description:
      'Read-only design-system audit: literals that could be $tokens, orphan tokens, unused or dangling preset groups. It only reports — you and the human decide what to change.',
    inputSchema: { path: z.string().describe('Design file path (project presets are read from its project)') },
    run: (a) => {
      const path = reqStr(a, 'path');
      const loaded = loadDoc(path);
      const { items } = listPresets(path);
      const presetPath = presetPathFor(path);
      const presetDoc = presetPath === null ? null : (readPresetFile(presetPath)?.doc ?? null);
      const input = auditInputFrom(
        loaded.doc,
        items.map((p) => ({ key: p.key, type: p.type, value: p.value })),
        presetDoc,
      );
      return { ok: true, path, ...auditDoc(loaded.doc, input) };
    },
  },

  paintress_establish: {
    description:
      'Propose $tokens from repeated literals (colors/radii/spacing) and preset groups from same-type nodes sharing a property set. Dry-run unless apply:true, which writes __preset.ptr and rewrites matched nodes to references.',
    inputSchema: {
      path: z.string().describe('Design file path'),
      apply: z.boolean().optional().describe('true writes the preset file and rewrites nodes; default false only suggests'),
      minUses: z.number().int().min(2).optional().describe('Minimum occurrences for a candidate; default 2'),
    },
    run: (a) => {
      const path = reqStr(a, 'path');
      const loaded = loadDoc(path);
      const minUses = typeof a['minUses'] === 'number' ? (a['minUses'] as number) : undefined;
      const plan = planEstablish(loaded.doc, { ...(minUses !== undefined ? { minUses } : {}) });
      if (a['apply'] !== true) return { ok: true, applied: false, ...plan };
      const applied = applyEstablish(path, plan, { expectedMtimeMs: loaded.mtimeMs });
      notifyChanges(path, applied.touched);
      return { ok: true, ...applied };
    },
  },

  paintress_adjust: {
    description:
      'Preview the blast radius of changing a token (key) or one group property (group+prop): dry-run returns affected nodes with before->after. apply:true writes __preset.ptr only — designs follow through their references.',
    inputSchema: {
      path: z.string().describe('Design file path (project presets are read from its project)'),
      key: z.string().optional().describe('Token key to change'),
      group: z.string().optional().describe('Preset group to change'),
      prop: z.string().optional().describe('Group property to change (with group)'),
      value: z.string().describe('New value: #RRGGBB for colors, a number for dimensions, a family for fonts'),
      apply: z.boolean().optional().describe('true writes the preset file; default false only previews'),
    },
    run: (a) => {
      const path = reqStr(a, 'path');
      const value = reqStr(a, 'value');
      const loaded = loadDoc(path);
      const presetDoc = readPresetDoc(path);
      const key = optStr(a, 'key');
      const group = optStr(a, 'group');
      const prop = optStr(a, 'prop');
      if (key !== undefined && (group !== undefined || prop !== undefined)) {
        throw new Error('key 与 group/prop 是两种调整方式，只能选一种');
      }
      if ((group === undefined) !== (prop === undefined)) {
        throw new Error('改 preset 组必须同时提供 group 与 prop');
      }
      const plan = planAdjust(loaded.doc, presetDoc, {
        ...(key !== undefined ? { key } : {}),
        ...(group !== undefined ? { group } : {}),
        ...(prop !== undefined ? { prop } : {}),
        value,
      });
      if (a['apply'] !== true) return { ok: true, applied: false, ...plan };
      const applied = applyAdjust(path, presetDoc, plan, { doc: loaded.doc });
      notifyChanges(path, applied.touched);
      return { ok: true, ...applied };
    },
  },

  paintress_component: {
    description:
      'Project component library in __components.ptr: look here before drawing anything reusable. list returns reusable components; insert copies one into a design (fresh ids, no live link); add registers a design subtree as a component.',
    inputSchema: {
      action: z.enum(['list', 'insert', 'add']),
      path: z.string().optional().describe('Design file or project directory; for insert this is the target design'),
      id: z.string().optional().describe('Component id; required for insert'),
      parent: z.string().optional().describe("插到哪个父节点，默认 'root'"),
      index: z.number().int().min(0).optional(),
    },
    run: (a) => {
      const action = optStr(a, 'action') ?? 'list';
      const from = resolve(optStr(a, 'path') ?? process.cwd());
      if (action === 'list') {
        const compPath = componentsPathFor(from);
        if (compPath === null) {
          return {
            ok: true,
            path: null,
            items: [],
            hint: '项目还没有组件库：先 paintress_viewer 注册项目（会自动创建 __components.ptr）',
          };
        }
        return { ok: true, path: compPath, items: listComponents(compPath) };
      }

      if (action === 'add') {
        const sourcePath = reqStr(a, 'path');
        const sourceId = reqStr(a, 'id');
        const loaded = loadDoc(sourcePath);
        const expanded = expandRefs(applyProjectPresets(loaded.doc, sourcePath).doc, []);
        const node = findNodeIn(expanded, sourceId);
        if (node === null) throw new Error(`节点不存在：${sourceId}（先 paintress_query 拿 id）`);
        const copy = structuredClone(node);
        const name =
          optStr(a, 'name') ?? (typeof copy['name'] === 'string' && copy['name'] !== '' ? copy['name'] : sourceId);
        copy['name'] = name;
        stripReusableDeep(copy);
        copy['reusable'] = true;
        const root = findProjectRootStrict(sourcePath);
        ensureProjectScaffold(root);
        const compPath = join(root, COMPONENTS_FILE);
        return write(compPath, (doc, mark) => {
          remapIds(copy, new Set(collectIds(doc.children)));
          const newId = i(doc, optStr(a, 'parent') ?? 'root', copy, optNum(a, 'index'));
          mark([newId]);
          return { id: newId, name, componentPath: compPath, source: sourceId };
        });
      }

      const target = reqStr(a, 'path');
      const compId = reqStr(a, 'id');
      const compPath = componentsPathFor(resolve(target));
      if (compPath === null) throw new Error('找不到项目组件库 __components.ptr（先在项目里注册）');
      const compLoaded = readComponentsFile(compPath);
      if (compLoaded === null) throw new Error(`组件库不可读：${compPath}`);

      const warnings: string[] = [];
      // 先展开内部 ref：复制件要自包含，不能带走一个指向组件库的悬空引用
      const expanded = expandRefs(applyProjectPresets(compLoaded.doc, compPath).doc, warnings);
      const node = findNodeIn(expanded, compId);
      if (node === null) throw new Error(`组件不存在：${compId}（先 paintress_component list 看有哪些）`);
      const copy = structuredClone(node);
      // 复制出来的是实例，不是组件定义：整棵子树都摘掉 reusable。
      // 否则组件库里的嵌套组件（ref 展开后仍带 reusable:true）会被复制成新定义，
      // 下次 list 就在设计稿里看到一堆"伪组件"。
      stripReusableDeep(copy);
      const componentName = typeof node['name'] === 'string' && node['name'] !== '' ? node['name'] : compId;
      const existing = findNodesByName(loadDoc(target).doc.children, componentName);

      return write(target, (doc, mark) => {
        remapIds(copy, new Set(collectIds(doc.children)));
        const newId = i(doc, optStr(a, 'parent') ?? 'root', copy, optNum(a, 'index'));
        mark([newId]);
        return {
          id: newId,
          from: compId,
          componentPath: compPath,
          warnings,
          ...(existing.length > 0 ? { existing } : {}),
        };
      });
    },
  },

  paintress_convert: {
    description:
      'Convert a .pen file to .ptr (fresh fileToken; source untouched; refuses to overwrite unless overwrite:true). The flavors are identical today, but .ptr may evolve.',
    inputSchema: {
      path: z.string().describe('Source .pen path'),
      out: z.string().optional().describe('Target .ptr path; defaults to the source with .ptr extension'),
      overwrite: z.boolean().optional().describe('Overwrite an existing target (default false)'),
    },
    run: (a) => {
      const source = reqStr(a, 'path');
      if (!source.toLowerCase().endsWith('.pen')) throw new Error(`source must be a .pen file, got: ${source}`);
      const target = optStr(a, 'out') ?? source.replace(/\.pen$/i, '.ptr');
      if (resolve(target) === resolve(source)) throw new Error('Target must differ from the source');
      if (existsSync(target) && optBool(a, 'overwrite') !== true) {
        throw new Error(`Target exists, not overwritten: ${target} (pass overwrite=true to replace it)`);
      }
      const loaded = loadDoc(source);
      if (!loaded.validation.ok) {
        throw new Error(
          `Source fails validation, nothing written:\n${loaded.validation.errors.map((e) => `  ${e.path}: ${e.message}`).join('\n')}`,
        );
      }
      const meta = (loaded.doc as Record<string, unknown>)['x-paintress'];
      const doc: PenDocument = {
        ...loaded.doc,
        fileToken: randomUUID(),
        ...(meta !== undefined ? {} : { ['x-paintress']: { spec: '1' } }),
      } as PenDocument;
      saveDoc(target, doc, { flavor: 'ptr', createOnly: optBool(a, 'overwrite') !== true });
      return {
        ok: true,
        source,
        out: target,
        fileToken: doc.fileToken,
        version: doc.version,
        nodeCount: doc.children.length,
        warnings: loaded.validation.warnings,
      };
    },
  },

  paintress_render: {
    description:
      'Render a design to a standalone HTML file (every node keeps data-node-id) — the artifact a human opens. Project fonts come from the registry; embedFonts inlines file fonts.',
    inputSchema: {
      path: z.string(),
      out: z.string().describe('Output .html path'),
      embedFonts: z.boolean().optional().describe('Inline file-source fonts as data URIs (default false)'),
    },
    run: (a) => {
      const out = reqStr(a, 'out');
      const path = reqStr(a, 'path');
      const loaded = loadDoc(path);
      const merged = applyProjectPresets(loaded.doc, path).doc;
      const { registry } = projectFontRegistry(path);
      const root = findProjectRoot(path) ?? dirname(resolve(path));
      const embed = a['embedFonts'] === true;
      const plan = planFonts(
        registry,
        (source) => {
          if (source.target === undefined) return null;
          const abs = resolve(root, source.target);
          if (embed && source.kind === 'file') {
            try {
              const data = readFileSync(abs);
              const ext = extname(abs).toLowerCase();
              const mime =
                ext === '.woff2' ? 'font/woff2' : ext === '.woff' ? 'font/woff' : ext === '.otf' ? 'font/otf' : 'font/ttf';
              return `data:${mime};base64,${data.toString('base64')}`;
            } catch {
              return null;
            }
          }
          return pathToFileURL(abs).href;
        },
        merged,
      );
      const r = renderDocument(merged, { fonts: plan });
      if (embed && Object.values(registry.families).some((entry) => entry.source.kind === 'css')) {
        r.warnings.push('css 来源的字体未内联（分片 CSS 的 url 无法安全重写）；导出件仍需能访问那些文件');
      }
      writeFileSync(out, r.html, 'utf8');
      return { ok: true, out, canvas: r.canvas, warnings: r.warnings };
    },
  },

  paintress_screenshot: {
    description:
      'Screenshot a design to PNG for your own review. scale 0.2-2, default 0.8 (agent-review size); either edge is capped at 8192px. Pass board to capture one board instead of the whole canvas. Needs local Chrome/Chromium or PTR_BROWSER.',
    inputSchema: {
      path: z.string(),
      out: z.string().describe('Output .png path'),
      scale: z.number().min(0.2).max(2).optional().describe('Pixel scale 0.2-2, default 0.8; 1x = board design pixels (the viewer 1:1)'),
      board: z.string().optional().describe('Capture one board by id or name; an ambiguous name errors and lists candidates'),
    },
    run: async (a) => {
      const browser = findBrowser();
      if (!browser) throw new Error('未找到可用浏览器：安装 Chromium/Chrome，或设置 PTR_BROWSER');
      const board = typeof a['board'] === 'string' ? a['board'] : '';
      const res = await screenshotPen(reqStr(a, 'path'), reqStr(a, 'out'), {
        ...(typeof a['scale'] === 'number' ? { scale: a['scale'] as number } : {}),
        ...(board !== '' ? { board } : {}),
      });
      return {
        ok: true,
        out: res.out,
        canvas: res.canvas,
        ...(res.board !== undefined ? { board: res.board } : {}),
        scale: res.scale,
        browser: res.browser,
        ...(res.fonts !== undefined ? { fonts: res.fonts } : {}),
        warnings: res.warnings,
      };
    },
  },

  paintress_clear_changes: {
    description:
      'Stop the change highlight (pulsing gold ring) once editing is done so the user sees the final design; the open viewer updates instantly. It also fades by itself 3 minutes after the last write.',
    inputSchema: {
      path: z.string().describe('Design file whose highlight to clear (.ptr / .pen)'),
    },
    run: async (a) => {
      const path = optStr(a, 'path');
      if (path === undefined) throw new Error('需要 design file path');
      if (!isDaemonRunning()) return { ok: true, cleared: 0, note: 'paintress web 未运行：本来就没有高亮' };
      try {
        // 与写操作的 changes 记录对称：daemon 按绝对路径找到「项目 + 相对文件」
        return await sendRequest({ kind: 'clear-changes', path: resolve(path) }, 2000);
      } catch (cause) {
        // 高亮的收尾不值得让 agent 报错：控制面不通就当作没清
        return { ok: true, cleared: 0, note: cause instanceof Error ? cause.message : String(cause) };
      }
    },
  },

  paintress_marks: {
    description:
      'Read or clear the node marks for this session: clicking a node in the viewer assigns #1 #2...; returns the #N -> node id mapping so the conversation can refer to it (e.g. "make #1 blue").',
    inputSchema: {
      project: z.string().optional().describe('Project name; omit to return marks from all projects'),
      action: z.enum(['list', 'clear']).optional().describe('Default: list'),
    },
    run: async (a) => {
      if (!isDaemonRunning()) {
        throw new Error('paintress web 未运行，无法读取标记；先调用 paintress_viewer（或运行 paintress web）');
      }
      const project = optStr(a, 'project') ?? '';
      const action = optStr(a, 'action') ?? 'list';
      if (action === 'clear') {
        const res = await sendRequest({ kind: 'clear-marks', project });
        return res;
      }
      const res = await sendRequest({ kind: 'marks', project });
      return res;
    },
  },
};
