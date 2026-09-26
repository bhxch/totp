/** R7：卡片基建组合式函数用例——useAsyncMessage / useAutoPrefs / useConfirmPattern */
import { describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { useAsyncMessage } from '../src/composables/useAsyncMessage'
import { useAutoPrefs, type AutoPrefsChannel, type AutoPrefsShape } from '../src/composables/useAutoPrefs'
import { useConfirmPattern } from '../src/composables/confirmPattern'

const PREFS: AutoPrefsShape = { onChange: false, onInterval: false, intervalMinutes: 60 }

function channelOf(over: Partial<AutoPrefsChannel<AutoPrefsShape>> = {}): AutoPrefsChannel<AutoPrefsShape> {
  return { get: () => ({ ...PREFS }), set: () => {}, ...over }
}

describe('useAsyncMessage', () => {
  it('fail：Error 取 message、非 Error String()，均置 err 态', () => {
    const { msg, msgKind, fail } = useAsyncMessage()
    fail(new Error('boom'))
    expect(msg.value).toBe('boom')
    expect(msgKind.value).toBe('err')
    fail(42)
    expect(msg.value).toBe('42')
    expect(msgKind.value).toBe('err')
  })

  it('run：成功置 okMsg（ok 态）返回 true；失败经 fail 返回 false；busy 恒复位', async () => {
    const { busy, msg, msgKind, run } = useAsyncMessage()
    const ok = await run(async () => {}, 'done')
    expect(ok).toBe(true)
    expect(msg.value).toBe('done')
    expect(msgKind.value).toBe('ok')
    expect(busy.value).toBe(false)

    const notOk = await run(async () => {
      busy.value = true
      throw new Error('boom')
    }, 'done')
    expect(notOk).toBe(false)
    expect(msg.value).toBe('boom')
    expect(msgKind.value).toBe('err')
    expect(busy.value).toBe(false)
  })
})

describe('useAutoPrefs', () => {
  it('load：get 同步/异步形态均兼容；读取失败保持默认值', async () => {
    const a = useAutoPrefs(() => channelOf({ get: () => ({ onChange: true, onInterval: false, intervalMinutes: 15 }) }))
    await a.load()
    expect(a.autoPrefs.value).toEqual({ onChange: true, onInterval: false, intervalMinutes: 15 })

    const b = useAutoPrefs(() => channelOf({ get: () => Promise.resolve({ onChange: false, onInterval: true, intervalMinutes: 360 }) }))
    await b.load()
    expect(b.autoPrefs.value).toEqual({ onChange: false, onInterval: true, intervalMinutes: 360 })

    const c = useAutoPrefs(() => channelOf({ get: () => Promise.reject(new Error('x')) }))
    await c.load()
    expect(c.autoPrefs.value).toEqual(PREFS)
  })

  it('load 同步 get：调用栈内同步落初值（无 await 窗口），不与挂载后的立即操作竞态', () => {
    const a = useAutoPrefs(() => channelOf({ get: () => ({ onChange: true, onInterval: false, intervalMinutes: 15 }) }))
    void a.load()
    expect(a.autoPrefs.value).toEqual({ onChange: true, onInterval: false, intervalMinutes: 15 })
  })

  it('load/refreshStatus：loadStatus 失败保持旧值（初始 null），成功置文本', async () => {
    let status: string | null = null
    let boom = false
    const a = useAutoPrefs(() => channelOf(), { loadStatus: () => (boom ? Promise.reject(new Error('x')) : status) })
    await a.load()
    expect(a.autoStatus.value).toBeNull()
    status = '昨天 12:00'
    await a.refreshStatus()
    expect(a.autoStatus.value).toBe('昨天 12:00')
    boom = true
    await a.refreshStatus()
    expect(a.autoStatus.value).toBe('昨天 12:00') // 失败保持旧值，不清成「暂无」
  })

  it('三个 handler：内存即时前进并整体回写（连续切换不丢字段）', async () => {
    const seen: AutoPrefsShape[] = []
    const a = useAutoPrefs(() => channelOf({ set: (p) => { seen.push({ ...p }) } }))
    a.onAutoOnChange(true)
    await flushPromises()
    a.onAutoIntervalToggle(true)
    await flushPromises()
    a.onIntervalChange('360')
    await flushPromises()
    expect(seen).toEqual([
      { onChange: true, onInterval: false, intervalMinutes: 60 },
      { onChange: true, onInterval: true, intervalMinutes: 60 },
      { onChange: true, onInterval: true, intervalMinutes: 360 },
    ])
    expect(a.autoPrefs.value).toEqual({ onChange: true, onInterval: true, intervalMinutes: 360 })
  })

  it('回写失败走 onError 而非未处理 rejection；channel 为 null 时整体 no-op', async () => {
    const onError = vi.fn()
    const a = useAutoPrefs(() => channelOf({ set: () => Promise.reject(new Error('write-fail')) }), { onError })
    a.onAutoOnChange(true)
    await flushPromises()
    expect(onError).toHaveBeenCalledTimes(1)

    const b = useAutoPrefs(() => null)
    expect(() => b.onIntervalChange(15)).not.toThrow()
    await flushPromises()
    expect(b.autoPrefs.value).toEqual({ onChange: false, onInterval: false, intervalMinutes: 15 }) // 内存仍前进，回写 no-op
  })
})

describe('useConfirmPattern', () => {
  it('ask 互斥：进入新槽前清空同组其余槽；anyPending 反映任一挂起', () => {
    const c = useConfirmPattern(['adopt', 'reset', 'remove'])
    expect(c.anyPending.value).toBe(false)
    c.ask('reset', 's1')
    expect(c.slots.reset.value).toBe('s1')
    expect(c.anyPending.value).toBe(true)
    c.ask('remove', 's2')
    expect(c.slots.reset.value).toBeNull()
    expect(c.slots.remove.value).toBe('s2')
  })

  it('槽可绕过 ask 直接赋值（同步结果发起的挂起），cancel 收起', () => {
    const c = useConfirmPattern(['adopt', 'reset'])
    c.slots.adopt.value = 'vault-json'
    expect(c.anyPending.value).toBe(true)
    c.cancel('adopt')
    expect(c.slots.adopt.value).toBeNull()
    expect(c.anyPending.value).toBe(false)
  })
})
