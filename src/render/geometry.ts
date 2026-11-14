import type { VarResolver } from './vars.js';

/**
 * 圆弧 / 圆环 / 圆角多边形的几何（C1、C2）。
 *
 * 只产出**路径字符串**，坐标系是画板像素（viewBox = `0 0 w h`），
 * 这样描边宽度不会被非等比缩放拉变形。尺寸拿不到数值时调用方退回旧渲染（+ 警告），
 * 不在几何层猜尺寸。
 *
 * 角度约定（format/spec.yaml §nodes.ellipse）：0° 在正右、逆时针为正、sweep 正逆负顺；
 * 而 SVG 的 y 轴向下、sweep-flag=1 是顺时针，所以正向扇形的 flag 是 0。
 */

const TAU = Math.PI * 2;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export interface Point {
  x: number;
  y: number;
}

/** 角度 → 椭圆上的点（度，0° 正右，逆时针为正；渲染坐标系 y 向下） */
export function ellipsePoint(cx: number, cy: number, rx: number, ry: number, deg: number): Point {
  const a = (deg * Math.PI) / 180;
  return { x: cx + rx * Math.cos(a), y: cy - ry * Math.sin(a) };
}

function fmt(n: number): string {
  // 3 位小数足够；去掉尾随 0，路径短一点
  return String(Math.round(n * 1000) / 1000);
}

function arcTo(rx: number, ry: number, large: boolean, ccw: boolean, p: Point): string {
  // SVG：sweep-flag=1 为「正角方向」（屏幕上顺时针）；数学上的逆时针 = 0
  return `A ${fmt(rx)} ${fmt(ry)} 0 ${large ? 1 : 0} ${ccw ? 0 : 1} ${fmt(p.x)} ${fmt(p.y)}`;
}

export interface EllipseGeometryInput {
  width: number;
  height: number;
  /** 0° 正右、逆时针为正 */
  startAngle?: number;
  /** 正逆负顺，−360..360；缺省 360 */
  sweepAngle?: number;
  /** 内外半径比 0..1（0 实心、1 空心到没有厚度） */
  innerRadius?: number;
}

/** 是否需要走 SVG（整圆实心仍旧用 div 渲染，保证既有产物像素不变） */
export function needsEllipseSvg(input: EllipseGeometryInput): boolean {
  const sweep = input.sweepAngle ?? 360;
  const inner = input.innerRadius ?? 0;
  return inner > 0 || Math.abs(sweep) < 360;
}

/**
 * 椭圆形状的 SVG path（px 坐标）。
 * - inner=0 + 整圆：不在本函数处理（调用方用 div）
 * - 整圆 + inner>0：外圆 + 内圆（evenodd）
 * - 部分弧：扇形（inner=0）或扇环（inner>0）
 */
export function ellipsePath(input: EllipseGeometryInput): string {
  const w = Math.max(1, input.width);
  const h = Math.max(1, input.height);
  const cx = w / 2;
  const cy = h / 2;
  const rx = w / 2;
  const ry = h / 2;
  const start = input.startAngle ?? 0;
  const sweepRaw = input.sweepAngle ?? 360;
  const sweep = Math.max(-360, Math.min(360, sweepRaw));
  const inner = Math.max(0, Math.min(1, input.innerRadius ?? 0));

  const full = Math.abs(sweep) >= 360 || sweep === 0;
  if (full) {
    const rix = rx * inner;
    const riy = ry * inner;
    if (inner <= 0) {
      // 整圆：两条半圆弧拼回起点
      return `M ${fmt(cx - rx)} ${fmt(cy)} ${arcTo(rx, ry, false, true, { x: cx + rx, y: cy })} ${arcTo(rx, ry, false, true, { x: cx - rx, y: cy })} Z`;
    }
    // 圆环：外圈 + 内圈，evenodd 挖空
    const outer = `M ${fmt(cx - rx)} ${fmt(cy)} ${arcTo(rx, ry, false, true, { x: cx + rx, y: cy })} ${arcTo(rx, ry, false, true, { x: cx - rx, y: cy })} Z`;
    const innerRing = `M ${fmt(cx - rix)} ${fmt(cy)} ${arcTo(rix, riy, false, true, { x: cx + rix, y: cy })} ${arcTo(rix, riy, false, true, { x: cx - rix, y: cy })} Z`;
    return `${outer} ${innerRing}`;
  }

  const a0 = start;
  const a1 = start + sweep;
  const large = Math.abs(sweep) > 180;
  const ccw = sweep > 0;
  const p0 = ellipsePoint(cx, cy, rx, ry, a0);
  const p1 = ellipsePoint(cx, cy, rx, ry, a1);

  if (inner <= 0) {
    // 扇形：圆心 → 起点弧 → 终点
    return `M ${fmt(cx)} ${fmt(cy)} L ${fmt(p0.x)} ${fmt(p0.y)} ${arcTo(rx, ry, large, ccw, p1)} Z`;
  }

  const rix = rx * inner;
  const riy = ry * inner;
  const q0 = ellipsePoint(cx, cy, rix, riy, a0);
  const q1 = ellipsePoint(cx, cy, rix, riy, a1);
  // 外弧顺走、内弧回走（sweep 取反）
  return [
    `M ${fmt(p0.x)} ${fmt(p0.y)}`,
    arcTo(rx, ry, large, ccw, p1),
    `L ${fmt(q1.x)} ${fmt(q1.y)}`,
    arcTo(rix, riy, large, !ccw, q0),
    'Z',
  ].join(' ');
}

export interface PolygonGeometryInput {
  width: number;
  height: number;
  /** 边数，缺省 3 */
  count?: number;
  /** 圆角半径（px）；<=0 即尖角 */
  cornerRadius?: number;
}

/** 多边形顶点：−90° 起、按屏幕顺时针排，和旧 clip-path 的位置一致 */
export function polygonPoints(input: PolygonGeometryInput): Point[] {
  const w = Math.max(1, input.width);
  const h = Math.max(1, input.height);
  const n = Math.max(3, Math.round(input.count ?? 3));
  const cx = w / 2;
  const cy = h / 2;
  const rx = w / 2;
  const ry = h / 2;
  const pts: Point[] = [];
  for (let i = 0; i < n; i++) {
    const a = ((-90 + (360 / n) * i) * Math.PI) / 180;
    pts.push({ x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) });
  }
  return pts;
}

/**
 * 圆角多边形：每个顶点按内切圆半径 r 退让 d = r / tan(内角/2)，
 * 用二次贝塞尔过顶点圆角。d 被限制在相邻边长的 45% 以内，避免小边被吃穿。
 */
export function polygonPath(input: PolygonGeometryInput): string {
  const pts = polygonPoints(input);
  const n = pts.length;
  const r = Math.max(0, input.cornerRadius ?? 0);
  if (r <= 0) {
    return `M ${pts.map((p) => `${fmt(p.x)} ${fmt(p.y)}`).join(' L ')} Z`;
  }
  const halfAngle = ((Math.PI * (n - 2)) / n) / 2; // 正多边形内角的一半
  const dWant = r / Math.tan(halfAngle);
  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    const prev = pts[(i - 1 + n) % n] as Point;
    const cur = pts[i] as Point;
    const next = pts[(i + 1) % n] as Point;
    const v0 = { x: prev.x - cur.x, y: prev.y - cur.y };
    const v1 = { x: next.x - cur.x, y: next.y - cur.y };
    const len0 = Math.hypot(v0.x, v0.y) || 1;
    const len1 = Math.hypot(v1.x, v1.y) || 1;
    const d = Math.min(dWant, len0 * 0.45, len1 * 0.45);
    const a = { x: cur.x + (v0.x / len0) * d, y: cur.y + (v0.y / len0) * d };
    const b = { x: cur.x + (v1.x / len1) * d, y: cur.y + (v1.y / len1) * d };
    parts.push(i === 0 ? `M ${fmt(a.x)} ${fmt(a.y)}` : `L ${fmt(a.x)} ${fmt(a.y)}`);
    parts.push(`Q ${fmt(cur.x)} ${fmt(cur.y)} ${fmt(b.x)} ${fmt(b.y)}`);
  }
  parts.push('Z');
  return parts.join(' ');
}

/** 顶层实色（填充列表里最后一层生效的 color）；有渐变/图片/关闭层里夹着色时返回只认纯色的那一层 */
export function solidFillColor(fill: unknown, vars: VarResolver): string | null {
  const entries = Array.isArray(fill) ? fill : fill === undefined ? [] : [fill];
  let color: string | null = null;
  for (const entry of entries) {
    if (typeof entry === 'string') {
      color = vars.resolve(entry);
      continue;
    }
    if (!isRecord(entry)) continue;
    if (vars.resolveBool(entry['enabled'] as boolean | string) === false) continue;
    if (entry['type'] !== 'color') return null; // 渐变/图片/shader：本形状不支持，交给调用方降级
    const c = entry['color'];
    if (typeof c === 'string') color = vars.resolve(c);
  }
  return color;
}

export interface StrokeSpec {
  color: string;
  width: number;
}

/** 单层、单色、非逐边的描边（否则返回 null，调用方降级） */
export function simpleStroke(node: Record<string, unknown>, vars: VarResolver): StrokeSpec | null {
  const raw = node['stroke'];
  if (raw === undefined) return null;
  const entries = Array.isArray(raw) ? raw : [raw];
  const enabled = entries.filter((e) => !(isRecord(e) && vars.resolveBool(e['enabled'] as boolean | string) === false));
  if (enabled.length !== 1) return null;
  const entry = enabled[0];
  const widthRaw = node['strokeWidth'];
  if (isRecord(widthRaw)) return null; // 逐边宽度：SVG 单路径表达不了
  let color: string | null = null;
  if (typeof entry === 'string') color = vars.resolve(entry);
  else if (isRecord(entry) && entry['type'] === 'color' && typeof entry['color'] === 'string') color = vars.resolve(entry['color']);
  if (color === null) return null;
  const width = vars.resolveNum(widthRaw as number | string) ?? 1;
  return { color, width };
}
