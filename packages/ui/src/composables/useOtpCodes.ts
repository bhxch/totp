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

export function useOtpCodes(entries: Ref<OtpEntry[]>) {
  const nowMs = ref(Date.now())
  const codes = ref(new Map<string, CodeState>())

  async function recompute() {
    nowMs.value = Date.now()
    const next = new Map<string, CodeState>()
    for (const e of entries.value) {
      // period/remaining 仅供 catch 分支兜底展示；成功分支以 computeEntryCode 返回值为准
      const period = e.period || 30
      const remaining = period - (Math.floor(nowMs.value / 1000) % period)
      try {
        const r = await computeEntryCode(e, nowMs.value)
        next.set(e.uuid, { code: r.code, remaining: r.remaining, progress: r.remaining / r.period })
      } catch (err) {
        // secret 非法 / counter 类型错误 / 算法不支持等：渲染层据此显红 + 鼠标悬停查看原始错误，
        // 不让单条错误炸整个列表
        next.set(e.uuid, {
          code: 'INVALID',
          remaining,
          progress: remaining / period,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    codes.value = next
  }

  void recompute()
  const timer = setInterval(() => void recompute(), 1000)
  onScopeDispose(() => clearInterval(timer))

  return { codes, nowMs, /** 仅供渲染层对照，区分 INVALID/------ 占位 */ placeholder: PLACEHOLDER }
}
