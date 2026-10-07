/** 右键菜单导入中转键：background（entrypoints/background.ts）校验后写入 pending 信封 JSON，popup（App.vue）读取即清除 */
export const PENDING_OTPAUTH_KEY = 'pendingOtpauth'

/**
 * pending 存储信封（P5）：旧版为裸 otpauth URI 字符串，升级为带版本与 kind 的 JSON 信封——
 * background 可写 otpauth URI（QR 识别）或原始粘贴文本（选中文本全格式单条），popup 消费端按
 * kind 分派（uri→URI 预填、pasted→parsePastedText 复解）。旧裸字符串经 decodePending 返回
 * null 且非空 → 调用方按 { kind:'uri', text: raw } 兼容解释（兼容规则归调用方，见计划 Global Constraints）。
 * R5-I3：ts 为写入时刻（encodePending 自动盖章）。P5 后信封内容扩大到任意选中文本（可能含
 * secret），盘上残留无 TTL 不可接受——消费端读到超过 PENDING_TTL_MS 的信封须删除并提示。
 * 版本策略：无 ts 的旧信封**不过期**（升级兼容：用户升级后残留信封不因缺时间戳失效），
 * 新写入一律带 ts。
 */
export interface PendingOtpauth { v: 1; kind: 'uri' | 'pasted'; text: string; ts?: number }

/** 信封有效期（R5-I3）：10 分钟——右键添加到打开 popup 的合理上限，超时视为已放弃 */
export const PENDING_TTL_MS = 10 * 60 * 1000

/** 序列化信封（写盘单一形态）：自动盖章写入时刻 ts，调用方无需感知 */
export function encodePending(p: PendingOtpauth): string {
  return JSON.stringify({ ...p, ts: Date.now() })
}

/** 解析信封：JSON 解析失败/形状不符（版本、kind、text 任一不合法；ts 存在但非数字）→ null
 * （调用方按旧裸 URI 兼容处理）；ts 缺失容忍（v1 旧信封，不过期，见上） */
export function decodePending(raw: string): PendingOtpauth | null {
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return null
  }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  if (o.v !== 1) return null
  if (o.kind !== 'uri' && o.kind !== 'pasted') return null
  if (typeof o.text !== 'string') return null
  if (o.ts !== undefined && typeof o.ts !== 'number') return null
  return o.ts === undefined ? { v: 1, kind: o.kind, text: o.text } : { v: 1, kind: o.kind, text: o.text, ts: o.ts }
}

/** 信封是否过期（R5-I3）：无 ts 的旧信封不过期（升级兼容）；带 ts 超过 PENDING_TTL_MS 判过期 */
export function isPendingExpired(p: PendingOtpauth, now: number = Date.now()): boolean {
  if (p.ts === undefined) return false
  return now - p.ts > PENDING_TTL_MS
}
