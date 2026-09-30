import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { serverConfigFromEnv } from './cordis/config.node.js';
import { serviceDefaults } from './cordis/config.js';
const { companyServer, companyClient, webui } = serviceDefaults;
export default defineConfig({
  plugins: [react()],
  root: 'dag-webui',
  publicDir: '../public',
  server: {
    host: companyServer.host,
    port: webui.devPort,
    strictPort: true,
    proxy: {
      [companyClient.baseURL]: {
        target: `http://${companyServer.host}:${serverConfigFromEnv().port}`,
        changeOrigin: true,
        configure(proxy) {
          proxy.on('proxyReq', (proxyReq, request) => {
            if ([companyServer.host, 'localhost'].some(host => request.headers.origin === `http://${host}:${webui.devPort}`)) proxyReq.removeHeader('origin');
          });
        },
      },
    },
  },
  preview: { host: companyServer.host, port: webui.devPort },
  build: { target: 'esnext', outDir: '../dist/panel', emptyOutDir: true },
});
