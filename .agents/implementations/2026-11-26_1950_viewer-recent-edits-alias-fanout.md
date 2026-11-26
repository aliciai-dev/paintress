# 2026-11-26T19:50+08:00 — Fan out design change events to every project name on the same root

代码审查发现 `designs` 事件的 owner 解析错了一处：`watchDesigns` 按目录复用监听器（第一个调用方赢），
但回调闭包里写的是 `entry.name`。同一目录挂第二个项目名时（MCP 自动注册 + 人工 watch），
监听器仍是第一个，广播的也还是第一个名字——第二个项目的行永远等不到自己的事件。

改为在事件触发时按 `rootReal` 查出所有已注册项目名，逐个广播。
回归用例：同目录注册 `alias-of-test-proj` → 写盘 → 注册表通道必须同时出现两个名字的 `designs`。
`src/web/watcher.ts` 的注释补明「监听器只保留第一个，fan-out 由调用方负责」。

顺带把三处相邻小缺口记进 `.agents/memory/FUTURE.md`（本轮不改）：
- depth 不一致时 watcher 重建会换监听器，owner 可能再次错位；
- 规格 Risks 里承诺的 150ms 合并未实现；
- 深度之外的 `change` 也会广播，前端会给未列出的路径插一条不可见的 `fileMeta`。

验证：`pnpm check` 双端 0 错误；`pnpm test` 34 文件 471 用例全绿（新增 1 个）；`pnpm build` 通过。
