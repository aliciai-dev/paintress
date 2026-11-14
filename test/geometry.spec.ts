import { describe, expect, it } from 'vitest';
import { renderDocument } from '../src/index.js';
import { ellipsePath, needsEllipseSvg, polygonPath, polygonPoints } from '../src/render/geometry.js';
import type { PenDocument } from '../src/schema/index.js';

/**
 * 渲染器规格缺口 C1–C3：弧形/圆环、圆角多边形、网格渐变。
 * 三者的共同要求是「不再降级 + 不再警告」，所以断言同时看 HTML 和 warnings。
 */

function render(children: unknown[]): { html: string; warnings: string[] } {
  const doc = {
    version: '2.22',
    fileToken: '00000000-0000-4000-8000-000000000009',
    variables: {},
    children,
  } as unknown as PenDocument;
  const out = renderDocument(doc);
  return { html: out.html, warnings: out.warnings };
}

describe('椭圆几何（纯函数）', () => {
  it('整圆实心不需要 SVG（既有产物像素不变）', () => {
    expect(needsEllipseSvg({ width: 10, height: 10 })).toBe(false);
    expect(needsEllipseSvg({ width: 10, height: 10, sweepAngle: 360 })).toBe(false);
    expect(needsEllipseSvg({ width: 10, height: 10, sweepAngle: 90 })).toBe(true);
    expect(needsEllipseSvg({ width: 10, height: 10, innerRadius: 0.5 })).toBe(true);
  });

  it('90° 扇形：从圆心出发，一段弧，闭合', () => {
    const d = ellipsePath({ width: 200, height: 200, startAngle: 0, sweepAngle: 90 });
    expect(d.startsWith('M 100 100')).toBe(true);
    expect(d).toContain('A 100 100 0 0 0 100 0'); // 起点(200,100) → 终点(100,0)，逆时针
    expect(d.trim().endsWith('Z')).toBe(true);
  });

  it('负 sweep 走顺时针（sweep-flag=1）', () => {
    const d = ellipsePath({ width: 100, height: 100, startAngle: 0, sweepAngle: -90 });
    expect(d).toContain('A 50 50 0 0 1 50 100');
  });

  it('sweepAngle=0 是空弧，不返回任何路径', () => {
    expect(ellipsePath({ width: 100, height: 100, sweepAngle: 0 })).toBe('');
  });

  it('圆环：外圈 + 内圈两条子路径', () => {
    const d = ellipsePath({ width: 100, height: 100, innerRadius: 0.5 });
    expect(d.match(/M /g)?.length).toBe(2);
    expect(d).toContain('A 25 25');
  });
});

describe('多边形几何（纯函数）', () => {
  it('四边形顶点：−90° 起、屏幕顺时针', () => {
    const pts = polygonPoints({ width: 100, height: 100, count: 4 });
    expect(pts[0]?.x).toBeCloseTo(50);
    expect(pts[0]?.y).toBeCloseTo(0);
    expect(pts[1]?.x).toBeCloseTo(100);
    expect(pts[1]?.y).toBeCloseTo(50);
  });

  it('非正方多边形按每个顶点的真实内角退让', () => {
    const d = polygonPath({ width: 200, height: 100, count: 4, cornerRadius: 10 });
    // 顶角内角 126.87° → d=5；侧角内角 53.13° → d=20
    expect(d).toContain('M 95.528 2.236');
    expect(d).toContain('L 182.111 41.056');
  });

  it('圆角不小于 0 时用二次贝塞尔过渡，尖角时就是直线', () => {
    expect(polygonPath({ width: 100, height: 100, count: 4, cornerRadius: 0 })).not.toContain('Q');
    const rounded = polygonPath({ width: 100, height: 100, count: 4, cornerRadius: 10 });
    expect(rounded.match(/Q /g)?.length).toBe(4);
  });
});

describe('渲染：C1 弧形 / 圆环', () => {
  it('扇形出 SVG，不再有 border-radius 与降级警告', () => {
    const { html, warnings } = render([
      { type: 'ellipse', id: 'arc', width: 200, height: 200, startAngle: 0, sweepAngle: 90, fill: '#123456' },
    ]);
    expect(html).toContain('viewBox="0 0 200 200"');
    expect(html).toContain('fill="#123456"');
    expect(html).not.toContain('border-radius:50%');
    expect(warnings).toEqual([]);
  });

  it('圆环用 evenodd 挖空，尺寸/描边走 SVG 属性', () => {
    const { html, warnings } = render([
      {
        type: 'ellipse',
        id: 'ring',
        width: 100,
        height: 100,
        innerRadius: 0.5,
        fill: '#205080',
        stroke: '#908030',
        strokeWidth: 2,
      },
    ]);
    expect(html).toContain('fill-rule="evenodd"');
    expect(html).toContain('stroke="#908030"');
    expect(html).toContain('stroke-width="2"');
    expect(warnings).toEqual([]);
  });

  it('sweepAngle=0 不画形状，并明确警告空弧', () => {
    const { html, warnings } = render([
      { type: 'ellipse', id: 'empty', width: 100, height: 100, sweepAngle: 0, fill: '#FF0000' },
    ]);
    expect(html).toContain('d=""');
    expect(html).not.toContain('border-radius:50%');
    expect(warnings.join('\n')).toContain('空弧不绘制');
  });

  it('整圆实心仍走 div（回归保护）', () => {
    const { html } = render([{ type: 'ellipse', id: 'dot', width: 40, height: 40, fill: '#000000' }]);
    expect(html).toContain('border-radius:50%');
    expect(html).not.toContain('<svg viewBox="0 0 40 40"');
  });
});

describe('渲染：C2 圆角多边形', () => {
  it('有 cornerRadius 且尺寸显式 → 走 SVG path，不再忽略', () => {
    const { html, warnings } = render([
      { type: 'polygon', id: 'tri', width: 120, height: 100, polygonCount: 3, cornerRadius: 8, fill: '#ABCDEF' },
    ]);
    expect(html).toContain('viewBox="0 0 120 100"');
    expect(html).toContain('Q ');
    expect(html).not.toContain('clip-path');
    expect(warnings).toEqual([]);
  });

  it('没有圆角时保持 clip-path（旧产物不变）', () => {
    const { html } = render([{ type: 'polygon', id: 'tri2', width: 120, height: 100, polygonCount: 3 }]);
    expect(html).toContain('clip-path:polygon(');
  });
});

describe('渲染：C3 网格渐变', () => {
  const mesh = (colors: string[], columns = 2, rows = 2) => ({
    type: 'mesh_gradient',
    columns,
    rows,
    colors,
  });

  it('2×2 四色出 4 层径向渐变 + 平均底色，不再退化成单色', () => {
    const { html, warnings } = render([
      { type: 'rectangle', id: 'mesh', width: 100, height: 100, fill: [mesh(['#FF0000', '#00FF00', '#0000FF', '#FFFFFF'])] },
    ]);
    expect(html.match(/radial-gradient\(ellipse /g)?.length).toBe(4);
    expect(html).toContain('background-color:rgb(128 128 128)'); // 四色平均
    expect(warnings).toEqual([]);
  });

  it('颜色数不够 → 保持降级并说明原因', () => {
    const { html, warnings } = render([
      { type: 'rectangle', id: 'mesh2', width: 100, height: 100, fill: [mesh(['#FF0000'])] },
    ]);
    expect(html).toContain('background-color:#FF0000');
    expect(warnings.join('\n')).toMatch(/mesh_gradient.*降级为首个顶点色/);
  });
});
