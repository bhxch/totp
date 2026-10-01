import { defineConfig } from 'vitest/config'

// 仅覆盖 scripts/ 构建脚本的自动化测试（杂-I5：bump.mjs 版本落点门禁此前零测试，全靠人工
// 验证、CI 无保护）。workspace 各包测试由各自 vitest.config.ts 负责（pnpm -r test 递归执行），
// 根 test 脚本先跑本配置再递归各包，均受 CI web job 的 `pnpm test` 覆盖。
export default defineConfig({
  test: {
    environment: 'node',
    include: ['scripts/**/*.test.mjs'],
  },
})
