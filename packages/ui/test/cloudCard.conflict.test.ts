import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { computed, ref } from 'vue'
import type { EntryConflict } from '@totp/core'
import CloudCard from '../src/components/CloudCard.vue'
import {
  clearSyncProgress, requestMergeConfirm, setSyncProgress, settleMergeConfirm,
} from '../src/components/cloudSyncBridge'
import { createTestI18n } from './helpers/i18n'
import type { CloudPlatform } from '../src/components/cloudPlatform'
import type { VueStore } from '../src/store'

const VALID_VAULT = JSON.stringify({ version: 2, entries: [], tags: [], updatedAt: 0 })

const SOURCE_A = { id: 's-a', kind: 'webdav' as const, name: 'WebDAV', retention: { type: 'overwrite' as const }, enabled: true, role: 'primary' as const }
const SOURCE_B = { id: 's-b', kind: 'gist' as const, name: 'Gist', retention: { type: 'overwrite' as const }, enabled: true, role: 'replica' as const }

const CONFLICT: EntryConflict = {
  entryId: 'e1', issuer: 'GitHub', label: 'me@example.com',
  ours: null, theirs: null, base: null, // 形状最小化：本文件不依赖条目内容
}

function mkPlatform(over: Partial<CloudPlatform> = {}): CloudPlatform {
  return {
    loadSources: vi.fn(async () => [SOURCE_A, SOURCE_B]),
    saveSources: vi.fn(async () => {}),
    saveCred: vi.fn(async () => {}),
    removeCred: vi.fn(async () => {}),
    creds: {},
    readVaultJson: () => VALID_VAULT,
    persistDownloaded: vi.fn(async () => {}),
    loadSourceState: vi.fn(async () => ({ lastKnownRemoteRev: null, baseSnapshot: null })),
    saveSourceState: vi.fn(async () => {}),
    deviceId: vi.fn(async () => 'dev-test'),
    autoPrefs: { get: () => ({ onChange: false, onInterval: false, intervalMinutes: 60 }), set: () => {} },
    ...over,
  }
}

/** 最小 store 面（CloudCard 只消费 mergeConflicts/conflictCount/resolveMergeConflictOp） */
function mkStore(conflicts: EntryConflict[] = []): { store: VueStore; resolve: ReturnType<typeof vi.fn> } {
  const list = ref<EntryConflict[]>(conflicts)
  const resolve = vi.fn(async () => { list.value = [] })
  const store = {
    mergeConflicts: list,
    conflictCount: computed(() => list.value.length),
    resolveMergeConflictOp: resolve,
  } as unknown as VueStore
  return { store, resolve }
}

async function mountCard(p: CloudPlatform, store?: VueStore, authFailed?: boolean) {
  const w = mount(CloudCard, {
    global: { plugins: [createTestI18n()] },
    props: { platform: p, sessionSecret: 'pw', store: store ?? null, ...(authFailed === undefined ? {} : { authFailed }) },
  })
  await flushPromises()
  return w
}

afterEach(() => {
  settleMergeConfirm(false) // 清挂起征询，防用例间模块级桥状态串扰
  clearSyncProgress()
})

describe('CloudCard 冲突区块（T11）', () => {
  it('conflictCount>0：渲染冲突区块与行文案；点「取本地方」调 store.resolveMergeConflictOp(\'e1\',\'ours\')，裁决后区块消失', async () => {
    const { store, resolve } = mkStore([CONFLICT])
    const w = await mountCard(mkPlatform(), store)
    expect(w.find('.conflict-block').exists()).toBe(true)
    expect(w.text()).toContain('同步冲突')
    const picks = w.findAll('button.conflict-pick')
    expect(picks).toHaveLength(2)
    await picks[0]!.trigger('click')
    await flushPromises()
    expect(resolve).toHaveBeenCalledWith('e1', 'ours')
    expect(w.find('.conflict-block').exists()).toBe(false)
  })

  it('store 缺省（null）：不渲染冲突区块（popup 等宿主零影响）', async () => {
    const w = await mountCard(mkPlatform())
    expect(w.find('.conflict-block').exists()).toBe(false)
  })

  it('裁决拒绝走 fail 通道：err 消息呈现，列表保留', async () => {
    const list = ref<EntryConflict[]>([CONFLICT])
    const store = {
      mergeConflicts: list,
      conflictCount: computed(() => list.value.length),
      resolveMergeConflictOp: vi.fn(async () => { throw new Error('vault locked') }),
    } as unknown as VueStore
    const w = await mountCard(mkPlatform(), store)
    await w.findAll('button.conflict-pick')[1]!.trigger('click')
    await flushPromises()
    expect(w.find('.err').text()).toContain('vault locked')
    expect(w.find('.conflict-block').exists()).toBe(true)
  })
})

describe('CloudCard 凭据失效警示归位（T11）', () => {
  it('authFailed=true：渲染重授权警示（自 SyncCard 迁入）', async () => {
    const w = await mountCard(mkPlatform(), undefined, true)
    expect(w.text()).toContain('云端凭据已失效，请重新授权')
    expect(w.find('p[role="alert"]').exists()).toBe(true)
  })

  it('缺省 false：不渲染', async () => {
    const w = await mountCard(mkPlatform())
    expect(w.text()).not.toContain('云端凭据已失效')
  })
})

describe('CloudCard 冲突副本区（extension 平台能力）', () => {
  it('listConflictCopies 提供且有副本：渲染行 + 导出按钮调 exportConflictCopy(name)', async () => {
    const exportCopy = vi.fn(async () => true)
    const p = mkPlatform({
      listConflictCopies: vi.fn(async () => [{ name: 'conflict-s-a-123.totpbackup', at: 123 }]),
      exportConflictCopy: exportCopy,
    })
    const w = await mountCard(p)
    expect(w.text()).toContain('冲突副本')
    expect(w.text()).toContain('conflict-s-a-123.totpbackup')
    await w.find('button.copy-export').trigger('click')
    expect(exportCopy).toHaveBeenCalledWith('conflict-s-a-123.totpbackup')
  })

  it('无平台能力（desktop）：不渲染副本区', async () => {
    const w = await mountCard(mkPlatform())
    expect(w.text()).not.toContain('冲突副本')
  })

  it('导出无名=false：如实提示副本已不存在', async () => {
    const p = mkPlatform({
      listConflictCopies: vi.fn(async () => [{ name: 'gone.totpbackup', at: 1 }]),
      exportConflictCopy: vi.fn(async () => false),
    })
    const w = await mountCard(p)
    await w.find('button.copy-export').trigger('click')
    await flushPromises()
    expect(w.find('.err').text()).toContain('副本已不存在')
  })
})

describe('CloudCard 角色互斥（spec §2，T11）', () => {
  it('把 replica 源选为 primary：原 primary 降 replica 且该源移到列表首位（配合 loadSources 归一可持久化）', async () => {
    const w = await mountCard(mkPlatform())
    // 每源行一个角色分段控件（两枚按钮：主/副本）
    const segs = w.findAll('.target-role')
    expect(segs).toHaveLength(2)
    // 第二源（Gist，replica）点「主」
    await segs[1]!.findAll('button')[0]!.trigger('click')
    await flushPromises()
    const names = w.findAll('.target-head strong').map((x) => x.text())
    expect(names).toEqual(['Gist', 'WebDAV'])
    // 重排后重查 DOM：第一行（Gist）primary 选中态
    const after = w.findAll('.target-role')
    expect(after[0]!.findAll('button')[0]!.attributes('aria-checked')).toBe('true')
    expect(after[1]!.findAll('button')[0]!.attributes('aria-checked')).toBe('false')
  })

  it('已是 primary 点击 replica 无效果（启用源中恒恰一个 primary，让位须选举他人）', async () => {
    const w = await mountCard(mkPlatform())
    const segs = w.findAll('.target-role')
    await segs[0]!.findAll('button')[1]!.trigger('click') // 第一源（primary）点「副本」
    await flushPromises()
    const names = w.findAll('.target-head strong').map((x) => x.text())
    expect(names).toEqual(['WebDAV', 'Gist'])
    expect(segs[0]!.findAll('button')[0]!.attributes('aria-checked')).toBe('true')
  })
})

describe('CloudCard manual 合并预览桥（cloudSyncBridge）', () => {
  it('requestMergeConfirm 挂起 → 对话框打开；点确认 resolve(true) 且对话框关闭', async () => {
    const w = await mountCard(mkPlatform())
    expect(w.find('[role="dialog"]').exists()).toBe(false)
    const p = requestMergeConfirm({ conflicts: [], mergeDegraded: false, sourceName: 'WebDAV' })
    await flushPromises()
    expect(w.find('[role="dialog"]').exists()).toBe(true)
    await w.find('button.preview-confirm').trigger('click')
    await expect(p).resolves.toBe(true)
    await flushPromises()
    expect(w.find('[role="dialog"]').exists()).toBe(false)
  })

  it('点取消 resolve(false)（runner 记跳过态）', async () => {
    const w = await mountCard(mkPlatform())
    const p = requestMergeConfirm({ conflicts: [], mergeDegraded: true, sourceName: 'S3' })
    await flushPromises()
    await w.find('button.preview-cancel').trigger('click')
    await expect(p).resolves.toBe(false)
  })
})

describe('CloudCard 逐源进度（spec §5 ⑥）', () => {
  it('done<total：显示「x/y 源完成」进度行；轮末 (total,total) 自动隐藏', async () => {
    const w = await mountCard(mkPlatform())
    expect(w.find('.sync-progress').exists()).toBe(false)
    setSyncProgress(1, 2)
    await flushPromises()
    expect(w.find('.sync-progress').exists()).toBe(true)
    expect(w.text()).toContain('1/2')
    setSyncProgress(2, 2)
    await flushPromises()
    expect(w.find('.sync-progress').exists()).toBe(false)
  })
})
