import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  base: '/',
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: { proxy: { '/api': 'http://localhost:8080' } },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    sourcemap: false,
    rollupOptions: {
      output: {
        // Long-lived vendor chunks cache across deploys; the app chunk stays small.
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined
          if (/recharts|d3-|victory-vendor/.test(id)) return undefined
          if (/@radix-ui|radix-ui|@floating-ui|aria-hidden|react-remove-scroll/.test(id)) return 'radix'
          if (/react-dom|react-router|node_modules\/react\/|scheduler/.test(id)) return 'react'
          if (/@tanstack/.test(id)) return 'tanstack'
          return undefined
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: false,
  },
})
