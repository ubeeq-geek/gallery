import { defineConfig } from 'vite';
import fs from 'fs';
import path from 'path';

const configuredApiUrl = process.env.VITE_API_BASE_URL || 'https://fanadmin.top:4000';
const configuredApiPort = (() => {
  try {
    return new URL(configuredApiUrl).port || '4000';
  } catch {
    return '4000';
  }
})();

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
        target: `https://127.0.0.1:${configuredApiPort}`,
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
