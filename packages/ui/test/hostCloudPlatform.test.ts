import { describe, expect, it, vi } from 'vitest'
import type { StorageAdapter } from '@totp/core'
import { createStoreBackedCloudPlatform } from '../src/host/cloudPlatform'
import type { VueStore } from '../src/store'

/** saveBackupFile 透传（plan23 §4）：仅消费该成员，store/adapter 不被触达，最小哑对象即可 */
const DUMMY_STORE = {} as VueStore
const DUMMY_ADAPTER = {} as StorageAdapter
const baseOverrides = {
  saveSources: async () => {},
  autoPrefs: { get: () => ({ onChange: false, onInterval: false, intervalMinutes: 60 }), set: () => {} },
}

describe('createStoreBackedCloudPlatform.saveBackupFile 透传（plan23 §4）', () => {
  it('overrides 提供：平台成员透传同引用', async () => {
    const saveBackupFile = vi.fn(async () => true)
    const platform = createStoreBackedCloudPlatform(DUMMY_STORE, DUMMY_ADAPTER, { ...baseOverrides, saveBackupFile })
    expect(platform.saveBackupFile).toBe(saveBackupFile)
    await expect(platform.saveBackupFile!('vault-20261010-090000.totpbackup', new Uint8Array([1]))).resolves.toBe(true)
    expect(saveBackupFile).toHaveBeenCalledWith('vault-20261010-090000.totpbackup', new Uint8Array([1]))
  })

  it('缺省：平台无 saveBackupFile 成员（能力检测不渲染导出按钮）', () => {
    const platform = createStoreBackedCloudPlatform(DUMMY_STORE, DUMMY_ADAPTER, { ...baseOverrides })
    expect(platform.saveBackupFile).toBeUndefined()
  })
})
