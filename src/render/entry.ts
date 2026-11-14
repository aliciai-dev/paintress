import { makeVarResolver, expandRefs, type Warnings } from './index.js';
import { renderTree, computeCanvas, boardBoxes, escapeAttr, type BoardBox } from './html.js';
import type { PenDocument, PenNode } from '../schema/index.js';
import { applyPresetRefs, presetGroupsOf } from '../doc/presets.js';
import {
  BUILTIN_FONT_STACK,
  isGenericFamily,
  splitFontStack,
  stackWithPreviews,
  type FontMetrics,
  type FontPlan,
} from '../doc/fonts.js';

export type { BoardBox };

export interface RenderResult {
  html: string;
  warnings: Warnings;
  /** 画布尺寸（顶层节点包围盒，px） */
  canvas: { width: number; height: number };
  /** 每个顶层节点的包围盒（画板）：供按画板截图层选择与裁剪 */
  boards: BoardBox[];
}

export interface RenderOptions {
  /** 页面标题（默认 paintress render） */
  title?: string;
  /** 透明画布底（组件 tile 用；默认白底） */
  transparent?: boolean;
  /** 字体计划：URL 由调用方给（查看器 /files，截图 file://） */
  fonts?: FontPlan;
  /** 注入字体可用性探针脚本（查看器用；静态导出不开） */
  probeFonts?: boolean;
}

function metricsCss(metrics: FontMetrics | undefined): string {
  if (metrics === undefined) return '';
  const parts: string[] = [];
  if (metrics.sizeAdjust !== undefined) parts.push(`size-adjust:${metrics.sizeAdjust}`);
  if (metrics.ascentOverride !== undefined) parts.push(`ascent-override:${metrics.ascentOverride}`);
  if (metrics.descentOverride !== undefined) parts.push(`descent-override:${metrics.descentOverride}`);
  if (metrics.lineGapOverride !== undefined) parts.push(`line-gap-override:${metrics.lineGapOverride}`);
  return parts.length > 0 ? `${parts.join(';')};` : '';
}

function faceCss(face: FontPlan['faces'][number]): string {
  const src = face.src.startsWith('local(') ? face.src : `url("${face.src}")`;
  const format = face.format !== undefined ? ` format("${face.format}")` : '';
  return `@font-face{font-family:${JSON.stringify(face.family)};src:${src}${format};${metricsCss(face.metrics)}}`;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 探针要检查的 family：注册表里的、默认栈里的、文档里写死的 */
function collectProbeFamilies(nodes: PenNode[], plan: FontPlan | undefined): string[] {
  const set = new Set<string>();
  for (const family of Object.keys(plan?.previews ?? {})) set.add(family);
  for (const family of splitFontStack(plan?.defaultStack ?? BUILTIN_FONT_STACK)) {
    if (!isGenericFamily(family)) set.add(family);
  }
  const walk = (list: unknown[]): void => {
    for (const raw of list) {
      if (!isRecord(raw)) continue;
      if (raw['type'] === 'text' && typeof raw['fontFamily'] === 'string' && !raw['fontFamily'].startsWith('$')) {
        for (const family of splitFontStack(raw['fontFamily'])) {
          if (!isGenericFamily(family)) set.add(family);
        }
      }
      const kids = raw['children'];
      if (Array.isArray(kids)) walk(kids);
    }
  };
  walk(nodes);
  return [...set];
}

/**
 * 字体 CSS 异步加载：外链样式表会阻塞 load（测试与首屏都不该等 CDN），
 * 于是用脚本注入；`window.__paintressFontsReady` 给自己人（探针 / 截图）一个等待点。
 */
function fontLoaderScript(links: string[]): string {
  if (links.length === 0) return '';
  return [
    '<script>',
    '(function(){',
    `var hrefs=${JSON.stringify(links).replace(/</g, '\\u003c')};`,
    'var loads=hrefs.map(function(href){return new Promise(function(resolve){',
    'var l=document.createElement("link");l.rel="stylesheet";l.href=href;l.onload=resolve;l.onerror=resolve;document.head.appendChild(l);',
    '});});',
    'window.__paintressFontsReady=Promise.all(loads).then(function(){',
    'return document.fonts&&document.fonts.ready?document.fonts.ready:null;});',
    '})();',
    '</script>',
  ].join('\n');
}

/**
 * 字体可用性探针（宽度法）：`document.fonts.check()` 对缺失的系统字体也返回 true，
 * 只有「候选 family 与缺失基线的宽度是否相同」能区分。
 */
function probeScript(families: string[]): string {
  if (families.length === 0) return '';
  const payload = JSON.stringify(families).replace(/</g, '\\u003c').replace(/[\u2028\u2029]/g, (ch) => '\\u' + ch.charCodeAt(0).toString(16));
  return [
    '<script type="application/json" id="ptr-fonts">',
    payload,
    '</script>',
    '<script>',
    '(function(){',
    'var el=document.getElementById("ptr-fonts");if(!el||window.parent===window)return;',
    'var families=[];try{families=JSON.parse(el.textContent||"[]")}catch(e){return}',
    'if(!families.length)return;',
    'var c=document.createElement("canvas").getContext("2d");',
    'var text="漢字Abc123 光伴";',
    'function w(f,b){c.font=\'32px "\'+f+\'", \'+b;return c.measureText(text).width}',
    'function missing(){var sb=w("__paintress_missing__","serif"),mb=w("__paintress_missing__","monospace");',
    'var out=[];for(var i=0;i<families.length;i++){var f=families[i];',
    'if(Math.abs(w(f,"serif")-sb)<0.5&&Math.abs(w(f,"monospace")-mb)<0.5)out.push(f)}return out}',
    'function send(){var m=missing();var data={type:"paintress-fonts",checked:families,missing:m};window.parent.postMessage(data,"*");if(window.PAINTRESS_FONT_URL){fetch(window.PAINTRESS_FONT_URL,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({checked:families,missing:m})}).catch(function(){})}}',
    'Promise.resolve(window.__paintressFontsReady).then(function(){setTimeout(send,50)});',
    '})();',
    '</script>',
  ].join('\n');
}

/**
 * 渲染入口（决策 2/3/4/5 的兑现）：
 * 变量内联解析 → ref 展开 → 树 → HTML（每节点 data-node-id）。
 * 纯函数：不改文档；文件系统仅图标读取（见 render/icons.ts）。
 */
export function renderDocument(doc: PenDocument, opts: RenderOptions = {}): RenderResult {
  const warnings: Warnings = [];
  const vars = makeVarResolver(doc, warnings);
  const groups = presetGroupsOf(doc);
  // ref 的 target 按原始节点类型校验；先套一次，expandRefs 才会把组属性带到实例根。
  const seeded = applyPresetRefs(doc.children, groups, warnings);
  const expanded = expandRefs({ ...doc, children: seeded }, warnings);
  // 展开后再套一次：覆盖组件定义与 descendants 里新出现的 preset 引用。
  const postWarnings: string[] = [];
  const withPresets = applyPresetRefs(expanded, groups, postWarnings);
  for (const message of postWarnings) {
    if (!warnings.includes(message)) warnings.push(message);
  }
  const canvas = computeCanvas(withPresets, vars);
  const boards = boardBoxes(withPresets, vars);
  const title = opts.title ?? 'paintress render';
  const body = renderTree(withPresets, vars, warnings, { previews: opts.fonts?.previews ?? {} });

  // 字体：URL 由调用方给（daemon/screenshot 的 planFonts 会把内置 Inter + Noto Sans SC 带上）
  const links = [...new Set(opts.fonts?.links ?? [])];
  const defaultStack = stackWithPreviews(opts.fonts?.defaultStack ?? BUILTIN_FONT_STACK, opts.fonts?.previews ?? {});
  const faces = (opts.fonts?.faces ?? []).map(faceCss);
  const probe = opts.probeFonts === true ? probeScript(collectProbeFamilies(withPresets, opts.fonts)) : '';

  const html = [
    '<!DOCTYPE html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8">',
    `<title>${escapeAttr(title)}</title>`,
    '<style>',
    '* { box-sizing: border-box; margin: 0; padding: 0; }',
    `body { margin: 0; background: ${opts.transparent === true ? 'transparent' : '#ffffff'}; }`,
    `.ptr-canvas { position: relative; font-family: ${defaultStack}; }`,
    ...faces,
    '</style>',
    '</head>',
    '<body>',
    `<div class="ptr-canvas" style="width:${canvas.width}px;height:${canvas.height}px">`,
    body,
    '</div>',
    fontLoaderScript(links),
    probe,
    '</body>',
    '</html>',
    '',
  ].join('\n');
  return { html, warnings, canvas, boards };
}
