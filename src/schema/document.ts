import { z } from 'zod';
import { NodeSchema } from './nodes.js';
import type { PenNode } from './nodes.js';
import type { AssertSame, TypedObject, TypedSchema } from './typed.js';

/** 规格来源：format/spec.yaml §document、§ptr（v0.2.0） */

/* ================================================================== *
 * 公共类型面（手写）
 *
 * 与 `nodes.ts` 同样的理由：`z.infer` 展开后的文档类型会把节点 union 整段内联，
 * 声明产物达 MB 级并触发 TS7056。这里给出稳定的手写形状，一致性由文件末尾的
 * 编译期断言把关。
 * ================================================================== */

/** 变量的字面量取值 */
export type VariableValue = string | number | boolean;

/** 按主题分派的变量取值 */
export interface ThemedValue {
  value: VariableValue;
  theme?: Record<string, string>;
  [key: string]: unknown;
}

/** 变量定义：type + value（字面量或按主题分派的列表） */
export interface VariableDef {
  type: 'boolean' | 'color' | 'number' | 'string';
  value: VariableValue | ThemedValue[];
  [key: string]: unknown;
}

/** ptr 文档级扩展（x-paintress） */
export interface XPaintress {
  spec: string;
  generator?: string;
  created_at?: string;
  updated_at?: string;
  [key: string]: unknown;
}

/** 文档根。passthrough：fileToken 与未来未知顶层键全部透传。 */
export interface PenDocument {
  version: string;
  fileToken?: string;
  themes?: Record<string, string[]>;
  imports?: Record<string, string>;
  variables?: Record<string, VariableDef>;
  children: PenNode[];
  [key: string]: unknown;
}

/** .ptr 文档：pen_profile + x-paintress 必填 */
export type PtrDocument = PenDocument & { 'x-paintress': XPaintress };

/* ================================================================== *
 * 运行时 schema
 * ================================================================== */

const variableValueLiteral = z.union([z.string(), z.number(), z.boolean()]);

const themedValueObject = z
  .object({ value: variableValueLiteral, theme: z.record(z.string()).optional() })
  .passthrough();

/** 变量定义：type + value（字面量或按主题分派的列表） */
const variableDefObject = z
  .object({
    type: z.enum(['boolean', 'color', 'number', 'string']),
    value: z.union([variableValueLiteral, z.array(themedValueObject)]),
  })
  .passthrough();

export const VariableDef: TypedObject<VariableDef> = variableDefObject;

/** ptr 文档级扩展（x-paintress）。pen 读取器忽略；ptr 写入器必须输出 spec 字段。 */
const xPaintressObject = z
  .object({
    spec: z.string(),
    generator: z.string().optional(),
    created_at: z.string().optional(),
    updated_at: z.string().optional(),
  })
  .passthrough();

export const XPaintress: TypedObject<XPaintress> = xPaintressObject;

export const X_PAINTRESS_KEY = 'x-paintress';
export const PTR_SPEC_VERSION = '1';

/**
 * 新文档写入的 `version` 字段值。
 * 必须与 `format/spec.yaml§meta.layers.pen_profile.observed_document_version` 同步
 * （`test/spec-conformance.spec.ts` 会断言两者相等）。
 */
export const PEN_DOC_VERSION = '2.22';

/** 文档根。passthrough：fileToken 与未来未知顶层键全部透传。 */
const documentObject = z
  .object({
    version: z.string(),
    fileToken: z.string().optional(),
    themes: z.record(z.array(z.string())).optional(),
    imports: z.record(z.string()).optional(),
    variables: z.record(variableDefObject).optional(),
    children: z.array(NodeSchema),
  })
  .passthrough();

export const DocumentObjectSchema: TypedObject<PenDocument> = documentObject;

const refinedDocument = documentObject.superRefine((doc, ctx) => {
  if (X_PAINTRESS_KEY in doc) {
    const parsed = xPaintressObject.safeParse((doc as Record<string, unknown>)[X_PAINTRESS_KEY]);
    if (!parsed.success) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [X_PAINTRESS_KEY], message: 'x-paintress 结构不合法' });
    }
  }
});

export const DocumentSchema: TypedSchema<PenDocument> = refinedDocument;

const ptrIntersection = refinedDocument.and(
  z.object({ [X_PAINTRESS_KEY]: xPaintressObject }).passthrough(),
);

/** .ptr 文档：pen_profile + x-paintress 必填 */
export const PtrDocumentSchema: TypedSchema<PtrDocument> = ptrIntersection;

/* ================================================================== *
 * 手写类型 ↔ schema 一致性断言（纯编译期，不导出、不进 .d.ts）
 * ================================================================== */

const _variableDefMatches: AssertSame<z.infer<typeof variableDefObject>, VariableDef> = true;
const _themedValueMatches: AssertSame<z.infer<typeof themedValueObject>, ThemedValue> = true;
const _xPaintressMatches: AssertSame<z.infer<typeof xPaintressObject>, XPaintress> = true;
const _documentMatches: AssertSame<z.infer<typeof documentObject>, PenDocument> = true;
const _ptrDocumentMatches: AssertSame<z.infer<typeof ptrIntersection>, PtrDocument> = true;

/** 读取断言常量，避免 unused 检查噪音。 */
void [_variableDefMatches, _themedValueMatches, _xPaintressMatches, _documentMatches, _ptrDocumentMatches];
