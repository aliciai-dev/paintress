# 设计系统引导（Stage D）：字号 token、写入提示、组件上收、预设种子

- 状态：**全部实现**（2026-11-15，D0–D6）；记录见 `.agents/implementations/2026-11-15_0101_fontsize-token.md`、`2026-11-15_0132_design-system-guidance.md`
- 前置：A/B/C 批次已收口（`PLAN.md`）；三层模型见 `album.md`；存储见 `project-presets.md` 与 `components.md`。
- 本文只写**本批的增量与裁决**，不复述三层模型。

## 需求（2026-11-15 实检结论）

1. **AI 面向的提示没有形成闭环**：MCP `INSTRUCTIONS`（`src/mcp/server.ts`）只有查看器与工作流，未提预设与组件，
   而 `components.md#提示词注入` 要求「SKILL.md + MCP instructions 必须包含先查组件」。
   写路径（`update` / `insert` / `batch`）在 AI 写裸值时只回结构警告，实测 `fill:"#3B82F6"`
   在存在 `$color-brand` 时返回 `warnings: []`——只有显式 `audit` 才会指出。
2. **字号 token 是坏的，且 `establish` 会主动制造它**：`font` 类型落盘为 string
   （`src/doc/project.ts#varTypeOf`），`resolveNum` 只接受 number（`src/render/vars.ts`）。
   实测：重复 `fontSize:16` → `establish --apply` 写成 `$font-16` → 渲染告警「数字变量解析失败」，字号丢失。
   `audit`（`src/doc/audit.ts#NUMERIC_PROP_KIND`）与 `establish`（`src/doc/album.ts#NUM_PROPS`）同源。
3. **组件只能复用、不能上收**：`paintress_component` 只有 `list` / `insert`；把页面里做好的子树登记进
   `__components.ptr` 只能靠手写 `paintress_insert`，没有工具也没有提示固化路径。
4. **新项目没有可参照的数值尺度**：SKILL 只说「提议一个小调色板与圆角/间距尺度」，
   每个会话各自发明一套数值，跨会话不可比。
5. **对外文档漏写**：README 双语未列 `preset` / `component` / `marks` 三个工具，未介绍 `.ptr` 默认格式与
   两个项目文件，未记任何环境变量；MCP 工具描述全中文，与 README/SKILL/INSTRUCTIONS 英文不一致。

## operator 决策（2026-11-15，原文）

- 范围：「D0–D6 全做」
- 字号 token：「新增 fontSize 类型」
- 文案语言：「改英文，与 README/SKILL 一致」

## 数据模型增量

### token 类型收敛为五种

```text
color | radius | spacing | fontSize | font
```

- `fontSize` 落盘为 `number`（与 radius/spacing 同形），`font` 只表示字体族（string）。
- **读取时归一（零迁移）**：`x-paintress.presets.items[key].type === 'font'` 且值可解析为有限数字
  → 在**合并副本**里按 `{type:'number', value:Number(v)}` 呈现，面板与 `listPresets` 报 `fontSize`。
  设计稿与预设文件在第一次被编辑前**一个字节都不改**；改一次就落新类型。
- `suggestTokenKey` 增加 `fontSize-<值>`；老的 `font-16` 键保留不改名（按值匹配，不按键）。
- 不引入 `other`：`album.md` 里「扩展 … | other」一句同步删除。

### 属性 → token 种类的唯一映射

`src/doc/presets.ts` 导出 `PROP_TOKEN_KIND`，`audit` / `establish` / `validate` / 写入提示共用这一份：

| 属性 | 种类 |
| --- | --- |
| `fill` `stroke` `color` `effect` | `color` |
| `cornerRadius` | `radius` |
| `gap` `padding` `strokeWidth` `letterSpacing` | `spacing` |
| `fontSize` | `fontSize` |
| `fontFamily` | `font` |

`lineHeight` 不参与（它是 fontSize 的倍数，塞进任何一类都是错语义）；`fontWeight` 也不参与（待独立种类，见 `FUTURE.md`）。

## 单元

### D0 字号 token + 引用类型校验

- 类型与读取归一按上节；`paintress_preset` 的 `type` 枚举加 `fontSize`，面板把它归入「字号」并给数字输入。
- `validate` 增加**引用类型校验**（warning，不阻断）：属性按 `PROP_TOKEN_KIND` 期望某个种类时，
  若 `$token` 的种类不符（如 `fill:"$radius-8"`、`fontSize:"$font-sans"`），报
  `fill 引用了非颜色 token $radius-8（类型 radius）`。只校验项目预设已知种类的 token，本地变量不猜。
  preset 组的 `props` 同样校验。
- 验收：
  1. 重复 `fontSize:16` → `establish --apply` → 渲染仍为 `16px`、0 警告。
  2. 老文件里的 `font-16`（string）不落盘改写也能渲染成 16px（读取归一生效）。
  3. `fill:"$radius-8"` / `fontSize:"$font-sans"` 各得一条 warning，写入照常成功。
  4. `audit` 对重复 fontSize 给出 `$fontSize-16` 建议，采纳后渲染正确。

### D1 写入路径的漂移提示

- `write()` 返回值增加 `hints: string[]`：保存成功后，对本次动到的节点做**等值精确匹配**——
  某个样式属性写了字面量，且项目里存在同种类的等值 token → 提示 `fill #3B82F6 可写成 $color-brand`。
- 只匹配、不猜测（不做近似色、不做「你没用 token」的泛泛提醒）；去重、最多 3 条、稳定排序；
  永不阻断写入、不进 `warnings`（语义不变）。
- 验收：等值裸值 → 有 hint；不等值 → 无 hint；项目无 token → 无 hint；`batch` 一次多条只出 3 条。

### D2 设计系统状态可见

- `paintress_doc_info` 与 `paintress_new` 返回同形的 `designSystem` 块：
  `{ path, tokens: { color, radius, spacing, fontSize, font }, groups: [{ name, target, props }], components }`，
  外加 `next`：当 token 与组件都为空时给一句可执行建议（`paintress_preset seed` 或 `set`；
  `paintress_component list`）。
- `paintress_component list` 在没有组件库时补 `hint`（先 `paintress_viewer` 注册项目），不再只回 `path:null`。
- 验收：空项目显示 0 + `next`；已有项目显示真实计数与组；`new` 立刻可用。

### D3 组件上收

- `paintress_component { action: "add", path, id, name?, parent?, keepSource? }`：
  从 `path` 指向的设计稿取 `id` 子树 → 展开内部 ref、深拷贝、整棵子树摘 `reusable`、
  根节点强制 `reusable: true`、按 `name`（缺省取节点 `name`）命名、为整棵子树重排 id（对组件库取新 id 空间）
  → 追加进 `__components.ptr`（`parent` 默认 root）。`keepSource` 缺省 true（复制，不动源节点）。
- `insert` 增加 `existing` 提示：目标稿里已有同名节点时一并返回，提醒「可能重复造了轮子」。
- 验收：add → list 可见 → insert 拿到的副本 id 全新、可独立渲染；源节点不变；`validate` 0 error；
  `add` 到组件库里再 `insert` 回来不产生重复 id。

### D4 预设种子

- `paintress_preset { action: "seed", path?, apply? }`，默认 dry-run，返回 `created` / `skipped` 两份清单。
- 种子包 v1（固定，可后续升级版本号）：

| 种类 | 键 | 值 |
| --- | --- | --- |
| color | `color-text` `color-text-muted` `color-surface` `color-surface-muted` `color-border` `color-brand` `color-danger` `color-success` | `#111827` `#6B7280` `#FFFFFF` `#F3F4F6` `#E5E7EB` `#2563EB` `#DC2626` `#059669` |
| radius | `radius-4` `radius-8` `radius-12` `radius-full` | `4` `8` `12` `999` |
| spacing | `spacing-4` `spacing-8` `spacing-12` `spacing-16` `spacing-24` `spacing-32` `spacing-48` | 同名数值 |
| fontSize | `fontSize-12` `fontSize-14` `fontSize-16` `fontSize-20` `fontSize-24` `fontSize-32` | 同名数值 |
| font | `font-sans` `font-mono` | `Inter, system-ui, sans-serif` / `ui-monospace, SFMono-Regular, monospace` |

- 种子组：`text.body`（target text，`fontSize` `fill`）、`text.muted`、`text.title`、
  `button`（target frame，`fill` `cornerRadius`）、`card`（frame，`fill` `cornerRadius` `stroke`）、
  `input`（frame，`fill` `cornerRadius` `stroke`）。
- **只补缺失、永不覆盖**：键已存在即算 `skipped`（即使值不同）；组同理。
- 验收：空项目一次得到 27 token + 6 组；连跑两次第二次 `created` 为空；
  `preset:"text.body"` 直接渲染生效；`audit` 不再报孤儿 token。

### D5 提示词落位

- MCP `INSTRUCTIONS` 增加一段 DESIGN SYSTEM（3–4 行）：预设先于像素、`$token` 不写裸值、
  组件先查后建、同一形态第二次出现就 `component add` 上收、改完 `validate`。
- 19 个工具的 `description` 与全部参数说明**改写为英文**（与 README/SKILL/INSTRUCTIONS 一致）；
  `new` / `insert` / `update` / `batch` 各补一句预设与组件的指引。
- `SKILL.md`：组件登记明确写「进 `__components.ptr`」；补「用两次以上就上收」；补 `fontSize` 类型与
  `paintress_preset seed`；保留 dry-run 纪律（establish / adjust / seed）。
- 验收：`components.md#提示词注入` 的两处注入都包含该要求；`grep -P '[\x{4e00}-\x{9fff}]' src/mcp/tools.ts` 无命中。

### D6 README 双语 + 文档漂移测试

- README 两份同步：MCP 工具行补 `doc_info` / `preset` / `component` / `marks`（现有 15 项 / 共 19 个）；新增「文件与格式」小节
  （`.ptr` 是默认、`.pen` 兼容、`__preset.ptr` / `__components.ptr` 由程序创建且**应提交进版本库**）；
  环境变量表（`PTR_BROWSER` / `PAINTRESS_HOME` / `PAINTRESS_NO_OPEN` / `PAINTRESS_NO_AUTO_WEB` / `CI`）；
  CLI 列表补 `preset groups` 与 `watch --depth`；新增「设计系统」小节（三层 + 三个操作 + 种子）；
  笔记由谁写、导出文件名与 8192 上限、侧栏 agent 接入点。
- `TERMS.md`：裁决 画谱 / 谱值（token）/ 谱式（preset 组）/ 谱件（component）四个词，中英对照。
- 新增 `test/docs.spec.ts`：`Object.keys(TOOLS)` 每个名字都必须在两份 README 出现；
  两份 README 的小节标题集合一致（缺一节即红）。
- 验收：`docs.spec.ts` 绿；中英两份小节一一对应。

## 顺序与依赖

D0 → D1 / D2 / D4 可并行 → D3 独立 → D5 依赖 D2–D4 的真实接口 → D6 最后。

## 本批不做

- `lineHeight` / `fontWeight` 的 token 种类、`font` 族的 fallback 栈校验。
- 组件的改名 / 删除 / 使用率统计、跨文档真 `ref`（`imports` 仍是 TBD）。
- 主题化 token 的面板编辑与 `adjust`（`readPresetFile` 仍跳过 themed 数组）。
