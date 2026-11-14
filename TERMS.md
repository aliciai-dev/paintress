# 术语（TERMS）

一个事实一个家：本文件只裁决**容易混用的词**，不重复规格内容。

| 中文 | English | 指什么 | 不指什么 |
| --- | --- | --- | --- |
| 画谱 | album | 项目级设计系统的整体：谱值 → 谱式 → 谱件 | 单个 token、单个组件 |
| 谱值 | token | `__preset.ptr` 里的一个变量（颜色 / 倒角 / 间距 / 字号 / 字体族），设计稿用 `$key` 引用 | preset 组 |
| 谱式 | preset group | `x-paintress.presets.groups` 里的一组「节点类型 + 属性 → `$token`」，节点写 `preset: "<name>"` 参与 | 单个谱值 |
| 谱件 | component | `__components.ptr` 里 `reusable: true` 的节点 | 设计稿里的普通节点 |
| 设计系统 | design system | 与画谱同义；**对外文档**用这个词，内部文档可用「画谱」 | — |
| 预设 | preset | 口语里常拿来指谱值；正式写作请写「谱值」或「谱式」 | — |

## 用法示例

- ✅ 「`color-brand` 是项目的**谱值**，`button` 是把它和倒角绑在一起的**谱式**，`Card` 是**谱件**。」
- ✅ 「这次任务在补**设计系统**的字体层。」
- ❌ 「改一下预设组里的预设」——两个词都指不清，改成「改 `button` 谱式里的 `fill`」。
