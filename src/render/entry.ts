import { makeVarResolver, expandRefs, type Warnings } from './index.js';
import { renderTree, computeCanvas, boardBoxes, escapeAttr, type BoardBox } from './html.js';
import type { PenDocument } from '../schema/index.js';
import { applyPresetRefs, presetGroupsOf } from '../doc/presets.js';

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
}

/**
 * 渲染入口（决策 2/3/4/5 的兑现）：
 * 变量内联解析 → ref 展开 → 树 → HTML（每节点 data-node-id）。
 * 纯函数：不改文档；文件系统仅图标读取（见 render/icons.ts）。
 */
export function renderDocument(doc: PenDocument, opts: RenderOptions = {}): RenderResult {
  const warnings: Warnings = [];
  const vars = makeVarResolver(doc, warnings);
  const expanded = expandRefs(doc, warnings);
  // 谱式：`preset: '<name>'` 的节点先铺组属性（节点自己的属性优先），再进布局与渲染
  const withPresets = applyPresetRefs(expanded, presetGroupsOf(doc), warnings);
  const canvas = computeCanvas(withPresets, vars);
  const boards = boardBoxes(withPresets, vars);
  const title = opts.title ?? 'paintress render';
  const body = renderTree(withPresets, vars, warnings);
  const html = [
    '<!DOCTYPE html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8">',
    `<title>${escapeAttr(title)}</title>`,
    '<style>',
    '* { box-sizing: border-box; margin: 0; padding: 0; }',
    `body { margin: 0; background: ${opts.transparent === true ? 'transparent' : '#ffffff'}; }`,
    '.ptr-canvas { position: relative; }',
    '</style>',
    '</head>',
    '<body>',
    `<div class="ptr-canvas" style="width:${canvas.width}px;height:${canvas.height}px">`,
    body,
    '</div>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
  return { html, warnings, canvas, boards };
}
