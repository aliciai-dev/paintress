/**
 * 预设（token）与谱式（preset 组）的纯逻辑：类型、属性映射、读组、渲染前叠加。
 *
 * 只做不碰文件系统的事——写盘在 `doc/project.ts`，渲染器只吃这里产出的结构。
 */

/**
 * token 类型：`fontSize` 落盘为 number，`font` 只表示字体族（string）。
 * 老文件里「`font` + 数字值」在读取时归一成 `fontSize`（见 `project.ts#presetKindOf`）。
 */
export type PresetType = 'color' | 'radius' | 'spacing' | 'fontSize' | 'font';

export const PRESET_TYPES: readonly PresetType[] = ['color', 'radius', 'spacing', 'fontSize', 'font'];

export function isPresetType(v: unknown): v is PresetType {
  return typeof v === 'string' && (PRESET_TYPES as readonly string[]).includes(v);
}

/**
 * 属性 → 期望的 token 种类。**唯一映射表**：audit、establish、validate、写入提示都从这里取，
 * 各处不得再抄一份（2026-11-15：`fontSize` 曾因两处映射不一致而无法 token 化）。
 *
 * 刻意不含 `lineHeight`（它是 fontSize 的倍数，塞进任何数字种类都是错语义）；
 * `fontWeight` 同理（等独立种类，见 `.agents/memory/FUTURE.md`）。
 */
export const PROP_TOKEN_KIND: Record<string, PresetType> = {
  fill: 'color',
  stroke: 'color',
  color: 'color',
  effect: 'color',
  cornerRadius: 'radius',
  gap: 'spacing',
  padding: 'spacing',
  strokeWidth: 'spacing',
  letterSpacing: 'spacing',
  fontSize: 'fontSize',
  fontFamily: 'font',
};

/** 种类的人读名（校验与审计的提示语用） */
export const PRESET_TYPE_LABEL: Record<PresetType, string> = {
  color: '颜色',
  radius: '倒角',
  spacing: '间距',
  fontSize: '字号',
  font: '字体族',
};

/** 值是不是一个数字字串（老 `font` token 靠它识别字号；纯字体族名不会全是数字） */
export function isNumericPresetValue(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value));
}

export interface PresetGroup {
  /** 适用的节点类型（frame / text / rectangle …） */
  target: string;
  /** 属性 → `$token` 引用 */
  props: Record<string, string>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 文档里携带的预设组（`x-paintress.presets.groups`）；坏结构当没有 */
export function presetGroupsOf(doc: unknown): Record<string, PresetGroup> {
  const meta = isRecord(doc) ? doc['x-paintress'] : undefined;
  const presets = isRecord(meta) ? meta['presets'] : undefined;
  const groups = isRecord(presets) ? presets['groups'] : undefined;
  if (!isRecord(groups)) return {};
  const out: Record<string, PresetGroup> = {};
  for (const [name, raw] of Object.entries(groups)) {
    if (!isRecord(raw)) continue;
    const target = typeof raw['target'] === 'string' ? raw['target'] : '';
    const props: Record<string, string> = {};
    const rawProps = raw['props'];
    if (isRecord(rawProps)) {
      for (const [k, v] of Object.entries(rawProps)) {
        if (typeof v === 'string' && v.trim() !== '') props[k] = v;
      }
    }
    if (target === '' || Object.keys(props).length === 0) continue;
    out[name] = { target, props };
  }
  return out;
}

/**
 * 渲染前把节点上的 `preset: '<name>'` 铺开：组属性打底，**节点自己的属性优先**。
 * 返回新树（不改输入，保存永远写原文档）；缺失/类型不符的引用只警告、不猜。
 */
export function applyPresetRefs<T>(nodes: T[], groups: Record<string, PresetGroup>, warnings: string[]): T[] {
  if (Object.keys(groups).length === 0) return nodes;
  const walk = (list: unknown[], where: string): unknown[] =>
    list.map((raw, i) => {
      if (!isRecord(raw)) return raw;
      let node: Record<string, unknown> = raw;
      const name = node['preset'];
      const label = `${String(node['type'] ?? '?')}${typeof node['name'] === 'string' && node['name'] !== '' ? `: ${String(node['name'])}` : ''}`;
      if (typeof name === 'string' && name !== '') {
        const group = groups[name];
        if (group === undefined) {
          warnings.push(`${label}: preset "${name}" 不存在`);
        } else if (group.target !== node['type']) {
          // 展开前已经套到 ref 上的组属性会被 expandRefs 复制到组件根；
          // 第二遍看到 target=ref → type=frame 不算新的不匹配。
          const alreadyApplied = Object.entries(group.props).every(([key, value]) => node[key] === value);
          if (!alreadyApplied) {
            warnings.push(`${label}: preset "${name}" 适用于 ${group.target}，节点是 ${String(node['type'])}`);
          }
        } else {
          node = { ...group.props, ...node };
        }
      }
      const kids = node['children'];
      if (Array.isArray(kids)) node = { ...node, children: walk(kids, `${where}/${i}`) };
      return node;
    });
  return walk(nodes, 'children') as T[];
}
