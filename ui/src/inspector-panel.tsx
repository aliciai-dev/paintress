import { For, Show, type JSX } from 'solid-js';
import { Panel } from './panel.js';

/**
 * 只读属性面板：选中节点 → 看它在磁盘上的真实字段。
 *
 * 刻意不带任何编辑控件：写路径只有 MCP / CLI 一条，查看器开了第二个写入口就必然出现两份状态。
 * 值一律按「原样 + 可读化」两段显示：颜色给色块、`$变量` 给解析值，其余照原样（对象折成 JSON）。
 */

export interface InspectorLabels {
  title: string;
  close: string;
  empty: string;
  groups: {
    identity: string;
    geometry: string;
    layout: string;
    appearance: string;
    text: string;
    other: string;
  };
  /** ref 实例的后代覆写条数 */
  descendants: (count: number) => string;
}

export interface InspectorPanelProps {
  node: Record<string, unknown> | null;
  /** 变量表（项目预设 + 文档本地），把 `$name` 显示成「引用 → 值」 */
  vars: Record<string, string>;
  labels: InspectorLabels;
  onClose: () => void;
}

const GROUPS: { key: keyof InspectorLabels['groups']; fields: string[] }[] = [
  { key: 'identity', fields: ['id', 'type', 'name', 'reusable', 'preset', 'ref', 'metadata'] },
  { key: 'geometry', fields: ['x', 'y', 'width', 'height', 'rotation', 'opacity', 'flipX', 'flipY'] },
  {
    key: 'layout',
    fields: ['layout', 'gap', 'padding', 'justifyContent', 'alignItems', 'layoutPosition', 'clip', 'textGrowth'],
  },
  {
    key: 'appearance',
    fields: ['fill', 'stroke', 'strokeWidth', 'strokeAlignment', 'cornerRadius', 'effect', 'blendMode'],
  },
  { key: 'text', fields: ['content', 'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'textAlign'] },
];

/** 展示用：值 → 文本 + 可选的解析值/色块 */
interface Shown {
  text: string;
  resolved?: string;
  swatch?: string;
}

const MAX_TEXT = 120;
const COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

function show(raw: unknown, vars: Record<string, string>): Shown | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'string') {
    if (raw.startsWith('$')) {
      const name = raw.slice(1);
      const hit = vars[name];
      if (hit !== undefined) {
        return { text: raw, resolved: hit, ...(COLOR_RE.test(hit) ? { swatch: hit } : {}) };
      }
      return { text: raw };
    }
    if (COLOR_RE.test(raw)) return { text: raw, swatch: raw };
    return { text: raw };
  }
  if (typeof raw === 'number' || typeof raw === 'boolean') return { text: String(raw) };
  let json: string;
  try {
    json = JSON.stringify(raw);
  } catch {
    json = String(raw);
  }
  return { text: json.length > MAX_TEXT ? `${json.slice(0, MAX_TEXT)}…` : json };
}

function rowsOf(node: Record<string, unknown>, key: keyof InspectorLabels['groups'], fields: string[]): [string, unknown][] {
  const out: [string, unknown][] = [];
  for (const f of fields) {
    const v = node[f];
    if (v !== undefined) out.push([f, v]);
  }
  // 「其它」= 不在任何已知组里的字段；children 是结构不是属性，不列
  if (key === 'other') {
    const known = new Set(GROUPS.flatMap((g) => g.fields));
    for (const [k, v] of Object.entries(node)) {
      if (known.has(k) || k === 'children') continue;
      out.push([k, v]);
    }
  }
  return out;
}

export function InspectorPanel(props: InspectorPanelProps): JSX.Element {
  const node = (): Record<string, unknown> | null => props.node;

  return (
    <Panel title={props.labels.title} closeLabel={props.labels.close} onClose={props.onClose} floating class="inspector-panel">
      <Show
        when={node() !== null}
        fallback={<p class="empty">{props.labels.empty}</p>}
      >
        <Show when={Array.isArray(node()?.['descendants']) ? (node()?.['descendants'] as unknown[]).length : 0}>
          <p class="insp-note">{props.labels.descendants((node()?.['descendants'] as unknown[]).length)}</p>
        </Show>
        <For each={GROUPS}>
          {(group) => {
            const rows = (): [string, unknown][] => rowsOf(node() ?? {}, group.key, group.fields);
            return (
              <Show when={rows().length > 0}>
                <section class="insp-group">
                  <h3>{props.labels.groups[group.key]}</h3>
                  <For each={rows()}>
                    {([key, raw]) => {
                      const shown = show(raw, props.vars);
                      return (
                        <Show when={shown !== null}>
                          <div class="insp-row">
                            <span class="insp-key">{key}</span>
                            <span class="insp-val">
                              <Show when={shown!.swatch}>
                                <span class="insp-swatch" style={{ background: shown!.swatch! }} aria-hidden="true" />
                              </Show>
                              <code>{shown!.text}</code>
                              <Show when={shown!.resolved !== undefined}>
                                <span class="insp-resolved">→ {shown!.resolved}</span>
                              </Show>
                            </span>
                          </div>
                        </Show>
                      );
                    }}
                  </For>
                </section>
              </Show>
            );
          }}
        </For>
      </Show>
    </Panel>
  );
}
