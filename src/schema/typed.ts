import type { z } from 'zod';

/**
 * 声明产物的收敛器（dts 用）。
 *
 * zod passthrough 的推断结果会随着字段数量组合爆炸：`z.infer` 展开成的字面量类型
 * 在 `.d.ts` 里被整段序列化，`NodeSchema` / 文档 schema 曾把 `index.d.ts` 撑到 1.5 MB，
 * 甚至在 TS 的序列化上限处直接报 TS7056。把 schema 的输出类型显式标注成手写形状后，
 * 声明里只剩一个类型引用，体积与上限问题一起消失。
 *
 * 手写类型与运行时 schema 的一致性由各 schema 模块里的编译期断言兜底（见 `AssertSame`）。
 */

/** 只要输出类型：用于 union / intersection 这类非 object schema。 */
export type TypedSchema<T> = z.ZodType<T, z.ZodTypeDef, unknown>;

/** 输出类型 + 保留 `.shape`：规格一致性测试要枚举字段名。 */
export type TypedObject<T> = TypedSchema<T> & { shape: Record<string, z.ZodTypeAny> };

/**
 * 编译期的一致性断言：`Actual`（zod 推断）与 `Declared`（手写形状）必须互为子类型。
 * 多一个字段、少一个字段、类型放宽或收窄都会让断言失败。
 * 用元组包裹以免联合类型分布展开。
 */
export type AssertSame<Actual, Declared> = [Actual] extends [Declared]
  ? [Declared] extends [Actual]
    ? true
    : never
  : never;
