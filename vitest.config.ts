import { defineConfig } from 'vitest/config';

// 测试不依赖外网：内置网络字体（jsDelivr）在测试进程里统一关掉，
// 字体链路本身仍由单测用本地 fixture / 注册表覆盖。
export default defineConfig({
  test: {
    setupFiles: ['./test/setup-env.ts'],
  },
});
