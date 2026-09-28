import { computeEntryCode, type OtpEntry } from '@totp/core'
import { onScopeDispose, ref, type Ref } from 'vue'

export interface CodeState {
  /** 验证码；secret 非法时为 'INVALID'，渲染层据此显红 */
  code: string
  /** 剩余秒数（用于环形进度） */
  remaining: number
  /** 0..1 进度 */
  progress: number
  /** [可选] secret 非法时的原始错误信息（鼠标悬停提示） */
  error?: string
}

/** 探测期/未到刷新窗口占位符：'------'，与 secret 非法区分（INVALID） */
const PLACEHOLDER = '------'

/**
 * 窗口缓存：code 是「条目内容 + 窗口号 counter=floor(nowSec/period)」的纯函数
 * （totp/steam/yandex 按窗口取码、hotp 恒定，见 typeProfiles）——同窗口内无需重复 HMAC，
 * 每秒 CPU 从 O(N) 次签名降为仅窗口轮换条目的重算。entry 存引用做变化检测：
 * store 编辑/推进 counter 会替换对象引用 → 下轮自动重算。
 */
interface CodeCacheEntry {
  entry: OtpEntry
  counter: number
  code: string
}

export function useOtpCodes(entries: Ref<OtpEntry[]>) {
  const nowMs = ref(Date.now())
  const codes = ref(new Map<string, CodeState>())
  const cache = new Map<string, CodeCacheEntry>()
  let timer: ReturnType<typeof setInterval> | null = null
  let computing = false

  async function recompute() {
    if (computing) return // 上一轮未完成（大库/慢机）时跳过本 tick，下一秒自然重算
    computing = true
    try {
      nowMs.value = Date.now()
      const next = new Map<string, CodeState>()
      const nowSec = Math.floor(nowMs.value / 1000)
      for (const e of entries.value) {
        // remaining/progress 与 core 的 entryCode.ts 同式本地求值（窗口缓存命中路径不经过 core）
        const period = e.period || 30
        const remaining = period - (nowSec % period)
        const counter = Math.floor(nowSec / period)
        // 窗口缓存命中（同条目引用 + 同窗口号）→ 跳过 HMAC，仅刷新时间字段
        const hit = cache.get(e.uuid)
        try {
          let code: string
          if (hit && hit.entry === e && hit.counter === counter) {
            code = hit.code
          } else {
            const r = await computeEntryCode(e, nowMs.value)
            code = r.code
            cache.set(e.uuid, { entry: e, counter, code })
          }
          next.set(e.uuid, { code, remaining, progress: remaining / period })
        } catch (err) {
          // secret 非法 / counter 类型错误 / 算法不支持等：渲染层据此显红 + 鼠标悬停查看原始错误，
          // 不让单条错误炸整个列表（错误不缓存：每秒重试成本极低，且允许 secret 修复后自愈）
          cache.delete(e.uuid)
          next.set(e.uuid, {
            code: 'INVALID',
            remaining,
            progress: remaining / period,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
      codes.value = next
    } finally {
      computing = false
    }
  }

  // 后台节流：页面不可见（主窗到托盘 / mini 失焦自动隐藏 / popup 关闭前）时停表，
  // 恢复可见立即重算一次再续表——渲染开销由 WebView occlusion 兜底，此处省的是 HMAC/响应式 CPU。
  // 主窗与 mini 各持一份本 composable 实例，各自随自身窗口可见性启停。
  function startTimer() {
    if (timer === null && !document.hidden) timer = setInterval(() => void recompute(), 1000)
  }
  function stopTimer() {
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }
  function onVisibilityChange() {
    if (document.hidden) {
      stopTimer()
    } else {
      void recompute()
      startTimer()
    }
  }

  void recompute()
  startTimer()
  document.addEventListener('visibilitychange', onVisibilityChange)
  onScopeDispose(() => {
    document.removeEventListener('visibilitychange', onVisibilityChange)
    stopTimer()
  })

  return { codes, nowMs, /** 仅供渲染层对照，区分 INVALID/------ 占位 */ placeholder: PLACEHOLDER }
}
