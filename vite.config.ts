/** 演示面板的开发与生产构建配置。 */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({ plugins: [react()], root: 'web', build: { outDir: '../dist/panel', emptyOutDir: true } });
