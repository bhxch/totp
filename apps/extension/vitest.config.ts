import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  // @totp/ui 入口全量导出 .vue 组件（store.ts 依赖 createVueStore），node 环境解析需要 vue 插件
  plugins: [vue()],
  test: {
    environment: 'node',
    coverage: {
      // 豁免清单（coverage-design §1.3）：createApp 三行入口装配，无运行时逻辑可测
      // 覆盖默认排除集后需补回测试目录（自定义数组整体替换默认值）
      exclude: [
        'node_modules/**',
        'dist/**',
        '.wxt/**',
        '.output/**', // 本机 wxt build 产物（CI 无）
        'test/**',
        'vitest.config.ts',
        'entrypoints/popup/main.ts', // 豁免清单（coverage-design §1.3）：createApp 三行入口
        'entrypoints/options/main.ts',
      ],
    },
  },
})
