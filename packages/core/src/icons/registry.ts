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

/** 推荐候选：builtin 项带 path；extra（stored 图标 id 等）无 path */
export interface IconSuggestion {
  id: string
  title: string
  source: 'builtin' | 'extra'
  path?: string
}

const ICONS = data.icons as Record<string, BuiltinIcon>
const ALIASES = data.aliases as Record<string, string>

/** 全部内置图标，键为图标 id（Simple Icons slug） */
export function getBuiltinIcons(): Record<string, BuiltinIcon> {
  return ICONS
}

/** 全量集（icons-full.json）加载后合并进注册表；幂等（同 id 覆盖） */
export function registerIcons(icons: ReadonlyArray<BuiltinIcon>): void {
  for (const icon of icons) ICONS[icon.id] = icon
}

/**
 * 小写并去除空白/点/连字符/下划线，用于发行方匹配；R4-C1：同时剔除 Windows 文件名
 * 危险字符（`\ / : * ? " < > |`）与控制字符——产出值兼作图标包 stored id / 注册表键
 * （iconImport.ts），桌面端会以其为存储键成分并经 tauriFs 映射为文件名，源头清洗
 * 避免 ADS/子目录逃逸；调用面仅 suggestIcons 运行时匹配（两侧同函数归一，无持久化
 * 匹配键）与本清洗点，不破坏既有条目 id 匹配。
 */
export function normalizeIssuer(name: string): string {
  // eslint-disable-next-line no-control-regex -- 刻意清除 C0 控制字符与 DEL
  return name.toLowerCase().replace(/[/\\:*?"<>|\u0000-\u001f\u007f]/g, '').replace(/[\s._-]+/g, '')
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
 * 图标推荐：normalize 后按莱文斯坦距离升序（含精确命中 dist 0），同距 builtin 优先、
 * 再按 id 字典序。候选含内置 id/title/别名键 + extra 候选（stored 图标 id，已 normalize）；
 * 子串包含免距离阈值（前缀搜索补全），默认 5 条。
 * extra 与内置同 id 时跳过（内置优先）。阈值随输入长度放宽（3 字符容差 1、6 字符容差 2），上限 3。
 */
export function suggestIcons(
  issuer: string,
  limit: number = 5,
  extra: ReadonlyArray<{ id: string; title?: string }> = [],
): IconSuggestion[] {
  const key = normalizeIssuer(issuer)
  if (!key) return []
  const maxDist = Math.min(3, Math.max(1, Math.floor(key.length / 3)))
  interface Hit {
    title: string
    path?: string
    /** 包含命中时恰为长度差，与纠错距离同轴可比 */
    dist: number
    builtin: boolean
  }
  const best = new Map<string, Hit>()
  const consider = (text: string, iconId: string, title: string, path: string | undefined, builtin: boolean) => {
    const norm = normalizeIssuer(text)
    if (!norm) return
    const included = norm.includes(key) || key.includes(norm)
    const dist = levenshtein(key, norm)
    if (!included && dist > maxDist) return
    const prev = best.get(iconId)
    if (!prev || dist < prev.dist) best.set(iconId, { title, path, dist, builtin })
  }
  for (const icon of Object.values(ICONS)) {
    consider(icon.id, icon.id, icon.title, icon.path, true)
    consider(icon.title, icon.id, icon.title, icon.path, true)
  }
  for (const [alias, id] of Object.entries(ALIASES)) {
    const icon = ICONS[id]
    if (icon) consider(alias, id, icon.title, icon.path, true)
  }
  for (const cand of extra) {
    if (ICONS[cand.id]) continue
    const title = cand.title ?? cand.id
    consider(cand.id, cand.id, title, undefined, false)
    if (cand.title) consider(cand.title, cand.id, title, undefined, false)
  }
  return [...best.entries()]
    .map(([id, h]) => ({ id, title: h.title, source: h.builtin ? ('builtin' as const) : ('extra' as const), ...(h.path ? { path: h.path } : {}) }))
    .sort((a, b) => {
      const ha = best.get(a.id)!, hb = best.get(b.id)!
      return ha.dist - hb.dist || (ha.builtin ? 0 : 1) - (hb.builtin ? 0 : 1) || a.id.localeCompare(b.id)
    })
    .slice(0, limit)
}
