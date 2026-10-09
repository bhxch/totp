import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  // @totp/ui 入口全量导出 .vue 组件（store.ts 依赖 createVueStore），node 环境解析需要 vue 插件
  plugins: [vue()],
  test: {
    environment: 'node',
    coverage: {
      // 覆盖率 gate（coverage-design §5，P6 开闸）：vitest 2 实测 97.07% lines / 92.44% branches；
      // vitest 5 ast 重映射口径实测 94.99% lines / 88.21% branches（2026-10-09 vite8+vitest5 迁移：
      // .vue template 编译分支首次计入 branches + 回调按函数级计，较 v8 range 粒度更严；
      // extension 完整链路迁移并入 Task 8，彼时随 wxt 0.21 再收紧），各减 0.5pp 安全边际重校准
      thresholds: { lines: 94.4, branches: 87.7 },
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
        'src/env.d.ts', // 豁免清单（coverage-design §1.3）：纯 declare module 类型声明，零运行时逻辑（同 core model.ts、ui *Platform.ts 先例；2026-09-27 终验补登记）
      ],
    },
  },
})
