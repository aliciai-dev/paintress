# 2026-11-17T01:58+08:00 — Keep the viewer board strip on single-board files, dropping only the "All" entry

画板条整条挂在 `boards().length > 1` 上，把它的导出控件（倍率 0.5x / 1x / 2x + 导出 PNG）一起带走了：只有一块画板的稿子既看不到画板条，也没有任何导出入口。而导出本来就是「以画板为单位」的，单画板稿反而最常见。

## 改动

`ui/src/App.tsx`

- 画板条的显示条件从 `> 1` 改为 `> 0`。
- 「全部」按钮单独用 `<Show when={boards().length > 1}>` 包住：单画板时它就是整张画布，多一个按钮只是噪音；多画板时行为不变（`focusBoard(null)` → `fitAll`）。
- 新增 `exportBoardId()`：优先返回选中的画板，只剩一块画板时返回它自己。导出控件的显示条件和 `downloadFrame()` 都改用它，所以单画板文件载入即可导出。
- `bindFrame()` 里单画板自动选中（`setActiveBoard(boards[0].id)`），画板条上的那一项因此从一开始就是 active 态；多画板仍是「全部」态起始。

`ui/src/styles.css`

- 钉住左侧的「全部」从 `.boardbar > .board:first-child` 改成 `.boardbar > .board-all`。`<Show>` 会在该位置留下注释/文本标记节点，位置选择器不可靠；类名不受 DOM 结构变化影响。

`specs/canvas-interaction.md`、`README.md`：同步口径 —— 有画板就显示画板条，「全部」仅在 ≥2 时出现，单画板载入即选中。

`test/ui-interaction.spec.ts`：新增「单画板文件」回归（条上 1 个画板、无 `.board-all`、该画板 active、导出控件与 3 个倍率选项常驻、真下载一次 `.png`）。原多画板用例保持不变，仍覆盖「全部」态不出导出控件。

## 验证

- `pnpm check`（tsc --noEmit）通过
- `pnpm build`（tsdown + ui build）通过
- `pnpm test`：34 个文件 / 456 个用例全绿
- 真实浏览器截图对比：单画板稿顶部只剩 `App 800×600` + 右侧 `Scale 1x` / `Export PNG`；多画板稿仍是 `All` + 两个画板，无导出控件

## 未做

- 未改 `paintress shot --board` / MCP 侧语义（本来就与画板条无关）。
- 未发版、未 push。
