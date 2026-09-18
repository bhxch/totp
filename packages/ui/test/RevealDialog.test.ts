import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import type { OtpEntry } from '@totp/core'
import RevealDialog from '../src/components/RevealDialog.vue'

const entry: OtpEntry = {
  uuid: 'u1', type: 'totp', issuer: 'GitHub', label: 'me@ex.com', secret: 'JBSWY3DPEHPK3PXP',
  algorithm: 'SHA1', digits: 6, period: 30, groupIds: [], order: 0, createdAt: 0,
}

describe('RevealDialog', () => {
  it('open=false 不渲染弹层', () => {
    const w = mount(RevealDialog, { props: { open: false, entry: null } })
    expect(w.find('.md-dialog').exists()).toBe(false)
  })

  it('entry=null 时 headline 兜底为「密钥」（不渲染 undefined 字样）', () => {
    const w = mount(RevealDialog, { props: { open: true, entry: null } })
    expect(w.find('.md-dialog__headline').text()).toBe('密钥')
    expect(w.text()).not.toContain('undefined')
  })

  it('headline「{issuer} — 密钥」；密钥呈前 4…后 4 遮蔽形态，不渲染完整 secret', () => {
    const w = mount(RevealDialog, { props: { open: true, entry } })
    expect(w.find('.md-dialog__headline').text()).toBe('GitHub — 密钥')
    expect(w.find('.reveal-secret').text()).toMatch(/^[A-Z2-7]{4}…[A-Z2-7]{4}$/)
    expect(w.find('.reveal-secret').text()).toBe('JBSW…3PXP')
    // 全文任何位置不出现完整明文密钥
    expect(w.text()).not.toContain('JBSWY3DPEHPK3PXP')
    expect(w.text()).toContain('仅显示密钥前后各 4 位')
  })

  it('secret ≤8 位时全显', () => {
    const short = { ...entry, secret: 'ABCD2345' }
    const w = mount(RevealDialog, { props: { open: true, entry: short } })
    expect(w.find('.reveal-secret').text()).toBe('ABCD2345')
  })

  it('secret 含空白时归一化后遮蔽', () => {
    const spaced = { ...entry, secret: 'JBSW Y3DP EHPK 3PXP' }
    const w = mount(RevealDialog, { props: { open: true, entry: spaced } })
    expect(w.find('.reveal-secret').text()).toBe('JBSW…3PXP')
  })

  it('点「关闭」（data-md-close 委托）emit close', async () => {
    const w = mount(RevealDialog, { props: { open: true, entry }, attachTo: document.body })
    const closeBtn = w.findAll('[data-md-close]').find((b) => b.text() === '关闭')!
    await closeBtn.trigger('click')
    expect(w.emitted('close')).toHaveLength(1)
    w.unmount()
  })
})
