# 2026-11-15T20:50+08:00 — Cover nested designs and seeded presets in change highlights

754df4d 已覆盖 establish、adjust 与 preset 的单项写入，但仍有两处同类缺口：

1. `designFilesOf` 只读取项目根目录，查看器支持的子目录设计稿（默认深度 3、最大 6）不会收到变更记录。
2. `paintress_preset {action:'seed', apply:true}` 会新建 token / 组并改变已有悬空引用的渲染，但没有调用变更通知。

两条都先以回归测试复现：嵌套稿的通知数少 1；seed apply 的通知数少 1。

## 修复

- 将 `Registry.listDesigns` 的枚举逻辑原样提取为 `listDesignFiles`，注册表与预设通知共用目录深度、隐藏目录、构建目录和 `__` 项目文件过滤规则；预设通知按查看器上限递归扫描。
- 新增 `nodesAffectedByPresets`，一次合并多个 token / 组的引用集合，只遍历设计稿一遍。保留 `nodesAffectedByPreset` 作为单项调用的兼容包装。
- seed 仅在 `applied:true` 后，把 `created.tokens` 与 `created.groups` 合并成一次通知计算；dry-run 不通知。

## 验证

- 新增两条回归：根目录 + 嵌套设计稿都收到通知；seed dry-run 无通知、apply 同时覆盖直接 token 引用与 preset 组引用。
- `pnpm check` 0 错误；`pnpm test` 34 文件 455 用例全绿；`pnpm build` 通过。
- `Registry.listDesigns` 的既有深度、隐藏目录与扩展名测试全部通过。

构建仍有 tsdown `define` 配置警告，属于本轮之外的既有问题，未改。
