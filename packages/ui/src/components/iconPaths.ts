// packages/ui/src/components/iconPaths.ts
/** Material Symbols path 注册表：形态统一 `{ viewBox, d }`，组件与宿主共用（Task 5 合并其余散落 path） */
export interface IconPath {
  viewBox: string
  d: string
}

/** close（Material Symbols 24dp） */
export const close: IconPath = {
  viewBox: '0 0 24 24',
  d: 'M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z',
}
