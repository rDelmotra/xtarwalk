import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

export default defineConfig({
  plugins: process.env.VITE_HTTPS ? [basicSsl()] : [],
  server: {
    host: true,
    port: 5173
  }
});
