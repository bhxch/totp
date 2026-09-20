import { hasNestedQuantifierRisk, MAX_MATCH_PATTERN_LENGTH, type HashAlgorithm, type IconRef, type MatchRule } from '@totp/core'

export interface EntryFormData {
  type: 'totp' | 'hotp' | 'steam' | 'yandex'
  issuer: string
  label: string
  secret: string
  /** 哈希算法；缺省表示沿用服务端默认（SHA1），避免编辑既有条目时隐式重置 */
  algorithm?: HashAlgorithm
  /** 验证码位数；缺省表示沿用服务端默认（totp/hotp=6，steam=5，yandex=8） */
  digits?: number
  /** TOTP 周期（秒）；缺省 30 */
  period?: number
  /** HOTP 计数器（仅 hotp 类型有效） */
  counter?: number
  /** Yandex（yaotp）的 PIN，可选；仅 yandex 类型提交（缺省/空串按无 PIN 计算） */
  pin?: string
  note: string
  tagIds: string[]
  matchRules: MatchRule[]
  /** 图标引用：builtin/stored/url；未设置时缺省 */
  icon?: IconRef
}

/** regex 预校验失败结果（i18n D2）：key 为文案键（渲染方经 t() 出文案）；raw 为浏览器 RegExp
 *  构造错误原始消息（浏览器本地化文本，直接展示优先于 key） */
export interface RegexIssue {
  key: 'entryForm.regexInvalid' | 'entryForm.regexTooLong' | 'entryForm.regexNested'
  /** 浏览器 RegExp 构造错误原始消息；存在时渲染方直接展示（与浏览器本地化一致） */
  raw?: string
  /** key 文案的插值参数（regexTooLong 的 {limit}） */
  params?: Record<string, string | number>
}

/**
 * I51：URL 匹配规则中 strategy=regex 的客户端预校验。
 * - 空串视为合法（前端过滤后忽略）；非空时必须能编译为 RegExp。
 * - F13：与恢复校验对齐——超长（>256）与嵌套量词回溯形态（如 (a+)+）同样拒绝，
 *   避免表单创建出恢复路径会拒收的规则。
 * - 不接受 /flag 之外的特殊字符限制；保留 i/m 常用旗标。
 * - i18n D2：返回结构化 { key, raw?, params? } 而非成品文案，由组件侧经 t() 渲染
 */
export function validateRegex(pattern: string): RegexIssue | null {
  const p = pattern.trim()
  if (!p) return null
  // RegExp 构造只接受 g/i/m/s/u/y 旗标，其余（d 等 v8 私有）可能不被旧宿主支持
  try {
    // eslint-disable-next-line no-new
    new RegExp(p)
  } catch (e) {
    return e instanceof Error ? { key: 'entryForm.regexInvalid', raw: e.message } : { key: 'entryForm.regexInvalid' }
  }
  if (p.length > MAX_MATCH_PATTERN_LENGTH) return { key: 'entryForm.regexTooLong', params: { limit: MAX_MATCH_PATTERN_LENGTH } }
  if (hasNestedQuantifierRisk(p)) return { key: 'entryForm.regexNested' }
  return null
}
