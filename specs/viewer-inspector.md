# 查看器只读属性面板

## 需求

点中一个节点后，人得能看见它到底是什么：类型、尺寸、颜色、圆角、文字、布局、是不是组件实例。
现在只有面包屑上的 type/name，其余要问 agent——「只读」是刻意的：写路径只有 MCP / CLI 一条，查看器不开口子。

## 方案

- **数据来源**：新接口 `GET /api/node?project=<name>&path=<rel>&id=<nodeId>`
  → `{ ok, node, presets: { <key>: value } }`。`node` 是磁盘上的原始节点（`ref` 不展开，保留 `ref/descendants` 原貌，属性面板要显示「它就是引用」）；
  `presets` 是项目预设变量表，用来把 `$color-brand` 同时显示成「引用 + 解析值」。
- **取数时机**：选中变化时一次请求；同一次选中不轮询。SSE `change` 且面板开着 → 重取一次（文件被 agent 改了要跟上）。
- **界面**：复用 `ui/src/panel.tsx` 的 `Panel` 浮动壳，挂在画布右侧（与预设/组件面板同一位置、互斥）；
  `tool-rail` 增加第三项「属性」。选中节点即展开；点空白/清空选择即收起。主动关掉后，本次会话不再自动弹（记在内存，不落盘）。
- **分组**：标识（id/type/name/reusable/preset）· 几何（x/y/width/height/rotation/opacity）· 布局（layout/gap/padding/justify/align）·
  外观（fill/stroke/cornerRadius/effect）· 文本（content/fontFamily/fontSize/fontWeight/lineHeight）。
  空组不渲染；未知字段折叠进「其它」，不丢信息。
- 颜色类值显示色块 + 原始字符串；`$var` 显示成 `$name → 解析值`。

## 验收

1. 点任意节点 → 面板出现，id 与 `#N` 短号指向同一个节点；点画板空白 → 收起。
2. 切换节点：面板内容跟着换，不残留上一节点；切换文件/项目：清空。
3. `ref` 节点显示引用关系（`ref` + `descendants` 条数），不展开成子节点。
4. 面板与预设/组件面板互斥；三个 rail 项状态正确。
5. 大文档（278 节点）下选中响应 ≤ 1 次请求、无整份文档传输。
