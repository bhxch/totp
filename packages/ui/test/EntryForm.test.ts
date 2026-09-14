import { describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createMemoryStorage, getBuiltinIcons, type OtpEntry } from '@totp/core'
import EntryForm from '../src/components/EntryForm.vue'
import type { EntryFormData } from '../src/components/entryForm'
import { createIconStore } from '../src/iconStore'

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

describe('EntryForm 图标推荐与选择', () => {
  const icons = () => ({ builtin: getBuiltinIcons(), stored: {} as Readonly<Record<string, string>> })
  const issuerInput = (w: VueWrapper) => w.find('input[placeholder="服务名（如 GitHub）"]')

  it('issuer 输入 github 防抖后出现推荐气泡，点「使用」后 save 携带 builtin icon', async () => {
    const w = mount(EntryForm, { props: { initial: null, groups: [], icons: icons() } })
    expect(w.text()).not.toContain('检测到图标')
    await issuerInput(w).setValue('github')
    // 300ms 防抖后才显示推荐
    await vi.waitFor(() => expect(w.text()).toContain('检测到图标'))
    expect(w.find('.icon-recommend svg.icon-preview').exists()).toBe(true)
    await w.find('button.use-recommend-icon').trigger('click')
    expect(w.text()).not.toContain('检测到图标')
    await w.find('form').trigger('submit')
    expect(w.emitted('save')![0]![0]).toMatchObject({ icon: { kind: 'builtin', id: 'github' } })
  })

  it('issuer 无匹配时不显示推荐气泡', async () => {
    const w = mount(EntryForm, { props: { initial: null, groups: [], icons: icons() } })
    await issuerInput(w).setValue('zzz-不存在的服务')
    await new Promise((r) => setTimeout(r, 400)) // 越过 300ms 防抖
    expect(w.text()).not.toContain('检测到图标')
  })

  it('图标选择区默认收起，展示当前图标（builtin→svg），清除后 save 不携带 icon', async () => {
    const w = mount(EntryForm, {
      props: { initial: { ...entry, icon: { kind: 'builtin', id: 'github' } }, groups: [], icons: icons() },
    })
    const picker = w.find('details.icon-picker')
    expect(picker.exists()).toBe(true)
    expect((picker.element as HTMLDetailsElement).open).toBe(false)
    // 已有图标不弹推荐
    await issuerInput(w).setValue('github')
    await new Promise((r) => setTimeout(r, 400))
    expect(w.text()).not.toContain('检测到图标')
    await picker.find('summary').trigger('click')
    expect(picker.find('svg.icon-preview').exists()).toBe(true)
    await w.find('button.clear-icon').trigger('click')
    await w.find('form').trigger('submit')
    expect((w.emitted('save')![0]![0] as EntryFormData).icon).toBeUndefined()
  })

  it('URL 拉取成功后预览并随 save 携带 {kind:url}；清除按钮收起已设图标', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, blob: async () => new Blob(['png-bytes'], { type: 'image/png' }) })))
    try {
      const store = createIconStore(createMemoryStorage())
      const w = mount(EntryForm, { props: { initial: null, groups: [], icons: { builtin: getBuiltinIcons(), stored: store.icons }, iconStore: store } })
      await w.find('details.icon-picker summary').trigger('click')
      await w.find('input.icon-url').setValue('https://example.com/a.png')
      await w.find('button.fetch-icon').trigger('click')
      await vi.waitFor(() => expect(w.find('img.icon-current-img').attributes('src')).toMatch(/^data:image\/png;base64,/))
      await w.find('form').trigger('submit')
      expect(w.emitted('save')![0]![0]).toMatchObject({ icon: { kind: 'url', url: 'https://example.com/a.png' } })
      // store 内以 url:<id> 缓存
      expect(Object.keys(store.icons).some((k) => k.startsWith('url:'))).toBe(true)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('URL 拉取失败显示错误提示且不设置 icon', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, blob: async () => new Blob([]) })))
    try {
      const store = createIconStore(createMemoryStorage())
      const w = mount(EntryForm, { props: { initial: null, groups: [], icons: { builtin: getBuiltinIcons(), stored: store.icons }, iconStore: store } })
      await w.find('details.icon-picker summary').trigger('click')
      await w.find('input.icon-url').setValue('https://example.com/a.png')
      await w.find('button.fetch-icon').trigger('click')
      await vi.waitFor(() => expect(w.text()).toContain('图标拉取失败'))
      await w.find('form').trigger('submit')
      expect((w.emitted('save')![0]![0] as EntryFormData).icon).toBeUndefined()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
