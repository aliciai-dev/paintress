# 2026-11-26T18:54+08:00 — Spec the viewer's recently-edited marker for the Designs list

规划「Designs 列表一眼可见哪份稿刚被改」这一个工作单元，产出规格 `specs/viewer-recent-edits.md` 并在 `specs/PLAN.md` 登记 R1–R4。

## 关键结论（operator 2026-11-26 四条决策）

1. 两级标识：金色点 = 变更记录未过期（与金边同 TTL 3 分钟）；灰色相对时间 = mtime 在 24 小时内。
2. 时间窗口 24 小时，超出不显示文字，悬停给完整时间。
3. 不改列表顺序（不做最近优先、不做筛选开关），只加标识。
4. 规格先落盘再开工。

## 现状勘察（为什么要两级）

- `src/web/changes.ts` 的 `ChangesStore` 已经记着 project+file+ids，但只有单文件查询（`/api/changes?project&path`），
  且被金边独占；TTL 3 分钟、daemon 重启即失、只覆盖 MCP 写路径（CLI 写盘不发通知）。
- `src/web/registry.ts` 的 `listDesignFiles` 为了判断目录/扩展名，本来就对每个条目 `statSync`，mtime 是免费信息，只是丢弃了。
- `src/web/watcher.ts` 的 `watchDesigns` 只订阅 add/unlink/unlinkDir，改一份已有的稿不会推任何东西给其它窗口。

## 方案骨架

- `/api/projects/<name>/files` 追加 `meta: { "<rel>": { mtime } }`，`files: string[]` 不动（旧前端/旧 daemon 双向兼容）。
- `ChangesStore.list(project)` + `GET /api/changes?project=<name>`（不带 path）。
- `watchDesigns` 订阅 `change` 并带 `kind`；daemon 新增注册表 SSE 事件 `designs`（change / 记录变更 / 清除变更三处触发），
  change 不走 `scheduleRegistryNotify`，避免每次写都全项目重扫目录。
- 前端：`ui/src/recency.ts` 纯函数 + `fileMeta`/`now` 两个 signal + 行内 `.item-row`（名称省略号不影响时间列）；
  QuickSwitch 不动。

## 已明确的边界

不排序不筛选；项目行不加时间；不落盘编辑流水账；不给 CLI 写路径补变更通知（记作已知缺口）。

## 证据

- 只读勘察：`ui/src/App.tsx`（Designs 段 1227–1246）、`src/web/daemon.ts`（`/files` 767–776、注册表 SSE 1114–1130）、
  `src/web/changes.ts`、`src/web/registry.ts`、`src/web/watcher.ts`、`ui/src/styles.css`（`.item*` / `.dot`）、`ui/src/i18n.ts`。
- 全仓确认 `/files` 端点只有 `ui/src/api.ts` 一个消费者，追加字段不会波及别处。
