# 2026-11-14T20:52+08:00 — 渲染器规格缺口 C1–C3（弧形/圆环、圆角多边形、网格渐变）

规格：`specs/renderer-gaps.md`。目标不是「能画」，而是**不再降级、不再警告**。

## 改动

### C1 椭圆：弧形与圆环（`src/render/geometry.ts` + `html.ts`）

- 角度按 `format/spec.yaml`：0° 正右、逆时针为正、sweep 正逆负顺；SVG 的 sweep-flag 相应取反。
- 整圆实心**仍走原来的 div + border-radius**（像素不变）；只有 `innerRadius > 0` 或 `|sweep| < 360` 才换 SVG。
- 扇形（inner=0）从圆心出发；扇环用外弧 + 内弧回走的闭合路径；整圆环用两条子路径 + `fill-rule: evenodd`。
- 坐标系用**画板像素**（viewBox = `0 0 w h`），描边不会被非等比缩放拉变形。
- 填充只支持纯色：渐变/图片把形状换回旧渲染并解释一句（不画一个「矩形底色」骗人）。
  描边同样只认单层单色、非逐边；否则降级。

### C2 多边形圆角

- `clip-path: polygon()` 画不了圆角 → 生成 SVG path：每个顶点退让 `d = r / tan(内角/2)`（上限 45% 边长），
  用二次贝塞尔过顶点。顶点取法与旧 clip-path 一致（−90° 起、屏幕顺时针），所以位置不漂。
- 需要显式数值宽高（圆角是 px 量，不能归一化）；拿不到就退回 clip-path + 警告。

### C3 mesh_gradient

- 每个网格点一层 `radial-gradient(ellipse …, 该点颜色 0%, transparent 72%)`，底下垫平均色；
  按预乘 alpha 插值叠出平滑网格。`columns × rows` 行主序（spec 定义）。
- 网格不完整（列/行缺失、颜色数不够）或超过 144 格 → 保持旧的「首个顶点色 + 警告」。
- 顺手修了 `averageColor` 的正则：非捕获组导致永远取不到数字，四色平均会抛错。

## 验证

- 新增 `test/geometry.spec.ts`（13 用例）：纯函数几何（扇形两段弧、负 sweep 的 flag、圆环两子路径、
  多边形顶点与圆角贝塞尔）+ 渲染层断言（viewBox、evenodd、无 clip-path、四种降级分支）。
- 真机出图核对：270° 扇形、300° 圆环（inner=0.6）、圆角六边形、2×2 网格渐变，方向与颜色符合规格。
- 双端 `tsc` 0 错误、27 文件 350 用例全绿、`pnpm build` 通过。

## 未做

- `shader`（WebGL）、图标库扩展、离线文字度量、`imports`、逐边描边 + outer/center：
  按 `FUTURE.md` 的触发条件延期。
