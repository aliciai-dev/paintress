import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  COMPONENTS_FILE,
  ensureProjectScaffold,
  findNestedProjectFiles,
  findProjectRoot,
  findProjectRootStrict,
  PRESET_FILE,
  projectFilesInfo,
  setProjectRoots,
} from '../src/doc/project.js';

/** 项目根解析：注册根优先、写入严格、嵌套冲突可见 */

const tempDirs: string[] = [];

function makeProject(withStrayNested: boolean): { root: string; designDir: string; design: string } {
  const root = mkdtempSync(join(tmpdir(), 'paintress-root-'));
  tempDirs.push(root);
  const designDir = join(root, 'design');
  mkdirSync(designDir, { recursive: true });
  ensureProjectScaffold(root);
  if (withStrayNested) ensureProjectScaffold(designDir);
  const design = join(designDir, 'a.ptr');
  writeFileSync(
    design,
    JSON.stringify({ version: '2.22', fileToken: '00000000-0000-4000-8000-0000000000c1', variables: {}, children: [] }),
  );
  return { root, designDir, design };
}

beforeEach(() => setProjectRoots([]));
afterAll(() => {
  setProjectRoots([]);
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe('项目根解析', () => {
  it('注册根优先于「最近的脏目录」', () => {
    const { root, designDir, design } = makeProject(true);
    // 没注册时按最近的文件目录解析（这就是误建的来源）
    expect(findProjectRoot(design)).toBe(designDir);
    setProjectRoots([root]);
    expect(findProjectRoot(design)).toBe(root);
    expect(findProjectRootStrict(design)).toBe(root);
  });

  it('没有注册根、祖先有两套 → 严格解析报错，不猜', () => {
    const { design } = makeProject(true);
    expect(() => findProjectRootStrict(design)).toThrow(/不唯一/);
  });

  it('裸设计稿不在项目里 → 报错并提示先 paintress web，绝不就地建', () => {
    const dir = mkdtempSync(join(tmpdir(), 'paintress-bare-'));
    tempDirs.push(dir);
    const file = join(dir, 'x.ptr');
    writeFileSync(file, JSON.stringify({ version: '2.22', variables: {}, children: [] }));
    expect(() => findProjectRootStrict(file)).toThrow(/找不到项目根/);
  });

  it('显式目录可以作为项目根（CLI 传目录的场景）', () => {
    const { root } = makeProject(false);
    expect(findProjectRootStrict(root)).toBe(root);
  });

  it('projectFilesInfo 只在根建文件，并报告嵌套冲突', () => {
    const { root, designDir } = makeProject(true);
    const info = projectFilesInfo(root, { ensure: true });
    expect(info.presetExists).toBe(true);
    expect(info.componentsExists).toBe(true);
    expect(info.presetPath).toBe(join(root, PRESET_FILE));
    expect(info.componentsPath).toBe(join(root, COMPONENTS_FILE));
    expect(info.conflicts).toContain(designDir);
    expect(findNestedProjectFiles(root)).toContain(designDir);
  });

  it('嵌套扫描跳过 node_modules 与点目录', () => {
    const { root } = makeProject(false);
    mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true });
    ensureProjectScaffold(join(root, 'node_modules', 'pkg'));
    mkdirSync(join(root, '.cache'), { recursive: true });
    ensureProjectScaffold(join(root, '.cache'));
    expect(findNestedProjectFiles(root)).toEqual([]);
  });
});
