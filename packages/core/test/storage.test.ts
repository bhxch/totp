import { describe, expect, it } from 'vitest'
import { createMemoryStorage } from '../src/storage/memory'
import { loadVault, saveVault, VAULT_KEY } from '../src/storage/vaultStore'
import { addEntry, createVault } from '../src/vault'
import { newEntryFromUri } from '../src/vault'

describe('memory storage', () => {
  it('set/get/delete', async () => {
    const s = createMemoryStorage()
    expect(await s.get('k')).toBeNull()
    await s.set('k', 'v1')
    expect(await s.get('k')).toBe('v1')
    await s.delete('k')
    expect(await s.get('k')).toBeNull()
  })
})

describe('vaultStore', () => {
  it('空存储返回全新 vault', async () => {
    expect(await loadVault(createMemoryStorage())).toEqual(createVault())
  })

  it('save 后 load 往返一致', async () => {
    const s = createMemoryStorage()
    const v = addEntry(createVault(), newEntryFromUri('otpauth://totp/A:b?secret=JBSWY3DPEHPK3PXP'))
    await saveVault(s, v)
    expect(await loadVault(s)).toEqual(v)
    expect(JSON.parse((await s.get(VAULT_KEY))!).version).toBe(2)
  })

  it('损坏数据抛 vault corrupted', async () => {
    const s = createMemoryStorage()
    await s.set(VAULT_KEY, '{oops')
    await expect(loadVault(s)).rejects.toThrow('vault corrupted')
  })
})
