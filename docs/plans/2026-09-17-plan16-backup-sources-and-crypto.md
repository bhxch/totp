# 备份源统一模型 + 密钥出密文 + envelope v2 + 导入去重 + 锁定策略 实施计划（plan16）

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 落地 `docs/plans/2026-09-17-backup-sources-and-crypto-design.md` 四节设计：DEK 保管区（备份口令+云凭据出 vault/云密文、受主口令保护）、锁定策略四触发器、envelope v2（KDF 三档+被动轮换+主口令天数提示）、BackupSource 统一云/本地源（同类型多份+每源覆盖/keep-n）、导入去重判定树。

**Architecture:** 纯逻辑全部下沉 `packages/core`（源模型/保管区密封/v2 信封/远端滚动删除/去重判定树/锁定判定），UI 卡片只做展示与确认流，两端宿主只做平台适配（chrome.storage.session + chrome.idle / Tauri 事件 + fs）。复用点：store 既有 `applyDekAndUnlock`/`lock` 双路径是保管区装载/清空的唯一汇合点；`syncMultipleTargets` 的 `key` 本就是不透明字符串，换源 id 无 core 改动；`selectBackupsToKeep` 直接复用于远端滚动删除。

**Tech Stack:** TypeScript + Vue3 + vitest 2（core=node / ui=jsdom+@vue/test-utils）+ Tauri 2（Rust，仅 Task 15 增 Windows 锁屏事件）+ WXT。无新增 npm 依赖。

**Spec:** `docs/plans/2026-09-17-backup-sources-and-crypto-design.md`。上游事实核查结论（写码前必读的六个事实）：

1. `store.ts` 的 `applyDekAndUnlock`（store.ts:328）是 password/PRF/DPAPI 三条解锁路径的唯一汇合点，`lock()`（store.ts:435）是唯一锁定汇合点——保管区装载/清空、DEK 持久化挂载点只在这两处。
2. `replaceVault`（store.ts:69）逐字段拷贝，`backupSecret` 分支删除后旧 vault 里残留的字段自然被丢弃——迁移必须显式读出后再剥除。
3. vault `backupSecret` 字段被 `vaultSecret.ts`、`store.ts`（4 处）、`BackupSecretCard.vue`、`disableEncryption`（store.ts:295）引用——删除时六处同改。
4. 云端旧 envelope（v1）在放弃兼容后**不可解**：用户 dogfood 设备的云对象需用 CloudCard 既有「用当前口令重置云端」救济，或手动重新备份——文档勘误中必须写明。
5. `cloudRevs`/`cloudCreds` 的迁移约定键在 `cloudPlatform.ts:28-38` 注释块与 `apps/extension/src/cloudCredStore.ts`、`apps/desktop/src/App.vue:227-285` 两处宿主——迁移函数放 core 纯逻辑，两端复用。
6. GDrive 的 `cred.fileId` 是**文件** id 非目录——keep-n 的 list 语义是「取该文件 parents，再列同父下 `vault-*`」；Gist 是天然多文件容器；OneDrive 同 GDrive 按 item parents 处理。

**测试约定：** core 测试在 `packages/core/test/*.test.ts`（vitest node）；ui 测试在 `packages/ui/test/*.test.ts`（jsdom+@vue/test-utils）；运行 `pnpm --filter @totp/core test` / `pnpm --filter @totp/ui test`；全量 `pnpm test`、typecheck `pnpm -r run typecheck`。每任务先写失败测试。新增 core 模块行覆盖 ≥95%（coverage-v8 基线，与 plan15 一致）。

**与设计的两处裁定偏差**（评审口头确认过的记录在案）：
- 本地库 KDF 档位**立即生效**（重 wrap 换 salt，不重加密数据）而非「下次改口令时生效」——重 wrap 成本即一次 argon2id，无「强制重加密」顾虑。
- 系统锁屏触发器 Windows 先行（Tauri Rust 模块 + WTS 通知），mac/Linux 记挂账与既有真机验证挂账合并。

---

## 里程碑总览

| 阶段 | 任务 | 内容 |
|---|---|---|
| A core 纯逻辑 | 1–6 | 源模型 / 保管区密封+vault 字段删除 / envelope v2+轮换 / 远端滚动删除+五后端 list / 去重判定树 / 锁定判定+settings 字段 |
| B ui 层 | 7–11 | store 保管区+轮换+DEK 持久化+迁移 / CloudCard 源列表化 / BackupCard 本地源列表化 / ImportCard 去重 / SecurityCard 档位+天数+锁定偏好 |
| C 宿主接线 | 12–15 | extension DEK session+idle / extension 迁移+runner / desktop 迁移+每源备份+runner / desktop 系统锁屏（Rust） |
| D 收尾 | 16 | 迁移端到端测试 + 文档勘误 + 全量验证（coverage） |

依赖：A→B→C 顺序严格；11 可与 8–10 并行；16 最后。

---

### Task 1: core — BackupSource 模型与存取

**Files:**
- Create: `packages/core/src/backup/sources.ts`
- Modify: `packages/core/src/index.ts`（追加 `export * from './backup/sources'`）
- Test: `packages/core/test/sources.test.ts`

**Step 1: 写失败测试**

```ts
// packages/core/test/sources.test.ts
import { describe, expect, it } from 'vitest'
import { createMemoryAdapter } from '../src/storage/memory'
import { isBackupSource, loadSourceRevs, loadSources, normalizeRetention, saveSourceRev, saveSources, type BackupSource } from '../src/backup/sources'

const src = (over: Partial<BackupSource> = {}): BackupSource => ({
  id: 's1', kind: 'webdav', name: '家里 WebDAV', retention: { type: 'overwrite' }, enabled: true, ...over,
})

describe('BackupSource 存取', () => {
  it('normalizeRetention：overwrite 与 keep(n≥1)，非法回退 overwrite', () => {
    expect(normalizeRetention({ type: 'overwrite' })).toEqual({ type: 'overwrite' })
    expect(normalizeRetention({ type: 'keep', n: 3 })).toEqual({ type: 'keep', n: 3 })
    expect(normalizeRetention({ type: 'keep', n: 0 })).toEqual({ type: 'overwrite' })
    expect(normalizeRetention(undefined)).toEqual({ type: 'overwrite' })
  })
  it('isBackupSource：合法真、缺 id/kind/retention 假、kind 非法假', () => {
    expect(isBackupSource(src())).toBe(true)
    expect(isBackupSource({ ...src(), id: '' })).toBe(false)
    expect(isBackupSource({ ...src(), kind: 'ftp' })).toBe(false)
    expect(isBackupSource({ ...src(), retention: { type: 'keep', n: -1 } })).toBe(false)
  })
  it('loadSources：坏 JSON/缺键 → 空数组；非法条目过滤不抛', async () => {
    const a = createMemoryAdapter()
    await expect(loadSources(a)).resolves.toEqual([])
    await a.set('backupSources', 'not json')
    await expect(loadSources(a)).resolves.toEqual([])
    await a.set('backupSources', JSON.stringify([src(), { id: 'bad' }]))
    await expect(loadSources(a)).resolves.toHaveLength(1)
  })
  it('saveSources→loadSources 往返', async () => {
    const a = createMemoryAdapter()
    await saveSources(a, [src({ retention: { type: 'keep', n: 5 } }), src({ id: 's2', kind: 'local', dir: 'C:\\bp' })])
    expect(await loadSources(a)).toHaveLength(2)
  })
  it('sourceRevs：按 id 存删基线；坏 JSON → 空', async () => {
    const a = createMemoryAdapter()
    expect(await loadSourceRevs(a)).toEqual({})
    await saveSourceRev(a, 's1', 'abc')
    await saveSourceRev(a, 's2', 'def')
    expect(await loadSourceRevs(a)).toEqual({ s1: 'abc', s2: 'def' })
    await saveSourceRev(a, 's1', null) // null=删除该源基线
    expect(await loadSourceRevs(a)).toEqual({ s2: 'def' })
  })
})
```

**Step 2: 运行确认失败**

Run: `pnpm --filter @totp/core test -- sources`
Expected: FAIL（模块不存在）

**Step 3: 实现 `packages/core/src/backup/sources.ts`**

```ts
/** 备份源统一模型（设计 §3）：云后端与桌面本地目录同构为「源」，同 kind 可多条，每源独立保留策略。
 *  元数据（本模块）明文存 settings 域；凭据是秘密，存 DEK 保管区（secretBag.ts）按 id 关联。 */
import type { StorageAdapter } from '../storage/adapter'

export type SourceKind = 'webdav' | 's3' | 'gist' | 'gdrive' | 'onedrive' | 'local'
export type Retention = { type: 'overwrite' } | { type: 'keep'; n: number }

export interface BackupSource {
  id: string
  kind: SourceKind
  /** 用户可见别名（如「家里 WebDAV」），同 kind 多份时区分用 */
  name: string
  retention: Retention
  enabled: boolean
  /** 云源对象路径（缺省回落 DEFAULT_OBJECT_PATH，沿 resolveObjectPath 校验） */
  objectPath?: string
  /** 本地源目录；null/缺省=应用数据 backups 目录 */
  dir?: string | null
}

export const SOURCES_KEY = 'backupSources'
export const SOURCE_REVS_KEY = 'sourceRevs'

const KINDS: readonly SourceKind[] = ['webdav', 's3', 'gist', 'gdrive', 'onedrive', 'local']

export function normalizeRetention(x: unknown): Retention {
  const r = x as { type?: unknown; n?: unknown } | null
  if (r?.type === 'keep' && typeof r.n === 'number' && Number.isInteger(r.n) && r.n >= 1) return { type: 'keep', n: r.n }
  return { type: 'overwrite' }
}

export function isBackupSource(x: unknown): x is BackupSource {
  if (typeof x !== 'object' || x === null) return false
  const o = x as Record<string, unknown>
  return (
    typeof o['id'] === 'string' && o['id'] !== '' &&
    typeof o['kind'] === 'string' && (KINDS as readonly string[]).includes(o['kind']) &&
    typeof o['name'] === 'string' &&
    typeof o['enabled'] === 'boolean' &&
    isRetentionShape(o['retention'])
  )
}

function isRetentionShape(x: unknown): boolean {
  const r = x as { type?: unknown; n?: unknown } | null
  if (r === null || typeof r !== 'object') return false
  if (r.type === 'overwrite') return true
  return r.type === 'keep' && typeof r.n === 'number' && Number.isInteger(r.n) && r.n >= 1
}

export async function loadSources(adapter: StorageAdapter): Promise<BackupSource[]> {
  let raw: string | null
  try {
    raw = await adapter.get(SOURCES_KEY)
  } catch {
    return []
  }
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter(isBackupSource) : []
  } catch {
    return []
  }
}

export async function saveSources(adapter: StorageAdapter, sources: BackupSource[]): Promise<void> {
  await adapter.set(SOURCES_KEY, JSON.stringify(sources))
}

export async function loadSourceRevs(adapter: StorageAdapter): Promise<Record<string, string>> {
  let raw: string | null
  try {
    raw = await adapter.get(SOURCE_REVS_KEY)
  } catch {
    return {}
  }
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(parsed)) if (typeof v === 'string') out[k] = v
    return out
  } catch {
    return {}
  }
}

/** hash=null 语义为删除该源基线键（与旧 saveTargetHash 一致，非写入 null 值） */
export async function saveSourceRev(adapter: StorageAdapter, id: string, hash: string | null): Promise<void> {
  const revs = await loadSourceRevs(adapter)
  if (hash === null) delete revs[id]
  else revs[id] = hash
  await adapter.set(SOURCE_REVS_KEY, JSON.stringify(revs))
}
```

（若 `createMemoryAdapter` 导出名不同，以 `packages/core/src/storage/memory.ts` 实际导出为准。）

**Step 4: 运行确认通过** → `pnpm --filter @totp/core test -- sources` PASS

**Step 5: Commit** `git add -A && git commit -m "feat(core): BackupSource 模型与存取纯函数（plan16 T1）"`（why：源统一模型数据底座；what：kind/retention/基线 CRUD）

### Task 2: core — DEK 保管区密封 + vault 备份口令字段删除

**Files:**
- Create: `packages/core/src/backup/secretBag.ts`
- Delete: `packages/core/src/backup/vaultSecret.ts`
- Modify: `packages/core/src/model.ts:35-42`（Vault 删 `backupSecret` 字段与注释）
- Modify: `packages/core/src/index.ts`（`vaultSecret` 行替换为 `secretBag`）
- Test: `packages/core/test/secretBag.test.ts`；修 `packages/core/test/vaultSecret.test.ts`（删除）

**Step 1: 写失败测试**

```ts
// packages/core/test/secretBag.test.ts
import { describe, expect, it } from 'vitest'
import { randomBytes } from '../src/crypto/aesgcm'
import { openSecretBag, sealSecretBag, SECRET_BAG_KEY, emptyBag } from '../src/backup/secretBag'

describe('DEK 保管区', () => {
  it('密封→开启往返（backupPassword + creds）', async () => {
    const dek = randomBytes(32)
    const sealed = await sealSecretBag(dek, { backupPassword: '口令A', creds: { s1: { backend: 'webdav', serverUrl: 'https://x', username: 'u', password: 'p' } } })
    const opened = await openSecretBag(dek, sealed)
    expect(opened.backupPassword).toBe('口令A')
    expect(opened.creds['s1']?.backend).toBe('webdav')
  })
  it('每次密封 nonce 不同（同内容不同密文）', async () => {
    const dek = randomBytes(32)
    const c = { backupPassword: 'x', creds: {} }
    expect(await sealSecretBag(dek, c)).not.toBe(await sealSecretBag(dek, c))
  })
  it('错 DEK 解密抛错', async () => {
    const sealed = await sealSecretBag(randomBytes(32), { backupPassword: 'x', creds: {} })
    await expect(openSecretBag(randomBytes(32), sealed)).rejects.toThrow()
  })
  it('null/坏 JSON/结构非法 → 空保管区（不抛）', async () => {
    const dek = randomBytes(32)
    expect(openSecretBag(dek, null)).resolves.toEqual(emptyBag())
    expect(openSecretBag(dek, 'not json')).resolves.toEqual(emptyBag())
    expect(openSecretBag(dek, JSON.stringify({ v: 1, nonce: '!!', ciphertext: '!!' }))).resolves.toEqual(emptyBag())
  })
  it('emptyBag 形状', () => {
    expect(emptyBag()).toEqual({ backupPassword: '', creds: {} })
  })
  it('SECRET_BAG_KEY 常量', () => {
    expect(SECRET_BAG_KEY).toBe('secretBag')
  })
})
```

同时**删除** `packages/core/test/vaultSecret.test.ts`（随实现删除，plan15 的 D1 语义由本任务正式反转）。

**Step 2: 运行确认失败** → `pnpm --filter @totp/core test -- secretBag` FAIL

**Step 3: 实现 `packages/core/src/backup/secretBag.ts`**

```ts
/** DEK 保管区（设计 §1）：备份口令与各源云凭据以库 DEK AES-256-GCM 加密后落设备侧独立键。
 *  vault/云 envelope 不再含任何秘密；锁定（DEK 丢弃）后保管区密文不可解。每次密封新随机 nonce。 */
import type { CloudCred } from '../cloud/backend'
import { aesGcmDecrypt, aesGcmEncrypt, base64ToBytes, bytesToBase64, randomBytes } from '../crypto/aesgcm'

export const SECRET_BAG_KEY = 'secretBag'

export interface SecretBagContent {
  /** 备份口令；空串=未设置 */
  backupPassword: string
  /** 源 id → 云凭据 */
  creds: Record<string, CloudCred>
}

export interface SecretBagEnvelope { v: 1; nonce: string; ciphertext: string }

export function emptyBag(): SecretBagContent {
  return { backupPassword: '', creds: {} }
}

export async function sealSecretBag(dek: Uint8Array, content: SecretBagContent): Promise<string> {
  if (dek.length !== 32) throw new Error('invalid dek')
  const nonce = randomBytes(12)
  const ciphertext = await aesGcmEncrypt(dek, new TextEncoder().encode(JSON.stringify(content)), nonce)
  const env: SecretBagEnvelope = { v: 1, nonce: bytesToBase64(nonce), ciphertext: bytesToBase64(ciphertext) }
  return JSON.stringify(env)
}

export async function openSecretBag(dek: Uint8Array, raw: string | null): Promise<SecretBagContent> {
  if (dek.length !== 32) throw new Error('invalid dek')
  if (raw === null || raw === '') return emptyBag()
  let env: SecretBagEnvelope
  try {
    env = JSON.parse(raw) as SecretBagEnvelope
  } catch {
    return emptyBag()
  }
  if (env?.v !== 1 || typeof env.nonce !== 'string' || typeof env.ciphertext !== 'string') return emptyBag()
  let pt: Uint8Array
  try {
    pt = await aesGcmDecrypt(dek, base64ToBytes(env.ciphertext), base64ToBytes(env.nonce))
  } catch {
    throw new Error('保管区解密失败：DEK 不匹配或数据损坏')
  }
  try {
    const parsed = JSON.parse(new TextDecoder().decode(pt)) as Partial<SecretBagContent>
    return { backupPassword: typeof parsed.backupPassword === 'string' ? parsed.backupPassword : '', creds: parsed.creds ?? {} }
  } catch {
    return emptyBag()
  }
}
```

**Step 3b: 删除 vault 字段与函数**（同步修改，core 内编译干净为准）：
- `model.ts`：删 `backupSecret?: string` 与其注释行；
- 删文件 `packages/core/src/backup/vaultSecret.ts`；
- `index.ts`：`export * from './backup/vaultSecret'` → `export * from './backup/secretBag'`；
- 全仓 `rg -l "vaultSecret|backupSecret"` 清理 core 内残留（此时 ui/apps 会编译失败——属预期，Task 7 修复；但**本任务内先只保证 core typecheck**：`pnpm --filter @totp/core typecheck`）。

**Step 4: 运行确认通过** → core test + core typecheck PASS

**Step 5: Commit** `feat(core): DEK 保管区密封并删除 vault 备份口令字段（plan16 T2，反转 plan15 D1）`

### Task 3: core — envelope v2（KDF 档位）+ 口令轮换 + passwordChangedAt

**Files:**
- Modify: `packages/core/src/backup/envelope.ts`（v2 重写，v1 删除）
- Modify: `packages/core/src/security/securityStore.ts`（SecuritySettings 增 `profile?`/`passwordChangedAt?`；setup/change 签名）
- Modify: `packages/core/src/cloud/syncOrchestrator.ts`（`pushEnvelope`/`SyncWithCloudOpts` 透传 `profile?`）
- Test: `packages/core/test/envelope.test.ts`（重写）、`packages/core/test/securityStore.test.ts`（增补）

**Step 1: 重写失败测试（关键用例）**

```ts
// packages/core/test/envelope.test.ts 核心断言（保留原往返/错口令用例，签名改 v2）
it('v2 结构：profile 展开参数与 aead 字段落盘', async () => {
  const env = await createBackupEnvelope('{"x":1}', '口令', 'fast')
  expect(env.v).toBe(2)
  expect(env.aead).toBe('aes-256-gcm')
  expect(env.kdf.profile).toBe('fast')
  expect(env.kdf.m).toBe(KDF_PROFILES.fast.m)
  expect(env.kdf.t).toBe(KDF_PROFILES.fast.t)
})
it('缺省档位 balanced（65536/3/1）', async () => {
  const env = await createBackupEnvelope('{}', '口令')
  expect(env.kdf.profile).toBe('balanced')
  expect(env.kdf.m).toBe(65536)
})
it('v1 信封拒绝（v!==2 → invalid backup envelope）', async () => {
  await expect(openBackupEnvelope({ v: 1, kdf: {}, wrapNonce: '', wrappedDek: '', dataNonce: '', ciphertext: '' }, 'x')).rejects.toThrow('invalid backup envelope')
})
it('KDF 参数钳制沿用：声明超大 m 拒绝', async () => {
  const env = await createBackupEnvelope('{}', '口令')
  const evil = { ...env, kdf: { ...env.kdf, m: 2 ** 30 } }
  await expect(openBackupEnvelope(evil, '口令')).rejects.toThrow('invalid backup envelope')
})
```

securityStore 增补用例：

```ts
it('setupVaultEncryption 写入 profile 与 passwordChangedAt', async () => {
  const r = await setupVaultEncryption('{}', '口令', { profile: 'paranoid' })
  expect(r.security.profile).toBe('paranoid')
  expect(r.security.kdf.m).toBe(262144)
  expect(typeof r.security.passwordChangedAt).toBe('number')
})
it('changeVaultPassphrase 缺省仅重包裹（dek=null）；rotateDek=true 返回新 DEK 且旧 DEK 解不开新 wrappedDek', async () => {
  const setup = await setupVaultEncryption('{}', '旧')
  const rewrap = await changeVaultPassphrase(setup.security, setup.dek, '新')
  expect(rewrap.dek).toBeNull()
  const rotated = await changeVaultPassphrase(setup.security, setup.dek, '新', { rotateDek: true, profile: 'fast' })
  expect(rotated.dek).not.toBeNull()
  expect(rotated.security.kdf.profile).toBe('fast')
  expect(rotated.security.passwordChangedAt).toBeGreaterThanOrEqual(setup.security.passwordChangedAt!)
})
```

**Step 2: 确认失败** 后实现。

**Step 3: envelope.ts v2 重写**（完整替换文件；`isKdfProfile`、`KDF_PROFILES`、`DEFAULT_KDF_PROFILE` 导出；`openBackupEnvelope` 只认 `v===2`，钳制逻辑沿用现有 MIN/MAX 注释；`createBackupEnvelope(vaultJson, password, profile = DEFAULT_KDF_PROFILE)`）：

```ts
export type KdfProfile = 'fast' | 'balanced' | 'paranoid'
/** KDF 档位（设计 §2）：fast≈OWASP 低档（低端机快），balanced=历史默认，paranoid=保守。
 *  展开参数同时落盘，读端仍按展开值钳制（profile 仅记录写入意图）。 */
export const KDF_PROFILES: Record<KdfProfile, { m: number; t: number; p: number }> = {
  fast: { m: 19_456, t: 2, p: 1 },
  balanced: { m: 65_536, t: 3, p: 1 },
  paranoid: { m: 262_144, t: 4, p: 1 },
}
export const DEFAULT_KDF_PROFILE: KdfProfile = 'balanced'

export interface BackupEnvelope {
  v: 2
  kdf: { alg: 'argon2id'; profile: KdfProfile; m: number; t: number; p: number; salt: string }
  wrapNonce: string
  wrappedDek: string
  aead: 'aes-256-gcm'
  dataNonce: string
  ciphertext: string
}
```

`securityStore.ts`：
- `SecuritySettings` 增 `profile?: KdfProfile; passwordChangedAt?: number`（import type 自 backup/envelope，注意避免循环依赖：KDF_PROFILES 在 envelope.ts，securityStore 已与 backup 层无依赖关系——将 `KdfProfile`/`KDF_PROFILES` 定义**上提至 securityStore.ts**，envelope.ts 从 securityStore re-export，保持单向依赖 security→backup 不成立、backup→security 亦不成立：**裁定：类型与常量放 `crypto/aesgcm.ts` 旁新文件 `crypto/kdfProfile.ts`**，两侧 import，零循环）。
- `setupVaultEncryption(vaultJson, password, opts: { profile?: KdfProfile } = {})`：kdf 展开值取 `KDF_PROFILES[profile]`，写 `profile` 与 `passwordChangedAt: Date.now()`。
- `changeVaultPassphrase(security, dek, newPassword, opts: { rotateDek?: boolean; profile?: KdfProfile } = {})` → 返回 `{ security: SecuritySettings; dek: Uint8Array | null }`：rotateDek=true 时 `dek=randomBytes(32)` 作被包裹对象并返回；profile 提供时 kdf 参数/salt 用新档位（salt 本就全新随机）；恒写 `passwordChangedAt: Date.now()`。

`syncOrchestrator.ts`：`SyncWithCloudOpts` 与 `pushEnvelope` opts 增 `profile?: KdfProfile`，透传 `createBackupEnvelope`。`multiTarget.ts` 的 `syncMultipleTargets` opts 同步增 `profile?` 透传。

全仓 `rg -l "BackupEnvelopeV1|createBackupEnvelope" packages apps` 修正引用（desktop `backupService.ts` 的 `type BackupEnvelopeV1` 改 `BackupEnvelope`；`writeBackupFileOs` 签名同步）。

**Step 4: core test + typecheck PASS**（ui/apps 失败留待 Task 7+；`pnpm --filter @totp/core test` 全绿为准——envelope/syncOrchestrator/multiTarget 既有测试同步改 v2 断言）

**Step 5: Commit** `feat(core): envelope v2 KDF 档位与口令轮换（plan16 T3，弃 v1 兼容）`

### Task 4: core — 远端滚动删除 + 云源时间戳路径 + 五后端 listBackups

**Files:**
- Create: `packages/core/src/backup/retention.ts`
- Modify: `packages/core/src/cloud/backend.ts`（CloudBackend 增可选 `listBackups?(): Promise<string[]>`）
- Modify: `packages/core/src/cloud/targetPath.ts`（增 `resolveTimestampPath(cred, now)`、`resolveDirPath(cred)`）
- Modify: `packages/core/src/cloud/{webdav,s3,gist,gdrive,onedrive}.ts`（各实现 `listBackups`）
- Modify: `packages/core/src/index.ts`（导出 retention）
- Test: `packages/core/test/retention.test.ts` + 各后端既有测试文件增补 listBackups 用例

**Step 1: 失败测试（core 侧）**

```ts
// packages/core/test/retention.test.ts
import { describe, expect, it, vi } from 'vitest'
import { enforceRemoteRetention } from '../src/backup/retention'
import { selectBackupsToKeep } from '../src/backup/policy'

describe('远端滚动删除', () => {
  const names = ['vault-20260101-000000.totpbackup', 'vault-20260202-000000.totpbackup', 'vault-20260303-000000.totpbackup', 'conflict-webdav-20260101-000000.totpbackup', 'other.txt']
  it('keep=2：仅删最旧的正则匹配份，conflict/其他文件不动', async () => {
    const del = vi.fn<(p: string) => Promise<void>>().mockResolvedValue(undefined)
    const deleted = await enforceRemoteRetention({ listBackups: async () => names, delete: del } as never, 2)
    expect(deleted).toBe(1)
    expect(del).toHaveBeenCalledWith('vault-20260101-000000.totpbackup')
  })
  it('keep=0/负数视作不删除；未超额定删除 0；backend 无 listBackups → 返回 -1（不支持）', async () => {
    expect(await enforceRemoteRetention({ listBackups: async () => names, delete: async () => {} } as never, 0)).toBe(0)
    expect(await enforceRemoteRetention({ delete: async () => {} } as never, 2)).toBe(-1)
  })
  it('删除名单与 selectBackupsToKeep 同源（超额=旧→新前 N）', async () => {
    expect(selectBackupsToKeep(names, 2)).toEqual(['vault-20260101-000000.totpbackup'])
  })
})
```

targetPath 用例：

```ts
it('resolveTimestampPath：overwrite 名同目录 vault-{ts}；根路径对象直接 vault-{ts}', () => {
  const cred = { backend: 'webdav', serverUrl: 's', username: 'u', password: 'p', objectPath: 'dir/sub/totp-backup.totpbackup' } as WebdavCred
  expect(resolveTimestampPath(cred, new Date(2026, 8, 17, 12, 34, 56))).toBe('dir/sub/vault-20260917-123456.totpbackup')
  expect(resolveTimestampPath({ ...cred, objectPath: undefined }, new Date(2026, 8, 17, 12, 34, 56))).toBe('vault-20260917-123456.totpbackup')
})
it('resolveDirPath：取对象路径父目录（根=''）', () => {
  expect(resolveDirPath({ ...cred })).toBe('dir/sub')
  expect(resolveDirPath({ ...cred, objectPath: undefined })).toBe('')
})
```

**Step 2–3: 实现**

`retention.ts`：

```ts
/** 云源 keep-n 远端滚动删除（设计 §3）：名单口径与本地一致（BACKUP_NAME_RE、字典序=时间序、
 *  conflict/overwrite 名不参与），仅作用域换成远端 list/delete。删除逐个进行，单个失败不阻断（计失败数）。 */
import type { CloudBackend } from '../cloud/backend'
import { selectBackupsToKeep } from './policy'

/** 返回删除数；backend 不支持 listBackups 返回 -1 */
export async function enforceRemoteRetention(backend: CloudBackend, keep: number): Promise<number> {
  if (!backend.listBackups) return -1
  if (!Number.isInteger(keep) || keep < 1) return 0
  const stale = selectBackupsToKeep(await backend.listBackups(), keep)
  let deleted = 0
  for (const name of stale) {
    try {
      await backend.delete(name)
      deleted++
    } catch {
      // 单个删除失败不阻断：下轮同步会再次尝试
    }
  }
  return deleted
}
```

`backend.ts` 接口增：

```ts
/** [可选] 列出该后端容器内可滚动的备份名（vault-{ts}.totpbackup）。keep-n 云源需要；
 *  缺省=该后端不支持（enforceRemoteRetention 返回 -1，UI 对 keep 选项降级提示）。 */
listBackups?(): Promise<string[]>
```

`targetPath.ts` 增：

```ts
/** keep-n 云源上传名：对象路径同目录下 vault-{yyyyMMdd-HHmmss}.totpbackup（与本地 backupFileName 同戳格式） */
export function resolveTimestampPath(cred: CloudCred, now: Date): string {
  const dir = resolveDirPath(cred)
  const name = backupFileName(now)
  return dir ? `${dir}/${name}` : name
}

/** 对象路径父目录（'a/b/c.totpbackup'→'a/b'；无目录段→''）。穿越校验与 resolveObjectPath 同款 */
export function resolveDirPath(cred: CloudCred): string {
  const p = resolveObjectPath(cred)
  const idx = p.lastIndexOf('/')
  return idx > 0 ? p.slice(0, idx) : ''
}
```

五后端 `listBackups` 实现要点（各自测试文件加 fake fetch 用例，沿用该文件既有 mock 方式）：
- **webdav**：`PROPFIND {dir}/` Depth:1 → 解 multistatus `<D:response>` 的 `<D:href>` 取末段 → 过滤 `BACKUP_NAME_RE`。
- **s3**：`GET {bucket}?list-type=2&prefix={dir}/` → XML `<Key>` 末段过滤。
- **gist**：`GET gists/{gistId}` → `Object.keys(files)` 过滤（gist 文件名不能含 `/`，目录段忽略——列全量过滤即可）。
- **gdrive**：`GET files/{fileId}?fields=parents` → `GET files?q='parent' in parents and name contains 'vault-' and trashed=false` → names。
- **onedrive**：`GET me/drive/items/{itemPath}`（编码路径）取 `parentReference` → `GET children` → names 过滤。

**Step 4: core test PASS** **Step 5: Commit** `feat(core): 云源 keep-n 时间戳路径与五后端 listBackups+远端滚动删除（plan16 T4）`

### Task 5: core — 导入去重判定树

**Files:**
- Create: `packages/core/src/import/dedup.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/dedup.test.ts`

**Step 1: 失败测试**

```ts
// packages/core/test/dedup.test.ts
import { describe, expect, it } from 'vitest'
import { createVault } from '../src/vault'
import { addEntry } from '../src/vault'
import { applyImportPlan, dedupeWithinFile, planImport, type ParsedEntry } from '../src/import/dedup'

const p = (over: Partial<ParsedEntry> = {}): ParsedEntry => ({
  type: 'totp', issuer: 'GitHub', label: 'a@x.com', secret: 'KRSXG5DSM5UQ', algorithm: 'SHA1', digits: 6, period: 30, ...over,
})
const seeded = () => addEntry(createVault(), { uuid: 'u1', type: 'totp', issuer: 'GitHub', label: 'a@x.com', secret: 'KRSXG5DSM5UQ', algorithm: 'SHA1', digits: 6, period: 30, groupIds: [], order: 0, createdAt: 1 })

describe('dedupeWithinFile：文件内完全重复行合并', () => {
  it('保留首条并计合并数', () => {
    const r = dedupeWithinFile([p(), p({ label: 'b@x.com' }), p()])
    expect(r.kept).toHaveLength(2)
    expect(r.removed).toBe(1)
  })
})

describe('planImport 判定树', () => {
  it('全字段一致 → identical；secret+algorithm 同但 label/period 异 → suspect（带 targetUuid）；issuer+label 撞而 secret 异 → conflict', () => {
    const v = seeded()
    const inc = [p(), p({ label: 'renamed@x.com' }), p({ secret: 'DIFFERENTSECRET' })]
    const plan = planImport(v, inc)
    expect(plan.kinds).toEqual(['identical', 'suspect', 'conflict'])
    expect(plan.targetUuids[1]).toBe('u1')
  })
  it('同 secret 不同 issuer（罕见合法多标签）→ suspect 而非 identical', () => {
    const plan = planImport(seeded(), [p({ issuer: 'GitLab' })])
    expect(plan.kinds[0]).toBe('suspect')
  })
  it('无碰撞 → new', () => {
    expect(planImport(seeded(), [p({ issuer: 'Other', label: 'z', secret: 'ANOTHERSECRET' })]).kinds[0]).toBe('new')
  })
})

describe('applyImportPlan', () => {
  it('identical 恒跳过；suspect 决策默认 skip、add 新增、replace 按 targetUuid 覆盖保留 uuid/order/groupIds', () => {
    const v = seeded()
    const inc = [p(), p({ label: 'renamed@x.com', period: 60 })]
    const plan = planImport(v, inc)
    let out = applyImportPlan(v, inc, plan, new Map([[1, 'replace'] as const]), 'skip')
    expect(out.vault.entries).toHaveLength(1)
    expect(out.vault.entries[0]!.uuid).toBe('u1')
    expect(out.vault.entries[0]!.period).toBe(60)
    out = applyImportPlan(v, inc, plan, new Map([[1, 'add'] as const]), 'skip')
    expect(out.vault.entries).toHaveLength(2)
    expect(out.stats).toEqual({ added: 1, replaced: 0, suspectSkipped: 1, identical: 1, conflictSkipped: 0, conflictReplaced: 0, conflictMerged: 0 })
  })
  it('conflict 条目沿用 ConflictPolicy（skip/replace/merge 语义与 applyImport 一致）', () => {
    const v = seeded()
    const inc = [p({ secret: 'DIFFERENTSECRET' })]
    const plan = planImport(v, inc)
    const out = applyImportPlan(v, inc, plan, new Map(), 'merge')
    expect(out.vault.entries).toHaveLength(2) // merge=并存
  })
})
```

**Step 2–3: 实现 `packages/core/src/import/dedup.ts`**（要点：全字段键 `type\|issuer\|label\|secret\|algorithm\|digits\|period\|counter` trim+大小写不敏感拼接；`planImport` 先查全字段键（identical），再查 `secret\nalgorithm` 键（suspect，targetUuid=首个匹配 existing），再落 `findConflicts`（conflict），否则 new；`applyImportPlan` 中 suspect replace 走 `updateEntry` 仅更新解析来源明确字段（与 conflict.ts replace 同白名单）；conflict 分支直接复用 `applyImport(v, [entry], policy, {0:idx})` 单条调用以保语义一致——或内联同白名单逻辑，二选一保持 DRY）。

**Step 4: PASS** **Step 5: Commit** `feat(core): 导入去重判定树 identical/suspect/conflict/new（plan16 T5）`

### Task 6: core — 锁定判定纯函数 + AppSettings 锁定偏好字段

**Files:**
- Create: `packages/core/src/security/lockPolicy.ts`
- Modify: `packages/core/src/storage/vaultStore.ts`（AppSettings/DEFAULT_SETTINGS 增三字段 + loadSettings 校验）
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/lockPolicy.test.ts`

**Step 1: 失败测试**

```ts
import { shouldLockNow } from '../src/security/lockPolicy'
const NOW = 1_000_000_000
it('空闲超时：now-last >= N 分钟触发', () => {
  expect(shouldLockNow({ idleMinutes: 5, lastActivityAt: NOW - 5 * 60_000, now: NOW })).toBe(true)
  expect(shouldLockNow({ idleMinutes: 5, lastActivityAt: NOW - 4 * 60_000, now: NOW })).toBe(false)
})
it('idleMinutes=0 恒不触发（禁用）', () => {
  expect(shouldLockNow({ idleMinutes: 0, lastActivityAt: 0, now: NOW })).toBe(false)
})
it('负数/非整数钳为禁用', () => {
  expect(shouldLockNow({ idleMinutes: -1, lastActivityAt: 0, now: NOW })).toBe(false)
})
```

**Step 2–3: 实现**

```ts
// packages/core/src/security/lockPolicy.ts
/** 空闲锁定判定（设计 §1 锁定策略）：纯函数，宿主定时器驱动；系统锁屏/重启触发不在本层。 */
export function shouldLockNow(input: { idleMinutes: number; lastActivityAt: number; now: number }): boolean {
  if (!Number.isInteger(input.idleMinutes) || input.idleMinutes < 1) return false
  return input.now - input.lastActivityAt >= input.idleMinutes * 60_000
}
```

`vaultStore.ts`：`AppSettings` 增

```ts
/** 锁定策略（设计 §1）：重启即锁（DEK 持久化关闭；false=浏览器会话内保持解锁） */
lockOnRestart: boolean
/** 空闲超时锁定分钟数；0=禁用 */
lockIdleMinutes: number
/** 系统锁屏即锁定（desktop=Tauri 事件；extension=chrome.idle 'locked'） */
lockOnSystemLock: boolean
```

`DEFAULT_SETTINGS`：`lockOnRestart: true, lockIdleMinutes: 0, lockOnSystemLock: true`；`loadSettings` 按 M4 逐字段 typeof 校验（number 且 ≥0）。

**Step 4: PASS** **Step 5: Commit** `feat(core): 空闲锁定判定与锁定偏好设置字段（plan16 T6）`

### Task 7: ui — store 保管区接线 + 口令轮换 + DEK 持久化 + 遗留迁移

**Files:**
- Modify: `packages/ui/src/store.ts`（核心改造）
- Test: `packages/ui/test/store.secretBag.test.ts`（新建；既有 store 测试中 backupSecret 断言随语义更新）

**store.ts 修改清单（符号级）**：

1. import 增：`openSecretBag, sealSecretBag, SECRET_BAG_KEY, emptyBag, type SecretBagContent`，删 `readVaultBackupSecret, withVaultBackupSecret`。
2. opts 增：

```ts
/** DEK 持久化（设计 §1 锁定策略·重启即锁）：宿主提供会话级存取（extension=chrome.storage.session base64）；
 *  缺省=不持久化（desktop 内存级，重启天然锁定）。lock() 必清；解锁/自动恢复必写。 */
dekPersist?: { get(): Promise<string | null>; set(dek: Uint8Array): Promise<void>; clear(): Promise<void> }
```

3. 新增内部状态：`let bag: SecretBagContent = emptyBag()`（保管区当前明文缓存，仅解锁态有效）；`const credsCache = ref<Record<string, import('@totp/core').CloudCred>>({})`（只读视图经 return 暴露）。
4. 新增 `async function loadBagIntoSession(): Promise<void>`：`bag = await openSecretBag(dekByWin.get(windowId)!, await adapter.get(SECRET_BAG_KEY)).catch(() => emptyBag())`；`setSessionBackupSecret(bag.backupPassword || null)`；`credsCache.value = { ...bag.creds }`。
5. `applyDekAndUnlock`：填充后调 `await loadBagIntoSession()`（替换原 `setSessionBackupSecret(readVaultBackupSecret(loaded))`），随后 `void opts.dekPersist?.set(key)`。
6. `initStore` 的「同进程已持 DEK」分支：`setSessionBackupSecret(readVaultBackupSecret(loaded))` → `await loadBagIntoSession()`；加密态无 DEK 分支前先尝试 `opts.dekPersist?.get()` → 有则 `await applyDekAndUnlock(base64ToBytes(v))` 实现会话内自动恢复。
7. `lock()`：增 `bag = emptyBag(); credsCache.value = {}` 与 `void opts.dekPersist?.clear()`。
8. `setBackupSecret(secret, remember)`：remember 分支改为——守护同款（未启用加密/锁定中文报错）后：`bag.backupPassword = trimmed; await adapter.set(SECRET_BAG_KEY, await sealSecretBag(dekByWin.get(windowId)!, bag))`（**不再写 vault**）。
9. `forgetBackupSecret()`：会话清；解锁+加密态时 `bag.backupPassword = ''` → 重封写盘。
10. 新增 `saveSourceCredOp(id: string, cred: CloudCred)` / `removeSourceCredOp(id: string)`：解锁+加密守护；`bag.creds[id] = cred` / `delete bag.creds[id]` → 重封写盘 → `credsCache.value = { ...bag.creds }`。未启用加密时守护报「需先启用加密才能保存云凭据」。
11. `disableEncryption()`：删 `withVaultBackupSecret` 调用，改 `await adapter.delete(SECRET_BAG_KEY)` + `bag = emptyBag(); credsCache.value = {}`（sessionSecret 清理保留）。
12. `changePassphrase(newPassword, opts?: { rotateDek?: boolean; profile?: KdfProfile })`：

```ts
const r = await changeVaultPassphrase(security.value, dekByWin.get(windowId)!, newPassword, opts)
security.value = r.security
if (r.dek) {
  dekByWin.set(windowId, r.dek)
  // 被动轮换（设计 §2）：DEK 已换 → 全库重加密写盘 + 保管区重封
  lastSelfWrite.vault = Date.now()
  await adapter.set(VAULT_KEY, JSON.stringify(await encryptVaultWithDek(r.dek, JSON.stringify(vault))))
  await adapter.set(SECRET_BAG_KEY, await sealSecretBag(r.dek, bag))
  void opts2.dekPersist?.set(r.dek)
}
lastSelfWrite.vault = Date.now()
await adapter.set(SECURITY_KEY, JSON.stringify(r.security))
```

（`opts2` 即 store opts；注意 changePassphrase 默认 `rotateDek: true`——设计裁定改口令即轮换。）
13. **迁移 op**：

```ts
/** 遗留迁移（设计 §1）：旧 vault.backupSecret → 保管区，随后从 vault 剥除写盘。幂等：
 *  bag 已有口令时仅剥除 vault 字段。解锁态调用（applyDekAndUnlock 后宿主调一次）。 */
async function migrateLegacySecrets(): Promise<void> {
  if (!security.value || lockedByWin.get(windowId)) return
  const legacy = (vault as { backupSecret?: string }).backupSecret
  if (typeof legacy === 'string' && legacy && !bag.backupPassword) {
    bag.backupPassword = legacy
    await adapter.set(SECRET_BAG_KEY, await sealSecretBag(dekByWin.get(windowId)!, bag))
    setSessionBackupSecret(legacy)
  }
  if (legacy !== undefined) await commit((v) => { const n = { ...v } as Vault; delete (n as { backupSecret?: string }).backupSecret; return n })
}
```

14. return 增：`credsCache（只读）、saveSourceCredOp、removeSourceCredOp、migrateLegacySecrets`；`replaceVault` 删 backupSecret 分支。

**测试要点**（memory adapter，先失败后绿）：解锁后 setBackupSecret(remember=true) → `adapter.get('secretBag')` 非空且**vault 密文解出后无 backupSecret 字段**；lock→unlock 后 backupSecret 自动恢复；未启用加密 remember 报中文错；saveSourceCredOp 往返 + lock 后不可用；disableEncryption 删 bag 键；changePassphrase(rotateDek) 后旧 DEK 解不开新密文、bag 仍可解、backupSecret 会话保留；迁移幂等（二次调用无写盘）。

**Commit** `feat(ui): store 接 DEK 保管区/口令轮换/DEK 持久化/遗留迁移（plan16 T7）`

### Task 8: ui — CloudPlatform 接口源化 + CloudCard 源列表

**Files:**
- Modify: `packages/ui/src/components/cloudPlatform.ts`（接口改造，见下）
- Modify: `packages/ui/src/components/CloudCard.vue`
- Modify: `packages/ui/src/components/cloudRunner.ts`
- Test: `packages/ui/test/cloudCard.sources.test.ts`（新建）；`cloudRunner` 既有测试改源 id 口径

**cloudPlatform.ts 改造**：

```ts
import type { BackupSource } from '@totp/core'
/** 多目标源列表：元数据（明文 settings）；凭据经 store 保管区 op 存取（解锁态限定） */
export interface CloudPlatform {
  loadSources(): Promise<BackupSource[]>
  saveSources(list: BackupSource[]): Promise<void>
  /** 保存源凭据（走 store.saveSourceCredOp；未解锁 reject 中文错误） */
  saveCred(id: string, cred: CloudCred): Promise<void>
  /** 删除源凭据（幂等；源移除时同步清理） */
  removeCred(id: string): Promise<void>
  /** 凭据缓存（store.credsCache 只读视图；锁定态为空） */
  creds: Record<string, CloudCred>
  readVaultJson(): string
  persistDownloaded(json: string): Promise<void>
  saveConflictBackup?(bytes: Uint8Array, sourceId?: string): Promise<string | null>
  loadTargetHash(sourceId: string): Promise<string | null>
  saveTargetHash(sourceId: string, hash: string | null): Promise<void>
  autoPrefs: { get(): CloudAutoPrefs | Promise<CloudAutoPrefs>; set(p: CloudAutoPrefs): void | Promise<void> }
  loadAutoStatus?(): Promise<string | null>
  /** KDF 档位（备份设置所选，信封生成用） */
  kdfProfile?: () => KdfProfile
}
```

（删除 `CloudTarget` 与 `loadCreds/saveCreds`；`createCloudBackend` 保留。）

**CloudCard.vue 改造要点**：
- `targets: ref<CloudTarget[]>` → `sources: ref<BackupSource[]>`；`addTarget(b)` 生成 `crypto.randomUUID()` 源（`retention: {type:'overwrite'}`，`name` 默认 `BACKEND_LABEL[b]`，同 kind 多份允许——`addableBackends` 不再过滤，菜单列出全部五种 + 本地源类型不在此卡）；展开行加 `name` MdTextField 与 retention 二选（`MdSegmentedButton`：覆盖 / 保留最近 + n 输入，n 仅 keep 显示）。
- 凭据字段 v-model 绑定行内内存副本 `credDrafts: ref<Record<string, CloudCred>>`（按 sourceId）；「保存凭据」→ `saveSources` + 逐源 `saveCred(id, draft)`（空白凭据跳过）。
- `onSync`：`inputs = enabled.map(t => ({ key: t.id, backend: createCloudBackend(credsDraft(t) ?? props.platform.creds[t.id]!, onCredChange 按 sourceId 回写), path: t.retention.type === 'keep' ? resolveTimestampPath(cred, new Date()) : resolveObjectPath(cred), hash: await p.loadTargetHash(t.id) }))`；`syncMultipleTargets({ ..., profile: p.kdfProfile?.() })`；keep 源上传成功后 `enforceRemoteRetention(createCloudBackend(cred), n)`（import 自 core）。
- `pendingHashes`/`resettableBackends`/`statusMap`/`removeTarget`/`askRemove` 全部键改 sourceId；移除源时 `removeCred(id)` + `saveSources(剩余)`。
- 「用当前口令重置云端」`pushEnvelope` 的 path 按 retention 同上。

**cloudRunner.ts 改造**：`CloudRunnerDeps` 的 `loadCreds(): Promise<CloudTarget[]>` → `loadSources(): Promise<Array<{ source: BackupSource; cred: CloudCred }>>`；inputs 组装按 `source.id`/retention 同 CloudCard；`loadTargetHash(source.id)`；keep 源成功后滚动删除；`syncMultipleTargets` 透传 `profile: deps.kdfProfile?.()`。

**Commit** `feat(ui): CloudCard/runner 换 BackupSource 多份同类型与每源保留策略（plan16 T8）`

### Task 9: ui — BackupCard 本地源列表化

**Files:**
- Modify: `packages/ui/src/components/backupPlatform.ts`
- Modify: `packages/ui/src/components/BackupCard.vue`
- Test: `packages/ui/test/backupCard.sources.test.ts`（新建）

**backupPlatform.ts**：`BackupMode`/`mode`/`setMode`/`getBackupDir`/`setBackupDir` 删除；增：

```ts
/** 本地源视图（desktop 宿主实现；缺省=无本地源区，extension/popup 零影响） */
export interface LocalSourceView { id: string; name: string; dir: string | null; retention: Retention; enabled: boolean }
export interface BackupPlatform {
  /** 向全部启用本地源备份（各按其 retention），返回中文摘要（如「已备份到 2 个目录」） */
  createBackup(vaultJson: string, password: string): Promise<string>
  listLocalSources?(): Promise<LocalSourceView[]>
  saveLocalSource?(s: LocalSourceView): Promise<void>
  removeLocalSource?(id: string): Promise<void>
  pickBackupDir?(): Promise<string | null>
  exportToFile?(...): ...        // 不变
  restoreFromPicker?(...): ...   // 不变
  /** 聚合全部本地源备份文件（sourceId 供恢复定位） */
  listBackups?(): Promise<Array<{ sourceId: string; name: string }>>
  restoreByName?(sourceId: string, name: string, password: string): Promise<{ json: string } | null>
  replaceAllOp?(v: Vault): Promise<void>
  readImportFile?(...): ...      // 以下四成员不变
  readImportFileBytes? / decryptDpapi? / getAutoPrefs? / setAutoPrefs? / getAutoStatus?
}
```

**BackupCard.vue 改造要点**：`mode/modes/keepN/onModeSelect/onNChange` 区块替换为「本地备份目录」源列表（每行：name/dir 文本 + retention `MdSegmentedButton`(覆盖/保留最近+n) + 启用 MdSwitch + 移除）；「添加目录」按钮（`pickBackupDir` 非 null → `saveLocalSource({id: uuid, kind 本地, name: 目录末段, dir, retention: keep 3, enabled: true})`）；「立即备份」调新 `createBackup` 展示中文摘要；`listBackups`/`restoreByName` 带 sourceId。dir=null 行显示「默认（应用数据目录）」。

**Commit** `feat(ui): BackupCard 本地源列表化与每源保留策略（plan16 T9）`

### Task 10: ui — ImportCard 去重接线

**Files:**
- Modify: `packages/ui/src/components/ImportCard.vue`
- Test: `packages/ui/test/importCard.dedup.test.ts`（新建，mount+seed store）

**改造要点**：
- `parseAndConfirm` 内：`const dedup = dedupeWithinFile(r.entries); r.entries = dedup.kept`（`dedup.removed` 存 `inFileMerged` ref，confirm/report 页展示「文件内重复已合并 N 条」）。
- confirm 步：`const planRes = planImport(props.platform!.store.vault, r.entries)` 存 `importPlan` ref；四组计数替换现 `conflictCount` 行：`新增 X · 完全相同自动跳过 Y · 疑似同账户 Z（默认跳过） · 冲突 W`。
- suspect 逐条选择区：`suspectChoices = ref<Map<number, 'skip' | 'add' | 'replace'>>(new Map())`；列表行显示「{issuer}/{label} → 现有 {target.issuer}/{target.label}」+ `MdSegmentedButton`(跳过/新增/覆盖)。
- `commitImport`：`conflicts` 重算逻辑替换为 `applyImportPlan(v, r.entries, importPlan, suspectChoices, policy)`，report 增 `identical/suspectSkipped/inFileMerged` 字段展示。

**Commit** `feat(ui): ImportCard 四档去重判定树接线（plan16 T10）`

### Task 11: ui — SecurityCard KDF 档位 + 口令天数提示 + 锁定偏好

**Files:**
- Modify: `packages/ui/src/components/securityPlatform.ts`（SecurityPlatform 增 `lockPrefs: { get(): LockPrefs | Promise<LockPrefs>; set(p: LockPrefs): void | Promise<void> }`；`LockPrefs = Pick<AppSettings, 'lockOnRestart' | 'lockIdleMinutes' | 'lockOnSystemLock'>`）
- Modify: `packages/ui/src/components/SecurityCard.vue`
- Test: `packages/ui/test/securityCard.plan16.test.ts`（新建）

**改造要点**：
- 换口令区上方增「加密强度」行：`MdSelect` 三档（fast=更快（低端机友好）/balanced=默认/paranoid=更慢更耐算），展示当前 `platform.security.securitySettings.value?.profile ?? 'balanced'`；变更弹当前口令输入行 → `store.changePassphrase(当前口令, { profile })`（重 wrap 立即生效，文案注明「无需重加密数据」）。
- 换口令成功消息后追加持久的提示行：`本地主口令已 N 天未更换`（`Math.floor((Date.now() - passwordChangedAt) / 86_400_000)`；>180 天加 `class="pw-age-warn"` 强调色；`passwordChangedAt` 缺失显示「未记录」）。SecurityPlatform.security 增 `passwordChangedAt: Readonly<Ref<number | null>>`（宿主从 store.securitySettings 映射）。
- 「锁定策略」区（`v-if="hasEnc && platform.lockPrefs"`）：三个控件——「重启后保持锁定」`MdSwitch`（lockOnRestart，false=浏览器会话内保持解锁）、「空闲 N 分钟后锁定」`MdTextField number`（0=禁用）、「系统锁屏时锁定」`MdSwitch`（lockOnSystemLock）。变更即 `platform.lockPrefs.set({...})`。
- `onChangePw` 改调 `p.security.changePassphrase(newPw, { rotateDek: true })`（securityPlatform 的 op 签名同步加 opts 透传）。

**Commit** `feat(ui): SecurityCard 加密强度档位/口令天数/锁定策略（plan16 T11）`

### Task 12: extension — chrome.storage.session DEK 持久化 + chrome.idle 锁定执行

**Files:**
- Create: `apps/extension/src/dekSession.ts` + `apps/extension/src/lockEnforcer.ts`
- Modify: `apps/extension/entrypoints/options/App.vue` 与 `popup/App.vue`（createVueStore 传 `dekPersist`；options 挂 lockEnforcer）
- Test: `apps/extension/test/dekSession.test.ts`、`lockEnforcer.test.ts`（chrome shim 假实现，沿用既有 test/ 模式）

**dekSession.ts**：

```ts
import { bytesToBase64, base64ToBytes } from '@totp/core'
/** DEK 会话级持久化（设计 §1）：chrome.storage.session 浏览器退出即清、默认不落盘。
 *  set/clear 幂等；get 失败按无 DEK。仅扩展页上下文可读（TRUSTED_CONTEXTS 默认）。 */
export function createDekSession(): { get(): Promise<string | null>; set(dek: Uint8Array): Promise<void>; clear(): Promise<void> } {
  return {
    async get() {
      try {
        const o = await chrome.storage.session.get('dek')
        return (o['dek'] as string | undefined) ?? null
      } catch {
        return null
      }
    },
    async set(dek) {
      await chrome.storage.session.set({ dek: bytesToBase64(dek) })
    },
    async clear() {
      await chrome.storage.session.remove('dek')
    },
  }
}
```

**lockEnforcer.ts**：`createIdleLockWatcher(deps: { enabled(): Promise<{ idleMinutes: number; lockOnSystemLock: boolean }>; lock(): void; onError?(e: unknown): void })` → `start()/stop()`：30s `setInterval` → `chrome.idle.queryState(15, (s) => { if (s === 'locked' && lockOnSystemLock) lock(); else if (s === 'idle' && shouldLockNow({ idleMinutes, lastActivityAt: Date.now() - (待注入 lastActivity), now })) lock() })`——**裁定**：chrome.idle 的 `idle` 态即宿主已按 detectionInterval 判定无操作，等价超时达成，无需自算 lastActivity：`deps.enabled()` 返回 `idleMinutes` 时同步 `chrome.idle.setDetectionInterval(clamp(idleMinutes * 60, 15, 86_400))`，轮询仅判断 `s === 'idle' && idleMinutes >= 1`。

**接线**：options App.vue store 工厂加 `dekPersist: createDekSession()`；options 挂 watcher（popup 生命周期短不挂）。manifest（wxt.config.ts）确认 `permissions` 含 `idle`，无则加。

**Commit** `feat(ext): DEK 会话持久化与 idle/锁屏自动锁定（plan16 T12）`

### Task 13: extension — 源/保管区迁移 + runner 接线

**Files:**
- Modify: `apps/extension/src/cloudCredStore.ts`（增 `migrateToSources(deps)`：读旧 `cloudCreds`/`cloudCred` → 构造 `BackupSource[]`（id=backend 键保基线兼容、name=BACKEND_LABEL、retention overwrite、enabled 原值）→ `saveSources` + 逐源 `store.saveSourceCredOp` → `adapter.remove(CLOUD_CREDS_KEY/CLOUD_CRED_KEY)`；`cloudRevs`/`cloudRev` → `saveSourceRev` 平移 → 删旧键。幂等：无旧键直接返回）
- Modify: `apps/extension/entrypoints/options/App.vue`（platform 工厂换新 CloudPlatform 形状：loadSources/saveSources/saveCred/removeCred（后三者走 store op）；init 顺序=store.initStore→unlock 态 `migrateLegacySecrets()`→`migrateToSources`；cloudRunner deps 换源口径；LockScreen 所在根组件解锁成功回调调 `migrateLegacySecrets`）
- Test: `apps/extension/test/migrateSources.test.ts`

**Commit** `feat(ext): 云凭据/基线迁移至源模型与保管区（plan16 T13）`

### Task 14: desktop — 每源备份服务 + 迁移 + runner 接线

**Files:**
- Modify: `apps/desktop/src/backupService.ts`（`createBackupToDir` → `createBackupToSources(sources: LocalSourceView[], vaultJson, password)`：逐源按 retention 走现有 keep/overwrite 分支（dir=source.dir），聚合返回中文摘要；`readBackupByName(sourceId, name)`——目录定位：源列表经参数传入或返回 `{dir}` 映射）
- Modify: `apps/desktop/src/App.vue`：
  - 键替换：`CLOUD_CREDS_KEY/CLOUD_REVS_KEY` 读写函数 → `loadSourcesImpl/saveSourcesImpl/loadTargetHashImpl(sourceId)/saveTargetHashImpl`（`sourceRevs` 键经 core 函数）；备份模式 localStorage 键（BACKUP_MODE_KEY 等）→ 本地源存 `backupSources`（AppData fs 键，core saveSources），首次启动迁移：localStorage backupMode/backupKeepN → 默认本地源（id='local-default', dir=null）retention。
  - cloud platform 工厂换新接口形状（同 Task 13 模式，fsAdapter 版）；`migrateToSources` desktop 版（fsAdapter 读旧 cloudCreds）。
  - store 工厂：desktop 不传 dekPersist（内存级，重启即锁天然成立）；解锁回调挂 `migrateLegacySecrets()`。
  - autoRunner deps：`loadCreds` → 源口径；`doBackup` → `createBackupToSources`。
- Test: `apps/desktop/src/backupService.test.ts` 增每源用例（temp dir）

**Commit** `feat(desktop): 备份目录源化/云源迁移/多源自动备份（plan16 T14）`

### Task 15: desktop — Windows 系统锁屏事件（Rust）

**Files:**
- Modify: `apps/desktop/src-tauri/src/lib.rs`（增 `lock_events` 模块：Windows 下 `WTSRegisterSessionNotification(hwnd, NOTIFY_FOR_THIS_SESSION)` + 处理 `WM_WTSSESSION_CHANGE`/`WTS_SESSION_LOCK` → `app.emit("system-lock", ())`；非 Windows `cfg` 空实现）
- Modify: `apps/desktop/src/App.vue`（`listen('system-lock', () => { if (prefs.lockOnSystemLock) store.lock() })`；空闲判定：document 级 `pointerdown/keydown` 节流更新 `lastActivityAt` + 30s interval `shouldLockNow` → lock）
- Test: Rust `cargo check` 通过（Windows 真机行为验证并入既有 mac/Linux/真机挂账）

**Commit** `feat(desktop): Windows 锁屏事件与空闲锁定执行（plan16 T15；mac/Linux 挂账）`

### Task 16: 迁移端到端 + 文档勘误 + 全量验证

**Files:**
- Test: `packages/core/test/migration.e2e.test.ts`（构造：旧 vault 带 backupSecret 密文 + cloudCreds/cloudRevs 旧键 → 模拟宿主迁移序列 → 断言 bag/sources/sourceRevs/vault 剥除/旧键删除全对且二次运行幂等）
- Modify: `docs/plans/2026-09-16-settings-ux-design.md`（文首加勘误块：D1「备份口令入库」已被 plan16 反转）；`docs/plans/2026-09-17-backup-sources-and-crypto-design.md`（附录：v1 云对象不可解的救济路径说明）

**Steps:** 写端到端失败测试 → 修至全绿 → `pnpm test && pnpm -r run typecheck` → `pnpm --filter @totp/core run test -- --coverage` 确认新模块 ≥95% → Commit `test+docs(plans): plan16 迁移端到端与设计勘误（收尾）`

---

## 风险与回退

- **云端 v1 信封不可解**（事实 4）：用户 dogfood 云对象需「用当前口令重置云端」或重新上传；本地旧 .totpbackup 文件同不可解——需在升级说明中置顶告知。
- **迁移中断**：所有迁移「先写新、后删旧、二次幂等」，中断重跑无害。
- **keep-n 远端删除是破坏性操作**：仅删 `BACKUP_NAME_RE` 匹配名且超出 keep 数的份，`conflict-*` 与 overwrite 名永不删除；backend.delete 路径白名单沿用各后端既有校验。
