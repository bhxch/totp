/**
 * MiniApp 挂载冒烟（P4，盘点 B10.33-36 双窗口缺口）：windowId='mini' 独立 store（与 main 隔离）、
 * 未加密可读/加密经槽 peek 自动解锁（①跟随主窗解锁）、复制编排（HOTP 复制旧 counter 码→递增→
 * 500ms 自动隐藏）、stage 失败→copyFailed 保持可见且 HOTP 不推进、force-lock/mini-session 事件联动、
 * mini 不监听回注事件。
 * Tauri 边界走 test/mocks/tauri（fs 以内存 map 供给）；store 走真实 createTauriFs+createVueStore
 * （createVueStore 局部包装仅记录 windowId 实参）；i18n 用真实 createAppI18n（断言 zh 文案）。
 */
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent } from 'vue'
import {
  addEntry, base64ToBytes, bytesToBase64, changeVaultPassphrase, createVault, encryptVaultWithDek,
  setupVaultEncryption, SECURITY_KEY, VAULT_KEY, type OtpEntry, type SecuritySettings, type Tag, type Vault,
} from '@totp/core'
import { tauriMock } from '../test/mocks/tauri'
import MiniApp from './MiniApp.vue'

const { vueStoreSpy } = vi.hoisted(() => ({ vueStoreSpy: { calls: [] as Array<Record<string, unknown>> } }))
vi.mock('@tauri-apps/api/core', async () => (await import('../test/mocks/tauri')).invokeModule())
vi.mock('@tauri-apps/api/event', async () => (await import('../test/mocks/tauri')).eventModule())
vi.mock('@tauri-apps/api/window', async () => (await import('../test/mocks/tauri')).windowModule())
vi.mock('@tauri-apps/plugin-fs', async () => (await import('../test/mocks/tauri')).fsModule())
vi.mock('@totp/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@totp/ui')>()
  return {
    ...actual,
    createVueStore: (...args: Parameters<typeof actual.createVueStore>) => {
      vueStoreSpy.calls.push(args[1] ?? {})
      return actual.createVueStore(...args)
    },
  }
})

/** OtpListItem 桩：保留 entry/code props 与 copy 事件（copy 编排的驱动入口） */
const OtpListItemStub = defineComponent({
  props: {
    entry: { type: Object, required: true }, icon: { type: null, default: null },
    code: { type: String, default: '' }, remaining: { type: Number, default: 0 }, progress: { type: Number, default: 0 },
    contextMenu: { type: Boolean, default: false }, showQr: { type: Boolean, default: false },
  },
  emits: ['copy', 'dblclick'],
  template: `<div data-test="item" :data-code="code"><button data-test="copy" @click="$emit('copy')">{{ entry.issuer }}</button></div>`,
})

const TOTP: OtpEntry = {
  uuid: 'u1', type: 'totp', issuer: 'GitHub', label: 'me@ex.com', secret: 'JBSWY3DPEHPK3PXP',
  algorithm: 'SHA1', digits: 6, period: 30, tagIds: [], order: 0, createdAt: 0,
}
const HOTP: OtpEntry = {
  uuid: 'h1', type: 'hotp', issuer: 'Legacy', label: 'hotp@ex.com', secret: 'JBSWY3DPEHPK3PXP',
  algorithm: 'SHA1', digits: 6, period: 30, counter: 3, tagIds: [], order: 1, createdAt: 0,
}

/** plugin-fs 内存种子（tauriFs 以 <key>.json 读写） */
const files = new Map<string, string>()
function seedFs() {
  ;(tauriMock.fs.exists as Mock).mockImplementation(async (p: string) => files.has(p))
  ;(tauriMock.fs.readTextFile as Mock).mockImplementation(async (p: string) => files.get(p) ?? '')
  ;(tauriMock.fs.writeTextFile as Mock).mockImplementation(async (p: string, c: string) => { files.set(p, c) })
}

/** locale 定为 zh：locale 缺省 auto 会按 jsdom navigator.language 解析出 en 文案 */
function seedZh() {
  files.set('settings.json', JSON.stringify({ locale: 'zh' }))
}

async function seedVault(entries: OtpEntry[], tags: Tag[] = []): Promise<Vault> {
  let vault: Vault = createVault()
  for (const e of entries) vault = addEntry(vault, e)
  vault.tags = tags
  files.set(`${VAULT_KEY}.json`, JSON.stringify(vault))
  return vault
}

async function mountMini() {
  const wrapper = mount(MiniApp, { global: { stubs: { OtpListItem: OtpListItemStub } } })
  await flushPromises()
  return wrapper
}

/** 确定性等待 useOtpCodes 取码：推进 fake timers 驱动 1s tick 直至谓词满足（复制驱动用例共用） */
async function waitForCode(wrapper: Awaited<ReturnType<typeof mountMini>>, predicate: (c: string) => boolean): Promise<string> {
  let code = wrapper.find('[data-test="item"]').attributes('data-code') ?? ''
  for (let i = 0; i < 30 && !predicate(code); i++) {
    await vi.advanceTimersByTimeAsync(200)
    await flushPromises()
    code = wrapper.find('[data-test="item"]').attributes('data-code') ?? ''
  }
  if (!predicate(code)) throw new Error(`code not ready: ${code}`)
  return code
}

beforeEach(() => {
  tauriMock.reset()
  files.clear()
  seedFs()
  seedZh()
})

describe('windowId=mini 独立 store（spec §7 双窗口 DEK 隔离）', () => {
  it('store 以 windowId=mini 创建；mini 不监听 stash-dek-request/system-lock（只读无回注）', async () => {
    await seedVault([])
    await mountMini()
    expect(vueStoreSpy.calls.at(-1)).toMatchObject({ windowId: 'mini' })
    expect(tauriMock.listenerCount('stash-dek-request')).toBe(0)
    expect(tauriMock.listenerCount('system-lock')).toBe(0)
    expect(tauriMock.listenerCount('force-lock')).toBe(1) // 释放策略锁库联动保留
  })

  it('未加密可读：空库显示「暂无条目」；有条目渲染码列表（useOtpCodes 真实取码，下一 tick 就绪）', async () => {
    const empty = await mountMini()
    expect(empty.text()).toContain('暂无条目')
    await empty.unmount()
    await seedVault([TOTP])
    const wrapper = await mountMini()
    await vi.waitFor(() => expect(wrapper.find('[data-test="item"]').attributes('data-code')).toMatch(/^\d{6}$/), { timeout: 4000 })
  })
})

describe('加密库恒锁定（mini 无解锁 UI 也拿不到主窗会话 DEK）', () => {
  it('加密 vault → lockedNote 文案、条目不渲染', async () => {
    const vault = await seedVault([TOTP])
    const { security, encrypted } = await setupVaultEncryption(JSON.stringify(vault), 'pw-test')
    files.set(`${VAULT_KEY}.json`, JSON.stringify(encrypted))
    files.set(`${SECURITY_KEY}.json`, JSON.stringify(security))
    const wrapper = await mountMini()
    expect(wrapper.text()).toContain('主窗口解锁后此窗口可用')
    expect(wrapper.find('[data-test="item"]').exists()).toBe(false)
  })
})

describe('复制编排（B10.36）', () => {
  it('HOTP 复制成功：stage 暂存旧 counter 码 → counter 递增 → 下次复制为新码 → 500ms 自动隐藏', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      await seedVault([HOTP])
      const wrapper = await mountMini()
      const firstCode = await waitForCode(wrapper, (c) => /^\d{6}$/.test(c))
      await wrapper.find('[data-test="copy"]').trigger('click')
      await flushPromises()
      expect(tauriMock.calls('stage_clipboard_write')[0]?.args).toEqual({ value: firstCode }) // RFC：复制旧 counter 码
      const secondCode = await waitForCode(wrapper, (c) => /^\d{6}$/.test(c) && c !== firstCode) // counter 3→4 已递增
      expect(secondCode).not.toBe(firstCode)
      await vi.advanceTimersByTimeAsync(500)
      await flushPromises()
      expect(tauriMock.window.hide).toHaveBeenCalled() // completeCopy 代次未变 → 自动隐藏
    } finally {
      vi.useRealTimers()
    }
  })

  it('stage 失败（剪贴板被占用）→ copyFailed 保持可见、不武装隐藏、HOTP 不推进', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      await seedVault([HOTP])
      tauriMock.on('stage_clipboard_write', () => { throw new Error('clipboard busy') })
      const wrapper = await mountMini()
      const before = await waitForCode(wrapper, (c) => /^\d{6}$/.test(c))
      await wrapper.find('[data-test="copy"]').trigger('click')
      await flushPromises()
      expect(wrapper.text()).toContain('复制失败：剪贴板被占用')
      // 面板装配后沿旧 v-else 链语义：失败横幅 3s 复位期间列表区被横幅顶替——推进越过复位点
      // （fake 时间确定性，不依赖 shouldAdvanceTime 的真实时间泄漏），再验未隐藏与 HOTP 不推进
      await vi.advanceTimersByTimeAsync(3100)
      await flushPromises()
      expect(tauriMock.window.hide).not.toHaveBeenCalled() // 失败保持窗口可见
      expect(wrapper.find('[data-test="item"]').attributes('data-code')).toBe(before) // 码未复制成功 → counter 不推进
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('聚焦重载与卸载（B10.34）', () => {
  it('聚焦重载失败（fs 异常）→ 保留旧数据（只读窗口无写盘风险）', async () => {
    await seedVault([TOTP])
    const wrapper = await mountMini()
    expect(wrapper.find('[data-test="item"]').exists()).toBe(true)
    tauriMock.fs.mkdir.mockRejectedValue(new Error('fs gone'))
    tauriMock.emitFocusChanged(true) // mini 显示即聚焦 → 整链重建 store
    await flushPromises()
    expect(wrapper.find('[data-test="item"]').exists()).toBe(true) // 重载失败保留旧数据
  })

  it('卸载清理：force-lock 监听随组件作用域移除', async () => {
    await seedVault([])
    const wrapper = await mountMini()
    expect(tauriMock.listenerCount('force-lock')).toBe(1)
    wrapper.unmount()
    expect(tauriMock.listenerCount('force-lock')).toBe(0)
  })
})

describe('force-lock 联动（释放策略暂停/销毁）', () => {
  it('force-lock → 锁定提示；锁库路径 onLocked → 清 Rust DEK 暂存槽（与主窗同口径）', async () => {
    await seedVault([TOTP])
    const wrapper = await mountMini()
    expect(wrapper.text()).not.toContain('主窗口解锁后此窗口可用')
    tauriMock.emit('force-lock', null)
    await flushPromises()
    expect(wrapper.text()).toContain('主窗口解锁后此窗口可用')
    expect(tauriMock.calls('clear_stashed_dek')).toHaveLength(1)
  })
})

describe('mini 跟随主窗解锁（①槽 peek 自动恢复 + mini-session 事件联动）', () => {
  /** 加密库种子（复用 force-lock 前置）：返回盘上密文的真实 DEK base64（等价主窗解锁后写入 mini 槽的值） */
  async function seedEncryptedVault(entries: OtpEntry[]): Promise<string> {
    const vault = await seedVault(entries)
    const { security, encrypted, dek } = await setupVaultEncryption(JSON.stringify(vault), 'pw-test')
    files.set(`${VAULT_KEY}.json`, JSON.stringify(encrypted))
    files.set(`${SECURITY_KEY}.json`, JSON.stringify(security))
    return bytesToBase64(dek)
  }

  it('boot 传 dekPersist（peek_mini_dek）；槽有 DEK 时 initStore 自动解锁渲染条目', async () => {
    const dekB64 = await seedEncryptedVault([TOTP])
    tauriMock.onReturn('peek_mini_dek', dekB64)
    const wrapper = await mountMini()
    // 槽 DEK 解密走 WebCrypto 线程池（宏任务）：flushPromises 不够，轮询等 boot 链完全收敛
    // （mini-session/force-lock 监听注册 + 槽 DEK 解锁渲染）——不等会让未收敛链跨用例晚注册（僵尸监听）
    await vi.waitFor(() => {
      expect(tauriMock.listenerCount('mini-session')).toBe(1) // 主窗解锁态联动已接线
      expect(wrapper.find('[data-test="item"]').exists()).toBe(true) // 槽 DEK 解密成功 → 条目渲染
    })
    expect(tauriMock.calls('peek_mini_dek')).toHaveLength(2) // boot 经 dekPersist.get peek + Minor-1 赋值后复查 peek
    expect(wrapper.text()).not.toContain('主窗口解锁后此窗口可用') // 锁定文案未出现
  })

  it('mini-session locked:true → store.lock()（清 Rust 暂存槽）；locked:false 且锁定中 → 重载再 peek 自动解锁', async () => {
    const dekB64 = await seedEncryptedVault([TOTP]) // 槽空（peek 缺省 null）→ boot 后锁定
    const wrapper = await mountMini()
    expect(wrapper.text()).toContain('主窗口解锁后此窗口可用')
    expect(tauriMock.calls('peek_mini_dek')).toHaveLength(1)
    // 锁定路径无解密不跨宏任务，但先等监听就绪防时序误判（同上）
    await vi.waitFor(() => expect(tauriMock.listenerCount('mini-session')).toBe(1))
    tauriMock.emit('mini-session', { locked: true }) // 主窗锁库广播 → mini 跟随锁定
    await flushPromises()
    expect(tauriMock.calls('clear_stashed_dek')).toHaveLength(1) // lock() 路径 onLocked 清暂存槽
    expect(wrapper.find('[data-test="item"]').exists()).toBe(false)
    tauriMock.onReturn('peek_mini_dek', dekB64) // 主窗解锁：同一库 DEK 入 mini 槽
    tauriMock.emit('mini-session', { locked: false }) // 通知 mini 重载
    await flushPromises()
    expect(tauriMock.calls('peek_mini_dek').length).toBeGreaterThanOrEqual(2) // load 重建再 peek
    await vi.waitFor(() => expect(wrapper.find('[data-test="item"]').exists()).toBe(true)) // 重载经槽 DEK 自动解锁
    expect(wrapper.text()).not.toContain('主窗口解锁后此窗口可用')
  })

  it('Minor-1：在途 load 期间主窗锁定（槽清空）→ boot 后复查槽并锁定本窗，闭合明文窄窗', async () => {
    const dekB64 = await seedEncryptedVault([TOTP])
    // peek 序列：首次（boot initStore）返回 DEK → 解锁；其后 null（主窗在 load 完成前已锁定清槽，
    // locked:true 事件只锁到旧 store——无后续事件来锁本 store，终审 Minor-1 的明文窄窗序列）
    let n = 0
    tauriMock.on('peek_mini_dek', () => (n++ === 0 ? dekB64 : null))
    const wrapper = await mountMini()
    // 复查逻辑：boot 赋值后二次 peek 发现槽空 → lock()（→ onLocked 清暂存槽）
    await vi.waitFor(() => expect(tauriMock.calls('clear_stashed_dek').length).toBeGreaterThanOrEqual(1))
    expect(tauriMock.calls('peek_mini_dek').length).toBeGreaterThanOrEqual(2) // boot peek + 赋值后复查 peek
    expect(wrapper.find('[data-test="item"]').exists()).toBe(false) // 不持明文
    expect(wrapper.text()).toContain('主窗口解锁后此窗口可用')
  })

  it('I2：boot 复查通过后、load 完成前主窗锁定 → locked:true 事件不再丢失，mini 即时收敛锁定', async () => {
    const dekB64 = await seedEncryptedVault([TOTP])
    tauriMock.onReturn('peek_mini_dek', dekB64) // boot peek 与复查 peek 期间槽尚有 DEK（复查通过）
    files.set('icons.json', '{}') // 图标仓有存量：确保 iconStore.init 真正走到 readTextFile（门控点可达）
    // 门控 icons.json（iconStore.init 首读）：把首 boot 挂在复查之后的最后一个 await 段
    // ——此刻 store.value 已赋值、监听已注册（I2 修复后先于 load 注册）、槽复查已通过
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    let gated = false
    ;(tauriMock.fs.readTextFile as Mock).mockImplementation(async (p: string) => {
      if (p === 'icons.json' && !gated) {
        gated = true
        await gate
      }
      return files.get(p) ?? ''
    })
    const wrapper = await mountMini()
    await vi.waitFor(() => {
      expect(tauriMock.listenerCount('mini-session')).toBe(1) // 监听先于 load 注册（I2 修复点）
      expect((tauriMock.fs.readTextFile as Mock).mock.calls.some(([p]) => p === 'icons.json')).toBe(true)
    })
    // 主窗锁定：清槽 + 广播 locked:true（旧排序下监听未注册，事件在此丢失 → mini 滞留明文）
    tauriMock.onReturn('peek_mini_dek', null)
    tauriMock.emit('mini-session', { locked: true })
    await flushPromises()
    release()
    await flushPromises()
    expect(tauriMock.calls('clear_stashed_dek').length).toBeGreaterThanOrEqual(1) // lock() → onLocked
    expect(wrapper.text()).toContain('主窗口解锁后此窗口可用') // 收敛为锁定态
    expect(wrapper.find('[data-test="item"]').exists()).toBe(false) // 无明文残留
  })

  it('I1：主窗改口令（rotateDek=true 轮换）槽更新 → mini 聚焦重建仍解锁（旧 DEK 残留场景闭合）', async () => {
    // 内联种子（需留明文库 JSON 供轮换重加密）：加密库 + 空 mini 槽 → boot 锁定
    const vault = addEntry(await seedVault([]), TOTP)
    const plain = JSON.stringify(vault)
    const { security, encrypted, dek: dek1 } = await setupVaultEncryption(plain, 'pw-test')
    files.set(`${VAULT_KEY}.json`, JSON.stringify(encrypted))
    files.set(`${SECURITY_KEY}.json`, JSON.stringify(security))
    const wrapper = await mountMini()
    await vi.waitFor(() => expect(tauriMock.listenerCount('mini-session')).toBe(1))
    expect(wrapper.text()).toContain('主窗口解锁后此窗口可用')
    // 主窗解锁：DEK1 入槽 + locked:false 广播 → mini 重载自动解锁
    tauriMock.onReturn('peek_mini_dek', bytesToBase64(dek1))
    tauriMock.emit('mini-session', { locked: false })
    await vi.waitFor(() => expect(wrapper.find('[data-test="item"]').exists()).toBe(true))
    // 主窗改口令（rotateDek=true）：全库以新 DEK 重加密写盘 + mini 槽更新为新 DEK（I1 修复：
    // 主窗 changePassphrase 提交点触发 onUnlock → publishMiniUnlock 覆盖槽中旧 DEK）
    const rotated = await changeVaultPassphrase(
      JSON.parse(files.get(`${SECURITY_KEY}.json`)!) as SecuritySettings,
      dek1, 'pw-2', { rotateDek: true },
    )
    files.set(`${VAULT_KEY}.json`, JSON.stringify(await encryptVaultWithDek(rotated.dek!, plain)))
    files.set(`${SECURITY_KEY}.json`, JSON.stringify(rotated.security))
    tauriMock.onReturn('peek_mini_dek', bytesToBase64(rotated.dek!))
    tauriMock.emit('mini-session', { locked: false }) // publishMiniUnlock 广播（mini 已解锁 → 不重载）
    tauriMock.emitFocusChanged(true) // 用户聚焦 mini → 整链重建 store，peek 到新 DEK
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="item"]').exists()).toBe(true) // 新 DEK 解密成功仍解锁
      expect(wrapper.text()).not.toContain('主窗口解锁后此窗口可用')
    })
  })
})

describe('mini 标题区 chrome（spec §1.4/§1.5）', () => {
  it('pin 按钮切换：invoke mini_pin_set(pinned) 且 aria-pressed 同步', async () => {
    const w = await mountMini()
    const btn = w.find('[data-test="pin-btn"]')
    expect(btn.attributes('aria-pressed')).toBe('false')
    await btn.trigger('click')
    await flushPromises()
    expect(tauriMock.invoke).toHaveBeenCalledWith('mini_pin_set', { pinned: true })
    expect(w.find('[data-test="pin-btn"]').attributes('aria-pressed')).toBe('true')
  })

  it('pinned 时复制后不自动隐藏；取消 pin 恢复', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      await seedVault([TOTP])
      const w = await mountMini()
      await waitForCode(w, (c) => /^\d{6}$/.test(c))
      await w.find('[data-test="pin-btn"]').trigger('click') // pin
      await flushPromises()
      await w.find('[data-test="copy"]').trigger('click')
      await flushPromises()
      await vi.advanceTimersByTimeAsync(600)
      await flushPromises()
      expect(tauriMock.window.hide).not.toHaveBeenCalled() // pinned 抑制自动隐藏
      await w.find('[data-test="pin-btn"]').trigger('click') // 取消 pin
      await flushPromises()
      await w.find('[data-test="copy"]').trigger('click')
      await flushPromises()
      await vi.advanceTimersByTimeAsync(600)
      await flushPromises()
      expect(tauriMock.window.hide).toHaveBeenCalledTimes(1) // 取消 pin 后恢复自动隐藏
    } finally {
      vi.useRealTimers()
    }
  })

  it('收起按钮：调用 window.hide', async () => {
    const w = await mountMini()
    await w.find('[data-test="hide-btn"]').trigger('click')
    expect(tauriMock.window.hide).toHaveBeenCalled()
  })
})

describe('mini load 失败暴露（spec §2.2）', () => {
  it('boot 失败：横幅 role=alert 渲染且 console.error 收到错误对象', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    ;(tauriMock.fs.readTextFile as Mock).mockRejectedValueOnce(new Error('disk boom'))
    const w = await mountMini()
    expect(w.find('[role="alert"]').exists()).toBe(true)
    expect(w.text()).toContain('加载失败')
    expect(errSpy).toHaveBeenCalledWith('[mini] load failed:', expect.any(Error))
    errSpy.mockRestore()
  })
})

describe('mini 搜索框（spec §1.2，经 QuickCodesPanel 冻结行）', () => {
  it('输入过滤列表：命中 issuer 子串；清空恢复；无命中显示 searchEmpty 文案', async () => {
    await seedVault([TOTP, HOTP]) // 种子两条（GitHub / Legacy），复用文件既有种子
    const w = await mountMini()
    const input = w.find('.quick-codes-panel .frozen input[type="search"]')
    await input.setValue('git')
    expect(w.findAll('[data-test="item"]')).toHaveLength(1)
    await input.setValue('zzz-no-match')
    expect(w.findAll('[data-test="item"]')).toHaveLength(0)
    expect(w.text()).toContain('无匹配条目')
    await input.setValue('')
    expect(w.findAll('[data-test="item"]')).toHaveLength(2)
  })
})

describe('QuickCodesPanel 装配与标签筛选（P4 Task 2）', () => {
  const A: OtpEntry = { ...TOTP, uuid: 'ta', issuer: 'Alpha', tagIds: ['t1'] }
  const B: OtpEntry = { ...TOTP, uuid: 'tb', issuer: 'Beta', tagIds: ['t2'] }
  const TAGS: Tag[] = [{ id: 't1', name: '工作' }, { id: 't2', name: '个人' }]

  it('装配结构：搜索行入面板 .frozen 冻结容器；有标签时筛选行出现且无管理钮；条目经面板渲染', async () => {
    await seedVault([A, B], TAGS)
    const w = await mountMini()
    expect(w.find('.quick-codes-panel').exists()).toBe(true)
    expect(w.find('.quick-codes-panel .frozen input[type="search"]').exists()).toBe(true)
    expect(w.find('.quick-codes-panel .tag-filter-row').exists()).toBe(true)
    expect(w.find('button.manage-btn').exists()).toBe(false) // 快速窗语义：无管理入口
    expect(w.findAll('[data-test="item"]')).toHaveLength(2)
  })

  it('tag 过滤编排（any）：chip 选中只留命中条目；选择不持久化（快速窗会话语义，不写 settings）；清空恢复', async () => {
    await seedVault([A, B], TAGS)
    const w = await mountMini()
    // chips 序：全部 / 个人(t2) / 工作(t1)（名称 zh 字母序，同面板测试口径）
    await w.findAll('button.md-chip')[2]!.trigger('click') // 选中 t1
    await flushPromises()
    const items = w.findAll('[data-test="item"]')
    expect(items).toHaveLength(1)
    expect(items[0]!.text()).toContain('Alpha')
    // 选择不触发 commitSettings：settings 原子写落 settings.json.tmp（mock rename no-op），
    // 无 .tmp 即无写盘——快速窗会话语义
    expect(files.get('settings.json.tmp')).toBeUndefined()
    await w.findAll('button.md-chip')[2]!.trigger('click') // 取消 → 直通
    await flushPromises()
    expect(w.findAll('[data-test="item"]')).toHaveLength(2)
  })

  it('tagMode 走全局 settings：选中≥2 后模式钮翻转 any→all（无条目同带两标签 → searchEmpty 空态）；commitSettings 落盘且选中集合仍不持久化', async () => {
    await seedVault([A, B], TAGS)
    const w = await mountMini()
    await w.findAll('button.md-chip')[1]!.trigger('click') // 个人 t2
    await w.findAll('button.md-chip')[2]!.trigger('click') // 工作 t1
    await flushPromises()
    expect(w.findAll('[data-test="item"]')).toHaveLength(2) // any：各带其一都命中
    await w.find('button.mode-toggle').trigger('click')
    await flushPromises()
    expect(w.findAll('[data-test="item"]')).toHaveLength(0) // all：无条目同带两标签
    expect(w.text()).toContain('无匹配条目') // 标签过滤后空列表落 noMatchText（语义近似可接受）
    const saved = JSON.parse(files.get('settings.json.tmp')!) as { tagFilterMode?: string; lastTagFilterIds?: string[] } // settings 原子写落 .tmp（mock rename no-op）
    expect(saved.tagFilterMode).toBe('all') // 模式全局共享（CodesPage 同款 commitSettings）
    expect(saved.lastTagFilterIds).toEqual([]) // 快速窗选择不持久化
  })

  it('悬空 tag 清理：主窗删除标签后聚焦重载 → 选中集合剔除悬空 id（CodesPage 同款 watch），列表恢复全量', async () => {
    await seedVault([A, B], TAGS)
    const w = await mountMini()
    await w.findAll('button.md-chip')[2]!.trigger('click') // 选中 t1 → 只剩 Alpha
    await flushPromises()
    expect(w.findAll('[data-test="item"]')).toHaveLength(1)
    // 主窗删除标签 t1 落盘，mini 聚焦触发整链重载（store 重建）
    const vault = JSON.parse(files.get(`${VAULT_KEY}.json`)!) as Vault
    vault.tags = vault.tags.filter((t) => t.id !== 't1')
    files.set(`${VAULT_KEY}.json`, JSON.stringify(vault))
    tauriMock.emitFocusChanged(true)
    // 清理后选中集合为空 → 过滤直通；若未清理则 t1 悬空仍命中 Alpha（Beta 隐藏）可区分
    await vi.waitFor(() => expect(w.findAll('[data-test="item"]')).toHaveLength(2))
  })
})

describe('mini-ready 首屏就绪信号（spec §2.4）', () => {
  it('首次 load 完成后 emit mini-ready（spec §2.4）', async () => {
    await mountMini()
    expect(tauriMock.event.emit).toHaveBeenCalledWith('mini-ready')
  })

  it('load 失败也发（成败都发，Rust 重建路径不被前端失败堵死 show）', async () => {
    ;(tauriMock.fs.readTextFile as Mock).mockRejectedValue(new Error('disk boom'))
    await mountMini()
    expect(tauriMock.event.emit).toHaveBeenCalledWith('mini-ready')
  })
})
