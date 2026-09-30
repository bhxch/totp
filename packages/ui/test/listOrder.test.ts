import { describe, expect, it } from 'vitest'
import { moveToIndex, moveWithinPartition } from '../src/entriesSort'

/** ④C 拖拽/序号定位移动的纯函数：全序 = 置顶区前缀 + 普通区（sortEntries 口径） */
const uuids = ['a', 'b', 'c', 'd', 'e']
const PINNED_A = new Set(['a'])

describe('moveWithinPartition（拖拽落点）', () => {
  it('同区内移动：a 拖到 c 之后 → [b,c,a,d,e]', () => {
    expect(moveWithinPartition(uuids, 'a', 'c', false, new Set())).toEqual(['b', 'c', 'a', 'd', 'e'])
  })
  it('before 落点：a 拖到 c 之前 → [b,a,c] 移除后插目标前', () => {
    expect(moveWithinPartition(uuids, 'a', 'c', true, new Set())).toEqual(['b', 'a', 'c', 'd', 'e'])
  })
  it('向后拖：a → d below 落其后（移除后下标重算）', () => {
    expect(moveWithinPartition(uuids, 'a', 'd', false, new Set())).toEqual(['b', 'c', 'd', 'a', 'e'])
  })
  it('跨区回弹：普通条目拖入置顶区返回 null', () => {
    expect(moveWithinPartition(uuids, 'b', 'a', true, PINNED_A)).toBeNull()
  })
  it('置顶区内可移动：a 是唯一置顶 → 单元素区无可动，落位仍是置顶区则放行', () => {
    // a(pinned) 拖到 b after：b 非同区，落位越界 → null
    expect(moveWithinPartition(uuids, 'a', 'b', false, PINNED_A)).toBeNull()
  })
  it('src/target 缺席或相同：null', () => {
    expect(moveWithinPartition(uuids, 'x', 'b', true, new Set())).toBeNull()
    expect(moveWithinPartition(uuids, 'a', 'a', true, new Set())).toBeNull()
  })
  it('置顶条目在置顶区内移动（多置顶）：p,q 拖动放行', () => {
    const twoPinned = new Set(['p', 'q'])
    expect(moveWithinPartition(['p', 'q', 'r', 's'], 'p', 'q', false, twoPinned)).toEqual(['q', 'p', 'r', 's'])
  })
})

describe('moveToIndex（序号定位移动）', () => {
  it('普通条目移到目标序号：c → 1 → [c,a,b,d,e]', () => {
    expect(moveToIndex(uuids, 'c', 1, new Set())).toEqual(['c', 'a', 'b', 'd', 'e'])
  })
  it('超过最大序号落末尾：a → 99 → [b,c,d,e,a]', () => {
    expect(moveToIndex(uuids, 'a', 99, new Set())).toEqual(['b', 'c', 'd', 'e', 'a'])
  })
  it('非置顶条目目标落在置顶区内 → 落到普通区顶部（设计分区规则）', () => {
    expect(moveToIndex(uuids, 'c', 1, PINNED_A)).toEqual(['a', 'c', 'b', 'd', 'e'])
  })
  it('置顶条目输入超置顶区长度 → 置顶区末尾', () => {
    const twoPinned = new Set(['p', 'q'])
    expect(moveToIndex(['p', 'q', 'r'], 'p', 99, twoPinned)).toEqual(['q', 'p', 'r'])
  })
  it('同位（无位移）返回 null；非法输入返回 null', () => {
    expect(moveToIndex(uuids, 'a', 1, new Set())).toBeNull()
    expect(moveToIndex(uuids, 'a', Number.NaN, new Set())).toBeNull()
    expect(moveToIndex(uuids, 'ghost', 2, new Set())).toBeNull()
  })
})
