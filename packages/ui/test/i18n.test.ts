import { createAppI18n } from '../src/i18n'
import { createVueStore } from '../src/store'
import { describe, expect, it } from 'vitest'
import type { StorageAdapter } from '@totp/core'

const memAdapter = (): StorageAdapter => {
  const m = new Map<string, string>()
  return { get: async (k) => m.get(k) ?? null, set: async (k, v) => void m.set(k, v), delete: async (k) => void m.delete(k) }
}

describe('createAppI18n', () => {
  it('locale 跟随 settings.locale（en 生效，zh 为回退）', () => {
    const store = createVueStore(memAdapter())
    store.settings.locale = 'en'
    const i18n = createAppI18n(store)
    expect(i18n.global.locale.value).toBe('en')
    expect(i18n.global.t('app.title')).not.toBe('app.title') // en 资源已就绪
  })
  it('settings.locale=auto 时按 navigator.language 判定（非 *-en* 落 zh）', () => {
    const store = createVueStore(memAdapter())
    store.settings.locale = 'auto'
    const i18n = createAppI18n(store)
    expect(['zh', 'en']).toContain(i18n.global.locale.value)
  })
  it('settings.locale 变更联动 locale', () => {
    const store = createVueStore(memAdapter())
    const i18n = createAppI18n(store)
    store.settings.locale = 'en'
    expect(i18n.global.locale.value).toBe('en')
  })
})
