import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditDoc, auditInputFrom } from '../src/doc/audit.js';
import { PRESET_FILE, setPreset, setPresetGroup } from '../src/doc/project.js';
import { loadDoc } from '../src/doc/io.js';
import { TOOLS } from '../src/mcp/tools.js';
import type { PenDocument } from '../src/schema/index.js';

/** 画谱审计（B3）：只读报告，三类问题各造一份样例 */

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'paintress-audit-'));
  copyFileSync(join(import.meta.dirname, 'fixtures/basic.pen'), join(root, '__components.ptr'));
  setPreset(root, { key: 'color-brand', type: 'color', value: '#3B82F6' });
  setPreset(root, { key: 'radius-md', type: 'radius', value: '6' });
  setPreset(root, { key: 'space-md', type: 'spacing', value: '12' });
  setPresetGroup(root, { name: 'body-text', target: 'text', props: { fill: '$color-brand' } });
  setPresetGroup(root, { name: 'ghost-group', target: 'frame', props: { gap: '$space-md' } });
  writeFileSync(
    join(root, 'screen.ptr'),
    JSON.stringify(
      {
        version: '2.22',
        fileToken: '00000000-0000-4000-8000-0000000000bb',
        variables: {},
        'x-paintress': { spec: '1' },
        children: [
          {
            type: 'frame',
            id: 'board',
            width: 300,
            height: 200,
            gap: 12, // 裸值 = $space-md
            children: [
              { type: 'text', id: 'a', preset: 'body-text', content: 'A' },
              { type: 'text', id: 'b', preset: 'nope', content: 'B' },
              // 字号 / 字体族裸值：D0 之后应分别建议成 $fontSize-16 / $font-ui
              { type: 'text', id: 'sized', content: '16', fontSize: 16, fontFamily: 'Inter' },
              // 裸色 + 裸圆角，且显式允许字面量（逃生舱）
              {
                type: 'rectangle',
                id: 'escaped',
                width: 40,
                height: 40,
                fill: '#3B82F6',
                cornerRadius: 6,
                metadata: { allowLiteral: true },
              },
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

describe('auditDoc', () => {
  function run(): ReturnType<typeof auditDoc> {
    const path = join(root, 'screen.ptr');
    const loaded = loadDoc(path);
    const preset = loadDoc(join(root, PRESET_FILE)).doc;
    const tokens = [
      { key: 'color-brand', type: 'color', value: '#3B82F6' },
      { key: 'radius-md', type: 'radius', value: '6' },
      { key: 'space-md', type: 'spacing', value: '12' },
      { key: 'fontSize-16', type: 'fontSize', value: '16' },
      { key: 'font-ui', type: 'font', value: 'Inter' },
      { key: 'orphan', type: 'color', value: '#000000' },
    ];
    return auditDoc(loaded.doc, auditInputFrom(loaded.doc, tokens, preset));
  }

  it('裸值命中 token 时给建议（gap 12 → $space-md）', () => {
    const r = run();
    const hit = r.findings.find((f) => f.kind === 'literal' && f.where === 'board');
    expect(hit?.suggestion).toBe('$space-md');
    expect(hit?.message).toContain('gap');
  });

  it('metadata.allowLiteral 的节点跳过裸值检查', () => {
    const r = run();
    expect(r.findings.some((f) => f.where === 'escaped' && f.kind === 'literal')).toBe(false);
  });

  it('悬空 preset 引用被列出', () => {
    const r = run();
    expect(r.findings.some((f) => f.kind === 'dangling-preset' && f.where === 'b')).toBe(true);
  });

  it('没被引用的 preset 组与孤儿 token 各自成条', () => {
    const r = run();
    expect(r.findings.some((f) => f.kind === 'unused-preset' && f.message.includes('ghost-group'))).toBe(true);
    expect(r.findings.some((f) => f.kind === 'orphan-token' && f.message.includes('$orphan'))).toBe(true);
    // body-text 被 a 引用，不算未使用
    expect(r.findings.some((f) => f.kind === 'unused-preset' && f.message.includes('body-text'))).toBe(false);
  });

  it('summary 是给人看的一句话', () => {
    expect(run().summary).toMatch(/越界裸值 \d+/);
  });

  it('字号建议 $fontSize-16、字体族建议 $font-ui（fontSize 不再被归到 font）', () => {
    const r = run();
    const size = r.findings.find((f) => f.kind === 'literal' && f.where === 'sized' && f.message.includes('fontSize'));
    expect(size?.suggestion).toBe('$fontSize-16');
    const family = r.findings.find((f) => f.kind === 'literal' && f.where === 'sized' && f.message.includes('fontFamily'));
    expect(family?.suggestion).toBe('$font-ui');
  });
});

describe('paintress_audit 工具', () => {
  it('走项目路径，返回 counts 与 findings', async () => {
    const out = (await TOOLS['paintress_audit']!.run({ path: join(root, 'screen.ptr') })) as {
      ok: boolean;
      counts: { literal: number };
      findings: { kind: string }[];
      summary: string;
    };
    expect(out.ok).toBe(true);
    expect(out.counts.literal).toBeGreaterThan(0);
    expect(out.findings.some((f) => f.kind === 'dangling-preset')).toBe(true);
    expect(out.summary.length).toBeGreaterThan(0);
  });
});

describe('preset 组里的字面量', () => {
  it('组属性不是 $token → preset-literal', () => {
    const doc = { version: '2.22', children: [] } as unknown as PenDocument;
    const preset = {
      version: '2.22',
      variables: {},
      children: [],
      'x-paintress': { spec: '1', presets: { version: 1, groups: { bad: { target: 'text', props: { fill: '#fff' } } } } },
    } as unknown as PenDocument;
    const r = auditDoc(doc, auditInputFrom(doc, [], preset));
    expect(r.counts['preset-literal']).toBe(1);
    expect(r.findings[0]?.message).toContain('应当引用 $token');
  });
});
