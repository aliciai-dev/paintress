import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';

/**
 * 开发期：vite dev server（3317）把 API/渲染/文件/事件请求代理到本地 daemon。
 * 目标端口默认 6033；daemon 在端口阶梯上跳级时用 PAINTRESS_PORT 指过去。
 * 生产期：`vite build` 产出 ui/dist，由 daemon 直接托管（无需 dev server）。
 */
const daemonPort = process.env.PAINTRESS_PORT ?? '6033';
const daemonOrigin = `http://127.0.0.1:${daemonPort}`;
export default defineConfig({
  plugins: [solid()],
  server: {
    port: 3317,
    strictPort: true,
    proxy: {
      '/api': daemonOrigin,
      '/render': daemonOrigin,
      '/files': daemonOrigin,
      '/events': daemonOrigin,
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
  },
});
