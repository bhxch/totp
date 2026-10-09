import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    coverage: {
      // 覆盖率 gate（coverage-design §5，P6 开闸）：vitest 2 实测 99.91% lines / 98.63% branches；
      // vitest 5 ast 重映射口径实测 99.75% lines / 97.64% branches（2026-10-09 vite8+vitest5 迁移，
      // 引擎按 istanbul 语义计未触发分支，较 v8 range 粒度更严），各减 0.5pp 安全边际重校准
      thresholds: { lines: 99.2, branches: 97.1 },
      // 纯类型文件（仅 interface/type 声明、零运行时可执行行）显式排除：
      // v8 coverage.all 强制将其计入并恒为 0%，属统计噪音而非测试缺口（P1a 覆盖率方案 §3.1 裁定）。
      // vitest 5 起 configDefaults.coverage.exclude 清空（原 vitest 2 内建默认排除集不再提供），
      // 下列默认集逐项显式补回（2026-10-09 vite8+vitest5 迁移，对齐原统计口径）：
      exclude: [
        ...(configDefaults.coverage.exclude ?? []),
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
        'src/model.ts',
        'src/import/types.ts',
        'src/storage/adapter.ts',
        // 纯转发出口（export * 再导出链，零可执行语句）：vitest 5 ast-v8-to-istanbul 重映射
        // 判 0 可执行语句计入 0%，同 model.ts 纯类型豁免先例（2026-10-09 补登记）
        'src/import/sniff.ts',
      ],
    },
  },
})
