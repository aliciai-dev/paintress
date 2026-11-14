import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyAdjust, applyEstablish, planAdjust, planEstablish, readPresetDoc } from '../src/doc/album.js';
import { ensureProjectScaffold, applyProjectPresets, listPresetGroups, listPresets, PRESET_FILE } from '../src/doc/project.js';
import { renderDocument } from '../src/render/index.js';
import { loadDoc } from '../src/doc/io.js';
import { TOOLS } from '../src/mcp/tools.js';
import type { PenDocument } from '../src/schema/index.js';

/** 画谱的两个操作：establish（提取候选 / 应用）与 adjust（dry-run 影响面 / 应用） */

let root: string;
let design: string;

function node(id: string, extra: Record<string, unknown>): Record<string, unknown> {
  return { type: 'rectangle', id, width: 60, height: 40, ...extra };
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'paintress-album-'));
  ensureProjectScaffold(root);
  design = join(root, 'screen.ptr');
  writeFileSync(
    design,
    JSON.stringify(
      {
        version: '2.22',
        fileToken: '00000000-0000-4000-8000-0000000000cc',
        variables: {},
        'x-paintress': { spec: '1' },
        children: [
          {
            type: 'frame',
            id: 'board',
            width: 300,
            height: 200,
            children: [
              // 两个卡片：同色同圆角 → 既是 token 候选（出现 2 次）也是 preset 候选
              node('a', { fill: '#3B82F6', cornerRadius: 8 }),
              node('b', { fill: '#3B82F6', cornerRadius: 8 }),
              // 只出现一次 → 不当候选
              node('c', { fill: '#FF0000', cornerRadius: 12 }),
            ],
          },
        ],
      },
      null,
      2,
    ),
  );
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('establish：提取候选', () => {
  it('出现 ≥2 次的字面量成为 token 候选，出现 1 次的不算', () => {
    const plan = planEstablish(loadDoc(design).doc);
    const keys = plan.tokens.map((t) => `${t.type}:${t.value}`).sort();
    expect(keys).toContain('color:#3B82F6');
    expect(keys).toContain('radius:8');
    expect(keys).not.toContain('color:#FF0000');
    expect(plan.groups.length).toBe(1);
    expect(plan.groups[0]?.target).toBe('rectangle');
    expect(plan.groups[0]?.uses.sort()).toEqual(['a', 'b']);
  });

  it('apply=false 时一个字节都不写', async () => {
    const out = (await TOOLS['paintress_establish']!.run({ path: design })) as { applied: boolean };
    expect(out.applied).toBe(false);
    expect(loadDoc(design).doc.children[0]).toMatchObject({ type: 'frame' });
    const a = (loadDoc(design).doc.children[0] as Record<string, unknown>)['children'] as Record<string, unknown>[];
    expect(a[0]?.['fill']).toBe('#3B82F6'); // 仍是裸值
    expect(listPresets(root).items).toEqual([]);
  });

  it('apply=true：写 token 与组，并把命中节点改成 preset 引用', () => {
    const plan = planEstablish(loadDoc(design).doc);
    const res = applyEstablish(design, plan);
    expect(res.written.tokens.length).toBeGreaterThan(0);
    expect(res.written.groups.length).toBe(1);

    const doc = loadDoc(design).doc;
    const kids = (doc.children[0] as Record<string, unknown>)['children'] as Record<string, unknown>[];
    expect(kids[0]?.['preset']).toBe(res.written.groups[0]);
    expect(kids[0]?.['fill']).toBeUndefined(); // 组属性不烤进文档
    // 未命中组的节点：裸值换成 $token
    expect(kids[2]?.['fill']).toBe('#FF0000');

    const presets = listPresets(root).items;
    expect(presets.some((p) => p.type === 'color' && p.value === '#3B82F6')).toBe(true);
    expect(listPresetGroups(root).groups[res.written.groups[0] as string]).toBeDefined();
  });
});

describe('adjust：dry-run 与落盘', () => {
  it('改 token 先给影响面（节点 + preset 组），不写盘', () => {
    const loaded = loadDoc(design).doc;
    const presetDoc = readPresetDoc(design);
    const token = listPresets(root).items.find((p) => p.type === 'color');
    expect(token).toBeDefined();
    const plan = planAdjust(loaded, presetDoc, { key: token!.key, value: '#123456' });
    expect(plan.kind).toBe('token');
    expect(plan.changes.length).toBeGreaterThan(0);
    expect(plan.changes.every((c) => c.after === '#123456')).toBe(true);
    // dry-run 不动文件
    expect(listPresets(root).items.find((p) => p.key === token!.key)?.value).not.toBe('#123456');
  });

  it('apply=true 只改预设文件，设计稿保持引用', () => {
    const loaded = loadDoc(design).doc;
    const presetDoc = readPresetDoc(design);
    const token = listPresets(root).items.find((p) => p.type === 'color')!;
    const plan = planAdjust(loaded, presetDoc, { key: token.key, value: '#123456' });
    applyAdjust(design, presetDoc, plan);
    expect(listPresets(root).items.find((p) => p.key === token.key)?.value).toBe('#123456');
    expect(loadDoc(design).doc.variables?.[token.key]).toBeUndefined();
  });

  it('改组属性：影响面是被引用该组的节点', () => {
    const groupName = listPresetGroups(root).groups ? Object.keys(listPresetGroups(root).groups)[0] : undefined;
    expect(groupName).toBeDefined();
    const loaded = loadDoc(design).doc;
    const presetDoc = readPresetDoc(design);
    const plan = planAdjust(loaded, presetDoc, { group: groupName!, prop: 'fill', value: '#222222' });
    expect(plan.kind).toBe('group');
    expect(plan.changes.map((c) => c.where)).toContain('a');
    applyAdjust(design, presetDoc, plan);
    expect(listPresetGroups(root).groups[groupName!]?.props['fill']).toBe('#222222');
  });

  it('不存在的组直接报错；不存在的 token 在 apply 时报错（dry-run 只给 0 影响面）', () => {
    const dry = TOOLS['paintress_adjust']!.run({ path: design, key: 'nope', value: '#000000' }) as {
      applied: boolean;
      changes: unknown[];
    };
    expect(dry.applied).toBe(false);
    expect(dry.changes).toEqual([]);
    expect(() => TOOLS['paintress_adjust']!.run({ path: design, key: 'nope', value: '#000000', apply: true })).toThrow();
    expect(() =>
      TOOLS['paintress_adjust']!.run({ path: design, group: 'nope', prop: 'fill', value: '#000000' }),
    ).toThrow();
  });
});

describe('工具面', () => {
  it('paintress_audit 在 establish 之后不再报「未使用的 preset 组」', async () => {
    const audit = (await TOOLS['paintress_audit']!.run({ path: design })) as {
      findings: { kind: string; message: string }[];
    };
    expect(audit.findings.some((f) => f.kind === 'unused-preset')).toBe(false);
  });
});

describe('字号 token（D0）', () => {
  it('重复 fontSize 提成 fontSize token；apply 后渲染仍是 16px、0 警告', () => {
    const dir = mkdtempSync(join(tmpdir(), 'paintress-fontsize-album-'));
    try {
      ensureProjectScaffold(dir);
      const path = join(dir, 'screen.ptr');
      writeFileSync(
        path,
        JSON.stringify({
          version: '2.22',
          fileToken: '00000000-0000-4000-8000-0000000000ff',
          variables: {},
          children: [
            {
              type: 'frame',
              id: 'board',
              width: 200,
              height: 100,
              children: [
                { type: 'text', id: 't1', content: 'A', fontSize: 16 },
                { type: 'text', id: 't2', content: 'B', fontSize: 16 },
              ],
            },
          ],
        }),
      );

      const plan = planEstablish(loadDoc(path).doc);
      expect(plan.tokens.find((t) => t.type === 'fontSize')).toMatchObject({ key: 'fontSize-16', value: '16' });

      applyEstablish(path, plan);
      const doc = loadDoc(path).doc;
      const kids = (doc.children[0] as Record<string, unknown>)['children'] as Record<string, unknown>[];
      expect(kids[0]?.['fontSize']).toBe('$fontSize-16');
      expect(loadDoc(join(dir, PRESET_FILE)).doc.variables?.['fontSize-16']).toMatchObject({ type: 'number', value: 16 });

      const out = renderDocument(applyProjectPresets(doc, path).doc);
      expect(out.html).toContain('font-size:16px');
      expect(out.warnings).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
