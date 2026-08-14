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
  },
});