import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

function saveDemoPlugin() {
  return {
    name: 'xtarwalk-save-demo',
    configureServer(server) {
      server.middlewares.use('/__demo_log', (req, res, next) => {
        if (req.method !== 'POST') return next();
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          console.log('[DEMO]', Buffer.concat(chunks).toString('utf8'));
          res.statusCode = 204;
          res.end();
        });
      });
      server.middlewares.use('/__save_demo', (req, res, next) => {
        if (req.method !== 'POST') return next();
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          const outDir = path.resolve(process.cwd(), 'demo');
          fs.mkdirSync(outDir, { recursive: true });
          const outPath = path.join(outDir, 'xtarwalk-vr-demo.webm');
          fs.writeFileSync(outPath, Buffer.concat(chunks));
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: true, path: outPath }));
        });
      });
    }
  };
}

export default defineConfig({
  // GitHub Pages serves the project under /<repo>/; the deploy workflow sets BASE_PATH
  base: process.env.BASE_PATH || '/',
  resolve: {
    // satellite.js's root entry re-exports its WASM/worker build, which breaks the bundle;
    // the pure-JS SGP4 modules are all we need (see src/sat/satellites.js).
    alias: { '@sat-core': fileURLToPath(new URL('./node_modules/satellite.js/dist', import.meta.url)) }
  },
  plugins: [saveDemoPlugin(), ...(process.env.VITE_HTTPS ? [basicSsl()] : [])],
  server: {
    host: true,
    port: 5173
  }
});
