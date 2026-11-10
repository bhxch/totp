import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, ref, watch, type Ref } from 'vue'
import { computeEntryCode, EMPTY_TIME_SYNC_STATE, TIME_SYNC_TTL_MS, type OtpEntry, type TimeSyncState } from '@totp/core'
import { useOtpCodes } from '../src/composables/useOtpCodes'
import { initTimeSync, timeSource, type TimeSyncController } from '../src/timeSource'

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
/** 可控装载：模拟本地键 IO 尚未回包（扩展端 storage.local.get 是真异步），由用例决定何时落定 */
function deferredLoad() {
  let settle!: (s: TimeSyncState | null) => void
  let fail!: (e: unknown) => void
  const load = vi.fn(() => new Promise<TimeSyncState | null>((res, rej) => { settle = res; fail = rej }))
  return { load, settle: (s: TimeSyncState | null) => settle(s), fail: (e: unknown) => fail(e) }
}
/** 可控校准器：让下一次校准请求挂起，由用例决定何时成功/失败落定 */
function deferCalibrate(calibrate: ReturnType<typeof makeDeps>['calibrate']) {
  type R = { offsetMs: number; sourceId: string }
  let ok!: (r: R) => void
  let fail!: (e: unknown) => void
  calibrate.mockImplementationOnce(() => new Promise<R>((res, rej) => { ok = res; fail = rej }))
  return { ok: (r: R) => ok(r), fail: (e: unknown) => fail(e) }
}

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
    const oldLoad = deferredLoad()
    const old = makeDeps({ ...NETWORK, load: oldLoad.load })
    const oldCtl = initTimeSync(old.deps)
    const cur = makeDeps({ load: vi.fn(async () => okState(700)) })
    const curCtl = initTimeSync(cur.deps)
    expect(timeSource()).toBe(curCtl)
    await vi.waitFor(() => expect(curCtl.state.value.offsetMs).toBe(700))
    oldLoad.settle(okState(9999)) // 旧实例的装载此刻才完成
    await macrotask()
    expect(oldCtl.state.value).toEqual(EMPTY_TIME_SYNC_STATE)
    expect(old.calibrate).not.toHaveBeenCalled() // network + 陈旧本应重校：已被取代故放弃
    expect(curCtl.state.value.offsetMs).toBe(700)
    // 被取代实例的闸门不再打开：即便有人继续调它的自动入口，也不会对空状态做决策
    oldCtl.ensureAutoCalibrate()
    oldCtl.noteDeviceTick(Date.now())
    await macrotask()
    expect(old.calibrate).not.toHaveBeenCalled()
  })
})

describe('装载闸门：本地键装载落定前不做自动决策（评审 I-1 / MN-1 / MN-5）', () => {
  it('落定前零校准请求：tick / 跳变 / 冷启动入口只更新基准；落定后按装载值决策（新鲜 → 仍为 0）', async () => {
    const d = deferredLoad()
    const { deps, calibrate } = makeDeps({ ...NETWORK, load: d.load })
    const ctl = initTimeSync(deps)
    const t = Date.now()
    ctl.noteDeviceTick(t) // 安装后立即 tick：若对空状态做 TTL 决策，此刻就会发起
    ctl.ensureAutoCalibrate()
    ctl.noteDeviceTick(t - 10_000) // 回退 10s：落定前不判跳变
    expect(calibrate).not.toHaveBeenCalled()
    expect(ctl.syncing.value).toBe(false)
    expect(Math.abs(ctl.effectiveNowMs() - Date.now())).toBeLessThan(50) // 尚无偏移：设备时刻
    d.settle({ ...freshState(2000), preferredSourceId: 'jd' })
    await vi.waitFor(() => expect(ctl.state.value.offsetMs).toBe(2000))
    // 基准在落定前已随 tick 更新到 t-10s：落定后的下一个正常 tick 不被判成跳变
    ctl.noteDeviceTick(t - 9_000)
    await macrotask()
    expect(calibrate).not.toHaveBeenCalled() // 刚成功：冷启动决策与 tick 决策都不该发起
    expect(ctl.state.value.preferredSourceId).toBe('jd')
  })
  it('落定前的 tick 已建立基准：落定后首个 tick 即可判跳变', async () => {
    const d = deferredLoad()
    const { deps, calibrate } = makeDeps({ ...NETWORK, load: d.load })
    const ctl = initTimeSync(deps)
    const t = Date.now()
    ctl.noteDeviceTick(t)
    d.settle(freshState())
    await vi.waitFor(() => expect(ctl.state.value.offsetMs).toBe(500))
    expect(calibrate).not.toHaveBeenCalled()
    ctl.noteDeviceTick(t - 10_000) // 相对落定前建立的基准回退 10s
    expect(calibrate).toHaveBeenCalledTimes(1)
  })
  it('落定后按装载值做冷启动决策：陈旧 → 恰 1 次，且用已存首选源', async () => {
    const d = deferredLoad()
    const { deps, calibrate } = makeDeps({ ...NETWORK, load: d.load })
    const ctl = initTimeSync(deps)
    ctl.noteDeviceTick(Date.now())
    expect(calibrate).not.toHaveBeenCalled()
    d.settle({ ...okState(100), syncedAt: Date.now() - 20 * 60 * 1000, preferredSourceId: 'jd' })
    await vi.waitFor(() => expect(calibrate).toHaveBeenCalledTimes(1))
    expect(calibrate).toHaveBeenCalledWith('jd') // 落定前抢跑的话入参会是 null（忽略已存首选源）
    await vi.waitFor(() => expect(ctl.syncing.value).toBe(false))
    ctl.noteDeviceTick(Date.now())
    expect(calibrate).toHaveBeenCalledTimes(1)
    expect(ctl.state.value).toMatchObject({ offsetMs: 1234, sourceId: 'jd', preferredSourceId: 'jd' })
  })
  it.each([
    ['从未成功、5s 前刚失败', (now: number): TimeSyncState => ({ ...EMPTY_TIME_SYNC_STATE, lastAttemptAt: now - 5_000, lastAttemptFailed: true })],
    ['已有偏移且超龄、1min 前重校失败', (now: number): TimeSyncState => ({ ...okState(100), lastAttemptAt: now - 60_000, lastAttemptFailed: true })],
  ])('落定后按装载值决策：退避期内（%s）→ 0 次，失败记录不被刷新', async (_label, make) => {
    const d = deferredLoad()
    const { deps, calibrate } = makeDeps({ ...NETWORK, load: d.load })
    const ctl = initTimeSync(deps)
    ctl.noteDeviceTick(Date.now())
    const loaded = make(Date.now())
    d.settle(loaded)
    await vi.waitFor(() => expect(ctl.state.value).toBe(loaded))
    ctl.noteDeviceTick(Date.now())
    await macrotask()
    expect(calibrate).not.toHaveBeenCalled()
    expect(ctl.state.value).toBe(loaded) // 失败记录（lastAttemptAt）原样保留
  })
  it('装载失败也算落定：闸门打开，network 从未尝试 → 自动校准 1 次', async () => {
    const d = deferredLoad()
    const { deps, calibrate } = makeDeps({ ...NETWORK, load: d.load })
    const ctl = initTimeSync(deps)
    ctl.noteDeviceTick(Date.now())
    expect(calibrate).not.toHaveBeenCalled()
    d.fail(new Error('io'))
    await vi.waitFor(() => expect(calibrate).toHaveBeenCalledTimes(1))
    expect(calibrate).toHaveBeenCalledWith(null)
  })
  it('装载晚到不覆盖内存态：落定前的手动校准结果保留（评审 MN-1）', async () => {
    const d = deferredLoad()
    const { deps } = makeDeps({ load: d.load })
    const ctl = initTimeSync(deps)
    const st = await ctl.calibrateNow() // 手动路径不受闸门约束
    expect(st.offsetMs).toBe(1234)
    d.settle(okState(7))
    await macrotask()
    expect(ctl.state.value).toBe(st)
  })
  it('装载晚到不覆盖内存态：落定前改的首选源保留（评审 MN-1）', async () => {
    const d = deferredLoad()
    const { deps } = makeDeps({ load: d.load })
    const ctl = initTimeSync(deps)
    await ctl.setPreferredSource('gitee')
    d.settle({ ...okState(7), preferredSourceId: 'jd' })
    await macrotask()
    expect(ctl.state.value.preferredSourceId).toBe('gitee')
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

describe('退避的集成阳性：校准恒败时自动路径不连环重试（core R15 / R17 / R18，回滚任一条本组即转红）', () => {
  /** 校准恒败的 network 装配，等 bootstrap 首试失败落定后返回 */
  async function installFailing(loaded: TimeSyncState) {
    const { deps, calibrate } = makeDeps({ ...NETWORK, load: vi.fn(async () => loaded) })
    calibrate.mockRejectedValue(new Error('offline'))
    const ctl = initTimeSync(deps)
    await vi.waitFor(() => expect(ctl.state.value.lastAttemptFailed).toBe(true)) // bootstrap 首试失败
    await vi.waitFor(() => expect(ctl.syncing.value).toBe(false))
    return { ctl, calibrate }
  }
  /** 连续 n 个正常 tick（设备钟自然流逝，不构成跳变），每个 tick 后等可能发起的校准落定 */
  async function tickTimes(ctl: TimeSyncController, n: number) {
    for (let i = 0; i < n; i++) {
      ctl.noteDeviceTick(Date.now())
      await vi.waitFor(() => expect(ctl.syncing.value).toBe(false))
    }
  }

  it('已成功 + syncedAt 超龄：bootstrap 与其后 20 个 tick 合计恰 1 次请求（R15：超龄分支退避）', async () => {
    const { ctl, calibrate } = await installFailing({ ...okState(100), syncedAt: Date.now() - 7 * 60 * 60 * 1000 })
    await tickTimes(ctl, 20)
    expect(calibrate).toHaveBeenCalledTimes(1)
    expect(ctl.state.value.offsetMs).toBe(100) // 旧偏移保留，出码继续用它
  })
  it('回拨态（syncedAt 在未来）+ 首试失败：同样恰 1 次（R17：负差路径共用退避）', async () => {
    const future = Date.now() + 60 * 60 * 1000 // 设备钟被回拨 1h：上次成功的钟读数落在「未来」
    const { ctl, calibrate } = await installFailing({ ...okState(100), syncedAt: future, lastAttemptAt: future })
    await tickTimes(ctl, 20)
    expect(calibrate).toHaveBeenCalledTimes(1)
  })
  it('回拨 1h + 首试失败：退避期满（ttl）即重试，不必等回拨量被追平后再过一个 ttl（R18：回拨见证）', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const syncedAt = Date.now() + 60 * 60 * 1000
    const { ctl, calibrate } = await installFailing({ ...okState(100), syncedAt, lastAttemptAt: syncedAt })
    const failedAt = ctl.state.value.lastAttemptAt!
    // 每 59s 一个 tick（不足 60s，不构成前跳），走到退避期满前的最后一个 tick
    let t = failedAt
    while (t + 59_000 < failedAt + TIME_SYNC_TTL_MS) {
      t += 59_000
      vi.setSystemTime(t)
      ctl.noteDeviceTick(t)
    }
    expect(calibrate).toHaveBeenCalledTimes(1) // 退避期内一次不重试——含回拨量被追平（1h）之后的 5h
    vi.setSystemTime(failedAt + TIME_SYNC_TTL_MS)
    ctl.noteDeviceTick(failedAt + TIME_SYNC_TTL_MS)
    expect(calibrate).toHaveBeenCalledTimes(2) // 期满即重试
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
  it('幅值护栏（终审 G5）：offsetMs=25h 超一天上界 → 视为垃圾值走失败分支：保留旧偏移、记失败、rethrow', async () => {
    const { deps, calibrate } = makeDeps({ load: vi.fn(async () => okState(700)) })
    initTimeSync(deps)
    await vi.waitFor(() => expect(timeSource().state.value.offsetMs).toBe(700))
    calibrate.mockResolvedValueOnce({ offsetMs: 25 * 60 * 60 * 1000, sourceId: 'baidu' })
    await expect(timeSource().calibrateNow()).rejects.toThrow('implausible offset')
    const st = timeSource().state.value
    expect(st.offsetMs).toBe(700) // 旧偏移不被污染
    expect(st.syncedAt).toBe(1000)
    expect(st.lastAttemptFailed).toBe(true)
    expect(deps.save).toHaveBeenLastCalledWith(expect.objectContaining({ offsetMs: 700, lastAttemptFailed: true }))
    expect(timeSource().syncing.value).toBe(false)
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

describe('在途期间改首选源不被回滚（评审 MJ-1）', () => {
  it('自动校准在途改偏好 → 成功落定后保留新偏好（内存与落盘）；请求入参仍是发起时的偏好', async () => {
    const stale = { ...okState(100), preferredSourceId: 'a' } // 超龄：bootstrap 落定即自动校准
    const { deps, calibrate } = makeDeps({ ...NETWORK, load: vi.fn(async () => stale) })
    const c = deferCalibrate(calibrate)
    const ctl = initTimeSync(deps)
    await vi.waitFor(() => expect(calibrate).toHaveBeenCalledTimes(1))
    expect(calibrate).toHaveBeenCalledWith('a')
    await ctl.setPreferredSource('b') // 校准在途，用户换源
    c.ok({ offsetMs: 42, sourceId: 'a' })
    await vi.waitFor(() => expect(ctl.syncing.value).toBe(false))
    expect(ctl.state.value).toMatchObject({ offsetMs: 42, sourceId: 'a', preferredSourceId: 'b', lastAttemptFailed: false })
    expect(deps.save).toHaveBeenLastCalledWith(expect.objectContaining({ offsetMs: 42, preferredSourceId: 'b' }))
  })
  it('自动校准在途改回「自动」（null）→ 失败落定后同样不回滚（失败分支回写的也是落定时刻的偏好）', async () => {
    const stale = { ...okState(100), preferredSourceId: 'a' }
    const { deps, calibrate } = makeDeps({ ...NETWORK, load: vi.fn(async () => stale) })
    const c = deferCalibrate(calibrate)
    const ctl = initTimeSync(deps)
    await vi.waitFor(() => expect(calibrate).toHaveBeenCalledWith('a'))
    await ctl.setPreferredSource(null)
    c.fail(new Error('down'))
    await vi.waitFor(() => expect(ctl.syncing.value).toBe(false))
    expect(ctl.state.value).toMatchObject({ offsetMs: 100, preferredSourceId: null, lastAttemptFailed: true })
    expect(deps.save).toHaveBeenLastCalledWith(expect.objectContaining({ preferredSourceId: null, lastAttemptFailed: true }))
  })
  it('手动 calibrateNow 在途改偏好：落定后保留新偏好', async () => {
    const { deps, calibrate } = makeDeps({ load: vi.fn(async () => ({ ...EMPTY_TIME_SYNC_STATE, preferredSourceId: 'a' })) })
    const ctl = initTimeSync(deps)
    await vi.waitFor(() => expect(ctl.state.value.preferredSourceId).toBe('a'))
    const c = deferCalibrate(calibrate)
    const p = ctl.calibrateNow()
    expect(calibrate).toHaveBeenCalledWith('a')
    await ctl.setPreferredSource('b')
    c.ok({ offsetMs: 42, sourceId: 'a' })
    const st = await p
    expect(st.preferredSourceId).toBe('b')
    expect(ctl.state.value).toBe(st)
  })
  it('显式指定源：发起时即记为偏好，失败也保留；在途的重复调用不改偏好；途中再改以后改的为准', async () => {
    const { deps, calibrate } = makeDeps()
    const ctl = initTimeSync(deps)
    await macrotask()
    calibrate.mockRejectedValueOnce(new Error('down'))
    await expect(ctl.calibrateNow({ preferredSourceId: 'x' })).rejects.toThrow('down')
    expect(ctl.state.value).toMatchObject({ preferredSourceId: 'x', lastAttemptFailed: true })
    expect(deps.save).toHaveBeenLastCalledWith(expect.objectContaining({ preferredSourceId: 'x', lastAttemptFailed: true }))
    const c = deferCalibrate(calibrate)
    const p = ctl.calibrateNow({ preferredSourceId: 'y' })
    expect(calibrate).toHaveBeenLastCalledWith('y')
    expect(ctl.state.value.preferredSourceId).toBe('y') // 发起当刻即生效
    const dup = await ctl.calibrateNow({ preferredSourceId: 'z' }) // 在途：未实际发起
    expect(dup.preferredSourceId).toBe('y')
    await ctl.setPreferredSource('w') // 途中用户又改
    c.ok({ offsetMs: 42, sourceId: 'y' })
    expect((await p).preferredSourceId).toBe('w')
    expect(calibrate).toHaveBeenCalledTimes(2)
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

describe('useOtpCodes 出码取时接线（spec §2）', () => {
  const entry: OtpEntry = {
    uuid: 'a', type: 'totp', issuer: 'GitHub', label: 'me@ex.com', secret: 'JBSWY3DPEHPK3PXP',
    algorithm: 'SHA1', digits: 6, period: 30, tagIds: [], order: 0, createdAt: 0,
  }
  // 1_700_000_000_000 → nowSec mod 30 = 20（窗口剩余 10s）；偏移 95s = 跨 3 个窗口且窗内相位 +5s
  const T0 = 1_700_000_000_000
  const OFFSET = 95_000

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
  })

  /** effectScope 内起一份 useOtpCodes 并等首算出码（scope.stop 清理定时器与 watch）。
   *  firstNowMs=首算同步段的取时（vi.waitFor 轮询会推进假时钟，须在其前采样） */
  async function mountCodes() {
    const startedAt = Date.now()
    const scope = effectScope()
    const api = scope.run(() => useOtpCodes(ref([entry]) as Ref<OtpEntry[]>))!
    const firstNowMs = api.nowMs.value
    await vi.waitFor(() => expect(api.codes.value.get('a')).toBeDefined())
    return { scope, api, startedAt, firstNowMs }
  }

  it('network+偏移：nowMs/码值/剩余秒取 effectiveNowMs（偏移后的窗口），而非设备时刻', async () => {
    const { deps } = makeDeps({ ...NETWORK, load: vi.fn(async () => freshState(OFFSET)) })
    initTimeSync(deps)
    await vi.waitFor(() => expect(timeSource().state.value.offsetMs).toBe(OFFSET))
    const tick = vi.spyOn(timeSource(), 'noteDeviceTick')
    const { scope, api, startedAt, firstNowMs } = await mountCodes()
    expect(firstNowMs).toBe(startedAt + OFFSET)
    // 喂给 noteDeviceTick 的是设备墙钟 Date.now()，不是带偏移的有效时刻（裁定 R11：基准只存设备墙钟；评审 MN-4）
    expect(tick).toHaveBeenCalledWith(startedAt)
    expect(tick).not.toHaveBeenCalledWith(startedAt + OFFSET)
    const want = await computeEntryCode(entry, startedAt + OFFSET)
    const got = api.codes.value.get('a')!
    expect(got.code).toBe(want.code)
    expect(got.remaining).toBe(want.remaining) // 5s（设备时刻为 10s）
    // 用例自证：该偏移确实跨窗（设备时刻的码不同），上面的相等断言才有鉴别力
    expect((await computeEntryCode(entry, startedAt)).code).not.toBe(want.code)
    scope.stop()
  })

  it('偏移变化（state 引用替换）→ 立即重算，不等下一秒 tick', async () => {
    const { deps, calibrate } = makeDeps({ ...NETWORK, load: vi.fn(async () => freshState(0)) })
    calibrate.mockResolvedValue({ offsetMs: OFFSET, sourceId: 'baidu' })
    initTimeSync(deps)
    await vi.waitFor(() => expect(timeSource().state.value.syncedAt).not.toBeNull())
    const { scope, api, startedAt, firstNowMs } = await mountCodes()
    expect(firstNowMs).toBe(startedAt) // 偏移 0：设备时刻
    await timeSource().calibrateNow() // 校准成功 → state 引用替换（偏移 0 → 95s）
    await nextTick() // 冲刷 watch（pre 队列）；自首算起未推进过定时器
    expect(api.nowMs.value).toBe(Date.now() + OFFSET)
    scope.stop()
  })

  it('安装后立即挂载：装载落定前首算与 tick 都不发起校准，落定后按装载值决策（评审 I-1 接线侧）', async () => {
    const d = deferredLoad()
    const { deps, calibrate } = makeDeps({ ...NETWORK, load: d.load })
    initTimeSync(deps)
    const { scope } = await mountCodes() // 不等装载：首算（含喂 tick）已跑完
    expect(calibrate).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1000) // 落定前再过一个 tick
    expect(calibrate).not.toHaveBeenCalled()
    // 本地键回包：陈旧 + 已存首选源 → 恰 1 次，且用的是已存首选源
    d.settle({ ...okState(0), syncedAt: Date.now() - 20 * 60 * 1000, preferredSourceId: 'jd' })
    await vi.waitFor(() => expect(calibrate).toHaveBeenCalledTimes(1))
    expect(calibrate).toHaveBeenCalledWith('jd')
    scope.stop()
  })

  it('装载落定撞上在途首算：按旧偏移算出的结果不发布，随即补算——首个出码即偏移后的码，不等下一秒 tick（评审 I-2）', async () => {
    const d = deferredLoad()
    const { deps } = makeDeps({ ...NETWORK, load: d.load })
    initTimeSync(deps)
    const startedAt = Date.now()
    const published: string[] = []
    const scope = effectScope()
    const api = scope.run(() => {
      const a = useOtpCodes(ref([entry]) as Ref<OtpEntry[]>)
      watch(a.codes, (m) => { const c = m.get('a'); if (c) published.push(c.code) }, { flush: 'sync' })
      return a
    })!
    expect(api.nowMs.value).toBe(startedAt) // 装载未落定：首算按 0 偏移取时，HMAC 在途
    d.settle(freshState(OFFSET)) // 本地键此刻回包，首算仍在途
    await vi.waitFor(() => expect(published.length).toBeGreaterThan(0))
    const want = await computeEntryCode(entry, startedAt + OFFSET)
    const deviceCode = (await computeEntryCode(entry, startedAt)).code
    expect(deviceCode).not.toBe(want.code) // 用例自证：该偏移确实跨窗
    expect(published).not.toContain(deviceCode) // 错窗码从未发布
    expect(published[0]).toBe(want.code)
    expect(Date.now() - startedAt).toBeLessThan(1000) // 假时钟只被轮询推进：尚未到下一秒 tick
    scope.stop()
  })

  it('每秒 tick 喂 noteDeviceTick(Date.now())：设备钟被前拨 ≥60s → 检出跳变静默重校', async () => {
    const { deps, calibrate } = makeDeps({ ...NETWORK, load: vi.fn(async () => freshState(0)) })
    initTimeSync(deps)
    await vi.waitFor(() => expect(timeSource().state.value.syncedAt).not.toBeNull())
    const { scope } = await mountCodes()
    expect(calibrate).not.toHaveBeenCalled() // 新鲜状态：装载与首算均不触发
    vi.setSystemTime(Date.now() + 5 * 60 * 1000) // 前拨 5min（远小于 6h TTL：只有跳变分支可触发）
    await vi.advanceTimersByTimeAsync(1000) // 下一秒 tick
    expect(calibrate).toHaveBeenCalledTimes(1)
    scope.stop()
  })

  it('宿主晚于 useOtpCodes 安装/覆盖安装（mini 窗序）：下一 tick 起按当前实例取时', async () => {
    initTimeSync(makeDeps().deps) // 起点：device 模式实例（等价未接线）
    const { scope, api, startedAt, firstNowMs } = await mountCodes()
    expect(firstNowMs).toBe(startedAt)
    const { deps } = makeDeps({ ...NETWORK, load: vi.fn(async () => freshState(OFFSET)) })
    initTimeSync(deps) // 覆盖安装（如 mini 聚焦重建 store 后）
    await vi.waitFor(() => expect(timeSource().state.value.offsetMs).toBe(OFFSET))
    await vi.advanceTimersByTimeAsync(1000) // 至少过一次 tick
    const lag = Date.now() + OFFSET - api.nowMs.value // nowMs=最近一次 tick 时刻+偏移
    expect(lag).toBeGreaterThanOrEqual(0)
    expect(lag).toBeLessThan(1000)
    scope.stop()
  })
})
