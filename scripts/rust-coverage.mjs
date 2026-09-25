#!/usr/bin/env node
// Rust 覆盖率测法固化（coverage-design §2 Phase 0 / §5 CI 防回退）。
// 用法: node scripts/rust-coverage.mjs [附加 cargo-llvm-cov 参数...]
//   例: node scripts/rust-coverage.mjs --fail-under-lines 90
//
// 踩实过的坑（勿动参数）：
// - --no-rustc-wrapper：cargo-llvm-cov 0.9.1 默认经 RUSTC_WRAPPER 注入插桩，
//   在 cargo 1.98 下失效（报 no coverage data found），必须绕过；
// - +nightly：--branch 分支覆盖依赖 nightly 的 -Z llvm-cov flags（CI Rust job 同用 nightly）；
// - 不加 --text：--text 是 llvm-cov show 的逐行源码标注视图，无汇总表；
//   默认 report 格式输出 Filename/TOTAL 行/分支汇总表（--summary-only 去掉函数级明细）。
//   实测 TOTAL：行 61.07%（1915/3136），与设计文档基线一致。
// 退出码透传（配 --fail-under-* 即可做 CI gate）。
import { spawnSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifestDir = resolve(root, 'apps/desktop/src-tauri')

const result = spawnSync(
  'cargo',
  ['+nightly', 'llvm-cov', '--no-rustc-wrapper', '--branch', '--summary-only', ...process.argv.slice(2)],
  { cwd: manifestDir, stdio: 'inherit' },
)

if (result.error) {
  console.error(`cargo 执行失败：${result.error.message}`)
  process.exit(1)
}
process.exit(result.status ?? 1)
