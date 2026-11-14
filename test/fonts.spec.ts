import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ensureProjectScaffold,
  listPresetGroups,
  listPresets,
  PRESET_FILE,
  projectFontRegistry,
  removeFontEntry,
  seedDesignSystem,
  setDefaultFont,
  setFontEntry,
} from '../src/doc/project.js';
import {
  BUILTIN_FONT_STACK,
  fontRegistryOf,
  planFonts,
  stackWithPreviews,
  textFontGaps,
  type FontRegistry,
} from '../src/doc/fonts.js';
import { renderDocument } from '../src/render/index.js';
import { validateDoc } from '../src/doc/validate.js';
import { loadDoc } from '../src/doc/io.js';
import { TOOLS } from '../src/mcp/tools.js';
import type { PenDocument } from '../src/schema/index.js';

/** 字体注册表、渲染计划、缺口统计与预设种子（F1/F2/D4） */

let root: string;
let design: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'paintress-fonts-'));
  ensureProjectScaffold(root);
  design = join(root, 'screen.ptr');
  writeFileSync(
    design,
    JSON.stringify({
      version: '2.22',
      fileToken: '00000000-0000-4000-8000-0000000000f1',
      variables: {},
      children: [
        {
          type: 'frame',
          id: 'board',
          width: 300,
          height: 200,
          children: [
            { type: 'text', id: 'with-font', content: 'A', fontFamily: 'Inter', fontSize: 16 },
            { type: 'text', id: 'no-font', content: 'B', fontSize: 14 },
          ],
        },
      ],
    }),
  );
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('字体注册表', () => {
  it('web 来源落盘并在读回时保留 preview', () => {
    const registry = setFontEntry(root, {
      family: 'Inter',
      source: { kind: 'web', target: 'https://cdn.example.com/inter.css' },
      preview: 'system-ui',
    });
    expect(registry.families['Inter']).toMatchObject({
      source: { kind: 'web', target: 'https://cdn.example.com/inter.css' },
      preview: 'system-ui',
    });
    expect(projectFontRegistry(root).registry.families['Inter']).toBeDefined();
    expect(loadDoc(join(root, PRESET_FILE)).doc['x-paintress']).toMatchObject({ fonts: { families: { Inter: {} } } });
  });

  it('system / bundle 必须给 preview；css / file 的路径必须在项目内且存在；web 必须是 http(s)', () => {
    expect(() => setFontEntry(root, { family: 'YaHei', source: { kind: 'system' } })).toThrow(/preview/);
    expect(() => setFontEntry(root, { family: 'Bundled', source: { kind: 'bundle' } })).toThrow(/preview/);
    expect(() => setFontEntry(root, { family: 'Missing', source: { kind: 'file', target: 'nope.woff2' } })).toThrow(
      /不存在/,
    );
    expect(() => setFontEntry(root, { family: 'Out', source: { kind: 'file', target: '../x.woff2' } })).toThrow(
      /越出项目|不存在/,
    );
    expect(() => setFontEntry(root, { family: 'Bad', source: { kind: 'web', target: 'ftp://x' } })).toThrow(/http/);
  });

  it('file 来源：项目内相对路径 + 消失后的 remove', () => {
    mkdirSync(join(root, 'assets'), { recursive: true });
    writeFileSync(join(root, 'assets', 'ray.woff2'), '');
    setFontEntry(root, {
      family: 'Raybend Display',
      source: { kind: 'file', target: 'assets/ray.woff2' },
      preview: 'Inter',
      metrics: { sizeAdjust: '96%' },
    });
    const registry = projectFontRegistry(root).registry;
    expect(registry.families['Raybend Display']?.metrics?.sizeAdjust).toBe('96%');
    removeFontEntry(root, 'Raybend Display');
    expect(projectFontRegistry(root).registry.families['Raybend Display']).toBeUndefined();
  });

  it('default 可以指向 token key', () => {
    setDefaultFont(root, 'font-ui');
    expect(projectFontRegistry(root).registry.default).toBe('font-ui');
  });
});

describe('渲染计划', () => {
  it('web 进 links、file 进 faces、preview 与默认栈拼进 CSS', () => {
    const registry = fontRegistryOf({
      'x-paintress': {
        fonts: {
          default: 'font-ui',
          families: {
            Inter: { source: { kind: 'web', target: 'https://cdn.example.com/inter.css' }, preview: 'Noto Sans SC' },
            Ray: {
              source: { kind: 'file', target: 'assets/ray.woff2' },
              preview: 'Inter',
              metrics: { sizeAdjust: '96%', ascentOverride: '92%' },
            },
          },
        },
      },
      variables: { 'font-ui': { type: 'string', value: 'Inter, sans-serif' } },
    } as unknown as PenDocument);

    const plan = planFonts(
      registry,
      (source) => (source.target === undefined ? null : `/files/proj/${source.target}`),
      { variables: { 'font-ui': { type: 'string', value: 'Inter, sans-serif' } } } as unknown as PenDocument,
    );
    expect(plan.links).toContain('https://cdn.example.com/inter.css');
    expect(plan.faces.find((f) => f.family === 'Ray')).toMatchObject({ src: '/files/proj/assets/ray.woff2', format: 'woff2' });
    // 带 metrics 的 preview 用别名 family，排在替代之前
    expect(plan.faces.find((f) => f.family === 'Preview: Ray')?.src).toBe('local("Inter")');
    expect(plan.previews['Ray']).toContain('"Preview: Ray"');
    expect(plan.defaultStack).toBe('Inter, sans-serif');
  });

  it('栈拼接：真字体在前、替代在后、generic 兜底，不重复', () => {
    expect(stackWithPreviews('Inter, Inter', { Inter: 'Noto Sans SC' })).toBe('Inter, "Noto Sans SC", sans-serif');
    expect(stackWithPreviews('Inter, sans-serif', { Inter: 'Noto Sans SC' })).toBe(
      'Inter, sans-serif, "Noto Sans SC"',
    );
  });
});

describe('缺口与校验', () => {
  it('textFontGaps 统计没写字体 / 未登记的 family', () => {
    const doc = loadDoc(design).doc;
    const registry = fontRegistryOf({ 'x-paintress': { fonts: { families: {} } } } as unknown as PenDocument);
    const gaps = textFontGaps(doc, registry);
    expect(gaps.textNodes).toBe(1);
    expect(gaps.ids).toEqual(['no-font']);
    expect(gaps.unregistered).toEqual(['Inter']);
    expect(gaps.defaultStack.length).toBeGreaterThan(0);
  });

  it('validate 给字体三类 warning（缺字体 / 未登记 / system 无 preview）', () => {
    const doc = loadDoc(design).doc;
    const registry: FontRegistry = { families: {} };
    const messages = validateDoc(doc, { fontRegistry: registry }).warnings.map((w) => w.message);
    expect(messages.some((m) => m.includes('没有 fontFamily'))).toBe(true);
    expect(messages.some((m) => m.includes('字体未登记：Inter'))).toBe(true);

    const system = fontRegistryOf({
      'x-paintress': { fonts: { families: { YaHei: { source: { kind: 'system' } } } } },
    } as unknown as PenDocument);
    expect(validateDoc({ version: '2.22', children: [] }, { fontRegistry: system }).warnings.some((m) =>
      m.message.includes('没有 preview'),
    )).toBe(true);
  });

  it('渲染把 preview 拼在真字体后面（并在 .ptr-canvas 上给默认栈）', () => {
    const doc = loadDoc(design).doc;
    const plan = planFonts(
      fontRegistryOf({
        'x-paintress': { fonts: { families: { Inter: { source: { kind: 'system' }, preview: 'Noto Sans SC' } } } },
      } as unknown as PenDocument),
      () => null,
      doc,
    );
    const out = renderDocument(doc, { fonts: plan });
    expect(out.html).toContain('.ptr-canvas');
    expect(out.html).toContain('font-family:Inter, &quot;Noto Sans SC&quot;, sans-serif');
    expect(out.html).toContain(BUILTIN_FONT_STACK.split(',')[0]?.replace(/"/g, '') as string);
  });
});

describe('预设种子（D4）', () => {
  it('一次补齐 27 token + 6 组 + 2 个字体，默认 font-sans；连跑两次不重复', () => {
    const seedRoot = mkdtempSync(join(tmpdir(), 'paintress-seed-apply-'));
    try {
      ensureProjectScaffold(seedRoot);
      const second = seedDesignSystem(seedRoot, { apply: true });
      expect(second.applied).toBe(true);
      expect(second.created.tokens.length).toBe(27);
      expect(second.created.groups.length).toBe(6);
      expect(second.created.fonts.sort()).toEqual(['Inter Variable', 'Noto Sans SC Variable']);
      expect(second.created.defaultFont).toBe(true);

      const items = listPresets(seedRoot).items;
      expect(items.length).toBe(27);
      expect(items.find((p) => p.key === 'fontSize-16')?.type).toBe('fontSize');
      expect(items.find((p) => p.key === 'color-brand')?.value).toBe('#2563EB');
      expect(Object.keys(listPresetGroups(seedRoot).groups).sort()).toEqual([
        'button',
        'card',
        'input',
        'text.body',
        'text.muted',
        'text.title',
      ]);
      const registry = projectFontRegistry(seedRoot).registry;
      expect(registry.default).toBe('font-sans');
      expect(Object.keys(registry.families).sort()).toEqual(['Inter Variable', 'Noto Sans SC Variable']);

      const again = seedDesignSystem(seedRoot, { apply: true });
      expect(again.created).toEqual({ tokens: [], groups: [], fonts: [], defaultFont: false });
      expect(again.skipped.tokens.length).toBe(27);
    } finally {
      rmSync(seedRoot, { recursive: true, force: true });
    }
  });

  it('dry-run 一个字节都不写', () => {
    const fresh = mkdtempSync(join(tmpdir(), 'paintress-seed-'));
    try {
      const plan = seedDesignSystem(fresh, {});
      expect(plan.applied).toBe(false);
      expect(plan.created.tokens.length).toBe(27);
      expect(() => loadDoc(join(fresh, PRESET_FILE))).toThrow();
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });
});

describe('MCP：写入提示与设计系统概览', () => {
  it('insert 裸色值命中 token → hints 给出 $key；text 没写字体 → 提示补', async () => {
    await TOOLS['paintress_preset']!.run({ action: 'set', path: root, key: 'color-brand', type: 'color', value: '#2563EB' });
    const inserted = (await TOOLS['paintress_insert']!.run({
      path: design,
      parent: 'board',
      node: { type: 'rectangle', id: 'lit', width: 20, height: 20, fill: '#2563EB' },
    })) as { hints: string[] };
    expect(inserted.hints.some((h) => h.includes('$color-brand'))).toBe(true);

    const text = (await TOOLS['paintress_insert']!.run({
      path: design,
      parent: 'board',
      node: { type: 'text', id: 'plain', content: 'C' },
    })) as { hints: string[] };
    expect(text.hints.some((h) => h.includes('没有 fontFamily'))).toBe(true);
  });

  it('doc_info 带 designSystem 概览（token 计数 / 字体 / 缺口）', async () => {
    const info = (await TOOLS['paintress_doc_info']!.run({ path: design })) as {
      designSystem: { tokens: Record<string, number>; fonts: { families: string[] }; gaps: { textNodes: number } };
    };
    expect(info.designSystem.tokens.color).toBeGreaterThan(0);
    expect(info.designSystem.fonts.families.length).toBe(1);
    expect(info.designSystem.gaps.textNodes).toBeGreaterThan(0);
  });
});
