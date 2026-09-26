// R16②：正则安全器自 engine.ts 纯拆（原 34-108 行，与匹配分发无耦合）。
// 消费方：engine.ts 编译缓存、parseVaultJson 恢复校验、ui entryForm 表单校验——
// 后两者经 '@totp/core' 顶层导入，engine.ts 以 `export *` 保持既有导入面不变。

/** 单条 pattern 长度上限（F13：恢复校验与引擎边界兜底共用） */
export const MAX_MATCH_PATTERN_LENGTH = 256

/**
 * F13：灾难性回溯保守筛查——识别「组体末尾原子已量词化，组再被量词化」的嵌套量词形态
 * （如 (a+)+、((a+))+、(a{2,4})+）。保守检测：宁可错杀罕见的安全形态（对匹配器可接受）。
 * 已知不覆盖（残留，见 finding F13）：跨支歧义 ((a+|b)+)、同支重叠 ((a|aa)+)、相邻量词 (a+a+)。
 */
export function hasNestedQuantifierRisk(pattern: string): boolean {
  // 栈保存各组开启前的 lastQuantified，闭组后还原父层状态
  const stack: boolean[] = []
  let lastQuantified: boolean = false // 当前分支最后一个原子是否「量词化终止」（自带量词，或是末尾量词化的组）
  let i = 0
  while (i < pattern.length) {
    const c = pattern[i]
    if (c === '\\') { i += 2; lastQuantified = false; continue } // 转义原子（\+ 等按字面量处理）
    if (c === '[') {
      // 字符类整体视为单原子：类内 + * { 为字面量
      i++
      while (i < pattern.length && pattern[i] !== ']') {
        if (pattern[i] === '\\') i++
        i++
      }
      i++
      lastQuantified = false
      continue
    }
    if (c === '(') {
      stack.push(lastQuantified)
      lastQuantified = false
      i++
      // (?: (?= (?! (?<= (?<! (?<name>：跳过引导段
      if (pattern[i] === '?') {
        if (pattern[i + 1] === '<' && pattern[i + 2] !== '=' && pattern[i + 2] !== '!') {
          const gt = pattern.indexOf('>', i + 2)
          if (gt === -1) return false // 形态非法，编译期即失败
          i = gt + 1
        } else {
          i += 2
        }
      }
      continue
    }
    if (c === ')') {
      const inner: boolean = lastQuantified
      const q = quantifierAt(pattern, i + 1)
      if (q.risky && inner) return true // 量词化的组再被（风险类）量词化 → 嵌套量词
      lastQuantified = q.len > 0 ? true : inner
      i = i + 1 + q.len
      continue
    }
    const q = quantifierAt(pattern, i)
    if (q.len > 0) {
      i += q.len
      lastQuantified = true
      continue
    }
    if (c === '|') { lastQuantified = false; i++; continue } // 组体末尾状态由末支决定
    i++
    lastQuantified = false
  }
  return false
}

/** i 处量词 token：len 为长度（0=非量词），risky 表示是否属风险类（+ * 和 {n,m}；有界 ? 不计） */
function quantifierAt(p: string, i: number): { len: number; risky: boolean } {
  const c = p[i]
  if (c === '+' || c === '*') return { len: p[i + 1] === '?' ? 2 : 1, risky: true }
  if (c === '?') return { len: p[i + 1] === '?' ? 2 : 1, risky: false }
  if (c === '{') {
    const m = /^\{\d+(,\d*)?\}/.exec(p.slice(i))
    if (!m) return { len: 0, risky: false } // 不成对 {} 按字面量
    return { len: m[0].length + (p[i + m[0].length] === '?' ? 1 : 0), risky: true }
  }
  return { len: 0, risky: false }
}

/** F13：regex pattern 求值安全检查（恢复校验与引擎边界共用）：长度上限 + 无嵌套量词形态 */
export function isSafeRegexPattern(pattern: string): boolean {
  const p = pattern.trim()
  if (!p || p.length > MAX_MATCH_PATTERN_LENGTH) return false
  return !hasNestedQuantifierRisk(p)
}
