import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applyProjectPresets,
  COMPONENTS_FILE,
  ensureProjectScaffold,
  listPresetGroups,
  listPresets,
  PRESET_FILE,
  removePreset,
  removePresetGroup,
  setPreset,
  setPresetGroup,
  withProjectPresets,
} from '../src/doc/project.js';
import { renderDocument } from '../src/render/index.js';
import { validateDoc } from '../src/doc/validate.js';
import { loadDoc } from '../src/doc/io.js';
import type { PenDocument } from '../src/schema/index.js';
import { TOOLS } from '../src/mcp/tools.js';

/** 项目级预设：脚手架、写入、合并优先级、校验与「不烤进设计稿」 */

let root: string;
let design: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'paintress-preset-'));
  copyFileSync(join(import.meta.dirname, 'fixtures/basic.pen'), join(root, 'design.ptr'));
  design = join(root, 'design.ptr');
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('脚手架', () => {
  it('首次创建两个文件，第二次一个字都不动', () => {
    const first = ensureProjectScaffold(root);
    expect(first.created.map((p) => p.split('/').pop()).sort()).toEqual([COMPONENTS_FILE, PRESET_FILE]);

    const before = readFileSync(join(root, PRESET_FILE), 'utf8');
    const second = ensureProjectScaffold(root);
    expect(second.created).toEqual([]);
    expect(readFileSync(join(root, PRESET_FILE), 'utf8')).toBe(before);
  });

  it('预设文件本身是合法设计稿（只有变量，没有画布内容）', () => {
    const loaded = loadDoc(join(root, PRESET_FILE));
    expect(loaded.doc.children).toEqual([]);
    expect(loaded.validation.ok).toBe(true);
  });
});

describe('写入与读取', () => {
  it('setPreset 落盘：颜色存 string、倒角存 number', () => {
    const items = setPreset(root, { key: 'color-brand', type: 'color', value: '#3b82f6', name: '主色' });
    expect(items).toEqual([{ key: 'color-brand', type: 'color', name: '主色', value: '#3B82F6' }]);

    setPreset(root, { key: 'radius-md', type: 'radius', value: '6', name: '圆角中' });
    const loaded = loadDoc(join(root, PRESET_FILE));
    expect(loaded.doc.variables?.['color-brand']).toMatchObject({ type: 'color', value: '#3B82F6' });
    expect(loaded.doc.variables?.['radius-md']).toMatchObject({ type: 'number', value: 6 });

    const { items: all } = listPresets(root);
    expect(all.map((p) => `${p.type}:${p.key}`)).toEqual(['color:color-brand', 'radius:radius-md']);
  });

  it('非法值被拒，不落盘', () => {
    expect(() => setPreset(root, { key: 'bad', type: 'color', value: 'red' })).toThrow(/#RGB/);
    expect(() => setPreset(root, { key: 'bad', type: 'radius', value: '-2' })).toThrow(/非负/);
    expect(listPresets(root).items.some((p) => p.key === 'bad')).toBe(false);
  });

  it('removePreset 删掉变量与元数据', () => {
    setPreset(root, { key: 'color-temp', type: 'color', value: '#000000' });
    const items = removePreset(root, 'color-temp');
    expect(items.some((p) => p.key === 'color-temp')).toBe(false);
    expect(loadDoc(join(root, PRESET_FILE)).doc.variables?.['color-temp']).toBeUndefined();
  });
});

describe('合并与校验', () => {
  it('设计稿里的 $预设名 算已定义；本地同名变量优先并给警告', () => {
    const presetDoc = loadDoc(join(root, PRESET_FILE)).doc;
    const doc = {
      version: '2.22',
      variables: { 'color-brand': { type: 'color', value: '#111111' } },
      children: [{ type: 'rectangle', id: 'b1', name: 'B', width: 100, height: 100, fill: '$color-brand', cornerRadius: '$radius-md' }],
    } as unknown as PenDocument;

    const merged = withProjectPresets(doc, presetDoc);
    const names = new Set(Object.keys(presetDoc.variables ?? {}));

    const plain = validateDoc(doc);
    expect(plain.warnings.some((w) => w.message.includes('$radius-md'))).toBe(true);

    const withPresets = validateDoc(merged, { knownVars: names, presetVars: names });
    expect(withPresets.warnings.some((w) => w.message.includes('未定义的变量'))).toBe(false);
    expect(withPresets.warnings.some((w) => w.message.includes('覆盖了项目预设'))).toBe(true);
  });

  it('applyProjectPresets 找到上层预设文件，且不改原文档', () => {
    const nested = join(root, 'screens');
    mkdirSync(nested, { recursive: true });
    copyFileSync(join(import.meta.dirname, 'fixtures/basic.pen'), join(nested, 'home.ptr'));
    const loaded = loadDoc(join(nested, 'home.ptr'));
    const { doc, presetNames } = applyProjectPresets(loaded.doc, join(nested, 'home.ptr'));
    expect(presetNames.has('color-brand')).toBe(true);
    expect(doc.variables?.['color-brand']).toMatchObject({ value: '#3B82F6' });
    expect(loaded.doc.variables?.['color-brand']).toBeUndefined();
  });
});

describe('谱值扩展：间距 / 字体（B1）', () => {
  it('spacing 落盘为 number，font 落盘为 string', () => {
    setPreset(root, { key: 'space-md', type: 'spacing', value: '12' });
    setPreset(root, { key: 'font-body', type: 'font', value: 'Inter, sans-serif' });
    const doc = loadDoc(join(root, PRESET_FILE)).doc;
    expect(doc.variables?.['space-md']).toMatchObject({ type: 'number', value: 12 });
    expect(doc.variables?.['font-body']).toMatchObject({ type: 'string', value: 'Inter, sans-serif' });
    expect(listPresets(root).items.find((p) => p.key === 'font-body')?.type).toBe('font');
  });

  it('间距同样是「非负数字」，空字体被拒', () => {
    expect(() => setPreset(root, { key: 'bad-space', type: 'spacing', value: '-1' })).toThrow(/非负/);
    expect(() => setPreset(root, { key: 'bad-font', type: 'font', value: '   ' })).toThrow(/不能为空/);
  });
});

describe('谱式：preset 组 + 节点引用（B2）', () => {
  it('写组不丢 token，写 token 不丢组', () => {
    // 字号用 fontSize token（D0 之后 fontSize 引用 spacing token 会被校验出类型错配）
    setPreset(root, { key: 'fontSize-16', type: 'fontSize', value: '16' });
    setPresetGroup(root, { name: 'body-text', target: 'text', props: { fill: '$color-brand', fontSize: '$fontSize-16' } });
    setPreset(root, { key: 'color-muted', type: 'color', value: '#7a7166' });

    const groups = listPresetGroups(root).groups;
    expect(groups['body-text']).toEqual({ target: 'text', props: { fill: '$color-brand', fontSize: '$fontSize-16' } });
    expect(listPresets(root).items.some((p) => p.key === 'color-muted')).toBe(true);

    removePreset(root, 'color-muted');
    expect(listPresetGroups(root).groups['body-text']).toBeDefined();
  });

  it('渲染时先铺组属性，节点自己的属性优先', () => {
    const presetDoc = loadDoc(join(root, PRESET_FILE)).doc;
    const doc = {
      version: '2.22',
      variables: {},
      children: [
        {
          type: 'frame',
          id: 'board',
          width: 200,
          height: 100,
          children: [
            { type: 'text', id: 'a', preset: 'body-text', content: 'A' },
            { type: 'text', id: 'b', preset: 'body-text', content: 'B', fill: '#FF0000' },
          ],
        },
      ],
    } as unknown as PenDocument;

    const merged = withProjectPresets(doc, presetDoc);
    const out = renderDocument(merged);
    const html = out.html;
    // a：组里的 fill 生效；b：自己的 #FF0000 覆盖组里的 $color-brand
    expect(html).toContain('color:#3B82F6');
    expect(html).toContain('color:#FF0000');
    expect(out.warnings).toEqual([]);
  });

  it('悬空引用 / 类型不符 / 组里写裸值 → 校验警告', () => {
    const doc = {
      version: '2.22',
      children: [
        { type: 'text', id: 'a', preset: 'nope' },
        { type: 'rectangle', id: 'b', preset: 'body-text' },
      ],
    } as unknown as PenDocument;
    const warnings = validateDoc(doc, {
      presetGroups: {
        'body-text': { target: 'text', props: { fill: '$color-brand', opacity: '0.5' } },
      },
    }).warnings.map((w) => w.message);
    expect(warnings.some((m) => m.includes('preset "nope" 不存在'))).toBe(true);
    expect(warnings.some((m) => m.includes('适用于 text'))).toBe(true);
    expect(warnings.some((m) => m.includes('是字面量 "0.5"'))).toBe(true);
  });

  it('删组后引用变悬空（不静默）', () => {
    removePresetGroup(root, 'body-text');
    expect(listPresetGroups(root).groups['body-text']).toBeUndefined();
  });
});

describe('写路径不把预设烤进设计稿', () => {
  it('paintress_update 之后设计稿里仍然只有自己的变量', async () => {
    const path = join(root, 'screens', 'home.ptr');
    const before = loadDoc(path).doc;
    const firstId = String((before.children[0] as Record<string, unknown>)['id']);
    await TOOLS['paintress_update']!.run({ path, id: firstId, patch: { fill: '$color-brand' } });
    const after = loadDoc(path).doc;
    expect(after.variables?.['color-brand']).toBeUndefined();
    expect(after.variables?.['radius-md']).toBeUndefined();
  });
});

describe('paintress_preset 工具', () => {
  it('list / set / remove 走同一条项目路径', async () => {
    const listed = (await TOOLS['paintress_preset']!.run({ action: 'list', path: design })) as {
      path: string;
      items: { key: string; type: string }[];
    };
    expect(listed.path).toBe(join(root, PRESET_FILE));
    expect(listed.items.some((p) => p.key === 'color-brand')).toBe(true);

    const set = (await TOOLS['paintress_preset']!.run({
      action: 'set',
      path: design,
      key: 'color-accent',
      type: 'color',
      value: '#908030',
      name: '点缀色',
    })) as { items: { key: string; name: string }[] };
    expect(set.items.find((p) => p.key === 'color-accent')?.name).toBe('点缀色');

    const removed = (await TOOLS['paintress_preset']!.run({ action: 'remove', path: design, key: 'color-accent' })) as {
      items: { key: string }[];
    };
    expect(removed.items.some((p) => p.key === 'color-accent')).toBe(false);
  });

  it('没有项目文件时当场初始化（不需要先起 daemon）', async () => {
    const lonely = mkdtempSync(join(tmpdir(), 'paintress-noproj-'));
    try {
      const res = (await TOOLS['paintress_preset']!.run({
        action: 'set',
        path: lonely,
        key: 'color-x',
        type: 'color',
        value: '#000000',
      })) as { items: { key: string }[] };
      expect(res.items.map((p) => p.key)).toEqual(['color-x']);
      expect(readFileSync(join(lonely, PRESET_FILE), 'utf8')).toContain('color-x');
    } finally {
      rmSync(lonely, { recursive: true, force: true });
    }
  });
});

describe('字号 token（D0）', () => {
  it('fontSize 落盘为 number；非法值被拒', () => {
    setPreset(root, { key: 'fontSize-lg', type: 'fontSize', value: '24' });
    const doc = loadDoc(join(root, PRESET_FILE)).doc;
    expect(doc.variables?.['fontSize-lg']).toMatchObject({ type: 'number', value: 24 });
    expect(listPresets(root).items.find((p) => p.key === 'fontSize-lg')?.type).toBe('fontSize');
    expect(() => setPreset(root, { key: 'bad-size', type: 'fontSize', value: '-1' })).toThrow(/字号/);
  });

  it('老文件里的 font + 数字值：读取归一为字号，渲染 16px、文件一个字不改', () => {
    const legacy = mkdtempSync(join(tmpdir(), 'paintress-fontsize-'));
    try {
      // 2026-11-15 之前的 establish 会产出这种形状（font 类型 + 数字字串）
      writeFileSync(
        join(legacy, PRESET_FILE),
        JSON.stringify({
          version: '2.22',
          fileToken: '00000000-0000-4000-8000-0000000000dd',
          variables: { 'font-16': { type: 'string', value: '16' } },
          children: [],
          'x-paintress': { spec: '1', presets: { version: 1, items: { 'font-16': { type: 'font', name: 'body' } } } },
        }),
      );
      const designPath = join(legacy, 'a.ptr');
      writeFileSync(
        designPath,
        JSON.stringify({
          version: '2.22',
          fileToken: '00000000-0000-4000-8000-0000000000ee',
          variables: {},
          children: [
            { type: 'frame', id: 'b', width: 200, height: 100, children: [{ type: 'text', id: 't', content: 'A', fontSize: '$font-16' }] },
          ],
        }),
      );

      expect(listPresets(legacy).items).toEqual([{ key: 'font-16', type: 'fontSize', name: 'body', value: '16' }]);
      const before = readFileSync(join(legacy, PRESET_FILE), 'utf8');
      const merged = applyProjectPresets(loadDoc(designPath).doc, designPath).doc;
      expect(merged.variables?.['font-16']).toMatchObject({ type: 'number', value: 16 });

      const out = renderDocument(merged);
      expect(out.html).toContain('font-size:16px');
      expect(out.warnings).toEqual([]);
      // 读取不落盘：老文件保持原样，第一次编辑才升级类型
      expect(readFileSync(join(legacy, PRESET_FILE), 'utf8')).toBe(before);
    } finally {
      rmSync(legacy, { recursive: true, force: true });
    }
  });

  it('引用类型校验：颜色属性引用倒角、字号引用字体族 → 各一条 warning；同类引用不报', () => {
    const doc = {
      version: '2.22',
      variables: {},
      children: [{ type: 'text', id: 't', content: 'A', fill: '$radius-md', fontSize: '$font-body' }],
    } as unknown as PenDocument;
    const kinds = { 'radius-md': 'radius', 'font-body': 'font', 'fontSize-lg': 'fontSize' } as const;
    const messages = validateDoc(doc, { presetKinds: { ...kinds } }).warnings.map((w) => w.message);
    expect(messages.some((m) => m.includes('fill 需要颜色 token') && m.includes('$radius-md'))).toBe(true);
    expect(messages.some((m) => m.includes('fontSize 需要字号 token') && m.includes('$font-body'))).toBe(true);

    const ok = {
      version: '2.22',
      variables: {},
      children: [{ type: 'text', id: 't', content: 'A', fontSize: '$fontSize-lg', fill: '$fontSize-lg' }],
    } as unknown as PenDocument;
    expect(validateDoc(ok, { presetKinds: { ...kinds } }).warnings.some((w) => w.message.includes('fill 需要颜色 token'))).toBe(true);
    const good = {
      version: '2.22',
      variables: {},
      children: [{ type: 'text', id: 't', content: 'A', fontSize: '$fontSize-lg' }],
    } as unknown as PenDocument;
    expect(validateDoc(good, { presetKinds: { ...kinds } }).warnings.some((w) => w.message.includes('需要字号'))).toBe(false);
  });
});
