#!/usr/bin/env node
// release 发布说明截取：从 CHANGELOG.md 取指定版本小节输出到 stdout（release.yml publish
// 步以 body_path 交给 softprops/action-gh-release，其后自动附 generate_release_notes 提交列表）
// 用法: node scripts/extract-changelog.mjs <x.y.z>（容忍 v 前缀，如 v1.2.3）
// 退出码：2 = CHANGELOG.md 缺失（仓库配置错误，发布应当中断）；
//        0 = 正常（小节缺失时输出为空并打 ::warning:: 注解，Release 回退为自动生成的说明）
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// 测试注入口（scripts/extract-changelog.test.mjs 专用）：CHANGELOG_ROOT 指定 fixture 根目录
const root = process.env.CHANGELOG_ROOT
  ? resolve(process.env.CHANGELOG_ROOT)
  : resolve(dirname(fileURLToPath(import.meta.url)), '..')
const version = (process.argv[2] ?? '').replace(/^v/, '')
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('用法: node scripts/extract-changelog.mjs <x.y.z>（仅接受纯数字 x.y.z，与 bump 口径一致）')
  process.exit(2)
}

let text
try {
  text = readFileSync(resolve(root, 'CHANGELOG.md'), 'utf8')
} catch {
  console.error('CHANGELOG.md 不存在（应位于仓库根目录）')
  process.exit(2)
}

// 小节头形态：## [x.y.z] / ## [x.y.z] - 日期（Keep a Changelog），容忍无方括号写法；
// 版本精确匹配，防止 1.0.1 命中 1.0.11 之类前缀串扰
const headRe = new RegExp(`^##\\s+\\[?${version.replace(/\./g, '\\.')}\\]?(?:\\s.*)?$`)
const lines = text.split(/\r?\n/)
const start = lines.findIndex((l) => headRe.test(l))
if (start === -1) {
  console.error(`::warning::CHANGELOG.md 中未找到 ${version} 小节，Release 说明将回退为自动生成的提交列表`)
  process.exit(0)
}
let end = lines.length
for (let i = start + 1; i < lines.length; i++) {
  if (/^##\s/.test(lines[i])) { end = i; break }
}
// 去小节尾空行，避免 body 顶部堆叠空行
let body = lines.slice(start + 1, end).join('\n').replace(/\n+$/, '')
// 跳过小节内紧随标题的引导空行，body 顶部与 Release 说明模板衔接
body = body.replace(/^\n+/, '')
process.stdout.write(body + '\n')
