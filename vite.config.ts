import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': process.env.ORBIT_DEV_API_URL || 'http://localhost:3000', '/auth': process.env.ORBIT_DEV_API_URL || 'http://localhost:3000' }
  },
  build: { outDir: 'dist', rollupOptions: { input: { main: 'index.html', playground: 'playground.html' } } }
});
