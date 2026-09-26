/**
 * MiniApp 挂载冒烟（P4，盘点 B10.33-36 双窗口缺口）：windowId='mini' 独立 store（与 main 隔离）、
 * 未加密可读/加密恒锁定提示、复制编排（HOTP 复制旧 counter 码→递增→500ms 自动隐藏）、
 * stage 失败→copyFailed 保持可见且 HOTP 不推进、force-lock 联动、mini 不监听回注事件。
 * Tauri 边界走 test/mocks/tauri（fs 以内存 map 供给）；store 走真实 createTauriFs+createVueStore
 * （createVueStore 局部包装仅记录 windowId 实参）；i18n 用真实 createAppI18n（断言 zh 文案）。
 */
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent } from 'vue'
import {
  addEntry, createVault, setupVaultEncryption, SECURITY_KEY, VAULT_KEY,
  type OtpEntry, type Vault,
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

async function seedVault(entries: OtpEntry[]): Promise<Vault> {
  let vault: Vault = createVault()
  for (const e of entries) vault = addEntry(vault, e)
  files.set(`${VAULT_KEY}.json`, JSON.stringify(vault))
  return vault
}

async function mountMini() {
  const wrapper = mount(MiniApp, { global: { stubs: { OtpListItem: OtpListItemStub } } })
  await flushPromises()
  return wrapper
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
    expect(wrapper.text()).toContain('加密启用后迷你窗不可用，请在主窗口解锁使用')
    expect(wrapper.find('[data-test="item"]').exists()).toBe(false)
  })
})

describe('复制编排（B10.36）', () => {
  /** 确定性等待 useOtpCodes 取码：推进 fake timers 驱动 1s tick 直至谓词满足 */
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
      await vi.advanceTimersByTimeAsync(1500) // 越过 500ms 自动隐藏窗口
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
    expect(wrapper.text()).not.toContain('加密启用后迷你窗不可用')
    tauriMock.emit('force-lock', null)
    await flushPromises()
    expect(wrapper.text()).toContain('加密启用后迷你窗不可用，请在主窗口解锁使用')
    expect(tauriMock.calls('clear_stashed_dek')).toHaveLength(1)
  })
})
