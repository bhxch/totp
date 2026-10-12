/**
 * _locales 消息表守卫（i18n 批）：manifest name/description 与 background 菜单/通知文案
 * 已从硬编码中文迁至 chrome.i18n（public/_locales/{zh_CN,en}/messages.json）。此前该表
 * 零守护——双语键集漂移、占位符缺失、background 取用键被误删，均要到浏览器运行时才暴露。
 * 四层断言：双语键集一致、消息内容非空 + Chrome 132 字符上限、$占位符$ 必有 placeholders
 * 定义、background 源码 t() 取用键全部存在（源码扫描防删漏）。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import config from '../wxt.config'
import { ZH_MESSAGES_PATH } from './helpers/chromeShim'

type Messages = Record<string, { message: string; placeholders?: Record<string, { content: string }> }>

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const zh = JSON.parse(readFileSync(ZH_MESSAGES_PATH, 'utf8')) as Messages
const en = JSON.parse(readFileSync(ZH_MESSAGES_PATH.replace('zh_CN', 'en'), 'utf8')) as Messages

describe('_locales 消息表（manifest + background 共用）', () => {
  it('zh_CN 与 en 键集一致（双语同步维护，不因缺译回退默认语言）', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })

  it('全部消息非空；en extDescription 不超 Chrome 132 字符 manifest 上限', () => {
    for (const [file, table] of [['zh_CN', zh], ['en', en]] as const) {
      for (const [key, entry] of Object.entries(table)) {
        expect(entry.message.trim().length, `${file}.${key} 消息为空`).toBeGreaterThan(0)
      }
    }
    expect(en.extDescription!.message.length).toBeLessThanOrEqual(132)
  })

  it('消息里的 $占位符$ 必有同名 placeholders 定义，且 content 为 $n$ 形态', () => {
    for (const [file, table] of [['zh_CN', zh], ['en', en]] as const) {
      for (const [key, entry] of Object.entries(table)) {
        const names = [...entry.message.matchAll(/\$(\w+)\$/g)].map((m) => m[1]!)
        for (const name of names) {
          expect(entry.placeholders?.[name.toLowerCase()]?.content, `${file}.${key} 缺占位符 ${name}`).toMatch(/^\$\d+$/)
        }
      }
    }
  })

  it('background 源码 t() 取用的键全部存在于消息表（防删漏）', () => {
    const src = readFileSync(new URL('../entrypoints/background.ts', import.meta.url), 'utf8')
    const used = [...src.matchAll(/\bt\('([A-Za-z]\w*)'/g)].map((m) => m[1]!)
    expect(used.length).toBeGreaterThan(0)
    for (const key of used) expect(zh[key], `background 取用了未定义的消息键 ${key}`).toBeDefined()
  })

  it('manifest 接线：name/description 走 __MSG_，default_locale 为 zh_CN', () => {
    const manifest = (config.manifest as (env: { browser: 'chrome' }) => Record<string, unknown>)({ browser: 'chrome' })
    expect(manifest.name).toBe('__MSG_extName__')
    expect(manifest.description).toBe('__MSG_extDescription__')
    expect(manifest.default_locale).toBe('zh_CN')
  })
})
