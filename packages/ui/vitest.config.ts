import { configDefaults, defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  test: {
    environment: 'jsdom',
    coverage: {
      // 覆盖率 gate（coverage-design §5，P6 开闸）：当前实测 96.12% lines / 90.02% branches
      // 减 0.5pp 安全边际，随改进逐步收紧（95/85 分层目标已达成，余量随改进回收）。
      thresholds: { lines: 95.6, branches: 89.5 },
      // 纯类型/构建脚本文件显式排除（P2b 覆盖率方案 §1.3 豁免清单，同 core 先例）：
      // v8 coverage.all 强制将其计入并恒为 0%，属统计噪音而非测试缺口。
      // - theme/generate.mjs：node 构建脚本（pnpm theme 生成 tokens-palettes.css），浏览器运行时不加载
      // - components/*Platform.ts：仅 interface/type 声明（宿主平台能力契约），零运行时可执行行；
      //   同目录 cloudPlatform.ts/releasePlatform.ts 含运行时函数，不在排除之列且已测
      // 保留 configDefaults 排除项（test/、coverage/ 等产物目录不参与统计）
      exclude: [
        ...(configDefaults.coverage.exclude ?? []),
        'src/theme/generate.mjs',
        'src/components/backupPlatform.ts',
        'src/components/devtoolsPlatform.ts',
        'src/components/importPlatform.ts',
        'src/components/securityPlatform.ts',
        'src/components/syncPlatform.ts',
      ],
    },
  },
})
