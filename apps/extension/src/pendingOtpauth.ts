/** 右键菜单导入中转键：background（entrypoints/background.ts）校验后写入 pending 信封 JSON，popup（App.vue）onMounted 读取即清除 */
export const PENDING_OTPAUTH_KEY = 'pendingOtpauth'

/**
 * pending 存储信封（P5）：旧版为裸 otpauth URI 字符串，升级为带版本与 kind 的 JSON 信封——
 * background 可写 otpauth URI（QR 识别）或原始粘贴文本（选中文本全格式单条），popup 消费端按
 * kind 分派（uri→URI 预填、pasted→parsePastedText 复解）。旧裸字符串经 decodePending 返回
 * null 且非空 → 调用方按 { kind:'uri', text: raw } 兼容解释（兼容规则归调用方，见计划 Global Constraints）。
 */
export interface PendingOtpauth { v: 1; kind: 'uri' | 'pasted'; text: string }

/** 序列化信封（写盘单一形态） */
export function encodePending(p: PendingOtpauth): string {
  return JSON.stringify(p)
}

/** 解析信封：JSON 解析失败/形状不符（版本、kind、text 任一不合法）→ null（调用方按旧裸 URI 兼容处理） */
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
  return { v: 1, kind: o.kind, text: o.text }
}
