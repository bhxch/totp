#!/usr/bin/env node
// 版本单一来源：根 package.json → 同步 4 处落点（验收条目6 spec §1）
// 用法: node scripts/bump.mjs <x.y.z> | --check <x.y.z>
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const check = args.includes('--check')
const version = args.find((a) => a !== '--check')
if (!version || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
  console.error('用法: pnpm bump <x.y.z> [--check]')
  process.exit(2)
}

// 落点 4 处（根 package.json 为 workspace 根、无 version 字段，不作落点）
const jsonFiles = ['apps/desktop/package.json', 'apps/extension/package.json', 'apps/desktop/src-tauri/tauri.conf.json']
const cargoFile = 'apps/desktop/src-tauri/Cargo.toml'
let dirty = false

for (const rel of jsonFiles) {
  const p = resolve(root, rel)
  const text = readFileSync(p, 'utf8')
  const json = JSON.parse(text)
  if (json.version === version) continue
  if (check) { console.error(`${rel} 版本为 ${json.version}，期望 ${version}`); dirty = true; continue }
  // 文本级替换首个 "version" 行（均为顶层字段）：tauri.conf.json 为紧凑内联风格，
  // 整文件 JSON.stringify 重写会产生大量无关格式 diff
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

process.exit(dirty ? 1 : 0)
