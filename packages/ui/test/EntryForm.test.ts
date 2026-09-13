import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import EntryForm from '../src/components/EntryForm.vue'
import type { OtpEntry } from '@totp/core'

const entry: OtpEntry = {
  uuid: 'u1', type: 'totp', issuer: 'GitHub', label: 'me@ex.com', secret: 'JBSWY3DPEHPK3PXP',
  algorithm: 'SHA1', digits: 6, period: 30, groupIds: [], order: 0, createdAt: 0,
}

describe('EntryForm', () => {
  it('编辑模式回填字段，save 携带全部数据', async () => {
    const w = mount(EntryForm, { props: { initial: entry, groups: [] } })
    await w.find('form').trigger('submit')
    const payload = w.emitted('save')![0]![0]
    expect(payload).toMatchObject({ type: 'totp', issuer: 'GitHub', label: 'me@ex.com', secret: 'JBSWY3DPEHPK3PXP', note: '', groupIds: [], matchRules: [] })
  })
  it('非法 secret 显示错误且不 emit save', async () => {
    const w = mount(EntryForm, { props: { initial: null, groups: [] } })
    await w.find('input[placeholder="密钥 base32"]').setValue('AB01') // 0/1 非法
    await w.find('form').trigger('submit')
    expect(w.emitted('save')).toBeUndefined()
    expect(w.text()).toContain('base32')
  })
  it('分组 checkbox 勾选写入 groupIds', async () => {
    const w = mount(EntryForm, { props: { initial: null, groups: [{ id: 'g1', name: '工作', order: 0 }] } })
    await w.find('input[type="checkbox"]').setValue(true)
    await w.find('form').trigger('submit')
    expect(w.emitted('save')![0]![0]).toMatchObject({ groupIds: ['g1'] })
  })
})
