# 画谱（Album）：把项目的颜色与样式框死

- 状态：B1–B6 已实现（2026-11-14），记录见 `.agents/implementations/2026-11-14_2054_album-b-batch.md`

## 需求

operator 2026-11-12：**「最关键的一点要提供组件或是预设概念，用于框死一个项目中的颜色，样式，以及一个一个的可复用组件。」**
2026-11-13 已落地框架子集（`__preset.ptr` / `__components.ptr`、`paintress_preset`、预设面板、组件画廊）。
这一轮补的是**本体的三层与三个操作**：只有引用链和「改一处全项目变」，才算真框住。

## 三层模型

```
tokens（谱值）  ←  presets（谱式）  ←  components（谱件）  ←  页面节点
```

- token 的值只能是字面量；preset 的属性值只能是 `$token`；组件的观感走 preset / token；页面节点优先用 preset。
- 违反任一层：`validate` 出**警告**（不阻断写入，保留一次性设计的手感）；`audit` 列越界节点 + 可替换建议。
- 逃生舱：节点 `metadata.allowLiteral: true` 跳过越界检查。

## 存储（本轮默认，开工前可推翻）

- **tokens**：就是 `__preset.ptr` 的 `variables`（已存在）。分类复用 `x-paintress.presets.items[key].type`，扩展 `color | radius | spacing | font | other`；
  缺省由变量 `type` 推导（color→color，number→radius，string→font）。`kind` 不强制。
- **presets**：`x-paintress.presets.groups.<name> = { target: '<nodeType>', props: { fill: '$color-brand', cornerRadius: '$radius-md' } }`。
  `props` 的值必须是 `$token` 引用（裸值 → validate 警告）。
- **节点引用**：节点新增可选字段 `preset: '<name>'`。渲染时先套该组属性，**节点显式属性优先**；保存永远写原文档，不烤值。
- **schema 中立**：JSON 里不出现 `album`，沿用 `variables` / `presets` / `reusable`（D-005 的命名纪律）。

## 三个操作（工具面）

命名从拟定名收敛为动作名（不带 album 前缀，与 `paintress_preset` 一致）：

| 工具 | 输入 | 输出 |
| --- | --- | --- |
| `paintress_audit` | `path` | 越界节点（可替换的 token/preset）、孤儿 token、从未被引用的 preset、悬空 preset 引用、preset 里的裸值 |
| `paintress_establish` | `path`、`apply?` | 从现有稿提取候选 token（按值聚类）与候选 preset（按节点类型 + 属性组合）；`apply=false` 只出建议，`apply=true` 才写 `__preset.ptr` 并把匹配节点改写为引用 |
| `paintress_adjust` | `key`/`group`、新值、`apply?` | 改 token/preset 的影响面：受影响节点 id + 旧值→新值；`apply=true` 才写 `__preset.ptr`（设计稿自动跟着变，不需要批量改稿） |

组本身的写入并入 `paintress_preset`（`action: set-group / remove-group`），不另起工具：
组属于预设文件，与 token 同一条写路径、同一把 mtime 锁。

CLI 同名子命令：`paintress audit|establish|adjust`，参数与 MCP 一一对应。

## 单元与顺序

| 单元 | 内容 | 验收 |
| --- | --- | --- |
| B1 | token 分类（`type` 扩展 + `kind` 推导）+ validate 认识 tokens | `paintress_preset` 能建 spacing/font；图层面板按 kind 分组；旧文件不产生新警告 |
| B2 | preset 组 + 节点 `preset` 引用 + 渲染叠加 | 节点写 `preset: 'body'` 后渲染带出组属性；显式属性覆盖它；保存不烤值 |
| B3 | `audit`（MCP + CLI） | 三类问题各造一份样例稿，报告能指到具体 id |
| B4 | `establish`（先只出建议，后 apply） | 对 `demo/` 与 `design/` 真实稿给出可读候选；apply 后 validate 无新错误、diff 只有预期行 |
| B5 | `adjust` + dry-run diff | 改一个 token → 列出受影响节点与前后值；apply 后画布/截图跟着变，设计稿 mtime 不变 |
| B6 | 手改面板扩展（分组 + 组展示） | 面板按 kind 分组编辑 token；preset 组以只读列表展示；改值画布实时变 |

## 未决（本轮按上表默认执行，遇到真实稿再改）

1. `kind` 是否强制（强制后能做单位换算与对照检查，代价是历史文件迁移）。
2. preset 组能否跨文档/跨项目继承（`imports` 仍是 TBD）。
3. 变体怎么表达：命名变体（`variant=primary`）还是参数化插槽。
4. 画谱放文档顶层（`x-paintress.album`）还是独立文件——本轮继续走独立文件 `__preset.ptr`（多稿共享、一人一份）。
