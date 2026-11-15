import { defineConfig } from 'tsdown/config';

export default defineConfig({
  entry: ['src/index.ts', 'src/cli.ts', 'src/mcp/server.ts'],
  format: 'esm',
  target: 'node22',
  // 产物名写死（不带内容 hash）：exports 里的 types / import 指向固定路径。
  hash: false,
  // 声明产物已可用：schema 的输出类型由 src/schema/typed.ts 显式标注收敛，
  // 不再触发 TS7056，index.d.ts 约 105 KB（此前推断展开为 1.5 MB）。
  dts: true,
});
