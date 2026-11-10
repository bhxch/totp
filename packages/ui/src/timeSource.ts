/**
 * 时间源模块级单例（时间源特性，spec §2；useToast 同款装配模式）：宿主 main/App 安装
 * initTimeSync(deps) 注入设备本地键 IO 与端校准器；出码层（useOtpCodes/mcpBridge）与设置
 * 卡消费 timeSource()。未安装时返回降级实例（offset 恒 0、calibrate 恒败、零网络）——
 * 测试与未接线上下文零影响（spec §7 device 模式零回归）。
 */
import {
  COLD_START_TTL_MS, EMPTY_TIME_SYNC_STATE, clockJumpKind, shouldAutoCalibrate, type TimeSyncState,
} from '@totp/core'
import { ref, shallowRef, type Ref, type ShallowRef } from 'vue'

export interface CalibrateResult {
  /** 校准偏移毫秒（=网络时间-设备时间） */
  offsetMs: number
  /** 成功来源 id */
  sourceId: string
}

/** 宿主注入的端依赖：load/save=设备本地键 IO（实现内自带 try/catch 吞 IO 错误）；
 *  calibrate=端校准器（扩展=background 消息；桌面=Rust SNTP 命令），失败必须 reject */
export interface TimeSyncDeps {
  load(): Promise<TimeSyncState | null>
  save(state: TimeSyncState): Promise<void>
  isNetworkMode(): boolean
  calibrate(preferredSourceId: string | null): Promise<CalibrateResult>
}

export interface TimeSyncController {
  /** 校准状态（引用替换驱动浅 watch → 出码层联动重算） */
  state: ShallowRef<TimeSyncState>
  /** 校准进行中（按钮 spinner/互斥） */
  syncing: Ref<boolean>
  /** 出码取时单点：Date.now() +（network 且有偏移时的 offset；否则 0）——出码永不等待网络 */
  effectiveNowMs(): number
  /** 每秒 tick 入口（useOtpCodes）/事件驱动顺带（mcpBridge）：跳变判定 + TTL（6h）静默重校，
   *  均仅 network 模式生效（spec §3-③④）。跳变=回退 ≥5s 或前跳 ≥60s，无采样间隔条件
   *  （裁定 R11）：停表/休眠恢复等长间隔采样同判前跳，多一次无害校准，宁误判不漏判 */
  noteDeviceTick(deviceNowMs: number): void
  /** 冷启动入口（上下文激活；initTimeSync 装载完成后自动调用一次）：收紧 TTL（10min，
   *  裁定 R13）决策 + 静默重校；幂等互斥 */
  ensureAutoCalibrate(): void
  /** 设置卡改首选源：仅更新偏好并落盘，不触发校准 */
  setPreferredSource(id: string | null): Promise<void>
  /** 手动/模式切换校准（spec §3-①②）：无视模式与退避恒允许；失败 rethrow 供调用方 toast；
   *  在途（syncing）直接返回当前 state 不重复请求。opts.preferredSourceId 缺省=沿用已存偏好；
   *  显式非 null=本次用该源并记为偏好；显式 null=本次走端内置顺序（不清既有偏好） */
  calibrateNow(opts?: { preferredSourceId?: string | null }): Promise<TimeSyncState>
}

function createController(deps: TimeSyncDeps): TimeSyncController {
  const state = shallowRef<TimeSyncState>({ ...EMPTY_TIME_SYNC_STATE })
  const syncing = ref(false)
  /** 上一次 tick 的设备墙钟：仅作 clockJumpKind 的 prev 输入；null=本实例尚无基准（首 tick 不判跳变） */
  let lastTick: number | null = null

  /** 状态提交：引用替换（驱动出码层浅 watch）+ 落盘。落盘失败只影响持久化、不影响内存态
   *  （本会话校准结果照常出码）——deps.save 按契约自吞 IO 错误，此处兜底防违约实现把成功
   *  校准误记为失败、或让静默路径产生未处理 rejection */
  async function commit(next: TimeSyncState): Promise<TimeSyncState> {
    state.value = next
    try {
      await deps.save(next)
    } catch { /* 内存态已生效 */ }
    return next
  }

  /** 校准事务：成功/失败均刷新 state（引用替换）并落盘；throwOnFail 区分手动（true，rethrow）
   *  与静默（false，吞掉仅留痕）。preferred=null 走端内置顺序。在途互斥：直接返回当前 state */
  async function runCalibrate(preferred: string | null, throwOnFail: boolean): Promise<TimeSyncState> {
    if (syncing.value) return state.value
    syncing.value = true
    try {
      const r = await deps.calibrate(preferred)
      // 端校准器解析异常防御（Task 1 评审 M4：core computeOffsetMs 纯透传，守卫归消费端）：
      // NaN/±Infinity 一旦采纳，effectiveNowMs 即非有限值、全部条目出码异常——视为校准失败
      if (!Number.isFinite(r.offsetMs)) throw new Error('time sync: non-finite offset from calibrator')
      const now = Date.now()
      return await commit({
        v: 1, offsetMs: r.offsetMs, syncedAt: now, sourceId: r.sourceId,
        lastAttemptAt: now, lastAttemptFailed: false,
        preferredSourceId: preferred ?? state.value.preferredSourceId,
      })
    } catch (e) {
      // 失败：保留旧偏移（spec §3-⑤），仅记尝试时刻与失败标记（自动重试退避依据）
      const next = await commit({
        ...state.value, lastAttemptAt: Date.now(), lastAttemptFailed: true,
        preferredSourceId: preferred ?? state.value.preferredSourceId,
      })
      if (throwOnFail) throw e
      return next
    } finally {
      syncing.value = false
    }
  }

  /** 静默重校（自动路径共用）：出码先用旧偏移不阻塞；在途互斥、失败只留痕不抛（runCalibrate 内保证） */
  function recalibrateSilently(): void {
    void runCalibrate(state.value.preferredSourceId, false)
  }

  return {
    state,
    syncing,
    effectiveNowMs(): number {
      const st = state.value
      return Date.now() + (deps.isNetworkMode() && st.offsetMs !== null ? st.offsetMs : 0)
    },
    noteDeviceTick(deviceNowMs: number): void {
      const prev = lastTick
      lastTick = deviceNowMs
      if (prev !== null && clockJumpKind(prev, deviceNowMs) !== 'none') {
        // 跳变（回退 ≥5s / 前跳 ≥60s）：旧偏移不再可信，绕过 TTL 决策直接重校。
        // device 模式零网络（裁定 R4）：shouldAutoCalibrate 自带模式短路，本分支绕过了它，
        // 故显式守卫——device 下跳变只更新基准
        if (deps.isNetworkMode()) recalibrateSilently()
        return
      }
      // 运行期 TTL 决策：core 默认 6h（不传 ttlMs，裁定 R13）
      if (shouldAutoCalibrate(state.value, deps.isNetworkMode(), Date.now())) recalibrateSilently()
    },
    ensureAutoCalibrate(): void {
      // 冷启动入口收紧 TTL（裁定 R13）：上下文全灭期间的系统校时无 tick 可观测，10min 判据覆盖该盲区
      if (shouldAutoCalibrate(state.value, deps.isNetworkMode(), Date.now(), COLD_START_TTL_MS)) recalibrateSilently()
    },
    async setPreferredSource(id: string | null): Promise<void> {
      if (state.value.preferredSourceId === id) return
      await commit({ ...state.value, preferredSourceId: id })
    },
    async calibrateNow(opts?: { preferredSourceId?: string | null }): Promise<TimeSyncState> {
      const preferred = opts?.preferredSourceId !== undefined ? opts.preferredSourceId : state.value.preferredSourceId
      return runCalibrate(preferred, true)
    },
  }
}

/** 降级实例（未安装/测试默认）：offset 恒 0、calibrate 恒败（手动调用方 toast 失败文案）、零网络 */
const fallback = createController({
  load: async () => null,
  save: async () => {},
  isNetworkMode: () => false,
  calibrate: async () => { throw new Error('time sync not installed') },
})

let singleton: TimeSyncController = fallback

/** 宿主安装（覆盖式；mini 窗聚焦重建 store 后可重复安装）：bootstrap 异步装载本地键，
 *  装载完成后跑一次冷启动 TTL 决策（network 模式超龄即静默重校）；装载失败静默保降级语义。
 *  装载在途期间若已被再次覆盖安装，旧实例放弃 bootstrap（不写状态、不发起校准） */
export function initTimeSync(deps: TimeSyncDeps): TimeSyncController {
  const controller = createController(deps)
  singleton = controller
  void deps.load()
    .then((st) => {
      if (singleton !== controller) return
      if (st) controller.state.value = st
      controller.ensureAutoCalibrate()
    })
    .catch(() => {})
  return controller
}

/** 消费入口：未安装（未调 initTimeSync）返回降级实例。单例可被覆盖安装——需跟随最新实例的
 *  调用方应每次现取，勿长期持有返回值 */
export function timeSource(): TimeSyncController {
  return singleton
}
