import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: false,
      includeAssets: ['favicon.svg', 'icons/apple-touch-icon.png', 'oauth-error.css'],
      manifest: {
        name: 'OpenRampart',
        short_name: 'OpenRampart',
        description: 'Your own durable, searchable record of interactions with organisations and people.',
        lang: 'en-GB',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        background_color: '#edf5fd',
        theme_color: '#546a80',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
        shortcuts: [
          { name: 'Capture a letter', short_name: 'Capture', url: '/events/new/letter', icons: [{ src: '/icons/icon-192.png', sizes: '192x192' }] },
          { name: 'Add Event', short_name: 'Add', url: '/events/new', icons: [{ src: '/icons/icon-192.png', sizes: '192x192' }] },
        ],
      },
      workbox: {
        // Only the application shell is cached. Record data, documents and
        // previews are always fetched from the server and never stored offline.
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//, /^\/oauth\//, /^\/mcp/, /^\/\.well-known\//, /^\/healthz/, /^\/readyz/],
        runtimeCaching: [],
        cleanupOutdatedCaches: true,
      },
    }),
  ],
  build: {
    outDir: 'dist/web',
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    port: 5173,
  },
});
