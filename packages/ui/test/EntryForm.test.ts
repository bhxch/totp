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
  it('编辑已有 hotp 时类型下拉锁定且含 hotp 选项', async () => {
    const w = mount(EntryForm, { props: { initial: { ...entry, type: 'hotp' }, groups: [] } })
    const select = w.find('select')
    expect(select.attributes('disabled')).toBeDefined()
    expect(select.html()).toContain('hotp')
  })
  it('添加/编辑/删除 matchRule 并随 save 提交', async () => {
    const w = mount(EntryForm, { props: { initial: entry, groups: [] } })
    await w.find('button.add-rule').trigger('click')
    const selects = w.findAll('select.rule-strategy')
    expect(selects).toHaveLength(1)
    await selects[0]!.setValue('baseDomain')
    await w.find('input.rule-pattern').setValue('github.com')
    await w.find('form').trigger('submit')
    expect(w.emitted('save')![0]![0]).toMatchObject({ matchRules: [{ strategy: 'baseDomain', pattern: 'github.com' }] })
    await w.find('button.rm-rule').trigger('click')
    await w.find('form').trigger('submit')
    expect(w.emitted('save')!.at(-1)![0]).toMatchObject({ matchRules: [] })
  })
  it('secret 默认遮蔽（type=password），toggle 切换显示/隐藏', async () => {
    const w = mount(EntryForm, { props: { initial: null, groups: [] } })
    const secret = () => w.find('input[placeholder="密钥 base32"]')
    expect(secret().attributes('type')).toBe('password')
    await w.find('button.secret-toggle').trigger('click')
    expect(secret().attributes('type')).toBe('text')
    await w.find('button.secret-toggle').trigger('click')
    expect(secret().attributes('type')).toBe('password')
  })
  it('遮蔽下 secret 值仍可输入并随 save 提交', async () => {
    const w = mount(EntryForm, { props: { initial: null, groups: [] } })
    await w.find('input[placeholder="密钥 base32"]').setValue('jbswy3dpehpk3pxp')
    await w.find('form').trigger('submit')
    expect(w.emitted('save')![0]![0]).toMatchObject({ secret: 'JBSWY3DPEHPK3PXP' })
  })
})
