#!/usr/bin/env node
// 版本单一来源：apps/desktop/package.json → 同步 5 处落点（验收条目6 spec §1）
// 用法: node scripts/bump.mjs <x.y.z> [--check] | node scripts/bump.mjs --check
//       （--check 不带版本参数时，以 apps/desktop/package.json 当前版本为基准）
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const check = args.includes('--check')
let version = args.find((a) => a !== '--check')
if (!version && check) {
  version = JSON.parse(readFileSync(resolve(root, 'apps/desktop/package.json'), 'utf8')).version
}
if (!version || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
  console.error('用法: pnpm bump <x.y.z> [--check] | pnpm bump --check')
  process.exit(2)
}

// 落点 5 处：3 个 JSON + Cargo.toml + Cargo.lock
//（根 package.json 为 workspace 根、无 version 字段，不作落点）
const jsonFiles = ['apps/desktop/package.json', 'apps/extension/package.json', 'apps/desktop/src-tauri/tauri.conf.json']
const cargoFile = 'apps/desktop/src-tauri/Cargo.toml'
const lockFile = 'apps/desktop/src-tauri/Cargo.lock'
let dirty = false

for (const rel of jsonFiles) {
  const p = resolve(root, rel)
  const text = readFileSync(p, 'utf8')
  const json = JSON.parse(text)
  if (json.version === version) continue
  if (check) { console.error(`${rel} 版本为 ${json.version}，期望 ${version}`); dirty = true; continue }
  // 文本级替换首个 "version" 行（均为顶层字段）：按各文件原有格式就地改写，
  // 避免 JSON.parse/stringify 整文件重排产生无关格式 diff
  const jsonRe = /^(\s*"version"\s*:\s*)"[^"]*"/m
  if (!jsonRe.test(text)) { console.error(`${rel} 未找到 version 行`); dirty = true; continue }
  writeFileSync(p, text.replace(jsonRe, `$1"${version}"`))
  console.log(`${rel} → ${version}`)
}

// Cargo.toml 首个行首 `version =` 即 [package] 段版本行（依赖均为内嵌 `version =`，不匹配 ^）
const cargoRe = /^(version\s*=\s*)"([^"]*)"/m
const cargo = readFileSync(resolve(root, cargoFile), 'utf8')
const cargoMatch = cargo.match(cargoRe)
if (cargoMatch) {
  const cargoCur = cargoMatch[2]
  if (cargoCur === version) {
    // 已一致
  } else if (check) {
    console.error(`${cargoFile} 版本为 ${cargoCur}，期望 ${version}`)
    dirty = true
  } else {
    writeFileSync(resolve(root, cargoFile), cargo.replace(cargoRe, `$1"${version}"`))
    console.log(`${cargoFile} → ${version}`)
  }
}

// Cargo.lock 中 workspace 包 totp-desktop 的版本行（[[package]]\nname = "totp-desktop"\nversion）：
// name 精确匹配保证只动本包，不触碰任何依赖条目
const lockRe = /^(name = "totp-desktop"\r?\nversion\s*=\s*)"([^"]*)"/m
const lock = readFileSync(resolve(root, lockFile), 'utf8')
const lockMatch = lock.match(lockRe)
if (lockMatch) {
  const lockCur = lockMatch[2]
  if (lockCur === version) {
    // 已一致
  } else if (check) {
    console.error(`${lockFile} totp-desktop 版本为 ${lockCur}，期望 ${version}`)
    dirty = true
  } else {
    writeFileSync(resolve(root, lockFile), lock.replace(lockRe, `$1"${version}"`))
    console.log(`${lockFile} (totp-desktop) → ${version}`)
  }
} else {
  console.error(`${lockFile} 未找到 totp-desktop 包条目`)
  dirty = true
}

process.exit(dirty ? 1 : 0)
