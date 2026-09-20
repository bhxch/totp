import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createMemoryStorage, newEntryFromUri } from '@totp/core'
import { createVueStore } from '../../src/store'
import SyncPage from '../../src/pages/SyncPage.vue'
import { createTestI18n } from '../helpers/i18n'
import BackupCard from '../../src/components/BackupCard.vue'
import CloudCard from '../../src/components/CloudCard.vue'
import SyncCard from '../../src/components/SyncCard.vue'
import type { BackupPlatform } from '../../src/components/backupPlatform'
import type { CloudPlatform } from '../../src/components/cloudPlatform'
import type { SyncPlatform } from '../../src/components/syncPlatform'

async function readyStore() {
  const s = createVueStore(createMemoryStorage())
  await s.initStore()
  await s.addEntryOp(newEntryFromUri('otpauth://totp/GitHub:me@ex.com?secret=JBSWY3DPEHPK3PXP', 1))
  return s
}

function backupPlatform(): BackupPlatform {
  return {
    createBackup: vi.fn(async () => '已备份到 1 个目录'),
  }
}
/** CloudCard 挂载仅读接口做回填；同步链路成员不被页面路径触达，实现按需补全 */
function cloudPlatform(): CloudPlatform {
  return {
    loadSources: vi.fn(async () => []),
    saveSources: vi.fn(async () => {}),
    saveCred: vi.fn(async () => {}),
    removeCred: vi.fn(async () => {}),
    creds: {},
    readVaultJson: vi.fn(() => ''),
    persistDownloaded: vi.fn(async () => {}),
    loadTargetHash: vi.fn(async () => null),
    saveTargetHash: vi.fn(async () => {}),
    autoPrefs: { get: () => ({ onChange: false, onInterval: false, intervalMinutes: 60 }), set: () => {} },
  }
}
function syncPlatform(): SyncPlatform {
  return {
    syncEnabled: false,
    setSyncEnabled: vi.fn(async () => {}),
    readStatus: vi.fn(async () => null),
    canSync: true,
  }
}

describe('SyncPage 三区块按 props 缺省渲染', () => {
  it('三平台齐备 → 本地备份/云同步/浏览器同步三区块都渲染', async () => {
    const s = await readyStore()
    const w = mount(SyncPage, { global: { plugins: [createTestI18n()] },
      props: { store: s, platform: backupPlatform(), cloudPlatform: cloudPlatform(), syncPlatform: syncPlatform() },
    })
    expect(w.findComponent(BackupCard).exists()).toBe(true)
    expect(w.findComponent(CloudCard).exists()).toBe(true)
    expect(w.findComponent(SyncCard).exists()).toBe(true)
  })

  it('platform 缺省 → 不渲染本地备份区块', async () => {
    const s = await readyStore()
    const w = mount(SyncPage, { global: { plugins: [createTestI18n()] },
      props: { store: s, platform: null, cloudPlatform: cloudPlatform(), syncPlatform: syncPlatform() },
    })
    expect(w.findComponent(BackupCard).exists()).toBe(false)
    expect(w.findComponent(CloudCard).exists()).toBe(true)
    expect(w.findComponent(SyncCard).exists()).toBe(true)
  })

  it('cloudPlatform 缺省 → 不渲染云同步区块', async () => {
    const s = await readyStore()
    const w = mount(SyncPage, { global: { plugins: [createTestI18n()] },
      props: { store: s, platform: backupPlatform(), cloudPlatform: null, syncPlatform: syncPlatform() },
    })
    expect(w.findComponent(BackupCard).exists()).toBe(true)
    expect(w.findComponent(CloudCard).exists()).toBe(false)
    expect(w.findComponent(SyncCard).exists()).toBe(true)
  })

  it('syncPlatform 缺省 → 不渲染浏览器同步区块', async () => {
    const s = await readyStore()
    const w = mount(SyncPage, { global: { plugins: [createTestI18n()] },
      props: { store: s, platform: backupPlatform(), cloudPlatform: cloudPlatform(), syncPlatform: null },
    })
    expect(w.findComponent(BackupCard).exists()).toBe(true)
    expect(w.findComponent(CloudCard).exists()).toBe(true)
    expect(w.findComponent(SyncCard).exists()).toBe(false)
  })

  it('BackupCard 收到 vault JSON 快照（含条目数据）', async () => {
    const s = await readyStore()
    const w = mount(SyncPage, { global: { plugins: [createTestI18n()] },
      props: { store: s, platform: backupPlatform(), cloudPlatform: null, syncPlatform: null },
    })
    const json = String(w.findComponent(BackupCard).props('vaultJson'))
    expect(json).toContain('GitHub')
  })
})
