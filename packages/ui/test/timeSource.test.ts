import { afterEach, describe, expect, it, vi } from 'vitest'
import { watch } from 'vue'
import { EMPTY_TIME_SYNC_STATE, TIME_SYNC_TTL_MS, type TimeSyncState } from '@totp/core'
import { initTimeSync, timeSource } from '../src/timeSource'

/** 已成功但陈旧的状态：syncedAt=1000（1970 年），远超任何 TTL 判据 */
function okState(offsetMs = 500): TimeSyncState {
  return { ...EMPTY_TIME_SYNC_STATE, offsetMs, syncedAt: 1000, sourceId: 'baidu' }
}
/** 已成功且新鲜的状态（syncedAt=此刻）：network 模式下 bootstrap 与 tick 均不触发自动校准 */
function freshState(offsetMs = 500): TimeSyncState {
  const now = Date.now()
  return { ...okState(offsetMs), syncedAt: now, lastAttemptAt: now }
}
/** 装配原则（裁定 R5）：默认 device 模式（isNetworkMode false）——不测自动路径的用例不受
 *  bootstrap 自动校准干扰（否则与手动 calibrateNow 抢 syncing / 消耗 mockOnce 造成竞态）；
 *  测自动路径的用例显式叠加 NETWORK */
function makeDeps(overrides: Partial<Parameters<typeof initTimeSync>[0]> = {}) {
  const calibrate = vi.fn(async (preferred: string | null) => ({ offsetMs: 1234, sourceId: preferred ?? 'baidu' }))
  return {
    deps: {
      load: vi.fn(async (): Promise<TimeSyncState | null> => null),
      save: vi.fn(async () => {}),
      isNetworkMode: vi.fn(() => false),
      calibrate,
      ...overrides,
    },
    calibrate,
  }
}
const NETWORK = { isNetworkMode: () => true }
/** 让出一个宏任务：等在途微任务链（bootstrap/静默校准）全部落定 */
const macrotask = () => new Promise<void>((r) => setTimeout(r, 0))

afterEach(() => {
  vi.useRealTimers() // 个别用例冻结 Date 推进 TTL，统一还原
})

describe('未安装降级实例（Review Focus 5）', () => {
  // 本组依赖模块单例初始态：首例必须是本文件最先触达 timeSource/initTimeSync 的用例（其后
  // 用例均经 initTimeSync 覆盖安装；vi.resetModules 对静态 import 的模块单例无效，故不用）
  it('fresh 模块态 timeSource()：effectiveNow=Date.now()、calibrate 恒败', async () => {
    const before = Date.now()
    const ts = timeSource()
    expect(Math.abs(ts.effectiveNowMs() - before)).toBeLessThan(50)
    expect(ts.state.value).toEqual(EMPTY_TIME_SYNC_STATE)
    expect(ts.syncing.value).toBe(false)
    await expect(ts.calibrateNow()).rejects.toThrow()
  })
  it('降级实例零网络：tick/跳变/冷启动入口均不发起校准', async () => {
    const ts = timeSource()
    const st0 = ts.state.value
    const now = Date.now()
    ts.ensureAutoCalibrate()
    ts.noteDeviceTick(now)
    ts.noteDeviceTick(now - 10_000) // 回退 10s
    ts.noteDeviceTick(now + 3_600_000) // 前跳 1h
    expect(ts.syncing.value).toBe(false) // 校准一旦发起 syncing 即同步置位
    await macrotask()
    expect(ts.state.value).toBe(st0) // 无任何状态替换（出码层 watch 不被惊动）
    expect(Math.abs(ts.effectiveNowMs() - Date.now())).toBeLessThan(50)
  })
})

describe('initTimeSync 装配', () => {
  it('bootstrap load 装入已存状态；返回值即当前单例', async () => {
    const { deps } = makeDeps({ load: vi.fn(async () => okState(700)) })
    const ctl = initTimeSync(deps)
    expect(timeSource()).toBe(ctl)
    await vi.waitFor(() => expect(timeSource().state.value.offsetMs).toBe(700))
  })
  it('bootstrap 后 network 模式从未尝试 → 自动校准一次并落盘', async () => {
    const { deps, calibrate } = makeDeps(NETWORK)
    initTimeSync(deps)
    await vi.waitFor(() => expect(calibrate).toHaveBeenCalledWith(null))
    await vi.waitFor(() => expect(deps.save).toHaveBeenCalled())
    expect(timeSource().state.value.offsetMs).toBe(1234)
    expect(timeSource().state.value.sourceId).toBe('baidu')
    expect(calibrate).toHaveBeenCalledTimes(1)
  })
  it('冷启动 10min 判据（裁定 R13）：20min 龄的成功状态 bootstrap 即重校（6h 判据下不会触发）', async () => {
    const aged = { ...okState(100), syncedAt: Date.now() - 20 * 60 * 1000 }
    const { deps, calibrate } = makeDeps({ ...NETWORK, load: vi.fn(async () => aged) })
    initTimeSync(deps)
    await vi.waitFor(() => expect(calibrate).toHaveBeenCalled())
  })
  it('load 失败：静默保持空状态（降级语义），手动校准仍可用', async () => {
    const { deps } = makeDeps({ load: vi.fn(async () => { throw new Error('io') }) })
    initTimeSync(deps)
    await macrotask()
    expect(timeSource().state.value).toEqual(EMPTY_TIME_SYNC_STATE)
    await expect(timeSource().calibrateNow()).resolves.toMatchObject({ offsetMs: 1234 })
  })
  it('覆盖安装：装载在途即被取代的旧实例放弃 bootstrap（不写状态、不发起校准）', async () => {
    let resolveOld!: (s: TimeSyncState | null) => void
    const old = makeDeps({
      ...NETWORK,
      load: vi.fn(() => new Promise<TimeSyncState | null>((r) => { resolveOld = r })),
    })
    const oldCtl = initTimeSync(old.deps)
    const cur = makeDeps({ load: vi.fn(async () => okState(700)) })
    const curCtl = initTimeSync(cur.deps)
    expect(timeSource()).toBe(curCtl)
    await vi.waitFor(() => expect(curCtl.state.value.offsetMs).toBe(700))
    resolveOld(okState(9999)) // 旧实例的装载此刻才完成
    await macrotask()
    expect(oldCtl.state.value).toEqual(EMPTY_TIME_SYNC_STATE)
    expect(old.calibrate).not.toHaveBeenCalled() // network + 陈旧本应重校：已被取代故放弃
    expect(curCtl.state.value.offsetMs).toBe(700)
  })
})

describe('effectiveNowMs', () => {
  it('network+有偏移：Date.now()+offset', async () => {
    // 新鲜状态：network 模式 bootstrap 不重校，偏移保持装载值
    const { deps } = makeDeps({ ...NETWORK, load: vi.fn(async () => freshState(2000)) })
    initTimeSync(deps)
    await vi.waitFor(() => expect(timeSource().state.value.offsetMs).toBe(2000))
    const before = Date.now()
    const got = timeSource().effectiveNowMs()
    expect(got - before).toBeGreaterThanOrEqual(1990)
    expect(got - before).toBeLessThan(2100)
  })
  it('device 模式：偏移不生效（Review Focus 5）', async () => {
    const { deps } = makeDeps({ load: vi.fn(async () => okState(2000)), isNetworkMode: () => false })
    initTimeSync(deps)
    await vi.waitFor(() => expect(timeSource().state.value.offsetMs).toBe(2000))
    expect(Math.abs(timeSource().effectiveNowMs() - Date.now())).toBeLessThan(50)
    expect(deps.calibrate).not.toHaveBeenCalled() // 自动路径也被模式短路
  })
  it('network 但偏移 null（未成功过）：回退设备时间', async () => {
    // 刚失败（退避期内）：network 模式 bootstrap 不重试，偏移保持 null
    const failed = { ...EMPTY_TIME_SYNC_STATE, lastAttemptAt: Date.now(), lastAttemptFailed: true }
    const { deps, calibrate } = makeDeps({ ...NETWORK, load: vi.fn(async () => failed) })
    initTimeSync(deps)
    await vi.waitFor(() => expect(timeSource().state.value.lastAttemptFailed).toBe(true))
    expect(Math.abs(timeSource().effectiveNowMs() - Date.now())).toBeLessThan(50)
    expect(calibrate).not.toHaveBeenCalled()
  })
})

describe('自动重校：TTL 与退避（spec §3-③⑤）', () => {
  it('TTL 超龄（7h）：bootstrap 即静默重校', async () => {
    const stale = { ...okState(100), syncedAt: Date.now() - 7 * 60 * 60 * 1000 }
    const { deps, calibrate } = makeDeps({ ...NETWORK, load: vi.fn(async () => stale) })
    initTimeSync(deps)
    await vi.waitFor(() => expect(calibrate).toHaveBeenCalled()) // TTL 超龄自动重校
  })
  it('tick 路径用默认 6h 判据：20min 龄不触发（区别于冷启动 10min，裁定 R13）', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const { deps, calibrate } = makeDeps({ ...NETWORK, load: vi.fn(async () => freshState()) })
    initTimeSync(deps)
    await vi.waitFor(() => expect(timeSource().state.value.offsetMs).toBe(500))
    vi.setSystemTime(Date.now() + 20 * 60 * 1000)
    timeSource().noteDeviceTick(Date.now()) // 本实例首个 tick：无基准不判跳变，仅 TTL 决策
    expect(calibrate).not.toHaveBeenCalled()
  })
  it('tick 路径 TTL 超龄（≥6h）→ 静默重校', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const { deps, calibrate } = makeDeps({ ...NETWORK, load: vi.fn(async () => freshState()) })
    initTimeSync(deps)
    await vi.waitFor(() => expect(timeSource().state.value.offsetMs).toBe(500))
    expect(calibrate).not.toHaveBeenCalled() // 新鲜：bootstrap 不触发
    vi.setSystemTime(Date.now() + TIME_SYNC_TTL_MS)
    timeSource().noteDeviceTick(Date.now()) // 首个 tick：仅 TTL 决策
    expect(calibrate).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(timeSource().state.value.offsetMs).toBe(1234))
  })
  it('退避期内 noteDeviceTick 不重校（自动路径）', async () => {
    const backed = { ...EMPTY_TIME_SYNC_STATE, lastAttemptAt: Date.now(), lastAttemptFailed: true }
    const { deps, calibrate } = makeDeps({ ...NETWORK, load: vi.fn(async () => backed) })
    initTimeSync(deps)
    await vi.waitFor(() => expect(timeSource().state.value.lastAttemptFailed).toBe(true))
    timeSource().noteDeviceTick(Date.now())
    expect(calibrate).not.toHaveBeenCalled()
  })
  it('ensureAutoCalibrate 幂等互斥：在途与新鲜期内重复调用不追加请求', async () => {
    const { deps, calibrate } = makeDeps(NETWORK)
    let release!: () => void
    calibrate.mockImplementationOnce(() => new Promise<void>((r) => { release = r as () => void }).then(() => ({ offsetMs: 42, sourceId: 'baidu' })))
    const ctl = initTimeSync(deps)
    await vi.waitFor(() => expect(calibrate).toHaveBeenCalledTimes(1)) // bootstrap 触发（从未尝试）
    expect(ctl.syncing.value).toBe(true)
    ctl.ensureAutoCalibrate()
    ctl.ensureAutoCalibrate() // 在途：互斥
    expect(calibrate).toHaveBeenCalledTimes(1)
    release()
    await vi.waitFor(() => expect(ctl.syncing.value).toBe(false))
    expect(ctl.state.value.offsetMs).toBe(42)
    ctl.ensureAutoCalibrate() // 刚成功（<10min）：不再触发
    expect(calibrate).toHaveBeenCalledTimes(1)
  })
})

describe('noteDeviceTick 跳变（spec §3-④）', () => {
  it('跳变回退触发静默重校（Review Focus 4 集成侧）', async () => {
    // network + 新鲜成功状态：bootstrap/TTL 均不触发，重校只可能来自跳变分支
    const { deps, calibrate } = makeDeps({ ...NETWORK, load: vi.fn(async () => freshState()) })
    initTimeSync(deps)
    await vi.waitFor(() => expect(timeSource().state.value.offsetMs).toBe(500))
    expect(calibrate).not.toHaveBeenCalled()
    const t = Date.now()
    timeSource().noteDeviceTick(t)
    expect(calibrate).not.toHaveBeenCalled()
    timeSource().noteDeviceTick(t - 10_000) // 回退 10s
    await vi.waitFor(() => expect(calibrate).toHaveBeenCalled())
    // 基准已随跳变更新：重校落定后的正常 tick 不再重复触发
    await vi.waitFor(() => expect(timeSource().state.value.offsetMs).toBe(1234))
    timeSource().noteDeviceTick(t - 9_000)
    expect(calibrate).toHaveBeenCalledTimes(1)
  })
  it('正常 tick 不触发', async () => {
    const { deps, calibrate } = makeDeps({ ...NETWORK, load: vi.fn(async () => freshState()) })
    initTimeSync(deps)
    await vi.waitFor(() => expect(timeSource().state.value.offsetMs).toBe(500))
    const t = Date.now()
    timeSource().noteDeviceTick(t)
    timeSource().noteDeviceTick(t + 1000)
    expect(calibrate).not.toHaveBeenCalled()
  })
  it('device 模式跳变不触发（裁定 R4：零网络，仅更新基准）', async () => {
    let network = false
    const { deps, calibrate } = makeDeps({ isNetworkMode: () => network, load: vi.fn(async () => freshState()) })
    initTimeSync(deps)
    await vi.waitFor(() => expect(timeSource().state.value.offsetMs).toBe(500))
    const t = Date.now()
    timeSource().noteDeviceTick(t)
    expect(() => timeSource().noteDeviceTick(t - 10_000)).not.toThrow() // 回退 10s
    expect(calibrate).not.toHaveBeenCalled()
    expect(timeSource().syncing.value).toBe(false)
    // 基准已更新为回退后的读数：切到 network 后的正常 tick 不把旧基准误判成跳变
    network = true
    timeSource().noteDeviceTick(t - 9_000)
    expect(calibrate).not.toHaveBeenCalled()
  })
})

describe('calibrateNow（Review Focus 3）', () => {
  it('成功：更新 state（含 preferred 保留）并落盘', async () => {
    const { deps } = makeDeps({ load: vi.fn(async () => ({ ...EMPTY_TIME_SYNC_STATE, preferredSourceId: 'jd' })) })
    initTimeSync(deps)
    await vi.waitFor(() => expect(timeSource().state.value.preferredSourceId).toBe('jd'))
    const st = await timeSource().calibrateNow()
    expect(st.offsetMs).toBe(1234)
    expect(st.sourceId).toBe('jd') // preferred 优先于 deps 内置
    expect(st.lastAttemptFailed).toBe(false)
    expect(st.preferredSourceId).toBe('jd')
    expect(timeSource().state.value).toBe(st)
    expect(deps.save).toHaveBeenLastCalledWith(st)
  })
  it('失败：lastAttemptFailed 置位 + 落盘 + rethrow；退避期内手动仍可重试', async () => {
    const { deps, calibrate } = makeDeps()
    calibrate.mockRejectedValueOnce(new Error('down'))
    initTimeSync(deps)
    await expect(timeSource().calibrateNow()).rejects.toThrow('down')
    await vi.waitFor(() => expect(timeSource().state.value.lastAttemptFailed).toBe(true))
    expect(deps.save).toHaveBeenLastCalledWith(expect.objectContaining({ lastAttemptFailed: true, offsetMs: null }))
    await expect(timeSource().calibrateNow()).resolves.toBeTruthy() // 退避不约束手动
  })
  it('syncing 互斥：在途调用直接返回当前 state', async () => {
    const { deps, calibrate } = makeDeps()
    let release!: () => void
    calibrate.mockImplementation(() => new Promise<void>((r) => { release = r as () => void }).then(() => ({ offsetMs: 1, sourceId: 'baidu' })))
    initTimeSync(deps)
    const p1 = timeSource().calibrateNow()
    const st2 = await timeSource().calibrateNow() // 在途：立即返回不二次请求
    expect(st2.offsetMs).toBeNull()
    release()
    await p1
    expect(calibrate).toHaveBeenCalledTimes(1)
  })
  it('opts.preferredSourceId 显式覆盖：非 null 透传并记为偏好；null=本次走内置顺序且不清既有偏好', async () => {
    const { deps, calibrate } = makeDeps()
    initTimeSync(deps)
    const st1 = await timeSource().calibrateNow({ preferredSourceId: 'tuna' })
    expect(calibrate).toHaveBeenLastCalledWith('tuna')
    expect(st1.preferredSourceId).toBe('tuna')
    const st2 = await timeSource().calibrateNow({ preferredSourceId: null })
    expect(calibrate).toHaveBeenLastCalledWith(null)
    expect(st2.preferredSourceId).toBe('tuna')
  })
  it('校准器回非有限偏移（NaN/±Infinity）→ 视为失败：rethrow、保留旧偏移、记失败并落盘（评审 M4）', async () => {
    const { deps, calibrate } = makeDeps({ load: vi.fn(async () => okState(700)) })
    initTimeSync(deps)
    await vi.waitFor(() => expect(timeSource().state.value.offsetMs).toBe(700))
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      calibrate.mockResolvedValueOnce({ offsetMs: bad, sourceId: 'baidu' })
      await expect(timeSource().calibrateNow()).rejects.toThrow()
      const st = timeSource().state.value
      expect(st.offsetMs).toBe(700) // 旧偏移不被污染
      expect(st.syncedAt).toBe(1000)
      expect(st.lastAttemptFailed).toBe(true)
    }
    expect(deps.save).toHaveBeenLastCalledWith(expect.objectContaining({ offsetMs: 700, lastAttemptFailed: true }))
    expect(timeSource().syncing.value).toBe(false)
  })
  it('静默路径同样拒收非有限偏移：记失败不抛（评审 M4）', async () => {
    const { deps, calibrate } = makeDeps(NETWORK)
    calibrate.mockResolvedValue({ offsetMs: Number.NaN, sourceId: 'baidu' })
    initTimeSync(deps)
    await vi.waitFor(() => expect(timeSource().state.value.lastAttemptFailed).toBe(true))
    expect(timeSource().state.value.offsetMs).toBeNull()
    expect(Number.isFinite(timeSource().effectiveNowMs())).toBe(true)
    await vi.waitFor(() => expect(timeSource().syncing.value).toBe(false))
  })
  it('落盘失败不影响内存态：成功校准仍被采纳、不误记失败', async () => {
    const { deps } = makeDeps({ save: vi.fn(async () => { throw new Error('quota') }) })
    initTimeSync(deps)
    const st = await timeSource().calibrateNow()
    expect(st.offsetMs).toBe(1234)
    expect(st.lastAttemptFailed).toBe(false)
    expect(timeSource().state.value).toBe(st)
    expect(timeSource().syncing.value).toBe(false)
    await expect(timeSource().setPreferredSource('gitee')).resolves.toBeUndefined()
    expect(timeSource().state.value.preferredSourceId).toBe('gitee')
  })
})

describe('setPreferredSource', () => {
  it('仅更新偏好并落盘，不触发校准', async () => {
    const { deps, calibrate } = makeDeps()
    initTimeSync(deps)
    await vi.waitFor(() => expect(timeSource().state.value).toEqual(EMPTY_TIME_SYNC_STATE))
    calibrate.mockClear()
    await timeSource().setPreferredSource('gitee')
    expect(timeSource().state.value.preferredSourceId).toBe('gitee')
    expect(deps.save).toHaveBeenCalled()
    expect(calibrate).not.toHaveBeenCalled()
    await timeSource().setPreferredSource('gitee') // 同值：no-op 不重复落盘
    expect(deps.save).toHaveBeenCalledTimes(1)
    await timeSource().setPreferredSource(null)
    expect(timeSource().state.value.preferredSourceId).toBeNull()
  })
})

describe('state 替换触发 watch（出码联动）', () => {
  it('state 引用替换（浅 watch 生效）', async () => {
    const seen: TimeSyncState[] = []
    const { deps } = makeDeps()
    initTimeSync(deps)
    await vi.waitFor(() => expect(timeSource().state.value).toEqual(EMPTY_TIME_SYNC_STATE))
    const stop = watch(timeSource().state, (s) => seen.push(s))
    await timeSource().calibrateNow()
    await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0))
    stop()
    expect(seen[seen.length - 1]!.offsetMs).toBe(1234)
  })
})
