# 2026-11-26T19:13+08:00 — Mark recently edited designs in the viewer sidebar

按规格 `specs/viewer-recent-edits.md` 实现侧栏设计稿的「最近编辑」标识（operator 四条决策：两级标识 / 24 小时窗口 / 不动顺序 / 规格先落盘）。

## 服务端

- `src/web/registry.ts`：新增 `DesignFileStat` + `listDesignFilesWithStat`——遍历时本来就 `statSync` 每个条目判目录与扩展名，mtime 顺手带出，不额外付 IO；`listDesignFiles` 改为投影，`fileCount`、MCP 的 `designFilesOf` 零改动。
- `src/web/daemon.ts` `/api/projects/<name>/files` 追加 `meta: { "<rel>": { mtime } }`，`files: string[]` 逐字保留（旧前端无害、新前端连旧 daemon 就不画标识）。
- `src/web/changes.ts` 新增 `ChangesStore.list(project)`（未过期、`at` 倒序）；`/api/changes` 增加不带 `path` 的项目级分支，缺 `project` 回 400。
- `src/web/watcher.ts` `watchDesigns` 订阅 `change`，回调改为 `(file, kind: 'add' | 'change' | 'unlink')`。
- `src/web/daemon.ts` 新增注册表 SSE 事件 `designs`（载荷类型落在 `src/shared/api-types.ts`，前后端共用一份）：目录 `change` 只推这一份稿的 mtime，走单独通路不触发 `scheduleRegistryNotify` 的全量目录重扫；`changes.record` 推 ids；`clear-changes` 推 `cleared: true`（整项目撤销时逐份发）。

## 前端

- `ui/src/recency.ts`（新）：`formatRelative(at, now, lang)` + `RECENT_WINDOW_MS`，边界取 `>=`（正好 24 小时即不显示），未来时间按「刚刚」。
- `ui/src/api.ts`：`FilesResponse.meta?`、`ProjectChangesResponse`、`fetchProjectChanges`。
- `ui/src/App.tsx`：`fileMeta` / `now` 两个 signal；打开项目由 `files.meta` + 项目级 changes 一次填满，此后只靠 `designs` 事件 patch 单条；`now` 30 秒一跳、`document.hidden` 时暂停、`visibilitychange` 回来立刻补；金点存活判定复用 `changedRemainingMs`（与金边同一个 3 分钟窗口），行内时间走 `formatRelative`。
- `ui/src/styles.css`：`.item-row`（flex，长路径继续省略号、时间列 `flex: 0 0 auto`）、`.item-time`、`.dot.fresh`（`--gold`，不做呼吸动画）。
- `ui/src/i18n.ts`：`justNow` / `minutesAgo` / `hoursAgo` / `recentEditTitle`，中英各一套。

## 顺手修的既有 lint

`src/web/daemon.ts` 里 6 处 `x !== undefined ? a : b` 形式的既有写法被工具链判为 blocker，按纯条件倒置改写（语义不变，同一文件内，行号在本次改动之外）。

## 证据

- `pnpm check` + `ui` 侧 `tsc --noEmit`：0 错误。
- `pnpm test`：34 文件 470 用例全绿（新增：`formatRelative` 边界、`ChangesStore.list`、项目级 changes、`designs` 事件两条、watcher `change`+kind、`/files` 的 meta 与 mtime 前进、真浏览器列表标识用例）。
- `pnpm build`：tsdown + ui 构建通过。
- 可视检查：临时项目三份稿（一份两天前）截图确认——活跃行金点 + 金色「just now」、长文件名正常省略、两天前那份不显示时间；截图用的临时用例已删除。
