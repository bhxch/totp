import vue from '@vitejs/plugin-vue'
import { configDefaults, defineConfig } from 'vitest/config'

// vue 插件：storeWrap.test 探针经 @totp/ui 入口 import createVueStore（连带 .vue 组件模块），
// 仅编译不挂载，node 环境安全
export default defineConfig({
  plugins: [vue()],
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    // 覆盖默认排除列表（整体替换语义，须带回默认项）：
    // vitest 5 起 configDefaults.coverage.exclude 清空（原 vitest 2 内建默认排除集不再提供），
    // 下列默认集逐项显式补回（2026-10-09 vite8+vitest5 迁移，对齐原统计口径）：
    coverage: {
      // 覆盖率 gate（coverage-design §5，P6 开闸）：vitest 2 实测 99.28% lines / 94.87% branches；
      // vitest 5 ast 重映射口径实测 97.56% lines / 92.98% branches（2026-10-09 vite8+vitest5 迁移：
      // 装配回调 lambda 按函数级计未覆盖较 v8 range 粒度更严；securityPlatform T6/T7 新通道已补测），
      // 各减 0.5pp 安全边际重校准
      thresholds: { lines: 97, branches: 92.4 },
      exclude: [
        ...configDefaults.coverage.exclude,
        'coverage/**',
        'dist/**',
        '**/node_modules/**',
        '**/[.]**',
        'packages/*/test?(s)/**',
        '**/*.d.ts',
        '**/virtual:*',
        '**/__x00__*',
        'cypress/**',
        'test?(s)/**',
        'test?(-*).?(c|m)[jt]s?(x)',
        '**/*{.,-}{test,spec,bench,benchmark}?(-d).?(c|m)[jt]s?(x)',
        '**/__tests__/**',
        '**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build,eslint,prettier}.config.*',
        '**/vitest.{workspace,projects}.[jt]s?(on)',
        '**/.{eslint,mocha,prettier}rc.{?(c|m)js,yml}',
        'src-tauri/**',
        '**/*.test.ts',
        // 豁免清单（coverage-design §1.3）：createApp 三行入口装配，无运行时逻辑可测
        // （同 extension popup/options main.ts 先例；2026-09-26 终审补登记）
        'src/main.ts',
        'src/mini.ts',
        // 纯转发出口（一行 re-export，零可执行语句）：vitest 5 ast-v8-to-istanbul 重映射判
        // 0 可执行语句计入 0%，同 model.ts 纯类型豁免先例（2026-10-09 补登记）
        'src/miniSort.ts',
      ],
    },
  },
})
