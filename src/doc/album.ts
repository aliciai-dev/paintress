import { loadDoc, saveDoc, FileChangedError } from './io.js';
import { statSync } from 'node:fs';
import { findProjectRoot, findProjectRootStrict, listPresetGroups, listPresets, PRESET_FILE, readPresetFile, setPreset, setPresetGroup } from './project.js';
import { presetGroupsOf, type PresetGroup } from './presets.js';
import type { PenDocument } from '../schema/index.js';

/**
 * 画谱的两个操作：establish（从现有稿里提取 token / preset）与 adjust（改一处、看影响面）。
 *
 * 分工：本模块只做分析与改写计划；写盘走 `project.ts` 的 setPreset / setPresetGroup，
 * 设计稿改写走 `saveDoc`（带 mtime 防覆盖）。`apply=false` 时一个字节都不写。
 */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 一次性设计的逃生舱：建立候选与改写都跳过，但继续检查后代 */
function allowsLiteral(node: Record<string, unknown>): boolean {
  const meta = node['metadata'];
  return isRecord(meta) && (meta['allowLiteral'] === true || meta['allowLiteral'] === 'true');
}

const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/** 参与提取的属性：颜色（fill/stroke）与数值（圆角/间距/字号） */
const COLOR_PROPS = ['fill', 'stroke'] as const;
const NUM_PROPS: { prop: string; kind: 'radius' | 'spacing' | 'fontSize' }[] = [
  { prop: 'cornerRadius', kind: 'radius' },
  { prop: 'gap', kind: 'spacing' },
  { prop: 'fontSize', kind: 'fontSize' },
];

export interface LiteralUse {
  id: string;
  prop: string;
}

export interface CandidateToken {
  key: string;
  type: 'color' | 'radius' | 'spacing' | 'fontSize';
  value: string;
  uses: LiteralUse[];
}

export interface CandidateGroup {
  name: string;
  target: string;
  props: Record<string, string>;
  /** 命中的节点 id */
  uses: string[];
}

export interface EstablishPlan {
  tokens: CandidateToken[];
  groups: CandidateGroup[];
}

/** 建议的 token key：由值推导，可重复运行；必须符合 VARIABLE_NAME（不允许小数点等字符） */
export function suggestTokenKey(type: string, value: string): string {
  const raw = type === 'color' ? value.replace(/^#/, '') : value;
  const safe = raw.replace(/[^A-Za-z0-9_-]+/g, '-');
  if (type === 'color') return `color-${safe.toLowerCase()}`;
  if (type === 'radius') return `radius-${safe}`;
  if (type === 'spacing') return `spacing-${safe}`;
  if (type === 'fontSize') return `fontSize-${safe}`;
  return `font-${safe}`;
}

/**
 * 从设计稿提取候选：同一字面量被 ≥ minUses 处使用 → 建议 token；
 * 同一类节点带同一组属性 ≥ minUses 次 → 建议 preset 组（属性值只引用已建议的 token）。
 */
export function planEstablish(doc: PenDocument, opts: { minUses?: number } = {}): EstablishPlan {
  const minUses = Math.max(2, opts.minUses ?? 2);
  const colorUses = new Map<string, LiteralUse[]>();
  const numUses = new Map<string, { kind: 'radius' | 'spacing' | 'fontSize'; value: string; uses: LiteralUse[] }>();
  const signatures = new Map<string, { target: string; props: Record<string, string>; ids: string[] }>();

  const walk = (nodes: unknown[], inheritedAllowLiteral = false): void => {
    for (const raw of nodes) {
      if (!isRecord(raw)) continue;
      const node = raw;
      const allowLiteral = inheritedAllowLiteral || allowsLiteral(node);
      const id = typeof node['id'] === 'string' ? node['id'] : '?';
      const type = typeof node['type'] === 'string' ? node['type'] : '?';

      if (!allowLiteral) {
        for (const prop of COLOR_PROPS) {
        const v = node[prop];
        if (typeof v === 'string' && HEX_RE.test(v)) {
          const list = colorUses.get(v.toUpperCase()) ?? [];
          list.push({ id, prop });
          colorUses.set(v.toUpperCase(), list);
        }
      }
      for (const { prop, kind } of NUM_PROPS) {
        const v = node[prop];
        if (typeof v === 'number' && Number.isFinite(v)) {
          const mapKey = `${kind}:${v}`;
          const hit = numUses.get(mapKey) ?? { kind, value: String(v), uses: [] };
          hit.uses.push({ id, prop });
          numUses.set(mapKey, hit);
        }
      }

      // preset 候选：同类型 + 同一组「颜色/圆角/间距」属性
      const styleProps: Record<string, string> = {};
      for (const prop of ['fill', 'stroke', 'cornerRadius', 'gap'] as const) {
        const v = node[prop];
        if (typeof v === 'string' && HEX_RE.test(v)) styleProps[prop] = v.toUpperCase();
        else if (typeof v === 'number' && Number.isFinite(v)) styleProps[prop] = String(v);
      }
      if (Object.keys(styleProps).length >= 2) {
        const sig = `${type}|${JSON.stringify(styleProps)}`;
        const hit = signatures.get(sig) ?? { target: type, props: styleProps, ids: [] };
        hit.ids.push(id);
        signatures.set(sig, hit);
      }
      }

      const kids = node['children'];
      if (Array.isArray(kids)) walk(kids, allowLiteral);
    }
  };
  walk(doc.children);

  const tokens: CandidateToken[] = [];
  const tokenByValue = new Map<string, string>();
  for (const [value, uses] of colorUses) {
    if (uses.length < minUses) continue;
    const key = suggestTokenKey('color', value);
    tokens.push({ key, type: 'color', value, uses });
    tokenByValue.set(`color:${value}`, key);
  }
  for (const [, entry] of numUses) {
    if (entry.uses.length < minUses) continue;
    const key = suggestTokenKey(entry.kind, entry.value);
    tokens.push({ key, type: entry.kind, value: entry.value, uses: entry.uses });
    tokenByValue.set(`${entry.kind}:${entry.value}`, key);
  }
  // 同一个 key 只留一条（值理论上唯一，这里防手改过的文档撞名）
  const seen = new Set<string>();
  const uniqueTokens = tokens.filter((t) => (seen.has(t.key) ? false : (seen.add(t.key), true)));

  const groups: CandidateGroup[] = [];
  const groupNames = new Set<string>();
  for (const [, hit] of signatures) {
    if (hit.ids.length < minUses) continue;
    const props: Record<string, string> = {};
    let complete = true;
    for (const [prop, value] of Object.entries(hit.props)) {
      const isColor = HEX_RE.test(value);
      const kind = isColor ? 'color' : prop === 'cornerRadius' ? 'radius' : 'spacing';
      // gap 与 cornerRadius 可以是同一个数字，但语义不同，不能按「先找到哪个算哪个」
      const key = tokenByValue.get(`${kind}:${value}`);
      if (key === undefined) {
        complete = false;
        break;
      }
      props[prop] = `$${key}`;
    }
    if (!complete || Object.keys(props).length < 2) continue;
    let name = `preset-${hit.target}`;
    let i = 2;
    while (groupNames.has(name)) name = `preset-${hit.target}-${i++}`;
    groupNames.add(name);
    groups.push({ name, target: hit.target, props, uses: hit.ids });
  }

  return { tokens: uniqueTokens, groups };
}

export interface EstablishResult {
  applied: boolean;
  tokens: CandidateToken[];
  groups: CandidateGroup[];
  written: { tokens: string[]; groups: string[]; nodes: number };
  /** 被改写成引用的节点 id：调用方据此让查看器把这些节点标出来 */
  touched: string[];
}

/**
 * 应用提取结果：写 token / preset 组，并把命中的节点改写成引用。
 * 传 expectedMtimeMs 时，**先**检查设计稿再写预设，避免计划过期后留下半套变更。
 */
export function applyEstablish(
  designPath: string,
  plan: EstablishPlan,
  opts: { expectedMtimeMs?: number } = {},
): EstablishResult {
  if (opts.expectedMtimeMs !== undefined && statSync(designPath).mtimeMs !== opts.expectedMtimeMs) {
    throw new FileChangedError(designPath);
  }
  const root = findProjectRootStrict(designPath);
  const presetPath = `${root}/${PRESET_FILE}`;

  // 候选名来自值/类型，可能撞上项目里已经被手改过的同名定义。
  // 覆盖它会改变现有节点的观感，所以必须在任何写入之前报冲突，而不是静默替换。
  const existingTokens = new Map(listPresets(presetPath).items.map((item) => [item.key, item]));
  for (const token of plan.tokens) {
    const existing = existingTokens.get(token.key);
    if (existing !== undefined && (existing.type !== token.type || existing.value !== token.value)) {
      throw new Error(`token "${token.key}" 已存在且定义不同，拒绝覆盖（现有 ${existing.value}，候选 ${token.value}）`);
    }
  }
  const existingGroups = listPresetGroups(presetPath).groups;
  for (const group of plan.groups) {
    const existing = existingGroups[group.name];
    if (
      existing !== undefined &&
      (existing.target !== group.target || JSON.stringify(existing.props) !== JSON.stringify(group.props))
    ) {
      throw new Error(`preset 组 "${group.name}" 已存在且定义不同，拒绝覆盖；请先调整候选组名`);
    }
  }

  const writtenTokens: string[] = [];
  for (const t of plan.tokens) {
    setPreset(presetPath, { key: t.key, type: t.type, value: t.value });
    writtenTokens.push(t.key);
  }
  const writtenGroups: string[] = [];
  for (const g of plan.groups) {
    setPresetGroup(presetPath, { name: g.name, target: g.target, props: g.props });
    writtenGroups.push(g.name);
  }

  const loaded = loadDoc(designPath);
  const groupByNode = new Map<string, CandidateGroup>();
  for (const g of plan.groups) for (const id of g.uses) groupByNode.set(id, g);
  const tokenByValue = new Map<string, string>();
  for (const t of plan.tokens) tokenByValue.set(`${t.type}:${t.value.toUpperCase()}`, t.key);

  let updated = 0;
  const touchedIds = new Set<string>();
  const rewrite = (nodes: unknown[], inheritedAllowLiteral = false): void => {
    for (const raw of nodes) {
      if (!isRecord(raw)) continue;
      const node = raw;
      if (inheritedAllowLiteral || allowsLiteral(node)) {
        const kids = node['children'];
        if (Array.isArray(kids)) rewrite(kids, true);
        continue;
      }
      const id = typeof node['id'] === 'string' ? node['id'] : '';
      const group = groupByNode.get(id);
      if (group !== undefined && node['preset'] === undefined) {
        for (const prop of Object.keys(group.props)) delete node[prop];
        node['preset'] = group.name;
        if (id !== '') touchedIds.add(id);
        updated += 1;
      } else {
        // 没有命中组：只改写 planEstablish 声明过的样式属性。
        // 不能遍历全部字段——width:8、content:'#3B82F6' 都不是圆角/颜色 token 的用途。
        let touched = false;
        for (const prop of COLOR_PROPS) {
          const value = node[prop];
          if (typeof value !== 'string' || !HEX_RE.test(value)) continue;
          const key = tokenByValue.get(`color:${value.toUpperCase()}`);
          if (key !== undefined) {
            node[prop] = `$${key}`;
            touched = true;
          }
        }
        for (const { prop, kind } of NUM_PROPS) {
          const value = node[prop];
          if (typeof value !== 'number' || !Number.isFinite(value)) continue;
          const key = tokenByValue.get(`${kind}:${String(value)}`);
          if (key !== undefined) {
            node[prop] = `$${key}`;
            touched = true;
          }
        }
        if (touched) {
          if (id !== '') touchedIds.add(id);
          updated += 1;
        }
      }
      const kids = node['children'];
      if (Array.isArray(kids)) rewrite(kids);
    }
  };
  rewrite(loaded.doc.children);
  if (updated > 0) saveDoc(designPath, loaded.doc, { expectedMtimeMs: loaded.mtimeMs, flavor: loaded.flavor });

  return {
    applied: true,
    tokens: plan.tokens,
    groups: plan.groups,
    written: { tokens: writtenTokens, groups: writtenGroups, nodes: updated },
    touched: [...touchedIds],
  };
}

// ---------------------------------------------------------------- adjust

/** 遍历文档节点（含嵌套）；没 id 的节点给 `'?'`，调用方自己过滤 */
function forEachNode(nodes: unknown[], visit: (node: Record<string, unknown>, id: string) => void): void {
  for (const raw of nodes) {
    if (!isRecord(raw)) continue;
    const id = typeof raw['id'] === 'string' ? raw['id'] : '?';
    visit(raw, id);
    const kids = raw['children'];
    if (Array.isArray(kids)) forEachNode(kids, visit);
  }
}

/** 「退了一个 token」或「换了一个 preset 组」的描述：只需要知道改了谁，不需要新值 */
export interface PresetBlast {
  /** 改 / 删的 token key（不带 `$`） */
  token?: string;
  /** 改 / 删的 preset 组名 */
  group?: string;
}

/**
 * 预设变更会连带改变哪些节点：
 * - token：直接写着 `$key` 的节点，外加引用 `$key` 的 preset 组装上的节点；
 * - 组：写着 `preset:"<组名>"` 的节点。
 *
 * 只服务于「写完告诉查看器亮哪些节点」，**不参与渲染计算**：渲染侧的合并由 project.ts 负责。
 */
export function nodesAffectedByPreset(
  doc: PenDocument,
  presetDoc: PenDocument | null,
  blast: PresetBlast,
): string[] {
  const groups: Record<string, PresetGroup> = { ...presetGroupsOf(presetDoc), ...presetGroupsOf(doc) };
  const affectedGroups = new Set<string>();
  if (blast.group !== undefined) affectedGroups.add(blast.group);
  const ref = blast.token === undefined ? null : `$${blast.token}`;
  if (ref !== null) {
    for (const [name, group] of Object.entries(groups)) {
      if (Object.values(group.props).includes(ref)) affectedGroups.add(name);
    }
  }
  const referencesRef = (value: unknown): boolean => {
    if (ref !== null && value === ref) return true;
    if (Array.isArray(value)) return value.some(referencesRef);
    if (isRecord(value)) return Object.values(value).some(referencesRef);
    return false;
  };
  const out = new Set<string>();
  forEachNode(doc.children, (node, id) => {
    if (id === '?') return;
    const preset = typeof node['preset'] === 'string' ? node['preset'] : undefined;
    if (preset !== undefined && affectedGroups.has(preset)) {
      out.add(id);
      return;
    }
    if (ref !== null && Object.entries(node).some(([prop, value]) => prop !== 'children' && referencesRef(value))) {
      out.add(id);
    }
  });
  return [...out];
}

export interface AdjustChange {
  where: string;
  prop: string;
  before: string;
  after: string;
}

export interface AdjustRequest {
  /** 改 token 值 */
  key?: string;
  /** 或者改 preset 组的某个属性 */
  group?: string;
  prop?: string;
  value: string;
}

export interface AdjustPlan {
  kind: 'token' | 'group';
  target: string;
  /** 改组属性时必须独立于 changes 保存：未被引用的组 changes 为空也要能 apply */
  prop?: string;
  value: string;
  changes: AdjustChange[];
}

function resolveVars(doc: PenDocument, presetDoc: PenDocument | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const src of [presetDoc?.variables, doc.variables]) {
    for (const [k, def] of Object.entries(src ?? {})) {
      const raw = isRecord(def) ? def['value'] : undefined;
      const v = Array.isArray(raw) ? (raw[0] as Record<string, unknown> | undefined)?.['value'] : raw;
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = String(v);
    }
  }
  return out;
}

/**
 * 改一处的影响面（dry-run）：token 被哪些节点/组引用、preset 组被哪些节点引用，
 * 每条都给出 `before → after`。不写盘。
 */
export function planAdjust(
  doc: PenDocument,
  presetDoc: PenDocument | null,
  req: AdjustRequest,
): AdjustPlan {
  const groups: Record<string, PresetGroup> = { ...presetGroupsOf(presetDoc), ...presetGroupsOf(doc) };
  const vars = resolveVars(doc, presetDoc);
  const changes: AdjustChange[] = [];

  if (req.key !== undefined && req.key !== '') {
    const ref = `$${req.key}`;
    const before = vars[req.key] ?? '';
    const walk = (nodes: unknown[]): void => {
      for (const raw of nodes) {
        if (!isRecord(raw)) continue;
        const id = typeof raw['id'] === 'string' ? raw['id'] : '?';
        // 引用可能在 fill[0].color、effect[1].color、descendants.<path>.fill 等嵌套位置；
        // 只比较顶层字段会把最常见的结构化填充全部漏掉。
        const scan = (value: unknown, propPath: string): void => {
          if (value === ref) {
            changes.push({ where: id, prop: propPath, before, after: req.value });
            return;
          }
          if (Array.isArray(value)) {
            value.forEach((entry, index) => scan(entry, `${propPath}[${index}]`));
            return;
          }
          if (isRecord(value)) {
            for (const [key, entry] of Object.entries(value)) scan(entry, `${propPath}.${key}`);
          }
        };
        for (const [prop, value] of Object.entries(raw)) {
          if (prop !== 'children') scan(value, prop);
        }
        const kids = raw['children'];
        if (Array.isArray(kids)) walk(kids);
      }
    };
    walk(doc.children);
    for (const [name, g] of Object.entries(groups)) {
      for (const [prop, value] of Object.entries(g.props)) {
        if (value === ref) changes.push({ where: `<preset:${name}>`, prop, before, after: req.value });
      }
    }
    return { kind: 'token', target: req.key, value: req.value, changes };
  }

  if (req.group !== undefined && req.group !== '' && req.prop !== undefined && req.prop !== '') {
    const group = groups[req.group];
    if (group === undefined) throw new Error(`preset 组不存在：${req.group}`);
    const groupProp = req.prop;
    const beforeRef = group.props[groupProp] ?? '';
    const before = beforeRef.startsWith('$') ? (vars[beforeRef.slice(1)] ?? beforeRef) : beforeRef;
    const walk = (nodes: unknown[]): void => {
      for (const raw of nodes) {
        if (!isRecord(raw)) continue;
        const id = typeof raw['id'] === 'string' ? raw['id'] : '?';
        if (raw['preset'] === req.group && raw[groupProp] === undefined) {
          // 节点自己的同名显式属性优先于 preset，改组值不会影响它
          changes.push({ where: id, prop: groupProp, before, after: req.value });
        }
        const kids = raw['children'];
        if (Array.isArray(kids)) walk(kids);
      }
    };
    walk(doc.children);
    return { kind: 'group', target: req.group, prop: groupProp, value: req.value, changes };
  }

  throw new Error('adjust 需要 key（改 token）或 group + prop（改 preset 组属性）');
}

export interface AdjustResult extends AdjustPlan {
  applied: boolean;
  /** 落盘后渲染会变的节点 id：调用方据此让查看器把它们标出来 */
  touched: string[];
}

/** 应用：只写 `__preset.ptr`；设计稿里的引用自动跟着变 */
export function applyAdjust(
  designPath: string,
  presetDoc: PenDocument | null,
  plan: AdjustPlan,
  /** `doc` 已经在手边时传进来，避免为了算受影响的节点再读一遍大稿 */
  opts: { doc?: PenDocument } = {},
): AdjustResult {
  const designDoc = (): PenDocument => opts.doc ?? loadDoc(designPath).doc;
  /** 计划里点名过的节点 + 经预设组间接受影响、计划只记了 `<preset:x>` 的节点 */
  const touchedOf = (): string[] => {
    const direct = plan.changes.map((c) => c.where).filter((where) => where !== '?' && !where.startsWith('<'));
    const viaPreset =
      plan.kind === 'token' ? nodesAffectedByPreset(designDoc(), presetDoc, { token: plan.target }) : [];
    return [...new Set([...direct, ...viaPreset])];
  };
  if (plan.kind === 'token') {
    const items = listPresets(designPath).items;
    const existing = items.find((p) => p.key === plan.target);
    if (existing === undefined) throw new Error(`token 不存在：${plan.target}`);
    const presetPath = `${findProjectRootStrict(designPath)}/${PRESET_FILE}`;
    setPreset(presetPath, { key: existing.key, type: existing.type, value: plan.value, name: existing.name });
    return { ...plan, applied: true, touched: touchedOf() };
  }
  const groups = presetGroupsOf(presetDoc);
  const group = groups[plan.target];
  if (group === undefined) throw new Error(`preset 组不存在：${plan.target}`);
  const prop = plan.prop;
  if (prop === undefined || prop === '') throw new Error(`adjust 计划缺少组属性名：${plan.target}`);
  const nextProps = { ...group.props, [prop]: plan.value };
  const presetPath = `${findProjectRootStrict(designPath)}/${PRESET_FILE}`;
  setPresetGroup(presetPath, { name: plan.target, target: group.target, props: nextProps });
  return { ...plan, applied: true, touched: touchedOf() };
}

/** 读项目预设文档（没有就是 null） */
export function readPresetDoc(designPath: string): PenDocument | null {
  const root = findProjectRoot(designPath);
  if (root === null) return null;
  return readPresetFile(`${root}/${PRESET_FILE}`)?.doc ?? null;
}
