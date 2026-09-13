import vue from 'vite-plugin-vue'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [vue()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: {
    target: 'chrome105',
    outDir: 'dist',
    rollupOptions: { input: { main: 'index.html', mini: 'mini.html' } },
  },
})
