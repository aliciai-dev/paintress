import { createEffect, createMemo, createSignal, For, Show, type JSX } from 'solid-js';
import { Modal } from './confirm';

/**
 * 多稿快速切换（编辑器式的「快速打开」）：
 * 输入过滤 → ↑↓ 选中 → Enter 打开 → Esc 关闭。
 *
 * 壳复用 `Modal`（遮罩/Esc/焦点一致），这里只加搜索框与结果列表。
 * 打开动作由调用方执行（`openFile`），本组件不碰 URL —— 查看器的路由只用 replaceState，
 * 不能在这里新增浏览历史，否则自动关窗就会失效（见 specs/viewer-autoclose.md）。
 */

export interface QuickSwitchLabels {
  title: string;
  placeholder: string;
  empty: string;
  hint: string;
}

export interface QuickSwitchProps {
  open: boolean;
  files: string[];
  current: string | null;
  labels: QuickSwitchLabels;
  onPick: (file: string) => void;
  onClose: () => void;
}

/** 文件名与目录拆开：列表里目录用小字，命中「设计稿」本身更显眼 */
function splitFile(file: string): { dir: string; name: string } {
  const i = file.lastIndexOf('/');
  return i < 0 ? { dir: '', name: file } : { dir: file.slice(0, i + 1), name: file.slice(i + 1) };
}

export function QuickSwitch(props: QuickSwitchProps): JSX.Element {
  const [query, setQuery] = createSignal('');
  const [active, setActive] = createSignal(0);
  let inputEl: HTMLInputElement | undefined;
  let listEl: HTMLUListElement | undefined;

  const hits = createMemo(() => {
    const q = query().trim().toLowerCase();
    const all = props.files;
    if (q === '') return all;
    return all.filter((f) => f.toLowerCase().includes(q));
  });

  // 每次打开都从「当前文件」起跳，而不是继承上一次的搜索词
  createEffect(() => {
    if (!props.open) return;
    setQuery('');
    const idx = props.current === null ? 0 : Math.max(0, props.files.indexOf(props.current));
    setActive(idx);
    queueMicrotask(() => inputEl?.select());
  });

  // 选中行滚进视野（上下键走到列表外面时）
  createEffect(() => {
    active();
    queueMicrotask(() => listEl?.querySelector<HTMLElement>('.qs-item.active')?.scrollIntoView({ block: 'nearest' }));
  });

  function pick(file: string | undefined): void {
    if (file === undefined) return;
    props.onPick(file);
  }

  function onKeyDown(ev: KeyboardEvent): void {
    const list = hits();
    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      setActive((i) => (list.length === 0 ? 0 : (i + 1) % list.length));
      return;
    }
    if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      setActive((i) => (list.length === 0 ? 0 : (i - 1 + list.length) % list.length));
      return;
    }
    if (ev.key === 'Enter') {
      // 输入法组合中的 Enter 是确认候选词，不是「打开」
      if ((ev as KeyboardEvent).isComposing) return;
      ev.preventDefault();
      pick(list[active()]);
    }
  }

  return (
    <Modal
      open={props.open}
      title={props.labels.title}
      onClose={props.onClose}
      initialFocus={() => inputEl}
      class="quick-switch-modal"
    >
      {/* 键盘处理放在容器上：Tab 到结果按钮后，↑↓ / Enter 仍然可用 */}
      <div class="qs-body" onKeyDown={onKeyDown}>
        <input
          class="qs-input"
          ref={(el) => {
            inputEl = el;
          }}
          type="text"
          value={query()}
          placeholder={props.labels.placeholder}
          onInput={(ev) => {
            setQuery(ev.currentTarget.value);
            setActive(0);
          }}
          aria-label={props.labels.placeholder}
        />
        <Show
          when={hits().length > 0}
          fallback={<p class="qs-empty">{props.labels.empty}</p>}
        >
          <ul class="qs-list" ref={(el) => { listEl = el; }}>
            <For each={hits()}>
              {(file, i) => {
                const parts = splitFile(file);
                return (
                  <li>
                    <button
                      type="button"
                      class="qs-item"
                      classList={{ active: i() === active(), current: file === props.current }}
                      onMouseEnter={() => setActive(i())}
                      onClick={() => pick(file)}
                    >
                      <Show when={parts.dir !== ''}>
                        <span class="qs-dir">{parts.dir}</span>
                      </Show>
                      <span class="qs-name">{parts.name}</span>
                    </button>
                  </li>
                );
              }}
            </For>
          </ul>
        </Show>
        <p class="qs-hint">{props.labels.hint}</p>
      </div>
    </Modal>
  );
}
