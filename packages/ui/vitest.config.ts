import { configDefaults, defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  test: {
    environment: 'jsdom',
    coverage: {
      // 覆盖率 gate（coverage-design §5，P6 开闸）：vitest 2 实测 96.12% lines / 90.01% branches；
      // vitest 5 ast 重映射口径实测 95.46% lines / 88.10% branches（2026-10-09 vite8+vitest5 迁移，
      // 组件回调/未触发分支按 istanbul 语义计入，较 v8 range 粒度更严），各减 0.5pp 安全边际重校准
      thresholds: { lines: 94.9, branches: 87.6 },
      // 纯类型/构建脚本文件显式排除（P2b 覆盖率方案 §1.3 豁免清单，同 core 先例）：
      // v8 coverage.all 强制将其计入并恒为 0%，属统计噪音而非测试缺口。
      // - theme/generate.mjs：node 构建脚本（pnpm theme 生成 tokens-palettes.css），浏览器运行时不加载
      // - components/*Platform.ts：仅 interface/type 声明（宿主平台能力契约），零运行时可执行行；
      //   同目录 cloudPlatform.ts/releasePlatform.ts 含运行时函数，不在排除之列且已测
      // - src/host/**：宿主装配工厂层（R4，f81a1dc）——设计上由宿主包测试覆盖（extension
      //   cloudRunnerFactory/optionsApp/popupApp/revSeal、desktop cloudPlatforms/securityPlatform
      //   链路经 '@totp/ui/host' 子出口真实执行），ui 包测试按 R4 裁定不经子出口加载 host
      //   （避免宿主 '@totp/ui' mock 的 actual 绑定首载失效）；v8 跨包统计归属真空：
      //   ui 测试进程不加载 → 计 0%，宿主报告 exclude node_modules → 不计——属归属噪音而非测试缺口
      // 保留 configDefaults 排除项（test/、coverage/ 等产物目录不参与统计）：
      // vitest 5 起 configDefaults.coverage.exclude 清空（原 vitest 2 内建默认排除集不再提供），
      // 下列默认集逐项显式补回（2026-10-09 vite8+vitest5 迁移，对齐原统计口径）
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
        // 纯资源文件（CSS 令牌/JSON 调色板/WASM 二进制），非可执行代码：vitest 5 起 ast 重映射将
        // 被 import 的资源列入统计恒 0%（vitest 2 仅报告已加载 JS 模块不计），2026-10-09 登记
        '**/*.{css,json,wasm}',
        'src/theme/generate.mjs',
        'src/components/backupPlatform.ts',
        'src/components/devtoolsPlatform.ts',
        'src/components/importPlatform.ts',
        'src/components/securityPlatform.ts',
        'src/components/syncPlatform.ts',
        'src/host/**',
      ],
    },
  },
})
