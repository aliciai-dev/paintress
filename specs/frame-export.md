# 单帧导出（选中画板 → 下载 PNG）

## 需求

operator 2026-11-14 点名：在查看器里选中一个画板后直接下载这一帧，倍率 **2x / 1x / 0.5x**（默认 1x）。
倍率只决定像素尺寸，不改设计稿；用途是把某一帧发出去或贴进文档。

## 本轮定下的四个待定

| 待定 | 结论 | 理由 |
| --- | --- | --- |
| 出口格式 | **只出 PNG** | 与 `paintress_screenshot` 同一条链路，零新渲染器；SVG 出口进 FUTURE |
| 倍率上限 | 2x，且单帧像素 ≤ 4096×4096 | 超出返回 413 并提示降到 1x/0.5x；防 daemon 被一次超大截图拖死 |
| 按钮位置 | 画板条右侧「导出」+ 倍率下拉 | 只在激活了具体画板（非「全部」）时出现；倍率选择按浏览器记住 |
| 文件名 | `<文件名去扩展名>-<画板名或 id>@<倍率>x.png` | 可预期、可排序；画板名取 `data-board-name`，缺失用 id |

## 方案

- **服务端**：`GET /api/export?project=<name>&path=<rel>&board=<id|name>&scale=<0.5|1|2>`
  → 用 `screenshotPen(file, tmp, { board, scale })` 写到临时文件，流式回传后删除；
  `Content-Type: image/png`、`Content-Disposition: attachment; filename="..."`、`Cache-Control: no-store`。
  无 Chromium → 501 + 可读提示（复用 `findBrowser()` 的判定）。
- **前端**：`ui/src/api.ts` 加 `exportUrl(project, file, board, scale)`；按钮直接走 `location.href`（浏览器原生下载，不必读进内存）。
- **安全面**：只读接口，不写设计稿、不触发变更高亮；`board` 走现有 `selectBoard` 规则（歧义名报错并列出候选）。

## 验收

1. 2x / 1x / 0.5x 产物像素尺寸 = 画板尺寸 × 倍率（200×100 的画板 → 400×200 / 200×100 / 100×50）。
2. 文件名符合规则；同一画板重复导出文件名稳定。
3. 超大画板 + 2x → 413，前端给出「降到 1x / 0.5x」的提示，不产生半截文件。
4. 没有 Chromium 的机器 → 501，文案说明需要本机 Chrome/Chromium。
5. 导出前后设计稿 mtime 不变、`/api/changes` 无记录。
