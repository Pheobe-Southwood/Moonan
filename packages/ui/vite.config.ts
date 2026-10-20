import { defineConfig } from 'vite';

/**
 * WebUI 是纯客户端 SPA：产物交给 apps/moonan 的 HTTP 服务托管（默认 21315）。
 * `base: './'` 让产物可以放在任意子路径下。
 */
export default defineConfig({
  base: './',
  build: {
    outDir: 'dist/web',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
  server: {
    port: 21316,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:21315',
        ws: true,
      },
    },
  },
});
