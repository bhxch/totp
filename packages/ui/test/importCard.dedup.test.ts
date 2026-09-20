import { describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createMemoryStorage, newEntryFromUri } from '@totp/core'
import { createVueStore } from '../src/store'
import ImportCard from '../src/components/ImportCard.vue'
import { createTestI18n } from './helpers/i18n'

// plan16 T10：ImportCard 四档去重判定树接线（identical > suspect > conflict > new，设计 §4）
const vaultUri = (secret: string, issuer: string, label: string): string =>
  `otpauth://totp/${issuer}:${label}?secret=${secret}`

/** vault 种子：现有 GitHub/me@x.com，secret=JBSWY3DPEHPK3PXP */
async function readyStore() {
  const s = createVueStore(createMemoryStorage())
  await s.initStore()
  await s.addEntryOp(newEntryFromUri(vaultUri('JBSWY3DPEHPK3PXP', 'GitHub', 'me@x.com'), 0))
  return s
}

/** 导入 URI 文本走完 start→next 进 confirm 页 */
async function gotoConfirm(w: VueWrapper, text: string): Promise<void> {
  await w.find('button.import-start').trigger('click')
  await vi.waitFor(() => expect(w.text()).toContain('uriBatch'))
  await w.find('button.import-next').trigger('click')
  await vi.waitFor(() => expect(w.text()).toContain('新增')) // 四组计数行出现即 confirm 页
}

function mkPlatform(store: Awaited<ReturnType<typeof readyStore>>, text: string) {
  return { readImportFile: vi.fn().mockResolvedValue({ text, name: 'u.txt' }), store }
}

describe('ImportCard 去重接线', () => {
  it('完全重复文件重导入：全部 identical → 零落库，report 显示自动跳过数', async () => {
    const store = await readyStore()
    const w = mount(ImportCard, { global: { plugins: [createTestI18n()] }, props: { platform: mkPlatform(store, vaultUri('JBSWY3DPEHPK3PXP', 'GitHub', 'me@x.com')) } })
    await gotoConfirm(w, '')
    expect(w.text()).toContain('新增 0')
    expect(w.text()).toContain('完全相同自动跳过 1')
    expect(w.text()).toContain('疑似同账户 0')
    expect(w.text()).toContain('冲突 0')
    await w.find('button.import-commit').trigger('click')
    await vi.waitFor(() => expect(w.text()).toContain('成功落库 0 条'))
    expect(w.text()).toContain('完全相同自动跳过 1 条')
    expect(store.vault.entries).toHaveLength(1) // 无重复落库
  })

  it('同 secret 异 label：suspect 默认跳过，不落库', async () => {
    const store = await readyStore()
    const w = mount(ImportCard, { global: { plugins: [createTestI18n()] }, props: { platform: mkPlatform(store, vaultUri('JBSWY3DPEHPK3PXP', 'Other', 'other@y.z')) } })
    await gotoConfirm(w, '')
    expect(w.text()).toContain('疑似同账户 1')
    // 逐条确认区：导入 → 现有 映射行
    expect(w.text()).toContain('导入 Other/other@y.z')
    expect(w.text()).toContain('现有 GitHub/me@x.com')
    await w.find('button.import-commit').trigger('click') // 默认 skip，不点分段按钮
    await vi.waitFor(() => expect(w.text()).toContain('成功落库 0 条'))
    expect(w.text()).toContain('疑似同账户跳过 1 条')
    expect(store.vault.entries).toHaveLength(1)
  })

  it('同 secret 异 label：suspect 选「新增」落库为独立条目', async () => {
    const store = await readyStore()
    const w = mount(ImportCard, { global: { plugins: [createTestI18n()] }, props: { platform: mkPlatform(store, vaultUri('JBSWY3DPEHPK3PXP', 'Other', 'other@y.z')) } })
    await gotoConfirm(w, '')
    await w.findAll('.suspect-row .md-seg__item')[1]!.trigger('click') // 跳过/新增/覆盖 中的「新增」
    await w.find('button.import-commit').trigger('click')
    await vi.waitFor(() => expect(w.text()).toContain('成功落库 1 条'))
    expect(w.text()).toContain('疑似同账户新增 1 条')
    expect(store.vault.entries).toHaveLength(2)
    expect(store.vault.entries.some((e) => e.issuer === 'Other' && e.label === 'other@y.z')).toBe(true)
  })

  it('同 secret 异 label：suspect 选「覆盖」按 secret 定位替换现有条目（保留 uuid）', async () => {
    const store = await readyStore()
    const originalUuid = store.vault.entries[0]!.uuid
    const w = mount(ImportCard, { global: { plugins: [createTestI18n()] }, props: { platform: mkPlatform(store, vaultUri('JBSWY3DPEHPK3PXP', 'Other', 'other@y.z')) } })
    await gotoConfirm(w, '')
    await w.findAll('.suspect-row .md-seg__item')[2]!.trigger('click') // 「覆盖」
    await w.find('button.import-commit').trigger('click')
    await vi.waitFor(() => expect(w.text()).toContain('成功落库 0 条'))
    expect(w.text()).toContain('疑似同账户覆盖 1 条')
    expect(store.vault.entries).toHaveLength(1)
    expect(store.vault.entries[0]!.uuid).toBe(originalUuid) // 覆盖原条目而非新增
    expect(store.vault.entries[0]!.issuer).toBe('Other')
    expect(store.vault.entries[0]!.label).toBe('other@y.z')
  })

  it('同 issuer+label 异 secret：conflict 三选路径不回归（replace 覆盖目标条目）', async () => {
    const store = await readyStore()
    const originalUuid = store.vault.entries[0]!.uuid
    const w = mount(ImportCard, { global: { plugins: [createTestI18n()] }, props: { platform: mkPlatform(store, vaultUri('JBSWY3DPEHPK3PXQ', 'GitHub', 'me@x.com')) } })
    await gotoConfirm(w, '')
    expect(w.text()).toContain('冲突 1')
    expect(w.text()).not.toContain('疑似同账户 1') // secret 不同不落 suspect 分支
    await w.findAll('.policies .md-seg__item')[1]!.trigger('click') // 覆盖现有条目
    await w.find('button.import-commit').trigger('click')
    await vi.waitFor(() => expect(w.text()).toContain('成功落库 0 条'))
    expect(w.text()).toContain('覆盖 1 条（与现有条目冲突）')
    expect(store.vault.entries).toHaveLength(1)
    expect(store.vault.entries[0]!.uuid).toBe(originalUuid)
    expect(store.vault.entries[0]!.secret).toContain('JBSWY3DPEHPK3PXQ')
  })

  it('文件内完全重复行合并：confirm 提示合并数，落库不重复', async () => {
    const store = await readyStore()
    const line = vaultUri('JBSWY3DPEHPK3PXQ', 'Fresh', 'f@x.com')
    const w = mount(ImportCard, { global: { plugins: [createTestI18n()] }, props: { platform: mkPlatform(store, `${line}\n${line}`) } })
    await gotoConfirm(w, '')
    expect(w.text()).toContain('文件内重复已合并 1 条')
    expect(w.text()).toContain('新增 1') // 合并后仅 1 条待导入
    await w.find('button.import-commit').trigger('click')
    await vi.waitFor(() => expect(w.text()).toContain('成功落库 1 条'))
    expect(w.text()).toContain('文件内重复已合并 1 条') // report 页同样展示
    expect(store.vault.entries).toHaveLength(2) // 原有 GitHub + Fresh 一条
  })

  it('commit 前 vault 变化：按最新 vault 重算判定树（预览 new → commit 时 identical 跳过）', async () => {
    const store = await readyStore()
    const w = mount(ImportCard, { global: { plugins: [createTestI18n()] }, props: { platform: mkPlatform(store, vaultUri('JBSWY3DPEHPK3PXQ', 'Fresh', 'f@x.com')) } })
    await gotoConfirm(w, '')
    expect(w.text()).toContain('新增 1')
    // 预览期间 vault 被其他窗口/远端写入同内容条目
    await store.addEntryOp(newEntryFromUri(vaultUri('JBSWY3DPEHPK3PXQ', 'Fresh', 'f@x.com'), 0))
    await w.find('button.import-commit').trigger('click')
    await vi.waitFor(() => expect(w.text()).toContain('成功落库 0 条'))
    expect(w.text()).toContain('完全相同自动跳过 1 条') // 重算后转 identical
    expect(store.vault.entries).toHaveLength(2)
    expect(store.vault.entries.filter((e) => e.issuer === 'Fresh')).toHaveLength(1) // 不重复落库
  })
})
