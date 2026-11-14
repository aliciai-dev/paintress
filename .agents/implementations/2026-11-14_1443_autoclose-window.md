# 2026-11-14T14:43+08:00 — 全收工后窗口自己关；倒计时卡片重做

operator 截图：agent 全收工后页面停在「服务已关闭 / 可以关闭此页面」，人要自己去点标签页的 ×。原需求是「发现全关了就倒计时自动关掉，不需要人手动关」。查下来那段 10s 倒计时只挂在「项目归零」这一条路径上，daemon shutdown 直接进静态页；而且当时没人验证过 `window.close()` 到底能不能关。

## 先定事实：`window.close()` 什么条件下能关

真 Chrome（`/usr/bin/google-chrome`，playwright-core 走 CDP 接管）实测：

| 场景 | history.length | 结果 |
| --- | --- | --- |
| 浏览器按命令行 URL 打开的标签（daemon 的真实路径） | 1 | **关掉了** |
| 同上，再 `pushState` ×2 | 3 | 被拒：`Scripts may close only the windows that were opened by them.` |
| 同上，改用 `replaceState` ×2 | 1（不增长） | **关掉了** |
| Playwright `newPage()` 后 `goto`（先停在 about:blank） | 2 | 被拒 |

结论：**关键不是「谁打开的」，而是这个标签有没有浏览历史**；单条历史的标签允许脚本关闭，`--headless=new` 下同样成立。查看器自身路由只用 `replaceState`（`syncUrl`），所以正常路径关得掉；只有人先在同一个标签里跳转过别处才会落到说明态。这条实测同时解释了「不就一个 js 吗」——js 本身没问题，缺的是把倒计时接在 shutdown 路径上。

## 改动

### 1. 统一自动关窗流程：`ui/src/App.tsx`

- 新增 `leaveReason: 'idle' | 'closed'`、`closeBlocked`；`LEAVE_SECONDS = 10`、`RING_LEN = 2πr` 提到模块级。
- 三个入口收进 `startLeave(reason)`：项目归零（idle）、注册表 SSE `shutdown`（closed）、侧栏「关闭服务器」确认后（closed）。
  已在倒计时时只允许 `idle → closed` 升级、**不重置秒数**；`closed` 之后不再重开（唯一回去的路是 agent 重新接入 → `stopLeave`）。
- `finishLeave()`：idle 时先 best-effort `POST /api/shutdown`，再 `setClosed(true)` + `window.close()`；
  600ms 后页面还活着 → `closeBlocked`，卡片换成「浏览器不允许自动关闭，请手动关掉这个标签」。定时器在 `stopLeave` 里清掉，不会串到下一次。
- 项目回来（`projects.length > 0`）→ `stopLeave()` 撤销倒计时 / closed / blocked，页面继续可用。
- 手动「关闭服务器」不再是「停进程 + 静态页」，而是「停进程 + 同一套倒计时关窗」。

### 2. 倒计时卡片视觉：`ui/src/styles.css`

- 细线进度条（`.countdown-track` / `.countdown-fill`）删掉，换成 72px 环形进度（SVG `stroke-dashoffset` 每秒线性过渡）+ 居中秒数（21px/650，tabular）。
- 顶部 2px 蓝→金发丝线（`--accent` → `--gold`，D-007 的两色），纸白卡片、12px 圆角，与侧栏/确认框同一套面子。
- 最后 3 秒 `.urgent`：环与数字转 logo 金——是「马上要关」，不是报错。
- 入场 220ms 上浮淡入；`prefers-reduced-motion` 下动画与过渡都关掉。
- 新增 `.sr-only`：秒数只在环里出现一次，读屏靠 `closingIn(n)` 播报。

### 3. 文案：`ui/src/i18n.ts`

- 标题按原因分（`serverClosed` / `noActiveProjects`）；新增 `closingAuto`、`closingWaitAgent`（正文不再重复秒数）、`closeBlockedHint`，中英同步。
- README 双语补一句「最后一个项目收走**或服务被关掉**时页面自己倒计时关窗」。

## 验证

- 新增 `test/viewer-leave.spec.ts`（真实 Chromium + `ui/dist`，3 用例）：
  1. `POST /api/shutdown` → 卡片出现（标题「服务已关闭」）→ 标签 `close` 事件到达；
  2. 解绑最后一个项目 → 卡片（「无激活项目」）→ 标签自己关 + 进程退出；
  3. 标签 `history.pushState` 后再关闭 → 关不掉，停在说明态且文案提到浏览器拒绝。
  用例把 1s tick 注入成 200ms（不注入就得真等 10s）；用 `--remote-debugging-port` + CDP 接管，是为了拿到 **history.length === 1** 的标签——`browser.newPage()` 拿到的是 2，会假失败。
- `pnpm check`（根）0 错误；`pnpm --dir ui typecheck` 0 错误；`pnpm test` **23 文件 300 用例全绿**；`pnpm build` 通过。
- 真机截图核对（zh / en 各一版）：`10` 蓝环 + 「服务已关闭 / 无激活项目」、末段金环，关不掉时是「服务已关闭 + 浏览器不允许自动关闭」。

## 未做

- 没有验证 Firefox / Safari 的关窗策略（本机只有 Chrome/Chromium；`findBrowser` 也只找 Chromium 系）。
- daemon 侧策略未动：`emptyBrowserMs`（30s）仍在 10s 之后兜底；没加「用 `--app` 窗口打开」这类为了关窗而改窗口形态的做法。
- 全局安装的 paintress 还是旧版（按分工由 operator 重新安装后才生效）。
