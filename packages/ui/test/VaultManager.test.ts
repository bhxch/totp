import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createMemoryStorage, newEntryFromUri } from '@totp/core'
import { createVueStore } from '../src/store'
import VaultManager from '../src/components/VaultManager.vue'

async function readyStore() {
  const s = createVueStore(createMemoryStorage())
  await s.initStore()
  await s.addEntryOp(newEntryFromUri('otpauth://totp/GitHub:me@ex.com?secret=JBSWY3DPEHPK3PXP', 1700000000000))
  return s
}

describe('VaultManager', () => {
  it('渲染条目与搜索过滤', async () => {
    const s = await readyStore()
    const w = mount(VaultManager, { props: { store: s } })
    await vi.waitFor(() => expect(w.text()).toContain('GitHub'))
    const input = w.find('input[type="search"]')
    await input.setValue('不存在')
    expect(w.text()).not.toContain('GitHub')
  })

  it('enableCopy=false 时不调用剪贴板；分组卡显示空态', async () => {
    const s = await readyStore()
    const writeText = vi.fn()
    Object.assign(navigator, { clipboard: { writeText } })
    const w = mount(VaultManager, { props: { store: s } })
    await (w.find('.otp-item').trigger('click'))
    expect(writeText).not.toHaveBeenCalled()
    expect(w.text()).toContain('暂无分组')
  })

  it('enableCopy=true 时点击条目 emit copy 且携带验证码', async () => {
    const s = await readyStore()
    const w = mount(VaultManager, { props: { store: s, enableCopy: true } })
    // 等验证码就绪（recompute 异步，未就绪时显示占位 '------'）
    await vi.waitFor(() => expect(w.find('.otp-item .code').text()).not.toBe('------'))
    await w.find('.otp-item').trigger('click')
    expect(w.emitted('copy')).toHaveLength(1)
    expect(String(w.emitted('copy')![0]![0])).toMatch(/^\d{6}$/)
  })
})

describe('VaultManager I49 搜 secret 开关', () => {
  it('默认关闭：搜密钥片段不命中（issuer/label 不含密钥）；开启后命中', async () => {
    const s = await readyStore() // 条目 issuer=GitHub, secret=JBSWY3DPEHPK3PXP
    const w = mount(VaultManager, { props: { store: s } })
    await vi.waitFor(() => expect(w.text()).toContain('GitHub'))
    const input = w.find('input[type="search"]')
    await input.setValue('JBSWY') // 密钥片段
    // 默认 searchSecret=false → 不显示
    expect(w.text()).not.toContain('GitHub')
    // 开启后
    await w.find('input.secret-toggle-input').setValue(true)
    expect(w.text()).toContain('GitHub')
    // 关掉
    await w.find('input.secret-toggle-input').setValue(false)
    expect(w.text()).not.toContain('GitHub')
  })
})

describe('VaultManager I64 删除分组清理 groupIds', () => {
  it('删除分组后 entries 的 groupIds 中该分组 id 被移除', async () => {
    const s = createVueStore(createMemoryStorage())
    await s.initStore()
    await s.addGroupOp('工作')
    await s.addGroupOp('生活')
    const gidWork = s.vault.groups[0]!.id
    const gidLife = s.vault.groups[1]!.id
    await s.addEntryOp(newEntryFromUri('otpauth://totp/A:a?secret=JBSWY3DPEHPK3PXP', 1))
    await s.addEntryOp(newEntryFromUri('otpauth://totp/B:b?secret=JBSWY3DPEHPK3PXP', 2))
    await s.updateEntryOp(s.vault.entries[0]!.uuid, { groupIds: [gidWork, gidLife] })
    await s.updateEntryOp(s.vault.entries[1]!.uuid, { groupIds: [gidWork] })

    const w = mount(VaultManager, { props: { store: s } })
    // 删除工作分组
    const workRow = w.findAll('.group-list li').find((li) => li.text().includes('工作'))!
    await workRow.findAll('button.icon')[1]!.trigger('click') // 🗑 按钮
    await vi.waitFor(() => expect(s.vault.groups.find((g) => g.id === gidWork)).toBeUndefined())
    // 验证级联：entry A 之前含 [工作, 生活]，删除后应只剩 [生活]
    const entryA = s.vault.entries.find((e) => e.issuer === 'A')!
    expect(entryA.groupIds).toEqual([gidLife])
    const entryB = s.vault.entries.find((e) => e.issuer === 'B')!
    expect(entryB.groupIds).toEqual([])
  })
})

describe('VaultManager reveal / 右键菜单 / pinned（C16）', () => {
  /** 准备含 2 条条目的 store（a/b） */
  async function storeWithTwo(): Promise<ReturnType<typeof createVueStore>> {
    const s = createVueStore(createMemoryStorage())
    await s.initStore()
    await s.addEntryOp(newEntryFromUri('otpauth://totp/A:a?secret=JBSWY3DPEHPK3PXP', 1))
    await s.addEntryOp(newEntryFromUri('otpauth://totp/B:b?secret=JBSWY3DPEHPK3PXP', 2))
    return s
  }

  it('点击 reveal 按钮弹模态显示前 4 + 后 4 形态密钥，不在列表 DOM 留明文', async () => {
    const s = await storeWithTwo()
    const w = mount(VaultManager, { props: { store: s } })
    await w.find('button.reveal').trigger('click')
    await vi.waitFor(() => expect(w.find('.reveal-mask').exists()).toBe(true))
    expect(w.find('.reveal-secret').text()).toMatch(/^[A-Z2-7]{4}…[A-Z2-7]{4}$/)
    // 列表 DOM 内不应出现完整密钥明文
    expect(w.find('.otp-item').text()).not.toContain('JBSWY3DPEHPK3PXP')
    // 点遮罩关闭
    await w.find('.reveal-mask').trigger('click')
    expect(w.find('.reveal-mask').exists()).toBe(false)
  })

  it('右键条目：渲染菜单，点「置顶」调用 updateEntryOp 并排序前置', async () => {
    const s = await storeWithTwo()
    const w = mount(VaultManager, { props: { store: s } })
    await w.find('.otp-item').trigger('contextmenu', { clientX: 100, clientY: 200 })
    expect(w.find('.ctx-menu').exists()).toBe(true)
    // 菜单有「编辑」「复制 URI」「置顶」三项
    expect(w.findAll('.ctx-menu li')).toHaveLength(3)
    // 第二条（uuid=b，对应 order=1）置顶——先获取置顶按钮并按目标条目置顶
    const items = w.findAll('.otp-item')
    // 模拟右键第二条；用 closeContextMenu 后再触发（避免互相影响）
    await items[1]!.trigger('contextmenu', { clientX: 50, clientY: 50 })
    const pinBtn = w.findAll('.ctx-menu li button').find((b) => b.text() === '置顶')!
    await pinBtn.trigger('click')
    await vi.waitFor(() => {
      const uuids = w.findAll('.otp-item').map((i) => i.text())
      // pinned=b 应排在 pinned=undefined(a) 之前；text() 包含 issuer
      expect(uuids[0]).toContain('B')
    })
    // 写盘：vault 内 B.pinned=true
    const ent = s.vault.entries.find((e) => e.issuer === 'B')!
    expect(ent.pinned).toBe(true)
  })

  it('右键「复制 URI」调用剪贴板写入 otpauth://', async () => {
    const s = await storeWithTwo()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    const w = mount(VaultManager, { props: { store: s } })
    await w.find('.otp-item').trigger('contextmenu', { clientX: 10, clientY: 10 })
    const copyBtn = w.findAll('.ctx-menu li button').find((b) => b.text() === '复制 URI')!
    await copyBtn.trigger('click')
    expect(writeText).toHaveBeenCalledTimes(1)
    const uri = String(writeText.mock.calls[0]![0])
    expect(uri).toMatch(/^otpauth:\/\/totp\/A:a\?secret=JBSWY3DPEHPK3PXP&issuer=A$/)
  })
})
