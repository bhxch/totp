# TOTP 工具 M1-计划5：导入体系（Aegis/WinAuth/通用 JSON）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付 M1 导入能力：core 导入嗅探器（Aegis 明文/加密 vault、WinAuth 明文/口令 XML（桌面另支持 DPAPI）、otpauth URI 批量、通用 JSON/JSON array/JSONL 点路径映射）+ 导入向导 UI（预览/映射/冲突策略/逐条报告）接入 options 页与桌面主窗口。

**Architecture:** core 新增 `import/`（sniff + 各格式 parser，统一产出 `ParsedEntry[]`）；冲突策略与合并为 core 纯函数；UI 新增 `ImportCard`（platform 提供文件读取），挂入 VaultManager（platform null 不渲染）。映射方案保存复用属 M2，本计划不做。

**Tech Stack:** 现有栈不变（core 仅 hash-wasm 已有；scrypt 用 hash-wasm）；desktop 新增 Rust 命令读导入文件（扩展名白名单）与 CryptUnprotectData（DPAPI，`windows` crate）。

**Spec:** `docs/plans/2026-09-13-totp-tool-design.md`（第 9 节导入导出；本计划实现其 M1 子集——19 格式全量、映射方案保存属 M2）

## Global Constraints

- 沿用全部既有约束（TS strict、TDD、Angular commit、中文 UI、core 运行时依赖仅 hash-wasm）
- 导入统一错误契约：文件级错误（嗅探失败/结构非法/解密失败）抛带中文 message 的 Error；**单条目失败不阻断**（收集为 `{ index, message }` 随结果返回）
- Aegis 加密 vault：与官方算法互认（scrypt KDF + AES-256-GCM key slot，参数取自文件 header）；口令错误报「口令错误或文件已损坏」
- WinAuth：明文/口令保护双端支持；DPAPI（默认 Windows 导出）仅桌面（Rust CryptUnprotectData），插件端检测到 DPAPI 条目→逐条错误「该 WinAuth 备份使用 Windows 加密，请用桌面版导入」；格式细节以 WinAuth 官方源码（github.com/winauth/winauth）为准研究对齐
- 冲突判定：已存在条目与导入条目的 `issuer` 与 `label` 均相同（大小写不敏感）即冲突；策略 skip=保留已有 / replace=用导入覆盖已有字段 / merge=并存为新条目
- 涉及 Rust/配置的任务必须核对构建产物

---

### Task 1: core 导入框架——嗅探 + URI 批量 + 通用 JSON/JSONL 映射（TDD）

**Files:**
- Create: `packages/core/src/import/types.ts`、`packages/core/src/import/sniff.ts`、`packages/core/src/import/generic.ts`、`packages/core/src/import/uriBatch.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/import.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // types.ts
  export interface ParsedEntry {            // 与 OtpEntry 字段子集对齐
    type: 'totp' | 'hotp' | 'steam'
    issuer: string
    label: string
    secret: string
    algorithm: 'SHA1' | 'SHA256' | 'SHA512'
    digits: number
    period: number
    counter?: number
    note?: string
  }
  export interface ImportResult {
    entries: ParsedEntry[]
    failures: Array<{ index: number; message: string }>
  }
  export type ImportFormat = 'aegis' | 'winauth' | 'uriBatch' | 'generic'
  ```
  - `sniffFormat(text: string): ImportFormat | null`——JSON.parse 成功且对象含 `db` 键→'aegis'（加密 vault 含 `header` 键→也是 'aegis'）；XML 且根/子含 `winauth` 或 `WinAuth` 字样→'winauth'；JSON.parse 成功且 Array.isArray→'generic'；每行 JSON.parse 成功且行数>1（或 1 行且为对象）→'generic'(JSONL)；含 `otpauth://`→'uriBatch'；其余 null。嗅探顺序：aegis → winauth → generic(JSON array/JSONL) → uriBatch → null
  - `importUriBatch(text: string): ImportResult`（按行 split、空行跳过；每行 parseOtpUri→ParsedEntry；失败行进 failures）
  - `extractGenericRows(text: string): { rows: unknown[]; kind: 'jsonArray' | 'jsonObjectArray' | 'jsonl' }`（JSON array→rows=数组；JSONL 按行 parse，坏行跳过不计 rows；单对象且某字段值是数组则 rows=该数组——自动探测候选：取对象中第一个 Array 类型的值）
  - `mapRowToEntry(row: unknown, mapping: RowMapping): ParsedEntry | { error: string }`——`interface RowMapping { type?: FieldMap; issuer?: FieldMap; label?: FieldMap; secret: FieldMap; algorithm?: FieldMap; digits?: FieldMap; period?: FieldMap; counter?: FieldMap; note?: FieldMap; defaults?: Partial<ParsedEntry> }`、`type FieldMap = { path: string; transform?: 'none' | 'uppercaseSecret' }`；点路径取值（`'otp.params.secret'`），取不到→用 defaults，secret 缺失→`{ error: '缺少 secret 字段' }`；secret 过 `uppercaseSecret`（默认对 secret 应用：trim+去空白+大写）
  - `importGeneric(text: string, mapping: RowMapping, rowsOverride?: unknown[]): ImportResult`（rows 用 extractGenericRows 或 override；逐行 mapRowToEntry）
- 通用类型值规整：algorithm 大写映射到三值枚举（非法→'SHA1'）；digits/period Number 化非法→默认 6/30；type 含 'steam'（大小写不敏感）→'steam'，含 'hotp'→'hotp'，其余 'totp'

- [ ] **Step 1: 写失败测试**

`packages/core/test/import.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { extractGenericRows, importGeneric, importUriBatch, mapRowToEntry, sniffFormat } from '../src/import/sniff'
import type { RowMapping } from '../src/import/sniff'

describe('sniffFormat', () => {
  it('各格式判定', () => {
    expect(sniffFormat('{"db": {"entries": []}}')).toBe('aegis')
    expect(sniffFormat('{"version": 1, "header": {"slots": []}}')).toBe('aegis')
    expect(sniffFormat('<?xml version="1.0"?><WinAuth>…</WinAuth>')).toBe('winauth')
    expect(sniffFormat('[{"secret":"JBSWY3DPEHPK3PXP"}]')).toBe('generic')
    expect(sniffFormat('{"a":1}\n{"b":2}')).toBe('generic')
    expect(sniffFormat('otpauth://totp/A:b?secret=JBSWY3DPEHPK3PXP')).toBe('uriBatch')
    expect(sniffFormat('hello')).toBeNull()
  })
})

describe('importUriBatch', () => {
  it('混合合法/非法行', () => {
    const r = importUriBatch(
      'otpauth://totp/GitHub:me@x.com?secret=JBSWY3DPEHPK3PXP\n\nnot a uri\notpauth://steam/Steam:u?secret=JBSWY3DPEHPK3PXP',
    )
    expect(r.entries).toHaveLength(2)
    expect(r.entries[0]).toMatchObject({ issuer: 'GitHub', label: 'me@x.com', type: 'totp' })
    expect(r.entries[1]).toMatchObject({ type: 'steam', digits: 5 })
    expect(r.failures).toEqual([{ index: 2, message: expect.stringContaining('invalid otpauth uri') }])
  })
})

describe('extractGenericRows', () => {
  it('数组/嵌套数组/JSONL', () => {
    expect(extractGenericRows('[{"s":"a"},{"s":"b"}]').rows).toHaveLength(2)
    const nested = extractGenericRows('{"data": {"otps": [{"s":"a"}]}}')
    expect(nested.rows).toEqual([{ s: 'a' }])
    expect(extractGenericRows('{"s":"a"}\n{"s":"b"}').kind).toBe('jsonl')
  })
})

describe('mapRowToEntry/importGeneric', () => {
  const mapping: RowMapping = {
    issuer: { path: 'name' },
    label: { path: 'account' },
    secret: { path: 'otp.secret' },
    type: { path: 'kind' },
  }
  const row = { name: 'GitHub', account: 'me@x.com', kind: 'totp', otp: { secret: 'jbswy3dpehpk3pxp' } }

  it('点路径取值 + secret 规整大写', () => {
    expect(mapRowToEntry(row, mapping)).toMatchObject({ issuer: 'GitHub', secret: 'JBSWY3DPEHPK3PXP', type: 'totp', digits: 6, period: 30, algorithm: 'SHA1' })
  })
  it('缺 secret 报错；defaults 补齐', () => {
    expect(mapRowToEntry({ name: 'x' }, mapping)).toEqual({ error: '缺少 secret 字段' })
    const withDefaults: RowMapping = { ...mapping, defaults: { issuer: '默认' } }
    expect(mapRowToEntry({ otp: { secret: 'JBSWY3DPEHPK3PXP' } }, withDefaults)).toMatchObject({ issuer: '默认', label: '' })
  })
  it('importGeneric 逐行报告', () => {
    const r = importGeneric(JSON.stringify([row, { name: 'bad' }]), mapping)
    expect(r.entries).toHaveLength(1)
    expect(r.failures).toEqual([{ index: 1, message: '缺少 secret 字段' }])
  })
  it('type=steam 时 digits 强制 5', () => {
    expect(mapRowToEntry({ ...row, kind: 'steam' }, mapping)).toMatchObject({ type: 'steam', digits: 5 })
  })
})
```

- [ ] **Step 2: 确认失败 → 实现 → 通过 → Commit**

实现按 Interfaces 逐项落地（sniff.ts 含全部四个函数或从同目录 re-export；JSON.parse 判定需 try/catch；XML 判定用正则 `/winauth/i` 即可，M1 不引入 XML 解析器——winauth parser 在 Task 3 自带轻量解析）。文件组织：types.ts/sniff.ts/generic.ts/uriBatch.ts 按 Interfaces 拆分。

Run: `pnpm --filter @totp/core test`（约 +14 用例）

```bash
git add packages/core/
git commit -m "feat(core): 导入嗅探+URI批量+通用JSON/JSONL点路径映射"
```

---

### Task 2: core Aegis 导入（明文 + 加密 vault，TDD）

**Files:**
- Create: `packages/core/src/import/aegis.ts`
- Test: `packages/core/test/aegisImport.test.ts`、`packages/core/test/fixtures/aegis-encrypted.json`（脚本生成随测试提交）

**Interfaces:**
- Consumes: ParsedEntry/ImportResult（Task 1）、hash-wasm scrypt、aesGcmDecrypt/base64（crypto/aesgcm）
- Produces:
  - `importAegisPlaintext(text: string): ImportResult`——JSON `{ db: { entries: [{ type, uuid, name, note, group?, info: { secret, algo, digits, period, counter, origin } }] } }`；type 形如 `totp`/`hotp`/`steam`（Aegis 里 steam 是 `totp` + issuer Steam？——以官方样例为准：Aegis db entry type: 'totp'|'hotp'|'steam'）；issuer 取 entry.issuer ?? name 前缀段（`Issuer:label` 拆分）；info.algo 'SHA1'|'SHA256'|'SHA512'；单条损坏进 failures
  - `async importAegisEncrypted(text: string, password: string): Promise<ImportResult>`——结构：`{ version, header: { slots: [{ type, uuid, key, key_params: { nonce, tag }, n, r, p, salt }], params: { nonce, tag, scrypt: { n, r, p } } }, db: {...} }`；slot.key=base64(nonce||ciphertext||tag)（nonce 前缀 12 字节），KEK=scrypt(password, slot.salt, {N:n, r, p}, 32)；解开任一 slot 得 master key；db 用 params.nonce + master key GCM 解密（db 密文=base64(nonce||ct||tag)?——以 Aegis 源码实测为准，实现者需研读 beemdevelopment/Aegis `Vault.decrypt`/`KeySlot` 逻辑并在此处注释引用对应源文件）；解出的 db JSON 走 importAegisPlaintext；口令错→`Error('口令错误或文件已损坏')`
  - 注意 hash-wasm scrypt API：`scrypt({ password, salt, N, r, p, hashLength: 32, outputType: 'binary' })`

- [ ] **Step 1: 生成加密 fixture**

`scripts/gen-aegis-fixture.mjs`（Node crypto scrypt + aes-256-gcm 按上述算法构造一个小 vault：1 条 totp 条目 secret 'JBSWY3DPEHPK3PXP'，口令 'test1234'）：
```js
import { scryptSync, randomBytes, createCipheriv } from 'node:crypto'
import { writeFileSync } from 'node:fs'

function gcmB64(key, nonce, plaintext) {
  const c = createCipheriv('aes-256-gcm', key, nonce)
  const ct = Buffer.concat([c.update(plaintext), c.final(), c.getAuthTag()])
  return Buffer.concat([nonce, ct]).toString('base64')
}

const password = 'test1234'
const slotSalt = randomBytes(32)
const kek = scryptSync(password, slotSalt, 32, { N: 16384, r: 8, p: 1 })
const masterKey = randomBytes(32)
const vault = {
  version: 1,
  header: {
    slots: [{ type: 1, uuid: crypto.randomUUID(), key: gcmB64(kek, randomBytes(12), masterKey), key_params: { nonce: 'placeholder', tag: 'x' }, n: 16384, r: 8, p: 1, salt: slotSalt.toString('base64') }],
    params: { nonce: 'placeholder', tag: 'x', scrypt: { n: 16384, r: 8, p: 1 } },
  },
  db: null,
}
// key_params 实际布局以 Aegis 源码为准：nonce/tag 可能分开存——实现者研读后统一 fixture 与 parser 的字段口径
const dbNonce = randomBytes(12)
const db = Buffer.from(JSON.stringify({ version: 1, entries: [{ type: 'totp', uuid: crypto.randomUUID(), name: 'GitHub:me@x.com', info: { secret: 'JBSWY3DPEHPK3PXP', algo: 'SHA1', digits: 6, period: 30, origin: 'manual' } }] }), 'utf8')
vault.db = gcmB64(masterKey, dbNonce, db)
writeFileSync('packages/core/test/fixtures/aegis-encrypted.json', JSON.stringify(vault, null, 2))
console.log('fixture written; password=test1234')
```
**要求**：实现者必须先读 Aegis 官方解密源码（raw.githubusercontent.com/beemdevelopment/Aegis/master/app/src/main/java/com/beemdevelopment/aegis/crypto/MasterKey.java 与 VaultFile* / crypto/KeySlot.java），确认 nonce/tag 的真实存放布局与 scrypt 参数来源，再统一 fixture 生成脚本与 parser 实现（脚本是起点口径，允许修正——fixture 与 parser 必须同口径且与官方算法一致，并在代码注释中引用所依据的源码文件）。

- [ ] **Step 2: 写失败测试**

`packages/core/test/aegisImport.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { importAegisEncrypted, importAegisPlaintext } from '../src/import/aegis'

const enc = () => readFileSync(fileURLToPath(new URL('./fixtures/aegis-encrypted.json', import.meta.url)), 'utf8')

describe('importAegisPlaintext', () => {
  it('官方结构样例', () => {
    const r = importAegisPlaintext(JSON.stringify({
      db: { version: 1, entries: [
        { type: 'totp', uuid: 'u1', name: 'GitHub:me@x.com', info: { secret: 'JBSWY3DPEHPK3PXP', algo: 'SHA1', digits: 6, period: 30, origin: 'manual' } },
        { type: 'steam', uuid: 'u2', name: 'Steam:player1', info: { secret: 'JBSWY3DPEHPK3PXP', algo: 'SHA1', digits: 5, period: 30 } },
      ] },
    }))
    expect(r.entries[0]).toMatchObject({ issuer: 'GitHub', label: 'me@x.com', type: 'totp' })
    expect(r.entries[1]).toMatchObject({ type: 'steam', digits: 5 })
    expect(r.failures).toHaveLength(0)
  })
  it('坏条目进 failures 不阻断', () => {
    const r = importAegisPlaintext(JSON.stringify({ db: { entries: [{ type: 'totp', name: 'x', info: {} }] } }))
    expect(r.entries).toHaveLength(0)
    expect(r.failures).toHaveLength(1)
  })
})

describe('importAegisEncrypted', () => {
  it('口令正确解开 fixture', async () => {
    const r = await importAegisEncrypted(enc(), 'test1234')
    expect(r.entries).toHaveLength(1)
    expect(r.entries[0]).toMatchObject({ issuer: 'GitHub', secret: 'JBSWY3DPEHPK3PXP' })
  })
  it('口令错误报中文错误', async () => {
    await expect(importAegisEncrypted(enc(), 'wrong')).rejects.toThrow('口令错误或文件已损坏')
  })
})
```

- [ ] **Step 3: 确认失败 → 实现 → 通过 → Commit**

```bash
git add packages/core/ scripts/gen-aegis-fixture.mjs
git commit -m "feat(core): Aegis导入(明文+加密vault,scrypt+GCM key slot对齐官方算法)"
```

---

### Task 3: core WinAuth 导入（明文/口令/DPAPI 探测）+ 桌面 DPAPI 命令（TDD）

**Files:**
- Create: `packages/core/src/import/winauth.ts`
- Modify: `packages/core/src/index.ts`、`apps/desktop/src-tauri/src/lib.rs`（+`decrypt_dpapi` 命令）、`apps/desktop/src-tauri/Cargo.toml`（+`windows` crate 目标依赖）、`apps/desktop/src/backupService.ts` 同级新文件 `importService.ts`（读导入文件命令封装）
- Test: `packages/core/test/winauthImport.test.ts`（fixtures 内联构造）

**Interfaces:**
- Produces:
  - `interface WinauthEntryInput { raw: string; encrypted?: 'dpapi' | 'password' | null; password?: string }`
  - `async importWinauth(text: string, opts?: { password?: string; decryptDpapi?: (b64: string) => Promise<string> }): Promise<ImportResult>`——XML `<winauth>` 根下多个 `<authenticator>`，每个含 `<protecteddata>` base64（明文导出为 `<entrydata>` 直接 base64 的 JSON——**口径以 WinAuth 源码研究为准**，实现者研读 github.com/winauth/winauth 的 WinAuthConfig.cs/WinAuth.cs 中 `Decryption`/`Unprotect`/XML 读写逻辑并在注释引用）；protected data 解出后为 UTF-8 JSON：`{ serialized: "...", ... }` 内含 HOTP/TOTP secret(base64)、type（Steam 判定）、digits、period、counter
  - protecteddata 三态：DPAPI（默认，无口令）→ 有 decryptDpapi 时调之（桌面），否则逐条 failure「该 WinAuth 备份使用 Windows 加密，请用桌面版导入」；password 保护→用 opts.password 按 WinAuth 算法解（研究结论：口令保护为 PBKDF2 派生 + AES？——以源码为准；hash-wasm 有 pbkdf2；如需 AES-CBC 用 WebCrypto）；口令缺失/错误→逐条 failure「需要口令或口令错误」
  - 内部把 WinAuth JSON 字段映射为 ParsedEntry（secret 从 base64 还原后转 base32 存储统一口径——用 `base32Encode`；issuer/label 从 WinAuth 的 name 字段拆分）
- desktop Rust：`#[tauri::command] fn decrypt_dpapi(b64: String) -> Result<String, String>`——`windows` crate `CryptUnprotectData`（CRYPTPROTECT_UI_FORBIDDEN），输入 base64→输出 UTF-8 字符串；仅 Windows 目标编译（`#[cfg(windows)]`，非 Windows 返回 Err('仅 Windows 支持')）；`importService.ts`：`readImportFileOs(path)`（新 Rust 命令 `read_import_file_os`，扩展名白名单 `.json|.wauth|.xml|.txt|.aegis`，与 read_text_file_os 同构）+ `decryptDpapiOs(b64)`（invoke 封装）
- 前端接线（Task 5 消费）：desktop platform.decryptDpapi=b64→invoke('decrypt_dpapi')；插件端不提供→核心自动逐条 failure

- [ ] **Step 1: 研究并写失败测试**

fixtures 内联构造（以研究结论为准修正下例结构）：
```ts
import { describe, expect, it } from 'vitest'
import { importWinauth } from '../src/import/winauth'

describe('importWinauth', () => {
  it('明文 entrydata', async () => {
    const xml = `<?xml version="1.0"?><winauth version="1"><entrydata>BASE64_JSON</entrydata></winauth>`
    // BASE64_JSON = UTF8(JSON.stringify({ serialized: '<base64 of authenticator data>', type: 'TOTP', name: 'GitHub:me@x.com', digits: 6, period: 30, secret: '<base32 or base64>' }))
    // 以研究结论填实——断言进口径：issuer/label/type/digits/period/secret(base32)
  })
  it('DPAPI 条目无 decryptDpapi 时逐条中文失败', async () => { /* protecteddata + 无 decryptDpapi → failures 含「桌面版」 */ })
  it('DPAPI + decryptDpapi 解开', async () => { /* 注入 mock decryptDpapi（内部实现用 node crypto 不行——测试直接传 stub 返回预置 JSON base64） */ })
  it('口令保护：无口令/错口令失败，对口令成功', async () => { /* fixture 用研究出的算法构造 */ })
})
```

- [ ] **Step 2: 确认失败 → 实现（含 Rust 命令与 npm 封装）→ 通过**

- [ ] **Step 3: 验证 + Commit**

Run: `pnpm --filter @totp/core test && pnpm -r run typecheck && pnpm --filter @totp/desktop tauri build`

```bash
git add packages/core/ apps/desktop/
git commit -m "feat(core,desktop): WinAuth导入(明文/口令/DPAPI探测)+桌面DPAPI命令"
```

---

### Task 4: core 冲突策略与合并（TDD）

**Files:**
- Create: `packages/core/src/import/conflict.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/conflict.test.ts`

**Interfaces:**
- Produces:
  - `type ConflictPolicy = 'skip' | 'replace' | 'merge'`
  - `findConflicts(existing: OtpEntry[], incoming: ParsedEntry[]): Set<number>`——incoming 下标集合：existing 中存在 issuer+label 均相同（trim+大小写不敏感）者
  - `applyImport(v: Vault, entries: ParsedEntry[], policy: ConflictPolicy, conflictIdx: Set<number>): Vault`——纯函数：非冲突条目全部新增（newEntryFromEntry：随机 uuid、order=maxOrder+1 递增、groupIds=[]、createdAt=now）；冲突条目按策略：skip=不动、replace=updateEntry（patch 全字段、保留 uuid/order/groupIds）、merge=照常新增并存
  - `newEntryFromParsed(p: ParsedEntry, uuid: string, order: number, nowMs: number): OtpEntry`
- extension/desktop 落地由 Task 5 经 `store.commit((v) => applyImport(v, entries, policy, conflicts))` 完成（replaceAllOp 不适用——冲突需在现 vault 上计算）

- [ ] **Step 1: 写失败测试**

`packages/core/test/conflict.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { applyImport, findConflicts } from '../src/import/conflict'
import type { ParsedEntry } from '../src/import/types'
import { addEntry, createVault, newEntryFromUri } from '../src/vault'

const p = (issuer: string, label: string): ParsedEntry => ({
  type: 'totp', issuer, label, secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA1', digits: 6, period: 30,
})

describe('findConflicts', () => {
  it('issuer+label 相同（大小写不敏感）判冲突', () => {
    const existing = [newEntryFromUri('otpauth://totp/GitHub:me@x.com?secret=JBSWY3DPEHPK3PXP', 0)]
    const idx = findConflicts(existing, [p('github', 'ME@X.COM'), p('GitLab', 'me@x.com')])
    expect([...idx]).toEqual([0])
  })
})

describe('applyImport', () => {
  const mkVault = () => {
    let v = createVault()
    v = addEntry(v, newEntryFromUri('otpauth://totp/GitHub:me@x.com?secret=JBSWY3DPEHPK3PXP', 0))
    return v
  }
  const incoming = [p('GitHub', 'me@x.com'), p('New', 'a@b.c')]
  it('skip：冲突条目不动，非冲突新增', () => {
    const v = applyImport(mkVault(), incoming, 'skip', findConflicts(mkVault(), incoming))
    expect(v.entries).toHaveLength(2)
    expect(v.entries.find((e) => e.issuer === 'New')).toBeDefined()
  })
  it('replace：冲突条目被覆盖（保留 uuid），非冲突新增', () => {
    const v0 = mkVault()
    const v = applyImport(v0, incoming, 'replace', findConflicts(v0, incoming))
    expect(v.entries).toHaveLength(2)
    const gh = v.entries.find((e) => e.issuer === 'GitHub')!
    expect(gh.uuid).toBe(v0.entries[0]!.uuid)
  })
  it('merge：冲突条目并存新增', () => {
    const v = applyImport(mkVault(), incoming, 'merge', findConflicts(mkVault(), incoming))
    expect(v.entries).toHaveLength(3)
  })
  it('新增条目 order 递增、createdAt>0', () => {
    const v = applyImport(createVault(), incoming, 'skip', new Set())
    expect(v.entries.map((e) => e.order)).toEqual([0, 1])
    expect(v.entries.every((e) => e.createdAt > 0)).toBe(true)
  })
})
```

- [ ] **Step 2: 确认失败 → 实现 → 通过 → Commit**

```bash
git add packages/core/
git commit -m "feat(core): 导入冲突检测与skip/replace/merge策略"
```

---

### Task 5: ImportCard 导入向导 UI + 三端接线

**Files:**
- Create: `packages/ui/src/components/ImportCard.vue`
- Modify: `packages/ui/src/index.ts`、`packages/ui/src/components/VaultManager.vue`（挂载，platform 可选扩展）
- Modify: `apps/desktop/src/App.vue`（platform 补 readImportFile/decryptDpapi）、`apps/extension/entrypoints/options/App.vue`（input file + 不提供 dpapi）
- Test: `packages/ui/test/ImportCard.test.ts`

**Interfaces:**
- Produces: `ImportCard.vue` props `{ platform: { readImportFile: () => Promise<{ text: string; name: string } | null>; decryptDpapi?: (b64: string) => Promise<string>; store: VueStore } | null }`
  - 流程状态机（单组件内）：idle（「导入」按钮 + 可选格式提示）→ picked（sniffFormat 结果展示 + 非 null 时进入）→ generic 映射编辑（每目标字段一个 path 输入 + rows 来源展示；secret 必填标注；「使用预填」按常见键名自动猜测——`secret|key`、`issuer|name|service`、`label|account|username`）→ 口令输入（aegis 加密/winauth 口令保护需口令时出现）→ confirm（冲突数展示 + 策略单选 skip/replace/merge）→ report（成功 N 条/失败列表逐条中文）
  - 行为：`store.commit((v) => applyImport(v, result.entries, policy, conflicts))`；失败列表不阻断成功；全程 busy 防重入；格式嗅探 null→「无法识别的文件格式」
- platform：desktop readImportFile→dialog open（过滤器 .json/.wauth/.txt/.aegis）+ readImportFileOs；extension→动态 input file（复用 Task 4 修复的挂起兜底模式：appendChild/remove+30s 超时）；decryptDpapi 仅 desktop 提供

- [ ] **Step 1: 写失败测试**

`packages/ui/test/ImportCard.test.ts`（jsdom）:
```ts
import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createMemoryStorage, newEntryFromUri } from '@totp/core'
import { createVueStore } from '../src/store'
import ImportCard from '../components/../src/components/ImportCard.vue'

async function readyStore() {
  const s = createVueStore(createMemoryStorage())
  await s.initStore()
  await s.addEntryOp(newEntryFromUri('otpauth://totp/GitHub:me@x.com?secret=JBSWY3DPEHPK3PXP', 0))
  return s
}

const URI_TEXT = 'otpauth://totp/NewServ:a@b.c?secret=JBSWY3DPEHPK3PXP\notpauth://totp/GitHub:me@x.com?secret=JBSWY3DPEHPK3PXP\nbadline'

function mkPlatform(store: Awaited<ReturnType<typeof readyStore>>) {
  return { readImportFile: vi.fn().mockResolvedValue({ text: URI_TEXT, name: 'u.txt' }), store }
}

describe('ImportCard', () => {
  it('URI 批量导入：识别格式→确认冲突策略 skip→报告 1 成功 1 冲突跳过 1 失败', async () => {
    const store = await readyStore()
    const w = mount(ImportCard, { props: { platform: mkPlatform(store) } })
    await w.find('button.import-start').trigger('click')
    await vi.waitFor(() => expect(w.text()).toContain('uriBatch'))
    await w.find('button.import-next').trigger('click') // URI 格式无映射页
    await vi.waitFor(() => expect(w.text()).toContain('冲突'))
    await w.find('input[value="skip"]').setValue()
    await w.find('button.import-commit').trigger('click')
    await vi.waitFor(() => {
      expect(w.text()).toContain('成功导入 1 条')
      expect(w.text()).toContain('跳过')
      expect(w.text()).toContain('badline')
    })
    expect(store.vault.entries).toHaveLength(2) // 原有 GitHub + NewServ
  })
  it('无法识别格式显示错误', async () => {
    const store = await readyStore()
    const w = mount(ImportCard, { props: { platform: { readImportFile: vi.fn().mockResolvedValue({ text: 'hello', name: 'x' }), store } } })
    await w.find('button.import-start').trigger('click')
    await vi.waitFor(() => expect(w.text()).toContain('无法识别'))
  })
})
```

- [ ] **Step 2: 实现（组件状态机 + 三端 platform 接线）→ 通过**

实现要点：sniffFormat/aegis/winauth/generic/conflict 全部从 '@totp/core' 导入；aegis 加密与 winauth 口令需口令时展示 password input（type=password）；映射页 rows 取 `extractGenericRows` 结果与 `rows.length` 展示；映射猜测预填（常见键名扫描首行 keys）；confirm 页显示 `findConflicts(store.vault.entries, entries).size`；report 页 failures 逐条（index+message）。

三端接线：VaultManager props `platform` 扩展可选字段（readImportFile/decryptDpapi），null 安全；desktop App.vue 组装（dialog open 过滤器 name '导入文件' extensions ['json','wauth','txt','aegis']）；extension options 组装（input file 模式）。popup 不动。

- [ ] **Step 3: 验证 + Commit**

Run: `pnpm test && pnpm -r run typecheck && pnpm --filter @totp/extension build && pnpm --filter @totp/desktop tauri build`

```bash
git add packages/ apps/ pnpm-lock.yaml
git commit -m "feat(ui): ImportCard导入向导(嗅探/映射/口令/冲突/报告)+三端接线"
```

---

### Task 6: 回归 + README

**Files:**
- Modify: `README.md`（补「导入」段：支持格式清单、通用 JSON 映射、冲突策略、WinAuth DPAPI 桌面限定）

- [ ] **Step 1: 回归**

Run: `pnpm test && pnpm --filter @totp/extension build && pnpm -r run typecheck && pnpm --filter @totp/desktop tauri build`
Expected: 全绿（core ~125、ui ~21）

- [ ] **Step 2: README + Commit**

```bash
git add README.md
git commit -m "docs: README补充导入格式与冲突策略说明"
```
