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
        },
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq, request) => {
            const url = request.url || '';
            // Public routes must remain anonymous even in local development.
            // `preview=1` is deliberately added only by Studio's “View public” link.
            // Depending on Vite's proxy stage, `request.url` can be either
            // the original `/local-api/...` path or the rewritten API path.
            // Keep the seeded identity for private application routes in both
            // forms; otherwise an authenticated local session is incorrectly
            // treated as anonymous and the UI tries to sign it out of Cognito.
            const useLocalIdentity = (
              url.startsWith('/local-api/studio/') ||
              url.startsWith('/local-api/me/') ||
              url.startsWith('/studio/') ||
              url.startsWith('/me/') ||
              /[?&]preview=1(?:&|$)/.test(url)
            );
            if (!useLocalIdentity) {
              proxyReq.removeHeader('x-user-id');
              proxyReq.removeHeader('x-user-role');
            }
          });
        }
      }
    }
  },
});
