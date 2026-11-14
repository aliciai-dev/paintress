import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TOOLS } from '../src/mcp/tools.js';

/** 对外文档漂移：工具清单、格式与项目文件、双语小节数量 */

const read = (name: string): string => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');

describe('对外文档', () => {
  const en = read('README.md');
  const zh = read('README.zh-CN.md');

  it('每个 MCP 工具都在两份 README 里出现', () => {
    for (const name of Object.keys(TOOLS)) {
      expect(en.includes(name), `README.md 缺 ${name}`).toBe(true);
      expect(zh.includes(name), `README.zh-CN.md 缺 ${name}`).toBe(true);
    }
  });

  it('格式、项目文件与环境变量在两个 README 里都有说明', () => {
    for (const needle of ['.ptr', '__preset.ptr', '__components.ptr', 'PTR_BROWSER', 'PAINTRESS_HOME']) {
      expect(en, `README.md 缺 ${needle}`).toContain(needle);
      expect(zh, `README.zh-CN.md 缺 ${needle}`).toContain(needle);
    }
  });

  it('两份 README 的二级小节数量一致（一侧新增就会失衡）', () => {
    const count = (text: string): number => (text.match(/^## /gm) ?? []).length;
    expect(count(zh)).toBe(count(en));
  });
});
