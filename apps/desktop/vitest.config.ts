import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vitest/config'

// vue 插件：storeWrap.test 探针经 @totp/ui 入口 import createVueStore（连带 .vue 组件模块），
// 仅编译不挂载，node 环境安全
export default defineConfig({
  plugins: [vue()],
  test: { environment: 'node', include: ['src/**/*.test.ts', 'test/**/*.test.ts'] },
})
