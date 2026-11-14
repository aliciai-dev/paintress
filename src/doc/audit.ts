import type { PenDocument } from '../schema/index.js';
import { presetGroupsOf, type PresetGroup } from './presets.js';

/**
 * 画谱审计（B3）：找出「本该用 token / preset，却写了裸值」的地方，以及
 * 孤儿 token、从没被引用的 preset 组、悬空的 preset 引用。
 *
 * 纯函数：只读文档与项目预设，不写盘、不改树。是否替换由 agent / 人决定。
 */

export type AuditKind = 'literal' | 'orphan-token' | 'unused-preset' | 'dangling-preset' | 'preset-target' | 'preset-literal';

export interface AuditFinding {
  kind: AuditKind;
  /** 节点 id 或 `<preset:组名>` */
  where: string;
  message: string;
  /** 可以把裸值换成的 token / preset */
  suggestion?: string;
}

export interface AuditToken {
  key: string;
  type: string;
  value: string;
}

export interface AuditInput {
  tokens: AuditToken[];
  groups: Record<string, PresetGroup>;
}

export interface AuditReport {
  findings: AuditFinding[];
  counts: Record<AuditKind, number>;
  /** 人看的一段话（CLI / agent 直接引用） */
  summary: string;
}

/** 参与「裸值 → token」建议的样式属性；宽高、透明度、文本内容都不在此列 */
const NUMERIC_PROP_KIND: Record<string, 'radius' | 'spacing' | 'font'> = {
  cornerRadius: 'radius',
  gap: 'spacing',
  padding: 'spacing',
  strokeWidth: 'spacing',
  fontSize: 'font',
};
const COLOR_STYLE_PROPS = new Set(['fill', 'stroke', 'color', 'effect']);
const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function countOf(findings: AuditFinding[]): Record<AuditKind, number> {
  const counts: Record<AuditKind, number> = {
    literal: 0,
    'orphan-token': 0,
    'unused-preset': 0,
    'dangling-preset': 0,
    'preset-target': 0,
    'preset-literal': 0,
  };
  for (const f of findings) counts[f.kind] += 1;
  return counts;
}

function summarize(report: Omit<AuditReport, 'summary'>): string {
  const c = report.counts;
  const parts = [
    `越界裸值 ${c.literal}`,
    `孤儿 token ${c['orphan-token']}`,
    `未使用的 preset 组 ${c['unused-preset']}`,
    `悬空 preset 引用 ${c['dangling-preset'] + c['preset-target']}`,
    `preset 里的裸值 ${c['preset-literal']}`,
  ];
  return parts.join(' · ');
}

export function auditDoc(doc: PenDocument, input: AuditInput): AuditReport {
  const findings: AuditFinding[] = [];
  const colorTokens = new Map<string, string>();
  const numberTokens = new Map<string, string>();
  for (const t of input.tokens) {
    if (t.type === 'color') {
      colorTokens.set(t.value.toUpperCase(), t.key);
    } else if (t.type === 'radius' || t.type === 'spacing' || t.type === 'font') {
      const n = Number(t.value);
      // key 带上 kind：gap 不能建议成 $radius，fontSize 也不能建议成间距
      if (Number.isFinite(n)) numberTokens.set(`${t.type}:${n}`, t.key);
    }
  }

  const usedVars = new Set<string>();
  const usedGroups = new Set<string>();

  const walk = (nodes: unknown[], inheritedAllowLiteral: boolean): void => {
    for (const raw of nodes) {
      if (!isRecord(raw)) continue;
      const node = raw;
      const id = typeof node['id'] === 'string' ? node['id'] : '?';
      const meta = node['metadata'];
      const allowLiteral =
        inheritedAllowLiteral || (isRecord(meta) && (meta['allowLiteral'] === true || meta['allowLiteral'] === 'true'));

      // preset 引用
      const presetName = node['preset'];
      if (typeof presetName === 'string' && presetName !== '') {
        const group = input.groups[presetName];
        if (group === undefined) {
          findings.push({ kind: 'dangling-preset', where: id, message: `preset "${presetName}" 不存在` });
        } else if (group.target !== node['type']) {
          findings.push({
            kind: 'preset-target',
            where: id,
            message: `preset "${presetName}" 适用于 ${group.target}，这里是 ${String(node['type'])}`,
          });
        } else {
          usedGroups.add(presetName);
        }
      }

      // 裸值 → token 建议。颜色只在样式字段里递归（结构化 fill / stroke / shadow），
      // 不扫 name/content/id；数值则按属性对应的 kind 匹配，数组与逐边对象也覆盖。
      if (!allowLiteral) {
        const suggestColor = (value: unknown, path: string): void => {
          if (typeof value === 'string') {
            if (!HEX_RE.test(value)) return;
            const hit = colorTokens.get(value.toUpperCase());
            if (hit !== undefined) {
              findings.push({ kind: 'literal', where: id, message: `${path} 写了裸色值 ${value}`, suggestion: `$${hit}` });
            }
            return;
          }
          if (Array.isArray(value)) {
            value.forEach((entry, index) => suggestColor(entry, `${path}[${index}]`));
            return;
          }
          if (isRecord(value)) {
            for (const [key, entry] of Object.entries(value)) suggestColor(entry, `${path}.${key}`);
          }
        };
        const suggestNumber = (value: unknown, path: string, kind: 'radius' | 'spacing' | 'font'): void => {
          if (typeof value === 'number' && Number.isFinite(value)) {
            const hit = numberTokens.get(`${kind}:${value}`);
            if (hit !== undefined) {
              findings.push({ kind: 'literal', where: id, message: `${path} 写了裸值 ${value}`, suggestion: `$${hit}` });
            }
            return;
          }
          if (Array.isArray(value)) {
            value.forEach((entry, index) => suggestNumber(entry, `${path}[${index}]`, kind));
            return;
          }
          if (isRecord(value)) {
            for (const [key, entry] of Object.entries(value)) suggestNumber(entry, `${path}.${key}`, kind);
          }
        };
        for (const [prop, value] of Object.entries(node)) {
          if (prop === 'children') continue;
          if (COLOR_STYLE_PROPS.has(prop)) suggestColor(value, prop);
          const kind = NUMERIC_PROP_KIND[prop];
          if (kind !== undefined) suggestNumber(value, prop, kind);
        }
      }

      // 变量引用（孤儿 token 判定）
      const scan = (v: unknown): void => {
        if (typeof v === 'string' && v.startsWith('$') && v.length > 1) usedVars.add(v.slice(1));
        else if (Array.isArray(v)) v.forEach(scan);
        else if (isRecord(v)) Object.values(v).forEach(scan);
      };
      scan(node);

      const kids = node['children'];
      if (Array.isArray(kids)) walk(kids, allowLiteral);
    }
  };
  walk(doc.children, false);

  // preset 组自身：属性值必须是 $token；组内引用的 token 算「用过」
  for (const [name, group] of Object.entries(input.groups)) {
    for (const [prop, value] of Object.entries(group.props)) {
      if (!value.startsWith('$')) {
        findings.push({
          kind: 'preset-literal',
          where: `<preset:${name}>`,
          message: `${prop} 写的是字面量 "${value}"，应当引用 $token`,
        });
      } else {
        usedVars.add(value.slice(1));
      }
    }
    if (!usedGroups.has(name)) {
      findings.push({ kind: 'unused-preset', where: `<preset:${name}>`, message: `没有任何节点引用 preset "${name}"` });
    }
  }

  // 孤儿 token：文档与 preset 组都没有 $key 引用
  for (const t of input.tokens) {
    if (!usedVars.has(t.key)) {
      findings.push({ kind: 'orphan-token', where: `<token:${t.key}>`, message: `token "$${t.key}" 从未被引用` });
    }
  }

  const counts = countOf(findings);
  const report = { findings, counts };
  return { ...report, summary: summarize(report) };
}

/** MCP / CLI 入口用：从设计稿 + 项目文件凑出审计输入 */
export function auditInputFrom(
  doc: PenDocument,
  tokens: AuditToken[],
  presetDoc: PenDocument | null,
): AuditInput {
  return { tokens, groups: { ...presetGroupsOf(presetDoc), ...presetGroupsOf(doc) } };
}
