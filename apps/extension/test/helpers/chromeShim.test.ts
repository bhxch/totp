/**
 * chromeShim 公共 fixture 自测（P0 验收）：迁移后的四个测试文件已重度使用 storage/onChanged/
 * idle/setBadgeText 路径，此处补齐迁移未触及的新能力契约——alarms 派发、runtime 双向通道
 * （ack / 无监听 reject / 无应答收束 / receive 入站）、idle 按需安装与钩子注入。
 */
import { describe, expect, it, vi } from 'vitest'
import { installChromeShim } from './chromeShim'

describe('storage 三区', () => {
  it('get(null)/get(keys)/set/remove/getBytesInUse 与 QUOTA_BYTES（syncEngine 生产调用形状）', async () => {
    const shim = installChromeShim({ local: { vault: '{"v":1}' } })
    expect(await shim.local.get(null)).toEqual({ vault: '{"v":1}' })
    expect(await shim.local.get(['vault', 'missing'])).toEqual({ vault: '{"v":1}' })
    expect(await shim.local.get('missing')).toEqual({})

    await shim.sync.set({ 'sync:meta': { rev: 2 }, chunk: 'x' })
    expect(shim.sync.data['sync:meta']).toEqual({ rev: 2 })
    await shim.sync.remove(['chunk'])
    expect('chunk' in shim.sync.data).toBe(false)

    await shim.session.set({ dek: 'b64' })
    expect(await shim.session.getBytesInUse()).toBe(JSON.stringify({ dek: 'b64' }).length)
    expect(shim.sync.QUOTA_BYTES).toBe(102_400)
    expect(await shim.local.get(null)).toEqual({ vault: '{"v":1}' }) // 三区互不串
  })

  it('onChanged 经 emit 手动派发（含 areaName），removeListener 生效', async () => {
    const shim = installChromeShim()
    const seen: Array<{ changes: unknown; area: string }> = []
    const listener = (changes: unknown, area: string): void => {
      seen.push({ changes, area })
    }
    shim.onChanged.addListener(listener)

    await shim.local.set({ k: 1 }) // 写盘不自动派发（store.test「先写盘后手动 emit」时序依赖）
    expect(seen).toEqual([])

    shim.emit({ k: { newValue: 1 } })
    shim.emit({ d: { newValue: 'dek' } }, 'session')
    expect(seen).toEqual([
      { changes: { k: { newValue: 1 } }, area: 'local' },
      { changes: { d: { newValue: 'dek' } }, area: 'session' },
    ])

    shim.onChanged.removeListener(listener)
    shim.emit({ k: { newValue: 2 } })
    expect(seen).toHaveLength(2)
  })
})

describe('alarms', () => {
  it('create 记录（name+info）；onAlarm 经 emitAlarm 派发，可移除', () => {
    const shim = installChromeShim()
    shim.alarms.create('clipboard-clear', { delayInMinutes: 0.5 })
    expect(shim.alarms.created).toEqual([{ name: 'clipboard-clear', info: { delayInMinutes: 0.5 } }])

    const got: Array<{ name: string }> = []
    const listener = (a: { name: string }): void => {
      got.push(a)
    }
    shim.alarms.onAlarm.addListener(listener)
    shim.emitAlarm({ name: 'clipboard-clear', scheduledTime: 123 })
    expect(got).toEqual([{ name: 'clipboard-clear', scheduledTime: 123 }])

    shim.alarms.onAlarm.removeListener(listener)
    shim.emitAlarm({ name: 'clipboard-clear' })
    expect(got).toHaveLength(1)
  })
})

describe('runtime 双向通道', () => {
  it('ack：listener 返回 true 持开通道，sendResponse 应答即 resolve', async () => {
    const shim = installChromeShim()
    shim.onMessage.addListener((msg, _sender, sendResponse) => {
      if ((msg as { type?: string }).type === 'clear-clipboard') {
        setTimeout(() => sendResponse({ ok: true }), 0)
        return true
      }
      return undefined
    })

    await expect(shim.runtime.sendMessage({ type: 'clear-clipboard' })).resolves.toEqual({ ok: true })
  })

  it('无监听：reject「Receiving end does not exist」（与 Chrome 一致）', async () => {
    const shim = installChromeShim()
    await expect(shim.runtime.sendMessage({ type: 'sync-push' })).rejects.toThrow(/Receiving end does not exist/)
  })

  it('有监听但未持通道：按「无应答」resolve undefined', async () => {
    const shim = installChromeShim()
    shim.onMessage.addListener(() => undefined)
    await expect(shim.runtime.sendMessage({ type: 'sync-push' })).resolves.toBeUndefined()
    expect(shim.runtime.messageListenerCount()).toBe(1)
  })

  it('receive 模拟入站消息（pendingOtpauth 通道），sendResponse 应答回传', async () => {
    const shim = installChromeShim({ local: { pendingOtpauth: 'otpauth://totp/x' } })
    shim.onMessage.addListener((msg, _sender, sendResponse) => {
      if ((msg as { type?: string }).type === 'get-pending') {
        sendResponse(shim.local.data['pendingOtpauth'] ?? null)
      }
      return undefined
    })
    await expect(shim.runtime.receive({ type: 'get-pending' })).resolves.toBe('otpauth://totp/x')
  })
})

describe('idle 与 action', () => {
  it('opts.idle 给出才安装；调用记录恒保留；state/on* 钩子可注入', () => {
    const withoutIdle = installChromeShim()
    expect(withoutIdle.chrome.idle).toBeUndefined() // lockEnforcer「宿主无 idle 权限」用例前提

    const onSet = vi.fn()
    const shim = installChromeShim({
      idle: { onSetDetectionInterval: onSet, onQueryState: (cb) => cb('locked') },
    })
    const idle = shim.idle!
    idle.setDetectionInterval(300)
    const states: Array<'active' | 'idle' | 'locked'> = []
    idle.queryState(300, (s) => states.push(s))
    expect(states).toEqual(['locked']) // onQueryState 钩子优先于默认 state 应答
    expect(idle.calls.setDetectionInterval).toEqual([300])
    expect(idle.calls.queryState).toEqual([300])
    expect(onSet).toHaveBeenCalledWith(300)

    idle.onQueryState = null
    idle.state = 'idle'
    idle.queryState(15, (s) => states.push(s))
    expect(states).toEqual(['locked', 'idle'])
  })

  it('setBadgeText 为 vi.fn（store badge 对账断言通道）', () => {
    const shim = installChromeShim()
    shim.setBadgeText({ text: '!' })
    expect(shim.setBadgeText).toHaveBeenCalledWith({ text: '!' })
  })
})

describe('注入生命周期', () => {
  it('注入 globalThis.chrome；restore 还原到原始状态', () => {
    const g = globalThis as unknown as { chrome?: unknown }
    const original = g.chrome
    const shim = installChromeShim()
    expect(g.chrome).toBe(shim.chrome)
    shim.restore()
    expect(g.chrome).toBe(original)

    delete (globalThis as unknown as { chrome?: unknown }).chrome
    const shim2 = installChromeShim()
    shim2.restore()
    expect(g.chrome).toBeUndefined()
    if (original !== undefined) g.chrome = original // 用例间不互踩
  })
})
