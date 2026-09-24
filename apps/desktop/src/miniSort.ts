import type { OtpEntry } from '@totp/core'

/** mini 列表排序：pinned 优先（truthy 检查兼容无 pinned 字段的旧 vault），组内按 order 升序。
 *  口径与 CodesPage.vue 一致（同一份 vault 跨宿主展示顺序稳定）；纯函数抽出便于单测
 *  （miniAutoHide 同型——desktop 包 vitest 为 node 环境，不挂载组件） */
export function sortMiniEntries(entries: OtpEntry[]): OtpEntry[] {
  return [...entries].sort((a, b) => {
    if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1
    return a.order - b.order
  })
}
