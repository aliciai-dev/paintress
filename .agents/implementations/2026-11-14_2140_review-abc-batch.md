# 2026-11-14T21:40+08:00 — A/B/C 批次第三方审查与修复

审查范围：`4e8e72b..31653e7` 的六个提交（截图倍率、查看器三件、渲染器 C1–C3、画谱 B1–B6）。
没有改本轮之外的旧问题。所有修复都补了回归用例。

## 已确认并修复

### 查看器与截图

1. `ref.descendants` 在 schema 中是对象映射，属性面板却按数组计数，覆写条数永远不显示；改为对象键数（数组仅作旧数据兜底）。
2. `/api/node` 选中画板会把整份子树传回，违背「不传输整份文档」；响应移除 `children`，新增 `childrenCount`。
3. `Ctrl/Cmd+K` 只监听父 window，焦点进入 iframe 后快捷键失效；`bindViewport` 增加 `onQuickSwitch` 回调。快速切换的 ↑↓/Enter 也从仅输入框上移到容器，Tab 到结果按钮后仍可用；无文件项目不再提供入口。
4. `--scale` 仍走旧的非负整数解析，0.5/0.8 会被 CLI 拒绝；新增连续数值解析。`--apply` 补进布尔旗标集合，不再吞后面的文件路径。
5. 补真实浏览器下载断言（导出保存文件、不增加历史）与 5000×1000 画板的 2x 实测（产物不超过 8192 单边且保持比例）。

### 渲染器

6. `sweepAngle=0` 被当成整圆绘制；现在返回空路径并给出「空弧不绘制」警告。
7. 圆角多边形统一套正多边形内角，非正方尺寸的角半径不一致；改为按每个顶点两边夹角计算退让距离。
8. SVG 形状的 `strokeAlignment=inner/outer` 实际只能居中，之前静默改变语义；现在明确警告（完整支持见下方未做项）。

### 画谱

9. 校验只认项目组，文档内组被误报悬空；`validateDoc` 与渲染统一为「项目组打底、文档内组覆盖」，并检查组属性里不存在的 `$token`。
10. `establish` 会改写任意数值/十六进制字符串字段，可能误伤 `width`、`content`；现在只改 `fill/stroke` 与声明过的数值样式属性。生成的 8.5 等小数 key 也改为合法变量名（`radius-8-5`）。
11. 组属性按「先 radius 后 spacing」猜类型，`gap` 可能引用圆角 token；改为按属性语义匹配。`allowLiteral` 子树现在既不提取也不改写。
12. `applyEstablish` 增加两道写前保护：设计稿 mtime 已变则先失败；同名但定义不同的 token / preset 组拒绝覆盖，均发生在任何预设写入之前。
13. `adjust` 只比较顶层字段，漏掉 `fill[0].color` 等嵌套引用；改为递归统计。组属性名独立存进计划，未使用组不再写出空属性名；显式覆盖组属性的节点不再误计为受影响；`key` 与 `group/prop` 同给会拒绝。
14. `audit` 之前会把 `name/content` 中的颜色文本当成可 token 化字段，并可能把 `gap` 建议成 radius；现在只递归样式字段，数值按 radius/spacing/font 分类匹配，覆盖结构化填充、圆角数组与逐边对象。
15. `ref` 的 preset target 在校验与展开后渲染中互相矛盾；渲染改为展开前后各套一次（后一次跳过已应用的 target=ref），并去重警告。

### 文档

- `skills/paintress/SKILL.md` 更新到 19 个工具、0.8 默认倍率、8192 上限、spacing/font 与 preset 组，以及 audit/establish/adjust 的 dry-run 纪律。
- README 双语补齐新 CLI、查看器属性面板/快速切换/画板导出与画谱能力。
- 单元规格同步：`/api/node` 不含子树、圆角多边形真实内角、导出实际回传方式。

## 验证

- 双端 `tsc --noEmit`：0 错误。
- `pnpm test`：28 文件、371 用例全绿。
- `pnpm build`：通过。
- `git diff --check`：无空白错误。

## 未修 / 后续风险

1. **`src/doc/album.ts#applyEstablish`**：设计稿与 `__preset.ptr` 是两份文件，仍不是真正跨文件事务。已在写前检查 mtime 和同名冲突，但若进程在两次写入之间崩溃仍可能留下半套状态。建议后续做临时文件 staging + 失败回滚。
2. **`src/render/html.ts#svgShapeHtml`**：SVG 形状的 inner/outer 描边仍按 center 画，只补了明确警告；`strokeLinecap/Linejoin` 也未映射。建议用 clip/mask 分别实现内侧/外侧描边，或保留旧渲染并说明。
3. **`src/render/style.ts#meshLayers`**：网格渐变是多层径向渐变近似，不是严格双线性 mesh；`points` 控制点仍按均匀网格处理。需要精确效果时应使用专用 mesh 渲染后端。
4. **`src/web/daemon.ts#/api/export`**：PNG 仍读入内存后返回，且并发导出会各自启动 Chromium。8192 上限控制单图尺寸，但不控制并发资源。建议流式响应 + 导出并发信号量。
5. **`src/doc/album.ts#planAdjust`**：dry-run 只统计传入的当前设计稿，不枚举项目内其它稿件；文档内定义的 preset 组也只支持预览，apply 仍以项目级 `__preset.ptr` 为准。若需要「全项目影响面」和本地组写回，需补项目文件枚举与明确的写回位置。
