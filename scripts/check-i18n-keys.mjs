#!/usr/bin/env node
// C9: i18n 键引用校验——扫 packages/ui/src 中以引号字面量出现的点分键串,
// 与 locales/{zh,en}/common.json 键集双向比对(缺键/无引用)。
// 引用判定用「字符串字面量出现」而非仅 t('...'):覆盖 cloudSyncShared 动作文案表
// 等常量键引用;非 i18n 的巧合字符串(如事件名)经 ALLOW 白名单豁免。
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
// 扫描面 = i18n 键真实消费方:ui 组件库 + extension(popup/options/背景系) + desktop 前端。
// 仅扫 ui/src 会把 app 侧消费的键(如 popup.*/desktop.*)全误报成无引用(首轮实证 150+),故扩面。
const ROOTS = [
  join(root, 'packages', 'ui', 'src'),
  join(root, 'apps', 'extension', 'entrypoints'),
  join(root, 'apps', 'extension', 'src'),
  join(root, 'apps', 'desktop', 'src'),
]

// 已知豁免(非 t() 消费的字符串巧合/计划中的键);增删需在 commit 正文说明
const ALLOW = new Set([
  // app.title:生产零消费,仅 packages/ui/test/i18n.test.ts:17 作「资源就绪」哨兵断言(删键会破坏该测试)
  'app.title',
  // 以下 27 键均为模板串动态键(脚本正则只抓静态字面量,属已知盲区而非死键):
  // nav.*: NavigationShell.vue:67 t(`nav.${r.name}`)(路由名由 routes.ts R16③ 单点派生)
  'nav.codes', 'nav.import', 'nav.sync', 'nav.security', 'nav.settings',
  // backupCard/cloudCard.interval*/retention*: cardShared.ts:72-83 t(`${domain}.interval15m`) 等(双卡共用常量文案表)
  'backupCard.interval15m', 'backupCard.interval1h', 'backupCard.interval6h', 'backupCard.intervalDaily',
  'backupCard.retentionOverwrite', 'backupCard.retentionKeep',
  'cloudCard.interval15m', 'cloudCard.interval1h', 'cloudCard.interval6h', 'cloudCard.intervalDaily',
  'cloudCard.retentionOverwrite', 'cloudCard.retentionKeep',
  // settingsPage.palette.*: SettingsPage.vue:54 t(`settingsPage.palette.${id}`)(id 来自 palettes.json 数据文件)
  'settingsPage.palette.blue', 'settingsPage.palette.indigo', 'settingsPage.palette.teal',
  'settingsPage.palette.green', 'settingsPage.palette.amber', 'settingsPage.palette.orange',
  'settingsPage.palette.red', 'settingsPage.palette.violet', 'settingsPage.palette.pink',
  'settingsPage.palette.slate',
])

const flat = (o, p = '') =>
  Object.entries(o).flatMap(([k, v]) => (typeof v === 'string' ? [p + k] : flat(v, `${p}${k}.`)))

const zh = JSON.parse(readFileSync(join(root, 'packages', 'ui', 'src', 'i18n/locales/zh/common.json'), 'utf8'))
const en = JSON.parse(readFileSync(join(root, 'packages', 'ui', 'src', 'i18n/locales/en/common.json'), 'utf8'))
const zhKeys = new Set(flat(zh))
const enKeys = new Set(flat(en))

// 键首段必须命中 locales 顶层命名空间(NS):排除代码属性路径/事件名等巧合点分串
const NS = new Set(Object.keys(zh))

const refs = new Set()
const walk = (d) => {
  for (const f of readdirSync(d)) {
    const p = join(d, f)
    if (statSync(p).isDirectory()) walk(p)
    else if (/\.(vue|ts)$/.test(f)) {
      const src = readFileSync(p, 'utf8')
      // 点分键形如 '域.子键' 或 '域.子.孙';首段必须字母开头且 ∈ NS,排除相对/包导入路径
      for (const m of src.matchAll(/['"]([a-zA-Z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9]+)+)['"]/g)) {
        if (NS.has(m[1].split('.')[0])) refs.add(m[1])
      }
    }
  }
}
for (const r of ROOTS) walk(r)

const problems = []
for (const r of refs) {
  if (ALLOW.has(r)) continue
  if (!zhKeys.has(r)) problems.push(`缺失(zh): ${r}`)
  if (!enKeys.has(r)) problems.push(`缺失(en): ${r}`)
}
for (const k of zhKeys) if (!refs.has(k) && !ALLOW.has(k)) problems.push(`无引用(zh): ${k}`)
for (const k of enKeys) if (!refs.has(k) && !ALLOW.has(k)) problems.push(`无引用(en): ${k}`)

if (problems.length > 0) {
  console.error(`i18n 键校验失败(${problems.length} 项):`)
  for (const p of problems) console.error(`  - ${p}`)
  process.exit(1)
}
console.log(`i18n 键校验通过: zh=${zhKeys.size} en=${enKeys.size} 引用=${refs.size}`)
