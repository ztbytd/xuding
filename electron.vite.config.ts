import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {},
  preload: {
    build: { rollupOptions: { output: { format: 'cjs', entryFileNames: 'index.js' } } }
  },
  renderer: {
    plugins: [
      react(),
      {
        name: 'production-csp',
        apply: 'build',
        transformIndexHtml: (html) =>
          html
            .replace("script-src 'self' 'unsafe-inline'", "script-src 'self'")
            .replace("connect-src 'self' ws://localhost:* ws://127.0.0.1:*", "connect-src 'self'")
      }
    ]
  }
})
