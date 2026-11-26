# SPEC: 查看器设计稿「最近编辑」标识

## Context

侧栏 Designs 列表只有文件名。改动过的节点有金边，但「哪几份稿被改过」这个信息只存在于文件内部：项目里三十份稿、AI 刚动了其中五份，人只能逐份点开看有没有金边。

三个信号各缺一环，谁都不能单独用：

| 信号 | 已有 | 缺 |
| --- | --- | --- |
| `ChangesStore`（`src/web/changes.ts`） | project + file + ids + 时间戳 | 只有单文件查询 `/api/changes?project&path`，被金边独占；TTL 3 分钟；daemon 重启即失；只覆盖 MCP 写路径（CLI 写盘不发通知） |
| 文件 `mtime` | `listDesignFiles` 遍历时本来就 `statSync` 每个条目判断目录与扩展名 | 被丢弃，没送到前端 |
| 目录监听 | 覆盖 `add` / `unlink` / `unlinkDir` | 不订阅 `change`：改一份已有的稿，其它窗口一无所知 |

所以缺的不是记录，是把记录送到列表上的那条通路。

## Goal

打开项目，Designs 列表直接告诉人哪几份稿刚被改过、多久之前改的——不点开任何文件，也不刷新页面。金点的含义与金边完全一致：点开它，就能在画布上看到金边。

## Scope

做：

- 列表行的最近编辑标识：金色点 + 灰色相对时间，中英文文案。
- 列表在不刷新页面的情况下跟随文件变化更新。
- 支撑这两件事的服务端数据（mtime、项目级变更查询、`designs` 事件）及对应测试。

不做：

- 不排序、不筛选——列表位置必须稳定。
- 项目行不加最近改动时间：`Registry.info()` 会给每个项目扫一遍目录，先不扩这层开销。
- 不落盘编辑流水账（`.paintress/changes.json`）：跨重启保留「AI 改过」的代价是往项目目录写状态文件，不值；重启后靠 mtime 兜底。
- 不给 CLI 写路径补变更通知：`paintress update` 等直接写盘，不产生金点/金边，mtime 会体现。作为已知缺口记着，不在这轮改。
- QuickSwitch、项目总页 HTML、截图路径都不动。

## Decisions

- **D1 两级标识**（operator 2026-11-26）：金点 = 未过期的变更记录（与金边同一个 3 分钟窗口）；灰色相对时间 = mtime 在 24 小时内。金点精确但短命且只覆盖 MCP 写；mtime 持久、跨重启、覆盖 CLI 与编辑器，但分不清是谁写的。两者互补。
- **D2 时间窗口 24 小时**（operator 2026-11-26）：超出不显示文字，悬停仍给完整本地时间。隔天还能查到，又不会把二十行全填满固定噪音。
- **D3 不动列表顺序**（operator 2026-11-26）：不做最近优先、不做筛选开关。先看标识够不够用。
- **D4 金点复用 `CHANGE_TTL_MS`**：不新增保留期状态、不落盘。`clear_changes` 撤金边时金点同时消失，从而保证「点下有金边」这句话永远成立。
- **D5 文案中性**：只写「3 小时前」，不写「AI 改的」。`git checkout` / `cp -r` 会批量刷新 mtime，归因必然是假的。

## Approach

**服务端三处小改，全部向后兼容。**

`listDesignFiles` 遍历时已经 `statSync` 过每个条目，mtime 是免费信息：新增 `listDesignFilesWithStat` 带出 `{ path, mtimeMs, size }`，原函数改为它的投影，既有调用方（`fileCount`、MCP 的 `designFilesOf`）零改动。

`/api/projects/<name>/files` 只追加 `meta` 字段，`files: string[]` 原样保留。旧前端不认识 `meta` 无害；新前端连旧 daemon 拿不到 `meta` 就不显示标识——与仓库里 `label` 缺省回退 `name` 的写法同一条降级路线。

`ChangesStore` 加一个 `list(project)`（只返回未过期的，按 `at` 倒序），`/api/changes` 增加「不带 `path`」的项目级分支；带 `path` 的单文件语义原样不动。

**推送：给注册表通道加一个 `designs` 事件。**

`watchDesigns` 订阅 `change`，回调签名扩展为 `(file, kind: 'add' | 'change' | 'unlink')`。daemon 只在 `kind === 'change'` 时发一条 `designs`，**不走** `scheduleRegistryNotify`——那条路会给每个项目重扫目录，每次 AI 写都全量扫一遍不值。`add` / `unlink` / `unlinkDir` 继续走既有的 `projects` 事件全量刷新。

同一个事件名承载三处触发，前端只需要写一次 patch 逻辑：

| 触发点 | 载荷 | 前端动作 |
| --- | --- | --- |
| 目录 `change` | `mtime` | patch `mtime` |
| `changes.record`（MCP 写完） | `at` + `ids` | patch `changedAt` / `changedNodes` |
| `clear-changes` | `cleared: true` | 清 `changedAt`，金点消失 |

**前端：两个 signal，一段行内结构。**

`fileMeta` 存 `Record<path, { mtime, changedAt?, changedNodes? }>`：打开项目时由 `files.meta` 加上一次 `fetchProjectChanges` 填满，此后只靠 `designs` 事件 patch，不重拉列表、不重扫目录。

`now` 是 30 秒 tick 的 signal，`document.hidden` 时暂停、`visibilitychange` 回来立刻补一次——相对时间不会「刚刚」挂一小时。

金点的存活判定直接复用 `ui/src/changed.ts` 的 `changedRemainingMs(changedAt, now)`，不再写第二份 TTL 逻辑；行内的相对时间走新的 `formatRelative`。两者都吃同一个 `now`。

行结构改为 `.item-row`（名称在左、时间在右）；长路径继续省略号，时间列 `flex: 0 0 auto` 不被挤压。金点复用现有 `.dot` 的形状，加 `.dot.fresh` 变体换成 `--gold`（`#908030`，与金边同色），不做呼吸动画——列表不该跟着呼吸。

## Data & contracts

`GET /api/projects/<name>/files`（追加字段，`meta` 的 key 与 `files` 项逐字一致）：

```jsonc
{
  "ok": true,
  "project": "c-thun/raybend",
  "depth": 3,
  "files": ["a.ptr", "sub/b.pen"],
  "meta": {
    "a.ptr": { "mtime": 1763000000000 },
    "sub/b.pen": { "mtime": 1762990000000 }
  }
}
```

`GET /api/changes?project=<name>`（不带 `path` 时的新语义）：

```jsonc
{ "ok": true, "changes": [{ "file": "a.ptr", "at": 1763000000123, "ids": ["n1", "n2"] }] }
```

SSE 注册表通道（`/events` 无 project 参数）新增事件：

```sse
event: designs
data: {"project":"c-thun/raybend","path":"a.ptr","at":1763000000123,"mtime":1763000000100}
data: {"project":"c-thun/raybend","path":"a.ptr","at":1763000000123,"ids":["n1","n2"]}
data: {"project":"c-thun/raybend","path":"a.ptr","cleared":true}
```

三个载荷字段集互补（`mtime` / `ids` / `cleared`），`project` 必须有：这条通道是所有项目共用的，前端只对 `activeProject()` 的载荷动手。

## Files

| 文件 | 职责 |
| --- | --- |
| `src/web/registry.ts` | 新增 `listDesignFilesWithStat`；`listDesignFiles` 改为投影 |
| `src/web/changes.ts` | `ChangesStore.list(project)`，未过期、按 `at` 倒序 |
| `src/web/watcher.ts` | `watchDesigns` 订阅 `change`，回调带 `kind` |
| `src/web/daemon.ts` | `/files` 追加 `meta`；`/api/changes` 项目级分支；`designs` 事件三处广播 |
| `ui/src/api.ts` | `meta?` 字段、`fetchProjectChanges`、事件载荷类型 |
| `ui/src/recency.ts` | 新文件：`formatRelative(at, now, lang)` 纯函数 |
| `ui/src/App.tsx` | `fileMeta` / `now` signal、`designs` 监听、行结构 |
| `ui/src/styles.css` | `.item-row`、`.item-time`、`.dot.fresh` |
| `ui/src/i18n.ts` | `justNow` / `minutesAgo(n)` / `hoursAgo(n)` / `recentEditTitle(time, nodes?)` |
| `test/web.spec.ts` | `/files` 的 `meta` 与 mtime 变化 |
| `test/changes.spec.ts` | 项目级列表、TTL 过期、清空 |
| `test/watcher.spec.ts` | 已存在文件被改触发 `change`（带 kind） |
| `test/ui-state.spec.ts` | `formatRelative` 边界 |
| `test/ui-interaction.spec.ts` | 真浏览器：出点、撤点、不刷新 |

## Milestones

**M1 数据通路**：mtime 外出 + 项目级变更查询。验收：`/files` 返回 `meta.mtime`；`/api/changes?project` 一次列全未过期记录；`files` 字段与旧响应逐字相同。

**M2 变更推送**：目录 `change` 事件 + `designs` SSE。验收：写一份没人打开的稿，注册表通道收到 `designs`；`add` / `unlink` 仍只走 `projects` 事件（不额外触发目录重扫）。

**M3 列表标识**：前端两级标识、时钟、i18n、CSS。验收：金点与金边同生同灭；24 小时内显示相对时间，超出不显示；中英文案正确。

**M4 真浏览器回归**：把 M1–M3 串起来跑一遍。验收：写稿后不刷新即出现金点；`clear-changes` 后点消失、时间文字留下；`touch` 老文件把它顶到「刚刚」。

## Verification

- `pnpm check`：根与 `ui/` 两侧类型检查 0 错误。
- `pnpm test`：新增用例并入现有 30+ 文件；`formatRelative` 覆盖 59s / 60s / 23h / 25h / 未来时间；Watcher 用例断言 `change` 的 kind；`changes` 用例断言 TTL 过期后不返回。
- `pnpm build`：`tsdown` + `ui` 构建通过（`ui-interaction` 依赖构建产物）。
- 手工：`paintress web` 开项目，让 agent 改其中一份 → 不刷新出现金点；`clear-changes` → 金点消失；`touch` 一份老文件 → 顶到「刚刚」；杀掉 daemon 重开 → 金点没了，时间仍在。

## Risks

- **git 切分支 / 批量还原**会让一批文件显示「刚刚」。缓解：中性文案 + 24 小时窗口把影响限制在时间信息上，不产生错误归因。
- **一次性批量建稿**（脚手架、demo）全场「刚刚」。这是真实状态，不算误报，但要在验收时接受它。
- **推送频率上升**：`change` 接入后，每次 AI 写都会经注册表通道。缓解：daemon 侧 150ms 合并、前端只 patch 单条、不引入 HTTP 往返。

## Open questions

无。D1–D5 已由 operator 定下；实现细节（字段名、CSS 类名）不需要再决策，评审时改字即可。
