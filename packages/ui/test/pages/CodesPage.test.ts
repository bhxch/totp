import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createMemoryStorage, newEntryFromUri } from '@totp/core'
import { createVueStore } from '../../src/store'
import CodesPage from '../../src/pages/CodesPage.vue'

async function readyStore() {
  const s = createVueStore(createMemoryStorage())
  await s.initStore()
  await s.addEntryOp(newEntryFromUri('otpauth://totp/GitHub:me@ex.com?secret=JBSWY3DPEHPK3PXP', 1700000000000))
  return s
}

describe('CodesPage 列表与搜索（自 旧单页 迁移）', () => {
  it('渲染条目与搜索过滤', async () => {
    const s = await readyStore()
    const w = mount(CodesPage, { props: { store: s } })
    await vi.waitFor(() => expect(w.text()).toContain('GitHub'))
    const input = w.find('input[type="search"]')
    await input.setValue('不存在')
    expect(w.text()).not.toContain('GitHub')
  })

  it('点击条目恒 emit copy 且携带验证码（enableCopy 语义由宿主 @copy 决定）', async () => {
    const s = await readyStore()
    const w = mount(CodesPage, { props: { store: s } })
    // 等验证码就绪（recompute 异步，未就绪时显示占位 '------'）
    await vi.waitFor(() => expect(w.find('.otp-item .code').text()).not.toBe('------'))
    await w.find('.otp-item').trigger('click')
    expect(w.emitted('copy')).toHaveLength(1)
    expect(String(w.emitted('copy')![0]![0])).toMatch(/^\d{6}$/)
  })

  it('HOTP：复制 emit copy 后 counter 递增', async () => {
    const s = createVueStore(createMemoryStorage())
    await s.initStore()
    await s.addEntryOp(newEntryFromUri('otpauth://hotp/H:h?secret=JBSWY3DPEHPK3PXP&counter=7', 1))
    const w = mount(CodesPage, { props: { store: s } })
    await vi.waitFor(() => expect(w.find('.otp-item .code').text()).not.toBe('------'))
    await w.find('.otp-item').trigger('click')
    expect(w.emitted('copy')).toHaveLength(1)
    await vi.waitFor(() => expect(s.vault.entries[0]!.counter).toBe(8))
  })

  it('删除：两击确认（首击仅进入确认态，再击才删除）', async () => {
    const s = await readyStore()
    const w = mount(CodesPage, { props: { store: s } })
    await vi.waitFor(() => expect(w.text()).toContain('GitHub'))
    const del = w.findAll('.ops button').find((b) => b.text() === '删除')!
    await del.trigger('click')
    // 第一次点击进入确认态，条目仍在
    const confirmBtn = w.find('.md-btn--danger')
    expect(confirmBtn.exists()).toBe(true)
    expect(confirmBtn.text()).toBe('确认删除？')
    expect(s.vault.entries).toHaveLength(1)
    // 第二次点击才真正删除
    await confirmBtn.trigger('click')
    await vi.waitFor(() => expect(s.vault.entries).toHaveLength(0))
  })
})

describe('CodesPage I49 搜 secret 开关（自 旧单页 迁移）', () => {
  it('默认关闭：搜密钥片段不命中（issuer/label 不含密钥）；开启后命中', async () => {
    const s = await readyStore() // 条目 issuer=GitHub, secret=JBSWY3DPEHPK3PXP
    const w = mount(CodesPage, { props: { store: s } })
    await vi.waitFor(() => expect(w.text()).toContain('GitHub'))
    const input = w.find('input[type="search"]')
    await input.setValue('JBSWY') // 密钥片段
    // 默认 searchSecret=false → 不显示
    expect(w.text()).not.toContain('GitHub')
    // 开启后（MdCheckbox 内部 checkbox 经 v-model:search-secret 上抛）
    await w.find('input[type="checkbox"]').setValue(true)
    expect(w.text()).toContain('GitHub')
    // 关掉
    await w.find('input[type="checkbox"]').setValue(false)
    expect(w.text()).not.toContain('GitHub')
  })
})

describe('CodesPage 分组筛选 chips', () => {
  /** 准备 2 分组 + 各含 1 条条目的 store（A→工作，B→生活） */
  async function storeWithGroups() {
    const s = createVueStore(createMemoryStorage())
    await s.initStore()
    await s.addGroupOp('工作')
    await s.addGroupOp('生活')
    const gidWork = s.vault.groups[0]!.id
    await s.addEntryOp(newEntryFromUri('otpauth://totp/A:a?secret=JBSWY3DPEHPK3PXP', 1))
    await s.addEntryOp(newEntryFromUri('otpauth://totp/B:b?secret=JBSWY3DPEHPK3PXP', 2))
    await s.updateEntryOp(s.vault.entries[0]!.uuid, { groupIds: [gidWork] })
    return { s, gidWork }
  }

  function chip(w: ReturnType<typeof mount>, label: string) {
    return w.findAll('.md-chip').find((c) => c.text() === label)!
  }

  it('渲染「全部」+ 各分组 + 「管理分组」；默认「全部」选中', async () => {
    const { s } = await storeWithGroups()
    const w = mount(CodesPage, { props: { store: s } })
    await vi.waitFor(() => expect(w.findAll('.md-chip').length).toBeGreaterThanOrEqual(3))
    const labels = w.findAll('.md-chip').map((c) => c.text())
    expect(labels).toEqual(['全部', '工作', '生活', '管理分组'])
    expect(chip(w, '全部').classes()).toContain('md-chip--selected')
    expect(chip(w, '工作').classes()).not.toContain('md-chip--selected')
  })

  it('选某分组 chip 后仅显示该组条目；点「全部」恢复全量', async () => {
    const { s } = await storeWithGroups()
    const w = mount(CodesPage, { props: { store: s } })
    await vi.waitFor(() => expect(w.findAll('.otp-item')).toHaveLength(2))
    await chip(w, '工作').trigger('click')
    const texts = w.findAll('.otp-item').map((i) => i.text())
    expect(texts).toHaveLength(1)
    expect(texts[0]).toContain('A')
    expect(chip(w, '工作').classes()).toContain('md-chip--selected')
    // 回「全部」
    await chip(w, '全部').trigger('click')
    expect(w.findAll('.otp-item')).toHaveLength(2)
    expect(chip(w, '全部').classes()).toContain('md-chip--selected')
  })

  it('选中分组被删除后自动回「全部」（悬空 filter 兜底）', async () => {
    const { s, gidWork } = await storeWithGroups()
    const w = mount(CodesPage, { props: { store: s } })
    await vi.waitFor(() => expect(w.findAll('.otp-item')).toHaveLength(2))
    await chip(w, '工作').trigger('click')
    expect(w.findAll('.otp-item')).toHaveLength(1)
    // 删除「工作」分组（Task 10 GroupManagerDialog / 远端同步路径）
    await s.removeGroupOp(gidWork)
    await vi.waitFor(() => expect(s.vault.groups.find((g) => g.id === gidWork)).toBeUndefined())
    // groupFilter 自动回 null：两条都显示，「全部」chip 选中
    await vi.waitFor(() => expect(w.findAll('.otp-item')).toHaveLength(2))
    expect(chip(w, '全部').classes()).toContain('md-chip--selected')
  })

  it('点「管理分组」emit open-groups 并打开 GroupManagerDialog，遮罩关闭', async () => {
    const { s } = await storeWithGroups()
    const w = mount(CodesPage, { props: { store: s } })
    await chip(w, '管理分组').trigger('click')
    expect(w.emitted('open-groups')).toHaveLength(1)
    expect(w.find('.md-dialog').exists()).toBe(true)
    expect(w.find('.md-dialog__headline').text()).toBe('分组管理')
    // 点遮罩关闭
    await w.find('.md-dialog__scrim').trigger('click')
    expect(w.find('.md-dialog').exists()).toBe(false)
  })
})

describe('CodesPage FAB 新建入口', () => {
  it('点 MdFab 打开 EntryFormDialog（新建态）渲染 EntryForm，取消后弹层收起', async () => {
    const s = await readyStore()
    const w = mount(CodesPage, { props: { store: s } })
    expect(w.find('.md-dialog').exists()).toBe(false)
    await w.find('.md-fab').trigger('click')
    expect(w.find('.md-dialog').exists()).toBe(true)
    expect(w.find('.md-dialog__headline').text()).toBe('新建条目')
    expect(w.find('form.entry-form').exists()).toBe(true)
    const cancel = w.findAll('form.entry-form button').find((b) => b.text() === '取消')!
    await cancel.trigger('click')
    expect(w.find('.md-dialog').exists()).toBe(false)
  })

  it('行内「编辑」打开 EntryFormDialog 编辑态，save 后写库并关弹（新建默认值分支留在本页）', async () => {
    const s = await readyStore()
    const w = mount(CodesPage, { props: { store: s } })
    await vi.waitFor(() => expect(w.text()).toContain('GitHub'))
    const editBtn = w.findAll('.ops button').find((b) => b.text() === '编辑')!
    await editBtn.trigger('click')
    expect(w.find('.md-dialog__headline').text()).toBe('编辑条目')
    await w.find('input[placeholder="服务名（如 GitHub）"]').setValue('GitHubX')
    await w.find('form.entry-form').trigger('submit')
    await vi.waitFor(() => expect(s.vault.entries[0]!.issuer).toBe('GitHubX'))
    // 关弹发生在写库 promise resolve 之后，同样 waitFor
    await vi.waitFor(() => expect(w.find('.md-dialog').exists()).toBe(false))
  })
})

describe('CodesPage reveal / 右键菜单 / pinned（自 旧单页 C16 迁移）', () => {
  /** 准备含 2 条条目的 store（a/b） */
  async function storeWithTwo(): Promise<ReturnType<typeof createVueStore>> {
    const s = createVueStore(createMemoryStorage())
    await s.initStore()
    await s.addEntryOp(newEntryFromUri('otpauth://totp/A:a?secret=JBSWY3DPEHPK3PXP', 1))
    await s.addEntryOp(newEntryFromUri('otpauth://totp/B:b?secret=JBSWY3DPEHPK3PXP', 2))
    return s
  }

  it('点击 reveal 按钮弹 RevealDialog 显示前 4 + 后 4 形态密钥，不在页面 DOM 留明文', async () => {
    const s = await storeWithTwo()
    const w = mount(CodesPage, { props: { store: s } })
    await w.find('button[title="显示密钥"]').trigger('click')
    await vi.waitFor(() => expect(w.find('.md-dialog').exists()).toBe(true))
    expect(w.find('.md-dialog__headline').text()).toBe('A — 密钥')
    expect(w.find('.reveal-secret').text()).toMatch(/^[A-Z2-7]{4}…[A-Z2-7]{4}$/)
    // 页面 DOM 内不应出现完整密钥明文（列表与对话框均遮蔽）
    expect(w.find('.otp-item').text()).not.toContain('JBSWY3DPEHPK3PXP')
    expect(w.text()).not.toContain('JBSWY3DPEHPK3PXP')
    // 点「关闭」（data-md-close 委托）关闭
    await w.find('[data-md-close]').trigger('click')
    expect(w.find('.md-dialog').exists()).toBe(false)
  })

  it('右键条目：MdMenu 渲染三项菜单，点「置顶」调用 updateEntryOp 并排序前置', async () => {
    const s = await storeWithTwo()
    const w = mount(CodesPage, { props: { store: s } })
    await w.find('.otp-item').trigger('contextmenu', { clientX: 100, clientY: 200 })
    expect(w.find('.md-menu').exists()).toBe(true)
    // 菜单有「编辑」「复制 URI」「置顶」三项
    expect(w.findAll('.md-menu button')).toHaveLength(3)
    // 模拟右键第二条；再次触发覆盖菜单位置与目标
    const items = w.findAll('.otp-item')
    await items[1]!.trigger('contextmenu', { clientX: 50, clientY: 50 })
    const pinBtn = w.findAll('.md-menu button').find((b) => b.text() === '置顶')!
    await pinBtn.trigger('click')
    await vi.waitFor(() => {
      const uuids = w.findAll('.otp-item').map((i) => i.text())
      // pinned=b 应排在 pinned=undefined(a) 之前；text() 包含 issuer
      expect(uuids[0]).toContain('B')
    })
    // 写盘：vault 内 B.pinned=true
    const ent = s.vault.entries.find((e) => e.issuer === 'B')!
    expect(ent.pinned).toBe(true)
    // 菜单动作完成后关闭
    expect(w.find('.md-menu').exists()).toBe(false)
  })

  it('右键「复制 URI」调用剪贴板写入 otpauth:// 并关闭菜单', async () => {
    const s = await storeWithTwo()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    const w = mount(CodesPage, { props: { store: s } })
    await w.find('.otp-item').trigger('contextmenu', { clientX: 10, clientY: 10 })
    const copyBtn = w.findAll('.md-menu button').find((b) => b.text() === '复制 URI')!
    await copyBtn.trigger('click')
    expect(writeText).toHaveBeenCalledTimes(1)
    const uri = String(writeText.mock.calls[0]![0])
    expect(uri).toMatch(/^otpauth:\/\/totp\/A:a\?secret=JBSWY3DPEHPK3PXP&issuer=A$/)
    expect(w.find('.md-menu').exists()).toBe(false)
  })
})
