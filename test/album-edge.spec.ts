import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyAdjust, applyEstablish, planAdjust, planEstablish, suggestTokenKey } from '../src/doc/album.js';
import { auditDoc, auditInputFrom } from '../src/doc/audit.js';
import { loadDoc } from '../src/doc/io.js';
import { ensureProjectScaffold, listPresetGroups, listPresets, PRESET_FILE, setPreset, setPresetGroup } from '../src/doc/project.js';
import { validateDoc } from '../src/doc/validate.js';
import { renderDocument } from '../src/render/index.js';
import { VARIABLE_NAME } from '../src/schema/index.js';
import { TOOLS } from '../src/mcp/tools.js';
import type { PenDocument } from '../src/schema/index.js';

/** 本轮审查补的边界用例：每个用例独立项目，互不依赖写入顺序。 */

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function project(children: unknown[], variables: Record<string, unknown> = {}): { root: string; design: string } {
  const root = mkdtempSync(join(tmpdir(), 'paintress-album-edge-'));
  roots.push(root);
  ensureProjectScaffold(root);
  const design = join(root, 'screen.ptr');
  writeFileSync(
    design,
    JSON.stringify({ version: '2.22', fileToken: '00000000-0000-4000-8000-0000000000ee', variables, 'x-paintress': { spec: '1' }, children }, null, 2),
  );
  return { root, design };
}

function docOf(children: unknown[], extra: Record<string, unknown> = {}): PenDocument {
  return { version: '2.22', children, ...extra } as unknown as PenDocument;
}

describe('establish 的字段与 key 边界', () => {
  it('小数 key 合法；只改样式属性，不碰宽高、间距外字段或文本内容', () => {
    expect(suggestTokenKey('radius', '8.5')).toBe('radius-8-5');
    expect(VARIABLE_NAME.test(`$${suggestTokenKey('radius', '8.5')}`)).toBe(true);

    const { root, design } = project([
      {
        type: 'frame', id: 'board', width: 300, height: 200,
        children: [
          // gap 不同，刻意不形成 preset 组，走逐字段 token 替换
          { type: 'rectangle', id: 'a', width: 8.5, height: 40, gap: 1, fill: '#3B82F6', cornerRadius: 8.5 },
          { type: 'rectangle', id: 'b', width: 8.5, height: 40, gap: 2, fill: '#3B82F6', cornerRadius: 8.5 },
          { type: 'text', id: 'text', content: '#3B82F6', fontSize: 14 },
        ],
      },
    ]);

    applyEstablish(design, planEstablish(loadDoc(design).doc));
    const doc = loadDoc(design).doc;
    const kids = (doc.children[0] as Record<string, unknown>)['children'] as Record<string, unknown>[];
    expect(kids[0]?.['fill']).toBe('$color-3b82f6');
    expect(kids[0]?.['cornerRadius']).toBe('$radius-8-5');
    expect(kids[0]?.['width']).toBe(8.5);
    expect(kids[0]?.['gap']).toBe(1);
    expect(kids[2]?.['content']).toBe('#3B82F6');
    expect(listPresets(root).items.some((p) => p.key === 'radius-8-5')).toBe(true);
  });
});

describe('establish 的组属性类型', () => {
  it('cornerRadius 与 gap 数值相同也分别引用 radius / spacing', () => {
    const { design } = project([
      { type: 'rectangle', id: 'a', width: 40, height: 40, fill: '#3B82F6', cornerRadius: 8, gap: 8 },
      { type: 'rectangle', id: 'b', width: 40, height: 40, fill: '#3B82F6', cornerRadius: 8, gap: 8 },
    ]);
    const plan = planEstablish(loadDoc(design).doc);
    expect(plan.groups).toHaveLength(1);
    expect(plan.groups[0]?.props['cornerRadius']).toBe('$radius-8');
    expect(plan.groups[0]?.props['gap']).toBe('$spacing-8');
  });
});

describe('establish 的写入保护', () => {
  it('allowLiteral 子树不提取、不改写', () => {
    const { root, design } = project([
      {
        type: 'rectangle', id: 'a', width: 40, height: 40, fill: '#3B82F6', cornerRadius: 8,
        metadata: { type: 'paintress.escape', allowLiteral: true },
      },
      { type: 'rectangle', id: 'b', width: 40, height: 40, fill: '#3B82F6', cornerRadius: 8 },
    ]);
    const plan = planEstablish(loadDoc(design).doc);
    expect(plan.tokens).toEqual([]); // a 被跳过，b 只剩一次，不到 minUses=2
    applyEstablish(design, plan);
    const doc = loadDoc(design).doc;
    expect(doc.children[0]?.['fill']).toBe('#3B82F6');
    expect(doc.children[1]?.['fill']).toBe('#3B82F6');
    expect(listPresets(root).items).toEqual([]);
  });

  it('同名但定义不同的 preset 组：拒绝覆盖且不写任何候选', () => {
    const { root, design } = project([
      { type: 'rectangle', id: 'a', width: 40, height: 40, fill: '#3B82F6', cornerRadius: 8 },
      { type: 'rectangle', id: 'b', width: 40, height: 40, fill: '#3B82F6', cornerRadius: 8 },
    ]);
    setPresetGroup(root, { name: 'preset-rectangle', target: 'text', props: { fontSize: '$font-body' } });
    expect(() => applyEstablish(design, planEstablish(loadDoc(design).doc))).toThrow(/定义不同，拒绝覆盖/);
    expect(listPresetGroups(root).groups['preset-rectangle']?.target).toBe('text');
    expect(listPresets(root).items).toEqual([]);
  });

  it('计划生成后设计稿被改动：在写预设前失败，不留半套变更', () => {
    const { root, design } = project([
      { type: 'rectangle', id: 'a', width: 40, height: 40, fill: '#3B82F6', cornerRadius: 8 },
      { type: 'rectangle', id: 'b', width: 40, height: 40, fill: '#3B82F6', cornerRadius: 8 },
    ]);
    const loaded = loadDoc(design);
    const plan = planEstablish(loaded.doc);
    utimesSync(design, new Date(), new Date(Date.now() + 2000));
    expect(() => applyEstablish(design, plan, { expectedMtimeMs: loaded.mtimeMs })).toThrow(/拒绝覆盖/);
    expect(listPresets(root).items).toEqual([]);
    expect(listPresetGroups(root).groups).toEqual({});
  });
});

describe('文档内 preset 组与项目组合并', () => {
  it('validateDoc 不再把同文档组误报为悬空', () => {
    const doc = docOf([{ type: 'text', id: 'a', preset: 'local', content: 'A' }], {
      'x-paintress': {
        spec: '1',
        presets: { version: 1, groups: { local: { target: 'text', props: { fontSize: '$font-body' } } } },
      },
    });
    const result = validateDoc(doc);
    expect(result.warnings.some((w) => w.message.includes('preset "local" 不存在'))).toBe(false);
  });

  it('target=ref 的组在展开前后都生效，校验与渲染不再互相矛盾', () => {
    const doc = docOf(
      [
        { type: 'frame', id: 'button', reusable: true, x: 0, y: 0, width: 100, height: 40 },
        { type: 'ref', id: 'instance', ref: 'button', preset: 'instance', x: 150, y: 0, width: 100, height: 40 },
      ],
      {
        variables: { 'opacity-half': { type: 'number', value: 0.5 } },
        'x-paintress': {
          spec: '1',
          presets: { version: 1, groups: { instance: { target: 'ref', props: { opacity: '$opacity-half' } } } },
        },
      },
    );
    expect(validateDoc(doc).warnings).toEqual([]);
    const rendered = renderDocument(doc);
    expect(rendered.warnings).toEqual([]);
    expect(rendered.html).toContain('opacity:0.5');
  });

  it('组属性引用了不存在的 token 也会校验出来', () => {
    const doc = docOf([]);
    const result = validateDoc(doc, {
      presetGroups: { local: { target: 'text', props: { fontSize: '$missing-token' } } },
    });
    expect(result.warnings.some((w) => w.message.includes('未定义的变量 $missing-token'))).toBe(true);
  });
});

describe('adjust 的引用与空影响面边界', () => {
  it('结构化 fill / effect 中的 $token 也进入影响面', () => {
    const { root, design } = project([
      {
        type: 'rectangle', id: 'a', width: 40, height: 40,
        fill: [{ type: 'color', color: '$color-brand' }],
        effect: [{ type: 'shadow', color: '$color-brand', offset: { x: 0, y: 1 } }],
      },
    ]);
    setPreset(root, { key: 'color-brand', type: 'color', value: '#3B82F6' });
    setPresetGroup(root, { name: 'card', target: 'rectangle', props: { fill: '$color-brand' } });
    const plan = planAdjust(loadDoc(design).doc, loadDoc(join(root, PRESET_FILE)).doc, { key: 'color-brand', value: '#123456' });
    const props = plan.changes.map((c) => `${c.where}:${c.prop}`);
    expect(props).toContain('a:fill[0].color');
    expect(props).toContain('a:effect[0].color');
    expect(props).toContain('<preset:card>:fill');
  });

  it('未被引用的组也能 apply，且不会写出空属性名', () => {
    const { root, design } = project([]);
    setPreset(root, { key: 'color-brand', type: 'color', value: '#3B82F6' });
    setPresetGroup(root, { name: 'ghost', target: 'rectangle', props: { fill: '$color-brand' } });
    const presetDoc = loadDoc(join(root, PRESET_FILE)).doc;
    const plan = planAdjust(loadDoc(design).doc, presetDoc, { group: 'ghost', prop: 'gap', value: '$space-md' });
    expect(plan.changes).toEqual([]);
    applyAdjust(design, presetDoc, plan);
    const group = listPresetGroups(root).groups['ghost'];
    expect(group?.props['gap']).toBe('$space-md');
    expect(group && '' in group.props).toBe(false);
  });

  it('节点显式覆盖的组属性不算受影响', () => {
    const { root, design } = project([
      { type: 'rectangle', id: 'a', preset: 'card' },
      { type: 'rectangle', id: 'b', preset: 'card', fill: '#FFFFFF' },
    ]);
    setPreset(root, { key: 'color-brand', type: 'color', value: '#3B82F6' });
    setPresetGroup(root, { name: 'card', target: 'rectangle', props: { fill: '$color-brand' } });
    const plan = planAdjust(loadDoc(design).doc, loadDoc(join(root, PRESET_FILE)).doc, {
      group: 'card', prop: 'fill', value: '$color-other',
    });
    expect(plan.changes.map((c) => c.where)).toEqual(['a']);
  });

  it('key 与 group/prop 同时给会拒绝，不静默选一边', () => {
    const { design } = project([]);
    expect(() =>
      TOOLS['paintress_adjust']!.run({ path: design, key: 'color-brand', group: 'card', prop: 'fill', value: '#000000' }),
    ).toThrow(/只能选一种/);
  });
});

describe('audit 的语义边界', () => {
  it('结构化颜色可建议；文本内容和 name 不会被误判；数值按 kind 匹配', () => {
    const { root, design } = project([
      {
        type: 'rectangle', id: 'a', name: '#3B82F6', width: 40, height: 40, opacity: 0.5,
        fill: [{ type: 'color', color: '#3B82F6' }], cornerRadius: [6, 6], gap: 12,
      },
      { type: 'text', id: 'text', content: '#3B82F6' },
    ]);
    setPreset(root, { key: 'color-brand', type: 'color', value: '#3B82F6' });
    setPreset(root, { key: 'radius-md', type: 'radius', value: '6' });
    setPreset(root, { key: 'space-md', type: 'spacing', value: '12' });
    setPreset(root, { key: 'radius-half', type: 'radius', value: '0.5' });
    const loaded = loadDoc(design).doc;
    const tokens = listPresets(root).items.map((p) => ({ key: p.key, type: p.type, value: p.value }));
    const report = auditDoc(loaded, auditInputFrom(loaded, tokens, loadDoc(join(root, PRESET_FILE)).doc));

    expect(report.findings.some((f) => f.where === 'a' && f.message.startsWith('fill[0].color') && f.suggestion === '$color-brand')).toBe(true);
    expect(report.findings.some((f) => f.where === 'a' && f.message.startsWith('gap') && f.suggestion === '$space-md')).toBe(true);
    expect(report.findings.some((f) => f.message.startsWith('opacity'))).toBe(false);
    expect(report.findings.some((f) => f.message.startsWith('name'))).toBe(false);
    expect(report.findings.some((f) => f.message.startsWith('content'))).toBe(false);
  });
});
