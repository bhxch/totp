/**
 * offscreen.ts 全测（P3a，盘点 B2-9/10）：offscreen document 持 CLIPBOARD 授权清剪贴板——
 * - 收 clear-clipboard → navigator.clipboard.writeText('')（成功路径）；
 * - writeText 被拒（offscreen 无焦点 async Clipboard API 常见拒绝）→ textarea+execCommand('copy') 兜底；
 * - 完成后 sendResponse({ok:true})（channel 关闭抛错吞掉）+ fire-and-forget sendMessage ack；
 * - listener 返回 true 持开通道（异步回执）；非 clear-clipboard 消息不拦截不持通道。
 *
 * jsdom 环境（document/navigator 必需）；extApi 经 extApiMock 惰性桥 + chromeShim 注入。
 * offscreen.ts 求值即注册 onMessage listener（无 defineBackground 包装），动态 import 前装好 shim。
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installChromeShim, type ChromeShim, type MessageListener } from './helpers/chromeShim'

vi.mock('../src/extApi', async () => (await import('./helpers/extApiMock')).extApiMock())

let shim: ChromeShim

/** 每用例独立注入：offscreen 的 listener 无法反挂，逐用例重载隔离 */
async function loadOffscreen(): Promise<unknown> {
  shim = installChromeShim()
  return await import('../entrypoints/offscreen/offscreen')
}

/** offscreen 注册的唯一 onMessage listener（shim 访问器取副本，直接派发断言返回值） */
function offscreenListener(): MessageListener {
  const l = shim.onMessageListeners()
  expect(l).toHaveLength(1)
  return l[0]!
}

/** 派发微任务（clearClipboard 的 then 链落地） */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  vi.resetModules()
})

afterEach(() => {
  shim?.restore()
  vi.restoreAllMocks()
  // 用例内 defineProperty 的 navigator.clipboard 摘除，防泄漏到其他文件（jsdom 每文件独立，防御性）
  try {
    delete (navigator as unknown as { clipboard?: unknown }).clipboard
  } catch { /* 不可删则留给下个 defineProperty 覆盖 */ }
})

describe('offscreen clear-clipboard 处理（B2-9/10）', () => {
  it('writeText 成功：写空串 + sendResponse({ok:true}) + fire-and-forget ack 消息', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    await loadOffscreen()
    const sendSpy = vi.spyOn(shim.chrome.runtime as { sendMessage: (msg: unknown) => Promise<unknown> }, 'sendMessage')

    // shim 双向通道：listener 返回 true 持开通道，sendResponse 应答即 resolve
    await expect(shim.runtime.receive({ type: 'clear-clipboard' })).resolves.toEqual({ ok: true })
    expect(writeText).toHaveBeenCalledWith('')
    expect(sendSpy).toHaveBeenCalledWith({ type: 'clear-clipboard-ack' })
  })

  it('writeText 被拒（offscreen 无焦点）：textarea + execCommand("copy") 兜底，回执照发', async () => {
    const writeText = vi.fn(async () => {
      throw new DOMException('Document is not focused', 'NotAllowedError')
    })
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const execCommand = vi.fn()
    Object.defineProperty(document, 'execCommand', { value: execCommand, configurable: true })
    await loadOffscreen()

    await expect(shim.runtime.receive({ type: 'clear-clipboard' })).resolves.toEqual({ ok: true })
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(execCommand).toHaveBeenCalledWith('copy')
  })

  it('sendResponse 抛错（channel 已关）：吞掉不扩散，ack 消息照发（SW 感知兜底通道）', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    await loadOffscreen()
    const sendSpy = vi.spyOn(shim.chrome.runtime as { sendMessage: (msg: unknown) => Promise<unknown> }, 'sendMessage')

    // 直接派发并注入抛错的 sendResponse（模拟 SW 已销毁、响应端口关闭）
    const listener = offscreenListener()
    expect(
      listener({ type: 'clear-clipboard' }, {}, () => {
        throw new Error('Attempt to postMessage on disconnected port')
      }),
    ).toBe(true) // 返回 true 持开通道（即使 sendResponse 已不可用）
    await flush()
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(sendSpy).toHaveBeenCalledWith({ type: 'clear-clipboard-ack' })
  })

  it('非 clear-clipboard 消息：不处理、不持通道（返回 undefined）', async () => {
    await loadOffscreen()
    const sendSpy = vi.spyOn(shim.chrome.runtime as { sendMessage: (msg: unknown) => Promise<unknown> }, 'sendMessage')
    const listener = offscreenListener()

    expect(listener({ type: 'sync-push' }, {}, () => {})).toBeUndefined()
    expect(listener(undefined, {}, () => {})).toBeUndefined() // 消息体缺失同样走 ?. 守卫忽略
    await flush()
    expect(sendSpy).not.toHaveBeenCalled()
  })

  it('listener 返回 true（B2-10 通道语义）：receive 应答前 promise 保持悬挂', async () => {
    const writeText = vi.fn(() => new Promise<void>((resolve) => setTimeout(resolve, 20)))
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    await loadOffscreen()

    let settled = false
    const pending = shim.runtime.receive({ type: 'clear-clipboard' }).then((r) => {
      settled = true
      return r
    })
    const pause = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5))
    await pause()
    expect(settled).toBe(false) // clearClipboard 在途：通道未应答（真实异步回执语义）

    await expect(pending).resolves.toEqual({ ok: true })
    expect(writeText).toHaveBeenCalledTimes(1)
  })
})
