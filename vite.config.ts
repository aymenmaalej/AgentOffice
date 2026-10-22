import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const backend = `http://127.0.0.1:${process.env.AGENT_OFFICE_PORT ?? 4317}`;

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': backend,
      '/events': backend,
      '/usage': backend,
      '/ws': { target: backend.replace('http', 'ws'), ws: true },
      '/pty': { target: backend.replace('http', 'ws'), ws: true },
    },
  },
});
