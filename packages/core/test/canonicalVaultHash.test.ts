// T-FINAL Fix1（I-1）：vault 内容 hash 剔除顶层 rev。
//
// 缺陷背景：F8 水位使加密库每次落盘推进 vault.rev（进密文明文），而同步链路内容 hash 用
// contentHash（canonicalJson 全量）——采纳后 stored JSON 恒多 rev 字段 ≠ 基线，产生
// ①每采纳周期一次冗余云写；②下轮 localUnchanged=false；③零条目冲突合并轮沉淀冲突副本。
// contentHashVault = 剔除顶层 rev 后规范化 hash（同步链路统一口径）；既有 contentHash 不动。
import { describe, expect, it } from 'vitest'
import { contentHash, contentHashVault } from '../src/cloud/canonical'

const VAULT = JSON.stringify({
  version: 2,
  entries: [{ uuid: 'a', label: 'A', secret: 'S' }, { uuid: 'b', label: 'B', secret: 'T' }],
  tags: ['t1'],
  updatedAt: 42,
})
const withRev = (rev: number): string => JSON.stringify({ ...JSON.parse(VAULT), rev })

describe('contentHashVault（剔除顶层 rev 的 vault 内容 hash）', () => {
  it('顶层 rev 任意变化不影响 hash：带 rev 与不带 rev、rev 推进前后同 hash', async () => {
    expect(await contentHashVault(VAULT)).toBe(await contentHashVault(withRev(1)))
    expect(await contentHashVault(withRev(1))).toBe(await contentHashVault(withRev(99)))
  })

  it('仍对内容变化敏感：条目/updatedAt 任一变化 → hash 变', async () => {
    const baseline = await contentHashVault(withRev(1))
    const entryChanged = JSON.stringify({
      ...JSON.parse(withRev(1)),
      entries: [{ uuid: 'a', label: 'A-changed', secret: 'S' }, { uuid: 'b', label: 'B', secret: 'T' }],
    })
    const tsChanged = JSON.stringify({ ...JSON.parse(withRev(1)), updatedAt: 43 })
    expect(await contentHashVault(entryChanged)).not.toBe(baseline)
    expect(await contentHashVault(tsChanged)).not.toBe(baseline)
  })

  it('键序抖动仍被规范化消除（与 contentHash 同性质）', async () => {
    const reordered = JSON.stringify({ updatedAt: 42, tags: ['t1'], rev: 1, version: 2, entries: JSON.parse(VAULT).entries })
    expect(await contentHashVault(withRev(1))).toBe(await contentHashVault(reordered))
  })

  it('守卫：既有 contentHash 不动——rev 字段仍参与其 hash（旧口径可区分 rev）', async () => {
    expect(await contentHash(VAULT)).not.toBe(await contentHash(withRev(1)))
    expect(await contentHash(withRev(1))).not.toBe(await contentHash(withRev(2)))
  })
})
