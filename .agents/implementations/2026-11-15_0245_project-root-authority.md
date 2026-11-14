# 2026-11-15T02:45+08:00 — Make the watch root authoritative for project files

`findProjectRoot` 从设计稿向上找「最近的含 `__preset.ptr` / `__components.ptr` 的目录」，而
`setPreset` / `seed` / `component add` 在没有项目文件时会用 `findProjectRoot(from) ?? projectDirOf(from)`
就地建文件。结果是：watch 根目录有一套、`design/` 里又有一套（ptr-test 实测），谁都不是权威；
多文件项目里 agent 也无法确定该用哪一套。

## 改了什么

- **注册根优先**：`setProjectRoots()` 由 daemon / CLI / MCP viewer 注入 watch 注册的项目根；
  `findProjectRoot` 先匹配注册根（最长前缀），没有再退回「向上找」。
- **写入严格解析**：`findProjectRootStrict` —— 注册根 → 唯一的祖先根 → 显式目录；
  祖先里出现两套即报错「项目根不唯一」，裸设计稿不在项目里时报错并提示先 `paintress web`，不再就地建。
  `setPreset` / `setPresetGroup` / `setFontEntry` / `seed` / `applyEstablish` / `component add` 全部切到严格解析。
- **`paintress_project`**：返回项目根、两个文件的绝对路径、token/组/组件计数，按需创建（只在根），
  并报告根下嵌套的重复副本（会拆开设计系统的那种）。
- **viewer 回报**：`paintress_viewer` 返回 `root` 与 `designSystem`；`paintress web` 打印当前目录已有的
  设计系统信息（只报告不创建）；CLI 启动时从 daemon 同步注册根，并新增 `paintress project`。
- 文档：`specs/project-presets.md` 的根规则、README 双语、SKILL、MCP instructions 都改为
  「用 `paintress_project` / viewer 的 `designSystem`，不要自己建这两个文件」。

## 证据

- 新增 `test/project-root.spec.ts` 6 例：注册根优先、双根报错、裸设计稿拒绝、显式目录可用、冲突报告、跳过 node_modules。
- `test/mcp.spec.ts` 22 个工具；`test/docs.spec.ts` 通过。
- 双端 `tsc` 0 错误；`pnpm test` **31 文件 404 用例全绿**；`pnpm build` 通过。
- 现场清理：`ptr-test` 根目录那对空文件已删除（备份 `/tmp/ptr-test-backup-1794681601`），保留 `design/` 那对。

## 未做

- 不自动删除/合并嵌套副本（只报告）：删文件是不可逆动作，交给人和显式指令。
- daemon 重启后 MCP 进程的根缓存会在下一次 `ensureViewer` / `paintress_project` 刷新；
  高频切换项目的多 agent 场景还没有推送式更新。
