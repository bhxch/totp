/**
 * desktopShell 直测（P4，盘点 B1/B2/B8 装配层缺口）：init 编排时序（监听注册顺序/回注先于
 * store 赋值/迁移先于 auto.start）、loadError 兜底、锁定链路（system-lock/force-lock/stash-dek
 * 两向/onLocked 清槽）、失焦隐藏门控、MCP 桥装配与审批事件接线、dispose 卸载清算。
 * Tauri 边界全走 test/mocks/tauri；store 经真实 createTauriFs+createVueStore 生产路径构建
 * （fs 为 mock，settings/vault 全默认 → 未加密解锁态）；i18n/迁移以 spy 注入隔离。
 */
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { ref, shallowRef } from 'vue'
import { base64ToBytes, bytesToBase64 } from '@totp/core'
import { tauriMock } from '../test/mocks/tauri'
import { fakeStore, memoryAdapter } from '../test/helpers/fakes'
import {
  createDesktopApprovalQueue, createDesktopMcpDeps, createDesktopShell, createDevtoolsPlatform, createLegacyMigrations,
  createMcpConsentFlow, createReleasePlatform, type DesktopShellDeps,
} from '../src/desktopShell'

vi.mock('@tauri-apps/api/core', async () => (await import('../test/mocks/tauri')).invokeModule())
vi.mock('@tauri-apps/api/event', async () => (await import('../test/mocks/tauri')).eventModule())
vi.mock('@tauri-apps/api/window', async () => (await import('../test/mocks/tauri')).windowModule())
vi.mock('@tauri-apps/plugin-fs', async () => (await import('../test/mocks/tauri')).fsModule())

function makeDeps() {
  const store = shallowRef<import('@totp/ui').VueStore | null>(null)
  const icons = ref<unknown>(null)
  const loadError = ref('')
  const auto = { notifyChanged: vi.fn(), start: vi.fn(), stop: vi.fn(), runBackupNow: vi.fn(async () => {}) }
  const deps: DesktopShellDeps = {
    store,
    icons: icons as never,
    loadError,
    setAdapter: vi.fn(),
    auto: auto as never,
    mountI18n: vi.fn(),
    runLegacyMigrations: vi.fn(async () => {}),
    approvalQueue: createDesktopApprovalQueue(),
    mcpDeps: createDesktopMcpDeps({
      getStore: () => store.value,
      runSync: async () => {},
      runBackup: () => auto.runBackupNow(),
    }),
  }
  return { deps, store, loadError, auto }
}

async function initShell(over?: Partial<Record<string, unknown>>) {
  const ctx = makeDeps()
  const shell = createDesktopShell({ ...ctx.deps, ...over } as DesktopShellDeps)
  const init = shell.init()
  await flushPromises()
  await init
  return { shell, ...ctx }
}

beforeEach(() => {
  tauriMock.reset()
  vi.clearAllMocks()
})

describe('init：启动序列与关键初始化', () => {
  it('注册顺序=行为契约：system-lock → 失焦隐藏 → adapter 登记 → force-lock → stash-dek → 回注 → i18n → 迁移 → auto.start', async () => {
    tauriMock.onReturn('take_stashed_dek', null)
    const { deps, store, auto } = await initShell()
    const listenOrder = (event: string): number => {
      const idx = tauriMock.listen.mock.calls.findIndex(([e]) => e === event)
      return tauriMock.listen.mock.invocationCallOrder[idx]!
    }
    const focusOrder = tauriMock.window.onFocusChanged.mock.invocationCallOrder[0]!
    const takeOrder = tauriMock.invoke.mock.calls.findIndex(([c]) => c === 'take_stashed_dek')
    const takeInvokeOrder = tauriMock.invoke.mock.invocationCallOrder[takeOrder]!
    expect(listenOrder('system-lock')).toBeLessThan(focusOrder)
    expect(focusOrder).toBeLessThan(listenOrder('force-lock'))
    expect(listenOrder('force-lock')).toBeLessThan(listenOrder('stash-dek-request'))
    expect(takeInvokeOrder).toBeGreaterThan(listenOrder('stash-dek-request'))
    // store 赋值/i18n/迁移/auto.start 在回注之后（i18n/runLegacyMigrations 为注入 spy）
    const mountOrder = vi.mocked(deps.mountI18n).mock.invocationCallOrder[0]!
    const migrateOrder = vi.mocked(deps.runLegacyMigrations).mock.invocationCallOrder[0]!
    const startOrder = auto.start.mock.invocationCallOrder[0]!
    expect(deps.setAdapter).toHaveBeenCalledTimes(1)
    expect(mountOrder).toBeGreaterThan(takeInvokeOrder)
    expect(migrateOrder).toBeGreaterThan(mountOrder)
    expect(startOrder).toBeGreaterThan(migrateOrder)
    expect(store.value).not.toBeNull()
    expect(deps.icons.value).not.toBeNull() // 图标仓就绪（shell 内创建）
  })

  it('store 生产路径接线：windowId 主窗 onLocked → clear_stashed_dek；onCommitted → auto.notifyChanged', async () => {
    const { store, auto } = await initShell()
    const s = store.value!
    s.settings.lockOnSystemLock = false
    s.lock() // 纯前端锁库 → onLocked 清 Rust DEK 暂存槽
    expect(s.locked.value).toBe(true)
    expect(tauriMock.calls('clear_stashed_dek')).toHaveLength(1)
    // onCommitted 接线：新 shell（未锁定）写 settings → commit → 自动备份变更检测
    const ctx2 = makeDeps()
    const shell2 = createDesktopShell(ctx2.deps)
    await shell2.init()
    await flushPromises()
    ctx2.store.value!.settings.clipboardClearEnabled = !ctx2.store.value!.settings.clipboardClearEnabled
    await ctx2.store.value!.commitSettings()
    await flushPromises()
    expect(ctx2.auto.notifyChanged).toHaveBeenCalled()
  })

  it('关键初始化失败 → loadError 原始消息（i18n 未装入，模板层兜底）；MCP 装配照常降级进行', async () => {
    tauriMock.fs.mkdir.mockRejectedValue(new Error('disk full'))
    const { deps, store, loadError } = await initShell()
    expect(loadError.value).toBe('disk full')
    expect(store.value).toBeNull()
    expect(vi.mocked(deps.mountI18n)).not.toHaveBeenCalled()
    expect(tauriMock.listenerCount('mcp://req')).toBe(1) // MCP 在主 try 之外，失败不放大
    expect(tauriMock.listenerCount('mcp://approval')).toBe(1)
  })
})

describe('锁定链路（B2）', () => {
  it('system-lock：lockOnSystemLock 开 → 锁库；关 → 不动作（回调现读设置）', async () => {
    const { store } = await initShell()
    const s = store.value!
    s.settings.lockOnSystemLock = true
    tauriMock.emit('system-lock', null)
    expect(s.locked.value).toBe(true)
    const ctx2 = await initShell()
    ctx2.store.value!.settings.lockOnSystemLock = false
    tauriMock.emit('system-lock', null)
    expect(ctx2.store.value!.locked.value).toBe(false)
  })

  it('force-lock → store.lock()（释放策略暂停/销毁锁库）', async () => {
    const { store } = await initShell()
    expect(store.value!.locked.value).toBe(false)
    tauriMock.emit('force-lock', null)
    expect(store.value!.locked.value).toBe(true)
  })

  it('stash-dek-request：解锁态 DEK 非空 → stash_dek（base64）；锁定/未启用 → 不上报', async () => {
    const { store } = await initShell()
    const s = store.value!
    await s.enableEncryption('test-password') // 真实路径：启用加密后解锁态持有 DEK
    tauriMock.emit('stash-dek-request', null)
    const dek = s.getCurrentDek()
    expect(dek).not.toBeNull()
    const [stashArgs] = tauriMock.calls('stash_dek')
    expect(stashArgs?.args?.dek).toBe(bytesToBase64(dek!))
    s.lock() // 锁定后 DEK 清空 → 不上报
    tauriMock.emit('stash-dek-request', null)
    expect(tauriMock.calls('stash_dek')).toHaveLength(1)
  })

  it('take_stashed_dek 回注：无暂存（锁库路径）→ 照常就绪；有暂存但不可用 → warn 保持就绪不放大', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { store } = await initShell()
    expect(store.value).not.toBeNull() // 无暂存（默认 null）
    tauriMock.onReturn('take_stashed_dek', bytesToBase64(new Uint8Array(32).fill(1)))
    const ctx2 = await initShell()
    // 未加密库 unlockWithDek 抛 'encryption not enabled' → warn 兜底保持页面（自然回退锁定页）
    await vi.waitFor(() => expect(warnSpy).toHaveBeenCalledWith('[release] 暂存 DEK 回注失败，保持锁定', expect.any(Error)))
    expect(ctx2.store.value).not.toBeNull()
    warnSpy.mockRestore()
  })

  it('take_stashed_dek 命令失败 → catch 兜底（联动降级不阻断启动）', async () => {
    tauriMock.on('take_stashed_dek', () => { throw new Error('rust gone') })
    const { store } = await initShell()
    expect(store.value).not.toBeNull()
  })
})

describe('失焦隐藏与窗口动作（B12）', () => {
  it('blurHideEnabled + main 标签 → 失焦 hide；开关关或不属于 main → 不隐藏', async () => {
    const { store } = await initShell()
    store.value!.settings.blurHideEnabled = true
    tauriMock.emitFocusChanged(false)
    expect(tauriMock.window.hide).toHaveBeenCalled()
    tauriMock.window.hide.mockClear()
    tauriMock.emitFocusChanged(true) // 聚焦不隐藏
    expect(tauriMock.window.hide).not.toHaveBeenCalled()
    tauriMock.window.label = 'mini'
    tauriMock.emitFocusChanged(false)
    expect(tauriMock.window.hide).not.toHaveBeenCalled() // 仅 main 自隐藏
    tauriMock.window.label = 'main'
    store.value!.settings.blurHideEnabled = false
    tauriMock.emitFocusChanged(false)
    expect(tauriMock.window.hide).not.toHaveBeenCalled()
  })
})

describe('MCP 桥与审批事件接线（B8）', () => {
  it('解锁态 list_accounts：mcp://req → mcp_respond ok:true（字段白名单语义由 mcpBridge 层已测）', async () => {
    const { store } = await initShell()
    store.value!.vault.entries.push({ uuid: 'e1', issuer: 'GitHub', label: 'main', type: 'totp', tagIds: [] } as never)
    tauriMock.emit('mcp://req', { id: 1, tool: 'list_accounts', args: {} })
    await vi.waitFor(() => expect(tauriMock.calls('mcp_respond')).toHaveLength(1))
    const respond = tauriMock.calls('mcp_respond')[0]!.args as { id: number; ok: boolean; result: { accounts: unknown[] }; error: unknown }
    expect(respond).toMatchObject({ id: 1, ok: true, error: null })
    expect((respond.result as { accounts: Array<{ id: string }> }).accounts[0]).toMatchObject({ id: 'e1', issuer: 'GitHub' })
  })

  it('锁定态 → 「vault locked」直达（requireEntries 门控）', async () => {
    const { store } = await initShell()
    store.value!.lock()
    tauriMock.emit('mcp://req', { id: 2, tool: 'list_accounts', args: {} })
    await vi.waitFor(() => expect(tauriMock.calls('mcp_respond')).toHaveLength(1))
    expect(tauriMock.calls('mcp_respond')[0]!.args).toMatchObject({ id: 2, ok: false, error: 'vault locked' })
  })

  it('审批/工具确认事件 → 队列（宿主对话框消费）；工具 Allow → mcp_respond 回 result:true 恰一次', async () => {
    const { deps } = await initShell()
    tauriMock.emit('mcp://approval', { ident: 'conn-1', tool: 'read_x' })
    tauriMock.emit('mcp://tool-approval', { id: 7, ident: 'conn-2', tool: 'write_y' })
    expect(deps.approvalQueue.current.value).toMatchObject({ ident: 'conn-1' }) // FIFO 队首=首连
    const flow = createMcpConsentFlow(deps.approvalQueue)
    flow.onApprovalAction('trust') // 队首回执 mcp_approval_response，工具确认顶上
    await vi.waitFor(() => expect(tauriMock.calls('mcp_approval_response')).toHaveLength(1))
    expect(tauriMock.calls('mcp_approval_response')[0]!.args).toEqual({ ident: 'conn-1', action: 'trust' })
    expect(deps.approvalQueue.current.value).toMatchObject({ id: 7 })
    flow.onToolAllow()
    await vi.waitFor(() => expect(tauriMock.calls('mcp_respond')).toHaveLength(1))
    expect(tauriMock.calls('mcp_respond')[0]!.args).toEqual({ id: 7, ok: true, result: true, error: null })
  })

  it('onConsentClose：按队首通道分流 deny（首连回执 deny；空队列安全 no-op）', async () => {
    const { deps } = await initShell()
    const flow = createMcpConsentFlow(deps.approvalQueue)
    flow.onConsentClose() // 空队列 no-op
    expect(tauriMock.calls('mcp_approval_response')).toHaveLength(0)
    tauriMock.emit('mcp://approval', { ident: 'conn-9', tool: 't' })
    await flushPromises()
    flow.onConsentClose()
    await flushPromises()
    expect(tauriMock.calls('mcp_approval_response')).toHaveLength(1)
    expect(tauriMock.calls('mcp_approval_response')[0]!.args).toEqual({ ident: 'conn-9', action: 'deny' })
    expect(deps.approvalQueue.current.value).toBeNull()
  })
})

describe('dispose：卸载清算', () => {
  it('auto.stop + 全部事件监听移除 + 文档监听移除 + 未决工具确认回 false', async () => {
    const { deps, auto, shell } = await initShell()
    tauriMock.emit('mcp://tool-approval', { id: 9, ident: 'conn-9', tool: 't' }) // 留未决
    const events = ['system-lock', 'force-lock', 'stash-dek-request', 'mcp://req', 'mcp://approval', 'mcp://tool-approval']
    const removeSpy = vi.spyOn(document, 'removeEventListener')
    shell.dispose()
    expect(auto.stop).toHaveBeenCalled()
    for (const e of events) expect(tauriMock.listenerCount(e)).toBe(0)
    expect(removeSpy).toHaveBeenCalledWith('pointerdown', expect.any(Function))
    expect(removeSpy).toHaveBeenCalledWith('keydown', expect.any(Function))
    // 未决工具确认 → onDecide(false) → mcp_respond result:false（Rust oneshot 不悬挂）
    await vi.waitFor(() => expect(tauriMock.calls('mcp_respond')).toHaveLength(1))
    expect(tauriMock.calls('mcp_respond')[0]!.args).toMatchObject({ id: 9, ok: true, result: false, error: null })
  })

  it('dispose 幂等安全（重复清理不抛）', async () => {
    const { shell } = await initShell()
    shell.dispose()
    expect(() => shell.dispose()).not.toThrow()
  })
})

describe('配置平台适配器（B12 释放策略/devtools）', () => {
  it('devtools get/set → invoke devtools_get_config/devtools_set_config', async () => {
    const p = createDevtoolsPlatform()
    tauriMock.onReturn('devtools_get_config', { enabled: true, port: 9222 })
    expect(await p.getConfig()).toEqual({ enabled: true, port: 9222 })
    await p.setConfig(false, 9223)
    expect(tauriMock.calls('devtools_set_config')[0]?.args).toEqual({ enabled: false, port: 9223 })
  })

  it('release get/set → invoke release_policy_get/set（snake_case 四键，rename camelCase 对齐）', async () => {
    const p = createReleasePlatform()
    tauriMock.onReturn('release_policy_get', { pauseMinutes: 10, destroyMinutes: 30, lockOnPause: true, lockOnDestroy: false })
    expect(await p.getConfig()).toMatchObject({ pauseMinutes: 10 })
    await p.setConfig({ pauseMinutes: 5, destroyMinutes: 15, lockOnPause: false, lockOnDestroy: true })
    expect(tauriMock.calls('release_policy_set')[0]?.args).toEqual({
      pauseMinutes: 5, destroyMinutes: 15, lockOnPause: false, lockOnDestroy: true,
    })
  })
})

describe('MCP 触发器前置判定接线（B8.28，受理即返回）', () => {
  it('锁定 → guard 结构化拒绝 trigger_sync（不触发通道）', async () => {
    const { store, auto } = await initShell()
    store.value!.lock()
    tauriMock.emit('mcp://req', { id: 3, tool: 'trigger_sync', args: {} })
    await vi.waitFor(() => expect(tauriMock.calls('mcp_respond')).toHaveLength(1))
    expect(tauriMock.calls('mcp_respond')[0]!.args).toMatchObject({ id: 3, ok: true, result: { triggered: false, reason: 'vault locked' } })
    expect(auto.runBackupNow).not.toHaveBeenCalled()
  })

  it('解锁有口令 → 受理即返回 triggered:true（不 await 业务结果，绝不返回 vault 数据）', async () => {
    const { store, auto } = await initShell()
    await store.value!.setBackupSecret('pw', false) // 会话备份口令（守护需要非 null）
    tauriMock.emit('mcp://req', { id: 4, tool: 'trigger_backup', args: {} })
    await vi.waitFor(() => expect(tauriMock.calls('mcp_respond')).toHaveLength(1))
    expect(tauriMock.calls('mcp_respond')[0]!.args).toMatchObject({ id: 4, ok: true, result: { triggered: true } })
    await vi.waitFor(() => expect(auto.runBackupNow).toHaveBeenCalled()) // fire-and-forget 通道已启动
    const respond = tauriMock.calls('mcp_respond')[0]!.args as { result: Record<string, unknown> }
    expect(Object.keys(respond.result)).toEqual(['triggered']) // 绝不携带 vault 数据
  })
})

describe('createLegacyMigrations 成功路径（云旧键迁移提示）', () => {
  it('unlock 态 + 云旧键 → 迁移 N 个并 console.info；saveCred 走 store 保管区 op', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
    const store = fakeStore()
    store.saveSourceCredOp.mockResolvedValue(undefined)
    const adapter = memoryAdapter()
    await adapter.set('cloudCreds', JSON.stringify([
      { cred: { backend: 'webdav', serverUrl: 'https://dav', username: 'u', password: 'p' }, enabled: true },
    ]))
    const run = createLegacyMigrations({
      getStore: () => store,
      getAdapter: () => adapter,
      migrateDekWrapToEntropyBound: async () => {},
    })
    await run()
    expect(store.saveSourceCredOp).toHaveBeenCalled()
    await vi.waitFor(() => expect(infoSpy).toHaveBeenCalledWith('[migrate] 已迁移 1 个云目标到新模型'))
    infoSpy.mockRestore()
  })
})

describe('createLegacyMigrations 容错', () => {
  it('迁移失败（adapter 未就绪）→ warn 旧键保留不抛（解锁后重试）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const run = createLegacyMigrations({
      getStore: () => ({ locked: { value: false } } as never),
      getAdapter: () => null,
      migrateDekWrapToEntropyBound: async () => {},
    })
    await expect(run()).resolves.toBeUndefined()
    await vi.waitFor(() => expect(warnSpy).toHaveBeenCalledWith('[migrate] 旧数据迁移失败（旧键保留，解锁后重试）', expect.any(Error)))
    warnSpy.mockRestore()
  })
})

describe('init 内三段独立容错（降级不放大）', () => {
  it('MCP 桥装配失败（mcp://req 注册拒绝）→ 仅 warn，审批监听照常注册', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const unlisten = async (): Promise<() => void> => () => {}
    tauriMock.listen.mockImplementationOnce(unlisten).mockImplementationOnce(unlisten).mockImplementationOnce(unlisten)
    tauriMock.listen.mockImplementationOnce(async (): Promise<() => void> => { throw new Error('bus down') }) // 第 4 次=mcp://req
    const ctx = makeDeps()
    const shell = createDesktopShell(ctx.deps)
    await shell.init()
    await flushPromises()
    await vi.waitFor(() => expect(warnSpy).toHaveBeenCalledWith('[mcp] MCP 桥装配失败，已降级跳过（不影响应用主流程）', expect.any(Error)))
    expect(tauriMock.listenerCount('mcp://approval')).toBe(1) // 后续容错段不受影响
    warnSpy.mockRestore()
  })

  it('审批/工具确认监听注册失败 → 各自 warn 降级', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const unlisten = async (): Promise<() => void> => () => {}
    // 第 1-4 次默认成功（system-lock/force-lock/stash/mcp://req），第 5 次=审批，第 6 次=工具确认
    for (let i = 0; i < 4; i++) tauriMock.listen.mockImplementationOnce(unlisten)
    tauriMock.listen.mockImplementationOnce(async (): Promise<() => void> => { throw new Error('approval bus down') })
    tauriMock.listen.mockImplementationOnce(async (): Promise<() => void> => { throw new Error('tool bus down') })
    const ctx = makeDeps()
    const shell = createDesktopShell(ctx.deps)
    await shell.init()
    await flushPromises()
    await vi.waitFor(() => expect(warnSpy).toHaveBeenCalledWith('[mcp] MCP 审批监听注册失败，已降级跳过（不影响应用主流程）', expect.any(Error)))
    expect(warnSpy).toHaveBeenCalledWith('[mcp] MCP 工具确认监听注册失败，已降级跳过（不影响应用主流程）', expect.any(Error))
    warnSpy.mockRestore()
  })

  it('工具确认回执失败 → onDecide invoke 拒绝仅告警', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ctx = await (async () => makeDeps())()
    const shell = createDesktopShell(ctx.deps)
    await shell.init()
    await flushPromises()
    tauriMock.on('mcp_respond', () => { throw new Error('respond rejected') })
    tauriMock.emit('mcp://tool-approval', { id: 11, ident: 'c11', tool: 't' })
    const flow = createMcpConsentFlow(ctx.deps.approvalQueue)
    flow.onToolAllow()
    await vi.waitFor(() => expect(warnSpy).toHaveBeenCalledWith('[mcp] mcp_respond(tool confirm) failed', expect.any(Error)))
    warnSpy.mockRestore()
  })
})
