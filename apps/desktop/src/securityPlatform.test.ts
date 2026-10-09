/**
 * securityPlatform 工厂直测（P4，盘点 B6.22-24 装配层缺口）：computed 求值与成员接线、
 * dpapi OS 解锁通道（32B 双层校验/移除后 keyring 清理 best-effort）、F3 DEK 包裹迁移幂等与
 * 失败仅告警、passkey(PRF) 绑定链（随机盐/exclude/取消 false）、lockPrefs unsupported 平台矩阵。
 * '@totp/ui' 局部替换（importOriginal）：WebAuthn 创建交互不可在测试环境发生，替换为可编程桩。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
    // vitest 5（tinyspy 3）起重复 spyOn 同一目标返回同一 mock 实例：mockRestore 会连
    // I2 describe 的模块级 warnSpy 一并卸载，此处只清调用记录、保留打桩
    warnSpy.mockClear()
  })

  it('add/remove 在 store 未就绪时「数据尚未就绪」', async () => {
    const { f, holder } = makeFactory()
    holder.value = null
    await expect(f.dpapi.add('x')).rejects.toThrow('数据尚未就绪')
    await expect(f.dpapi.remove()).rejects.toThrow('数据尚未就绪')
  })
})

describe('abeOps（ABE 服务宿主通道，P6 T4）', () => {
  it('supported 按 UA（win=true/linux=false）；非 Windows 全操作短路不打 invoke，兜底返回', async () => {
    const { f } = makeFactory(UA_LINUX)
    expect(f.abe.supported).toBe(false)
    expect(await f.abe.status()).toBeNull()
    expect(await f.abe.bind()).toEqual({ ok: false, reason: 'failed', detail: '当前平台不支持 ABE 服务' }) // 判别联合兜底（Task 11）
    expect(await f.abe.wrap(new Uint8Array(32))).toBe(false) // C1 终审：wrap 同口径短路
    expect(await f.abe.remove()).toEqual({ ok: false, message: expect.any(String) })
    expect(tauriMock.calls()).toHaveLength(0) // invoke 零触达
  })

  it('status：invoke 结果透传；异常/空返回收敛 null（管道不可达非异常路径）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { f } = makeFactory()
    expect(f.abe.supported).toBe(true)
    tauriMock.onReturn('abe_status', {
      installed: true,
      matchesCaller: true,
      boundPath: 'C:\\x\\TotpTools.exe',
      version: '1.2.3',
    })
    expect(await f.abe.status()).toEqual({
      installed: true,
      matchesCaller: true,
      boundPath: 'C:\\x\\TotpTools.exe',
      version: '1.2.3',
    })
    // 服务不可达（Rust 不会 reject，防御兜底）
    tauriMock.on('abe_status', () => { throw new Error('pipe gone') })
    expect(await f.abe.status()).toBeNull()
    tauriMock.onReturn('abe_status', null)
    expect(await f.abe.status()).toBeNull()
    warnSpy.mockClear()
  })

  it('bind：成功 {ok:true}；Err 前缀协议解析判别联合（cancelled/failed/notready），无前缀兜底 failed 不抛（Task 11）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { f } = makeFactory()
    tauriMock.onReturn('abe_bind', { ok: true })
    expect(await f.abe.bind()).toEqual({ ok: true })
    // 前缀三态（Task 10 协议）：真 Tauri 通道 Err(String) reject 即字符串原样带前缀
    tauriMock.on('abe_bind', () => { throw 'cancelled:UAC 提权被用户取消（exit -1）' })
    expect(await f.abe.bind()).toEqual({ ok: false, reason: 'cancelled', detail: 'UAC 提权被用户取消（exit -1）' })
    tauriMock.on('abe_bind', () => { throw 'failed:服务启动未完成（可能被安全软件拦截）' })
    expect(await f.abe.bind()).toEqual({ ok: false, reason: 'failed', detail: '服务启动未完成（可能被安全软件拦截）' })
    tauriMock.on('abe_bind', () => { throw 'notready:安装命令已完成，但服务未在 10s 内可达' })
    expect(await f.abe.bind()).toEqual({ ok: false, reason: 'notready', detail: '安装命令已完成，但服务未在 10s 内可达' })
    // 无前缀兜底（主窗口门控/join 失败不带前缀）：归 failed，detail 收敛通用文案不透传内部语义
    tauriMock.on('abe_bind', () => { throw '仅主窗口可调用此命令' })
    const bare = await f.abe.bind()
    if (bare.ok) throw new Error('expected bind failure')
    expect(bare.reason).toBe('failed')
    expect(bare.detail).toBe('安装过程异常终止')
    warnSpy.mockClear()
  })

  it('wrap（C1 终审）：DEK 以 number 数组入 abe_wrap，成功 true；invoke Err 折叠 false', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { f } = makeFactory()
    tauriMock.onReturn('abe_wrap', null)
    expect(await f.abe.wrap(DEK)).toBe(true)
    expect(tauriMock.calls('abe_wrap')[0]?.args).toEqual({ dek: Array.from(DEK) })
    tauriMock.on('abe_wrap', () => { throw new Error('pipe busy') })
    expect(await f.abe.wrap(DEK)).toBe(false)
    expect(warnSpy).toHaveBeenCalledWith('[desktop] abe_wrap 失败（服务不可达/被拒），绑定序列中止', expect.any(Error))
    warnSpy.mockClear()
  })

  it('remove：{ok} 透传；invoke 异常 → {ok:false,message}', async () => {
    const { f } = makeFactory()
    tauriMock.onReturn('abe_remove', { ok: true })
    expect(await f.abe.remove()).toEqual({ ok: true })
    tauriMock.onReturn('abe_remove', { ok: false, message: '本进程未通过服务验证（应用已更新或未绑定），删除被拒' })
    expect(await f.abe.remove()).toMatchObject({ ok: false })
    tauriMock.on('abe_remove', () => { throw new Error('ipc broken') })
    const r = await f.abe.remove()
    expect(r.ok).toBe(false)
    expect(r.message).toContain('ipc broken')
  })

  it('addSource/removeSource → store abe 标记源 op（T6 绑定编排落盘步，密文在服务侧 HKLM）；未就绪报「数据尚未就绪」', async () => {
    const { f, store, holder } = makeFactory()
    await f.abe.addSource()
    expect(store.addAbeSourceOp).toHaveBeenCalledTimes(1)
    await f.abe.removeSource()
    expect(store.removeAbeSourceOp).toHaveBeenCalledTimes(1)
    holder.value = null
    await expect(f.abe.addSource()).rejects.toThrow('数据尚未就绪')
    await expect(f.abe.removeSource()).rejects.toThrow('数据尚未就绪')
  })

  it('unwrap（T7 锁屏静默解锁）：成功 → Uint8Array；服务失败收敛 null 供 LockScreen 回退 dpapi（仅告警）；非 Windows 短路 null', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { f } = makeFactory()
    tauriMock.onReturn('abe_unwrap', Array.from(DEK))
    expect(await f.abe.unwrap()).toEqual(DEK)
    tauriMock.on('abe_unwrap', () => { throw new Error('service mismatch') })
    expect(await f.abe.unwrap()).toBeNull()
    expect(warnSpy).toHaveBeenCalledWith('[desktop] abe_unwrap 失败（服务未装/失配/不可达），锁屏将回退 OS 通道', expect.any(Error))
    warnSpy.mockClear()
    expect(await makeFactory(UA_LINUX).f.abe.unwrap()).toBeNull()
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
    warnSpy.mockClear()
  })
})

describe('I2 终审：ABE 服务侧密文与 DEK 生命周期联动（security 通道包装）', () => {
  // 模块级打桩（文件尾前全程生效）：vitest 5 下文件内其余 in-test spyOn 返回同一 mock，
  // 其清理只能 mockClear（见上），不得 mockRestore
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

  afterEach(() => {
    warnSpy.mockClear()
    tauriMock.reset()
  })

  /** R7-I2：fake store 的 changePassphrase 模拟 core 真实语义——rotateDek=true（缺省）时
   *  kekSources 重置为 password-only（abe/dpapi/prf 源数据层全清）；rotateDek=false 保留。
   *  旧口径（手动设 abeSource 且换口令后仍保留）与真实语义背离，联动测试以此为准绳 */
  function simulateRealRotation(store: ReturnType<typeof fakeStore>): void {
    store.changePassphrase.mockImplementation(async (_pw: string, opts?: { rotateDek?: boolean }) => {
      if (opts?.rotateDek ?? true) {
        store.abeSource.value = null
        store.dpapiSource.value = null
        store.prfSources.value = []
      }
    })
  }

  it('轮换换口令（rotateDek 缺省/true）+ abe 源在场 + 服务在线 → 新 DEK 重 Wrap + 恢复标记源（不清密文）', async () => {
    const { f, store } = makeFactory()
    store.getCurrentDek.mockReturnValue(DEK)
    store.abeSource.value = { kind: 'abe' as const }
    simulateRealRotation(store)
    tauriMock.onReturn('abe_status', { installed: true, matchesCaller: true, boundPath: 'C:\\x\\TotpTools.exe', version: '1.2.3' })
    await f.platform.value!.security!.changePassphrase('new')
    expect(tauriMock.calls('abe_status')).toHaveLength(1) // 服务在线判定：触发一次 status 查询
    expect(tauriMock.calls('abe_wrap')).toHaveLength(1) // 新 DEK（number 数组入 invoke）
    expect(tauriMock.calls('abe_wrap')[0]?.args).toEqual({ dek: Array.from(DEK) })
    expect(store.addAbeSourceOp).toHaveBeenCalledTimes(1) // 恢复 abe 标记源（换口令后会话仍解锁，落盘生效）
    expect(tauriMock.calls('abe_remove')).toHaveLength(0)
  })

  it('服务离线/失配/查询失败 → 不 wrap 不恢复源，abe_remove 清密文降级退出（仅告警不阻断）', async () => {
    const { f, store } = makeFactory()
    store.getCurrentDek.mockReturnValue(DEK)
    const sec = f.platform.value!.security!
    // 失配（服务在但 matchesCaller:false）
    store.abeSource.value = { kind: 'abe' as const }
    simulateRealRotation(store)
    tauriMock.onReturn('abe_status', { installed: true, matchesCaller: false })
    await sec.changePassphrase('new')
    expect(tauriMock.calls('abe_wrap')).toHaveLength(0)
    expect(store.addAbeSourceOp).not.toHaveBeenCalled()
    expect(tauriMock.calls('abe_remove')).toHaveLength(1)
    expect(warnSpy).toHaveBeenCalledWith('[desktop] ABE 服务离线/失配（换口令已生效；清服务密文降级，重装可恢复）')
    // status 查询失败（null）同降级
    tauriMock.reset()
    store.abeSource.value = { kind: 'abe' as const }
    tauriMock.on('abe_status', () => { throw new Error('pipe gone') })
    await sec.changePassphrase('new')
    expect(tauriMock.calls('abe_remove')).toHaveLength(1)
  })

  it('服务在线但重 Wrap 失败 / 标记源恢复落盘失败 → 清密文降级（标记源与 HKLM 密文须成对）', async () => {
    const { f, store } = makeFactory()
    store.getCurrentDek.mockReturnValue(DEK)
    const sec = f.platform.value!.security!
    // rewrap 失败
    store.abeSource.value = { kind: 'abe' as const }
    simulateRealRotation(store)
    tauriMock.onReturn('abe_status', { installed: true, matchesCaller: true })
    tauriMock.on('abe_wrap', () => { throw new Error('service busy') })
    await expect(sec.changePassphrase('new')).resolves.toBeUndefined()
    expect(tauriMock.calls('abe_wrap')).toHaveLength(1)
    expect(tauriMock.calls('abe_remove')).toHaveLength(1)
    expect(warnSpy).toHaveBeenCalledWith('[desktop] ABE 重 Wrap 失败（换口令已生效；清服务密文降级，重装可恢复）')
    // 恢复源落盘失败（如轮换窗口内恰被锁定）
    tauriMock.reset()
    store.abeSource.value = { kind: 'abe' as const }
    tauriMock.onReturn('abe_status', { installed: true, matchesCaller: true })
    tauriMock.onReturn('abe_wrap', null)
    store.addAbeSourceOp.mockRejectedValue(new Error('vault locked'))
    await sec.changePassphrase('new')
    expect(tauriMock.calls('abe_wrap')).toHaveLength(1)
    expect(store.addAbeSourceOp).toHaveBeenCalledTimes(1)
    expect(tauriMock.calls('abe_remove')).toHaveLength(1)
    expect(warnSpy).toHaveBeenCalledWith('[desktop] ABE 标记源恢复失败（换口令已生效；标记源与 HKLM 密文须成对，清密文降级）', expect.any(Error))
  })

  it('abe 源缺席或档位切换（rotateDek:false）→ 不查状态不触服务（HKLM 密文无需动）', async () => {
    const { f, store } = makeFactory()
    store.getCurrentDek.mockReturnValue(DEK)
    const sec = f.platform.value!.security!
    // abe 源缺席：零触达
    await sec.changePassphrase('new')
    expect(tauriMock.calls()).toHaveLength(0)
    // 档位切换：DEK 不变，不查状态不重包
    store.abeSource.value = { kind: 'abe' as const }
    await sec.changePassphrase('pw', { rotateDek: false, profile: 'fast' })
    expect(tauriMock.calls()).toHaveLength(0)
  })

  it('关加密 + abe 源在场 → abe_remove 清服务密文；失败仅告警；abe 源缺席不触服务', async () => {
    const { f, store } = makeFactory()
    const sec = f.platform.value!.security!
    // abe 源缺席：不触服务
    await sec.disableEncryption()
    expect(tauriMock.calls('abe_remove')).toHaveLength(0)
    // 在场：清服务侧 HKLM（标记源随 SECURITY_KEY 整体删除，无需 removeAbeSourceOp）
    store.abeSource.value = { kind: 'abe' as const }
    tauriMock.onReturn('abe_remove', { ok: true })
    await sec.disableEncryption()
    expect(tauriMock.calls('abe_remove')).toHaveLength(1)
    // 服务不可达：{ok:false} 折叠为告警，不阻断关闭
    tauriMock.reset()
    tauriMock.onReturn('abe_remove', { ok: false, message: 'unreachable' })
    await expect(sec.disableEncryption()).resolves.toBeUndefined()
    expect(warnSpy).toHaveBeenCalledWith('[desktop] ABE 服务密文清理失败（安全操作已生效；卸载/重装可清）', 'unreachable')
  })

  it('security 其余成员透传不变（locked/kdfProfile 等浅拷贝语义）', () => {
    const { f, store } = makeFactory()
    const sec = f.platform.value!.security!
    expect(sec.locked).toBe(store.locked)
    expect(sec.hasEncryption).toBe(store.hasEncryption)
    expect(sec.getCurrentDek?.()).toBeNull() // C1：factory 注入的 DEK 面板出口透传
  })

  it('abeOps.source 映射 store.abeSource（R7-I2：SecurityCard「已启用」态判定数据口）', () => {
    const { f, store } = makeFactory()
    expect(f.abe.source.value).toBeNull()
    store.abeSource.value = { kind: 'abe' as const }
    expect(f.abe.source.value).toEqual({ kind: 'abe' })
  })
})
