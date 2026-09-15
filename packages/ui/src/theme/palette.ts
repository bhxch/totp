import palettesJson from './palettes.json'
export interface ThemePaletteEntry { id: string; hex: string; label: string }
export const THEME_PALETTES: ThemePaletteEntry[] = palettesJson
export const DEFAULT_THEME_COLOR = 'blue'
export function isThemeColor(id: unknown): id is string {
  return typeof id === 'string' && THEME_PALETTES.some((p) => p.id === id)
}
