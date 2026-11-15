#!/usr/bin/env node
/**
 * 发布前自检：确保 `npm pack` 之后安装到用户机器上的东西是完整的。
 *
 * 背景：`files` 只声明目录，构建产物缺失时 npm 不会报错，装完才会在运行时炸
 * （`paintress/mcp` 指向不存在的文件、daemon 找不到 `ui/dist` 而降级）。
 * 所以把「package.json 声明的入口」逐个落地检查，作为 `prepack` 的一部分。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** @type {Record<string, any>} */
let pkg;
try {
  pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
} catch (cause) {
  console.error(`无法读取 package.json：${cause instanceof Error ? cause.message : String(cause)}`);
  process.exit(1);
}

/** @type {string[]} */
const errors = [];
/** @type {string[]} */
const checked = [];

function check(rel, what) {
  const abs = join(root, rel);
  const ok = existsSync(abs) && statSync(abs).isFile();
  checked.push(`${ok ? '✓' : '✗'} ${rel}  (${what})`);
  if (!ok) errors.push(`缺少 ${rel}（${what}）`);
  return ok;
}

// 1) package.json 里声明的每个入口都必须真实存在
for (const [key, value] of Object.entries(pkg.exports ?? {})) {
  const targets = typeof value === 'string' ? { import: value } : value;
  for (const [condition, target] of Object.entries(targets ?? {})) {
    if (typeof target !== 'string') continue;
    check(target.replace(/^\.\//, ''), `exports["${key}"].${condition}`);
  }
}
if (typeof pkg.types === 'string') check(pkg.types.replace(/^\.\//, ''), 'types');
if (typeof pkg.main === 'string') check(pkg.main.replace(/^\.\//, ''), 'main');
for (const [bin, target] of Object.entries(pkg.bin ?? {})) {
  const raw = String(target);
  // npm 11 起会把带 ./ 的 bin 当无效值改写，并在 publish 时打 warning，这里直接拦住
  if (raw.startsWith('./')) errors.push(`bin:${bin} 不要带 ./ 前缀（npm 发布时会改写该值）：${raw}`);
  check(raw.replace(/^\.\//, ''), `bin:${bin}`);
}

// 2) 前端产物：daemon 按 dist/../ui/dist 定位，不在包里就只能降级
if (check('ui/dist/index.html', 'viewer 前端入口')) {
  const assets = join(root, 'ui/dist/assets');
  const hasAssets = existsSync(assets) && statSync(assets).isDirectory();
  checked.push(`${hasAssets ? '✓' : '✗'} ui/dist/assets/  (viewer 静态资源)`);
  if (!hasAssets) errors.push('缺少 ui/dist/assets/（前端未构建）');
}

// 3) README 引用的资源与随包 skill
check('assets/logo.svg', 'README 品牌图');
check('assets/icon-512-wordmark.webp', 'README 图标');
check('skills/paintress/SKILL.md', 'agent skill');

// 4) CLI 必须是可执行的 ESM，带 shebang
const cliPath = join(root, 'dist/cli.js');
if (existsSync(cliPath)) {
  const head = readFileSync(cliPath, 'utf8').slice(0, 40);
  const hasShebang = head.startsWith('#!');
  checked.push(`${hasShebang ? '✓' : '✗'} dist/cli.js shebang`);
  if (!hasShebang) errors.push('dist/cli.js 缺少 shebang，bin 无法直接执行');
}

// 4b) 声明产物必须自成一体：相对 import 指向的文件得真实存在
//     （chunk 名带 hash 时最容易出这种事：d.ts 改名而引用没跟上）
function walkDts(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkDts(abs));
    else if (entry.name.endsWith('.d.ts')) out.push(abs);
  }
  return out;
}

let dangling = 0;
const dtsFiles = walkDts(join(root, 'dist'));
for (const file of dtsFiles) {
  const code = readFileSync(file, 'utf8');
  const rel = relative(root, file);
  for (const [, spec] of code.matchAll(/from\s+["'](\.{1,2}\/[^"']+)["']/g)) {
    const target = resolve(dirname(file), spec).replace(/\.js$/, '.d.ts');
    if (!existsSync(target)) {
      dangling++;
      errors.push(`${rel} 引用了不存在的 ${spec}`);
    }
  }
}
checked.push(`${dangling === 0 ? '✓' : '✗'} dist/**/*.d.ts  (${dtsFiles.length} 个声明文件，相对引用均可解析)`);

// 4c) 声明体积上限：新导出 schema 漏掉输出类型标注时，passthrough 推断会重新膨胀到 MB 级
//     （`pnpm check` 是 noEmit，抓不到；守门员是构建，这里再上一层保险，见 ARCHITECTURE.md#D-013）
const dtsEntry = join(root, 'dist/index.d.ts');
if (existsSync(dtsEntry)) {
  const size = statSync(dtsEntry).size;
  const limit = 512 * 1024;
  const ok = size <= limit;
  checked.push(`${ok ? '✓' : '✗'} dist/index.d.ts 体积 ${(size / 1024).toFixed(0)} KB（上限 512 KB）`);
  if (!ok) {
    errors.push(`dist/index.d.ts 膨胀到 ${(size / 1024).toFixed(0)} KB：检查新导出的 zod schema 是否漏了输出类型标注`);
  }
}

// 5) MCP Registry 清单：版本号必须与 package.json 一致，否则注册表里是旧版本
if (existsSync(join(root, 'server.json'))) {
  try {
    const manifest = JSON.parse(readFileSync(join(root, 'server.json'), 'utf8'));
    const same = manifest.version === pkg.version;
    checked.push(`${same ? '✓' : '✗'} server.json  version ${manifest.version} (package.json ${pkg.version})`);
    if (!same) errors.push(`server.json 的 version（${manifest.version}）与 package.json（${pkg.version}）不一致`);
  } catch (cause) {
    checked.push('✗ server.json  (JSON 解析失败)');
    errors.push(`server.json 不是合法 JSON：${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

console.log(checked.join('\n'));
if (errors.length > 0) {
  console.error(`\n发布自检失败（${errors.length} 项）：`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log('\n发布自检通过');
