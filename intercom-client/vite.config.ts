import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Served at /intercom-client/ from the same nginx as the console (see
// controller/frontend/nginx.conf) -base must match that path so built
// asset URLs resolve correctly.
export default defineConfig({
  base: '/intercom-client/',
  // Favicon and home-screen icons live with the shared logo (brand/).
  publicDir: '../brand/public',
  plugins: [react()],
  server: {
    proxy: {
      '/api/v1': { target: 'http://localhost:3100', changeOrigin: true },
    },
  },
});
