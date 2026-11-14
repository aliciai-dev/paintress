# 2026-11-15T01:32+08:00 — Design-system seed, write hints, component promotion, prompts and docs (D1-D6)

D0 修了字号 token 之后，AI 侧的引导仍不成闭环：写裸值没有提示、`doc_info` 看不到设计系统状态、
组件只能复用不能上收、新项目没有可参照的数值尺度；README 还漏了 4 个工具与两个项目文件。

## 改了什么

- **写入提示（D1）**：`write()` 返回 `hints`（最多 3 条）：等值 token、text 没写字体、未登记 family。
- **设计系统状态（D2）**：`doc_info` / `new` 返回 `designSystem`（token 计数、preset 组、字体、组件、字体缺口、空库 next）；
  `component list` 无库时给注册提示。
- **组件上收（D3）**：`paintress_component add` 把设计稿子树复制进 `__components.ptr`（展开 ref、摘内部 reusable、
  根 reusable、重排 id、可改名）；`insert` 遇到目标稿同名节点返回 `existing`。
- **预设种子（D4）**：`paintress_preset seed`（dry-run 默认）一次补 27 个 token + 6 个组 + 2 个网络字体 +
  `fonts.default = font-sans`；只补缺失、连跑不重复。
- **提示词（D5）**：MCP `INSTRUCTIONS` 增 DESIGN SYSTEM 段；20 个工具描述与 48 个参数说明改英文；
  SKILL 增字体注册、seed、组件 add 与「缺字体是缺口」规则。
- **文档（D6）**：README 双语补工具清单、`.ptr`/`.pen`、两个项目文件与提交建议、设计系统章节、环境变量表、
  CLI 缺口（`preset seed`、`font`、`watch --depth`）、笔记作者与导出文件名；新增 `TERMS.md` 与 `test/docs.spec.ts`。

## 证据

- `test/album.spec.ts` / `test/audit.spec.ts` / `test/mcp.spec.ts` / `test/components.spec.ts` / `test/fonts.spec.ts` 覆盖上述行为。
- `test/docs.spec.ts`：每个 `TOOLS` 名字都在两份 README 出现、格式/项目文件/环境变量均有说明、小节数一致。
- 双端 `tsc` 0 错误；`pnpm test` **30 文件 394 用例全绿**；`pnpm build` 通过；端到端 seed/establish 复现通过。

## 未做

- `query` 的 `fontless` 计数：`paintress_query` 返回数组，加字段会破坏形状；缺口已由 `doc_info`/`validate` 覆盖。
- 组件改名/删除/使用率、变体与跨文档继承：继续留在 FUTURE。
