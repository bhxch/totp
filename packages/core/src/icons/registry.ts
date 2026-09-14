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

/** 前缀包含匹配（normalize 后 id/title 任一 includes），默认返回 5 条 */
export function suggestIcons(issuer: string, limit: number = 5): BuiltinIcon[] {
  const key = normalizeIssuer(issuer)
  if (!key) return []
  return Object.values(ICONS)
    .filter((i) => normalizeIssuer(i.id).includes(key) || normalizeIssuer(i.title).includes(key))
    .slice(0, limit)
}
