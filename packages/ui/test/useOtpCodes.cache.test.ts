import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, ref, type Ref } from 'vue'
import { computeEntryCode, type OtpEntry } from '@totp/core'
import { useOtpCodes } from '../src/composables/useOtpCodes'

// mock 展开式（importActual 先例）：仅包 computeEntryCode 计数，其余取 actual（OtpEntry 等类型不受影响）
vi.mock('@totp/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@totp/core')>()
  return { ...actual, computeEntryCode: vi.fn(actual.computeEntryCode) }
})

const entry: OtpEntry = {
  uuid: 'a', type: 'totp', issuer: 'GitHub', label: 'me@ex.com', secret: 'JBSWY3DPEHPK3PXP',
  algorithm: 'SHA1', digits: 6, period: 30, tagIds: [], order: 0, createdAt: 0,
}

// 1_700_000_000_000 → nowSec=1_700_000_000：mod 30 = 20（窗口内剩余 10s，余量足够推进不跨窗）
const T0 = 1_700_000_000_000

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(T0)
  vi.mocked(computeEntryCode).mockClear()
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const computeCalls = () => vi.mocked(computeEntryCode).mock.calls.length

describe('useOtpCodes 窗口缓存（2026-09-28 性能批：同窗口内跳过 HMAC）', () => {
  it('同窗口内每秒重算仅刷新时间字段，不重复 computeEntryCode；跨窗口后重算一次', async () => {
    const scope = effectScope()
    let api: ReturnType<typeof useOtpCodes> | null = null
    scope.run(() => { api = useOtpCodes(ref([entry]) as Ref<OtpEntry[]>) })
    const codes = api!.codes
    await vi.waitFor(() => expect(codes.value.get('a')).toBeDefined())
    expect(computeCalls()).toBe(1) // 首算

    await vi.advanceTimersByTimeAsync(3_000) // 窗口内（余 10s）推进 3s
    expect(computeCalls()).toBe(1) // 缓存命中：无新 HMAC
    const c = codes.value.get('a')!
    expect(c.remaining).toBe(7) // 10 - 3
    expect(c.progress).toBeCloseTo(7 / 30, 5)
    expect(c.code).toMatch(/^\d{6}$/) // 码值照常可用

    await vi.advanceTimersByTimeAsync(12_000) // 跨过窗口边界
    expect(computeCalls()).toBe(2) // 仅窗口轮换触发一次重算
    expect(codes.value.get('a')!.remaining).toBeLessThanOrEqual(30)
    scope.stop()
  })

  it('条目被编辑（对象引用替换）→ 同窗口也强制重算，且用新内容', async () => {
    const entries = ref<OtpEntry[]>([entry])
    const scope = effectScope()
    let api: ReturnType<typeof useOtpCodes> | null = null
    scope.run(() => { api = useOtpCodes(entries) })
    await vi.waitFor(() => expect(api!.codes.value.get('a')).toBeDefined())
    expect(computeCalls()).toBe(1)

    const edited: OtpEntry = { ...entry, secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ' }
    entries.value = [edited]
    await vi.advanceTimersByTimeAsync(1_000)
    expect(computeCalls()).toBe(2) // 引用变化 → 不吃缓存
    // ref 深 reactive：recompute 拿到的是代理对象，断言按内容比较（secret 已是编辑后的新值）
    expect(vi.mocked(computeEntryCode).mock.calls.at(-1)![0].secret).toBe(edited.secret)
    scope.stop()
  })

  it('INVALID 错误条目不缓存：每秒重试（secret 修复后可自愈），好条目同窗口不受影响', async () => {
    const bad: OtpEntry = { ...entry, uuid: 'bad', secret: '!!!非法 base32!!!' }
    const scope = effectScope()
    let api: ReturnType<typeof useOtpCodes> | null = null
    scope.run(() => { api = useOtpCodes(ref([entry, bad]) as Ref<OtpEntry[]>) })
    await vi.waitFor(() => expect(api!.codes.value.get('bad')!.code).toBe('INVALID'))
    const n0 = computeCalls()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(computeCalls()).toBe(n0 + 2) // bad 每秒重试；good 同窗口不重算（n0 含 good 1 次 + bad 2 次）
    expect(api!.codes.value.get('bad')!.code).toBe('INVALID')
    scope.stop()
  })
})

describe('useOtpCodes 后台节流（document.hidden 停表，可见恢复立即重算）', () => {
  function setHidden(v: boolean) {
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(v)
    document.dispatchEvent(new Event('visibilitychange'))
  }

  it('hidden → 停表（nowMs 不再推进）；恢复可见 → 立即重算并续表', async () => {
    const scope = effectScope()
    let api: ReturnType<typeof useOtpCodes> | null = null
    scope.run(() => { api = useOtpCodes(ref([entry]) as Ref<OtpEntry[]>) })
    await vi.waitFor(() => expect(api!.codes.value.get('a')).toBeDefined())
    const now0 = api!.nowMs.value

    setHidden(true)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(api!.nowMs.value).toBe(now0) // 表已停

    setHidden(false)
    expect(api!.nowMs.value).toBe(Date.now()) // 恢复瞬间立即重算
    const now1 = api!.nowMs.value
    await vi.advanceTimersByTimeAsync(1_000)
    expect(api!.nowMs.value).toBe(now1 + 1000) // interval 已续
    scope.stop()
  })

  it('scope.stop 后 visibility 监听一并清理：再派发事件不复活重算', async () => {
    const scope = effectScope()
    let api: ReturnType<typeof useOtpCodes> | null = null
    scope.run(() => { api = useOtpCodes(ref([entry]) as Ref<OtpEntry[]>) })
    await vi.waitFor(() => expect(api!.codes.value.get('a')).toBeDefined())
    const now0 = api!.nowMs.value
    scope.stop()

    setHidden(false) // 若监听未清，会触发立即重算更新 nowMs
    await vi.advanceTimersByTimeAsync(3_000)
    expect(api!.nowMs.value).toBe(now0)
  })
})
