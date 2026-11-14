import { createSignal, For, Show, type JSX } from 'solid-js';
import { Panel } from './panel.js';
import type { PresetGroup, PresetItem } from './api.js';

/**
 * 项目预设面板（画谱的 token 手改入口）：按 kind 分组，值就地编辑。
 * 改一条就写回 `__preset.ptr`，画布收到 SSE 后重渲染——所以调色是即时的，
 * 不需要一句句跟 agent 说「红一点、再蓝一点」。
 *
 * preset 组（谱式）只读展示：它是 agent 用来框住一组属性的，人在这里看关系，
 * 改组值要走 agent / MCP（避免查看器开出第二个写路径）。
 */
export interface PresetPanelLabels {
  title: string;
  close: string;
  empty: string;
  hint: string;
  color: string;
  radius: string;
  spacing: string;
  font: string;
  groups: string;
  groupsEmpty: string;
}

export interface PresetPanelProps {
  items: PresetItem[];
  groups: Record<string, PresetGroup>;
  labels: PresetPanelLabels;
  onClose: () => void;
  /** 提交一条预设的新值；返回的 Promise 结束前输入框保持可编辑（不做乐观更新） */
  onSet: (key: string, value: string) => void;
}

/** `#RGB` / `#RRGGBBAA` → `<input type=color>` 能吃的 `#RRGGBB` */
function toHex6(value: string): string {
  const v = value.trim();
  if (/^#[0-9a-fA-F]{3}$/.test(v)) {
    return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`.toUpperCase();
  }
  if (/^#[0-9a-fA-F]{6,8}$/.test(v)) return v.slice(0, 7).toUpperCase();
  return '#000000';
}

const GROUPS: { type: PresetItem['type']; key: 'color' | 'radius' | 'spacing' | 'font' }[] = [
  { type: 'color', key: 'color' },
  { type: 'radius', key: 'radius' },
  { type: 'spacing', key: 'spacing' },
  { type: 'font', key: 'font' },
];

export function PresetPanel(props: PresetPanelProps): JSX.Element {
  const [draft, setDraft] = createSignal<Record<string, string>>({});

  const valueOf = (item: PresetItem): string => draft()[item.key] ?? item.value;
  const ofType = (type: PresetItem['type']): PresetItem[] => props.items.filter((p) => p.type === type);

  function edit(key: string, value: string): void {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }

  function commit(item: PresetItem): void {
    const raw = valueOf(item).trim();
    const clear = (): void => {
      setDraft((prev) => {
        const next = { ...prev };
        delete next[item.key];
        return next;
      });
    };
    if (raw === '' || raw === item.value) {
      clear();
      return;
    }
    props.onSet(item.key, raw);
    clear();
  }

  const onKey = (item: PresetItem) => (ev: KeyboardEvent): void => {
    if (ev.key === 'Enter') commit(item);
    if (ev.key === 'Escape') setDraft({});
  };

  /** 一行：名字 + 按 kind 选控件（颜色带色块，数值用 number，字体用文本） */
  const row = (item: PresetItem): JSX.Element => (
    <li class="preset-row">
      <span class="preset-name" title={item.key}>
        {item.name}
      </span>
      <Show when={item.type === 'color'}>
        <input
          class="preset-swatch"
          type="color"
          value={toHex6(valueOf(item))}
          aria-label={`${item.name} ${props.labels.color}`}
          onInput={(ev) => edit(item.key, ev.currentTarget.value.toUpperCase())}
          onChange={(ev) => {
            edit(item.key, ev.currentTarget.value.toUpperCase());
            commit(item);
          }}
        />
      </Show>
      <input
        class="preset-value"
        type={item.type === 'radius' || item.type === 'spacing' ? 'number' : 'text'}
        {...(item.type === 'radius' || item.type === 'spacing' ? { min: '0', step: item.type === 'spacing' ? '0.5' : '1' } : { spellcheck: false })}
        value={valueOf(item)}
        aria-label={`${item.name} ${props.labels[item.type]}`}
        onInput={(ev) => edit(item.key, ev.currentTarget.value)}
        onBlur={() => commit(item)}
        onKeyDown={onKey(item)}
      />
    </li>
  );

  const groupEntries = (): [string, PresetGroup][] => Object.entries(props.groups);

  return (
    <Panel title={props.labels.title} closeLabel={props.labels.close} onClose={props.onClose} floating class="preset-panel">
      <Show
        when={props.items.length > 0 || groupEntries().length > 0}
        fallback={
          <>
            <p class="panel-empty">{props.labels.empty}</p>
            <p class="panel-hint">{props.labels.hint}</p>
          </>
        }
      >
        <For each={GROUPS}>
          {(group) => (
            <Show when={ofType(group.type).length > 0}>
              <h3 class="panel-group">{props.labels[group.key]}</h3>
              <ul class="preset-list">
                <For each={ofType(group.type)}>{(item) => row(item)}</For>
              </ul>
            </Show>
          )}
        </For>

        <Show when={groupEntries().length > 0} fallback={<p class="panel-hint">{props.labels.groupsEmpty}</p>}>
          <h3 class="panel-group">{props.labels.groups}</h3>
          <ul class="preset-group-list">
            <For each={groupEntries()}>
              {([name, group]) => (
                <li class="preset-group">
                  <div class="preset-group-head">
                    <code>{name}</code>
                    <span class="hint">{group.target}</span>
                  </div>
                  <div class="preset-group-props">
                    <For each={Object.entries(group.props)}>
                      {([prop, value]) => (
                        <span class="preset-group-prop">
                          <span class="preset-group-key">{prop}</span>
                          <code>{value}</code>
                        </span>
                      )}
                    </For>
                  </div>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </Show>
    </Panel>
  );
}
