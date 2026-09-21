import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [vue()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    // cargo 构建期间会持续改写 target 下的 exe，Windows 上 watch 会 EBUSY 崩掉 dev server
    watch: { ignored: ['**/src-tauri/target/**'] },
  },
  build: {
    target: 'chrome105',
    outDir: 'dist',
    rollupOptions: { input: { main: 'index.html', mini: 'mini.html' } },
  },
})
