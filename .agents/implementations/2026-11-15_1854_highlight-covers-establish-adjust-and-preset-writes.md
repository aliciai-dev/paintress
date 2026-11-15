# 2026-11-15T18:54+08:00 — Make the change highlight cover establish, adjust and preset writes

写工具的金边只覆盖了走 `write()`（`src/mcp/tools.ts`）的那些操作。三类别处写入会改渲染却不登记变更：

- `paintress_establish`（`apply:true`）直接在 `src/doc/album.ts#applyEstablish` 里 `saveDoc` 重写设计稿，绕过了 `write()` 里唯一的 `notifyChanges` 调用；
- `paintress_adjust`（`apply:true`）只写 `__preset.ptr`，没有任何 id 记录；
- `paintress_preset` 的 `set` / `remove` / `set-group` / `remove-group` 同样只写预设文件。

页面本身会刷新（daemon 的浏览器 SSE 同时监听 `__preset.ptr`），所以现象是「画布变了、但没有任何金边」，看起来就像高亮坏了。

## 改法

- `applyEstablish` 在改写走查里收集被改写的节点 id，随结果返回 `touched`。
- 新增 `nodesAffectedByPreset(doc, presetDoc, {token|group})`：算「这个 token / 组一改，哪些节点会跟着变」，包含**经 preset 组间接受影响**的节点（`planAdjust` 里这部分只记了 `<preset:name>`，没有节点 id）。
- `applyAdjust` 返回 `touched` = 计划点名的节点 + `nodesAffectedByPreset` 的节点。
- `src/mcp/tools.ts`：establish / adjust 应用后 `notifyChanges(path, touched)`；新增 `notifyPresetBlast(from, blast)` 给预设工具用 —— `from` 是设计稿就只算它，是项目目录就逐张算根下的设计稿（`__preset.ptr` / `__components.ptr` 以 `__` 开头，不算设计稿）。
- 不新增 daemon 协议：刷新走已有的 preset watcher，金边走已有的 `/api/changes`。

## 验证

- `pnpm check` 0 错误；`pnpm test` **34 文件 454 用例全绿**；`pnpm build` 通过（ui 产物 hash 未变，本轮没动前端）。
- 新增用例：establish 应用后通知含被改写节点；adjust 改 token 时经 preset 组间接受影响的节点也在名单里；改组的名单是用该组的节点；`preset set` 传项目目录时逐张扫描、且不碰 `__preset.ptr`。
- 端到端（临时 daemon + 真实浏览器 + 真实 CLI）：`establish --apply` 后 0.4s 页面重载并出现 `[data-ptr-changed]` = `a, b`；`adjust --key color-3b82f6 --value #C81E1E --apply` 后 0.4s 画布变 `rgb(200,30,30)` 且同样亮起 `a, b`。

## 已知未改

`paintress_font` 的 `add` / `remove` / `default` 也会改渲染（同样只写 `__preset.ptr`，页面会刷新但没有 id 记录）。字体族可能经 `$font-*` token 间接引用，要先定「算不算受影响」的解析规则，登记在 `.agents/memory/FUTURE.md`。
