import { z } from 'zod';

/** 规格来源：format/spec.yaml §enums（v0.2.0，enum_ref 的目标全部在此定义） */

export const LayoutDir = z.enum(['none', 'vertical', 'horizontal']);
export const MainAxis = z.enum(['start', 'center', 'end', 'space_between', 'space_around']);
export const CrossAxis = z.enum(['start', 'center', 'end']);
export const BlendMode = z.enum([
  'normal', 'darken', 'multiply', 'linearBurn', 'colorBurn', 'light',
  'screen', 'linearDodge', 'colorDodge', 'overlay', 'softLight', 'hardLight',
  'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity',
]);
export const GradientType = z.enum(['linear', 'radial', 'angular']);
export const ImageFit = z.enum(['cover', 'contain', 'stretch']);
export const FillRule = z.enum(['nonzero', 'evenodd']);
export const StrokeCap = z.enum(['butt', 'round', 'square']);
export const StrokeJoin = z.enum(['miter', 'bevel', 'round']);
export const StrokeAlign = z.enum(['inner', 'center', 'outer']);
export const TextAlign = z.enum(['left', 'center', 'right', 'justify']);
export const TextAlignVertical = z.enum(['top', 'middle', 'bottom']);
export const TextGrowth = z.enum(['auto', 'fixed-width', 'fixed-width-height']);
export const ShadowKind = z.enum(['inner', 'outer']);
export const IconLibrary = z.enum([
  'lucide', 'feather',
  'Material Symbols Outlined', 'Material Symbols Rounded', 'Material Symbols Sharp',
  'phosphor',
]);
export const PositionMode = z.enum(['auto', 'absolute']);

/** 与上面各 zod enum 同名的类型别名：供手写公共类型（src/schema/typed.ts）引用，避免推断链扩散。 */
export type LayoutDir = z.infer<typeof LayoutDir>;
export type MainAxis = z.infer<typeof MainAxis>;
export type CrossAxis = z.infer<typeof CrossAxis>;
export type BlendMode = z.infer<typeof BlendMode>;
export type GradientType = z.infer<typeof GradientType>;
export type ImageFit = z.infer<typeof ImageFit>;
export type FillRule = z.infer<typeof FillRule>;
export type StrokeCap = z.infer<typeof StrokeCap>;
export type StrokeJoin = z.infer<typeof StrokeJoin>;
export type StrokeAlign = z.infer<typeof StrokeAlign>;
export type TextAlign = z.infer<typeof TextAlign>;
export type TextAlignVertical = z.infer<typeof TextAlignVertical>;
export type TextGrowth = z.infer<typeof TextGrowth>;
export type ShadowKind = z.infer<typeof ShadowKind>;
export type IconLibrary = z.infer<typeof IconLibrary>;
export type PositionMode = z.infer<typeof PositionMode>;
