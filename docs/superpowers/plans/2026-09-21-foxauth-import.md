# FoxAuth 备份导入 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增第 16 种导入格式 `foxauth`：明文与加密（Firefox Send 式 AES-GCM）备份均可导入，完全对齐现有导入框架（sniff → 解析器 → DISPATCH → UI/README → fixtures）。

**Architecture:** `types.ts` 联合类型加 `'foxauth'`；`sniff.ts` 特征判定（`accountInfos` 数组 + `isEncrypted` 布尔）；`jsonApps.ts` 加 `importFoxauth(text, password?)`（明文路径 + 加密解密路径）；口令取自 `passwordInfo.encryptPassword` 的 Base64 解码。

**Tech Stack:** packages/core vitest；WebCrypto（`globalThis.crypto.subtle`，core 既有多端约定）。

**Spec:** `docs/superpowers/specs/2026-09-21-foxauth-import-design.md`

## Global Constraints

- 错误契约：结构级错误 `throw`（中文信息），单条损坏进 `failures` 不阻断。
- 算法恒 SHA1（FoxAuth 无 algorithm 字段）；`localOTPType === 'Counter based'` → hotp，否则 totp；digits 缺省 6、period 缺省 30。
- 加密参数未经 Task 1 确认前**不得**凭猜测实现解密；确认失败走降级（加密版结构级报错）。
- 复用 `normalizeSecret`/`normalizeAlgorithm`/`toPositiveNumber`（`./normalize`），不重复造轮子。

---

### Task 1: 加密参数前置调查（gate：决定 Task 4 走哪条路）

**Files:**
- Modify: `docs/superpowers/specs/2026-09-21-foxauth-import-design.md`（末尾追加「加密参数附录」）

- [ ] **Step 1: 拉取 FoxAuth 加密源码**

WebFetch 以下文件（master 分支；如 404 则从仓库目录树定位实际路径）：
- `https://raw.githubusercontent.com/FoxAuth/FoxAuth/master/src/scripts/encryption/keychain.js`
- `https://raw.githubusercontent.com/FoxAuth/FoxAuth/master/src/scripts/encryption/MessageEncryption.js`
- `https://raw.githubusercontent.com/FoxAuth/FoxAuth/master/src/scripts/import.js`

- [ ] **Step 2: 固化参数附录**

从源码提取并写入 spec 附录：KDF（算法/迭代次数/salt 来源/派生位数）、AES 模式与填充、IV 长度与位置、密文编码、口令处理（是否 Base64 解码后再用于派生）。示例格式：

```
## 加密参数附录（调查于 2026-09-21）
- 口令：base64Decode(passwordInfo.encryptPassword) 得明文口令
- KDF：PBKDF2(SHA-256, salt=<来源>, iterations=<N>, 派生 <256> bit AES-GCM key)
- 密文：AES-GCM，IV <12B> 位于 <位置>，tag <128 bit>，<编码方式>
- 解密成功判据：<如 JSON.parse 成功>
```

- [ ] **Step 3: 路径裁定**

参数完整可复现 → Task 4 走「实现解密」；
参数无法确认（源码缺失/版本不符/无法构造可验证向量）→ Task 4 改走「降级」：
`isEncrypted:true` 时 `throw new Error('FoxAuth 加密备份暂不支持：请导出明文备份后重试')`，
spec 附录记录降级原因。两条路都允许，**必须在附录写明裁定结果**。

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-09-21-foxauth-import-design.md
git commit -m "docs(specs): foxauth加密参数调查结论与路径裁定（验收条目11）"
```

### Task 2: 类型与嗅探

**Files:**
- Modify: `packages/core/src/import/types.ts`（`ImportFormat` 联合）
- Modify: `packages/core/src/import/sniff.ts`（判定函数 + `sniffFormat` 链 + 头部注释）

**Interfaces:**
- Consumes: 既有 `sniffFormat` 判定链（JSON 对象族在 generic 兜底之前）
- Produces: `ImportFormat` 含 `'foxauth'`；`sniffFoxauth(obj: Record<string, unknown>): boolean`

- [ ] **Step 1: 写失败测试**

core 导入既有 sniff 测试文件内追加（文件以 `rg -l "sniffFormat" packages/core/src/import` 定位）：

```ts
describe('sniffFormat foxauth', () => {
  it('accountInfos 数组 + isEncrypted 布尔判 foxauth', () => {
    expect(sniffFormat(JSON.stringify({ accountInfos: [], isEncrypted: false }))).toBe('foxauth')
    expect(sniffFormat(JSON.stringify({ accountInfos: [{ localIssuer: 'GitHub' }], isEncrypted: true, passwordInfo: {} }))).toBe('foxauth')
  })

  it('不误伤既有格式', () => {
    expect(sniffFormat(JSON.stringify({ db: {}, header: {} }))).toBe('aegis')
    expect(sniffFormat(JSON.stringify({ services: [{ secret: 'JBSW' }] }))).toBe('twoFas')
    expect(sniffFormat('{}')).toBe('generic')
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @totp/core test -- sniff`
Expected: FAIL（`'foxauth'` 不在 `ImportFormat`）

- [ ] **Step 3: 实现**

types.ts：`ImportFormat` 加 `| 'foxauth'`（注释行同步：foxauth 为 JSON 对象特征格式）。
sniff.ts 头部判定顺序注释加一行 `foxauth`；判定链在 `sniffFreeOtp` 之后、generic 兜底之前插：

```ts
if (sniffFoxauth(obj)) return 'foxauth'
```

判定函数（与其他 sniff* 并列）：

```ts
// FoxAuth 备份（FoxAuth/FoxAuth src/scripts/import.js overwriteKeys 白名单）：
// 顶层 accountInfos 数组 + isEncrypted 布尔；accountInfos 加密时为密文形态亦可判定
function sniffFoxauth(obj: Record<string, unknown>): boolean {
  return Array.isArray(obj.accountInfos) && typeof obj.isEncrypted === 'boolean'
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm --filter @totp/core test -- sniff`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/import/types.ts packages/core/src/import/sniff.ts
git commit -m "feat(core): 导入格式嗅探新增foxauth（验收条目11）"
```

### Task 3: importFoxauth 明文路径

**Files:**
- Modify: `packages/core/src/import/jsonApps.ts`（文件末尾新增节）
- Modify: sniff 测试同文件或新建 `packages/core/src/import/foxauth.test.ts`（推荐独立文件）

**Interfaces:**
- Consumes: `parseJson`/`collectEntries`/`normalizeSecret`/`toPositiveNumber`（jsonApps.ts 与 ./normalize 既有）
- Produces: `export function importFoxauth(text: string, password?: string): Promise<ImportResult>`（async 为 Task 4 加密分支预留；明文分支不 await）

- [ ] **Step 1: 写失败测试**

`packages/core/src/import/foxauth.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { importFoxauth } from './jsonApps'

const plaintext = JSON.stringify({
  accountInfos: [
    { localIssuer: 'GitHub', localAccountName: 'a@b.c', localSecretToken: 'JBSWY3DPEHPK3PXP', localOTPType: 'Time based', localOTPDigits: '6', localOTPPeriod: '30' },
    { localIssuer: 'Battle.net', localAccountName: 'player1', localSecretToken: 'JBSWY3DPEHPK3PXP', localOTPType: 'Counter based', localOTPDigits: '8' },
    { localIssuer: '坏条目', localAccountName: 'x', localSecretToken: '!!not-base32!!', localOTPType: 'Time based' },
  ],
  isEncrypted: false,
})

describe('importFoxauth 明文', () => {
  it('字段映射与缺省口径', async () => {
    const r = await importFoxauth(plaintext)
    expect(r.entries).toHaveLength(2)
    expect(r.failures).toHaveLength(1)
    const [gh, bnet] = r.entries
    expect(gh).toMatchObject({ type: 'totp', issuer: 'GitHub', label: 'a@b.c', algorithm: 'SHA1', digits: 6, period: 30 })
    expect(bnet).toMatchObject({ type: 'hotp', issuer: 'Battle.net', digits: 8, counter: 0 })
  })

  it('结构级错误：非对象/缺 accountInfos/空数组', async () => {
    await expect(importFoxauth('[]')).rejects.toThrow(/顶层不是 JSON 对象/)
    await expect(importFoxauth('{}')).rejects.toThrow(/accountInfos/)
    await expect(importFoxauth(JSON.stringify({ accountInfos: [], isEncrypted: false }))).rejects.toThrow(/无条目/)
  })

  it('加密备份未给口令：明确报错', async () => {
    await expect(importFoxauth(JSON.stringify({ accountInfos: 'CIPHER', isEncrypted: true, passwordInfo: {} })))
      .rejects.toThrow(/加密/)
  })
})
```

（第三条在 Task 4 实现解密后仍应通过——不给口令时结构级报错。）

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @totp/core test -- foxauth`
Expected: FAIL（`importFoxauth` 未导出）

- [ ] **Step 3: 实现**

jsonApps.ts 末尾：

```ts
// ---------- FoxAuth（FoxAuth/FoxAuth src/scripts/import.js） ----------
// 顶层 overwriteKeys 白名单 {accountInfos, isEncrypted, passwordInfo, settings, dropbox}。
// 条目：localIssuer→issuer、localAccountName→label、localSecretToken→secret(base32)；
// localOTPType 'Counter based'→hotp（counter 恒 0：FoxAuth 无 counter 字段），否则 totp；
// 算法固定 SHA1（无字段）；digits/period 字符串数字，缺省 6/30。
// 加密备份（isEncrypted:true）：accountInfos 为密文，口令 = base64Decode(passwordInfo.encryptPassword)，
// 解密见 decryptFoxauth（参数依据 spec 加密参数附录）；未给口令结构级报错。
export async function importFoxauth(text: string, password?: string): Promise<ImportResult> {
  const obj = parseJson(text, 'FoxAuth')
  if (!Array.isArray(obj.accountInfos)) throw new Error('FoxAuth 文件结构非法：缺少 accountInfos 数组')
  const encrypted = obj.isEncrypted === true
  if (encrypted) {
    if (password === undefined || password === '') {
      throw new Error('FoxAuth 加密备份需要口令：请输入导出时设置的密码')
    }
    const b64pwd = (obj.passwordInfo as Record<string, unknown> | undefined)?.encryptPassword
    if (typeof b64pwd !== 'string' || b64pwd === '') {
      throw new Error('FoxAuth 文件结构非法：加密备份缺少 passwordInfo.encryptPassword')
    }
    const pwd = atob(b64pwd) // 口令为 Base64 编码，解码后使用（FoxAuth import.js base64Decode 口径）
    const plain = await decryptFoxauth(obj.accountInfos as string, pwd)
    return collectFoxauthRows(plain)
  }
  return collectFoxauthRows(obj.accountInfos)
}

function collectFoxauthRows(rows: unknown): ImportResult {
  return collectEntries(rows, (raw, index) => {
    const e = asObject(raw)
    if (!e) return { error: `条目 ${index} 非对象` }
    const secret = typeof e.localSecretToken === 'string' ? normalizeSecret(e.localSecretToken) : ''
    if (!secret) return { error: `条目 ${index} 缺少 secret` }
    const type = e.localOTPType === 'Counter based' ? 'hotp' as const : 'totp' as const
    return {
      type,
      issuer: typeof e.localIssuer === 'string' ? e.localIssuer : '',
      label: typeof e.localAccountName === 'string' ? e.localAccountName : '',
      secret,
      algorithm: 'SHA1' as const,
      digits: toPositiveNumber(Number(e.localOTPDigits), 6),
      ...(type === 'hotp' ? { counter: 0 } : {}),
      period: toPositiveNumber(Number(e.localOTPPeriod), 30),
    }
  })
}
```

（`decryptFoxauth` 本任务先给降级桩以通过编译：`async function decryptFoxauth(_cipher: string, _pwd: string): Promise<unknown> { throw new Error('FoxAuth 加密备份暂不支持：请导出明文备份后重试') }`——Task 4 按裁定替换或保留。`toPositiveNumber` 对 NaN 的行为以 normalize.ts 实际为准，若 NaN 不落缺省则改用 `Number.isFinite` 判断后传值。）

- [ ] **Step 4: 运行确认通过**

Run: `pnpm --filter @totp/core test -- foxauth`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/import/jsonApps.ts packages/core/src/import/foxauth.test.ts
git commit -m "feat(core): foxauth明文备份导入解析器（验收条目11）"
```

### Task 4: 加密分支（按 Task 1 裁定）

**Files:**
- Modify: `packages/core/src/import/jsonApps.ts`（`decryptFoxauth`）
- Modify: `packages/core/src/import/foxauth.test.ts`（加密向量用例）

**Interfaces:**
- Consumes: Task 1 附录参数；`globalThis.crypto.subtle`
- Produces: `decryptFoxauth(cipher: string, password: string): Promise<unknown>`（返回解析后的 accountInfos 数组）

- [ ] **Step 1（实现路）: 按附录参数写失败测试**

用「按附录参数手工构造的向量」（明文 JSON → 按参数加密 → 密文放入 `{accountInfos: <cipher>, isEncrypted: true, passwordInfo: {encryptPassword: b64('test-password')}}`），断言 `importFoxauth(text, 'test-password')` 与对应明文导入结果一致：

```ts
it('加密备份：正确口令解密导入', async () => {
  const r = await importFoxauth(encryptedFixture, 'test-password')
  expect(r.entries.map((e) => e.issuer)).toEqual(['GitHub'])
})

it('加密备份：错误口令结构级报错', async () => {
  await expect(importFoxauth(encryptedFixture, 'wrong-password')).rejects.toThrow()
})
```

`encryptedFixture` 的构造代码写进测试文件（用同参数加密一段明文生成——保证向量可复现，不硬编码来历不明密文）。

- [ ] **Step 2: 运行确认失败**（桩抛错即 FAIL）

- [ ] **Step 3: 实现解密**

```ts
async function decryptFoxauth(cipher: string, password: string): Promise<unknown> {
  // 参数严格按 spec「加密参数附录」（Task 1 固化）；此处为占位骨架，参数按附录填入：
  // 1. salt/iv 从密文中的位置提取（附录口径） 2. PBKDF2 派生 AES-GCM key
  // 3. decrypt → TextDecoder → JSON.parse（失败抛「口令错误或文件损坏」）
  throw new Error('按附录实现') // ← Task 1 实现路时替换；降级路时保留 Task 3 桩并删本函数
}
```

（骨架中的注释逐条替换为附录参数的真实实现；解密失败统一
`throw new Error('FoxAuth 备份解密失败：口令错误或文件已损坏')`。）

- [ ] **Step 4: 运行确认通过 / 降级路直接跳到 Step 5**

Run: `pnpm --filter @totp/core test -- foxauth`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/import/jsonApps.ts packages/core/src/import/foxauth.test.ts
git commit -m "feat(core): foxauth加密备份解密导入（参数见spec附录）（验收条目11）"
```

### Task 5: 入口接线与文档

**Files:**
- Modify: `packages/core/src/import/paste.ts`（`DISPATCH` 表）
- Modify: 导入 UI 格式清单组件（`rg -l "2FAS" packages/ui/src --glob '*.vue'` 定位清单文案处）
- Modify: `README.md` 支持格式表

**Interfaces:**
- Consumes: `importFoxauth`
- Produces: 粘贴路径可嗅探并直接导入 foxauth 明文（加密走导入页口令通道，与 Aegis 同款交互）

- [ ] **Step 1: DISPATCH 加项**

按 paste.ts 既有表形状（`rg -n "twoFas" packages/core/src/import/paste.ts` 参考邻近项）加 `'foxauth'` → `importFoxauth`（同步入口；加密情形由解析器抛错引导至口令通道）。

- [ ] **Step 2: UI/README 更新**

格式清单加「FoxAuth」；README 表加一行（明文 / 加密（见附录参数）状态与 Task 1 裁定一致）。

- [ ] **Step 3: 全量验证**

Run: `pnpm --filter @totp/core test && pnpm typecheck`
Expected: 全绿

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/import/paste.ts packages/ui README.md
git commit -m "feat(core): foxauth导入入口接线与文档（验收条目11）"
```
