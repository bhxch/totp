import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    coverage: {
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
