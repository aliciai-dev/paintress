# 渲染器规格缺口（C1–C3）

- 状态：C1–C3 已实现（2026-11-14），记录见 `.agents/implementations/2026-11-14_2052_renderer-c-batch.md`

> 目标是「不再降级 + 不再警告」的三项。`format/spec.yaml` 是唯一事实来源；
> 其余缺口（shader / 图标库 / 离线文字度量 / imports / 逐边描边）见 `FUTURE.md`。

## C1 — 椭圆：弧形与圆环

- **规格**（`spec.yaml §nodes.ellipse`）：`innerRadius` 0–1 为内外半径比；`startAngle` 度、**0° 在正右、逆时针为正**；`sweepAngle` −360–360，正逆负顺。
- **做法**：`type: 'ellipse'` 不再用 `border-radius: 50%` 的 div，改为内联 SVG（保留 `data-node-id` 等属性在容器上）：
  - 整圆：`<circle>`；`innerRadius > 0` 且 sweep 满 360 → `<path>`（外圆 + 内圆反向，`fill-rule: evenodd`）或 `stroke-width = (1-innerRadius) × r` 的圆；
  - 弧形：`<path>` 的 `A` 弧命令；sweep > 360 截断到 360，sweep = 0 则不画（警告「空弧」）。
  - 负 sweep（顺时针）在 SVG 里用 `sweep-flag=0` 表达，不额外翻坐标。
- **验收**：三种情形（90° 扇形、270° 缺口、`innerRadius=0.5` 圆环）几何正确；不再出现「暂按实心/整圆渲染」警告；既有整圆产物像素不变。

## C2 — 多边形圆角

- **规格**：`polygon.cornerRadius`（num_or_var），单位与设计稿一致。
- **做法**：`clip-path: polygon()` 无法圆角 → 改为生成 SVG `<path>`：
  每个顶点按**真实内角**计算切点退让距离 `d = cornerRadius / tan(内角/2)`（上限为相邻边长的 45%），切点之间用二次贝塞尔，控制点为原顶点；非正方多边形不套正多边形内角。
  顶点坐标沿用现有 `polygonClip` 的取点规则（−90° 起、逆时针），保证与旧产物的位置一致。
- **验收**：`polygonCount=3/5/6` + `cornerRadius=0/8` 四组渲染正确（0 时与原产物一致）；不再有「多边形圆角暂忽略」警告。

## C3 — mesh_gradient 网格渐变

- **规格**：`columns × rows` 个 `colors`，**行主序**；可选 `points`（本项缺失，按均匀网格处理）。
- **做法**：CSS 多层 `radial-gradient` 叠加近似——每个网格点为圆心、按到四邻的距离做双线性插值，得到一层径向渐变；
  颜色统一换算成 `rgba()` 以便叠色；`background-blend-mode: normal` + 由远到近的层序。
  网格点缺失/颜色数与 `columns×rows` 不符 → 保持现有降级（首顶点色）并给警告。
- **验收**：2×2 四色渐变不再退化成单色；与源稿视觉方向一致（同色域、中心色正确）；`test/render.spec.ts` 加几何/颜色断言，
  避免「看起来差不多」也算过。

## 不做（本轮）

- `shader` 填充与效果：需要 WebGL/GLSL 渲染后端，成本远超其余三项。
- 图标库扩展：每套图标数据都在数百 KB 以上。
- 离线文字度量：浏览器测量已够用；离线要自带字形度量。
- `imports` 跨文件引用：格式语法仍是 TBD（`spec.yaml §known_gaps`）。
- 逐边描边宽度 + `outer/center` 同时成立：`strokeAlignment` 本身已按 outline 实现，只剩「四边宽度不同且非 inner」这一小口子。
