import { defineConfig } from 'vite';
import fs from 'fs';
import path from 'path';

export default defineConfig({
  server: {
    host: 'fanadmin.top',
    port: 5174,
    strictPort: true,

    https: {
      key: fs.readFileSync(
        path.resolve(__dirname, '../../certs/fanadmin.top-key.pem')
      ),
      cert: fs.readFileSync(
        path.resolve(__dirname, '../../certs/fanadmin.top.pem')
      ),
    },

    allowedHosts: [
      'fanadmin.top',
    ],
    // Keep local Studio requests same-origin. This avoids browser CORS and
    // Cognito-session interference while the local API uses its seeded user.
    proxy: {
      '/local-api': {
        target: 'https://127.0.0.1:4000',
        changeOrigin: true,
        secure: false,
        rewrite: (path) => path.replace(/^\/local-api/, ''),
        headers: {
          'x-user-id': 'local-user',
          'x-user-role': 'creator'
        }
      }
    }
  },
});
