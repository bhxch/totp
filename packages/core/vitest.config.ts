import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    coverage: {
      // 覆盖率 gate（coverage-design §5，P6 开闸）：当前实测 99.91% lines / 98.63% branches
      // 减 0.5pp 安全边际，随改进逐步收紧（最终目标 100/95）。
      thresholds: { lines: 99.4, branches: 98.1 },
      // 纯类型文件（仅 interface/type 声明、零运行时可执行行）显式排除：
      // v8 coverage.all 强制将其计入并恒为 0%，属统计噪音而非测试缺口（P1a 覆盖率方案 §3.1 裁定）。
      // 保留 configDefaults 排除项（test/、coverage/ 等产物目录不参与统计）
      exclude: [
        ...(configDefaults.coverage.exclude ?? []),
        'src/model.ts',
        'src/import/types.ts',
        'src/storage/adapter.ts',
      ],
    },
  },
})
