import { describe, expect, it } from 'vitest'
import { mergeSettingsPreservingForeign } from '../src/tauriFs'

// P0 修复：前端 saveSettings 走 adapter.set('settings', …) 原为整文件覆盖，
// 会抹掉 Rust 侧同写 settings.json 的四组配置（shortcutToggleMini/devtools/releasePolicy/mcp）。
// mergeSettingsPreservingForeign 做 { ...盘上对象, ...新值 } 合并：新值优先、外来键保留。

/** 模拟 Rust 侧写入的外来配置（四组键的代表性样本） */
const rustKeys = {
  shortcutToggleMini: 'alt+shift+t',
  devtools: { enabled: true, port: 9222 },
  releasePolicy: { pauseMinutes: 10, destroyMinutes: 30, lockOnPause: true, lockOnDestroy: false },
  mcp: { enabled: true, mode: 'wildcard', port: 47215, token: 'x', whitelist: [], exposedTools: [] },
}

/** 模拟前端 saveSettings 的 JSON.stringify(AppSettings) 新值 */
const appSettings = JSON.stringify({ theme: 'dark', locale: 'zh', lockOnSystemLock: true })

describe('mergeSettingsPreservingForeign（settings.json 读改写合并）', () => {
  it('盘上 Rust 外来键全部保留，前端新键照常写入', () => {
    const oldText = JSON.stringify(rustKeys)
    const merged = JSON.parse(mergeSettingsPreservingForeign(oldText, appSettings)) as Record<string, unknown>
    expect(merged.shortcutToggleMini).toBe('alt+shift+t')
    expect(merged.devtools).toEqual({ enabled: true, port: 9222 })
    expect(merged.releasePolicy).toEqual(rustKeys.releasePolicy)
    expect(merged.mcp).toEqual(rustKeys.mcp)
    expect(merged.theme).toBe('dark')
    expect(merged.locale).toBe('zh')
  })

  it('同名键新值优先（前端保存的 AppSettings 覆盖盘上旧值）', () => {
    const oldText = JSON.stringify({ ...rustKeys, theme: 'light', locale: 'en' })
    const merged = JSON.parse(mergeSettingsPreservingForeign(oldText, appSettings)) as Record<string, unknown>
    expect(merged.theme).toBe('dark')
    expect(merged.locale).toBe('zh')
    expect(merged.shortcutToggleMini).toBe('alt+shift+t') // 非同名外来键不受影响
  })

  it('旧文本损坏（非法 JSON / 根非对象 / 空文本）回退纯新值，不抛错', () => {
    for (const bad of ['not json{', '[1,2]', '"x"', '42', 'null', '']) {
      const merged = JSON.parse(mergeSettingsPreservingForeign(bad, appSettings)) as Record<string, unknown>
      expect(merged).toEqual(JSON.parse(appSettings))
    }
  })

  it('无旧文件（null）落纯新值；新值非法 JSON 直接抛错（契约上层保证合法）', () => {
    const merged = JSON.parse(mergeSettingsPreservingForeign(null, appSettings)) as Record<string, unknown>
    expect(merged).toEqual(JSON.parse(appSettings))
    expect(() => mergeSettingsPreservingForeign('{}', '{broken')).toThrow()
  })
})
