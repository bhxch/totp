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
    // - src-tauri/**：Rust 工程其 target/ 构建产物 JS 被误计入，曾把 All files 污染到 10%
    // - *.test.ts：文档基线口径只统计生产代码，测试文件自身 100% 会虚高 All files
    coverage: {
      // 覆盖率 gate（coverage-design §5，P6 开闸）：当前实测 99.28% lines / 94.87% branches
      // 减 0.5pp 安全边际，随改进逐步收紧（95/85 分层目标已达成，余量随改进回收）。
      thresholds: { lines: 98, branches: 94 },
      exclude: [
        ...configDefaults.coverage.exclude,
        'src-tauri/**',
        '**/*.test.ts',
        // 豁免清单（coverage-design §1.3）：createApp 三行入口装配，无运行时逻辑可测
        // （同 extension popup/options main.ts 先例；2026-09-26 终审补登记）
        'src/main.ts',
        'src/mini.ts',
      ],
    },
  },
})
