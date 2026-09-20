import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { computed } from 'vue'
import SecurityPage from '../../src/pages/SecurityPage.vue'
import { createTestI18n } from '../helpers/i18n'
import SecurityCard from '../../src/components/SecurityCard.vue'
import type { SecurityPlatform } from '../../src/components/securityPlatform'

function makePlatform(over: Partial<SecurityPlatform> = {}): SecurityPlatform {
  return {
    security: null,
    clipboardClearEnabled: computed(() => true),
    setClipboardClear: vi.fn(async () => {}),
    ...over,
  }
}

describe('SecurityPage', () => {
  it('securityPlatform 提供时渲染 SecurityCard 并透传（DOM 落地，卡片本体 v-if）', () => {
    const p = makePlatform()
    const w = mount(SecurityPage, { global: { plugins: [createTestI18n()] }, props: { securityPlatform: p } })
    expect(w.find('section.security').exists()).toBe(true)
    expect(w.findComponent(SecurityCard).props('platform')).toStrictEqual(p)
  })

  it('securityPlatform=null 时不渲染 SecurityCard（popup 零影响）', () => {
    const w = mount(SecurityPage, { global: { plugins: [createTestI18n()] }, props: { securityPlatform: null } })
    expect(w.find('section.security').exists()).toBe(false)
  })
})
