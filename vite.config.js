import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    // satellite.js's root entry re-exports its WASM/worker build, which breaks the bundle;
    // the pure-JS SGP4 modules are all we need (see src/sat/satellites.js).
    alias: { '@sat-core': fileURLToPath(new URL('./node_modules/satellite.js/dist', import.meta.url)) }
  },
  plugins: process.env.VITE_HTTPS ? [basicSsl()] : [],
  server: {
    host: true,
    port: 5173
  }
});
