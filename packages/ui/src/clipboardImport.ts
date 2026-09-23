import { importTwoFas, parsePastedText, asObject, toOtpDigits, type ParsedEntry, type OtpEntry } from '@totp/core'
import { parseUriToEntryData } from './otpauthFlow'

/** 手动填写页「从剪贴板导入」（spec 批⑧ §6）：读剪贴板快照 + 文本意图分流。
 *  读剪贴板需用户手势与 clipboardRead 权限（扩展端，manifest 提供）；失败由调用方 catch 提示。 */
export interface ClipboardSnapshot {
  image: Blob | null
  text: string
}

export async function readClipboardSnapshot(): Promise<ClipboardSnapshot> {
  const items = await navigator.clipboard.read()
  let image: Blob | null = null
  const texts: string[] = []
  for (const item of items) {
    const imgType = item.types.find((t) => t.startsWith('image/'))
    if (imgType && !image) image = await item.getType(imgType)
    if (item.types.includes('text/plain')) texts.push(await (await item.getType('text/plain')).text())
  }
  return { image, text: texts.join('\n') }
}

export type ClipboardIntent =
  | { kind: 'prefill'; entry: OtpEntry }
  | { kind: 'batch'; entries: OtpEntry[] }
  | { kind: 'error'; message: string }

/** 文本意图：单条 otpauth URI / 单条目解析 → prefill；多条 → batch；解析不了 → error。
 *  URI 优先（与 QR 同路径）；其余格式走 parsePastedText 粘贴白名单（加密/需映射格式引导导入页，消息透传）。 */
export function resolveTextIntent(text: string): ClipboardIntent {
  const trimmed = text.trim()
  if (!trimmed) return { kind: 'error', message: '剪贴板没有可用内容' }
  // 仅单行文本尝试单条 URI：WHATWG URL 解析会剥离换行，多行整串强解 URI 会误判成一条
  // （分行约定与 uriBatch 的 /\r?\n/ 对齐）
  if (!/\r?\n/.test(trimmed)) {
    const uri = parseUriToEntryData(trimmed)
    if (!('error' in uri)) return { kind: 'prefill', entry: uri.data }
  }
  // URI 解析失败且文本含换行/非 URI 时按批量解析；单行纯文本（如裸 base32）也试批量通道给明确错误
  let r: ReturnType<typeof parsePastedText>
  try {
    r = parsePastedText(trimmed)
  } catch (e) {
    return { kind: 'error', message: e instanceof Error ? e.message : String(e) }
  }
  if ('unsupported' in r) {
    const single = singleEntryFromJson(trimmed)
    if (single) return { kind: 'prefill', entry: prefillFromParsed(single) }
    return { kind: 'error', message: r.unsupported }
  }
  if (r.entries.length === 0) {
    return { kind: 'error', message: r.failures[0]?.message ?? '未能从剪贴板解析出条目' }
  }
  if (r.entries.length === 1) {
    return { kind: 'prefill', entry: prefillFromParsed(r.entries[0]!) }
  }
  return { kind: 'batch', entries: r.entries.map(prefillFromParsed) }
}

/** 单条目 JSON（2FAS App「分享」出的单个 service：{ secret, otp: { account, ... }, name }）→ ParsedEntry。
 *  整库 2FAS（顶层 services 数组）已由 parsePastedText 白名单直解；分享单条不含 services 数组，
 *  sniffFormat 会落 generic → unsupported。此处包成单元素 services 数组复用 importTwoFas 同一解析口径
 *  （issuer/label/tokenType/counter 全一致），形状不符或解析失败返回 null 交回原 unsupported 消息。 */
function singleEntryFromJson(text: string): ParsedEntry | null {
  if (!text.startsWith('{')) return null
  let obj: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    obj = parsed as Record<string, unknown>
  } catch {
    return null
  }
  if (typeof obj.secret !== 'string' || obj.secret.trim() === '' || !asObject(obj.otp)) return null
  try {
    const r = importTwoFas(JSON.stringify({ services: [obj] }))
    return r.entries[0] ?? null
  } catch {
    return null
  }
}

/** ParsedEntry → OtpEntry 哑值形状（作 EntryForm initial / 预填；保存时宿主覆盖 uuid/order/createdAt） */
function prefillFromParsed(e: ParsedEntry): OtpEntry {
  return {
    uuid: '',
    type: e.type,
    issuer: e.issuer,
    label: e.label,
    secret: e.secret,
    algorithm: e.algorithm,
    // digits 经 toOtpDigits 收口 number→OtpDigits（steam=5、yandex=8、其余 6/7/8 兜底 6，同 CodesPage 提交口径）
    digits: toOtpDigits(e.digits, e.type),
    period: e.period,
    ...(e.counter !== undefined ? { counter: e.counter } : {}),
    ...(e.pin !== undefined ? { pin: e.pin } : {}),
    note: '',
    tagIds: [],
    matchRules: [],
    order: 0,
    createdAt: 0,
  }
}

/** OtpEntry → ParsedEntry 投影（批量落库 applyImport 入参；口径同 BatchPastePanel.toParsed） */
export function toParsedEntry(d: OtpEntry): ParsedEntry {
  return {
    type: d.type,
    issuer: d.issuer,
    label: d.label,
    secret: d.secret,
    algorithm: d.algorithm,
    digits: d.digits,
    period: d.period,
    ...(d.counter !== undefined ? { counter: d.counter } : {}),
    ...(d.pin !== undefined ? { pin: d.pin } : {}),
  }
}
