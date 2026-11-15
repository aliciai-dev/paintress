import { z } from 'zod';
import { BoolOrVar, ColorOrVar, CornerRadius, NumOrVar, Padding, Sizing, StringOrVar } from './scalars.js';
import { CrossAxis, MainAxis, LayoutDir, PositionMode, StrokeAlign, StrokeCap, StrokeJoin } from './enums.js';
import { GraphicsBlock } from './styles.js';
import type { Effects, Fills, StrokeWidth } from './styles.js';
import type { AssertSame, TypedObject, TypedSchema } from './typed.js';

/** 规格来源：format/spec.yaml §node_base、§layout_block、§nodes（v0.2.0） */

/* ================================================================== *
 * 公共类型面（手写）
 *
 * 为什么手写而不直接 `z.infer`：passthrough 的推断类型在 .d.ts 里会被整段序列化，
 * 14 个节点变体叠加后既超过 TS 的序列化上限（TS7056），也让包体从 164 KB 涨到 1.6 MB。
 * 这里给出稳定的公共形状，schema 的输出类型标注到它上面；两者的一致性由文件末尾的
 * 编译期断言（`AssertSame`）把关，字段一改错就会在 `pnpm check` 阶段报出来。
 *
 * `[key: string]: unknown` 索引签名对应 schema 的 passthrough 语义：未知键透传保留。
 * ================================================================== */

/** 节点公共基座。id 必填且禁含 '/'（保留给 ref 后代路径）。 */
export interface NodeBaseFields {
  id: string;
  name?: string;
  context?: string;
  reusable?: boolean;
  theme?: Record<string, string>;
  enabled?: BoolOrVar;
  opacity?: NumOrVar;
  flipX?: BoolOrVar;
  flipY?: BoolOrVar;
  layoutPosition?: PositionMode;
  metadata?: { type: string; [key: string]: unknown };
  rotation?: NumOrVar;
  x?: number;
  y?: number;
  width?: Sizing;
  height?: Sizing;
  [key: string]: unknown;
}

/** 布局块（容器持有）。规格默认：layout=horizontal、gap=0、justify/align=start。 */
export interface LayoutFields {
  layout?: LayoutDir;
  gap?: NumOrVar;
  padding?: Padding;
  justifyContent?: MainAxis;
  alignItems?: CrossAxis;
  layoutIncludeStroke?: boolean;
}

/** 图形块：填充、描边、效果。 */
export interface GraphicsFields {
  fill?: Fills;
  stroke?: Fills;
  strokeWidth?: StrokeWidth;
  strokeLinecap?: StrokeCap;
  strokeLinejoin?: StrokeJoin;
  strokeAlignment?: StrokeAlign;
  effect?: Effects;
}

export interface FrameNode extends NodeBaseFields, LayoutFields, GraphicsFields {
  type: 'frame';
  clip?: BoolOrVar;
  placeholder?: boolean;
  slot?: false | string[];
  cornerRadius?: CornerRadius;
  children?: unknown[];
}

export interface GroupNode extends NodeBaseFields {
  type: 'group';
  effect?: unknown;
  children?: unknown[];
}

export interface RectangleNode extends NodeBaseFields, GraphicsFields {
  type: 'rectangle';
  cornerRadius?: CornerRadius;
}

export interface EllipseNode extends NodeBaseFields, GraphicsFields {
  type: 'ellipse';
  innerRadius?: NumOrVar;
  startAngle?: NumOrVar;
  sweepAngle?: NumOrVar;
}

export interface PolygonNode extends NodeBaseFields, GraphicsFields {
  type: 'polygon';
  polygonCount?: NumOrVar;
  cornerRadius?: NumOrVar;
}

export interface PathNode extends NodeBaseFields, GraphicsFields {
  type: 'path';
  geometry?: string;
  fillRule?: 'nonzero' | 'evenodd';
  viewBox?: [number, number, number, number];
}

export interface TextNode extends NodeBaseFields, GraphicsFields {
  type: 'text';
  content?: StringOrVar;
  textGrowth?: 'auto' | 'fixed-width' | 'fixed-width-height';
  fontFamily?: StringOrVar;
  fontSize?: NumOrVar;
  fontWeight?: StringOrVar;
  letterSpacing?: NumOrVar;
  fontStyle?: StringOrVar;
  underline?: BoolOrVar;
  lineHeight?: NumOrVar;
  textAlign?: 'left' | 'center' | 'right' | 'justify';
  textAlignVertical?: 'top' | 'middle' | 'bottom';
  strikethrough?: BoolOrVar;
  href?: string;
}

export interface NoteNode extends NodeBaseFields {
  type: 'note';
  content?: StringOrVar;
  color?: ColorOrVar;
}

export interface IconNode extends NodeBaseFields {
  type: 'icon';
  library?: string;
  icon?: StringOrVar;
  weight?: NumOrVar;
  fill?: unknown;
}

/** 上游设计工具的图标节点写法（`iconFontName` + `iconFontFamily`），语义与 `icon` 等价。 */
export interface IconFontNode extends NodeBaseFields {
  type: 'icon_font';
  iconFontFamily?: string;
  iconFontName?: StringOrVar;
  weight?: NumOrVar;
  fill?: unknown;
}

export interface ScriptNode extends NodeBaseFields {
  type: 'script';
  scriptUri?: string;
  inputs?: Record<string, string | number | boolean>;
  clip?: BoolOrVar;
}

export interface BrowserNode extends NodeBaseFields {
  type: 'browser';
  url?: string;
  deviceId?: string;
  zoom?: number;
  scrollX?: number;
  scrollY?: number;
  cornerRadius?: CornerRadius;
  effect?: unknown;
  stroke?: unknown;
  strokeWidth?: unknown;
  strokeLinecap?: unknown;
  strokeLinejoin?: unknown;
  strokeAlignment?: unknown;
}

/** ref：组件实例。ref 上直接出现的其他属性 = 对组件根的覆写（passthrough 承载）。 */
export interface RefNode extends NodeBaseFields {
  type: 'ref';
  ref: string;
  descendants?: Record<string, unknown>;
}

/** 未知节点类型：宽松兜底。 */
export interface UnknownNode {
  type: string;
  id?: string;
  [key: string]: unknown;
}

/** 完整节点 union：已知 13 种 + 未知兜底。 */
export type PenNode =
  | FrameNode
  | GroupNode
  | RectangleNode
  | EllipseNode
  | PolygonNode
  | PathNode
  | TextNode
  | NoteNode
  | IconNode
  | IconFontNode
  | ScriptNode
  | BrowserNode
  | RefNode
  | UnknownNode;

/* ================================================================== *
 * 运行时 schema
 * ================================================================== */

/** 节点公共基座。id 必填且禁含 '/'（保留给 ref 后代路径）。 */
export const NodeBase = {
  id: z.string().regex(/^[^/]+$/, 'id 禁止包含 / （保留给 ref 后代路径）'),
  name: z.string().optional(),
  context: z.string().optional(),
  reusable: z.boolean().optional(),
  theme: z.record(z.string()).optional(),
  enabled: BoolOrVar.optional(),
  opacity: NumOrVar.optional(),
  flipX: BoolOrVar.optional(),
  flipY: BoolOrVar.optional(),
  layoutPosition: PositionMode.optional(),
  metadata: z.object({ type: z.string() }).passthrough().optional(),
  rotation: NumOrVar.optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  width: Sizing.optional(),
  height: Sizing.optional(),
};

/** 布局块（容器持有）。规格默认：layout=horizontal、gap=0、justify/align=start。 */
export const LayoutBlock = {
  layout: LayoutDir.optional(),
  gap: NumOrVar.optional(),
  padding: Padding.optional(),
  justifyContent: MainAxis.optional(),
  alignItems: CrossAxis.optional(),
  layoutIncludeStroke: z.boolean().optional(),
};

const sizeBlock = {
  width: Sizing.optional(),
  height: Sizing.optional(),
};

const frameObject = z
  .object({
    type: z.literal('frame'),
    ...NodeBase,
    ...LayoutBlock,
    ...GraphicsBlock,
    clip: BoolOrVar.optional(),
    placeholder: z.boolean().optional(),
    slot: z.union([z.literal(false), z.array(z.string())]).optional(),
    cornerRadius: CornerRadius.optional(),
    children: z.array(z.unknown()).optional(),
  })
  .passthrough();

export const FrameSchema: TypedObject<FrameNode> = frameObject;

const groupObject = z
  .object({
    type: z.literal('group'),
    ...NodeBase,
    effect: z.unknown().optional(),
    children: z.array(z.unknown()).optional(),
  })
  .passthrough();

export const GroupSchema: TypedObject<GroupNode> = groupObject;

const rectangleObject = z
  .object({
    type: z.literal('rectangle'),
    ...NodeBase,
    ...sizeBlock,
    ...GraphicsBlock,
    cornerRadius: CornerRadius.optional(),
  })
  .passthrough();

export const RectangleSchema: TypedObject<RectangleNode> = rectangleObject;

const ellipseObject = z
  .object({
    type: z.literal('ellipse'),
    ...NodeBase,
    ...sizeBlock,
    ...GraphicsBlock,
    innerRadius: NumOrVar.optional(),
    startAngle: NumOrVar.optional(),
    sweepAngle: NumOrVar.optional(),
  })
  .passthrough();

export const EllipseSchema: TypedObject<EllipseNode> = ellipseObject;

const polygonObject = z
  .object({
    type: z.literal('polygon'),
    ...NodeBase,
    ...sizeBlock,
    ...GraphicsBlock,
    polygonCount: NumOrVar.optional(),
    cornerRadius: NumOrVar.optional(),
  })
  .passthrough();

export const PolygonSchema: TypedObject<PolygonNode> = polygonObject;

const pathObject = z
  .object({
    type: z.literal('path'),
    ...NodeBase,
    ...sizeBlock,
    ...GraphicsBlock,
    geometry: z.string().optional(),
    fillRule: z.enum(['nonzero', 'evenodd']).optional(),
    viewBox: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
  })
  .passthrough();

export const PathSchema: TypedObject<PathNode> = pathObject;

const textObject = z
  .object({
    type: z.literal('text'),
    ...NodeBase,
    ...sizeBlock,
    ...GraphicsBlock,
    content: StringOrVar.optional(),
    textGrowth: z.enum(['auto', 'fixed-width', 'fixed-width-height']).optional(),
    fontFamily: StringOrVar.optional(),
    fontSize: NumOrVar.optional(),
    fontWeight: StringOrVar.optional(),
    letterSpacing: NumOrVar.optional(),
    fontStyle: StringOrVar.optional(),
    underline: BoolOrVar.optional(),
    lineHeight: NumOrVar.optional(),
    textAlign: z.enum(['left', 'center', 'right', 'justify']).optional(),
    textAlignVertical: z.enum(['top', 'middle', 'bottom']).optional(),
    strikethrough: BoolOrVar.optional(),
    href: z.string().optional(),
  })
  .passthrough();

export const TextSchema: TypedObject<TextNode> = textObject;

const noteObject = z
  .object({
    type: z.literal('note'),
    ...NodeBase,
    ...sizeBlock,
    content: StringOrVar.optional(),
    color: ColorOrVar.optional(),
  })
  .passthrough();

export const NoteSchema: TypedObject<NoteNode> = noteObject;

const iconObject = z
  .object({
    type: z.literal('icon'),
    ...NodeBase,
    ...sizeBlock,
    library: z.string().optional(),
    icon: StringOrVar.optional(),
    weight: NumOrVar.optional(),
    fill: z.unknown().optional(),
  })
  .passthrough();

export const IconSchema: TypedObject<IconNode> = iconObject;

/**
 * icon_font：上游设计工具的图标节点写法（`iconFontName` + `iconFontFamily`）。
 * 语义与 `icon`（`icon` + `library`）等价，仅字段名不同；渲染与校验按同一套处理。
 */
const iconFontObject = z
  .object({
    type: z.literal('icon_font'),
    ...NodeBase,
    ...sizeBlock,
    iconFontFamily: z.string().optional(),
    iconFontName: StringOrVar.optional(),
    weight: NumOrVar.optional(),
    fill: z.unknown().optional(),
  })
  .passthrough();

export const IconFontSchema: TypedObject<IconFontNode> = iconFontObject;

const scriptObject = z
  .object({
    type: z.literal('script'),
    ...NodeBase,
    ...sizeBlock,
    scriptUri: z.string().optional(),
    inputs: z.record(z.union([z.string(), z.number(), z.boolean(), z.string().regex(/^\$.+/)]))
      .optional(),
    clip: BoolOrVar.optional(),
  })
  .passthrough();

export const ScriptSchema: TypedObject<ScriptNode> = scriptObject;

const browserObject = z
  .object({
    type: z.literal('browser'),
    ...NodeBase,
    ...sizeBlock,
    url: z.string().optional(),
    deviceId: z.string().optional(),
    zoom: z.number().optional(),
    scrollX: z.number().optional(),
    scrollY: z.number().optional(),
    cornerRadius: CornerRadius.optional(),
    effect: z.unknown().optional(),
    stroke: z.unknown().optional(),
    strokeWidth: z.unknown().optional(),
    strokeLinecap: z.unknown().optional(),
    strokeLinejoin: z.unknown().optional(),
    strokeAlignment: z.unknown().optional(),
  })
  .passthrough();

export const BrowserSchema: TypedObject<BrowserNode> = browserObject;

/** ref：组件实例。ref 上直接出现的其他属性 = 对组件根的覆写（passthrough 承载）。 */
const refObject = z
  .object({
    type: z.literal('ref'),
    ...NodeBase,
    ref: z.string(),
    descendants: z.record(z.unknown()).optional(),
  })
  .passthrough();

export const RefSchema: TypedObject<RefNode> = refObject;

/** 已知节点类型清单（与 format/spec.yaml §nodes 的键一一对应） */
export const KNOWN_NODE_TYPES = [
  'frame', 'group', 'rectangle', 'ellipse', 'polygon', 'path',
  'text', 'note', 'icon', 'icon_font', 'script', 'browser', 'ref',
] as const;

export type KnownNodeType = (typeof KNOWN_NODE_TYPES)[number];

/** 未知节点类型：宽松兜底（保留透传语义）。 */
const unknownObject = z
  .object({ type: z.string(), id: z.string().optional() })
  .passthrough();

export const UnknownNodeSchema: TypedObject<UnknownNode> = unknownObject;

const nodeUnion = z.union([
  frameObject, groupObject, rectangleObject, ellipseObject, polygonObject,
  pathObject, textObject, noteObject, iconObject, iconFontObject, scriptObject,
  browserObject, refObject, unknownObject,
]);

/** 完整节点 union：已知 13 种 + 未知兜底。 */
export const NodeSchema: TypedSchema<PenNode> = nodeUnion;

/** 已知类型 → 专属 schema；未知类型 → 宽松兑底（保留透传语义）。 */
const SCHEMA_BY_TYPE: Record<string, z.ZodTypeAny> = {
  frame: frameObject,
  group: groupObject,
  rectangle: rectangleObject,
  ellipse: ellipseObject,
  polygon: polygonObject,
  path: pathObject,
  text: textObject,
  note: noteObject,
  icon: iconObject,
  icon_font: iconFontObject,
  script: scriptObject,
  browser: browserObject,
  ref: refObject,
};

/** 插入/写入用：已知类型走严格校验，未知类型走宽松兑底。 */
export function schemaForType(type: string): z.ZodTypeAny {
  return SCHEMA_BY_TYPE[type] ?? unknownObject;
}

/* ================================================================== *
 * 手写类型 ↔ schema 一致性断言
 *
 * 这些常量只是编译期检查（`AssertSame` 失败时类型变成 never，赋值 true 立即报错）。
 * 它们不导出、不进 .d.ts，也不参与运行时。
 * ================================================================== */

const _frameMatches: AssertSame<z.infer<typeof frameObject>, FrameNode> = true;
const _groupMatches: AssertSame<z.infer<typeof groupObject>, GroupNode> = true;
const _rectangleMatches: AssertSame<z.infer<typeof rectangleObject>, RectangleNode> = true;
const _ellipseMatches: AssertSame<z.infer<typeof ellipseObject>, EllipseNode> = true;
const _polygonMatches: AssertSame<z.infer<typeof polygonObject>, PolygonNode> = true;
const _pathMatches: AssertSame<z.infer<typeof pathObject>, PathNode> = true;
const _textMatches: AssertSame<z.infer<typeof textObject>, TextNode> = true;
const _noteMatches: AssertSame<z.infer<typeof noteObject>, NoteNode> = true;
const _iconMatches: AssertSame<z.infer<typeof iconObject>, IconNode> = true;
const _iconFontMatches: AssertSame<z.infer<typeof iconFontObject>, IconFontNode> = true;
const _scriptMatches: AssertSame<z.infer<typeof scriptObject>, ScriptNode> = true;
const _browserMatches: AssertSame<z.infer<typeof browserObject>, BrowserNode> = true;
const _refMatches: AssertSame<z.infer<typeof refObject>, RefNode> = true;
const _unknownMatches: AssertSame<z.infer<typeof unknownObject>, UnknownNode> = true;
const _unionMatches: AssertSame<z.infer<typeof nodeUnion>, PenNode> = true;

/** 只是为了「读过」上面那批断言常量：unused 检查会报噪音，运行时无意义。 */
void [
  _frameMatches, _groupMatches, _rectangleMatches, _ellipseMatches, _polygonMatches,
  _pathMatches, _textMatches, _noteMatches, _iconMatches, _iconFontMatches,
  _scriptMatches, _browserMatches, _refMatches, _unknownMatches, _unionMatches,
];
