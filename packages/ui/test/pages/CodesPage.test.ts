import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createMemoryStorage, newEntryFromUri, type OtpEntry } from '@totp/core'
import { createVueStore } from '../../src/store'
import CodesPage from '../../src/pages/CodesPage.vue'
import { createTestI18n } from '../helpers/i18n'

async function readyStore() {
  const s = createVueStore(createMemoryStorage())
  await s.initStore()
  await s.addEntryOp(newEntryFromUri('otpauth://totp/GitHub:me@ex.com?secret=JBSWY3DPEHPK3PXP', 1700000000000))
  return s
}

describe('CodesPage 列表与搜索（自 旧单页 迁移）', () => {
  it('渲染条目与搜索过滤', async () => {
    const s = await readyStore()
    const w = mount(CodesPage, { global: { plugins: [createTestI18n()] }, props: { store: s } })
    await vi.waitFor(() => expect(w.text()).toContain('GitHub'))
    const input = w.find('input[type="search"]')
    await input.setValue('不存在')
    expect(w.text()).not.toContain('GitHub')
  })

  it('点击条目恒 emit copy 且携带验证码（enableCopy 语义由宿主 @copy 决定）', async () => {
    const s = await readyStore()
    const w = mount(CodesPage, { global: { plugins: [createTestI18n()] }, props: { store: s } })
    // 验证码就绪前恒打码（验收条目3，'------' 占位不再可见）：双击揭示真实码作为就绪探针
    await w.find('.otp-item').trigger('dblclick')
    await vi.waitFor(() => expect(w.find('.otp-item .code').text()).toMatch(/^\d{3} \d{3}$/))
    await w.find('.otp-item').trigger('click')
    expect(w.emitted('copy')).toHaveLength(1)
    expect(String(w.emitted('copy')![0]![0])).toMatch(/^\d{6}$/)
  })

  it('HOTP：复制 emit copy 后 counter 递增', async () => {
    const s = createVueStore(createMemoryStorage())
    await s.initStore()
    await s.addEntryOp(newEntryFromUri('otpauth://hotp/H:h?secret=JBSWY3DPEHPK3PXP&counter=7', 1))
    const w = mount(CodesPage, { global: { plugins: [createTestI18n()] }, props: { store: s } })
    // 同上：打码后以双击揭示作为就绪探针
    await w.find('.otp-item').trigger('dblclick')
    await vi.waitFor(() => expect(w.find('.otp-item .code').text()).toMatch(/^\d{3} \d{3}$/))
    await w.find('.otp-item').trigger('click')
    expect(w.emitted('copy')).toHaveLength(1)
    await vi.waitFor(() => expect(s.vault.entries[0]!.counter).toBe(8))
  })

  it('删除：两击确认（首击仅进入确认态，再击才删除）', async () => {
    const s = await readyStore()
    const w = mount(CodesPage, { global: { plugins: [createTestI18n()] }, props: { store: s } })
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
    const w = mount(CodesPage, { global: { plugins: [createTestI18n()] }, props: { store: s } })
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

describe('CodesPage 标签筛选（spec §3 管理页）', () => {
  /** 空白底座条目（issuer=GitHub 供文本断言；tagIds 由用例按需覆盖） */
  function baseEntry(label: string): OtpEntry {
    return {
      uuid: label, type: 'totp', issuer: 'GitHub', label, secret: 'JBSWY3DPEHPK3PXP',
      algorithm: 'SHA1', digits: 6, period: 30, tagIds: [], order: 0, createdAt: 0,
    }
  }

  const twoTags = async (s: ReturnType<typeof createVueStore>) => {
    const r1 = await s.addTagOp('工作')
    await s.addTagOp('个人')
    await s.addEntryOp({ ...baseEntry('a'), tagIds: [r1] })
  }

  function chip(w: ReturnType<typeof mount>, label: string) {
    return w.findAll('button.md-chip').find((c) => c.text() === label)!
  }

  it('多选 any：命中任一选中标签；切「全部」模式后需命中全部选中', async () => {
    const s = createVueStore(createMemoryStorage())
    await s.initStore()
    await twoTags(s)
    const w = mount(CodesPage, { global: { plugins: [createTestI18n()] }, props: { store: s } })
    await vi.waitFor(() => expect(w.text()).toContain('GitHub'))
    const chips = w.findAll('button.md-chip')
    await chips.find((c) => c.text() === '工作')!.trigger('click')
    expect(w.text()).toContain('GitHub') // 条目带「工作」，any 命中 → 显示
    await chips.find((c) => c.text() === '个人')!.trigger('click')
    expect(w.text()).toContain('GitHub') // any 语义：命中任一选中标签即仍显示
    // 选中 ≥2 后模式切换自动可用：切「全部」（all）→ 条目仅带「工作」→ 隐藏
    await w.find('button.mode-toggle').trigger('click')
    expect(w.text()).not.toContain('GitHub')
  })

  it('rememberTagFilter 开启时选中集合写入 settings；关闭时不写', async () => {
    const s = createVueStore(createMemoryStorage())
    await s.initStore()
    await s.addTagOp('工作')
    s.settings.rememberTagFilter = true
    const w = mount(CodesPage, { global: { plugins: [createTestI18n()] }, props: { store: s } })
    await vi.waitFor(() => expect(w.text()).toContain('全部'))
    await w.findAll('button.md-chip').find((c) => c.text() === '工作')!.trigger('click')
    await vi.waitFor(() => expect(s.settings.lastTagFilterIds).toHaveLength(1))
    s.settings.rememberTagFilter = false
    await w.findAll('button.md-chip').find((c) => c.text() === '全部')!.trigger('click')
    expect(s.settings.lastTagFilterIds).toHaveLength(1) // 关闭后不再写
  })

  it('tag 被删除后选中集合剔除悬空 id（回到「全部」）', async () => {
    const s = createVueStore(createMemoryStorage())
    await s.initStore()
    const tid = await s.addTagOp('临时')
    await s.addTagOp('留存') // 保底 1 个 tag：删除「临时」后筛选行仍渲染（TagFilterRow v-if tags.length>0），可断言「全部」选中态
    const w = mount(CodesPage, { global: { plugins: [createTestI18n()] }, props: { store: s } })
    await vi.waitFor(() => expect(w.text()).toContain('临时'))
    await w.findAll('button.md-chip').find((c) => c.text() === '临时')!.trigger('click')
    expect(chip(w, '临时').classes()).toContain('md-chip--selected')
    await s.removeTagOp(tid)
    await vi.waitFor(() => expect(w.text()).not.toContain('临时'))
    // 悬空 id 已从选中集合剔除 → 「全部」chip 回选中态；留存 tag 未被误选
    await vi.waitFor(() => expect(chip(w, '全部').classes()).toContain('md-chip--selected'))
    expect(chip(w, '留存').classes()).not.toContain('md-chip--selected')
  })

  it('点「管理标签」emit open-tags 并打开 TagManagerDialog，遮罩关闭', async () => {
    const s = createVueStore(createMemoryStorage())
    await s.initStore()
    const w = mount(CodesPage, { global: { plugins: [createTestI18n()] }, props: { store: s } })
    await chip(w, '管理标签').trigger('click')
    expect(w.emitted('open-tags')).toHaveLength(1)
    expect(w.find('.md-dialog').exists()).toBe(true)
    expect(w.find('.md-dialog__headline').text()).toBe('标签管理')
    // 点遮罩关闭
    await w.find('.md-dialog__scrim').trigger('click')
    expect(w.find('.md-dialog').exists()).toBe(false)
  })

  it('options 时序（store 初始化晚于挂载）：settings 装载后恢复持久化选中（T13 缺陷修复）', async () => {
    // seed store 落数据：tag 入 vault、settings 预写持久化选中——共享同一 memory storage 模拟上次会话
    const storage = createMemoryStorage()
    const seed = createVueStore(storage)
    await seed.initStore()
    const tid = await seed.addTagOp('工作')
    await storage.set('settings', JSON.stringify({ rememberTagFilter: true, lastTagFilterIds: [tid] }))
    // options 时序：先 mount（settings 尚未装载，setup 初始化读到默认值）再 initStore
    const s = createVueStore(storage)
    const w = mount(CodesPage, { global: { plugins: [createTestI18n()] }, props: { store: s } })
    await s.initStore()
    // 补偿 watch 恢复：「工作」chip 处于选中态
    await vi.waitFor(() => {
      const c = w.findAll('button.md-chip').find((x) => x.text() === '工作')
      expect(c?.classes()).toContain('md-chip--selected')
    })
  })

  it('盘上 lastTagFilterIds 含悬空 id 时恢复不引入 ghost（all 模式不误报空列表）', async () => {
    // seed：真实 tag + 仅带该 tag 的条目；settings 预写 rememberTagFilter + 含悬空 id 的持久化选中 + all 模式
    const storage = createMemoryStorage()
    const seed = createVueStore(storage)
    await seed.initStore()
    const tid = await seed.addTagOp('工作')
    await seed.addEntryOp({ ...baseEntry('a'), tagIds: [tid] })
    await storage.set('settings', JSON.stringify({ rememberTagFilter: true, tagFilterMode: 'all', lastTagFilterIds: ['ghost-dangling-id', tid] }))
    // 悬空 id 走 setup 初始化恢复路径（store 先 init 后 mount：tags 已就绪，清理 watch 首轮无从触发）；
    // mount 先于 initStore 的时序里恢复 watch 与清理 watch 同轮 flush 自愈，测不到该缺陷
    const s = createVueStore(storage)
    await s.initStore()
    const w = mount(CodesPage, { global: { plugins: [createTestI18n()] }, props: { store: s } })
    // 仅真实 id 恢复为选中（悬空 id 无对应 chip，不进选中集合）
    await vi.waitFor(() => {
      const c = w.findAll('button.md-chip').find((x) => x.text() === '工作')
      expect(c?.classes()).toContain('md-chip--selected')
    })
    // ghost 未混入：all 模式下带「工作」的条目不被误报「无匹配条目」
    await vi.waitFor(() => expect(w.text()).toContain('GitHub'))
    expect(w.text()).not.toContain('无匹配条目')
  })

  it('options 时序：rememberTagFilter 关闭时不恢复持久化选中（T13 缺陷修复）', async () => {
    const storage = createMemoryStorage()
    const seed = createVueStore(storage)
    await seed.initStore()
    const tid = await seed.addTagOp('工作')
    // rememberTagFilter 缺省 false：即使盘上有 lastTagFilterIds 也不恢复
    await storage.set('settings', JSON.stringify({ lastTagFilterIds: [tid] }))
    const s = createVueStore(storage)
    const w = mount(CodesPage, { global: { plugins: [createTestI18n()] }, props: { store: s } })
    await s.initStore()
    await vi.waitFor(() => expect(w.text()).toContain('工作')) // chip 渲染（tags 已装载）
    const c = w.findAll('button.md-chip').find((x) => x.text() === '工作')!
    expect(c.classes()).not.toContain('md-chip--selected')
  })
})

describe('CodesPage FAB 新建入口', () => {
  it('点 MdFab 打开 EntryFormDialog（新建态）渲染 EntryForm，取消后弹层收起', async () => {
    const s = await readyStore()
    const w = mount(CodesPage, { global: { plugins: [createTestI18n()] }, props: { store: s } })
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
    const w = mount(CodesPage, { global: { plugins: [createTestI18n()] }, props: { store: s } })
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

describe('CodesPage 右键菜单 / pinned（自 旧单页 C16 迁移）', () => {
  /** 准备含 2 条条目的 store（a/b） */
  async function storeWithTwo(): Promise<ReturnType<typeof createVueStore>> {
    const s = createVueStore(createMemoryStorage())
    await s.initStore()
    await s.addEntryOp(newEntryFromUri('otpauth://totp/A:a?secret=JBSWY3DPEHPK3PXP', 1))
    await s.addEntryOp(newEntryFromUri('otpauth://totp/B:b?secret=JBSWY3DPEHPK3PXP', 2))
    return s
  }

  // 旧 reveal 按钮测试已随 OtpListItem 移除 reveal 入口而删除；RevealDialog 容器已一并清理（验收条目3）

  it('右键条目：MdMenu 渲染四项菜单，点「置顶」调用 updateEntryOp 并排序前置', async () => {
    const s = await storeWithTwo()
    const w = mount(CodesPage, { global: { plugins: [createTestI18n()] }, props: { store: s } })
    await w.find('.otp-item').trigger('contextmenu', { clientX: 100, clientY: 200 })
    expect(w.find('.md-menu').exists()).toBe(true)
    // 菜单有「编辑」「显示二维码」「复制 URI」「置顶」四项（Task 9 增「显示二维码」）
    expect(w.findAll('.md-menu button')).toHaveLength(4)
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

  it('右键「复制 URI」emit copy 携带 otpauth:// 载荷并关闭菜单（审查 I14：不直写剪贴板，由宿主 @copy 写入并纳入清除链路）', async () => {
    const s = await storeWithTwo()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    const w = mount(CodesPage, { global: { plugins: [createTestI18n()] }, props: { store: s } })
    await w.find('.otp-item').trigger('contextmenu', { clientX: 10, clientY: 10 })
    const copyBtn = w.findAll('.md-menu button').find((b) => b.text() === '复制 URI')!
    await copyBtn.trigger('click')
    // 不经 navigator.clipboard 直写（宿主 30s 清除链只挂 @copy，直写会绕过清除）
    expect(writeText).not.toHaveBeenCalled()
    expect(w.emitted('copy')).toHaveLength(1)
    const uri = String(w.emitted('copy')![0]![0])
    // 经 core buildOtpUri 产出（I1d：不再手拼）：label 编码冒号、默认参数不写出
    expect(uri).toBe('otpauth://totp/A%3Aa?secret=JBSWY3DPEHPK3PXP&issuer=A')
    expect(w.find('.md-menu').exists()).toBe(false)
  })
  it('yandex 条目「复制 URI」：host 为 yaotp 且携带 pin（I1d：手拼 otpauth://yandex/ 且无 pin 的旧实现自产 URI 自己都拒收）', async () => {
    const s = createVueStore(createMemoryStorage())
    await s.initStore()
    await s.addEntryOp(newEntryFromUri('otpauth://yaotp/Ya:user?secret=KJTEUGOD5SNXVWBCWJ4G36W4IA&pin=1234'))
    const w = mount(CodesPage, { global: { plugins: [createTestI18n()] }, props: { store: s } })
    await w.find('.otp-item').trigger('contextmenu', { clientX: 10, clientY: 10 })
    const copyBtn = w.findAll('.md-menu button').find((b) => b.text() === '复制 URI')!
    await copyBtn.trigger('click')
    const uri = String(w.emitted('copy')![0]![0])
    expect(uri.startsWith('otpauth://yaotp/')).toBe(true)
    expect(uri).toContain('pin=1234')
  })

  it('右键菜单键盘化：条目带 aria-haspopup=menu；开启聚焦首项；Esc 关闭后焦点回右键条目（批 6 a11y）', async () => {
    const s = await storeWithTwo()
    const w = mount(CodesPage, { global: { plugins: [createTestI18n()] }, props: { store: s }, attachTo: document.body })
    const item = w.find('.otp-item')
    // contextmenu 键/Shift+F10 会在焦点元素上派发 contextmenu → 条目可键盘触达，载体补 aria-haspopup
    expect(item.attributes('aria-haspopup')).toBe('menu')
    await item.trigger('contextmenu', { clientX: 10, clientY: 10 })
    await nextTick()
    expect(w.find('.md-menu').exists()).toBe(true)
    expect(document.activeElement).toBe(w.findAll('.md-menu button')[0]!.element) // 开启聚焦首项
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await nextTick()
    expect(w.find('.md-menu').exists()).toBe(false)
    expect(document.activeElement).toBe(item.element) // 焦点回右键所在条目
    w.unmount()
  })
})
