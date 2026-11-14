# 计划（未完成）

> 只放路线级计划与未决问题。每个工作单元开工前单独写 `specs/<unit>.md`；
> 已收口的工作移入 `.agents/memory/FINISHED.md`，只留摘要与证据指针。
> 进度本身只在 todo 工具里——这里不写。

## 路线

迁移自 `AGENTS.md`（2026-11-10）。

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| 1 | MCP 工具：读 / 查 / 改 / 插 / 删 / 校验 | 已完成（2026-11-10，9 工具 + CLI，记录见 `.agents/implementations/2026-11-10-stage1-core.md` 与 `-stage1-mcp-cli.md`） |
| 2 | 渲染器：`.pen` → HTML/CSS，+ headless 截图出 PNG | 已完成（2026-11-10，视觉验收通过，记录见 `.agents/implementations/2026-11-10-stage2-render.md`） |
| 3 | 查看器：本地 web server + 文件监听热重载 | 已完成（2026-11-10，统一进程方案 + 三处修正，记录见 `.agents/implementations/2026-11-10-stage3-web.md`） |
| 4 | 标记：点击选中 + 短号 + 变更高亮 | 已完成（2026-11-10 上线主体；2026-11-11 补齐嵌套层级切换）：点击选中、`#N` 短号、`paintress_marks`、变更高亮、Alt+点击选父级、Alt+滚轮切层级。记录：`.agents/implementations/2026-11-10-stage4-marks.md`、`.agents/implementations/2026-11-11-stage4-nesting.md` |
| 5 | 发布与安装规范化：npm 包、多客户端配置、Registry | **基本完成**（2026-11-11）：已发布 `paintress@0.1.1`（unscoped 根包名），多客户端 `install`/`doctor`/`mcp-config` 已实测；CI 与发布工作流已入仓（OIDC + provenance，action 钉 SHA）；剩 npm 侧配置 trusted publisher、MCP Registry 可选、dts 债。记录：`.agents/implementations/2026-11-11-stage5-publish-prep.md`、`2026-11-11-publish-npm.md` |
| 6 | 画布交互：多画板导航 + 平移缩放 | 已完成（2026-11-11，五步全部落地，记录见 `.agents/implementations/2026-11-11-stage6-canvas.md`）；方案与边界见 `specs/canvas-interaction.md` |

阶段 2 是地基，架构决定成败，其余三阶段都建立在它之上（理由见 `.agents/memory/ARCHITECTURE.md#D-002`）。

## 当前批次（2026-11-14）：A 查看器 + B 画谱 + C 渲染器

> 顺序即执行顺序。每个单元的规格已先行落盘；进度只在 todo 工具里，本表只说范围与出口。
> 「本会话不做」的条目在 `.agents/memory/FUTURE.md`。

| 序 | 单元 | 规格 | 出口（验收摘要） |
| --- | --- | --- | --- |
| A1 | 查看器只读属性面板 | `specs/viewer-inspector.md` | 选中出面板、切节点跟随；只读，不新增写路径 |
| A2 | 多稿快速切换 | `specs/viewer-file-switcher.md` | Cmd/Ctrl+K + 模糊过滤 + 键盘全程；不新增浏览历史 |
| A3 | 单帧导出 PNG | `specs/frame-export.md` | 画板级导出 2x/1x/0.5x；<=4096px；文件名可预期 |
| C1 | 椭圆弧形 / 圆环 | `specs/renderer-gaps.md` | startAngle/sweepAngle/innerRadius 真实几何 |
| C2 | 多边形圆角 | `specs/renderer-gaps.md` | cornerRadius 生效，不再忽略 |
| C3 | mesh_gradient 近似 | `specs/renderer-gaps.md` | 网格点插值，不再退化成单色 |
| B1 | 画谱：token 分类 | `specs/album.md` | kind 扩展 + validate 认识 tokens |
| B2 | 画谱：preset 组 + 节点引用 | `specs/album.md` | 渲染时生效、显式属性优先、不烤值 |
| B3 | 画谱：audit | `specs/album.md` | MCP + CLI 一份可读报告 |
| B4 | 画谱：establish | `specs/album.md` | 候选提取（不写盘）→ 批准后一次写入 |
| B5 | 画谱：adjust + dry-run | `specs/album.md` | 影响面 diff；apply 才写预设文件 |
| B6 | 画谱：手改面板扩展 | `specs/album.md` | 按 kind 分组编辑；组只读展示 |

依赖：A1 与 A3 都要动画布右侧/画板条，先 A1 再 A2 再 A3；C1–C3 互相独立，可穿插；B1→B2→B3 是硬顺序，B4/B5 依赖 B2。

**2026-11-14 收口：A1–A3、C1–C3、B1–B6 全部落地**（质量基线：双端 `tsc` 0 错误、27 文件 350 用例全绿、`pnpm build` 通过）。
摘要见 `.agents/memory/FINISHED.md`；决策见 `ARCHITECTURE.md#D-010`。

## 下一批次（2026-11-15）：Stage D 设计系统引导 + Stage F 字体

> 规格：`specs/design-system.md`（D）、`specs/fonts.md`（F，含 operator 五条决策原文）。进度只在 todo 工具里。
> 两批合流是因为 D0 的字号 token、D4 的 seed 字体、D5 的提示词都与字体耦合；
> 硬拆成「先 D 后 F」会在 D4/D5 返工。

| 序 | 单元 | 规格 | 出口（验收摘要） |
| --- | --- | --- | --- |
| 1 | D0 字号 token + 引用类型校验 | `design-system.md#D0` | `establish` 不再毁字号；`fill:$radius-8` 类错配在 validate 出 warning |
| 2 | F1 字体注册表 + validate + `paintress_font` | `fonts.md#8` | family 未登记 / system 无 preview 出 warning；add 校验路径与文件存在 |
| 3 | F2 渲染注入 + `defaultFont` + 缺口提示进 MCP | `fonts.md#8` | 项目字体在 `/render` 生效；无 family 的文本用 default，且 `doc_info`/`validate`/`get`/写路径都看得见 `gaps` |
| 4 | D4 预设种子（带字体登记） | `design-system.md#D4` | 27 token + 6 组，`font-sans`/`font-mono` 带 source 与 preview，`fonts.default` 指向 `font-ui` |
| 5 | D1 / D2 / D3 | `design-system.md#D1`… | 漂移提示、设计系统状态（带 fonts 概要）、组件上收 |
| 6 | F3 查看器探针 + 徽章 | `fonts.md#8` | 缺字体 / 用了替代在界面上可见，属性面板标解析值 |
| 7 | F4 截图等字体 + 报告 | `fonts.md#8` | `fonts.ready` 后才测量；结果含 loaded/missing/substituted |
| 8 | D5 / D6 | `design-system.md#D5`… | 提示词落位（含字体决策树）、README 双语与文档漂移测试 |
| 9 | F5 度量覆盖 + `--embed-fonts` | `fonts.md#8` | 替代字体行高接近真字体；导出脱离项目也能显示 |

**2026-11-15 收口：D0–D6、F1–F5 全部落地**（双端 `tsc` 0 错误、30 文件 397 用例全绿、`pnpm build` 通过）。
D4 的 seed 现在包含字体登记；D5 的提示词已含字体决策树。摘要见 `FINISHED.md`，决策见 `ARCHITECTURE.md#D-011`。

## 未决问题

- **dts 生成被禁用（债务）**：zod passthrough 推断类型超过 TS 序列化上限（TS7056，实测定位在 `src/schema/nodes.ts:209` 的 `NodeSchema`）。2026-11-11 实验：只给 `NodeSchema` 加显式注解即可通过构建，但 `index.d.ts` 达 1548 KB（包体从 164 KB → 1.67 MB），故 0.1.0 不发类型产物；要发需先给全部导出 schema 显式注解瘦身，或按需导出 + api-extractor。
- **格式规格存在缺口**（2 处，2026-11-10）：imports 跨文件 id 引用语法缺实例；corner_radius 四元组角顺序未确认。详情与证据标注见 `format/spec.yaml` 的 `ptr.known_gaps`。
- **README 免责声明**：当前 README 不提及任何第三方产品，因此无需声明；若将来在文档中描述性提及格式或产品名，需补「非官方、不隶属」声明。依据见 `specs/pen-format-licensing.md#红线 3`。
