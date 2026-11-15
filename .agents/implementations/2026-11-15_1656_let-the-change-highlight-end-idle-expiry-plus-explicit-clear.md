# 2026-11-15T16:56+08:00 — Let the change highlight end: idle expiry plus explicit clearing

金色呼吸描边（变更高亮）原本一旦画上就永不消失，只等 iframe 重渲染——人停在页面上看到的是动画而不是成品。要求：有保底（连续若干分钟无编辑则取消）、切换后不显示，并提供一条 MCP 让 agent 在明确编辑完后主动撤除。

## 实现

**保底（两层，同一窗口）**

- `ChangesStore` 的 TTL 由 60s 提到 5 分钟：`get()` 过期即返回空，刷新/重渲染不会把过期高亮复活。
- 前端 `applyChanges()` 画上金边时启动/重置一个 5 分钟定时器，到点 `clearChangedMarks()` 移除所有 `[data-ptr-changed]`；切稿/切项目时 iframe 重建，`onCleanup` 同时收掉定时器。

**主动撤除（新通道）**

- `daemon`：新增按 `项目 + 文件` 索引的浏览器 SSE 集合 `fileStreams`；新增控制面请求 `{kind:'clear-changes', path}`，清掉记录并推 `event: changes-cleared`。
- `ui`：查看器本来就订阅了这条每文件 SSE，新增监听 `changes-cleared` → `clearChangedMarks()`，即时撤高亮且**不重渲染**（页面不闪、选中不丢）。
- 新工具 `paintress_clear_changes(path)`：传设计稿路径即可；daemon 侧用新增的 `resolveRegisteredFile()`（与 `changes` 记录共用同一套「最深项目根」解析）定位项目与相对路径。控制面不通时返回 `cleared: 0` 而不是报错——高亮收尾不值得打断 agent。

## 工具面收窄（评估结论见 review）

- 工具描述总长 **4,777 → 4,120 字符**，同时工具数 22 → 23（新增 clear_changes 在内）；单工具均值 217 → 179。
- MCP 连接说明（每次 initialize 都下发）从 1,410 收紧到 1,349 并补上「收工清高亮」；顺带删掉与 SKILL 重复的铺陈。
- **没有删除任何工具**：逐个核对后每个仍有独立职责；`project` 的说明改成「只在有文件路径且没调 viewer 时用」，把与 `viewer.designSystem` 的重叠说清楚而不是合并。

## 验证

- `test/changes.spec.ts`：TTL 断言改为从导出的 `CHANGE_TTL_MS` 推导（不再写死 2 分钟）；新增 `clearFile` 只清单文件、`clear-changes` 按路径清除、以及**真实 SSE 收到 `changes-cleared`** 三条。
- `test/ui-interaction.spec.ts`：真实 Chromium —— 先造一次变更 → 页面加载后断言 `[data-ptr-changed]` 存在 → 调 `paintress_clear_changes` → 断言属性在 10s 内消失。
- `pnpm check` 干净；`pnpm build`（含 ui）通过；`pnpm test` **34 文件 / 447 用例全绿**。

## 过程中的坑

前端产物必须先 `pnpm build:ui`，否则 UI 测试跑的是旧 bundle（新监听器不存在），会误判成功能没做通。
