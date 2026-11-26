import { createEffect, createSignal, For, on, onCleanup, onMount, Show } from 'solid-js';
import {
  addMark,
  clearMarks,
  eventsUrl,
  fetchChanges,
  fetchDaemonInfo,
  fetchFiles,
  fetchComponents,
  fetchMarks,
  fetchNode,
  fetchProjectChanges,
  exportUrl,
  fetchNotes,
  fetchPresets,
  fetchProjects,
  setPresetValue,
  registryEventsUrl,
  renderUrl,
  shutdownDaemon,
  unwatchProject,
  type ComponentItem,
  type DaemonInfo,
  type DesignFileMeta,
  type DesignsEvent,
  type Mark,
  type PresetGroup,
  type PresetItem,
  type ProjectInfo,
} from './api';
import { Confirm, Modal } from './confirm';
import { isNewer } from '../../src/shared/version-compare.js';
import { bindViewport, type ViewportBinding } from './frame-viewport';
import { FRAME_STYLE } from './frame-style';
import { changedRemainingMs } from './changed';
import { formatRelative } from './recency';
import { parseViewport } from './viewport';
import {
  CanvasBgSwitch,
  CANVAS_BG_COLORS,
  initialCanvasBackground,
  rememberCanvasBackground,
  type CanvasBackground,
} from './canvas-bg';
import { initialLang, messages, rememberLang, type Lang } from './i18n';
import { NotesDrawer } from './notes-drawer';
import { PresetPanel } from './preset-panel';
import { ComponentGallery } from './component-gallery';
import { ToolRail, type RailItem } from './tool-rail';
import { InspectorPanel } from './inspector-panel';
import { QuickSwitch } from './quick-switch';

interface Board {
  id: string;
  name?: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Crumb {
  id: string;
  type: string;
  name?: string;
}

/**
 * 列表行的「最近编辑」数据：mtime 来自磁盘（持久），changed* 来自 daemon 的写入记录
 * （与画布金边同一个 3 分钟窗口）。两者叠加才既能跨重启、又能区分「还带着金边」。
 */
interface FileMeta {
  mtime: number;
  changedAt?: number;
  changedNodes?: number;
}

/** 项目行：`leaving` 用于退场动画（数据先移除，DOM 多留 220ms） */
interface ProjectRow extends ProjectInfo {
  leaving?: boolean;
}

/** 需要二次确认的破坏性动作（两者都不能手滑就执行） */
type PendingAction = { kind: 'unwatch'; name: string } | { kind: 'shutdown' };

/** 导出倍率的记忆（浏览器级）：只认三档，坏值回落到 1x */
function initialExportScale(): number {
  try {
    const raw = localStorage.getItem('paintress:export-scale');
    const n = raw === null ? 1 : Number(raw);
    return n === 2 || n === 1 || n === 0.5 ? n : 1;
  } catch {
    return 1;
  }
}

function rememberExportScale(scale: number): void {
  try {
    localStorage.setItem('paintress:export-scale', String(scale));
  } catch {
    /* 隐私模式写不进就算了 */
  }
}

/** 关窗倒计时秒数。daemon 侧 emptyBrowserMs 默认 30s 兜底，10s 留足了余量 */
const LEAVE_SECONDS = 10;
/** 倒计时环半径 30 的周长，SVG 进度靠它换算 stroke-dashoffset */
const RING_LEN = 2 * Math.PI * 30;
/**
 * 倒计时为什么关窗：
 * - `idle`：项目全被 agent 收走，daemon 还活着（结束时要顺手把它关掉）；
 * - `closed`：daemon 自己已经在关（空闲退出 / 侧栏「关闭服务器」），别再去打它。
 */
type LeaveReason = 'idle' | 'closed';

/** 从路径里按最长前缀解析项目（项目 key 带 `/`，如 `c-thun/raybend`） */
function projectFromPath(pathname: string, list: readonly ProjectInfo[]): string | null {
  const segs = pathname.split('/').filter((s) => s !== '');
  for (let n = Math.min(3, segs.length); n >= 1; n--) {
    const key = segs.slice(0, n).map((s) => decodeURIComponent(s)).join('/');
    if (list.some((p) => p.name === key)) return key;
  }
  return null;
}

function projectHref(project: string, file: string | null): string {
  const path = `/${project
    .split('/')
    .filter((s) => s !== '')
    .map(encodeURIComponent)
    .join('/')}`;
  return file === null ? path : `${path}?file=${file.split('/').map(encodeURIComponent).join('/')}`;
}

function cssEscape(s: string): string {
  return typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(s) : s.replace(/["\\]/g, '\\$&');
}

export default function App() {
  const [projects, setProjects] = createSignal<ProjectInfo[]>([]);
  /** 侧栏渲染用：含 `leaving` 过渡行的版本（数据源仍是 projects） */
  const [rows, setRows] = createSignal<ProjectRow[]>([]);
  const [activeProject, setActiveProject] = createSignal<string | null>(null);
  const [files, setFiles] = createSignal<string[]>([]);
  /** 每份稿的「最近编辑」数据（key 是相对路径，与 files() 项逐字一致） */
  const [fileMeta, setFileMeta] = createSignal<Record<string, FileMeta>>({});
  /**
   * 相对时间的参考时刻：30 秒一跳。不靠列表刷新才更新，也不在页面隐藏时白烧 CPU；
   * 没有它，「刚刚」会挂到下一次有人动列表为止。
   */
  const [now, setNow] = createSignal(Date.now());
  const [activeFile, setActiveFile] = createSignal<string | null>(null);
  const [fontReport, setFontReport] = createSignal<{ checked: string[]; missing: string[] } | null>(null);
  // 切稿时先清掉上一张稿的字体报告，等新稿的探针回来再显示
  createEffect(on(activeFile, () => setFontReport(null)));
  // 标签页标题跟着「在看什么」走：一堆标签页里能认出哪一个是这张稿
  createEffect(() => {
    const project = activeProject();
    const file = activeFile();
    document.title =
      file !== null ? `${file} · paintress` : project !== null ? `${project} · paintress` : 'paintress · design viewer';
  });
  onMount(() => {
    const onMessage = (ev: MessageEvent): void => {
      const data = ev.data as { type?: unknown; checked?: unknown; missing?: unknown } | null;
      if (data === null || typeof data !== 'object' || data.type !== 'paintress-fonts') return;
      setFontReport({
        checked: Array.isArray(data.checked) ? data.checked.map(String) : [],
        missing: Array.isArray(data.missing) ? data.missing.map(String) : [],
      });
    };
    window.addEventListener('message', onMessage);
    onCleanup(() => window.removeEventListener('message', onMessage));
  });
  const [marks, setMarks] = createSignal<Mark[]>([]);
  const [selectedId, setSelectedId] = createSignal<string | null>(null);
  const [crumbs, setCrumbs] = createSignal<Crumb[]>([]);
  const [error, setError] = createSignal<string | null>(null);
  const [daemonInfo, setDaemonInfo] = createSignal<DaemonInfo>({});
  const [reloadKey, setReloadKey] = createSignal(0);
  const [live, setLive] = createSignal(true);
  const [iframeSrc, setIframeSrc] = createSignal('');
  const [boards, setBoards] = createSignal<Board[]>([]);
  const [activeBoard, setActiveBoard] = createSignal<string | null>(null);
  const [zoom, setZoom] = createSignal(1);
  const [lang, setLang] = createSignal<Lang>(initialLang());
  const [canvasBg, setCanvasBg] = createSignal<CanvasBackground>(initialCanvasBackground());
  const [pending, setPending] = createSignal<PendingAction | null>(null);
  /** 多稿快速切换（Ctrl/Cmd+K） */
  const [switcherOpen, setSwitcherOpen] = createSignal(false);
  /** 单帧导出倍率：只有 2x / 1x / 0.5x 三档（1x = 查看器里的 1:1） */
  const [exportScale, setExportScale] = createSignal<number>(initialExportScale());
  const [closed, setClosed] = createSignal(false);
  /** 笔记抽屉（占布局，画布左侧）与右上浮动面板（预设 / 组件，互斥） */
  const [notesOpen, setNotesOpen] = createSignal(false);
  const [noteExists, setNoteExists] = createSignal(false);
  const [noteMarkdown, setNoteMarkdown] = createSignal<string | null>(null);
  const [noteError, setNoteError] = createSignal<string | null>(null);
  const [panel, setPanel] = createSignal<'presets' | 'components' | 'inspect' | null>(null);
  /** 属性面板：选中节点 → 只读字段（不参与任何写路径） */
  const [inspectorNode, setInspectorNode] = createSignal<Record<string, unknown> | null>(null);
  const [inspectorVars, setInspectorVars] = createSignal<Record<string, string>>({});
  /** 人手动关掉属性面板后，本次会话不再自动弹（选中仍会刷新数据） */
  let inspectorDismissed = false;
  const [presets, setPresets] = createSignal<PresetItem[]>([]);
  const [presetGroups, setPresetGroups] = createSignal<Record<string, PresetGroup>>({});
  const [components, setComponents] = createSignal<ComponentItem[]>([]);
  /** 关窗倒计时（秒）；null = 不显示遮罩 */
  const [countdown, setCountdown] = createSignal<number | null>(null);
  const [leaveReason, setLeaveReason] = createSignal<LeaveReason>('idle');
  /** 倒计时结束仍没关掉：浏览器只允许人自己关「有过浏览历史」的标签，得明说 */
  const [closeBlocked, setCloseBlocked] = createSignal(false);
  /** 本次页面会话是否曾经有过项目：有过的项目全消失才是「agent 收工」，才值得弹倒计时 */
  let sawProjects = false;
  const [showUpdate, setShowUpdate] = createSignal(false);
  const [copied, setCopied] = createSignal(false);
  const m = (): ReturnType<typeof messages> => messages(lang());
  const railItems = (): RailItem[] => [
    { id: 'inspect', label: m().inspector, icon: 'inspect' },
    { id: 'presets', label: m().presets, icon: 'preset' },
    { id: 'components', label: m().components, icon: 'component' },
  ];

  let frameEl: HTMLIFrameElement | undefined;
  let stageEl: HTMLElement | undefined;
  let boardBarEl: HTMLDivElement | undefined;
  let viewportCtl: ViewportBinding | null = null;
  let persistTimer: ReturnType<typeof setTimeout> | undefined;

  /** frame 名超出固定宽度时打标记：右侧 10px 渐隐（不用省略号，渐隐还能看出后面还有字） */
  function markOverflow(el: HTMLElement): void {
    el.classList.toggle('overflow', el.scrollWidth > el.clientWidth + 1);
  }

  function syncUrl(): void {
    const p = activeProject();
    const f = activeFile();
    // 项目 key 本身就带 `/`（c-thun/raybend），地址直接写成路径，不用 ?project= 转义
    history.replaceState(null, '', p === null ? '/' : projectHref(p, f));
  }

  // ---------- 数据加载 ----------
  /**
   * 项目列表 → 侧栏行。新增的行带入场动画；消失的行先标 `leaving`，
   * 220ms 后才真正从 DOM 抽掉。视觉上「项目被 agent 接入 / 收工」自己会说话，
   * 人不需要去点刷新或猜现在绑没绑。
   */
  let leaveTimer: ReturnType<typeof setTimeout> | undefined;
  function applyProjects(next: ProjectInfo[]): void {
    const prev = rows();
    const prevByName = new Map(prev.map((r) => [r.name, r]));
    const nextKeys = new Set(next.map((p) => p.name));
    const merged: ProjectRow[] = [];
    for (const p of next) {
      const old = prevByName.get(p.name);
      // 引用相同 → <For> 认为这一行没变，不会重建 DOM，也不会重播入场动画
      const unchanged =
        old !== undefined &&
        old.leaving !== true &&
        old.fileCount === p.fileCount &&
        old.agentConns === p.agentConns &&
        old.depth === p.depth &&
        old.label === p.label &&
        old.root === p.root;
      merged.push(unchanged ? old : { ...p });
    }
    let hasLeaving = false;
    for (const old of prev) {
      if (old.leaving === true) {
        if (!nextKeys.has(old.name)) {
          merged.push(old);
          hasLeaving = true;
        }
        continue;
      }
      if (!nextKeys.has(old.name)) {
        merged.push({ ...old, leaving: true });
        hasLeaving = true;
      }
    }
    // 新出现的行排在最前（合并列表时已按 next 顺序在前；`leaving` 行追加在尾）
    setRows(merged);
    if (hasLeaving) {
      clearTimeout(leaveTimer);
      leaveTimer = setTimeout(() => setRows((list) => list.filter((r) => r.leaving !== true)), 240);
    }
    if (next.length > 0) sawProjects = true;
  }

  async function loadProjects(): Promise<void> {
    try {
      const res = await fetchProjects();
      setProjects(res.projects);
      applyProjects(res.projects);
      setDaemonInfo({ pid: res.pid, version: res.version, latest: res.latest ?? null, connections: res.connections });
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  /** 后台刷新版本与连接数；本地 daemon 暂时不可达时保持现状，不弹错误 */
  async function refreshDaemonInfo(): Promise<void> {
    try {
      const res = await fetchDaemonInfo();
      setDaemonInfo({ pid: res.pid, version: res.version, latest: res.latest ?? null, connections: res.connections });
    } catch {
      /* 轮询必须静默：npm 或 daemon 暂时不可达都不打扰查看 */
    }
  }

  async function loadMarks(project: string): Promise<void> {
    try {
      setMarks((await fetchMarks(project)).marks);
    } catch {
      setMarks([]);
    }
  }

  /**
   * 文件列表回来：把 mtime 写进标识数据。
   * 项目已经切走就丢掉这个响应（慢请求不能改写别人的列表）。
   */
  function applyFileStats(project: string, meta: Record<string, DesignFileMeta> | undefined): void {
    if (meta === undefined || activeProject() !== project) return;
    setFileMeta((prev) => {
      const next: Record<string, FileMeta> = {};
      for (const [path, stat] of Object.entries(meta)) {
        const old = prev[path];
        next[path] = old === undefined ? { mtime: stat.mtime } : { ...old, mtime: stat.mtime };
      }
      return next;
    });
  }

  /** 项目级写入记录：金点的初始状态，此后靠 designs 事件增量更新 */
  async function loadProjectChanges(project: string): Promise<void> {
    try {
      const res = await fetchProjectChanges(project);
      if (activeProject() !== project) return;
      setFileMeta((prev) => {
        const next: Record<string, FileMeta> = { ...prev };
        for (const change of res.changes) {
          const old = next[change.file] ?? { mtime: 0 };
          next[change.file] = { ...old, changedAt: change.at, changedNodes: change.ids.length };
        }
        return next;
      });
    } catch {
      /* 拉不到就只显示 mtime：标识是增益信息，不拿它挡人看稿 */
    }
  }

  /** designs 事件：单份稿的时间戳 / 写入记录 / 撤销，一次 patch 一行 */
  function applyDesignsEvent(ev: DesignsEvent): void {
    if (activeProject() !== ev.project) return;
    setFileMeta((prev) => {
      const old = prev[ev.path];
      if (ev.cleared === true) {
        if (old === undefined || old.changedAt === undefined) return prev;
        return { ...prev, [ev.path]: { mtime: old.mtime } };
      }
      const next: FileMeta = old === undefined ? { mtime: 0 } : { ...old };
      if (ev.mtime !== undefined) next.mtime = ev.mtime;
      if (ev.ids !== undefined) {
        next.changedAt = ev.at;
        next.changedNodes = ev.ids.length;
      }
      return { ...prev, [ev.path]: next };
    });
  }

  /**
   * 一行的「最近编辑」状态：fresh = 还带着金边（与画布同一个 TTL），
   * 否则只给 mtime 的相对时间（超过 24 小时就不画文字，悬停仍有绝对时间）。
   */
  function rowMeta(file: string): { fresh: boolean; label: string; title: string } | null {
    const meta = fileMeta()[file];
    if (meta === undefined) return null;
    const t = now();
    const fresh = meta.changedAt !== undefined && changedRemainingMs(meta.changedAt, t) > 0;
    const at = fresh ? (meta.changedAt ?? 0) : meta.mtime;
    if (at <= 0) return null;
    return {
      fresh,
      label: formatRelative(at, t, lang()) ?? '',
      title: m().recentEditTitle(new Date(at).toLocaleString(), fresh ? meta.changedNodes : undefined),
    };
  }

  async function openProject(name: string): Promise<void> {
    setActiveProject(name);
    setActiveFile(null);
    setSelectedId(null);
    setCrumbs([]);
    setFileMeta({});
    try {
      const res = await fetchFiles(name);
      setFiles(res.files);
      applyFileStats(name, res.meta);
      setError(null);
    } catch (cause) {
      setFiles([]);
      setError(cause instanceof Error ? cause.message : String(cause));
    }
    void loadMarks(name);
    void loadProjectChanges(name);
    syncUrl();
  }

  /**
   * 注册表变了（别的窗口 watch/unwatch、或项目目录里新增了设计稿）：
   * 重拉项目与文件列表，不靠用户按 F5。
   */
  async function refreshRegistry(): Promise<void> {
    await loadProjects();
    const p = activeProject();
    if (p === null) return;
    if (!projects().some((x) => x.name === p)) {
      // 当前项目被 unwatch 掉了
      setActiveProject(null);
      setActiveFile(null);
      setFiles([]);
      setFileMeta({});
      setSelectedId(null);
      setCrumbs([]);
      syncUrl();
      return;
    }
    try {
      const res = await fetchFiles(p);
      const prev = files();
      setFiles(res.files);
      applyFileStats(p, res.meta);
      // 新文件到达：若尚未选中任何设计稿，自动选中新出现的第一个，省一次手点
      const f = activeFile();
      if (f === null) {
        const fresh = res.files.filter((x) => !prev.includes(x));
        if (fresh.length > 0 && projects().some((x) => x.name === p)) openFile(fresh[0] as string);
      } else if (!res.files.includes(f)) {
        // 当前文件被删了
        setActiveFile(null);
        setSelectedId(null);
        setCrumbs([]);
        syncUrl();
      }
    } catch {
      /* 拉不到就保持现状，下一轮事件再试 */
    }
    void loadMarks(p);
    void loadProjectChanges(p);
  }

  function openFile(file: string): void {
    setActiveFile(file);
    setSelectedId(null);
    setCrumbs([]);
    // 笔记属于上一份设计稿：换文件就收起抽屉（图标会按新文件重新出现）
    setNotesOpen(false);
    syncUrl();
  }

  // ---------- 设计稿笔记 / 项目预设 / 组件库 ----------
  async function loadNotes(project: string, file: string): Promise<void> {
    try {
      const res = await fetchNotes(project, file);
      setNoteExists(res.exists);
      setNoteMarkdown(res.markdown ?? null);
      setNoteError(null);
      if (!res.exists) setNotesOpen(false);
    } catch (cause) {
      setNoteExists(false);
      setNoteMarkdown(null);
      setNoteError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function loadPresets(project: string): Promise<void> {
    try {
      const res = await fetchPresets(project);
      setPresets(res.items);
      setPresetGroups(res.groups ?? {});
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function loadComponents(project: string): Promise<void> {
    try {
      setComponents((await fetchComponents(project)).items);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  /** 改一条预设：服务端写回后立即重渲染画布（SSE 也会推，双保险） */
  async function applyPreset(key: string, value: string): Promise<void> {
    const p = activeProject();
    if (p === null) return;
    try {
      const res = await setPresetValue(p, key, value);
      setPresets(res.items);
      setPresetGroups(res.groups ?? {});
      setReloadKey((n) => n + 1);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      void loadPresets(p);
    }
  }

  function togglePanel(id: string): void {
    const closing = panel() === id;
    const next = closing ? null : id;
    setPanel(next as 'presets' | 'components' | 'inspect' | null);
    // 属性面板被手动关掉：本次会话不再因为选中而自动弹回来
    if (id === 'inspect' && closing) inspectorDismissed = true;
    const p = activeProject();
    if (p === null) return;
    if (next === 'presets') void loadPresets(p);
    if (next === 'components') void loadComponents(p);
  }

  /** 取一个节点的只读属性；选中已经换人时丢弃这次结果 */
  async function loadInspector(project: string, file: string, id: string): Promise<void> {
    try {
      const res = await fetchNode(project, file, id);
      if (selectedId() !== id) return;
      setInspectorNode(res.node);
      setInspectorVars(res.vars);
      if (!inspectorDismissed && panel() === null) setPanel('inspect');
    } catch (cause) {
      if (selectedId() !== id) return;
      setInspectorNode(null);
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  // 选中变化 → 拉一次属性；清空选中 → 收起面板（规则见 specs/viewer-inspector.md）
  createEffect(
    on(selectedId, (id) => {
      const project = activeProject();
      const file = activeFile();
      if (id === null || project === null || file === null) {
        setInspectorNode(null);
        if (panel() === 'inspect') setPanel(null);
        return;
      }
      void loadInspector(project, file, id);
    }),
  );

  // ---------- 版本升级提示 ----------
  /** 有更新的版本时返回新版号，否则 null（离线 / 未探测 / 已是最新都返回 null） */
  function updateAvailable(): string | null {
    const latest = daemonInfo().latest ?? null;
    const current = daemonInfo().version ?? null;
    if (latest === null || current === null) return null;
    return isNewer(latest, current) ? latest : null;
  }

  async function copyPrompt(): Promise<void> {
    try {
      await navigator.clipboard.writeText(m().updatePrompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* 剪贴板不可用（非安全上下文）：文本仍可手动选中复制 */
    }
  }

  // ---------- 破坏性动作：解绑项目 / 关闭 web 进程 ----------
  function askUnwatch(name: string): void {
    setPending({ kind: 'unwatch', name });
  }

  function askShutdown(): void {
    setPending({ kind: 'shutdown' });
    // attach/SSE 的数量变化不推注册表事件，打开确认框时重新取一次准确值
    void refreshDaemonInfo();
  }

  function pendingCopy(): { title: string; body: string; confirm: string } {
    const action = pending();
    if (action === null) return { title: '', body: '', confirm: '' };
    if (action.kind === 'unwatch') {
      return { title: m().unwatchTitle, body: m().unwatchBody(action.name), confirm: m().unwatch };
    }
    return {
      title: m().closeServerTitle,
      body: m().closeServerBody(daemonInfo().pid ?? 0, daemonInfo().connections ?? 0),
      confirm: m().closeServer,
    };
  }

  async function runPending(): Promise<void> {
    const action = pending();
    setPending(null);
    if (action === null) return;
    try {
      if (action.kind === 'unwatch') {
        await unwatchProject(action.name);
        await refreshRegistry();
      } else {
        // 人点了「关闭服务器」：进程立刻停，倒计时只负责把窗口收掉
        await shutdownDaemon();
        startLeave('closed');
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  onMount(() => {
    // 注册表通道：项目增删 / 目录里新增设计稿 → 列表自动更新（不需要 F5）。
    // 事件里已经带全量项目信息，所以能同一帧把行加/删掉，不必再等一次接口往返。
    const registrySource = new EventSource(registryEventsUrl());
    registrySource.addEventListener('projects', (ev) => {
      const data = (ev as MessageEvent<string>).data;
      let next: ProjectInfo[] | null = null;
      try {
        const parsed = JSON.parse(data) as { projects?: ProjectInfo[] };
        if (Array.isArray(parsed.projects)) next = parsed.projects;
      } catch {
        /* 旧 daemon 只带数量：退回拉一次接口 */
      }
      if (next !== null) {
        setProjects(next);
        applyProjects(next);
        const p = activeProject();
        if (p !== null && !next.some((x) => x.name === p)) {
          // 当前项目已被 agent 收走：退回总页，不在一个死项目上停留
          setActiveProject(null);
          setActiveFile(null);
          setFiles([]);
          setSelectedId(null);
          setCrumbs([]);
          syncUrl();
        } else {
          void refreshRegistry();
        }
      } else {
        void refreshRegistry();
      }
    });
    // daemon 要关了（空闲退出 / agent 侧收尾）：不必等它断线，直接进关窗倒计时
    registrySource.addEventListener('shutdown', () => startLeave('closed'));
    // 单份稿的时间戳 / 写入记录：只 patch 那一行，不重拉列表（旧 daemon 不会发这个事件）
    registrySource.addEventListener('designs', (ev) => {
      try {
        applyDesignsEvent(JSON.parse((ev as MessageEvent<string>).data) as DesignsEvent);
      } catch {
        /* 坏载荷直接忽略：标识只是增益，不值得报错 */
      }
    });
    onCleanup(() => registrySource.close());

    // 首次 /api/projects 只启动后台 npm 探测并返回旧值；4s 后再取才能看到结果。
    // 后续轻量轮询让缓存过期后的新版本也能出现，不反复扫描项目目录。
    const versionRetry = setTimeout(() => {
      if (!closed()) void refreshDaemonInfo();
    }, 4000);
    const versionPoll = setInterval(() => {
      if (!closed()) void refreshDaemonInfo();
    }, 60_000);
    // 相对时间自己走：页面隐藏时不醒，回来立刻补一次，不在后台空跑
    const nowTimer = setInterval(() => {
      if (!document.hidden) setNow(Date.now());
    }, 30_000);
    const onVisible = (): void => {
      if (!document.hidden) setNow(Date.now());
    };
    document.addEventListener('visibilitychange', onVisible);
    onCleanup(() => {
      clearInterval(nowTimer);
      document.removeEventListener('visibilitychange', onVisible);
    });
    onCleanup(() => {
      clearTimeout(versionRetry);
      clearInterval(versionPoll);
    });

    // 焦点在父页面时也要能：空格临时平移、Ctrl+0/Shift+1 视口快捷键
    const isTyping = (ev: KeyboardEvent): boolean => {
      const el = ev.target as HTMLElement | null;
      return el?.tagName === 'INPUT' || el?.tagName === 'TEXTAREA' || el?.isContentEditable === true;
    };
    const onKey = (ev: KeyboardEvent): void => {
      if (isTyping(ev)) return;
      // Ctrl/Cmd+K：快速切换设计稿（输入框里不拦，见 specs/viewer-file-switcher.md）
      if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'k') {
        if (activeProject() !== null && files().length > 0) {
          ev.preventDefault();
          setSwitcherOpen(true);
        }
        return;
      }
      if (ev.key === 'Escape') {
        if (panel() !== null) {
          setPanel(null);
          ev.preventDefault();
          return;
        }
        if (notesOpen()) {
          setNotesOpen(false);
          ev.preventDefault();
          return;
        }
      }
      if (ev.key === ' ' && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
        viewportCtl?.setSpace(true);
        ev.preventDefault();
        return;
      }
      if (viewportCtl?.handleKey(ev) === true) ev.preventDefault();
    };
    const onKeyUp = (ev: KeyboardEvent): void => {
      if (ev.key === ' ') viewportCtl?.setSpace(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
    onCleanup(() => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKeyUp);
    });

    // frame 列表：滚轮直接横向滚。frame 一多，底下那条细滚动条根本不好抓，
    // 而滚轮是手上已有的动作，不需要额外学。
    const onBoardWheel = (ev: WheelEvent): void => {
      const bar = boardBarEl;
      if (bar === undefined) return;
      const target = ev.target as Node | null;
      if (target === null || !bar.contains(target)) return;
      const delta = ev.deltaY !== 0 ? ev.deltaY : ev.deltaX;
      if (delta === 0) return;
      const max = bar.scrollWidth - bar.clientWidth;
      if (max <= 0) return;
      ev.preventDefault();
      bar.scrollLeft = Math.max(0, Math.min(max, bar.scrollLeft + delta));
    };
    window.addEventListener('wheel', onBoardWheel, { passive: false });
    onCleanup(() => window.removeEventListener('wheel', onBoardWheel));

    const params = new URLSearchParams(location.search);
    void (async () => {
      await loadProjects();
      // 新地址：项目写在路径里（`/c-thun/raybend?file=design/editor.pen`）
      // 旧地址：`?project=c-thun-raybend&file=...` 仍然兼容，读进来后回写成新形式
      const fromPath = projectFromPath(location.pathname, projects());
      const legacy = params.get('project');
      const p = fromPath ?? (legacy !== null && projects().some((x) => x.name === legacy) ? legacy : null);
      if (p !== null) {
        await openProject(p);
        const f = params.get('file');
        // 走 openFile 而不是直接 setActiveFile：后者不会回写 URL，
        // 刷新后 file 参数会丢（深链只剩 project）
        if (f) openFile(f);
        else syncUrl();
      }
    })();
  });

  // ---------- 全收工 → 10s 倒计时关窗（人不需要自己去关页面/杀进程）----------
  let tickTimer: ReturnType<typeof setInterval> | undefined;
  /** 关窗后的「关不掉」探测（页面已被关掉的话这个定时器根本不会跑） */
  let blockedTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => {
    clearInterval(tickTimer);
    clearTimeout(blockedTimer);
  });

  function stopCountdown(): void {
    clearInterval(tickTimer);
    tickTimer = undefined;
    setCountdown(null);
  }

  /** 撤销整个「要走了」状态（倒计时 + 已关闭 + 关不掉提示），页面继续可用 */
  function stopLeave(): void {
    stopCountdown();
    clearTimeout(blockedTimer);
    setClosed(false);
    setCloseBlocked(false);
  }

  /**
   * 收工了：10s 后关窗。三个入口共用（项目归零 / daemon shutdown / 手动关服务器）。
   * 已在倒计时时只允许 `idle → closed` 升级，**不重置秒数**——
   * shutdown 事件经常紧跟项目归零，重置会让人看着一个跳回 10 的倒计时。
   * 已经走完（closed）就不再重开：唯一回去的路是 agent 重新接入（`stopLeave`）。
   */
  function startLeave(reason: LeaveReason): void {
    if (closed()) return;
    if (countdown() !== null) {
      if (reason === 'closed') setLeaveReason('closed');
      return;
    }
    setLeaveReason(reason);
    setCloseBlocked(false);
    setCountdown(LEAVE_SECONDS);
    clearInterval(tickTimer);
    tickTimer = setInterval(() => {
      const left = (countdown() ?? 0) - 1;
      if (left <= 0) {
        void finishLeave();
        return;
      }
      setCountdown(left);
    }, 1000);
  }

  /**
   * 倒计时归零：尽力把窗口关掉。
   * Chromium 允许脚本关闭 **只有一条历史** 的标签（daemon 用宿主浏览器打开的就是这种），
   * 所以正常路径下人什么都不用点；只有标签被导航过（history ≥ 2）时才关不掉——
   * 那就把卡片停在说明态，并在 600ms 后把文案换成「浏览器拒绝了自动关闭」。
   */
  async function finishLeave(): Promise<void> {
    const reason = leaveReason();
    stopCountdown();
    if (reason === 'idle') {
      try {
        await shutdownDaemon();
      } catch {
        /* 已经不可达也算目的达成 */
      }
    }
    setClosed(true);
    window.close(); // 关掉了就不会往下走（定时器随文档一起消失）
    blockedTimer = setTimeout(() => {
      if (closed()) setCloseBlocked(true);
    }, 600);
  }

  createEffect(
    on(
      () => projects().length,
      (n) => {
        // 有项目（或被 attach 重新拉进来）→ 撤销倒计时，页面继续用
        if (n > 0) {
          if (countdown() !== null || closed()) stopLeave();
          return;
        }
        // 从没进过项目就不弹（刚手动起 daemon、等 agent 接入的那几秒不该被吓一跳）
        if (!sawProjects) return;
        startLeave('idle');
      },
    ),
  );

  // ---------- iframe 内交互（同源访问，无需 allow-scripts）----------
  const frameDoc = (): Document | null => frameEl?.contentDocument ?? null;

  function ensureFrameStyle(): void {
    const doc = frameDoc();
    if (!doc) return;
    if (doc.getElementById('ptr-style')) return;
    const style = doc.createElement('style');
    style.id = 'ptr-style';
    style.textContent = FRAME_STYLE;
    doc.head.appendChild(style);
  }

  function applyHighlight(): void {
    const doc = frameDoc();
    if (!doc) return;
    for (const el of doc.querySelectorAll('[data-ptr-selected]')) el.removeAttribute('data-ptr-selected');
    const id = selectedId();
    if (!id) return;
    doc.querySelector(`[data-node-id="${cssEscape(id)}"]`)?.setAttribute('data-ptr-selected', '');
  }

  /// 上一层：最近的带 data-node-id 的祖先
  function parentNodeElement(el: Element): HTMLElement | null {
    return (el.parentElement?.closest('[data-node-id]') as HTMLElement | null) ?? null;
  }

  /// 下一层：第一个带 data-node-id 的子元素
  function firstChildNodeElement(el: Element): HTMLElement | null {
    return el.querySelector<HTMLElement>(':scope > [data-node-id]');
  }

  function onFrameClick(ev: MouseEvent): void {
    // 拖拽画布结束后紧跟的 click 不能当成选中
    if (viewportCtl?.consumeDragClick() === true) {
      ev.preventDefault();
      ev.stopPropagation();
      return;
    }
    const target = ev.target as Element | null;
    const hit = target?.closest('[data-node-id]');
    if (!hit) {
      // 点空白 = 取消选中（属性面板随之收起）
      setSelectedId(null);
      setCrumbs([]);
      applyHighlight();
      return;
    }
    ev.preventDefault();
    ev.stopPropagation();
    // Alt+点击：选上一层（已在顶层时选自己）
    const chosen = ev.altKey ? (parentNodeElement(hit) ?? (hit as HTMLElement)) : (hit as HTMLElement);
    void selectNode(chosen);
  }

  /// Alt+滚轮：在祖先链上上/下一级（纯导航，不产生标记）
  function stepLevel(direction: 1 | -1, point: { x: number; y: number }): void {
    const doc = frameDoc();
    if (!doc) return;
    const currentId = selectedId();
    const current =
      currentId === null ? null : doc.querySelector<HTMLElement>(`[data-node-id="${cssEscape(currentId)}"]`);
    if (current === null) {
      // 未选中：先选光标下的最深节点
      const hit = doc.elementFromPoint(point.x, point.y)?.closest('[data-node-id]') as HTMLElement | null;
      const id = hit?.dataset['nodeId'];
      if (id !== undefined) focusNodeById(id);
      return;
    }
    const next = direction === 1 ? parentNodeElement(current) : firstChildNodeElement(current);
    const nextId = next?.dataset['nodeId'];
    if (nextId !== undefined) focusNodeById(nextId);
  }

  function onFrameMove(ev: MouseEvent): void {
    const doc = frameDoc();
    if (!doc) return;
    for (const el of doc.querySelectorAll('[data-ptr-hover]')) el.removeAttribute('data-ptr-hover');
    const hit = (ev.target as Element | null)?.closest('[data-node-id]');
    hit?.setAttribute('data-ptr-hover', '');
  }

  /**
   * 金边高亮的保底：最后一次写入后最多再亮 3 分钟（与 daemon 的 TTL 一致）。
   * 只靠“文件一改就重画”的话，人停在页面上会看到永远在呼吸的金边，看不清实际效果。
   */
  let changedTimer: ReturnType<typeof setTimeout> | undefined;

  function clearChangedMarks(): void {
    if (changedTimer !== undefined) {
      clearTimeout(changedTimer);
      changedTimer = undefined;
    }
    const doc = frameDoc();
    if (!doc) return;
    for (const el of doc.querySelectorAll('[data-ptr-changed]')) el.removeAttribute('data-ptr-changed');
  }

  function scheduleChangedExpiry(delayMs: number): void {
    if (changedTimer !== undefined) clearTimeout(changedTimer);
    changedTimer = setTimeout(() => clearChangedMarks(), delayMs);
  }

  async function applyChanges(): Promise<void> {
    // 先收掉上一份的定时器：切到没有变更的稿子时，旧计时器不该继续活着
    clearChangedMarks();
    const p = activeProject();
    const f = activeFile();
    if (!p || !f) return;
    try {
      const res = await fetchChanges(p, f);
      // 过期由 daemon 的 TTL 判定（/api/changes 过期即返回空），前端不再叠加第二套阈值
      if (!res.ok || res.ids.length === 0) return;
      const remaining = changedRemainingMs(res.at);
      if (remaining === 0) return;
      const doc = frameDoc();
      if (!doc) return;
      for (const id of res.ids) {
        doc.querySelector(`[data-node-id="${cssEscape(id)}"]`)?.setAttribute('data-ptr-changed', '');
      }
      // 从最后写入起算，不是从本次打开页面起算：开了 2 分钟的变更只剩 1 分钟可亮
      scheduleChangedExpiry(remaining);
    } catch {
      /* 高亮尽力而为 */
    }
  }

  /**
   * 画板列表：优先用浏览器量出来的真实几何。
   *
   * 自动排版的设计稿（Pencil 里 frame 高度由内容撑开）在文件里根本没有 height，
   * `data-board-*` 会报 0；只有量真实盒子才知道这一页多高，否则「跳到某页」会框到空气。
   */
  function readBoards(): Board[] {
    const doc = frameDoc();
    if (!doc) return [];
    const canvas = doc.querySelector<HTMLElement>('.ptr-canvas');
    const cr = canvas?.getBoundingClientRect();
    const z = viewportCtl?.get().z ?? 1;
    return Array.from(doc.querySelectorAll<HTMLElement>('[data-board]')).map((el) => {
      const d = el.dataset;
      const r = cr === undefined ? null : el.getBoundingClientRect();
      const measured = r !== null && z > 0
        ? { x: (r.left - cr!.left) / z, y: (r.top - cr!.top) / z, w: r.width / z, h: r.height / z }
        : null;
      return {
        id: d['nodeId'] ?? '',
        ...(d['boardName'] === undefined ? {} : { name: d['boardName'] }),
        x: measured?.x ?? Number(d['boardX'] ?? 0),
        y: measured?.y ?? Number(d['boardY'] ?? 0),
        w: measured !== null && measured.w > 0 ? measured.w : Number(d['boardW'] ?? 0),
        h: measured !== null && measured.h > 0 ? measured.h : Number(d['boardH'] ?? 0),
      };
    });
  }

  /// 视口持久化键：按「项目 + 文件」（specs §2.1）
  function viewportKey(): string | null {
    const p = activeProject();
    const f = activeFile();
    return p && f ? `paintress:viewport:${p}/${f}` : null;
  }

  function persistViewport(vp: { z: number; tx: number; ty: number }): void {
    const key = viewportKey();
    if (key === null) return;
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      try {
        localStorage.setItem(key, JSON.stringify(vp));
      } catch {
        /* 存储不可用时忽略 */
      }
    }, 300);
  }

  function bindFrame(): void {
    const doc = frameDoc();
    if (!doc) return;
    frameReady = true;
    ensureFrameStyle();
    applyCanvasBg();
    viewportCtl?.destroy();
    viewportCtl = bindViewport({
      doc,
      onChange: (vp) => {
        setZoom(vp.z);
        persistViewport(vp);
      },
      onLevelStep: stepLevel,
      onQuickSwitch: () => setSwitcherOpen(true),
    });
    const next = readBoards();
    setBoards(next);
    // 单画板文件没有「全部」这一态（它和唯一的画板是同一块区域）：直接选中它，导出控件才始终有目标
    setActiveBoard(next.length === 1 ? (next[0]?.id ?? null) : null);
    restoreViewport();
    doc.addEventListener('click', onFrameClick, true);
    doc.addEventListener('mousemove', onFrameMove, true);
    applyHighlight();
    void applyChanges();
  }

  /// 有持久化则恢复，否则适配整画布
  function restoreViewport(): void {
    if (!viewportCtl) return;
    const key = viewportKey();
    const stored = key === null ? null : localStorage.getItem(key);
    const parsed = stored === null ? null : parseViewport(stored);
    if (parsed !== null) viewportCtl.set(parsed);
    else viewportCtl.fitAll();
  }

  /// 导出目标：选中的画板；只有一个画板时它自己就是目标（画板条上没有「全部」可点）
  function exportBoardId(): string | null {
    const selected = activeBoard();
    if (selected !== null) return selected;
    const all = boards();
    return all.length === 1 ? (all[0]?.id ?? null) : null;
  }

  /** 单帧导出：走浏览器原生下载（Content-Disposition），不把 PNG 读进内存 */
  function downloadFrame(): void {
    const project = activeProject();
    const file = activeFile();
    const board = exportBoardId();
    if (project === null || file === null || board === null) return;
    window.location.href = exportUrl(project, file, board, exportScale());
  }

  function focusBoard(id: string | null): void {
    setActiveBoard(id);
    if (!viewportCtl) return;
    if (id === null) {
      viewportCtl.fitAll();
      return;
    }
    const b = boards().find((x) => x.id === id);
    if (b) viewportCtl.focusBox({ x: b.x, y: b.y, w: b.w, h: b.h });
  }

  /// 祖先链（面包屑）：从命中元素逐层向上
  function chainOf(el: Element): Crumb[] {
    const chain: Crumb[] = [];
    let cur: Element | null = el;
    while (cur) {
      const nodeEl: Element | null = cur.closest('[data-node-id]');
      if (!nodeEl) break;
      const h = nodeEl as HTMLElement;
      chain.unshift({ id: h.dataset['nodeId'] ?? '', type: h.dataset['nodeType'] ?? '?', name: h.dataset['nodeName'] });
      cur = nodeEl.parentElement;
    }
    return chain;
  }

  async function selectNode(el: HTMLElement): Promise<void> {
    const nodeId = el.dataset['nodeId'] ?? '';
    if (nodeId === '') return;

    const chain = chainOf(el);

    setSelectedId(nodeId);
    setCrumbs(chain);
    applyHighlight();

    const project = activeProject();
    if (!project) return;
    try {
      const file = activeFile();
      await addMark({
        project,
        nodeId,
        ...(file !== null ? { file } : {}),
        ...(el.dataset['nodeName'] !== undefined ? { name: el.dataset['nodeName'] } : {}),
        ...(el.dataset['nodeType'] !== undefined ? { type: el.dataset['nodeType'] } : {}),
        path: chain.map((c) => c.name ?? c.type).join(' / '),
      });
      setMarks((await fetchMarks(project)).marks);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  function focusNodeById(id: string): void {
    setSelectedId(id);
    applyHighlight();
    const doc = frameDoc();
    const el = doc?.querySelector<HTMLElement>(`[data-node-id="${cssEscape(id)}"]`);
    if (!el || !doc) {
      setCrumbs([]);
      return;
    }
    // 面包屑跟着选中走（点击标记 / Alt+滚轮切换层级都走这里）
    setCrumbs(chainOf(el));
    const canvas = doc.querySelector<HTMLElement>('.ptr-canvas');
    if (!canvas || !viewportCtl) {
      el.scrollIntoView({ block: 'center' });
      return;
    }
    // 两个 rect 同受 transform 影响，差值再除 z 即为画布坐标
    const r = el.getBoundingClientRect();
    const c = canvas.getBoundingClientRect();
    const z = viewportCtl.get().z;
    viewportCtl.centerOn({
      x: (r.left - c.left) / z,
      y: (r.top - c.top) / z,
      w: r.width / z,
      h: r.height / z,
    });
  }

  async function clearAllMarks(): Promise<void> {
    const project = activeProject();
    if (!project) return;
    try {
      await clearMarks(project);
      setMarks([]);
      setSelectedId(null);
      setCrumbs([]);
      applyHighlight();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  // ---------- 界面语言与画布背景（均写入 localStorage；语言默认跟浏览器）----------
  createEffect(() => {
    const value = lang();
    document.documentElement.lang = value === 'zh' ? 'zh-CN' : 'en';
    rememberLang(value);
  });

  /// 画布背景：只改舞台与 iframe 文档底色，不动界面其它区域
  function applyCanvasBg(): void {
    if (stageEl === undefined) return;
    // 没有打开设计稿时不接管舞台底色（保持界面本来的米白）
    if (activeFile() === null) {
      stageEl.style.removeProperty('--canvas-bg');
      stageEl.removeAttribute('data-canvas-bg');
    } else {
      const color = CANVAS_BG_COLORS[canvasBg()];
      stageEl.style.setProperty('--canvas-bg', color);
      stageEl.setAttribute('data-canvas-bg', canvasBg());
    }
    frameDoc()?.documentElement.style.setProperty('--ptr-canvas-bg', CANVAS_BG_COLORS[canvasBg()]);
  }

  createEffect(() => {
    canvasBg();
    rememberCanvasBackground(canvasBg());
    applyCanvasBg();
  });

  // ---------- 预览地址与热重载 ----------
  /**
   * iframe 首次用 src 属性装载；之后换稿 / 重渲染一律走 location.replace。
   * 改 src 会给标签新增一条浏览历史，而「单历史」正是页面能自己关窗的前提（D-009）——
   * 换一次稿就把自动关窗弄坏，代价太大。
   */
  let frameReady = false;
  function navigateFrame(url: string): void {
    if (url === '' || !frameReady) {
      setIframeSrc(url);
      if (url === '') frameReady = false;
      return;
    }
    const win = frameEl?.contentWindow;
    if (win === null || win === undefined) {
      setIframeSrc(url);
      return;
    }
    try {
      win.location.replace(url);
    } catch {
      setIframeSrc(url);
    }
  }

  createEffect(
    on([activeProject, activeFile, reloadKey], () => {
      const p = activeProject();
      const f = activeFile();
      navigateFrame(p !== null && f !== null ? `${renderUrl(p, f)}&r=${reloadKey()}` : '');
      applyCanvasBg();
    }),
  );

  // 换文件：笔记跟着换（图标按新文件有无决定显隐）
  createEffect(
    on([activeProject, activeFile], () => {
      setNoteExists(false);
      setNoteMarkdown(null);
      setNoteError(null);
      const p = activeProject();
      const f = activeFile();
      if (p !== null && f !== null) void loadNotes(p, f);
    }),
  );

  let source: EventSource | null = null;
  createEffect(
    on([activeProject, activeFile, live], () => {
      source?.close();
      source = null;
      const p = activeProject();
      const f = activeFile();
      if (!live() || !p || !f) return;
      source = new EventSource(eventsUrl(p, f));
      source.addEventListener('change', () => {
        setReloadKey((n) => n + 1);
        // 同一条 SSE 也监听同名笔记与项目预设：改任何一个都要跟上
        void loadNotes(p, f);
        if (panel() === 'presets') void loadPresets(p);
        if (panel() === 'components') void loadComponents(p);
        // 文件被 agent 改了：属性面板要跟着刷新（选中没变，数据变了）
        const selected = selectedId();
        if (panel() === 'inspect' && selected !== null) void loadInspector(p, f, selected);
      });
      // agent 明确说「编辑完了」：不重渲染、不刷新，只把金边撤掉，让人直接看最终效果
      source.addEventListener('changes-cleared', () => clearChangedMarks());
    }),
  );
  onCleanup(() => source?.close());
  // 切稿/切项目时 iframe 会重建，金边本来就没了；把定时器一并收掉
  onCleanup(() => clearChangedMarks());

  return (
    <div class="app">
      <aside class="sidebar">
        <header class="sidebar-head">
          <img class="brand-mark" src="/logo.svg" alt="" />
          <h1>paintress</h1>
          <Show when={daemonInfo().version}>
            <Show
              when={updateAvailable()}
              fallback={<span class="badge" title={m().versionTitle}>v{daemonInfo().version}</span>}
            >
              <button class="badge badge-stack" title={m().updateTitle} onClick={() => setShowUpdate(true)}>
                <span>v{daemonInfo().version}</span>
                <span class="badge-new">v{updateAvailable()}</span>
              </button>
            </Show>
          </Show>
          <Show when={fontReport()}>
            {(report) => (
              <span
                class="badge"
                classList={{ 'badge-warn': report().missing.length > 0 }}
                title={
                  report().missing.length > 0 ? m().fontMissing(report().missing.join('、')) : m().fontTitle(report().checked.length)
                }
              >
                {m().fontBadge(report().checked.length - report().missing.length, report().checked.length)}
              </span>
            )}
          </Show>
        </header>

        <section class="section">
          <h2>{m().projects}</h2>
          {/* 用 rows 而不是 projects：项目被收走时数据先空、DOM 还要留 240ms 播退场动画 */}
          <Show
            when={rows().length > 0}
            fallback={
              <p class="empty">
                {m().waitingForAgent}
                <br />
                <code>paintress watch &lt;name&gt; &lt;dir&gt;</code>
              </p>
            }
          >
            <ul class="list">
              <For each={rows()}>
                {(p) => (
                  <li class="row" classList={{ leaving: p.leaving === true }}>
                    <button class="item" classList={{ active: activeProject() === p.name }} onClick={() => void openProject(p.name)}>
                      <span class="item-name">{p.label ?? p.name}</span>
                      <span class="item-meta">
                        {m().projectFiles(p.fileCount)}
                        {p.agentConns > 0 ? <span class="dot" title={m().agentOnline} /> : null}
                      </span>
                    </button>
                    <button class="row-action" title={m().unwatch} aria-label={`${m().unwatch} ${p.name}`} onClick={() => askUnwatch(p.name)}>
                      ×
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </section>

        <Show when={activeProject()}>
          <section class="section files">
            <h2>
              {m().designs}{' '}
              <span class="hint">
                {m().depth} {projects().find((p) => p.name === activeProject())?.depth ?? '-'}
              </span>
            </h2>
            <Show when={files().length > 0} fallback={<p class="empty">{m().noFiles}</p>}>
              <ul class="list">
                <For each={files()}>
                  {(f) => {
                    const info = (): ReturnType<typeof rowMeta> => rowMeta(f);
                    return (
                      <li>
                        <button
                          class="item"
                          classList={{ active: activeFile() === f }}
                          title={info()?.title}
                          onClick={() => openFile(f)}
                        >
                          <span class="item-row">
                            <span class="item-name">{f}</span>
                            <Show when={info()?.fresh === true}>
                              <span class="dot fresh" aria-hidden="true" />
                            </Show>
                            <Show when={info()?.label}>
                              {(label) => (
                                <span class="item-time" classList={{ fresh: info()?.fresh === true }}>
                                  {label()}
                                </span>
                              )}
                            </Show>
                          </span>
                        </button>
                      </li>
                    );
                  }}
                </For>
              </ul>
            </Show>
          </section>
        </Show>

        <Show when={marks().length > 0}>
          <section class="section marks">
            <h2>
              {m().marks}
              <button class="ghost tiny" onClick={() => void clearAllMarks()}>
                {m().clear}
              </button>
            </h2>
            <ul class="list">
              <For each={marks()}>
                {(m) => (
                  <li>
                    <button
                      class="item"
                      classList={{ active: selectedId() === m.nodeId }}
                      onClick={() => {
                        // 标记记了文件：跨文件点击先切稿，避免在错误的画布上找 id
                        if (m.file !== undefined && m.file !== activeFile()) {
                          openFile(m.file);
                          return;
                        }
                        focusNodeById(m.nodeId);
                      }}
                    >
                      <span class="item-name">
                        <b class="mark-no">#{m.shortId}</b> {m.name ?? m.nodeId}
                      </span>
                      <span class="item-meta">
                        {m.file !== undefined && m.file !== activeFile() ? `${m.file} · ` : ''}
                        {m.path}
                      </span>
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </section>
        </Show>

        <footer class="sidebar-foot">
          <label class="toggle">
            <input type="checkbox" checked={live()} onChange={(e) => setLive(e.currentTarget.checked)} />
            {m().liveReload}
          </label>
          <button class="ghost" onClick={() => void loadProjects()}>
            {m().refreshList}
          </button>
          <button class="ghost" onClick={() => askShutdown()}>
            {m().closeServer}
          </button>
          <Show when={daemonInfo().pid}>
            <span class="hint">pid {daemonInfo().pid}</span>
          </Show>
        </footer>
      </aside>

      <main class="stage" ref={(el) => { stageEl = el; }}>
        <Show when={error()}>
          <div class="error">{error()}</div>
        </Show>
        <div class="toolbar">
          <div class="crumbs">
            <Show when={crumbs().length === 0} fallback={
              <For each={crumbs()}>
                {(c, i) => (
                  <>
                    <Show when={i() > 0}>
                      <span class="sep">/</span>
                    </Show>
                    <button class="crumb" classList={{ active: selectedId() === c.id }} onClick={() => focusNodeById(c.id)}>
                      {c.name ?? c.type}
                    </button>
                  </>
                )}
              </For>
            }>
              <Show when={activeProject() !== null && activeFile() !== null}>
                <code>{projects().find((p) => p.name === activeProject())?.label ?? activeProject()}</code>
                <span class="sep">/</span>
                <code>{activeFile()}</code>
              </Show>
            </Show>
          </div>
          <div class="tools">
            <Show when={activeProject() !== null && activeFile() !== null}>
              <button
                class="ghost tiny qs-trigger"
                title={`${m().quickSwitch}（Ctrl/Cmd+K）`}
                onClick={() => setSwitcherOpen(true)}
              >
                {m().quickSwitch}
              </button>
              <span class="hint zoom">{Math.round(zoom() * 100)}%</span>
              <button class="ghost tiny" title={m().fitTitle} onClick={() => viewportCtl?.fitAll()}>
                {m().fit}
              </button>
              <button class="ghost tiny" title={m().actualSizeTitle} onClick={() => viewportCtl?.zoomToPercent(1)}>
                {m().actualSize}
              </button>
              <button class="ghost" onClick={() => setReloadKey((n) => n + 1)}>
                {m().rerender}
              </button>
              <span class="tool-sep" />
            </Show>
            <CanvasBgSwitch value={canvasBg()} onChange={setCanvasBg} label={m().canvasBackground} />
            <div class="lang-switch" role="group" aria-label={m().language} title={m().language}>
              <button class="lang-opt" classList={{ active: lang() === 'zh' }} onClick={() => setLang('zh')} aria-pressed={lang() === 'zh'}>
                中
              </button>
              <button class="lang-opt" classList={{ active: lang() === 'en' }} onClick={() => setLang('en')} aria-pressed={lang() === 'en'}>
                EN
              </button>
            </div>
          </div>
        </div>
        <Show
          when={activeProject() !== null && activeFile() !== null}
          fallback={
            <div class="placeholder">
              <Show when={activeProject()} fallback={<p>{m().pickProject}</p>}>
                <p>{m().pickFile}</p>
              </Show>
            </div>
          }
        >
          <Show when={boards().length > 0}>
            <div class="boardbar">
              {/*
                「全部」不参与滚动：横向翻到后面几个画板时，回看整张画布仍然是一次点击。
                只有一个画板时不出现 —— 它就是整张画布，多一个按钮只是噪音；
                画板条本身要留着，导出倍率与按钮挂在它上面，不能被单画板文件吞掉。
              */}
              <Show when={boards().length > 1}>
                <button class="board board-all" classList={{ active: activeBoard() === null }} onClick={() => focusBoard(null)}>
                  {m().allBoards}
                </button>
              </Show>
              <div
                class="boardbar-scroll"
                ref={(el) => {
                  boardBarEl = el;
                }}
              >
                <For each={boards()}>
                {(b) => (
                  <button class="board" classList={{ active: activeBoard() === b.id }} onClick={() => focusBoard(b.id)}>
                    <span
                      class="board-name"
                      ref={(el) => queueMicrotask(() => markOverflow(el))}
                    >
                      {b.name ?? `#${b.id}`}
                    </span>
                    <span class="board-size">
                      {Math.round(b.w)}×{Math.round(b.h)}
                    </span>
                  </button>
                )}
                </For>
              </div>
              <Show when={exportBoardId() !== null}>
                <div class="boardbar-export">
                  <span class="hint">{m().exportScale}</span>
                  <select
                    class="ghost tiny export-scale"
                    aria-label={m().exportScale}
                    value={String(exportScale())}
                    onChange={(ev) => {
                      const next = Number(ev.currentTarget.value);
                      setExportScale(next);
                      rememberExportScale(next);
                    }}
                  >
                    <option value="0.5">0.5x</option>
                    <option value="1">1x</option>
                    <option value="2">2x</option>
                  </select>
                  <button class="ghost tiny" onClick={() => downloadFrame()}>
                    {m().exportFrame}
                  </button>
                </div>
              </Show>
            </div>
          </Show>
          <div class="canvas-row">
            <Show when={notesOpen()}>
              <NotesDrawer
                title={m().notesTitle}
                closeLabel={m().closePanel}
                markdown={noteMarkdown()}
                error={noteError()}
                onClose={() => setNotesOpen(false)}
              />
            </Show>
            <div class="canvas-wrap">
              <iframe
                ref={(el) => {
                  frameEl = el;
                }}
                class="preview"
                title="design preview"
                sandbox="allow-same-origin allow-scripts"
                src={iframeSrc()}
                onLoad={bindFrame}
              />
              <Show when={noteExists() && !notesOpen()}>
                <button class="notes-toggle" title={m().notesTitle} onClick={() => setNotesOpen(true)}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
                    <path d="M14 3v5h5" />
                    <path d="M9 13h6M9 17h4" />
                  </svg>
                  {m().notes}
                </button>
              </Show>
              <ToolRail items={railItems()} active={panel()} onToggle={togglePanel} label={m().canvasTools} />
              <Show when={panel() === 'presets'}>
                <PresetPanel
                  items={presets()}
                  groups={presetGroups()}
                  labels={{
                    title: m().presets,
                    close: m().closePanel,
                    empty: m().presetEmpty,
                    hint: m().presetHint,
                    color: m().presetColor,
                    radius: m().presetRadius,
                    spacing: m().presetSpacing,
                    fontSize: m().presetFontSize,
                    font: m().presetFont,
                    groups: m().presetGroups,
                    groupsEmpty: m().presetGroupsEmpty,
                  }}
                  onClose={() => setPanel(null)}
                  onSet={(key, value) => void applyPreset(key, value)}
                />
              </Show>
              <Show when={panel() === 'inspect'}>
                <InspectorPanel
                  node={inspectorNode()}
                  vars={inspectorVars()}
                  labels={{
                    title: m().inspector,
                    close: m().closePanel,
                    empty: m().inspectorEmpty,
                    groups: m().inspectorGroups,
                    descendants: m().inspectorDescendants,
                  }}
                  onClose={() => {
                    inspectorDismissed = true;
                    setPanel(null);
                  }}
                />
              </Show>
              <Show when={panel() === 'components'}>
                <ComponentGallery
                  items={components()}
                  project={activeProject() ?? ''}
                  labels={{
                    title: m().components,
                    close: m().closePanel,
                    empty: m().componentsEmpty,
                    hint: m().componentsHint,
                    count: m().componentsCount,
                  }}
                  onClose={() => setPanel(null)}
                />
              </Show>
            </div>
          </div>
        </Show>
      </main>

      <QuickSwitch
        open={switcherOpen()}
        files={files()}
        current={activeFile()}
        labels={{
          title: m().quickSwitch,
          placeholder: m().quickSwitchPlaceholder,
          empty: m().quickSwitchEmpty,
          hint: m().quickSwitchHint,
        }}
        onPick={(file) => {
          setSwitcherOpen(false);
          openFile(file);
        }}
        onClose={() => setSwitcherOpen(false)}
      />

      <Confirm
        open={pending() !== null}
        title={pendingCopy().title}
        body={pendingCopy().body}
        confirmLabel={pendingCopy().confirm}
        cancelLabel={m().cancel}
        onConfirm={() => void runPending()}
        onCancel={() => setPending(null)}
      />

      {/* 关窗没成功（标签有浏览历史）：停在说明态，别让人对着 0 秒发呆 */}
      <Show when={closed()}>
        <div class="modal-backdrop countdown-backdrop">
          <div class="modal countdown closed" role="status">
            <h3>{m().serverClosed}</h3>
            <p class="modal-body">{closeBlocked() ? m().closeBlockedHint : m().serverClosedHint}</p>
          </div>
        </div>
      </Show>

      {/* 收工倒计时：项目全收走 / 服务关闭 → 10s 后自己关窗（agent 重新接入会自动撤销） */}
      <Show when={countdown() !== null && !closed()}>
        <div class="modal-backdrop countdown-backdrop">
          <div
            class="modal countdown"
            classList={{ urgent: (countdown() ?? 0) <= 3 }}
            role="status"
            aria-labelledby="countdown-title"
          >
            <div class="countdown-ring" aria-hidden="true">
              <svg viewBox="0 0 68 68">
                <circle class="countdown-ring-track" cx="34" cy="34" r="30" />
                <circle
                  class="countdown-ring-fill"
                  cx="34"
                  cy="34"
                  r="30"
                  style={{
                    'stroke-dashoffset': (RING_LEN * (1 - (countdown() ?? 0) / LEAVE_SECONDS)).toFixed(1),
                  }}
                />
              </svg>
              <span class="countdown-num">{countdown() ?? 0}</span>
            </div>
            <h3 id="countdown-title">{leaveReason() === 'closed' ? m().serverClosed : m().noActiveProjects}</h3>
            <p class="modal-body">{leaveReason() === 'closed' ? m().closingAuto : m().closingWaitAgent}</p>
            {/* 秒数只在环里出现一次；读屏靠这句播报 */}
            <p class="sr-only" aria-live="polite">
              {m().closingIn(countdown() ?? 0)}
            </p>
          </div>
        </div>
      </Show>

      <Modal
        open={showUpdate()}
        title={m().updateTitle}
        onClose={() => setShowUpdate(false)}
        actions={
          <>
            <a class="ghost" href="https://github.com/aliciai-dev/paintress" target="_blank" rel="noreferrer">
              {m().updateRepo}
            </a>
            <button class="ghost" onClick={() => setShowUpdate(false)}>
              {m().close}
            </button>
          </>
        }
      >
        <p class="modal-body">
          {m().updateAvailable(updateAvailable() ?? '', daemonInfo().version ?? '')}
        </p>
        <pre class="prompt">{m().updatePrompt}</pre>
        <button class="ghost tiny" onClick={() => void copyPrompt()}>
          {copied() ? m().copied : m().copy}
        </button>
        <p class="modal-body">{m().updateSteps}</p>
      </Modal>
    </div>
  );
}
