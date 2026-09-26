/**
 * securityPlatform 工厂直测（P4，盘点 B6.22-24 装配层缺口）：computed 求值与成员接线、
 * dpapi OS 解锁通道（32B 双层校验/移除后 keyring 清理 best-effort）、F3 DEK 包裹迁移幂等与
 * 失败仅告警、passkey(PRF) 绑定链（随机盐/exclude/取消 false）、lockPrefs unsupported 平台矩阵。
 * '@totp/ui' 局部替换（importOriginal）：WebAuthn 创建交互不可在测试环境发生，替换为可编程桩。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { shallowRef } from 'vue'
import { tauriMock } from '../test/mocks/tauri'
import { echoTr, fakeStore } from '../test/helpers/fakes'
import { createSecurityPlatform } from '../src/securityPlatform'
import { desktopUaFlags } from '../src/unlockNaming'

const { createPrfCredentialMock, prfSupportedMock } = vi.hoisted(() => ({
  createPrfCredentialMock: vi.fn(),
  prfSupportedMock: vi.fn(async () => true),
}))
vi.mock('@tauri-apps/api/core', async () => (await import('../test/mocks/tauri')).invokeModule())
vi.mock('@totp/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@totp/ui')>()
  return { ...actual, createPrfCredential: createPrfCredentialMock, prfSupported: prfSupportedMock }
})

const UA_WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126'
const UA_LINUX = 'Mozilla/5.0 (X11; Linux x86_64) Chrome/126'
const DEK = new Uint8Array(32).fill(7)

function makeFactory(ua = UA_WIN, storeOverrides: Record<string, unknown> = {}) {
  const store = fakeStore(storeOverrides)
  // shallowRef 宿主：与 App.vue store 浅包装同构（computed 对 getStore 的读取须可失效重算）
  const holder = shallowRef<typeof store | null>(store)
  const namingCalls = vi.fn(() => ({ prfLabel: 'Windows Hello (Passkey)', osAutoLabel: '桌面解锁名' }))
  const f = createSecurityPlatform({ getStore: () => holder.value, tr: echoTr, naming: namingCalls, flags: desktopUaFlags(ua), ua })
  return { f, store, holder, namingCalls }
}

beforeEach(() => {
  tauriMock.reset()
  createPrfCredentialMock.mockReset()
  prfSupportedMock.mockClear()
})

describe('securityPlatform computed（store 未就绪 null；成员接线）', () => {
  it('store 未就绪 → null（SecurityCard 整卡不渲染）；就绪后非 null 且 naming 求值', () => {
    const { f, holder, store, namingCalls } = makeFactory()
    holder.value = null
    expect(f.platform.value).toBeNull()
    expect(namingCalls).not.toHaveBeenCalled() // 惰性：未求值不取词
    holder.value = store
    const platform = f.platform.value
    expect(platform).not.toBeNull()
    expect(platform!.unlockNaming).toEqual({ prfLabel: 'Windows Hello (Passkey)', osAutoLabel: '桌面解锁名' })
    expect(namingCalls).toHaveBeenCalled() // computed 求值期调用（调用时取词，locale 联动机制）
  })

  it('security ops 闭包绑 store：enable/disable/changePassphrase（opts 透传）', () => {
    const { f, store } = makeFactory()
    const sec = f.platform.value!.security!
    expect(sec.locked).toBe(store.locked) // 同一 ref（浅包装语义）
    expect(sec.hasEncryption).toBe(store.hasEncryption)
    void sec.enableEncryption('pw')
    expect(store.enableEncryption).toHaveBeenCalledWith('pw')
    void sec.disableEncryption()
    expect(store.disableEncryption).toHaveBeenCalled()
    const opts = { rotateDek: false, profile: 'fast' as const }
    void sec.changePassphrase('new', opts)
    expect(store.changePassphrase).toHaveBeenCalledWith('new', opts) // 审查 I3/I5：档位切换不误触发全库轮换
  })

  it('kdfProfile/passwordChangedAt 读 securitySettings（缺省 balanced/null）', async () => {
    const { f, store } = makeFactory()
    const sec = f.platform.value!.security!
    expect(sec.kdfProfile.value).toBe('balanced')
    expect(sec.passwordChangedAt.value).toBeNull()
    store.securitySettings.value = { profile: 'paranoid', passwordChangedAt: 12345 }
    await Promise.resolve()
    expect(sec.kdfProfile.value).toBe('paranoid')
    expect(sec.passwordChangedAt.value).toBe(12345)
  })

  it('passkey.sources 映射 credentialId；prfSupported 委托', async () => {
    const { f, store } = makeFactory()
    store.prfSources.value = [{ credentialId: 'abc' }, { credentialId: 'def' }]
    const sec = f.platform.value!.security!
    expect(sec.passkey!.sources.value).toEqual([{ credentialId: 'abc' }, { credentialId: 'def' }])
    await expect(sec.passkey!.prfSupported()).resolves.toBe(true)
  })

  it('passkey.add：取消 → false 不落盘；成功 → 同盐绑定 addPrfSourceOp（32B 盐/exclude 现有凭据）', async () => {
    const { f, store } = makeFactory()
    store.prfSources.value = [{ credentialId: 'existing' }]
    const sec = f.platform.value!.security!.passkey!
    createPrfCredentialMock.mockResolvedValue(null)
    expect(await sec.add()).toBe(false)
    expect(store.addPrfSourceOp).not.toHaveBeenCalled()
    const created = { credentialId: 'cred-1', prfOutput: new Uint8Array(32).fill(3) }
    createPrfCredentialMock.mockResolvedValue(created)
    expect(await sec.add()).toBe(true)
    const [credentialId, prfOutput, salt] = store.addPrfSourceOp.mock.calls[0] as unknown as [string, Uint8Array, Uint8Array]
    expect(credentialId).toBe('cred-1')
    expect(prfOutput).toBe(created.prfOutput) // 解锁期以同一 prfOutput 复现
    expect(salt).toHaveLength(32) // 随机 32B 盐：注册/权威 get/解锁期同一盐
    const callArgs = createPrfCredentialMock.mock.calls[0]!
    expect(callArgs[0]).toBe('TOTP 验证码工具')
    expect(callArgs[2]).toEqual({ excludeCredentialIds: ['existing'] })
  })

  it('passkey.remove → store.removePrfSourceOp', async () => {
    const { f, store } = makeFactory()
    await f.platform.value!.security!.passkey!.remove('abc')
    expect(store.removePrfSourceOp).toHaveBeenCalledWith('abc')
  })

  it('剪贴板开关：clipboardClearEnabled 读 settings；setClipboardClear 写 + commitSettings', async () => {
    const { f, store } = makeFactory()
    const platform = f.platform.value!
    expect(platform.clipboardClearEnabled.value).toBe(store.settings.clipboardClearEnabled)
    await platform.setClipboardClear(true)
    expect(store.settings.clipboardClearEnabled).toBe(true)
    expect(store.commitSettings).toHaveBeenCalled()
  })

  it('lockPrefs：三字段 get 整读、set 整写 + commitSettings；unsupported 按 UA（win=重启 / 非 win=重启+系统锁）', () => {
    const { f, store } = makeFactory()
    store.settings.lockOnRestart = true
    store.settings.lockIdleMinutes = 5
    store.settings.lockOnSystemLock = true
    const lp = f.platform.value!.lockPrefs!
    expect(lp.get()).toEqual({ lockOnRestart: true, lockIdleMinutes: 5, lockOnSystemLock: true })
    lp.set({ lockOnRestart: false, lockIdleMinutes: 30, lockOnSystemLock: false })
    expect(store.settings.lockIdleMinutes).toBe(30)
    expect(store.commitSettings).toHaveBeenCalled()
    expect(lp.unsupported).toEqual(['lockOnRestart']) // Windows：系统锁屏事件源存在（WTS）
    const linux = makeFactory(UA_LINUX)
    expect(linux.f.platform.value!.lockPrefs!.unsupported).toEqual(['lockOnRestart', 'lockOnSystemLock'])
  })
})

describe('dpapi（OS 自动解锁通道）', () => {
  it('label getter 调用 naming 取词，null 回退 tr(desktop.unlockWindows)；techSuffix 按 flags', () => {
    const store = fakeStore()
    let osAutoLabel: string | null = '桌面解锁名'
    const f = createSecurityPlatform({
      getStore: () => store, tr: echoTr,
      naming: () => ({ prfLabel: 'x', osAutoLabel }),
      flags: desktopUaFlags(UA_WIN), ua: UA_WIN,
    })
    expect(f.dpapi.label).toBe('桌面解锁名')
    osAutoLabel = null
    expect(f.dpapi.label).toBe('desktop.unlockWindows') // ?? 回退防未来分支 null
    expect(f.dpapi.techSuffix).toBe('（DPAPI）')
    const mac = createSecurityPlatform({ getStore: () => store, tr: echoTr, naming: () => ({ prfLabel: 'x', osAutoLabel: null }), flags: desktopUaFlags('Mac OS X'), ua: 'Mac OS X' })
    expect(mac.dpapi.techSuffix).toBe('（Keychain）')
  })

  it('source/getCurrentDek 动态读 store；protect/unprotect 委托 os_auto_*（32B 校验前端先拒）', async () => {
    const { f, store } = makeFactory()
    expect(f.dpapi.source.value).toBeNull()
    expect(f.dpapi.getCurrentDek()).toBeNull()
    store.dpapiSource.value = { wrappedDekD: 'd3JhcA==' }
    store.getCurrentDek.mockReturnValue(DEK)
    expect(f.dpapi.source.value).toEqual({ wrappedDekD: 'd3JhcA==' })
    expect(f.dpapi.getCurrentDek()).toEqual(DEK)
    tauriMock.onReturn('os_auto_protect', 'd3JhcHBlZA==')
    expect(await f.dpapi.protect(DEK)).toBe('d3JhcHBlZA==')
    expect(tauriMock.calls('os_auto_protect')[0]?.args).toEqual({ dataB64: expect.any(String) })
    tauriMock.onReturn('os_auto_unprotect', Buffer.from(new Uint8Array(32).fill(9)).toString('base64'))
    expect(await f.dpapi.unprotect('wrap')).toHaveLength(32)
    await expect(f.dpapi.protect(new Uint8Array(31))).rejects.toThrow('DEK must be 32 bytes')
    expect(tauriMock.calls('os_auto_protect')).toHaveLength(1) // 无效长度不打到 OS 边界
    // 解包侧后置兜底：Rust 返回非 32B → 前端拒绝（双层防御第二层）
    tauriMock.onReturn('os_auto_unprotect', Buffer.from(new Uint8Array(31)).toString('base64'))
    await expect(f.dpapi.unprotect('short-wrap')).rejects.toThrow('DEK must be 32 bytes')
  })

  it('add/remove → store op；remove 后 best-effort os_auto_forget（失败仅告警不中断）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { f, store } = makeFactory()
    await f.dpapi.add('wrappedDekD-x')
    expect(store.addDpapiSourceOp).toHaveBeenCalledWith('wrappedDekD-x')
    tauriMock.on('os_auto_forget', () => { throw new Error('windows stub') }) // Windows 报错桩
    await f.dpapi.remove()
    expect(store.removeDpapiSourceOp).toHaveBeenCalled()
    await vi.waitFor(() => expect(warnSpy).toHaveBeenCalledWith('[desktop] keyring 条目清理失败', expect.any(Error)))
    warnSpy.mockRestore()
  })

  it('add/remove 在 store 未就绪时「数据尚未就绪」', async () => {
    const { f, holder } = makeFactory()
    holder.value = null
    await expect(f.dpapi.add('x')).rejects.toThrow('数据尚未就绪')
    await expect(f.dpapi.remove()).rejects.toThrow('数据尚未就绪')
  })
})

describe('migrateDekWrapToEntropyBound（F3 幂等/best-effort）', () => {
  const LEGACY = Buffer.from('legacy-32-bytes-aaaaaaaaaaaaaaaa').toString('base64')
  const V2 = Buffer.concat([new TextEncoder().encode('TOTPDEK1'), new Uint8Array(32).fill(1)]).toString('base64')

  it('锁定/未绑定/无 DEK/未就绪 → 短路不动作', async () => {
    const { f, store, holder } = makeFactory()
    store.getCurrentDek.mockReturnValue(DEK)
    store.dpapiSource.value = { wrappedDekD: LEGACY }
    store.locked.value = true
    await f.migrateDekWrapToEntropyBound()
    expect(store.addDpapiSourceOp).not.toHaveBeenCalled()
    store.locked.value = false
    store.dpapiSource.value = null
    await f.migrateDekWrapToEntropyBound()
    expect(store.addDpapiSourceOp).not.toHaveBeenCalled()
    store.dpapiSource.value = { wrappedDekD: LEGACY }
    store.getCurrentDek.mockReturnValue(null)
    await f.migrateDekWrapToEntropyBound()
    expect(store.addDpapiSourceOp).not.toHaveBeenCalled()
    holder.value = null
    await f.migrateDekWrapToEntropyBound()
    expect(store.addDpapiSourceOp).not.toHaveBeenCalled()
  })

  it('已是 v2 熵绑定格式 → 幂等跳过；旧格式 + 解锁态 → protect 重包并 add', async () => {
    const { f, store } = makeFactory()
    store.getCurrentDek.mockReturnValue(DEK)
    store.dpapiSource.value = { wrappedDekD: V2 }
    await f.migrateDekWrapToEntropyBound()
    expect(store.addDpapiSourceOp).not.toHaveBeenCalled()
    store.dpapiSource.value = { wrappedDekD: LEGACY }
    tauriMock.onReturn('os_auto_protect', 'd3JhcHBlZC12Mg==')
    await f.migrateDekWrapToEntropyBound()
    expect(store.addDpapiSourceOp).toHaveBeenCalledWith('d3JhcHBlZC12Mg==')
  })

  it('重包失败（OS 通道拒绝）→ 仅告警不抛（Rust 32B 兜底仍可解锁，下次重试）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { f, store } = makeFactory()
    store.getCurrentDek.mockReturnValue(DEK)
    store.dpapiSource.value = { wrappedDekD: LEGACY }
    tauriMock.on('os_auto_protect', () => { throw new Error('dpapi denied') })
    await expect(f.migrateDekWrapToEntropyBound()).resolves.toBeUndefined()
    await vi.waitFor(() => expect(warnSpy).toHaveBeenCalledWith('[migrate] DEK 包裹升级为应用熵绑定格式失败（旧格式仍可解锁，下次重试）', expect.any(Error)))
    warnSpy.mockRestore()
  })
})
