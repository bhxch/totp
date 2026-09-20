import { base32Decode, hotp, steamCode, totp, yandexCode, type OtpEntry } from '@totp/core'
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
  const secretCache = new Map<string, Uint8Array>()

  function secretOf(e: OtpEntry): Uint8Array {
    let s = secretCache.get(e.uuid)
    if (!s) {
      s = base32Decode(e.secret)
      secretCache.set(e.uuid, s)
    }
    return s
  }

  async function recompute() {
    nowMs.value = Date.now()
    const next = new Map<string, CodeState>()
    for (const e of entries.value) {
      const period = e.period || 30
      const remaining = period - (Math.floor(nowMs.value / 1000) % period)
      try {
        let code: string
        if (e.type === 'steam') code = await steamCode(secretOf(e), nowMs.value)
        else if (e.type === 'yandex') code = await yandexCode(e.secret, e.pin ?? '', nowMs.value, period, e.digits)
        else if (e.type === 'hotp') code = await hotp(secretOf(e), e.counter ?? 0, { algorithm: e.algorithm, digits: e.digits })
        else code = await totp(secretOf(e), nowMs.value, { algorithm: e.algorithm, digits: e.digits, period })
        next.set(e.uuid, { code, remaining, progress: remaining / period })
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
