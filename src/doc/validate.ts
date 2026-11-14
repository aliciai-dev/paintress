import { DocumentSchema, KNOWN_NODE_TYPES, VARIABLE_NAME } from '../schema/index.js';
import { PRESET_TYPE_LABEL, PROP_TOKEN_KIND, presetGroupsOf, type PresetGroup, type PresetType } from './presets.js';
import { collectIds } from './id.js';

/** 校验结果：errors 阻断写入，warnings 不阻断 */
export type ValidationIssue = {
  level: 'error' | 'warning';
  path: string;
  message: string;
};

export type ValidationResult = {
  ok: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
};

export interface ValidateOptions {
  /** 项目预设提供的变量名：引用它们不算「未定义」 */
  knownVars?: Iterable<string>;
  /** 文档本地定义了同名的项目预设 → 给警告（查看器里调预设不会影响这份文件） */
  presetVars?: Iterable<string>;
  /** 项目预设组（谱式）：节点 `preset` 引用与组内裸值都要检查 */
  presetGroups?: Record<string, PresetGroup>;
  /** 项目预设里每个 token 的种类：属性引用错类（`fill: $radius-8`）时给警告 */
  presetKinds?: Record<string, PresetType>;
}

/** 一个属性值里出现的所有 `$token` 引用（结构化填充、数组、逐边对象都要覆盖） */
function refsIn(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') {
    if (VARIABLE_NAME.test(value)) out.push(value.slice(1));
  } else if (Array.isArray(value)) {
    for (const entry of value) refsIn(entry, out);
  } else if (value !== null && typeof value === 'object') {
    for (const entry of Object.values(value)) refsIn(entry, out);
  }
  return out;
}

/** 结构校验（schema）+ 语义校验（重复 id、悬空 ref、未知类型、未解析变量） */
export function validateDoc(input: unknown, opts: ValidateOptions = {}): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  const parsed = DocumentSchema.safeParse(input);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      errors.push({
        level: 'error',
        path: issue.path.length > 0 ? issue.path.map(String).join('/') : '<root>',
        message: issue.message,
      });
    }
    return { ok: false, errors, warnings };
  }
  const doc = parsed.data;
  // 与渲染同一优先级：项目组打底、文档内组覆盖；否则同文档组会被误报成悬空引用
  const presetGroups = { ...(opts.presetGroups ?? {}), ...presetGroupsOf(doc) };
  const presetKinds = opts.presetKinds ?? {};

  // 重复 id
  const allIds = collectIds(doc.children);
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const id of allIds) {
    if (seen.has(id)) dup.add(id);
    seen.add(id);
  }
  for (const id of dup) {
    warnings.push({ level: 'warning', path: `<id:${id}>`, message: 'id 重复' });
  }

  // 悬空 ref 与未知节点类型
  const walk = (nodes: unknown[], path: string): void => {
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (!node || typeof node !== 'object') continue;
      const rec = node as Record<string, unknown>;
      const type = rec['type'];
      const here = `${path}/${i}`;
      if (typeof type === 'string' && !KNOWN_NODE_TYPES.includes(type as (typeof KNOWN_NODE_TYPES)[number])) {
        warnings.push({ level: 'warning', path: here, message: `未知节点类型 "${type}"，已原样保留` });
      }
      if (type === 'ref' && typeof rec['ref'] === 'string' && !seen.has(rec['ref'])) {
        warnings.push({ level: 'warning', path: here, message: `ref 指向不存在的组件 id "${String(rec['ref'])}"` });
      }
      const presetName = rec['preset'];
      if (typeof presetName === 'string' && presetName !== '') {
        const group = presetGroups[presetName];
        if (group === undefined) {
          warnings.push({ level: 'warning', path: here, message: `preset "${presetName}" 不存在` });
        } else if (group.target !== type) {
          warnings.push({
            level: 'warning',
            path: here,
            message: `preset "${presetName}" 适用于 ${group.target}，这里是 ${String(type)}`,
          });
        }
      }
      const kids = rec['children'];
      if (Array.isArray(kids)) walk(kids, `${here}/children`);

      // 引用类型错配：`fill: $radius-8`、`fontSize: $font-sans` 这类引用
      // 渲染时不会报错，只会输出一个错值——必须在写入前点出来。
      for (const [prop, value] of Object.entries(rec)) {
        if (prop === 'children') continue;
        const expected = PROP_TOKEN_KIND[prop];
        if (expected === undefined) continue;
        for (const ref of refsIn(value)) {
          const actual = presetKinds[ref];
          if (actual === undefined || actual === expected) continue;
          warnings.push({
            level: 'warning',
            path: here,
            message: `${prop} 需要${PRESET_TYPE_LABEL[expected]} token，$${ref} 是${PRESET_TYPE_LABEL[actual]}（类型 ${actual}）`,
          });
        }
      }
    }
  };
  walk(doc.children, 'children');

  // 谱式本身的越界：属性值必须是 $token，不能是裸值
  for (const [name, group] of Object.entries(presetGroups)) {
    for (const [prop, value] of Object.entries(group.props)) {
      if (!VARIABLE_NAME.test(value)) {
        warnings.push({
          level: 'warning',
          path: `<preset:${name}>`,
          message: `preset 组里的 ${prop} 是字面量 "${value}"，应当写成 $token 引用`,
        });
      } else {
        const expected = PROP_TOKEN_KIND[prop];
        const actual = presetKinds[value.slice(1)];
        if (expected !== undefined && actual !== undefined && actual !== expected) {
          warnings.push({
            level: 'warning',
            path: `<preset:${name}>`,
            message: `${prop} 需要${PRESET_TYPE_LABEL[expected]} token，${value} 是${PRESET_TYPE_LABEL[actual]}（类型 ${actual}）`,
          });
        }
      }
    }
  }

  // 未解析变量引用（$name 不在 variables 表，也不在项目预设里）
  const localNames = new Set(doc.variables ? Object.keys(doc.variables) : []);
  const varNames = new Set<string>([...localNames, ...(opts.knownVars ?? [])]);
  for (const name of opts.presetVars ?? []) {
    if (localNames.has(name)) {
      warnings.push({
        level: 'warning',
        path: '<variables>',
        message: `本地变量 $${name} 覆盖了项目预设（在查看器里调预设不会影响这份文件）`,
      });
    }
  }
  const varRefs = new Set<string>();
  const scan = (obj: unknown): void => {
    if (typeof obj === 'string' && VARIABLE_NAME.test(obj)) varRefs.add(obj.slice(1));
    else if (Array.isArray(obj)) obj.forEach(scan);
    else if (obj && typeof obj === 'object') Object.values(obj).forEach(scan);
  };
  scan(doc.children);
  // 组属性也是变量引用点：$token 写错名字不能靠「它不是裸值」而漏检
  for (const group of Object.values(presetGroups)) {
    for (const value of Object.values(group.props)) scan(value);
  }
  for (const name of varRefs) {
    if (!varNames.has(name)) {
      warnings.push({ level: 'warning', path: '<variables>', message: `字段引用了未定义的变量 $${name}` });
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}
