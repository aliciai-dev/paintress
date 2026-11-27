# 2026-11-27T16:34+08:00 — Stop the iframe body from clipping painted boards, and fit «All» to the measured board union

打开某些 `.pen` / `.ptr` 稿子时，画布里只剩画板顶上一条，其余部分被一条水平直线切掉（`sales-collection.pen` 的「反登记确认 · 弹窗」最典型）。

## 根因（三条机制叠在一起）

1. 渲染器把整张画布包进 `<div class="ptr-canvas" style="width:Wpx;height:Hpx">`，W/H 来自 `computeCanvas`：只取 `max(x+width)` / `max(y+height)`，**负坐标直接无视**，缺省 `height`（自动排版、由内容撑开）**按 0 计**。
2. `sales-collection.pen` 的 4 块画板里 3 块没有 `height`，其中两块 `y=228` → 画布高度被钉死在 **228px**；另有两块在负坐标（最远 x=-2355、y=-789）。
3. 查看器注入 `html,body{overflow:hidden;}`。`body` 的剪切盒就是那块 1233×228 的盒子，而画布变换只作用在 `.ptr-canvas` 上——**子元素平移不会带动父级剪切盒**。于是任何被平移到这个盒子之外的画板都只画出一条。

实测：弹窗画板在 iframe 里 top=24、height=740，可见区间只有 24..228（≈204px），切口正好落在 `body` 的 228px 下边界上。

## 改动

- `ui/src/frame-style.ts`：`html,body{overflow:hidden}` → `html{overflow:hidden}`。根元素上的 overflow 会传播到 viewport，滚动条照样没有，但 `body` 不再用那块小盒子当剪切盒。
- `ui/src/frame-viewport.ts`：`fitAll()` 适配的盒子从 `{0,0,canvas.offsetWidth,canvas.offsetHeight}` 改成画板盒的并集（`contentBox()`，可为负原点）；画板盒走 `layoutBox()`，优先用 `offsetLeft/offsetTop/offsetWidth/offsetHeight`（布局坐标＝设计稿坐标，自动排版的画板也只有布局能给真实高度），不是 canvas 直接定位子元素时退回量真实盒子再按倍率反算。
- `test/ui-interaction.spec.ts` + `test/fixtures/offscreen.pen`：新增回归用例（负坐标画板 + 自动高度画板），断言根元素仍 `hidden`、`body` 不再是剪切盒、「全部」把两块画板都框进视野、聚焦后画板 50%/90%/98% 高度处 `elementFromPoint` 都落在画板内部。

## 验证

- `pnpm check`（tsc --noEmit）通过
- `pnpm test`：34 个文件 / 472 个用例全绿
- `pnpm build`（tsdown + ui build）通过
- 反向验证：只留 `frame-style.ts` 的改动 → 新用例在「全部」断言处失败（`expected false to be true`）；两处都还原 → 新用例在 `body` overflow 断言处失败。说明这条用例同时约束两处改动。
- 真实稿验证：用本地构建的 daemon 打开 `vue-admin/design/sales-collection.pen`，「反登记确认 · 弹窗」整块显示（截图对比 0.8.1 的截断状态），点「全部」四块画板全部进入视野（35%）。

## 未做

- 没动 `computeCanvas`（渲染器侧的负原点 / 自动高度）；`paintress shot` 已经自己量画板盒，不受影响。改它会连带 `data-board-*` 的坐标语义，不在这次止血范围内。
- 未发版、未 push、未重装全局包。
