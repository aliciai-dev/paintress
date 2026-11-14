# 查看器自动关窗（全收工 → 倒计时 → 关掉标签）

## 需求

operator 2026-11-14：**「发现全关了就倒计时自动关掉，不需要人手动关。」**
截图现场：agent 全部收工、daemon 退出后，页面停在一张「服务已关闭 / 可以关闭此页面」的静态卡片上，
人要自己去点标签页的 ×。这不是没能力做——只是这条路径（daemon shutdown）当初没接倒计时。

1. 「全关」有两个来源，都算：
   - **项目全收走**：agent 会话结束、最后一个项目被 unwatch；
   - **web 进程关闭**：空闲退出、侧栏「关闭服务器」、`paintress stop`。
2. 都走同一个倒计时（10s），倒计时结束由页面**自己关掉浏览器窗口**，不劳人动手。
3. 倒计时期间 agent 又接入 / daemon 又回来 → **撤销**，页面继续可用。
4. 关不掉时不许装死：浏览器只允许人自己关「有过浏览历史」的标签，这种情况要**明说**。
5. 倒计时卡片的视觉要配查看器整体（纸白 + 主色蓝 + logo 金），不能是临时占位。

## 方案

**能关掉的原理（实测，2026-11-14）**：Chromium 允许脚本关闭 **history.length === 1** 的标签，
即使这个标签是浏览器自己按 URL 打开的（daemon 就是 `wslview` / `cmd start` 起宿主浏览器）。
一经 `pushState` 把历史顶到 ≥ 2，`window.close()` 就被拒（控制台：Scripts may close only the windows
that were opened by them）。查看器自身的路由只用 `history.replaceState`，长度始终是 1；
只有人先在同一个标签里跳转过别处才会落到说明态。

- **前端状态**（`ui/src/App.tsx`）：`leaveReason: 'idle' | 'closed'` + `countdown` + `closed` + `closeBlocked`。
  三个入口都进 `startLeave()`：项目归零（idle）、注册表 SSE `shutdown`（closed）、手动关服务（closed）。
  已在倒计时时只允许 `idle → closed` 升级，**不重置秒数**（shutdown 通常就紧跟项目归零）。
- **归零动作** `finishLeave()`：idle 先 best-effort `POST /api/shutdown`（人已经走了，进程别留着），
  然后 `window.close()`；600ms 后页面还活着 = 浏览器拒绝，置 `closeBlocked`。
- **撤销**：`projects.length > 0` → `stopLeave()`（清倒计时、清 closed/closeBlocked）。
- **视觉**：复用 `.modal` 壳 + `.countdown` 修饰，换成环形进度（SVG，`stroke-dashoffset` 每秒线性过渡）
  包住秒数；顶部 2px 蓝→金发丝线（与侧栏字标同源）；最后 3 秒环与数字转 logo 金；入场 220ms 上浮淡入；
  `prefers-reduced-motion` 全关。秒数只在环里出现一次，正文不重复数字。
- **文案**：标题按原因分（服务已关闭 / 无激活项目）；正文一句为什么；读屏用 `sr-only` 播报 `closingIn(n)`。
- **服务端不动**：`emptyBrowserMs`（30s 兜底）本来就是给前端倒计时留的窗口，10s < 30s 保持成立。

## 验收

1. 解绑最后一个项目 → 卡片标题「无激活项目」→ 约 10s 后窗口自己关（`page` 收到 close）。
2. `POST /api/shutdown` / 侧栏「关闭服务器」→ 卡片标题「服务已关闭」→ 窗口自己关。
3. 倒计时期间项目回来 → 卡片消失、页面继续可用（不关窗）。
4. 标签有浏览历史（`history.length > 1`）→ 倒计时结束停在说明态，文案明确「浏览器不允许自动关闭」。
5. `pnpm check` / `pnpm test` / `pnpm build` 三条全过；新增真实 Chromium 用例覆盖 1/2/4。
