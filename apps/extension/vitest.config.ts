import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  // @totp/ui 入口全量导出 .vue 组件（store.ts 依赖 createVueStore），node 环境解析需要 vue 插件
  plugins: [vue()],
  test: { environment: 'node' },
})
