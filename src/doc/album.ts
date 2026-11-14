import { loadDoc, saveDoc } from './io.js';
import { findProjectRoot, listPresets, PRESET_FILE, readPresetFile, setPreset, setPresetGroup } from './project.js';
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

const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/** 参与提取的属性：颜色（fill/stroke）与数值（圆角/间距/字号） */
const COLOR_PROPS = ['fill', 'stroke'] as const;
const NUM_PROPS: { prop: string; kind: 'radius' | 'spacing' | 'font' }[] = [
  { prop: 'cornerRadius', kind: 'radius' },
  { prop: 'gap', kind: 'spacing' },
  { prop: 'fontSize', kind: 'font' },
];

export interface LiteralUse {
  id: string;
  prop: string;
}

export interface CandidateToken {
  key: string;
  type: 'color' | 'radius' | 'spacing' | 'font';
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

/** 建议的 token key：由值推导，可重复运行（同样的值只会有一个 key） */
export function suggestTokenKey(type: string, value: string): string {
  if (type === 'color') return `color-${value.replace('#', '').toLowerCase()}`;
  if (type === 'radius') return `radius-${value}`;
  if (type === 'spacing') return `spacing-${value}`;
  return `font-${value}`;
}

/**
 * 从设计稿提取候选：同一字面量被 ≥ minUses 处使用 → 建议 token；
 * 同一类节点带同一组属性 ≥ minUses 次 → 建议 preset 组（属性值只引用已建议的 token）。
 */
export function planEstablish(doc: PenDocument, opts: { minUses?: number } = {}): EstablishPlan {
  const minUses = Math.max(2, opts.minUses ?? 2);
  const colorUses = new Map<string, LiteralUse[]>();
  const numUses = new Map<string, { kind: 'radius' | 'spacing' | 'font'; value: string; uses: LiteralUse[] }>();
  const signatures = new Map<string, { target: string; props: Record<string, string>; ids: string[] }>();

  const walk = (nodes: unknown[]): void => {
    for (const raw of nodes) {
      if (!isRecord(raw)) continue;
      const node = raw;
      const id = typeof node['id'] === 'string' ? node['id'] : '?';
      const type = typeof node['type'] === 'string' ? node['type'] : '?';

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

      const kids = node['children'];
      if (Array.isArray(kids)) walk(kids);
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
      const key = isColor ? tokenByValue.get(`color:${value}`) : tokenByValue.get(`radius:${value}`) ?? tokenByValue.get(`spacing:${value}`);
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
}

/** 应用提取结果：写 token / preset 组，并把命中的节点改写成引用（一次写入，mtime 防覆盖） */
export function applyEstablish(designPath: string, plan: EstablishPlan): EstablishResult {
  const root = findProjectRoot(designPath) ?? null;
  if (root === null) throw new Error('设计稿不在项目里（找不到 __preset.ptr），先注册项目或建预设文件');
  const presetPath = `${root}/${PRESET_FILE}`;

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
  const rewrite = (nodes: unknown[]): void => {
    for (const raw of nodes) {
      if (!isRecord(raw)) continue;
      const node = raw;
      const id = typeof node['id'] === 'string' ? node['id'] : '';
      const group = groupByNode.get(id);
      if (group !== undefined && node['preset'] === undefined) {
        for (const prop of Object.keys(group.props)) delete node[prop];
        node['preset'] = group.name;
        updated += 1;
      } else {
        // 没有命中组：把命中的字面量换成 $token，行为不变、引用链建立
        let touched = false;
        for (const [prop, value] of Object.entries(node)) {
          if (typeof value === 'string' && HEX_RE.test(value)) {
            const key = tokenByValue.get(`color:${value.toUpperCase()}`);
            if (key !== undefined) {
              node[prop] = `$${key}`;
              touched = true;
            }
          } else if (typeof value === 'number') {
            for (const kind of ['radius', 'spacing', 'font'] as const) {
              const key = tokenByValue.get(`${kind}:${String(value)}`);
              if (key !== undefined) {
                node[prop] = `$${key}`;
                touched = true;
                break;
              }
            }
          }
        }
        if (touched) updated += 1;
      }
      const kids = node['children'];
      if (Array.isArray(kids)) rewrite(kids);
    }
  };
  rewrite(loaded.doc.children);
  if (updated > 0) saveDoc(designPath, loaded.doc, { expectedMtimeMs: loaded.mtimeMs, flavor: loaded.flavor });

  return { applied: true, tokens: plan.tokens, groups: plan.groups, written: { tokens: writtenTokens, groups: writtenGroups, nodes: updated } };
}

// ---------------------------------------------------------------- adjust

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
        for (const [prop, value] of Object.entries(raw)) {
          if (value === ref) changes.push({ where: id, prop, before, after: req.value });
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
    const beforeRef = group.props[req.prop] ?? '';
    const before = beforeRef.startsWith('$') ? (vars[beforeRef.slice(1)] ?? beforeRef) : beforeRef;
    const walk = (nodes: unknown[]): void => {
      for (const raw of nodes) {
        if (!isRecord(raw)) continue;
        const id = typeof raw['id'] === 'string' ? raw['id'] : '?';
        if (raw['preset'] === req.group) changes.push({ where: id, prop: req.prop as string, before, after: req.value });
        const kids = raw['children'];
        if (Array.isArray(kids)) walk(kids);
      }
    };
    walk(doc.children);
    return { kind: 'group', target: req.group, value: req.value, changes };
  }

  throw new Error('adjust 需要 key（改 token）或 group + prop（改 preset 组属性）');
}

export interface AdjustResult extends AdjustPlan {
  applied: boolean;
}

/** 应用：只写 `__preset.ptr`；设计稿里的引用自动跟着变 */
export function applyAdjust(designPath: string, presetDoc: PenDocument | null, plan: AdjustPlan): AdjustResult {
  if (plan.kind === 'token') {
    const items = listPresets(designPath).items;
    const existing = items.find((p) => p.key === plan.target);
    if (existing === undefined) throw new Error(`token 不存在：${plan.target}`);
    const presetPath = `${findProjectRoot(designPath) ?? '.'}/${PRESET_FILE}`;
    setPreset(presetPath, { key: existing.key, type: existing.type, value: plan.value, name: existing.name });
    return { ...plan, applied: true };
  }
  const groups = presetGroupsOf(presetDoc);
  const group = groups[plan.target];
  if (group === undefined) throw new Error(`preset 组不存在：${plan.target}`);
  const prop = plan.changes[0]?.prop ?? '';
  const nextProps = { ...group.props, [prop]: plan.value };
  const presetPath = `${findProjectRoot(designPath) ?? '.'}/${PRESET_FILE}`;
  setPresetGroup(presetPath, { name: plan.target, target: group.target, props: nextProps });
  return { ...plan, applied: true };
}

/** 读项目预设文档（没有就是 null） */
export function readPresetDoc(designPath: string): PenDocument | null {
  const root = findProjectRoot(designPath);
  if (root === null) return null;
  return readPresetFile(`${root}/${PRESET_FILE}`)?.doc ?? null;
}
