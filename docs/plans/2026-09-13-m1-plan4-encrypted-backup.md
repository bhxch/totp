# TOTP 工具 M1-计划4：加密备份与本地备份 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付加密备份能力：core 的 Argon2id+AES-256-GCM 密钥分层加密（DEK/KEK）与自描述备份 envelope；桌面本地备份（固定目录自动命名、保留 N 份/覆盖、恢复）、导出到任意文件、跨端兼容的备份文件；tauriFs 原子写（防半写）。

**Architecture:** core 新增 `crypto/`（kdf/aesgcm，hash-wasm 唯一运行时依赖破例）与 `backup/`（envelope + 备份命名/滚动策略纯函数）；桌面端 fs 适配改造原子写 + Rust 自定义命令读写用户路径文件（避开 fs 插件 scope 限制）；UI 在 VaultManager 加备份设置卡（桌面）与插件导出/恢复入口。

**Tech Stack:** hash-wasm（Argon2id）、WebCrypto（AES-256-GCM）、tauri-plugin-dialog、Rust std::fs 自定义命令。

**Spec:** `docs/plans/2026-09-13-totp-tool-design.md`（第 6 节备份同步、第 7 节密钥分层口令模式、第 13 节防半写）

## Global Constraints

- 沿用全部既有约束（TS strict、TDD、Angular commit、中文 UI）
- **依赖破例**：`packages/core` 唯一允许的运行时依赖为 `hash-wasm`（Argon2id 无 WebCrypto 原语，自写不可行）；其余包不得新增运行时依赖
- envelope 格式 v1（对 spec 第 6 节的微调，密学正确性优先）：`{ v:1, kdf:{alg:'argon2id', m, t, p, salt}, wrapNonce, wrappedDek, dataNonce, ciphertext }`，全部二进制字段 base64（标准字母表含 padding）；GCM tag 内嵌于 wrappedDek/ciphertext 尾部（WebCrypto 行为），spec 中独立 `mac` 字段取消（文档勘误顺带）；wrapNonce 与 dataNonce 各自独立随机 96-bit，禁止复用
- KDF 参数固定初值：m=65536（64MiB）、t=3、p=1、输出 32 字节、salt 16 字节随机
- 密钥分层：DEK 随机 256 位加密 vault；KEK=Argon2id(口令, salt) 仅解开 wrappedDek；**本计划只做口令模式**，passkey PRF/DPAPI 与 vault 本体落盘加密属后续计划 6（与 spec backlog「整库口令加密」一致）
- 口令错误必须报错 `Error('bad password or corrupted backup')`，绝不静默返回乱码
- 涉及 tauri 配置的任务必须核对构建产物（教训延续）

---

### Task 1: core 加密原语（kdf + aesgcm，TDD）

**Files:**
- Create: `packages/core/src/crypto/kdf.ts`、`packages/core/src/crypto/aesgcm.ts`
- Modify: `packages/core/package.json`（dependencies 加 `hash-wasm`）、`packages/core/src/index.ts`
- Test: `packages/core/test/crypto.test.ts`

**Interfaces:**
- Produces:
  - `async deriveKek(password: string, salt: Uint8Array, params?: { m?: number; t?: number; p?: number }): Promise<Uint8Array>`（默认 65536/3/1，Argon2id 32 字节；同口令同 salt 同参数结果确定）
  - `async aesGcmEncrypt(keyBytes: Uint8Array, plaintext: Uint8Array, nonce: Uint8Array): Promise<Uint8Array>`（AES-256-GCM，keyBytes 必须 32 字节，nonce 必须 12 字节，返回 ct||16 字节 tag）
  - `async aesGcmDecrypt(keyBytes: Uint8Array, data: Uint8Array, nonce: Uint8Array): Promise<Uint8Array>`（认证失败抛 `OperationError`——WebCrypto 原生）
  - `randomBytes(n: number): Uint8Array`（crypto.getRandomValues 包装）
  - `bytesToBase64(b: Uint8Array): string` / `base64ToBytes(s: string): Uint8Array`（标准字母表含 padding）

- [ ] **Step 1: 安装依赖**

Run: `pnpm --filter @totp/core add hash-wasm`
（core package.json dependencies 出现 hash-wasm；「零第三方运行时依赖」约束按 Global Constraints 破例收窄为「唯一例外 hash-wasm」）

- [ ] **Step 2: 写失败测试**

`packages/core/test/crypto.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { aesGcmDecrypt, aesGcmEncrypt, base64ToBytes, bytesToBase64, deriveKek, randomBytes } from '../src/crypto/aesgcm'

describe('base64', () => {
  it('往返', () => {
    for (const len of [0, 1, 5, 12, 16, 32, 100]) {
      const b = randomBytes(len)
      expect(base64ToBytes(bytesToBase64(b))).toEqual(b)
    }
  })
  it('标准向量', () => {
    expect(bytesToBase64(new Uint8Array([0, 0]))).toBe('AAA=')
    expect(base64ToBytes('AAA=')).toEqual(new Uint8Array([0, 0]))
  })
})

describe('deriveKek', () => {
  it('同口令同 salt 确定性；异口令不同', async () => {
    const salt = randomBytes(16)
    const a = await deriveKek('口令测试', salt)
    const b = await deriveKek('口令测试', salt)
    const c = await deriveKek('另一个', salt)
    expect(a).toEqual(b)
    expect(a).not.toEqual(c)
    expect(a.length).toBe(32)
  })
  it('默认参数耗时合理（64MiB）且结果稳定', async () => {
    const s = base64ToBytes('AAAAAAAAAAAAAAAAAAAAAA==')
    const v = await deriveKek('x', s)
    expect(v.length).toBe(32)
  })
})

describe('aesGcm', () => {
  it('往返；tag 附加在尾部', async () => {
    const key = randomBytes(32)
    const nonce = randomBytes(12)
    const pt = new TextEncoder().encode('机密数据 secret 🎉')
    const ct = await aesGcmEncrypt(key, pt, nonce)
    expect(ct.length).toBe(pt.length + 16)
    expect(await aesGcmDecrypt(key, ct, nonce)).toEqual(pt)
  })
  it('错误密钥/被篡改密文抛错', async () => {
    const key = randomBytes(32)
    const nonce = randomBytes(12)
    const ct = await aesGcmEncrypt(key, new TextEncoder().encode('x'), nonce)
    await expect(aesGcmDecrypt(randomBytes(32), ct, nonce)).rejects.toThrow()
    const tampered = ct.slice()
    tampered[0]! ^= 1
    await expect(aesGcmDecrypt(key, tampered, nonce)).rejects.toThrow()
  })
  it('nonce 复用同 key 产生同密文（确定性校验）', async () => {
    const key = randomBytes(32)
    const nonce = randomBytes(12)
    const pt = new TextEncoder().encode('same')
    expect(await aesGcmEncrypt(key, pt, nonce)).toEqual(await aesGcmEncrypt(key, pt, nonce))
  })
})
```

- [ ] **Step 3: 运行确认失败 → 实现 → 通过**

`packages/core/src/crypto/aesgcm.ts`:
```ts
import { argon2id } from 'hash-wasm'

export function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n)
  crypto.getRandomValues(b)
  return b
}

export function bytesToBase64(b: Uint8Array): string {
  let s = ''
  for (const byte of b) s += String.fromCharCode(byte)
  return btoa(s)
}

export function base64ToBytes(s: string): Uint8Array {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export async function deriveKek(
  password: string,
  salt: Uint8Array,
  params: { m?: number; t?: number; p?: number } = {},
): Promise<Uint8Array> {
  const { m = 65536, t = 3, p = 1 } = params
  return (await argon2id({
    password,
    salt,
    parallelism: p,
    iterations: t,
    memorySize: m,
    hashLength: 32,
    outputType: 'binary',
  })) as Uint8Array
}

async function importAesKey(keyBytes: Uint8Array): Promise<CryptoKey> {
  if (keyBytes.length !== 32) throw new Error('AES-256 key must be 32 bytes')
  return crypto.subtle.importKey('raw', keyBytes as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

export async function aesGcmEncrypt(keyBytes: Uint8Array, plaintext: Uint8Array, nonce: Uint8Array): Promise<Uint8Array> {
  if (nonce.length !== 12) throw new Error('nonce must be 12 bytes')
  const key = await importAesKey(keyBytes)
  return new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce as BufferSource }, key, plaintext as BufferSource))
}

export async function aesGcmDecrypt(keyBytes: Uint8Array, data: Uint8Array, nonce: Uint8Array): Promise<Uint8Array> {
  if (nonce.length !== 12) throw new Error('nonce must be 12 bytes')
  const key = await importAesKey(keyBytes)
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce as BufferSource }, key, data as BufferSource))
}
```
（若 `packages/core/src/crypto/kdf.ts` 拆分与上述合并实现冲突，以单文件 aesgcm.ts 内聚实现为准——kdf/aesgcm/base64 同属密码学原语层，报告说明即可）

- [ ] **Step 4: 全仓验证 + Commit**

Run: `pnpm --filter @totp/core test && pnpm test && pnpm -r run typecheck`
Expected: 全绿

```bash
git add packages/core/ pnpm-lock.yaml
git commit -m "feat(core): Argon2id+AES-256-GCM加密原语与base64工具(hash-wasm唯一依赖破例)"
```

---

### Task 2: core 备份 envelope（TDD）

**Files:**
- Create: `packages/core/src/backup/envelope.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/envelope.test.ts`

**Interfaces:**
- Produces:
  - `interface BackupEnvelopeV1 { v: 1; kdf: { alg: 'argon2id'; m: number; t: number; p: number; salt: string }; wrapNonce: string; wrappedDek: string; dataNonce: string; ciphertext: string }`
  - `async createBackupEnvelope(vaultJson: string, password: string): Promise<BackupEnvelopeV1>`（DEK=randomBytes(32)、salt=randomBytes(16)、双 nonce=randomBytes(12)；KEK 派生→包裹 DEK→加密 vaultJson UTF-8）
  - `async openBackupEnvelope(env: unknown, password: string): Promise<string>`（结构校验：v===1、字段齐全且 base64 合法，否则 `Error('invalid backup envelope')`；解包/解密任一失败→`Error('bad password or corrupted backup')`；成功返回明文 JSON 字符串）
  - `isBackupEnvelope(x: unknown): x is BackupEnvelopeV1`（嗅探用：对象且 v===1 且有 wrapNonce/wrappedDek/dataNonce/ciphertext 字符串字段）

- [ ] **Step 1: 写失败测试**

`packages/core/test/envelope.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { createBackupEnvelope, isBackupEnvelope, openBackupEnvelope } from '../src/backup/envelope'

const vaultJson = JSON.stringify({ version: 1, entries: [{ uuid: 'a' }], groups: [], updatedAt: 1 })

describe('envelope', () => {
  it('创建→口令正确解开原文', async () => {
    const env = await createBackupEnvelope(vaultJson, '口令123')
    expect(env.v).toBe(1)
    expect(env.kdf.alg).toBe('argon2id')
    expect(env.kdf.m).toBe(65536)
    expect(isBackupEnvelope(env)).toBe(true)
    expect(await openBackupEnvelope(env, '口令123')).toBe(vaultJson)
  })
  it('口令错误抛 bad password', async () => {
    const env = await createBackupEnvelope(vaultJson, '对')
    await expect(openBackupEnvelope(env, '错')).rejects.toThrow('bad password or corrupted backup')
  })
  it('密文被篡改抛 bad password', async () => {
    const env = await createBackupEnvelope(vaultJson, 'p')
    const bytes = base64ToBytes(env.ciphertext)
    bytes[0]! ^= 1
    await expect(openBackupEnvelope({ ...env, ciphertext: bytesToBase64(bytes) }, 'p')).rejects.toThrow('bad password or corrupted backup')
  })
  it('结构非法抛 invalid backup envelope', async () => {
    await expect(openBackupEnvelope({ v: 2 }, 'p')).rejects.toThrow('invalid backup envelope')
    await expect(openBackupEnvelope('not json', 'p')).rejects.toThrow('invalid backup envelope')
  })
  it('同口令两次创建产生不同 salt/nonce（随机性）', async () => {
    const a = await createBackupEnvelope(vaultJson, 'p')
    const b = await createBackupEnvelope(vaultJson, 'p')
    expect(a.kdf.salt).not.toBe(b.kdf.salt)
    expect(a.wrapNonce).not.toBe(b.wrapNonce)
    expect(a.ciphertext).not.toBe(b.ciphertext)
  })
  it('isBackupEnvelope 拒绝任意对象', () => {
    expect(isBackupEnvelope({})).toBe(false)
    expect(isBackupEnvelope(null)).toBe(false)
  })
})
```

- [ ] **Step 2: 确认失败 → 实现 → 通过**

`packages/core/src/backup/envelope.ts`:
```ts
import { aesGcmDecrypt, aesGcmEncrypt, base64ToBytes, bytesToBase64, deriveKek, randomBytes } from '../crypto/aesgcm'

export interface BackupEnvelopeV1 {
  v: 1
  kdf: { alg: 'argon2id'; m: number; t: number; p: number; salt: string }
  wrapNonce: string
  wrappedDek: string
  dataNonce: string
  ciphertext: string
}

export function isBackupEnvelope(x: unknown): x is BackupEnvelopeV1 {
  if (typeof x !== 'object' || x === null) return false
  const o = x as Record<string, unknown>
  return (
    o['v'] === 1 &&
    typeof o['kdf'] === 'object' && o['kdf'] !== null &&
    typeof o['wrapNonce'] === 'string' &&
    typeof o['wrappedDek'] === 'string' &&
    typeof o['dataNonce'] === 'string' &&
    typeof o['ciphertext'] === 'string'
  )
}

export async function createBackupEnvelope(vaultJson: string, password: string): Promise<BackupEnvelopeV1> {
  const salt = randomBytes(16)
  const dek = randomBytes(32)
  const kek = await deriveKek(password, salt)
  const wrapNonce = randomBytes(12)
  const wrappedDek = await aesGcmEncrypt(kek, dek, wrapNonce)
  const dataNonce = randomBytes(12)
  const ciphertext = await aesGcmEncrypt(dek, new TextEncoder().encode(vaultJson), dataNonce)
  return {
    v: 1,
    kdf: { alg: 'argon2id', m: 65536, t: 3, p: 1, salt: bytesToBase64(salt) },
    wrapNonce: bytesToBase64(wrapNonce),
    wrappedDek: bytesToBase64(wrappedDek),
    dataNonce: bytesToBase64(dataNonce),
    ciphertext: bytesToBase64(ciphertext),
  }
}

export async function openBackupEnvelope(env: unknown, password: string): Promise<string> {
  if (!isBackupEnvelope(env)) throw new Error('invalid backup envelope')
  const kdf = env.kdf as { alg?: string; m?: number; t?: number; p?: number; salt?: string }
  if (kdf.alg !== 'argon2id' || typeof kdf.salt !== 'string') throw new Error('invalid backup envelope')
  let kek: Uint8Array
  try {
    kek = await deriveKek(password, base64ToBytes(kdf.salt), { m: kdf.m, t: kdf.t, p: kdf.p })
  } catch {
    throw new Error('invalid backup envelope')
  }
  let dek: Uint8Array
  try {
    dek = await aesGcmDecrypt(kek, base64ToBytes(env.wrappedDek), base64ToBytes(env.wrapNonce))
  } catch {
    throw new Error('bad password or corrupted backup')
  }
  try {
    const pt = await aesGcmDecrypt(dek, base64ToBytes(env.ciphertext), base64ToBytes(env.dataNonce))
    return new TextDecoder().decode(pt)
  } catch {
    throw new Error('bad password or corrupted backup')
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add packages/core/
git commit -m "feat(core): 备份envelope v1(DEK/KEK密钥分层,口令模式)"
```

---

### Task 3: 桌面原子写 + 本地备份服务

**Files:**
- Modify: `apps/desktop/src/tauriFs.ts`（set 改原子写：写 `${key}.json.tmp` → rename 覆盖；plugin-fs rename 权限与 AppData scope 核对）
- Create: `apps/desktop/src/backupService.ts`
- Create: `packages/core/src/backup/policy.ts` + 导出
- Test: `packages/core/test/backupPolicy.test.ts`

**Interfaces:**
- Produces:
  - core `policy.ts`：`backupFileName(now: Date): string`（`vault-YYYYMMDD-HHmmss.totpbackup`，本地时区）；`selectBackupsToKeep(names: string[], keep: number): string[]`（合法备份名排序后保留最近 keep 个，返回**应删除**的名字；非法文件名忽略不删；keep<=0 视为覆盖模式语义由调用方处理——此处仅对 keep 模式）；`OVERWRITE_NAME = 'vault-backup.totpbackup'`
  - desktop `backupService.ts`：
    - `async createBackupToDir(dir: string, vaultJson: string, password: string, mode: { type: 'keep'; n: number } | { type: 'overwrite' }): Promise<'created' | 'overwritten'>`（envelope 序列化写入 dir；overwrite 模式固定 OVERWRITE_NAME；keep 模式 backupFileName + 写后列目录 selectBackupsToKeep 删除超额）
    - `async listBackups(dir: string): Promise<Array<{ name: string }>>`（readDir 过滤 .totpbackup，名称倒序）
    - `async readBackupFile(path: string): Promise<string>`（读文本，交 envelope.open）
  - Rust 自定义命令（`apps/desktop/src-tauri/src/lib.rs`）：`write_text_file_os(path: String, contents: String)` / `read_text_file_os(path: String) -> String`（std::fs，供「导出到任意位置」「从文件恢复」用；前端 `invoke`）
  - tauriFs.set 原子化：`writeTextFile(key+'.json.tmp', value)` → `rename(key+'.json.tmp', key+'.json', { baseDir: AppData })`；capabilities 确认 rename 所需权限（`fs:allow-appdata-write-recursive` 应含 rename——核对插件 permission toml，若 rename 需独立权限点则补并报告）

- [ ] **Step 1: core policy TDD**

`packages/core/test/backupPolicy.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { backupFileName, OVERWRITE_NAME, selectBackupsToKeep } from '../src/backup/policy'

describe('backupFileName', () => {
  it('本地时区格式', () => {
    const d = new Date(2026, 8, 13, 15, 4, 5) // 2026-09-13 15:04:05 本地
    expect(backupFileName(d)).toBe('vault-20260913-150405.totpbackup')
  })
})

describe('selectBackupsToKeep', () => {
  const names = ['vault-20260913-150405.totpbackup', 'vault-20260912-090000.totpbackup', 'vault-20260911-090000.totpbackup', 'notes.txt', OVERWRITE_NAME]
  it('保留最近 n 个，返回应删除列表；非法名忽略', () => {
    expect(selectBackupsToKeep(names, 2)).toEqual(['vault-20260911-090000.totpbackup'])
    expect(selectBackupsToKeep(names, 5)).toEqual([])
  })
})
```

- [ ] **Step 2: 实现 + 桌面服务（build 验收）**

`packages/core/src/backup/policy.ts`:
```ts
export const BACKUP_EXT = '.totpbackup'
export const OVERWRITE_NAME = 'vault-backup.totpbackup'

export function backupFileName(now: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return `vault-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}${BACKUP_EXT}`
}

const NAME_RE = /^vault-\d{8}-\d{6}\.totpbackup$/

export function selectBackupsToKeep(names: string[], keep: number): string[] {
  const valid = names.filter((n) => NAME_RE.test(n)).sort() // 字典序=时间序
  const excess = keep > 0 ? valid.slice(0, Math.max(0, valid.length - keep)) : valid
  return excess
}
```

`backupService.ts`（invoke 封装 + plugin-fs readDir/rename，AppData `backups/` 子目录）：
```ts
import { invoke } from '@tauri-apps/api/core'
import { readDir, rename, writeTextFile, BaseDirectory } from '@tauri-apps/plugin-fs'
import { backupFileName, selectBackupsToKeep, OVERWRITE_NAME, createBackupEnvelope, type BackupEnvelopeV1 } from '@totp/core'

const dir = 'backups'

async function writeDirFile(name: string, contents: string): Promise<void> {
  const tmp = `${name}.tmp`
  await writeTextFile(`${dir}/${tmp}`, contents, { baseDir: BaseDirectory.AppData })
  await rename(`${dir}/${tmp}`, `${dir}/${name}`, { baseDir: BaseDirectory.AppData })
}

export async function createBackupToDir(vaultJson: string, password: string, mode: { type: 'keep'; n: number } | { type: 'overwrite' }): Promise<'created' | 'overwritten'> {
  const env = await createBackupEnvelope(vaultJson, password)
  const contents = JSON.stringify(env, null, 2)
  if (mode.type === 'overwrite') {
    await writeDirFile(OVERWRITE_NAME, contents)
    return 'overwritten'
  }
  await writeDirFile(backupFileName(new Date()), contents)
  const entries = await readDir(dir, { baseDir: BaseDirectory.AppData })
  const stale = selectBackupsToKeep(entries.map((e) => e.name), mode.n)
  for (const name of stale) await invoke('remove_backup_file', { name })
  return 'created'
}

export async function listBackups(): Promise<Array<{ name: string }>> {
  const entries = await readDir(dir, { baseDir: BaseDirectory.AppData })
  return entries.filter((e) => e.name.endsWith('.totpbackup')).map((e) => ({ name: e.name })).reverse()
}

export async function readBackupByName(name: string): Promise<string> {
  return readTextFile(`${dir}/${name}`, { baseDir: BaseDirectory.AppData })
}

export async function readBackupFileOs(path: string): Promise<string> {
  return invoke<string>('read_text_file_os', { path })
}

export async function writeBackupFileOs(path: string, envelope: BackupEnvelopeV1): Promise<void> {
  await invoke('write_text_file_os', { path, contents: JSON.stringify(envelope, null, 2) })
}
```
（`readTextFile` 从 plugin-fs 导入——按 Task 3 现状补 import；`remove_backup_file` Rust 命令：AppData/backups 下删指定名——白名单正则 `vault-*\.totpbackup` 校验防路径穿越；`read_text_file_os`/`write_text_file_os` 无 scope 限制（对话框选择的路径），命令实现加基本防护（拒绝目录/空路径）并在报告说明信任边界（路径由前端对话框产生））

Rust（lib.rs 追加三个 command + invoke_handler 注册）：
```rust
use std::fs;
use std::path::Path;

const BACKUP_NAME_RE: &str = r"^vault-[0-9]{8}-[0-9]{6}\.totpbackup$|^vault-backup\.totpbackup$";

fn valid_backup_name(name: &str) -> bool {
    // 简单白名单：前缀 vault-、后缀 .totpbackup、不含路径分隔符
    name.starts_with("vault-") && name.ends_with(".totpbackup") && !name.contains('/') && !name.contains('\\') && !name.contains("..")
}

#[tauri::command]
fn remove_backup_file(name: String) -> Result<(), String> {
    if !valid_backup_name(&name) { return Err("invalid backup name".into()); }
    let dir = dirs_appdata_backups()?;
    fs::remove_file(dir.join(name)).map_err(|e| e.to_string())
}

#[tauri::command]
fn read_text_file_os(path: String) -> Result<String, String> {
    let p = Path::new(&path);
    if !p.is_file() { return Err("not a file".into()); }
    fs::read_to_string(p).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_text_file_os(path: String, contents: String) -> Result<(), String> {
    if path.is_empty() { return Err("empty path".into()); }
    fs::write(path, contents).map_err(|e| e.to_string())
}
```
（`dirs_appdata_backups` 辅助：app.path().app_data_dir()?.join("backups")，必要时 create_dir_all；实现者按 tauri 2 AppHandle/State API 核实签名，可把三个命令改为接收 `app: tauri::AppHandle` 参数）

- [ ] **Step 3: 验证 + Commit**

Run: `pnpm --filter @totp/core test && pnpm -r run typecheck && pnpm --filter @totp/desktop tauri build`
Expected: 全绿 + 产物正常

```bash
git add packages/core/ apps/desktop/ pnpm-lock.yaml
git commit -m "feat(desktop): 本地备份服务(keep/overwrite模式)+原子写+OS文件命令"
```

---

### Task 4: 备份 UI（桌面设置卡 + 对话框导出/恢复 + 插件导出/恢复）

**Files:**
- Create: `packages/ui/src/components/BackupCard.vue`
- Modify: `packages/ui/src/index.ts`、`packages/ui/src/components/VaultManager.vue`（挂载 BackupCard）
- Modify: `apps/desktop/src/App.vue`（注入平台备份实现）
- Modify: `apps/extension/entrypoints/options/App.vue`（注入浏览器实现）
- Test: `packages/ui/test/BackupCard.test.ts`

**Interfaces:**
- Produces: `BackupCard.vue` props `{ platform: { createBackup(vaultJson: string, password: string): Promise<'created' | 'overwritten'>; exportToFile?(vaultJson: string, password: string): Promise<void>; restoreFromPicker?(): Promise<{ json: string } | null>; mode: { type: 'keep'; n: number } | { type: 'overwrite' }; setMode(m): Promise<void> } }`
  - UI：口令+确认口令输入（不一致报错）、模式选择（保留 N 份/覆盖）与 N 输入、「立即备份」按钮+结果反馈、备份文件列表（桌面）+「恢复」按钮（口令复用输入框）、[可选]「导出到文件」「从文件恢复」（platform 提供则显示）
  - 备份内容 = `saveVault` 同款 JSON 快照（`JSON.stringify(toRaw(vault))`）——调用方组装，BackupCard 只收 vaultJson 字符串（props 加 `vaultJson: string`）
- desktop App.vue platform 实现：createBackup→backupService（模式存 settings？模式与 N 属本地偏好——存 settings 新字段？**裁定：存桌面 localStorage**（非同步内容），key `backupMode`/`backupKeepN`，避免 core settings 再次扩面）；exportToFile→dialog save（默认名 backupFileName(new Date())）+ writeBackupFileOs；restoreFromPicker→dialog open+readBackupFileOs→openBackupEnvelope（口令在此处由对话框内输入）→ 返回 json
- extension options platform 实现：createBackup→createBackupEnvelope+Blob 下载（文件名 backupFileName(new Date())）；restoreFromPicker→`<input type=file>` 读文本→返回 json；恢复后统一走「替换导入」：`JSON.parse(json)` 校验 Vault 形状（version===1 且 Array.isArray(entries)）→ confirm 对话框「将用备份覆盖当前全部条目」→ adapter 层整体替换（store 需新增 `replaceAllOp(v: Vault)`——core `replaceVault` 语义：commit((cur) => parsed)）
- 恢复统一交互：解析 envelope→输入口令→成功后确认覆盖→`replaceAllOp`→成功提示

- [ ] **Step 1: store 补 replaceAllOp（TDD）**

`packages/ui/test/store.test.ts` 追加:
```ts
it('replaceAllOp 整体替换 vault 并落盘', async () => {
  const adapter = createMemoryStorage()
  const s = createVueStore(adapter)
  await s.initStore()
  const next = { version: 1 as const, entries: [{ uuid: 'r' }], groups: [], updatedAt: 42 }
  await s.replaceAllOp(next)
  expect(s.vault.updatedAt).toBe(42)
  expect(JSON.parse((await adapter.get('vault'))!).entries[0]).toEqual({ uuid: 'r' })
})
```
实现：store.ts 返回对象加 `replaceAllOp: (v: Vault) => commit(() => v)`（注意 replaceVault 深拷贝语义由 splice 保证）；extension 薄封装同步导出。

- [ ] **Step 2: BackupCard（TDD）**

`packages/ui/test/BackupCard.test.ts`:
```ts
import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import BackupCard from '../src/components/BackupCard.vue'

const platform = {
  createBackup: vi.fn().mockResolvedValue('created'),
  mode: { type: 'keep' as const, n: 5 },
  setMode: vi.fn().mockResolvedValue(undefined),
}

describe('BackupCard', () => {
  it('口令不一致不调用 createBackup', async () => {
    const w = mount(BackupCard, { props: { platform, vaultJson: '{}' } })
    const inputs = w.findAll('input[type="password"]')
    await inputs[0]!.setValue('a')
    await inputs[1]!.setValue('b')
    await w.find('button.backup-now').trigger('click')
    expect(platform.createBackup).not.toHaveBeenCalled()
  })
  it('口令一致调用并显示结果', async () => {
    const w = mount(BackupCard, { props: { platform, vaultJson: '{}' } })
    const inputs = w.findAll('input[type="password"]')
    await inputs[0]!.setValue('a')
    await inputs[1]!.setValue('a')
    await w.find('button.backup-now').trigger('click')
    await vi.waitFor(() => expect(platform.createBackup).toHaveBeenCalledWith('{}', 'a'))
    expect(w.text()).toContain('备份成功')
  })
  it('空口令不调用', async () => {
    const w = mount(BackupCard, { props: { platform, vaultJson: '{}' } })
    await w.find('button.backup-now').trigger('click')
    expect(platform.createBackup).not.toHaveBeenCalled()
  })
})
```
（BackupCard 内部：password/confirm refs、busy 状态、result 消息（成功文案含模式：`备份成功（新文件）` / `备份成功（覆盖）`）；mode 为 keep 时渲染 N 输入（change→setMode）；列表/导出/恢复按钮按 platform 可选方法有条件渲染——本测试覆盖核心三条，恢复路径在桌面/插件端各自手动验收）

- [ ] **Step 3: 三端接线 + 验证 + Commit**

- VaultManager 模板尾部 `<BackupCard :platform="platform" :vault-json="vaultJson" />`——props 新增 `platform?: BackupPlatform | null`（null 不渲染卡，popup 不受影响）；`vaultJson` computed `JSON.stringify(toRaw(store.vault))`——实现按现有结构最小接线
- desktop：dialog 插件（Cargo `tauri-plugin-dialog = "2"`、`.plugin(tauri_plugin_dialog::init())`、npm `@tauri-apps/plugin-dialog`、capabilities `dialog:allow-save`/`dialog:allow-open`）+ platform 组装（mode/N 持久化 localStorage、备份列表 load 后渲染、恢复流程 readBackupByName→openBackupEnvelope 口令 prompt（对话框内 input）→replaceAllOp）
- extension options：platform 组装（Blob 下载/input file）
- Run: `pnpm test && pnpm -r run typecheck && pnpm --filter @totp/desktop tauri build && pnpm --filter @totp/extension build`

```bash
git add packages/ apps/ pnpm-lock.yaml
git commit -m "feat(ui): BackupCard备份设置卡；桌面keep/overwrite与对话框导出；插件导出恢复"
```

---

### Task 5: 回归 + README

**Files:**
- Modify: `README.md`（补「备份」段：加密格式 envelope v1、桌面本地备份（目录/模式/恢复）、导出/导入文件、密钥自管口令）

- [ ] **Step 1: 回归**

Run: `pnpm test && pnpm -r run typecheck && pnpm --filter @totp/extension build && pnpm --filter @totp/desktop tauri build`
Expected: 全绿（core ~95、ui ~18）

- [ ] **Step 2: README + Commit**

```bash
git add README.md
git commit -m "docs: README补充加密备份说明"
```
