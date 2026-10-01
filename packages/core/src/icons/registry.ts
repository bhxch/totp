import data from './builtin.json'

export type IconRef =
  | { kind: 'builtin'; id: string }
  | { kind: 'stored'; id: string }
  | { kind: 'url'; id: string; url: string }

export interface BuiltinIcon {
  id: string
  title: string
  /** Simple Icons 24x24 path data */
  path: string
}

const ICONS = data.icons as Record<string, BuiltinIcon>
const ALIASES = data.aliases as Record<string, string>

/** 全部内置图标，键为图标 id（Simple Icons slug） */
export function getBuiltinIcons(): Record<string, BuiltinIcon> {
  return ICONS
}

/** 小写并去除空白/点/连字符/下划线，用于发行方匹配 */
export function normalizeIssuer(name: string): string {
  return name.toLowerCase().replace(/[\s._-]+/g, '')
}

/** 依次：normalize 后精确 id → 别名表 → null */
export function recommendBuiltinIcon(issuer: string): BuiltinIcon | null {
  const key = normalizeIssuer(issuer)
  if (!key) return null
  const id = key in ICONS ? key : ALIASES[key]
  if (!id) return null
  return ICONS[id] ?? null
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const curr = [i]
    for (let j = 1; j <= b.length; j++) {
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = curr
  }
  return prev[b.length]!
}

/**
 * 图标推荐：normalize 后按莱文斯坦距离升序（含精确命中 dist 0），同距按 id 字母序。
 * 候选含 id/title/别名键；子串包含免距离阈值（前缀搜索补全），默认 5 条。
 */
export function suggestIcons(issuer: string, limit: number = 5): BuiltinIcon[] {
  const key = normalizeIssuer(issuer)
  if (!key) return []
  // 阈值随输入长度放宽（3 字符容差 1、6 字符容差 2），上限 3 防长输入过宽
  const maxDist = Math.min(3, Math.max(1, Math.floor(key.length / 3)))
  interface Hit {
    icon: BuiltinIcon
    /** 包含命中时恰为长度差，与纠错距离同轴可比 */
    dist: number
  }
  const best = new Map<string, Hit>()
  const consider = (text: string, iconId: string) => {
    const icon = ICONS[iconId]
    if (!icon) return
    const norm = normalizeIssuer(text)
    if (!norm) return
    const included = norm.includes(key) || key.includes(norm)
    const dist = levenshtein(key, norm)
    if (!included && dist > maxDist) return
    const prev = best.get(iconId)
    if (!prev || dist < prev.dist) best.set(iconId, { icon, dist })
  }
  for (const icon of Object.values(ICONS)) {
    consider(icon.id, icon.id)
    consider(icon.title, icon.id)
  }
  for (const [alias, id] of Object.entries(ALIASES)) consider(alias, id)
  return [...best.values()]
    .sort((a, b) => a.dist - b.dist || a.icon.id.localeCompare(b.icon.id))
    .slice(0, limit)
    .map((h) => h.icon)
}
