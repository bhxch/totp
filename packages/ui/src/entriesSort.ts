import type { OtpEntry } from '@totp/core'

/** 条目列表排序单一来源（R14：CodesPage 与 desktop MiniApp 原各持一份 comparator 靠注释同步
 *  「同一份 vault 跨宿主展示顺序稳定」）：pinned 优先（truthy 检查兼容无 pinned 字段的旧 vault），
 *  组内按 order 升序；纯函数，返回新数组不改传入。 */
export function sortEntries(entries: OtpEntry[]): OtpEntry[] {
  return [...entries].sort((a, b) => {
    if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1
    return a.order - b.order
  })
}
