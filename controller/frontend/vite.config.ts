import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // Favicon and home-screen icons live with the shared logo (brand/).
  publicDir: '../../brand/public',
  plugins: [react()],
  server: {
    proxy: {
      '/api/v1': { target: 'http://localhost:3100', changeOrigin: true },
    },
  },
});
