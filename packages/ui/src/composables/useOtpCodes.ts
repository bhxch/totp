import { base32Decode, hotp, steamCode, totp, type OtpEntry } from '@totp/core'
import { onScopeDispose, ref, type Ref } from 'vue'

export interface CodeState {
  code: string
  remaining: number
  progress: number
}

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
        else if (e.type === 'hotp') code = await hotp(secretOf(e), e.counter ?? 0, { algorithm: e.algorithm, digits: e.digits })
        else code = await totp(secretOf(e), nowMs.value, { algorithm: e.algorithm, digits: e.digits, period })
        next.set(e.uuid, { code, remaining, progress: remaining / period })
      } catch {
        // secret 非法等：显示占位，不让单条错误炸整个列表
        next.set(e.uuid, { code: '------', remaining, progress: remaining / period })
      }
    }
    codes.value = next
  }

  void recompute()
  const timer = setInterval(() => void recompute(), 1000)
  onScopeDispose(() => clearInterval(timer))

  return { codes, nowMs }
}
