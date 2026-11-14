/**
 * 字体的纯逻辑：注册表结构、栈拼接、渲染计划、缺口统计。
 *
 * 不碰文件系统：URL 由调用方（查看器 / 截图 / 导出）通过 `resolveUrl` 给，
 * 读写 `__preset.ptr` 在 `doc/project.ts`，校验/提示在各自的入口组装。
 */

import type { PenDocument } from '../schema/index.js';

export type FontSourceKind = 'web' | 'css' | 'file' | 'system' | 'bundle';

export const FONT_SOURCE_KINDS: readonly FontSourceKind[] = ['web', 'css', 'file', 'system', 'bundle'];

export function isFontSourceKind(v: unknown): v is FontSourceKind {
  return typeof v === 'string' && (FONT_SOURCE_KINDS as readonly string[]).includes(v);
}

export interface FontSource {
  kind: FontSourceKind;
  /** `web`：CSS URL；`css` / `file`：项目内相对路径；`system` / `bundle`：省略 */
  target?: string;
}

export interface FontMetrics {
  sizeAdjust?: string;
  ascentOverride?: string;
  descentOverride?: string;
  lineGapOverride?: string;
}

export interface FontEntry {
  source: FontSource;
  /** 设计期替代：family 或 stack；`system` / `bundle` 必填 */
  preview?: string;
  /** 可选度量覆盖：让替代字体的行高/断行接近真字体 */
  metrics?: FontMetrics;
  note?: string;
}

export interface FontRegistry {
  /** 默认字体：font token 的 key，或直接写 family */
  default?: string;
  families: Record<string, FontEntry>;
}

/**
 * paintress 自己的字体观：不带字体文件，只给 jsDelivr 上的 fontsource CSS。
 * 版本钉死，换镜像/自托管只改这里与 seed 数据。
 */
export const BUILTIN_FONT_LINKS: readonly string[] = [
  'https://cdn.jsdelivr.net/npm/@fontsource-variable/inter@5.3.0/wght.css',
  'https://cdn.jsdelivr.net/npm/@fontsource-variable/noto-sans-sc@5.3.1/wght.css',
];

/** 内置网络字体 CSS；`PAINTRESS_NO_WEB_FONTS=1` 时跳过（CI / 纯离线） */
export function webFontLinks(): string[] {
  return process.env['PAINTRESS_NO_WEB_FONTS'] === '1' ? [] : [...BUILTIN_FONT_LINKS];
}

/** 无项目默认时的内置栈；系统字体只是栈尾兵底 */
export const BUILTIN_FONT_STACK =
  '"Inter Variable", "Noto Sans SC Variable", system-ui, -apple-system, "Segoe UI", sans-serif';

const GENERIC_FAMILIES = new Set([
  'sans-serif',
  'serif',
  'monospace',
  'cursive',
  'fantasy',
  'system-ui',
  'ui-monospace',
  'ui-sans-serif',
  'ui-serif',
  'ui-rounded',
  'emoji',
  'math',
  'fangsong',
]);

export function isGenericFamily(family: string): boolean {
  return GENERIC_FAMILIES.has(family.trim().toLowerCase());
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** `'Inter, "Noto Sans SC"'` → `['Inter', 'Noto Sans SC']`（去引号、去空项） */
export function splitFontStack(stack: string): string[] {
  return stack
    .split(',')
    .map((part) => part.trim().replace(/^["']|["']$/g, '').trim())
    .filter((part) => part !== '');
}

function quoteFamily(family: string): string {
  return /[\s]/.test(family) ? `"${family}"` : family;
}

/**
 * 真字体在前、替代在后、`sans-serif` 兜底。替代值可以是 stack。
 * 已经出现过的 family 不重复加（先出现的那一层优先，语义与 CSS 一致）。
 */
export function stackWithPreviews(stack: string, previews: Record<string, string>): string {
  const production = splitFontStack(stack);
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (family: string): void => {
    const key = family.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(quoteFamily(family));
  };
  // 替代紧跟它替代的真字体：原先的「先排完真字体、再排替代」会把 A 的替代挤到 B 后面
  for (const family of production) {
    push(family);
    const preview = previews[family];
    if (preview === undefined) continue;
    for (const entry of splitFontStack(preview)) push(entry);
  }
  // 已经显式写了 generic 兜底就不再补；原实现按「含空格就加引号」拆完再判 generic，
  // 会把 system-ui 误判成普通 family 并重复追加 sans-serif
  if (!production.some((family) => isGenericFamily(family))) out.push('sans-serif');
  return out.join(', ');
}

/** 节点显式写了的字体族（不展开 `$token`；token 的解析由渲染器完成） */
export function stackFamilies(stack: string): string[] {
  return splitFontStack(stack).filter((family) => !isGenericFamily(family));
}

/** 解析 `x-paintress.fonts`；坏结构当空，不让一份手写文件把渲染搞崩 */
export function fontRegistryOf(doc: unknown): FontRegistry {
  const meta = isRecord(doc) ? doc['x-paintress'] : undefined;
  const fonts = isRecord(meta) ? meta['fonts'] : undefined;
  if (!isRecord(fonts)) return { families: {} };
  const rawFamilies = isRecord(fonts['families']) ? fonts['families'] : {};
  const families: Record<string, FontEntry> = {};
  for (const [family, raw] of Object.entries(rawFamilies)) {
    if (!isRecord(raw)) continue;
    const sourceRaw = isRecord(raw['source']) ? raw['source'] : undefined;
    if (sourceRaw === undefined || !isFontSourceKind(sourceRaw['kind'])) continue;
    // target 是规范键；url / path 是老字段的兼容别名
    const candidates = [sourceRaw['target'], sourceRaw['url'], sourceRaw['path']];
    const target = candidates.find((v): v is string => typeof v === 'string');
    const source: FontSource = { kind: sourceRaw['kind'], ...(target !== undefined ? { target } : {}) };
    const metricsRaw = isRecord(raw['metrics']) ? raw['metrics'] : undefined;
    const metrics: FontMetrics = {};
    if (metricsRaw) {
      for (const key of ['sizeAdjust', 'ascentOverride', 'descentOverride', 'lineGapOverride'] as const) {
        if (typeof metricsRaw[key] === 'string' && metricsRaw[key] !== '') metrics[key] = metricsRaw[key] as string;
      }
    }
    families[family] = {
      source,
      ...(typeof raw['preview'] === 'string' && raw['preview'] !== '' ? { preview: raw['preview'] } : {}),
      ...(Object.keys(metrics).length > 0 ? { metrics } : {}),
      ...(typeof raw['note'] === 'string' && raw['note'] !== '' ? { note: raw['note'] } : {}),
    };
  }
  return {
    ...(typeof fonts['default'] === 'string' && fonts['default'] !== '' ? { default: fonts['default'] } : {}),
    families,
  };
}

function varString(variables: Record<string, unknown> | undefined, key: string): string | undefined {
  const def = variables?.[key];
  if (!isRecord(def)) return undefined;
  const value = def['value'];
  return typeof value === 'string' ? value : undefined;
}

/** 默认栈：`default` 是 token key 就解析成值，否则按 family 用；未配置用内置栈 */
export function resolveDefaultStack(registry: FontRegistry, doc?: PenDocument): string {
  const raw = registry.default;
  if (raw === undefined || raw === '') return BUILTIN_FONT_STACK;
  const fromToken = varString(doc?.variables, raw);
  if (fromToken !== undefined) return fromToken;
  return raw;
}

export interface FontPlan {
  /** `<link rel="stylesheet">` 的 URL（web CSS / 项目内 CSS） */
  links: string[];
  /** `@font-face`：file 来源、以及带度量覆盖的 preview 别名 */
  faces: { family: string; src: string; format?: string; metrics?: FontMetrics }[];
  /** family → 设计期替代栈 */
  previews: Record<string, string>;
  /** 节点没写 fontFamily 时用的栈 */
  defaultStack: string;
}

const FORMAT_BY_EXT: Record<string, string> = {
  '.woff2': 'woff2',
  '.woff': 'woff',
  '.ttf': 'truetype',
  '.otf': 'opentype',
};

function fontFormat(target: string): string | undefined {
  const dot = target.lastIndexOf('.');
  if (dot < 0) return undefined;
  return FORMAT_BY_EXT[target.slice(dot).toLowerCase()];
}

/**
 * 由注册表生成渲染计划。`resolveUrl` 决定 URL 的可达形式：
 * 查看器给 `/files/<project>/<path>`，截图给 `file:///<abs>`，导出可以给 data URI。
 */
export function planFonts(
  registry: FontRegistry,
  resolveUrl: (source: FontSource) => string | null,
  doc?: PenDocument,
): FontPlan {
  const links: string[] = webFontLinks();
  const faces: FontPlan['faces'] = [];
  const previews: Record<string, string> = {};
  for (const [family, entry] of Object.entries(registry.families)) {
    const { source } = entry;
    if (source.kind === 'web' && source.target !== undefined) {
      links.push(source.target);
    } else if (source.kind === 'css' && source.target !== undefined) {
      const url = resolveUrl(source);
      if (url !== null) links.push(url);
    } else if (source.kind === 'file' && source.target !== undefined) {
      const url = resolveUrl(source);
      if (url !== null) {
        const format = fontFormat(source.target);
        faces.push({ family, src: url, ...(format !== undefined ? { format } : {}) });
      }
    }
    if (entry.preview !== undefined) {
      const first = splitFontStack(entry.preview)[0];
      if (entry.metrics !== undefined && first !== undefined && !isGenericFamily(first)) {
        // 度量覆盖只能挂在 @font-face 上：声明一个别名 family，栈里排在替代之前
        faces.push({ family: `Preview: ${family}`, src: `local("${first}")`, metrics: entry.metrics });
        previews[family] = `"Preview: ${family}", ${entry.preview}`;
      } else {
        previews[family] = entry.preview;
      }
    }
  }
  return { links, faces, previews, defaultStack: resolveDefaultStack(registry, doc) };
}

export interface FontGaps {
  /** 没写 fontFamily、正在吃默认字体的文本节点数 */
  textNodes: number;
  /** 上述节点的样本 id（最多 10 个） */
  ids: string[];
  /** 文档里显式用到的 family */
  families: string[];
  /** 其中没在注册表里的 */
  unregistered: string[];
  /** 实际会用的默认栈（内置或项目配置） */
  defaultStack: string;
}

/** 字体缺口：没写 family 的文本、没登记的 family —— MCP 的 doc_info / validate / hints 共用 */
export function textFontGaps(doc: PenDocument, registry: FontRegistry): FontGaps {
  const ids: string[] = [];
  const families = new Set<string>();
  let textNodes = 0;
  const walk = (nodes: unknown[]): void => {
    for (const raw of nodes) {
      if (!isRecord(raw)) continue;
      if (raw['type'] === 'text') {
        const ff = raw['fontFamily'];
        if (typeof ff !== 'string' || ff.trim() === '') {
          textNodes += 1;
          if (ids.length < 10 && typeof raw['id'] === 'string') ids.push(raw['id']);
        } else if (!ff.startsWith('$')) {
          for (const family of stackFamilies(ff)) families.add(family);
        }
      }
      const kids = raw['children'];
      if (Array.isArray(kids)) walk(kids);
    }
  };
  walk(doc.children);
  const list = [...families];
  return {
    textNodes,
    ids,
    families: list,
    unregistered: list.filter((family) => registry.families[family] === undefined),
    defaultStack: resolveDefaultStack(registry, doc),
  };
}
