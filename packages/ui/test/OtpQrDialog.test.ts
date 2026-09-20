import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import OtpQrDialog from '../src/components/OtpQrDialog.vue'
import type { OtpEntry } from '@totp/core'

// jsdom 无 2d 上下文：stub 为 null，避免组件 draw 时 jsdom 虚拟控制台打「Not implemented」噪声
// （drawQrToCanvas 对 ctx null 早退，行为不变）
vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)

const entry = {
  uuid: 'u1', type: 'totp' as const, issuer: 'GitHub', label: 'alice', secret: 'JBSWY3DPEHPK3PXP',
  algorithm: 'SHA1' as const, digits: 6 as const, period: 30, tagIds: [], order: 0, createdAt: 0,
} satisfies OtpEntry

describe('OtpQrDialog', () => {
  it('open 时渲染 canvas 与固定密钥警示文案', () => {
    const w = mount(OtpQrDialog, { props: { open: true, entry } })
    expect(w.find('canvas').exists()).toBe(true)
    expect(w.text()).toContain('二维码包含完整密钥')
    expect(w.text()).toContain('GitHub')
  })
  it('点击关闭按钮 emit close', async () => {
    const w = mount(OtpQrDialog, { props: { open: true, entry } })
    await w.find('[data-test="qr-close"]').trigger('click')
    expect(w.emitted('close')).toBeTruthy()
  })
})
