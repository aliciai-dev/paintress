/**
 * 预设组（谱式）的纯逻辑：读、渲染前叠加。
 *
 * 只做「按名字取组 + 把组属性铺到节点上」这两件事，不碰文件系统——
 * 写盘在 `doc/project.ts`，渲染器只吃这里产出的结构。
 */

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
