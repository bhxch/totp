#!/usr/bin/env node
// Rust 覆盖率测法固化（coverage-design §2 Phase 0 / §5 CI 防回退）。
// 用法:
//   node scripts/rust-coverage.mjs                  # 文本 summary（人类可读）
//   node scripts/rust-coverage.mjs --fail-under-lines 71 --fail-under-branches 54
//     # gate 模式：解析 llvm-cov export JSON 的 totals 做门禁，低于任一 gate 打印偏差并 exit 1。
//     # 分支 gate 经 JSON 解析实现：--fail-under-branches 不是 cargo-llvm-cov 的选项
//     # （0.9.1 实测 invalid option；上游仅 --fail-under-lines 0.2.2 / functions·regions
//     # 0.5.37 / file-lines 0.8.6），CI 首跑实证（run 36224456089）。
//
// 踩实过的坑（勿动参数）：
// - --no-rustc-wrapper：cargo-llvm-cov 0.9.1 默认经 RUSTC_WRAPPER 注入插桩，
//   在 cargo 1.98 下失效（报 no coverage data found），必须绕过；
// - +nightly：--branch 分支覆盖依赖 nightly 的 -Z llvm-cov flags（CI Rust job 同用 nightly）；
// - 不加 --text：--text 是 llvm-cov show 的逐行源码标注视图，无汇总表；
//   文本模式默认 report 格式输出 Filename/TOTAL 行/分支汇总表（--summary-only 去掉函数级明细）。
//   实测 TOTAL：行 71.56%、分支 54.69%（Branches 426 总量），与 CI gate 基线一致。
//   注意 JSON totals 分母略大（含测试二进制自身插桩行，3804 vs 文本 3136）：
//   gate 模式实测 lines 71.69%/branches ~55-56%，两次运行分支数有 ±3 的并发波动，gate 边际已留足。
import { spawnSync } from 'node:child_process'
import { readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifestDir = resolve(root, 'apps/desktop/src-tauri')

// gate 参数只认 --fail-under-lines / --fail-under-branches（数字），其余原样透传 cargo-llvm-cov
const gates = {}
const passthrough = []
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i]
  if (arg === '--fail-under-lines' || arg === '--fail-under-branches') {
    const value = Number(process.argv[++i])
    if (!Number.isFinite(value)) {
      console.error(`${arg} 需要数字参数`)
      process.exit(2)
    }
    gates[arg.slice('--fail-under-'.length)] = value
  } else {
    passthrough.push(arg)
  }
}

const gating = gates.lines !== undefined || gates.branches !== undefined
const args = ['+nightly', 'llvm-cov', '--no-rustc-wrapper', '--branch', ...passthrough]

// gate 模式改走 JSON export（llvm-cov export -format=json 的 data[0].totals）：
// --summary-only 仅保留文件级汇总（体积可控），报告落临时文件，解析后即清理
let jsonPath
if (gating) {
  jsonPath = join(tmpdir(), `rust-coverage-gate-${process.pid}-${Date.now()}.json`)
  args.push('--json', '--summary-only', '--output-path', jsonPath)
} else {
  args.push('--summary-only')
}

const result = spawnSync('cargo', args, { cwd: manifestDir, stdio: 'inherit' })
if (result.error) {
  console.error(`cargo 执行失败：${result.error.message}`)
  process.exit(1)
}
if (result.status !== 0) {
  process.exit(result.status ?? 1)
}
if (!gating) {
  process.exit(0)
}

let totals
try {
  totals = JSON.parse(readFileSync(jsonPath, 'utf8')).data?.[0]?.totals
} catch (e) {
  rmSync(jsonPath, { force: true })
  console.error(`覆盖率 JSON 读取/解析失败：${e.message}`)
  process.exit(1)
}
rmSync(jsonPath, { force: true })
if (!totals?.lines || !totals?.branches) {
  console.error('覆盖率 JSON 缺少 totals.lines/branches 汇总（llvm-cov export 格式变更？）')
  process.exit(1)
}

// 人类可读汇总（对齐文本模式 TOTAL 行口径）后做 gate 判定
const pct = (s) => s.percent.toFixed(2)
const cnt = (s) => `${s.covered}/${s.count}`
console.log(`覆盖率汇总：lines ${pct(totals.lines)}% (${cnt(totals.lines)})、branches ${pct(totals.branches)}% (${cnt(totals.branches)})`)

let failed = false
if (gates.lines !== undefined && totals.lines.percent < gates.lines) {
  console.error(`ERROR: Coverage for lines (${pct(totals.lines)}%) does not meet gate (${gates.lines}%)`)
  failed = true
}
if (gates.branches !== undefined && totals.branches.percent < gates.branches) {
  console.error(`ERROR: Coverage for branches (${pct(totals.branches)}%) does not meet gate (${gates.branches}%)`)
  failed = true
}
if (failed) process.exit(1)
