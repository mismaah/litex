import { defineConfig } from 'vite';

export default defineConfig({
  root: 'web',
  build: { outDir: '../dist/web', emptyOutDir: true, target: 'es2020', cssMinify: true },
  server: { host: true, proxy: { '/api': 'http://localhost:8787' } },
});
