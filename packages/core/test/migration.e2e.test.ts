/**
 * plan16 迁移端到端（Task 16）：仅用 core 纯函数模拟完整宿主迁移序列（不依赖 ui/宿主实现）。
 * 旧态：v1 加密 vault 密文内含遗留 backupSecret 字段 + 旧云多目标键四件套
 * （cloudCreds 多源 / cloudCred 单对象回退 / cloudRevs / cloudRev）。
 * 迁移序列（与 ui store.migrateLegacySecrets + desktop/extension migrateLegacyCloudSources 同构）：
 *   解锁得 DEK → openSecretBag 空袋 → vault 内 backupSecret 写入保管区并密封（先写新）
 *   → 剥除字段重加密落盘（后删旧）→ cloudCreds 解析（缺失回退 cloudCred 单对象）
 *   → saveSources（id=旧 backend 键）→ 逐源凭据入保管区 → saveSourceRev 基线平移 → 删四旧键。
 * 断言：盘上 vault 密文解出无 backupSecret；保管区密文可解口令+两凭据；backupSources 形状正确；
 * sourceRevs 平移；四个旧键全删；迁移完成态二次运行整段序列零写盘（counting adapter）；
 * 第 2 个凭据 saveCred 抛错中断 → 旧键原样保留 → 重跑收敛（先写新后删旧）。
 */
import { describe, expect, it } from 'vitest'
import {
  decryptVaultWithDek, encryptVaultWithDek, isEncryptedVault, SECURITY_KEY,
  setupVaultEncryption, unlockVaultEncryption,
} from '../src/security/securityStore'
import { openSecretBag, sealSecretBag, SECRET_BAG_KEY } from '../src/backup/secretBag'
import {
  loadSourceRevs, loadSources, saveSourceRev, saveSources,
  SOURCE_REVS_KEY, SOURCES_KEY, type BackupSource,
} from '../src/backup/sources'
import type { CloudCred } from '../src/cloud/backend'
import type { StorageAdapter } from '../src/storage/adapter'
import { VAULT_KEY } from '../src/storage/vaultStore'

const CLOUD_CRED_KEY = 'cloudCred'
const CLOUD_CREDS_KEY = 'cloudCreds'
const CLOUD_REV_KEY = 'cloudRev'
const CLOUD_REVS_KEY = 'cloudRevs'
const OLD_KEYS = [CLOUD_CRED_KEY, CLOUD_CREDS_KEY, CLOUD_REV_KEY, CLOUD_REVS_KEY] as const

const PASSPHRASE = '主口令P@ss'
const LEGACY_SECRET = '旧备份口令'

const WEBDAV: CloudCred = { backend: 'webdav', serverUrl: 'https://dav.example', username: 'u', password: 'p1' }
const GIST: CloudCred = { backend: 'gist', token: 't', gistId: 'g' }

/** 旧盘上 vault 形状（plan16 前）：Vault 模型当时还有 backupSecret 字段 */
const OLD_VAULT_OBJ = {
  version: 1 as const,
  entries: [{ uuid: 'e1', issuer: 'Old', label: 'a@b', secret: 'JBSWY3DPEHPK3PXP', algo: 'SHA1', digits: 6, period: 30, type: 'totp', order: 0 }],
  groups: [] as unknown[],
  updatedAt: 12345,
  backupSecret: LEGACY_SECRET,
}

/** 旧目标 backend → 用户可见名（与宿主 BACKEND_LABEL 同表） */
const BACKEND_LABEL: Record<string, string> = {
  webdav: 'WebDAV', s3: 'S3', gist: 'GitHub Gist', gdrive: 'Google Drive', onedrive: 'OneDrive', local: '本地目录',
}

/** 计数 StorageAdapter：记录 set/delete 次数（二次运行零写盘断言用），data 供键存在性断言 */
function makeAdapter(initial: Record<string, string> = {}): StorageAdapter & {
  data: Record<string, string>
  writes: { set: number; delete: number }
} {
  const data: Record<string, string> = { ...initial }
  const writes = { set: 0, delete: 0 }
  return {
    data,
    writes,
    async get(key) {
      return data[key] ?? null
    },
    async set(key, value) {
      writes.set++
      data[key] = value
    },
    async delete(key) {
      writes.delete++
      delete data[key]
    },
  }
}

type Adapter = ReturnType<typeof makeAdapter>

/** 构造旧态：setupVaultEncryption 建库（fast 档位省时）后手动给 vault JSON 塞 backupSecret 再加密落盘 */
async function seedLegacyState(adapter: Adapter, cloudKeys: Record<string, string>): Promise<void> {
  const { security, encrypted } = await setupVaultEncryption(JSON.stringify(OLD_VAULT_OBJ), PASSPHRASE, { profile: 'fast' })
  adapter.data[SECURITY_KEY] = JSON.stringify(security)
  adapter.data[VAULT_KEY] = JSON.stringify(encrypted)
  Object.assign(adapter.data, cloudKeys)
}

/** 模拟宿主解锁：盘上 security → unlockVaultEncryption 得 DEK */
async function unlockFromDisk(adapter: Adapter): Promise<Uint8Array> {
  const security = JSON.parse(adapter.data[SECURITY_KEY]!)
  return unlockVaultEncryption(security, PASSPHRASE)
}

/** ui store.migrateLegacySecrets 同构（纯 core 版）：vault 内 backupSecret → 保管区（先写新）+ 剥除重加密落盘（后删旧）。
 *  幂等：字段已剥除（legacy undefined）时不写任何键。 */
async function migrateLegacySecrets(adapter: Adapter, dek: Uint8Array): Promise<void> {
  const raw = await adapter.get(VAULT_KEY)
  if (raw === null) return
  const parsed: unknown = JSON.parse(raw)
  let vaultObj: Record<string, unknown> | null = null
  let legacy: unknown
  if (isEncryptedVault(parsed)) {
    vaultObj = JSON.parse(await decryptVaultWithDek(dek, parsed)) as Record<string, unknown>
    legacy = vaultObj['backupSecret']
  } else if (parsed !== null && typeof parsed === 'object') {
    vaultObj = parsed as Record<string, unknown>
    legacy = vaultObj['backupSecret']
  }
  if (typeof legacy === 'string' && legacy !== '') {
    const bag = await openSecretBag(dek, await adapter.get(SECRET_BAG_KEY))
    if (!bag.backupPassword) {
      bag.backupPassword = legacy
      await adapter.set(SECRET_BAG_KEY, await sealSecretBag(dek, bag))
    }
  }
  if (legacy !== undefined && vaultObj !== null) {
    const stripped = { ...vaultObj }
    delete stripped['backupSecret']
    await adapter.set(VAULT_KEY, JSON.stringify(await encryptVaultWithDek(dek, JSON.stringify(stripped))))
  }
}

/** ui store.saveSourceCredOp 同构：凭据入保管区并密封落盘（每次从盘上重读保管区） */
function makeSaveCred(adapter: Adapter, dek: Uint8Array): (id: string, cred: CloudCred) => Promise<void> {
  return async (id, cred) => {
    const bag = await openSecretBag(dek, await adapter.get(SECRET_BAG_KEY))
    bag.creds[id] = cred
    await adapter.set(SECRET_BAG_KEY, await sealSecretBag(dek, bag))
  }
}

/** 宿主 migrateLegacyCloudSources 同构（desktop legacyMigrate.ts / extension cloudCredStore.ts 纯 core 版）：
 *  旧云键 → 源模型（id=旧 backend 键）+ 凭据入保管区 + sourceRevs 平移 + 四旧键删除（先写新后删旧）。
 *  返回本次迁移的源数（无旧键返回 0，不动任何键）。 */
async function migrateLegacyCloudSources(
  adapter: Adapter,
  dek: Uint8Array,
  deps: { saveCred(id: string, cred: CloudCred): Promise<void> },
): Promise<number> {
  // 读旧凭据：cloudCreds（数组）缺失回退 cloudCred（单对象 → enabled:true）
  let targets: { cred: CloudCred; enabled: boolean }[]
  const credsRaw = await adapter.get(CLOUD_CREDS_KEY)
  if (credsRaw !== null) {
    const parsed: unknown = JSON.parse(credsRaw)
    if (!Array.isArray(parsed)) return 0
    targets = parsed
      .filter((t): t is { cred: { backend: string }; enabled: boolean } => {
        const o = t as { cred?: { backend?: unknown }; enabled?: unknown }
        return typeof o?.cred?.backend === 'string' && typeof o.enabled === 'boolean'
      })
      .map((t) => ({ cred: t.cred as CloudCred, enabled: t.enabled }))
  } else {
    const singleRaw = await adapter.get(CLOUD_CRED_KEY)
    if (singleRaw === null) return 0
    const single = JSON.parse(singleRaw) as CloudCred
    if (typeof single?.backend !== 'string') return 0
    targets = [{ cred: single, enabled: true }]
  }
  if (targets.length === 0) return 0

  const existing = await loadSources(adapter)
  const migrated: BackupSource[] = targets.map((t) => ({
    id: t.cred.backend,
    kind: t.cred.backend,
    name: BACKEND_LABEL[t.cred.backend] ?? t.cred.backend,
    retention: { type: 'overwrite' },
    enabled: t.enabled,
  }))
  const merged = [...existing, ...migrated.filter((m) => !existing.some((e) => e.id === m.id))]

  // 先写新：源列表 → 逐源凭据入保管区 → 基线平移；任一步抛错旧键保留（异常上抛）
  await saveSources(adapter, merged)
  for (const t of targets) await deps.saveCred(t.cred.backend, t.cred)

  const revsRaw = await adapter.get(CLOUD_REVS_KEY)
  const ids = new Set(migrated.map((m) => m.id))
  if (revsRaw !== null) {
    const revs = JSON.parse(revsRaw) as Record<string, unknown>
    for (const [id, hash] of Object.entries(revs)) {
      if (typeof hash === 'string' && ids.has(id)) await saveSourceRev(adapter, id, hash)
    }
  } else {
    const legacyRev = await adapter.get(CLOUD_REV_KEY)
    const first = migrated[0]
    if (legacyRev !== null && first) await saveSourceRev(adapter, first.id, legacyRev)
  }

  await adapter.delete(CLOUD_CREDS_KEY)
  await adapter.delete(CLOUD_CRED_KEY)
  await adapter.delete(CLOUD_REVS_KEY)
  await adapter.delete(CLOUD_REV_KEY)
  return migrated.length
}

/** 宿主完整迁移序列：解锁 → migrateLegacySecrets → migrateLegacyCloudSources（App.vue 双汇合点同序） */
async function runHostMigration(
  adapter: Adapter,
  deps: { saveCred(id: string, cred: CloudCred): Promise<void> },
): Promise<{ dek: Uint8Array; migrated: number }> {
  const dek = await unlockFromDisk(adapter)
  await migrateLegacySecrets(adapter, dek)
  const migrated = await migrateLegacyCloudSources(adapter, dek, deps)
  return { dek, migrated }
}

/** 迁移后全量终态断言：vault 剥除/保管区内容/源形状/基线平移/旧键全删 */
async function expectMigratedState(adapter: Adapter, dek: Uint8Array, expectedCreds: Record<string, CloudCred>): Promise<void> {
  // 盘上 vault 密文解出后无 backupSecret，其余数据原样
  const enc = JSON.parse(adapter.data[VAULT_KEY]!)
  expect(isEncryptedVault(enc)).toBe(true)
  const vault = JSON.parse(await decryptVaultWithDek(dek, enc)) as Record<string, unknown>
  expect(vault).not.toHaveProperty('backupSecret')
  expect(vault['updatedAt']).toBe(OLD_VAULT_OBJ.updatedAt)

  // 保管区密文可解：口令 + 全部凭据
  const bag = await openSecretBag(dek, adapter.data[SECRET_BAG_KEY]!)
  expect(bag.backupPassword).toBe(LEGACY_SECRET)
  expect(bag.creds).toEqual(expectedCreds)

  // 旧键四件套全删
  for (const k of OLD_KEYS) expect(adapter.data[k]).toBeUndefined()

  // sourceRevs 键存在性由各用例自行断言（单对象回退无 cloudRevs 时形状不同）
}

describe('plan16 迁移端到端（纯 core 模拟宿主序列）', () => {
  it('两源 cloudCreds+cloudRevs：全序列迁移后 vault 剥除/保管区可解/源形状/基线平移/旧键全删；二次运行零写盘', async () => {
    const adapter = makeAdapter()
    await seedLegacyState(adapter, {
      [CLOUD_CREDS_KEY]: JSON.stringify([{ cred: WEBDAV, enabled: true }, { cred: GIST, enabled: false }]),
      [CLOUD_REVS_KEY]: JSON.stringify({ webdav: 'hash-w', gist: 'hash-g' }),
    })

    // 迁移前确认：盘上密文解出确含 backupSecret（旧态构造正确）
    const dekBefore = await unlockFromDisk(adapter)
    const before = JSON.parse(await decryptVaultWithDek(dekBefore, JSON.parse(adapter.data[VAULT_KEY]!))) as Record<string, unknown>
    expect(before['backupSecret']).toBe(LEGACY_SECRET)
    expect(await adapter.get(SECRET_BAG_KEY)).toBeNull()

    const { dek, migrated } = await runHostMigration(adapter, { saveCred: makeSaveCred(adapter, dekBefore) })
    expect(migrated).toBe(2)
    await expectMigratedState(adapter, dek, { webdav: WEBDAV, gist: GIST })

    // backupSources 形状：id=旧 backend 键、name 映射、retention overwrite、enabled 原值
    expect(await loadSources(adapter)).toEqual<BackupSource[]>([
      { id: 'webdav', kind: 'webdav', name: 'WebDAV', retention: { type: 'overwrite' }, enabled: true },
      { id: 'gist', kind: 'gist', name: 'GitHub Gist', retention: { type: 'overwrite' }, enabled: false },
    ])
    // sourceRevs 平移（键=源 id）
    expect(await loadSourceRevs(adapter)).toEqual({ webdav: 'hash-w', gist: 'hash-g' })

    // 二次运行整段序列：重新解锁后重跑全部迁移 → 零写盘（幂等完成态）
    const writesBefore = { ...adapter.writes }
    const second = await runHostMigration(adapter, { saveCred: makeSaveCred(adapter, dek) })
    expect(second.migrated).toBe(0)
    expect(adapter.writes.set).toBe(writesBefore.set)
    expect(adapter.writes.delete).toBe(writesBefore.delete)
  })

  it('单对象 cloudCred 回退：1 源 enabled:true、cloudRev 仅由首源继承，backupSecret 同步剥除', async () => {
    const adapter = makeAdapter()
    await seedLegacyState(adapter, {
      [CLOUD_CRED_KEY]: JSON.stringify(WEBDAV),
      [CLOUD_REV_KEY]: 'legacy-hash',
    })

    const { dek, migrated } = await runHostMigration(adapter, { saveCred: makeSaveCred(adapter, await unlockFromDisk(adapter)) })
    expect(migrated).toBe(1)
    await expectMigratedState(adapter, dek, { webdav: WEBDAV })

    expect(await loadSources(adapter)).toEqual<BackupSource[]>([
      { id: 'webdav', kind: 'webdav', name: 'WebDAV', retention: { type: 'overwrite' }, enabled: true },
    ])
    expect(await loadSourceRevs(adapter)).toEqual({ webdav: 'legacy-hash' })
    expect(await adapter.get(SOURCE_REVS_KEY)).not.toBeNull()
  })

  it('中断恢复：第 2 个凭据 saveCred 抛错 → 旧键仍在（先写新后删旧）→ 重跑整段序列收敛到一致终态', async () => {
    const adapter = makeAdapter()
    const legacyCreds = JSON.stringify([{ cred: WEBDAV, enabled: true }, { cred: GIST, enabled: true }])
    const legacyRevs = JSON.stringify({ webdav: 'hash-w', gist: 'hash-g' })
    await seedLegacyState(adapter, {
      [CLOUD_CREDS_KEY]: legacyCreds,
      [CLOUD_REVS_KEY]: legacyRevs,
    })

    // 中断：saveCred 第 2 次（gist）抛错
    let calls = 0
    const boom = new Error('需先启用加密才能保存云凭据')
    await expect(
      runHostMigration(adapter, {
        saveCred: async (id, cred) => {
          if (++calls === 2) throw boom
          await makeSaveCred(adapter, await unlockFromDisk(adapter))(id, cred)
        },
      }),
    ).rejects.toThrow('需先启用加密才能保存云凭据')

    // 旧键原样保留（读不出/未走完 = 不删）
    expect(adapter.data[CLOUD_CREDS_KEY]).toBe(legacyCreds)
    expect(adapter.data[CLOUD_REVS_KEY]).toBe(legacyRevs)
    // 先写新已生效：保管区已存口令+首个凭据，源列表已落盘
    const dekMid = await unlockFromDisk(adapter)
    const bagMid = await openSecretBag(dekMid, adapter.data[SECRET_BAG_KEY]!)
    expect(bagMid.backupPassword).toBe(LEGACY_SECRET)
    expect(Object.keys(bagMid.creds)).toEqual(['webdav'])
    expect((await loadSources(adapter)).map((s) => s.id)).toEqual(['webdav', 'gist'])

    // 重跑收敛：源按 id 去重不重复、凭据补齐、基线平移、旧键全删
    const { dek, migrated } = await runHostMigration(adapter, { saveCred: makeSaveCred(adapter, dekMid) })
    expect(migrated).toBe(2)
    await expectMigratedState(adapter, dek, { webdav: WEBDAV, gist: GIST })
    const sources = await loadSources(adapter)
    expect(sources.map((s) => s.id)).toEqual(['webdav', 'gist']) // 无重复
    expect(await loadSourceRevs(adapter)).toEqual({ webdav: 'hash-w', gist: 'hash-g' })
  })
})
