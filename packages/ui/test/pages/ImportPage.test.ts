import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createMemoryStorage } from '@totp/core'
import { createVueStore } from '../../src/store'
import ImportPage from '../../src/pages/ImportPage.vue'
import { createTestI18n } from '../helpers/i18n'
import ImportCard from '../../src/components/ImportCard.vue'
import type { BackupPlatform } from '../../src/components/backupPlatform'

async function readyStore() {
  const s = createVueStore(createMemoryStorage())
  await s.initStore()
  return s
}

/** BackupPlatform 最小实现（ImportPage 只消费 readImportFile 派生导入平台） */
function backupPlatform(readImportFile?: BackupPlatform['readImportFile']): BackupPlatform {
  return {
    createBackup: vi.fn(async () => '已备份到 1 个目录'),
    ...(readImportFile ? { readImportFile } : {}),
  }
}

describe('ImportPage', () => {
  it('platform.readImportFile 存在 → 渲染 ImportCard（DOM 落地，卡片本体 v-if）', async () => {
    const s = await readyStore()
    const w = mount(ImportPage, { global: { plugins: [createTestI18n()] },
      props: { store: s, platform: backupPlatform(async () => null), schemesApi: null },
    })
    expect(w.find('section.import').exists()).toBe(true)
  })

  it('platform.readImportFile 缺失 → 不渲染 ImportCard（popup 零影响）', async () => {
    const s = await readyStore()
    const w = mount(ImportPage, { global: { plugins: [createTestI18n()] }, props: { store: s, platform: backupPlatform() } })
    expect(w.find('section.import').exists()).toBe(false)
  })

  it('platform=null → 不渲染 ImportCard', async () => {
    const s = await readyStore()
    const w = mount(ImportPage, { global: { plugins: [createTestI18n()] }, props: { store: s, platform: null } })
    expect(w.find('section.import').exists()).toBe(false)
  })

  it('schemesApi 缺省（null）时不报错；提供时透传给 ImportCard', async () => {
    const s = await readyStore()
    const schemesApi = { load: vi.fn(async () => []), save: vi.fn(async () => {}) }
    const w = mount(ImportPage, { global: { plugins: [createTestI18n()] },
      props: { store: s, platform: backupPlatform(async () => null), schemesApi },
    })
    expect(w.findComponent(ImportCard).props('schemesApi')).toStrictEqual(schemesApi)
  })
})
