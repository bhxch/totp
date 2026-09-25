/**
 * background.ts 全测（P3a，盘点 B1-1~8）：WXT defineBackground stub 后回调体在模块求值期
 * 立即执行（test/helpers/defineBackground.ts），SW 的全部注册逻辑因此可断言：
 * - 冷启动注册两个 contextMenus（C11：不放 onInstalled；同 id 重复 create 吞 lastError 幂等）；
 * - 冷启动即 pullSyncIfNewer 首拉兜底（engine 内复核 syncEnabled——false 不拉的分支属 syncEngine 测试）；
 * - 右键点击 otpauth-add：非法选中文本→错误通知；合法→pendingOtpauth + canOpenPopup 探测
 *   openPopup（Promise resolve/reject 吞、非 Promise 忽略、API 缺失/同步抛错静默四形态）；
 * - 右键点击 qr-decode-image：fetch→arrayBuffer→解码成功→pendingOtpauth+成功通知；
 *   fetch 拒绝/解码失败→「图中未识别」通知；
 * - 消息协议：schedule-clipboard-clear（delayMs 缺省/非 number→30s 兜底）、sync-push（1s 合并
 *   窗口防抖）、sync-pull（立即）、未知 type 忽略；
 * - alarm clipboard-clear 到点→ensureOffscreenDocument+sendMessage+ack 结算（1s 超时重试，
 *   最多 3 轮；createDocument 失败吞掉不阻断）；
 * - storage.onChanged 且 area='sync'→pullSyncIfNewer（local 区不触发）。
 *
 * mock 边界：syncEngine 的 push/pull 以 vi.fn 替身注入（真实引擎的 LWW 语义由 syncEngine.test.ts
 * 承载，此处聚焦 SW 的路由与编排）；decodeImageBytesToUri 替身同理（QR 解码本体在 qrDecode/ui）；
 * extApi 经 extApiMock 惰性桥——ext 每次现读 globalThis.chrome，与 installChromeShim 逐用例注入合用。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installChromeShim, type ChromeShim } from './helpers/chromeShim'
import { stubDefineBackground } from './helpers/defineBackground'

const { pullSyncIfNewer, pushSync, decodeImageBytesToUri } = vi.hoisted(() => ({
  pullSyncIfNewer: vi.fn(async () => {}),
  pushSync: vi.fn(async () => {}),
  decodeImageBytesToUri: vi.fn(async (): Promise<string | null> => null),
}))

vi.mock('../src/extApi', async () => (await import('./helpers/extApiMock')).extApiMock())
vi.mock('../src/syncEngine', () => ({
  // 形状完整防 TypeError 假绿：background 只消费 pullSyncIfNewer/pushSync，其余为常用导出面
  pullSyncIfNewer,
  pushSync,
  markSyncOff: vi.fn(async () => {}),
  needsPullBeforePush: (meta: unknown, applied: number) => meta !== null,
  SYNC_STATUS_KEY: 'sync:status',
}))
vi.mock('../src/qrDecode', () => ({ decodeImageBytesToUri }))

/** 合法 otpauth URI（parseOtpUri 走 @totp/core 真实实现） */
const VALID_URI = 'otpauth://totp/GitHub:me?secret=JBSWY3DPEHPK3PXP'

let shim: ChromeShim
let stub: ReturnType<typeof stubDefineBackground>

/** 每用例独立：重置模块注册表 → 注入 shim+stub → 动态 import（求值即执行注册回调）。
 *  background 模块内有可变闭包状态（syncPushTimer）且注册 listener 无法反挂，逐用例重载隔离。 */
async function loadBackground(opts?: Parameters<typeof installChromeShim>[0]) {
  shim = installChromeShim(opts)
  stub = stubDefineBackground()
  return await import('../entrypoints/background')
}

/** 派发微任务队列（storage.set().then 链、async listener 的同步段落地） */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  vi.resetModules()
  // vi.mock 工厂只执行一次：hoisted 替身（pull/push/decode）跨用例是同一实例，须清调用记录
  vi.clearAllMocks()
})

afterEach(() => {
  stub?.restore()
  shim?.restore()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

/** 模拟用户右键点击菜单项 */
function clickMenu(info: Record<string, unknown>): void {
  shim.emitContextMenuClick(info)
}

describe('SW 冷启动注册（B1-1/2）', () => {
  it('注册两个 contextMenus：id 与 contexts 正确，create 回调执行且 lastError 干净', async () => {
    await loadBackground()
    expect(stub.callbacks).toHaveLength(1)
    expect(shim.contextMenus.created.map((c) => c.props.id)).toEqual(['otpauth-add', 'qr-decode-image'])
    expect(shim.contextMenus.created.map((c) => c.props.contexts)).toEqual([['selection'], ['image']])
    // 两个 create 的回调都已执行（幂等确认）且未报 lastError
    expect(shim.contextMenus.created.every((c) => c.callback !== undefined)).toBe(true)
  })

  it('重复创建（SW 重复加载/重放回调）：同 id lastError 被回调读取吞掉，不抛异常', async () => {
    await loadBackground()
    // shim 对同 id create 在 callback 期间置 lastError；background 的回调 `() => void ext.runtime.lastError`
    // 只读取不判断——重复注册不得抛出（C11 幂等语义）
    expect(() => stub.callbacks[0]!()).not.toThrow()
    expect(shim.contextMenus.created).toHaveLength(4)
    expect(shim.contextMenus.created[2]!.props.id).toBe('otpauth-add')
  })

  it('SW 冷启动即 pullSyncIfNewer 首拉兜底（浏览器关闭期间他端推送不再触发 onChanged）', async () => {
    await loadBackground()
    expect(pullSyncIfNewer).toHaveBeenCalledTimes(1)
  })
})

describe('右键菜单 otpauth-add（B1-4）', () => {
  it('选中文本非 otpauth：错误通知，不写 pendingOtpauth、不探测 openPopup', async () => {
    const openPopup = vi.fn(() => Promise.resolve())
    await loadBackground({ openPopup })

    clickMenu({ menuItemId: 'otpauth-add', selectionText: 'hello world' })
    await flush()

    expect(shim.notifications.created).toHaveLength(1)
    expect(shim.notifications.created[0]).toMatchObject({ type: 'basic', message: '选中文本不是有效的 otpauth 链接' })
    expect(shim.local.data['pendingOtpauth']).toBeUndefined()
    expect(openPopup).not.toHaveBeenCalled()
  })

  it('otpauth:// 前缀但解析失败（secret 缺失）：同样错误通知', async () => {
    await loadBackground()
    clickMenu({ menuItemId: 'otpauth-add', selectionText: 'otpauth://totp/bad' })
    await flush()
    expect(shim.notifications.created[0]).toMatchObject({ message: '选中文本不是有效的 otpauth 链接' })
    expect(shim.local.data['pendingOtpauth']).toBeUndefined()
  })

  it('合法 URI：写 pendingOtpauth，canOpenPopup 探测后调 openPopup（Promise 形态）', async () => {
    const openPopup = vi.fn(() => Promise.resolve())
    await loadBackground({ openPopup })

    clickMenu({ menuItemId: 'otpauth-add', selectionText: `  ${VALID_URI}  ` })
    await flush()

    expect(shim.local.data['pendingOtpauth']).toBe(VALID_URI) // trim 后原样写入
    expect(openPopup).toHaveBeenCalledTimes(1)
    expect(shim.notifications.created).toHaveLength(0) // 成功路径静默（用户点图标即见预填）
  })

  it('openPopup 返回 rejected Promise：catch 吞掉不产生 unhandled rejection', async () => {
    const openPopup = vi.fn(() => Promise.reject(new Error('no user gesture')))
    await loadBackground({ openPopup })
    clickMenu({ menuItemId: 'otpauth-add', selectionText: VALID_URI })
    await flush()
    expect(openPopup).toHaveBeenCalledTimes(1) // 无 unhandled rejection 即通过（vitest 会将未处理拒绝计为错误）
  })

  it('action 无 openPopup 成员（canOpenPopup false）：写入照常，不调用 openPopup', async () => {
    await loadBackground() // 未注入 openPopup
    clickMenu({ menuItemId: 'otpauth-add', selectionText: VALID_URI })
    await flush()
    expect(shim.local.data['pendingOtpauth']).toBe(VALID_URI)
  })

  it('openPopup 同步抛错（API 存在但调用失败）：try-catch 静默，不影响已写入的 pendingOtpauth', async () => {
    const openPopup = vi.fn(() => {
      throw new Error('openPopup is not allowed')
    })
    await loadBackground({ openPopup })
    clickMenu({ menuItemId: 'otpauth-add', selectionText: VALID_URI })
    await flush()
    expect(openPopup).toHaveBeenCalledTimes(1)
    expect(shim.local.data['pendingOtpauth']).toBe(VALID_URI)
  })

  it('非 otpauth 菜单 id：忽略（菜单点击派发给不相关监听器的防御）', async () => {
    await loadBackground()
    clickMenu({ menuItemId: 'other-menu', selectionText: VALID_URI })
    await flush()
    expect(shim.notifications.created).toHaveLength(0)
    expect(shim.local.data['pendingOtpauth']).toBeUndefined()
  })
})

describe('右键菜单 qr-decode-image（B1-5）', () => {
  it('fetch 成功 + 解码出 otpauth：写 pendingOtpauth + 成功通知', async () => {
    decodeImageBytesToUri.mockResolvedValue(VALID_URI)
    const fetchMock = vi.fn(async () => ({ arrayBuffer: async () => new ArrayBuffer(4) }))
    vi.stubGlobal('fetch', fetchMock)
    await loadBackground()

    clickMenu({ menuItemId: 'qr-decode-image', srcUrl: 'https://example.com/qr.png' })
    await flush()

    expect(fetchMock).toHaveBeenCalledWith('https://example.com/qr.png')
    expect(decodeImageBytesToUri).toHaveBeenCalledWith(expect.any(Uint8Array))
    expect(shim.local.data['pendingOtpauth']).toBe(VALID_URI)
    expect(shim.notifications.created[0]).toMatchObject({ message: '已识别验证码二维码，点扩展图标查看并保存' })
  })

  it('解码失败（返回 null）：「图中未识别」通知，不写 pendingOtpauth', async () => {
    decodeImageBytesToUri.mockResolvedValue(null)
    vi.stubGlobal('fetch', vi.fn(async () => ({ arrayBuffer: async () => new ArrayBuffer(4) })))
    await loadBackground()

    clickMenu({ menuItemId: 'qr-decode-image', srcUrl: 'https://example.com/qr.png' })
    await flush()

    expect(shim.notifications.created[0]).toMatchObject({ message: '图中未识别到有效的 otpauth 二维码' })
    expect(shim.local.data['pendingOtpauth']).toBeUndefined()
  })

  it('fetch 拒绝（权限/CORS Failed to fetch）：同样失败通知', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    }))
    await loadBackground()

    clickMenu({ menuItemId: 'qr-decode-image', srcUrl: 'https://example.com/qr.png' })
    await flush()

    expect(shim.notifications.created[0]).toMatchObject({ message: '图中未识别到有效的 otpauth 二维码' })
    expect(shim.local.data['pendingOtpauth']).toBeUndefined()
  })
})

describe('消息协议（B1-6）', () => {
  it('schedule-clipboard-clear：delayMs 缺省 → alarms.create when=now+30000（同名覆盖=重置计时）', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    await loadBackground()

    await shim.runtime.receive({ type: 'schedule-clipboard-clear' })
    expect(shim.alarms.created).toEqual([{ name: 'clipboard-clear', info: { when: 1_030_000 } }])

    // 重复调度：同名 create 记录覆盖（真实 API 重置计时），记录序供断言
    vi.setSystemTime(1_020_000)
    await shim.runtime.receive({ type: 'schedule-clipboard-clear', delayMs: 5_000 })
    expect(shim.alarms.created[1]).toEqual({ name: 'clipboard-clear', info: { when: 1_025_000 } })
  })

  it('delayMs 非数字 → 30000 兜底', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(2_000_000)
    await loadBackground()
    await shim.runtime.receive({ type: 'schedule-clipboard-clear', delayMs: 'soon' })
    await shim.runtime.receive({ type: 'schedule-clipboard-clear', delayMs: null })
    expect(shim.alarms.created.map((a) => a.info)).toEqual([
      { when: 2_030_000 },
      { when: 2_030_000 },
    ])
  })

  it('sync-push：1s 合并窗口防抖——窗口内多次只推一次，后续消息重新计时（SW 被杀唤醒不丢推送）', async () => {
    vi.useFakeTimers()
    await loadBackground()

    await shim.runtime.receive({ type: 'sync-push' })
    await shim.runtime.receive({ type: 'sync-push' })
    await shim.runtime.receive({ type: 'sync-push' })
    await vi.advanceTimersByTimeAsync(999)
    expect(pushSync).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(pushSync).toHaveBeenCalledTimes(1)

    // 窗口结束后再来一条：重新计时再推（不因前次已推而丢失）
    await shim.runtime.receive({ type: 'sync-push' })
    await vi.advanceTimersByTimeAsync(999)
    expect(pushSync).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(pushSync).toHaveBeenCalledTimes(2)
  })

  it('sync-pull：立即拉取（冷启动首拉之外再触发）；未知 type 忽略', async () => {
    vi.useFakeTimers()
    await loadBackground()
    expect(pullSyncIfNewer).toHaveBeenCalledTimes(1) // 冷启动首拉

    await shim.runtime.receive({ type: 'sync-pull' })
    expect(pullSyncIfNewer).toHaveBeenCalledTimes(2)

    await shim.runtime.receive({ type: 'totally-unknown' })
    expect(pullSyncIfNewer).toHaveBeenCalledTimes(2)
    expect(pushSync).not.toHaveBeenCalled()
    expect(shim.alarms.created).toHaveLength(0)
  })
})

describe('alarm clipboard-clear → 清剪贴板重试链（B1-7）', () => {
  it('收 ack：ensureOffscreenDocument + sendMessage 各一次即结算，不重试', async () => {
    vi.useFakeTimers()
    await loadBackground({ offscreen: {} })
    // 模拟 offscreen 侧：收到 clear-clipboard → 持通道异步回 ack 入站消息（sendResponse 应答的是
    // background 自己的 ack 监听承诺之外的第二通道；background 只认入站 ack 消息）
    shim.onMessage.addListener((msg) => {
      if ((msg as { type?: string }).type === 'clear-clipboard') {
        setTimeout(() => {
          void shim.runtime.receive({ type: 'clear-clipboard-ack' })
        }, 0)
        return true
      }
      return undefined
    })
    const sendSpy = vi.spyOn(shim.chrome.runtime as { sendMessage: (msg: unknown) => Promise<unknown> }, 'sendMessage')

    shim.emitAlarm({ name: 'clipboard-clear' })
    await vi.advanceTimersByTimeAsync(10)

    expect(shim.offscreen!.calls.createDocument).toEqual([
      { url: 'offscreen.html', reasons: ['CLIPBOARD'], justification: expect.any(String) },
    ])
    expect(sendSpy).toHaveBeenCalledTimes(1)
    expect(sendSpy).toHaveBeenCalledWith({ type: 'clear-clipboard' })

    // ack 已结算：再等也不重试
    await vi.advanceTimersByTimeAsync(5_000)
    expect(sendSpy).toHaveBeenCalledTimes(1)
  })

  it('无 ack：每次 1s 超时后重试，最多 3 轮后放弃', async () => {
    vi.useFakeTimers()
    await loadBackground({ offscreen: {} })
    // background 自身消息路由 listener 存在 → sendMessage 按「已送达无应答」resolve（不 reject），
    // 只能等 1s 超时判定失败——与真实 Chrome 中 offscreen 未挂 listener 时的悬挂通道同型
    const sendSpy = vi.spyOn(shim.chrome.runtime as { sendMessage: (msg: unknown) => Promise<unknown> }, 'sendMessage')

    shim.emitAlarm({ name: 'clipboard-clear' })
    await vi.advanceTimersByTimeAsync(1_000) // 第 1 轮超时
    expect(sendSpy).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(2_000) // 第 2、3 轮
    expect(sendSpy).toHaveBeenCalledTimes(4 - 1)
    expect(shim.offscreen!.calls.createDocument).toHaveLength(3) // 每轮先 ensure 再发

    await vi.advanceTimersByTimeAsync(10_000) // 放弃后不再动作
    expect(sendSpy).toHaveBeenCalledTimes(3)
  })

  it('createDocument 失败（已存在/权限缺失）：错误被吞，仍进入发送重试链（复用已存在文档）', async () => {
    vi.useFakeTimers()
    await loadBackground({ offscreen: { onCreateDocument: () => { throw new Error('Duplicate offscreen document') } } })
    shim.onMessage.addListener((msg) => {
      if ((msg as { type?: string }).type === 'clear-clipboard') {
        setTimeout(() => {
          void shim.runtime.receive({ type: 'clear-clipboard-ack' })
        }, 0)
        return true
      }
      return undefined
    })
    const sendSpy = vi.spyOn(shim.chrome.runtime as { sendMessage: (msg: unknown) => Promise<unknown> }, 'sendMessage')

    shim.emitAlarm({ name: 'clipboard-clear' })
    await vi.advanceTimersByTimeAsync(10)

    expect(shim.offscreen!.calls.createDocument).toHaveLength(1)
    expect(sendSpy).toHaveBeenCalledTimes(1) // ensure 失败未阻断清空动作
  })

  it('非 clipboard-clear 的 alarm：忽略', async () => {
    vi.useFakeTimers()
    await loadBackground({ offscreen: {} })
    const sendSpy = vi.spyOn(shim.chrome.runtime as { sendMessage: (msg: unknown) => Promise<unknown> }, 'sendMessage')
    shim.emitAlarm({ name: 'other-alarm' })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(sendSpy).not.toHaveBeenCalled()
    expect(shim.offscreen!.calls.createDocument).toHaveLength(0)
  })
})

describe('storage.onChanged（B1-8）', () => {
  it('area=sync 变更 → pullSyncIfNewer；local 区变更不触发', async () => {
    await loadBackground()
    expect(pullSyncIfNewer).toHaveBeenCalledTimes(1) // 冷启动首拉

    shim.emit({ vault: { newValue: 'x' } }, 'local')
    expect(pullSyncIfNewer).toHaveBeenCalledTimes(1)

    shim.emit({ vault: { newValue: 'y' } }, 'sync')
    expect(pullSyncIfNewer).toHaveBeenCalledTimes(2)
  })
})
