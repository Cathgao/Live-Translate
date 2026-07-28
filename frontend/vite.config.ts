import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig, loadEnv} from 'vite';

export default defineConfig(({mode}) => {
  // Load .env files so we can read ALLOWHOST for server.allowedHosts.
  const env = loadEnv(mode, process.cwd(), '');

  // ALLOWHOST can be a single hostname or a comma-separated list.
  const allowedHosts = (env.ALLOWHOST || '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);

  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
      // Allow access from the hostnames listed in ALLOWHOST (comma-separated),
      // so reverse-proxied domain access isn't blocked by Vite's host check.
      host: env.HOST || true,
      allowedHosts,
    },
  };
});
