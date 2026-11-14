#!/usr/bin/env node
// UI 字段几何 e2e（真机）：用 tauri-mcp 驱动真桌面应用，量测全部 MdSelect / MdTextField 的
// 浮动标签与值行几何，断言「标签不换行、不压值行、不被裁切」（2026-11-14 缺陷回归守卫）。
//
// 背景：jsdom 无布局，packages/ui 的单测只能钉结构与 CSS 声明，证明不了真实像素几何；
// 本脚本在真 WebView2 里跑真实组件 + 真实 i18n + 真实 CSS，给几何不变量做回归守卫。
//
// 用法：
//   node scripts/ui-layout-e2e.mjs [--port 9223] [--shot-dir <目录>] [--route <hash> ...]
//
// 前置：
//   1) 桌面应用以 debug 构建运行（mcp-bridge 仅 #[cfg(debug_assertions)] 装配）：
//        cd apps/desktop && pnpm tauri dev      （或先 pnpm tauri build --debug 再直跑 exe）
//      注意：直跑 debug exe 时须同起 vite dev server（devUrl http://localhost:1420），
//      否则页面白屏；已装 release 版驻留时 dev 实例会被单实例让位直接退出——先 taskkill。
//   2) tauri-mcp CLI 在 PATH；应用已解锁（锁定页下走查不到设置页）。
//   3) 屏幕不锁屏：LogonUI 下 WebView2 挂起渲染，量测全超时。
//
// 判定口径：
//   FAIL（几何不变量，必须过）：标签换行（>1 行）、浮动态标签压住值行（overlap>0）、标签被省略号裁切。
//   WARN（报告不判负）：值被省略号裁切——固定宽度容器里属设计取舍，完整文案在菜单可见。
//
// 退出码沿用 scripts/mcp-e2e.mjs 约定：process.exitCode = fail ? 1 : 0
// （不用 process.exit：Windows 上 exit 会触发 libuv 断言导致退出码失真）

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const args = process.argv.slice(2)
function opt(name, dflt) {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt
}
const PORT = opt('--port', '9223')
const SHOT_DIR = resolve(opt('--shot-dir', '.temp/e2e/ui-layout'))
const ROUTES = args.includes('--route')
  ? args.filter((a, i) => args[i - 1] === '--route')
  : ['#/codes', '#/import', '#/sync', '#/security', '#/settings']

let fail = 0
let warn = 0
let skip = 0
function check(name, cond, detail = '') {
  if (cond) {
    console.log(`PASS ${name}${detail ? ' — ' + detail : ''}`)
  } else {
    fail++
    console.log(`FAIL ${name}${detail ? ' — ' + detail : ''}`)
  }
}
/** 值被省略号裁切：报告不判负（固定宽度容器的取舍，完整文案在菜单可见） */
function note(name, detail) {
  warn++
  console.log(`WARN ${name}${detail ? ' — ' + detail : ''}`)
}
/** 跳过：前置交互未满足，非缺陷 */
function skipNote(name, detail) {
  skip++
  console.log(`SKIP ${name}${detail ? ' — ' + detail : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 定位 tauri-mcp CLI：优先直接跑其 JS 入口（免 shell、免 shell 注入面），
 *  找不到入口再退回调用 PATH 上的 shim */
export function resolveCli() {
  const sep = process.platform === 'win32' ? ';' : ':'
  const names = process.platform === 'win32' ? ['tauri-mcp.cmd', 'tauri-mcp'] : ['tauri-mcp']
  for (const dir of (process.env.PATH || '').split(sep)) {
    if (!dir) continue
    for (const n of names) {
      const shim = join(dir, n)
      if (!existsSync(shim)) continue
      const entry = join(dir, 'node_modules', '@hushlor', 'tauri-mcp-cli', 'dist', 'index.js')
      if (existsSync(entry)) return { cmd: process.execPath, prefix: [entry], shell: false }
      return { cmd: shim, prefix: [], shell: true }
    }
  }
  return null
}

/** 调 tauri-mcp CLI（daemon keep-alive，逐次调用共享会话） */
function tauriMcp(argv) {
  const cli = resolveCli()
  if (!cli) throw new Error('未找到 tauri-mcp CLI（须在 PATH 上）')
  const r = spawnSync(cli.cmd, [...cli.prefix, ...argv], { encoding: 'utf8', shell: cli.shell })
  const out = (r.stdout || '') + (r.stderr || '')
  if (r.status !== 0) throw new Error(`tauri-mcp ${argv.join(' ')} 退出码 ${r.status}\n${out.trim()}`)
  return out
}

/** 从 CLI 输出里抠出 JSON（输出含告警前缀与收尾说明）；--json 模式外层是信封，
 *  信封的 text 字段里才是真正的载荷——逐层剥到最内层 */
export function parseJson(text) {
  const start = text.search(/[[{]/)
  if (start < 0) throw new Error('未找到 JSON 输出：' + text.trim().slice(0, 300))
  const open = text[start]
  const close = open === '{' ? '}' : ']'
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') inStr = true
    else if (c === open) depth++
    else if (c === close) {
      depth--
      if (depth === 0) {
        const parsed = JSON.parse(text.slice(start, i + 1))
        if (parsed && typeof parsed.text === 'string') {
          try {
            return parseJson(parsed.text)
          } catch {
            /* text 不是 JSON：按原样返回 */
          }
        }
        return parsed
      }
    }
  }
  throw new Error('JSON 不完整：' + text.trim().slice(0, 300))
}

/** 在真 webview 里执行 JS，返回结构化结果 */
function execJs(script) {
  const out = tauriMcp(['webview-execute-js', '--json', '--window-id', 'main', '--script', script])
  return parseJson(out)
}

/** 量测脚本：遍历页面上全部 MdSelect / MdTextField，返回几何摘要 */
const MEASURE = `(() => {
  const out = [];
  document.querySelectorAll('.md-select, .md-text-field').forEach((field) => {
    const isSel = !!field.querySelector('.md-select__box');
    const label = field.querySelector('.md-select__label, .md-text-field__label');
    const value = isSel ? field.querySelector('.md-select__value') : field.querySelector('.md-text-field__input');
    if (!label || !value) return;
    const lr = label.getBoundingClientRect();
    const vr = value.getBoundingClientRect();
    const cs = getComputedStyle(label);
    const lh = parseFloat(cs.lineHeight) || lr.height;
    const floated = !!field.querySelector('.md-select__box--floated, .md-text-field__box--floated');
    out.push({
      kind: isSel ? 'select' : 'text',
      label: (label.textContent || '').trim(),
      value: (value instanceof HTMLInputElement ? value.value : (value.textContent || '').trim()),
      floated: floated,
      labelLines: Math.round((lr.height / lh) * 100) / 100,
      overlap: Math.round((lr.bottom - vr.top) * 10) / 10,
      labelTruncated: label.scrollWidth > label.clientWidth + 1,
      valueTruncated: value.scrollWidth > value.clientWidth + 1,
      width: Math.round(field.getBoundingClientRect().width),
    });
  });
  return out;
})()`

/** 逐字段断言几何不变量 */
function assertFields(scope, fields) {
  for (const f of fields) {
    const id = `${scope}｜${f.kind}｜${f.label}`
    check(`${id}：标签单行`, f.labelLines <= 1, `labelLines=${f.labelLines}`)
    check(`${id}：标签不压值行`, !(f.floated && f.overlap > 0), `overlap=${f.overlap}px floated=${f.floated}`)
    check(`${id}：标签未被裁切`, !f.labelTruncated, `label=${f.label}`)
    if (f.valueTruncated) note(`${id}：值被省略号裁切`, `value=${f.value} width=${f.width}`)
  }
}

function shot(name) {
  try {
    mkdirSync(SHOT_DIR, { recursive: true })
    tauriMcp(['webview-screenshot', '--window-id', 'main', '--file', `${SHOT_DIR}/${name}.png`])
    console.log(`SHOT ${SHOT_DIR}/${name}.png`)
  } catch (e) {
    console.log(`SHOT 失败 ${name}：${e.message}`)
  }
}

/** 切路由并等 Vue patch（合成事件后 DOM 更新是异步的） */
async function gotoRoute(hash) {
  execJs(`(() => { location.hash = "${hash}"; return "nav"; })()`)
  await sleep(900)
}

async function main() {
  // 会话：先看状态，未连上则拉起（应用未运行时会连不上——给出明确报错）
  let status
  try {
    status = parseJson(tauriMcp(['driver-session', 'status', '--json']))
  } catch {
    status = null
  }
  if (!status || status.connected !== true) {
    tauriMcp(['driver-session', 'start', '--port', PORT])
    await sleep(1500)
    status = parseJson(tauriMcp(['driver-session', 'status', '--json']))
  }
  check('driver-session 已连接真应用', status?.connected === true, `identifier=${status?.identifier}`)
  if (status?.connected !== true) {
    console.log('\n汇总：FAIL=1（应用未运行或 mcp-bridge 未启用——须 debug 构建）')
    process.exitCode = 1
    return
  }

  // 逐路由巡检
  for (const route of ROUTES) {
    await gotoRoute(route)
    const fields = execJs(MEASURE)
    const scope = route.replace('#/', '')
    if (!Array.isArray(fields) || fields.length === 0) {
      // 导入页需先选文件才出字段——无字段不算缺陷，记为跳过
      skipNote(`${scope}：无字段可量测`, '该页需前置交互（如导入页先选文件）才渲染字段，跳过')
      shot(`route-${scope}`)
      continue
    }
    console.log(`INFO ${scope}：量测 ${fields.length} 个字段`)
    assertFields(scope, fields)
    shot(`route-${scope}`)
  }

  // 缺陷复现路径：设置页切到英文后复测（标签文案变长、选中值变短）
  await gotoRoute('#/settings')
  const before = execJs(MEASURE)
  const localeBefore = before.find((f) => f.label === '界面语言' || f.label === 'Interface language')
  check('设置页：语言下拉存在', !!localeBefore, localeBefore ? `label=${localeBefore.label} value=${localeBefore.value}` : '未找到')
  execJs(`(() => {
    const trig = document.querySelector('.set-locale .md-select__trigger');
    if (!trig) return 'no-trigger';
    trig.click();
    return 'opened';
  })()`)
  await sleep(500)
  const picked = execJs(`(() => {
    const opt = Array.from(document.querySelectorAll('.md-select__option')).find((o) => (o.textContent || '').trim() === 'English');
    if (!opt) return { picked: false, options: Array.from(document.querySelectorAll('.md-select__option')).map((o) => (o.textContent || '').trim()) };
    opt.click();
    return { picked: true };
  })()`)
  check('设置页：语言切到 English', picked?.picked === true, picked?.picked ? '' : `可见选项=${JSON.stringify(picked?.options ?? [])}`)
  await sleep(900)
  const after = execJs(MEASURE)
  const localeAfter = after.find((f) => f.label === 'Interface language')
  check('设置页：英文态标签为 Interface language', !!localeAfter, localeAfter ? `value=${localeAfter.value}` : `实际标签=${JSON.stringify(after.map((f) => f.label))}`)
  if (Array.isArray(after)) assertFields('settings-en', after)
  shot('settings-english')

  console.log(`\n汇总：FAIL=${fail}${warn ? `，WARN=${warn}（值被省略号裁切：固定宽度容器的取舍，完整文案在菜单可见）` : ''}${skip ? `，SKIP=${skip}（前置交互未满足）` : ''}`)
  process.exitCode = fail ? 1 : 0
}

// 仅直接运行时执行（被 import 时只导出纯函数供单测）
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((e) => {
    console.error('e2e 执行异常：' + (e && e.stack ? e.stack : e))
    process.exitCode = 1
  })
}
