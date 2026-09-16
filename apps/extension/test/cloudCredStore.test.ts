/**
 * cloudCredStore 单测：内存 StorageAdapter（仿 syncEngine.test 的 storage 桩）注入，
 * 验证 Task 8 迁移约定在 storage.local 键形态下的实现（与 desktop App.vue *Impl 同语义）：
 * - cloudCreds 缺失回退旧 cloudCred（[{cred, enabled:true}]）；都无 → []；坏 JSON → 安全默认 []
 * - saveCreds 只写新键 cloudCreds 并删除旧键 cloudCred（重复保存旧键删除幂等）
 * - cloudRevs 缺失且旧 cloudRev 存在 → 仅 targets[0].cred.backend 继承旧基线，绝不回写新键
 * - saveTargetHash(null)=删除该 backend 的基线键（非写入 null 值）+删除旧 cloudRev 键
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { CloudCred, StorageAdapter } from '@totp/core'
import type { CloudTarget } from '@totp/ui'
import { createCloudCredStore } from '../src/cloudCredStore'

const CLOUD_CRED_KEY = 'cloudCred'
const CLOUD_CREDS_KEY = 'cloudCreds'
const CLOUD_REV_KEY = 'cloudRev'
const CLOUD_REVS_KEY = 'cloudRevs'

/** 内存 StorageAdapter：字符串键值 + data 供键存在性断言 */
function makeAdapter(initial: Record<string, string> = {}): StorageAdapter & { data: Record<string, string> } {
  const data: Record<string, string> = { ...initial }
  return {
    data,
    async get(key) {
      return data[key] ?? null
    },
    async set(key, value) {
      data[key] = value
    },
    async delete(key) {
      delete data[key]
    },
  }
}

const WEBDAV: CloudCred = { backend: 'webdav', serverUrl: 'https://dav', username: 'u', password: 'p' }
const GIST: CloudCred = { backend: 'gist', token: 't', gistId: 'g' }
const TARGETS: CloudTarget[] = [
  { cred: WEBDAV, enabled: true },
  { cred: GIST, enabled: false },
]

let adapter: StorageAdapter & { data: Record<string, string> }

beforeEach(() => {
  adapter = makeAdapter()
})

describe('loadCreds（迁移回退）', () => {
  it('①旧键回退：cloudCreds 缺失而 cloudCred 存在 → [{cred, enabled:true}]', async () => {
    adapter.data[CLOUD_CRED_KEY] = JSON.stringify(WEBDAV)
    await expect(createCloudCredStore(adapter).loadCreds()).resolves.toEqual([{ cred: WEBDAV, enabled: true }])
  })

  it('②都无 → []', async () => {
    await expect(createCloudCredStore(adapter).loadCreds()).resolves.toEqual([])
  })

  it('③坏 JSON → 安全默认 []（新键损坏不回退旧键，与 desktop 同口径）', async () => {
    adapter.data[CLOUD_CREDS_KEY] = '{not-json'
    adapter.data[CLOUD_CRED_KEY] = JSON.stringify(WEBDAV)
    await expect(createCloudCredStore(adapter).loadCreds()).resolves.toEqual([])
    adapter.data[CLOUD_CREDS_KEY] = JSON.stringify(TARGETS)
    adapter.data[CLOUD_CRED_KEY] = '{not-json' // 新键有效时旧键损坏不影响（新键优先）
    await expect(createCloudCredStore(adapter).loadCreds()).resolves.toEqual(TARGETS)
  })
})

describe('saveCreds', () => {
  it('④写新键并删除旧键；旧键已无时重复保存幂等不抛错', async () => {
    adapter.data[CLOUD_CRED_KEY] = JSON.stringify(WEBDAV)
    const store = createCloudCredStore(adapter)
    await store.saveCreds(TARGETS)
    expect(adapter.data[CLOUD_CREDS_KEY]).toBe(JSON.stringify(TARGETS))
    expect(CLOUD_CRED_KEY in adapter.data).toBe(false)
    await store.saveCreds([TARGETS[0]!]) // 再保存：旧键删除幂等
    expect(adapter.data[CLOUD_CREDS_KEY]).toBe(JSON.stringify([TARGETS[0]]))
    expect(CLOUD_CRED_KEY in adapter.data).toBe(false)
  })

  it('⑤roundtrip：saveCreds → loadCreds 原样还原', async () => {
    const store = createCloudCredStore(adapter)
    await store.saveCreds(TARGETS)
    await expect(store.loadCreds()).resolves.toEqual(TARGETS)
  })
})

describe('loadTargetHash（首目标继承）', () => {
  it('⑥cloudRevs 缺失且旧 cloudRev 存在 → 仅 targets[0].cred.backend 继承，且不回写新键', async () => {
    adapter.data[CLOUD_REV_KEY] = 'legacy-hash'
    adapter.data[CLOUD_CREDS_KEY] = JSON.stringify(TARGETS)
    const store = createCloudCredStore(adapter)
    await expect(store.loadTargetHash('webdav')).resolves.toBe('legacy-hash')
    await expect(store.loadTargetHash('gist')).resolves.toBeNull() // 非首目标不继承
    expect(CLOUD_REVS_KEY in adapter.data).toBe(false) // 绝不回写新键
  })

  it('⑦cloudRevs 存在时按新键读取（首目标也不吃旧键）；键缺失且无旧键 → null', async () => {
    adapter.data[CLOUD_REVS_KEY] = JSON.stringify({ gist: 'g-hash' })
    adapter.data[CLOUD_REV_KEY] = 'legacy-hash'
    adapter.data[CLOUD_CREDS_KEY] = JSON.stringify(TARGETS)
    const store = createCloudCredStore(adapter)
    await expect(store.loadTargetHash('gist')).resolves.toBe('g-hash')
    await expect(store.loadTargetHash('webdav')).resolves.toBeNull() // 新键有值时不再回退旧键
    delete adapter.data[CLOUD_REVS_KEY]
    delete adapter.data[CLOUD_REV_KEY]
    await expect(store.loadTargetHash('webdav')).resolves.toBeNull()
  })
})

describe('saveTargetHash', () => {
  it('⑧hash=null 删除该 backend 基线键（非写入 null 值）并删除旧 cloudRev 键', async () => {
    adapter.data[CLOUD_REVS_KEY] = JSON.stringify({ webdav: 'h1', gist: 'h2' })
    adapter.data[CLOUD_REV_KEY] = 'legacy'
    await createCloudCredStore(adapter).saveTargetHash('webdav', null)
    expect(JSON.parse(adapter.data[CLOUD_REVS_KEY]!)).toEqual({ gist: 'h2' })
    expect(adapter.data[CLOUD_REVS_KEY]!).not.toContain('webdav')
    expect(CLOUD_REV_KEY in adapter.data).toBe(false)
  })

  it('⑨roundtrip：saveTargetHash → loadTargetHash 还原；重复置 null 幂等', async () => {
    const store = createCloudCredStore(adapter)
    await store.saveTargetHash('webdav', 'h1')
    await expect(store.loadTargetHash('webdav')).resolves.toBe('h1')
    await store.saveTargetHash('webdav', null)
    await store.saveTargetHash('webdav', null) // 幂等
    await expect(store.loadTargetHash('webdav')).resolves.toBeNull()
  })
})
