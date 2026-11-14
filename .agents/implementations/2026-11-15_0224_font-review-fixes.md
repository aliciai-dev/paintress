# 2026-11-15T02:24+08:00 — Font stack order, viewer font reports, CLI wiring, pen→ptr conversion

第一轮字体实现里有三个真实缺陷：

1. `stackWithPreviews` 先把整份真字体排完再排替代，导致「A 的替代」排在「B 的真字体」之后；
   同时把带空格的 family 加引号后再判 generic，导致 `system-ui` 被误判成普通 family 并重复追加 `sans-serif`。
2. 查看器徽章虽然监听了 postMessage，但探针结果没有写回 daemon，`paintress_font list` 看不到加载状态。
3. CLI 缺 `component add`、`preset seed`、`font`、`render --embed-fonts` 四个新动作的接线。

## 改了什么

- `stackWithPreviews`：替代紧跟它替代的真字体；generic 判断改用拆栈前的原文本，不再误判。
- 查看器探针把结果 POST 回 `/api/fonts`，daemon 存进内存 `FontReportStore`；`paintress_font list` 现在返回每个 family 的 loaded/missing 与来自哪张稿。
- CLI 补齐 `component add`、`preset seed`、`font list/add/remove/default`、`render --embed-fonts`。
- `fontRegistryOf` 兼容老字段 `url`/`path`（`target` 优先）。
- 新增 `paintress_convert`（MCP + CLI）：读 `.pen`、校验、写 `.ptr`（新 fileToken + x-paintress 元数据），默认不覆盖、不删源文件。
- `get` 的字体缺口提示现在会给出项目里已有的 font token key。

## 证据

- `test/fonts.spec.ts` 新增栈拼接断言（替代顺序、generic 不重复）与转换用例；`test/mcp.spec.ts` 更新到 21 个工具。
- 双端 `tsc` 0 错误；`pnpm test` 30 文件 397 用例全绿；`pnpm build` 通过。
- lens 复核：本轮新增代码无 blocking；`daemon.ts` 的复杂度与 fan-out 是本轮之前就存在的结构性问题，未动。

## 未做

- `paintress_font check`（主动跑浏览器探针）：list 已能读到 viewer 与截图的报告，等真实需求再加。
- 截图侧把报告写回 daemon：截图结果本身已带 `fonts` 字段，daemon 里的报告目前只有 viewer 来源。
