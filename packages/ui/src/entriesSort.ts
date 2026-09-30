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

// ---------- ④C 手动排序（拖拽落点 / 序号定位移动）：全序语义下纯函数求新序列 ----------
// 两函数都以「展示顺序的 uuid 全序列 + 置顶集合」为输入，返回重排后的完整序列（交 reorderOp
// 落库）或 null（无效/同位/跨区回弹——调用方不提交）。分区约束：置顶区为序列前缀（sortEntries
// 口径），条目只能在自己所属分区内移动，跨区拖动回弹；序号定位移动则把目标钳入本分区。

/** 拖拽落点求新序列：before=插到 target 之前，否则之后（移除 src 后重算目标下标）。
 *  src 落位越过分区边界（拖入另一分区）返回 null。 */
export function moveWithinPartition(uuids: string[], src: string, target: string, before: boolean, pinned: Set<string>): string[] | null {
  const si = uuids.indexOf(src)
  const ti = uuids.indexOf(target)
  if (si < 0 || ti < 0 || si === ti) return null
  const arr = [...uuids]
  const [item] = arr.splice(si, 1)
  if (item === undefined) return null
  arr.splice(arr.indexOf(target) + (before ? 0 : 1), 0, item)
  const ni = arr.indexOf(src)
  const pinnedCount = uuids.filter((u) => pinned.has(u)).length
  if (pinned.has(src) ? ni >= pinnedCount : ni < pinnedCount) return null
  return arr
}

/** 序号定位移动（④C）：把 src 移到 1-based 目标序号。目标先钳入 src 所属分区：非置顶条目
 *  输入落在置顶区 → 普通区顶部；置顶条目输入超置顶区 → 置顶区末尾；超总长 → 末尾。
 *  同位/非法输入/未知 uuid 返回 null。 */
export function moveToIndex(uuids: string[], src: string, target1: number, pinned: Set<string>): string[] | null {
  const si = uuids.indexOf(src)
  if (si < 0 || !Number.isFinite(target1)) return null
  const pinnedCount = uuids.filter((u) => pinned.has(u)).length
  let t = Math.round(target1)
  if (pinned.has(src)) t = Math.min(Math.max(t, 1), pinnedCount)
  else t = Math.min(Math.max(t, pinnedCount + 1), uuids.length)
  const arr = [...uuids]
  const [item] = arr.splice(si, 1)
  if (item === undefined) return null
  const ins = Math.min(Math.max(t - 1, 0), arr.length)
  if (ins === si) return null
  arr.splice(ins, 0, item)
  return arr
}
