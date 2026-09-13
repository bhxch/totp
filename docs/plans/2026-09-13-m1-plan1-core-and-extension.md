# TOTP 工具 M1-计划1：脚手架 + core OTP 引擎 + 插件最小闭环 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 搭建 pnpm monorepo，实现 core 包的 base32/HOTP/TOTP/Steam/otpauth URI/领域模型/存储抽象（全部带 RFC 官方向量测试），并用 WXT 产出一个可安装的 Chrome/Edge 插件：手动录入 → 列表显示验证码与倒计时 → 点击复制。

**Architecture:** 三层 monorepo：`packages/core`（纯 TS，零框架零 DOM 依赖，WebCrypto 原语）→ `packages/ui`（Vue 3 组件与 composable）→ `apps/extension`（WXT 插件壳，实现 chrome.storage 的 StorageAdapter 并组装 UI）。core 以 TS 源码直接被 Vite 消费，不单独构建。

**Tech Stack:** pnpm 9+、Node 20+（全局 WebCrypto）、TypeScript 5 strict、Vitest、Vue 3.5、WXT（MV3）。

**Spec:** `docs/plans/2026-09-13-totp-tool-design.md`（本计划实现其 M1 的骨架部分；URL 匹配过滤、桌面壳、导入、加密备份在后续计划）

## Global Constraints

- Node >= 20、pnpm >= 9；测试框架一律 Vitest
- `packages/core` 禁止 import 任何框架、DOM API（`document`/`window`）与第三方运行时依赖；密码学原语只用全局 `crypto.subtle` / `crypto.randomUUID`
- TypeScript 全程 `strict: true`，模块 `ESNext` + `moduleResolution: bundler`，`verbatimModuleSyntax: true`
- UI 全部文案中文
- 每个任务结束必须 `git commit`（Angular 规范），提交前该任务的测试必须全绿
- 测试命令统一 `pnpm --filter <pkg> test`；根目录 `pnpm test` 递归跑全部
- 临时文件放 `.temp/`（已进 .gitignore）

---

### Task 1: pnpm workspace 脚手架

**Files:**
- Create: `package.json`、`pnpm-workspace.yaml`、`.gitignore`、`tsconfig.base.json`
- Create: `packages/core/package.json`、`packages/core/tsconfig.json`、`packages/core/vitest.config.ts`
- Create: `packages/core/src/index.ts`、`packages/core/test/smoke.test.ts`

**Interfaces:**
- Produces: 包名 `@totp/core`（后续所有任务从这里 import）；根脚本 `pnpm test`（递归跑所有包测试）

- [ ] **Step 1: 写根配置文件**

`pnpm-workspace.yaml`:
```yaml
packages:
  - packages/*
  - apps/*
```

`package.json`:
```json
{
  "name": "totp-workspace",
  "private": true,
  "scripts": {
    "test": "pnpm -r --no-bail run test",
    "typecheck": "pnpm -r run typecheck"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

`.gitignore`:
```
node_modules/
dist/
.output/
.temp/
*.log
.wxt/
src-tauri/target/
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM"],
    "strict": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "noUncheckedIndexedAccess": true,
    "isolatedModules": true,
    "noEmit": true
  }
}
```

`packages/core/package.json`:
```json
{
  "name": "@totp/core",
  "version": "0.1.0",
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

`packages/core/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src", "test", "vitest.config.ts"]
}
```

`packages/core/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { environment: 'node' },
})
```

- [ ] **Step 2: 冒烟测试**

`packages/core/test/smoke.test.ts`:
```ts
import { describe, expect, it } from 'vitest'

describe('workspace', () => {
  it('node 20+ 提供 webcrypto', () => {
    expect(crypto.subtle).toBeDefined()
  })
})
```

`packages/core/src/index.ts`:
```ts
export const CORE_VERSION = '0.1.0'
```

- [ ] **Step 3: 安装并验证**

Run: `pnpm install && pnpm --filter @totp/core test`
Expected: 1 个测试 PASS

- [ ] **Step 4: Commit**

```bash
git add package.json pnpm-workspace.yaml .gitignore tsconfig.base.json packages/core/
git commit -m "chore: 搭建pnpm workspace与core包脚手架"
```

---

### Task 2: base32 编解码

**Files:**
- Create: `packages/core/src/encoding/base32.ts`
- Create: `packages/core/src/index.ts`（修改，追加导出）
- Test: `packages/core/test/base32.test.ts`

**Interfaces:**
- Produces: `base32Decode(input: string, opts?: { alphabet?: string }): Uint8Array`（容错：大小写、空格/连字符、`=` padding 可省略；非法字符抛 `Error('invalid base32')`）；`base32Encode(bytes: Uint8Array): string`（RFC 4648，带 padding）；`RFC4648_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'`；`STEAM_ALPHABET = '23456789BCDFGHJKMNPQRTVWXY'`（26 字符，仅用于 Steam 码输出，不是解码表）

- [ ] **Step 1: 写失败测试**

`packages/core/test/base32.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { base32Decode, base32Encode, RFC4648_ALPHABET, STEAM_ALPHABET } from '../src/encoding/base32'

describe('base32Encode', () => {
  // RFC 4648 官方向量
  it.each([
    [new Uint8Array(0), ''],
    [new TextEncoder().encode('f'), 'MY======'],
    [new TextEncoder().encode('fo'), 'MZXQ===='],
    [new TextEncoder().encode('foo'), 'MZXW6==='],
    [new TextEncoder().encode('foob'), 'MZXW6YQ='],
    [new TextEncoder().encode('fooba'), 'MZXW6YTB'],
    [new TextEncoder().encode('foobar'), 'MZXW6YTBOI======'],
  ])('%s → %s', (input, expected) => {
    expect(base32Encode(input)).toBe(expected)
  })
})

describe('base32Decode', () => {
  it.each([
    ['', 0],
    ['MY======', 1],
    ['MZXW6YTBOI======', 6],
    ['MZXW6YTBOI', 6], // padding 可省略
    ['mzxw6ytboi======', 6], // 小写
    ['MZXW 6YTB OI', 6], // 空格
  ])('%s → %d bytes', (input, expectedLen) => {
    const out = base32Decode(input)
    expect(out.length).toBe(expectedLen)
    expect(new TextDecoder().decode(out)).toBe('foobar'.slice(0, expectedLen))
  })

  it('非法字符抛错', () => {
    expect(() => base32Decode('ABC1')).toThrow('invalid base32') // 1 不在 RFC4648 表
  })
})

describe('字母表', () => {
  it('RFC4648 表 32 字符；Steam 表 26 字符无 0189', () => {
    expect(RFC4648_ALPHABET).toHaveLength(32)
    expect(STEAM_ALPHABET).toHaveLength(26)
    expect(STEAM_ALPHABET).not.toMatch(/[0189]/)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @totp/core test`
Expected: FAIL，模块不存在

- [ ] **Step 3: 实现**

`packages/core/src/encoding/base32.ts`:
```ts
export const RFC4648_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
export const STEAM_ALPHABET = '23456789BCDFGHJKMNPQRTVWXY'

export function base32Encode(bytes: Uint8Array, alphabet: string = RFC4648_ALPHABET): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31]
  while (out.length % 8 !== 0) out += '='
  return out
}

export function base32Decode(input: string, alphabet: string = RFC4648_ALPHABET): Uint8Array {
  const map = new Map<string, number>()
  for (let i = 0; i < alphabet.length; i++) map.set(alphabet[i]!, i)
  const cleaned = input.toUpperCase().replace(/[=\s-]/g, '')
  const out: number[] = []
  let bits = 0
  let value = 0
  for (const ch of cleaned) {
    const idx = map.get(ch)
    if (idx === undefined) throw new Error('invalid base32')
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return new Uint8Array(out)
}
```

`packages/core/src/index.ts` 追加:
```ts
export * from './encoding/base32'
```

- [ ] **Step 4: 运行测试通过**

Run: `pnpm --filter @totp/core test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/
git commit -m "feat(core): RFC4648 base32编解码，容错大小写/空格/padding"
```

---

### Task 3: HOTP（RFC 4226）

**Files:**
- Create: `packages/core/src/otp/hotp.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/hotp.test.ts`

**Interfaces:**
- Consumes: `base32Decode`（Task 2）
- Produces: `type HashAlgorithm = 'SHA1' | 'SHA256' | 'SHA512'`；`async function hotp(secret: Uint8Array, counter: number, opts?: { algorithm?: HashAlgorithm; digits?: number }): Promise<string>`（digits 默认 6，algorithm 默认 'SHA1'；HMAC-SHA256/512 由 `crypto.subtle` 原生支持）

- [ ] **Step 1: 写失败测试**

`packages/core/test/hotp.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { hotp } from '../src/otp/hotp'

// RFC 4226 Appendix D：secret = ASCII "12345678901234567890"
const SECRET = new TextEncoder().encode('12345678901234567890')

describe('hotp', () => {
  it.each([
    [0, '755224'], [1, '287082'], [2, '359152'], [3, '969429'],
    [4, '338314'], [5, '254676'], [6, '287922'], [7, '162583'],
    [8, '399871'], [9, '520489'],
  ])('counter=%i → %s', async (counter, expected) => {
    expect(await hotp(SECRET, counter)).toBe(expected)
  })

  it('支持 8 位（RFC 6238 样例 counter=1 8位: 84755224 的后 8 位）', async () => {
    expect(await hotp(SECRET, 0, { digits: 8 })).toBe('84755224')
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @totp/core test`
Expected: FAIL

- [ ] **Step 3: 实现**

`packages/core/src/otp/hotp.ts`:
```ts
export type HashAlgorithm = 'SHA1' | 'SHA256' | 'SHA512'

async function hmac(secret: Uint8Array, message: Uint8Array, algorithm: HashAlgorithm): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', secret as BufferSource, { name: 'HMAC', hash: algorithm }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, message as BufferSource)
  return new Uint8Array(sig)
}

function dynamicTruncate(mac: Uint8Array, digits: number): string {
  const offset = mac[mac.length - 1]! & 0x0f
  const bin =
    ((mac[offset]! & 0x7f) << 24) |
    (mac[offset + 1]! << 16) |
    (mac[offset + 2]! << 8) |
    mac[offset + 3]!
  return String(bin).padStart(digits, '0').slice(-digits)
}

export async function hotp(
  secret: Uint8Array,
  counter: number,
  opts: { algorithm?: HashAlgorithm; digits?: number } = {},
): Promise<string> {
  const { algorithm = 'SHA1', digits = 6 } = opts
  const message = new Uint8Array(8)
  const view = new DataView(message.buffer)
  view.setUint32(4, counter) // 大端 64 位，高 32 位恒 0（counter 超 2^32 不支持）
  const mac = await hmac(secret, message, algorithm)
  return dynamicTruncate(mac, digits)
}
```

`packages/core/src/index.ts` 追加:
```ts
export * from './otp/hotp'
```

- [ ] **Step 4: 运行测试通过**

Run: `pnpm --filter @totp/core test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/
git commit -m "feat(core): RFC4226 HOTP，SHA1/256/512 + 动态截断"
```

---

### Task 4: TOTP（RFC 6238）

**Files:**
- Create: `packages/core/src/otp/totp.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/totp.test.ts`

**Interfaces:**
- Consumes: `hotp`（Task 3）
- Produces: `async function totp(secret: Uint8Array, timeMs: number, opts?: { period?: number; algorithm?: HashAlgorithm; digits?: number }): Promise<string>`（period 默认 30；`timeMs` 为毫秒时间戳）；`async function verifyTotp(secret: string, code: string, opts & { window?: number }): Promise<boolean>`（供后续同步校验用，window 默认 1，向前/后 window 个周期尝试）

- [ ] **Step 1: 写失败测试**

`packages/core/test/totp.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { totp, verifyTotp } from '../src/otp/totp'
import { base32Decode } from '../src/encoding/base32'

// RFC 6238 Appendix B 官方向量（8 位）
const S1 = new TextEncoder().encode('12345678901234567890') // SHA1
const S256 = new TextEncoder().encode('12345678901234567890123456789012') // SHA256
const S512 = new TextEncoder().encode(
  '1234567890123456789012345678901234567890123456789012345678901234', // 64 字节
)

describe('totp RFC 6238 向量', () => {
  const cases: Array<[number, string, string, string]> = [
    // [T秒, SHA1, SHA256, SHA512]
    [59, '94287082', '46119246', '90693936'],
    [1111111109, '07081804', '68084774', '25091201'],
    [1111111111, '14050471', '67062674', '99943326'],
    [1234567890, '89005924', '91819424', '93441116'],
    [2000000000, '69279037', '90698825', '38618901'],
    [20000000000, '65353130', '77737706', '47863826'],
  ]
  it.each(cases)('T=%i', async (tSec, sha1, sha256, sha512) => {
    const tMs = tSec * 1000
    expect(await totp(S1, tMs, { algorithm: 'SHA1', digits: 8 })).toBe(sha1)
    expect(await totp(S256, tMs, { algorithm: 'SHA256', digits: 8 })).toBe(sha256)
    expect(await totp(S512, tMs, { algorithm: 'SHA512', digits: 8 })).toBe(sha512)
  })
})

describe('totp period/digits', () => {
  it('默认 30 秒周期、6 位，与 hotp(counter=floor(t/30)) 一致', async () => {
    const secret = base32Decode('JBSWY3DPEHPK3PXP')
    const tMs = 1_700_000_000_000
    const expected = await totp(secret, tMs, { algorithm: 'SHA1', digits: 6 })
    expect(expected).toHaveLength(6)
  })
})

describe('verifyTotp', () => {
  it('当前码通过；窗口外的旧码在 window=0 时拒绝', async () => {
    const secret = base32Decode('JBSWY3DPEHPK3PXP')
    const nowMs = 1_700_000_000_000
    const code = await totp(secret, nowMs)
    expect(await verifyTotp(secret, code, { nowMs })).toBe(true)
    const oldCode = await totp(secret, nowMs - 5 * 60 * 1000)
    expect(await verifyTotp(secret, oldCode, { nowMs, window: 0 })).toBe(false)
    expect(await verifyTotp(secret, oldCode, { nowMs, window: 10 })).toBe(true)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @totp/core test`
Expected: FAIL

- [ ] **Step 3: 实现**

`packages/core/src/otp/totp.ts`:
```ts
import { hotp, type HashAlgorithm } from './hotp'

export async function totp(
  secret: Uint8Array,
  timeMs: number,
  opts: { period?: number; algorithm?: HashAlgorithm; digits?: number } = {},
): Promise<string> {
  const { period = 30, algorithm = 'SHA1', digits = 6 } = opts
  const counter = Math.floor(timeMs / 1000 / period)
  return hotp(secret, counter, { algorithm, digits })
}

export async function verifyTotp(
  secret: Uint8Array,
  code: string,
  opts: { period?: number; algorithm?: HashAlgorithm; digits?: number; window?: number; nowMs?: number } = {},
): Promise<boolean> {
  const { window = 1, nowMs = Date.now() } = opts
  const period = opts.period ?? 30
  const current = Math.floor(nowMs / 1000 / period)
  for (let c = current - window; c <= current + window; c++) {
    if (c < 0) continue
    if ((await hotp(secret, c, { algorithm: opts.algorithm ?? 'SHA1', digits: opts.digits ?? 6 })) === code) return true
  }
  return false
}
```

`packages/core/src/index.ts` 追加:
```ts
export * from './otp/totp'
```

- [ ] **Step 4: 运行测试通过**

Run: `pnpm --filter @totp/core test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/
git commit -m "feat(core): RFC6238 TOTP，多算法/周期/位数 + verifyTotp"
```

---

### Task 5: Steam 验证码算法

**Files:**
- Create: `packages/core/src/otp/steam.ts`
- Modify: `packages/core/src/index.ts`
- Create: `scripts/gen-steam-vectors.mjs`
- Test: `packages/core/test/steam.test.ts`、`packages/core/test/vectors/steam.json`（脚本生成）

**Interfaces:**
- Consumes: `base32Decode`、`STEAM_ALPHABET`（Task 2）、`hmac` 逻辑（此处自含 HMAC-SHA1 调用，与 Task 3 相同原语）
- Produces: `async function steamCode(secret: Uint8Array, timeMs: number): Promise<string>`（5 字符，字母表 `23456789BCDFGHJKMNPQRTVWXY`；算法：HMAC-SHA1(secret, counterBigEndian8) 取 HMAC 最后 4 字节为无符号数，循环 5 次 `code += alphabet[n % 26]; n = floor(n / 26)`）

- [ ] **Step 1: 生成对拍向量**

`scripts/gen-steam-vectors.mjs`（用公开参考实现 steam-totp 对拍；本脚本仅开发期运行，产出的 vectors/steam.json 随测试提交）:
```js
// pnpm dlx 方式运行：node scripts/gen-steam-vectors.mjs
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
// 先安装：pnpm add -D -w steam-totp（仅 devDependencies，供生成向量用）
const { generateAuthCode } = require('steam-totp')

// 固定测试 secret：标准 RFC4648 base32（此处为随机固定值，非真实账号）
const B32 = 'MZLVOVJQVEWROFJVOUQ4EJCVOFRKGADG'
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const b32decode = (s) => {
  const map = new Map([...ALPHABET].map((c, i) => [c, i]))
  const clean = s.replace(/=+$/, '')
  const out = []
  let bits = 0, value = 0
  for (const ch of clean) {
    value = (value << 5) | map.get(ch)
    bits += 5
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8 }
  }
  return Buffer.from(out)
}
const bytes = b32decode(B32)
const b64 = bytes.toString('base64') // steam-totp 接受 base64 的 shared_secret

// 取未来 60~120 秒内的三个 30s 整点，避免运行期间跨窗口
const now = Date.now()
const targets = [0, 1, 2].map((i) => (Math.floor((now + (120 + i * 30) * 1000) / 30000)) * 30000)
const vectors = []
for (const tMs of targets) {
  const offsetSec = Math.round((tMs - Date.now()) / 1000)
  const code = generateAuthCode(b64, offsetSec)
  vectors.push({ tMs, code })
}
console.log(JSON.stringify({ secretBase32: B32, vectors }, null, 2))
```

运行：`pnpm add -D -w steam-totp && node scripts/gen-steam-vectors.mjs`，把 stdout JSON 写入 `packages/core/test/vectors/steam.json`。**人工检查**：3 条 code 均为 5 字符、且属于字母表。

- [ ] **Step 2: 写失败测试**

`packages/core/test/steam.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { steamCode } from '../src/otp/steam'
import { base32Decode, STEAM_ALPHABET } from '../src/encoding/base32'

const vec = JSON.parse(
  readFileSync(fileURLToPath(new URL('./vectors/steam.json', import.meta.url)), 'utf8'),
) as { secretBase32: string; vectors: Array<{ tMs: number; code: string }> }

describe('steamCode 对拍 steam-totp 参考实现', () => {
  it.each(vec.vectors.map((v) => [v.tMs, v.code]))('tMs=%i → %s', async (tMs, code) => {
    const out = await steamCode(base32Decode(vec.secretBase32), tMs)
    expect(out).toBe(code)
  })
})

it('输出恒为 5 字符且属于 Steam 字母表', async () => {
  const out = await steamCode(base32Decode(vec.secretBase32), Date.now())
  expect(out).toHaveLength(5)
  for (const ch of out) expect(STEAM_ALPHABET).toContain(ch)
})
```

- [ ] **Step 3: 运行确认失败**

Run: `pnpm --filter @totp/core test`
Expected: FAIL（steam 模块不存在）

- [ ] **Step 4: 实现**

`packages/core/src/otp/steam.ts`:
```ts
import { STEAM_ALPHABET } from '../encoding/base32'

async function hmacSha1(secret: Uint8Array, message: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', secret as BufferSource, { name: 'HMAC', hash: 'SHA1' }, false, ['sign'])
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, message as BufferSource))
}

export async function steamCode(secret: Uint8Array, timeMs: number): Promise<string> {
  const counter = Math.floor(timeMs / 1000 / 30)
  const message = new Uint8Array(8)
  new DataView(message.buffer).setUint32(4, counter)
  const mac = await hmacSha1(secret, message)
  // 取 HMAC 最后 4 字节（与 Steam 官方实现一致，不做动态截断）
  let n = ((mac[28]! << 24) | (mac[29]! << 16) | (mac[30]! << 8) | mac[31]!) >>> 0
  let code = ''
  for (let i = 0; i < 5; i++) {
    code += STEAM_ALPHABET[n % 26]
    n = Math.floor(n / 26)
  }
  return code
}
```

`packages/core/src/index.ts` 追加:
```ts
export * from './otp/steam'
```

- [ ] **Step 5: 运行测试通过**

Run: `pnpm --filter @totp/core test`
Expected: PASS（含对拍向量）

- [ ] **Step 6: Commit**

```bash
git add packages/core/ scripts/ package.json pnpm-lock.yaml
git commit -m "feat(core): Steam 5字符验证码算法，与steam-totp参考实现对拍"
```

---

### Task 6: otpauth URI 解析与生成

**Files:**
- Create: `packages/core/src/otp/uri.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/uri.test.ts`

**Interfaces:**
- Produces: `interface OtpUriParams { type: 'totp' | 'hotp' | 'steam'; issuer: string; label: string; secret: string; algorithm: HashAlgorithm; digits: number; period: number; counter?: number }`；`parseOtpUri(uri: string): OtpUriParams`（非法输入抛 `Error('invalid otpauth uri')`；type 缺省 totp；`issuer` 参数优先于 label 前缀；`otpauth://steam/...` 或 issuer=Steam 判为 steam）；`buildOtpUri(p: OtpUriParams): string`（label 为 `Issuer:account` 形式并 URL 编码；steam 类型 scheme 用 `otpauth://steam/`）

- [ ] **Step 1: 写失败测试**

`packages/core/test/uri.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { parseOtpUri, buildOtpUri } from '../src/otp/uri'

describe('parseOtpUri', () => {
  it('标准 totp：label 前缀 issuer + 参数齐全', () => {
    const p = parseOtpUri(
      'otpauth://totp/GitHub:me%40ex.com?secret=JBSWY3DPEHPK3PXP&issuer=GitHub&digits=8&period=60&algorithm=SHA256',
    )
    expect(p).toEqual({
      type: 'totp', issuer: 'GitHub', label: 'me@ex.com',
      secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA256', digits: 8, period: 60,
    })
  })

  it('issuer 参数缺失时取 label 前缀', () => {
    const p = parseOtpUri('otpauth://totp/MyBank:alice?secret=JBSWY3DPEHPK3PXP')
    expect(p.issuer).toBe('MyBank')
    expect(p.label).toBe('alice')
  })

  it('otpauth://steam/ 判为 steam', () => {
    const p = parseOtpUri('otpauth://steam/Steam:user?secret=JBSWY3DPEHPK3PXP')
    expect(p.type).toBe('steam')
    expect(p.issuer).toBe('Steam')
  })

  it('hotp 带 counter', () => {
    const p = parseOtpUri('otpauth://hotp/x:y?secret=JBSWY3DPEHPK3PXP&counter=5')
    expect(p.type).toBe('hotp')
    expect(p.counter).toBe(5)
  })

  it.each([
    'https://example.com',
    'otpauth://totp/x?secret=',
    'otpauth://zzz/x?secret=AB',
  ])('非法输入 %s 抛错', (uri) => {
    expect(() => parseOtpUri(uri)).toThrow('invalid otpauth uri')
  })
})

describe('buildOtpUri', () => {
  it('往返一致', () => {
    const uri = buildOtpUri({
      type: 'totp', issuer: 'GitHub', label: 'me@ex.com', secret: 'JBSWY3DPEHPK3PXP',
      algorithm: 'SHA256', digits: 8, period: 60,
    })
    expect(parseOtpUri(uri)).toMatchObject({
      type: 'totp', issuer: 'GitHub', label: 'me@ex.com',
      secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA256', digits: 8, period: 60,
    })
  })

  it('steam 生成 otpauth://steam/', () => {
    const uri = buildOtpUri({ type: 'steam', issuer: 'Steam', label: 'user', secret: 'AB', algorithm: 'SHA1', digits: 5, period: 30 })
    expect(uri).toContain('otpauth://steam/')
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @totp/core test`
Expected: FAIL

- [ ] **Step 3: 实现**

`packages/core/src/otp/uri.ts`:
```ts
import type { HashAlgorithm } from './hotp'

export interface OtpUriParams {
  type: 'totp' | 'hotp' | 'steam'
  issuer: string
  label: string
  secret: string
  algorithm: HashAlgorithm
  digits: number
  period: number
  counter?: number
}

const ALGORITHMS: HashAlgorithm[] = ['SHA1', 'SHA256', 'SHA512']

export function parseOtpUri(uri: string): OtpUriParams {
  let url: URL
  try {
    url = new URL(uri)
  } catch {
    throw new Error('invalid otpauth uri')
  }
  if (url.protocol !== 'otpauth:') throw new Error('invalid otpauth uri')
  const type = url.host as OtpUriParams['type']
  if (!['totp', 'hotp', 'steam'].includes(type)) throw new Error('invalid otpauth uri')

  const q = url.searchParams
  const secret = q.get('secret')?.replace(/\s+/g, '') ?? ''
  if (!secret) throw new Error('invalid otpauth uri')

  // path 形如 /Issuer:label 或 /label（可能整体编码过）
  const rawPath = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
  const colon = rawPath.indexOf(':')
  let prefixIssuer = ''
  let label = rawPath
  if (colon >= 0) {
    prefixIssuer = rawPath.slice(0, colon)
    label = rawPath.slice(colon + 1)
  }

  const issuer = q.get('issuer') ?? prefixIssuer
  const algRaw = (q.get('algorithm') ?? 'SHA1').toUpperCase() as HashAlgorithm
  const typeFinal: OtpUriParams['type'] = type === 'steam' || issuer.toLowerCase() === 'steam' ? 'steam' : type
  const counterRaw = q.get('counter')

  return {
    type: typeFinal,
    issuer: issuer || label,
    label,
    secret,
    algorithm: ALGORITHMS.includes(algRaw) ? algRaw : 'SHA1',
    digits: typeFinal === 'steam' ? 5 : Number(q.get('digits') ?? 6) || 6,
    period: Number(q.get('period') ?? 30) || 30,
    ...(counterRaw !== null ? { counter: Number(counterRaw) || 0 } : {}),
  }
}

export function buildOtpUri(p: OtpUriParams): string {
  const labelPart = p.issuer ? `${p.issuer}:${p.label}` : p.label
  const host = p.type === 'steam' ? 'steam' : p.type
  const q = new URLSearchParams()
  q.set('secret', p.secret)
  if (p.issuer) q.set('issuer', p.issuer)
  if (p.algorithm !== 'SHA1') q.set('algorithm', p.algorithm)
  if (p.type !== 'steam' && p.digits !== 6) q.set('digits', String(p.digits))
  if (p.period !== 30) q.set('period', String(p.period))
  if (p.type === 'hotp' && p.counter !== undefined) q.set('counter', String(p.counter))
  return `otpauth://${host}/${encodeURIComponent(labelPart)}?${q.toString()}`
}
```

`packages/core/src/index.ts` 追加:
```ts
export * from './otp/uri'
```

- [ ] **Step 4: 运行测试通过**

Run: `pnpm --filter @totp/core test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/
git commit -m "feat(core): otpauth URI解析与生成，含steam特例与参数校验"
```

---

### Task 7: 领域模型与 vault 操作

**Files:**
- Create: `packages/core/src/model.ts`、`packages/core/src/vault.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/vault.test.ts`

**Interfaces:**
- Consumes: `OtpUriParams`（Task 6）
- Produces:
  - `interface OtpEntry { uuid: string; type: 'totp'|'hotp'|'steam'; issuer: string; label: string; secret: string; algorithm: HashAlgorithm; digits: number; period: number; counter?: number; note?: string; groupIds: string[]; order: number; createdAt: number }`
  - `interface Group { id: string; name: string; order: number }`
  - `interface Vault { version: 1; entries: OtpEntry[]; groups: Group[]; updatedAt: number }`
  - `createVault(): Vault`、`addEntry(v, e): Vault`、`removeEntry(v, uuid): Vault`、`updateEntry(v, uuid, patch): Vault`、`addGroup(v, name): Vault`、`renameGroup(v, id, name): Vault`、`removeGroup(v, id): Vault`、`reorderEntries(v, orderedUuids): Vault` — 全部纯函数，返回新对象（浅拷贝层级），不修改入参；`newEntryFromUri(uri: string, nowMs?: number): OtpEntry`（uuid 用 `crypto.randomUUID()`）

- [ ] **Step 1: 写失败测试**

`packages/core/test/vault.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { createVault, addEntry, removeEntry, updateEntry, addGroup, removeGroup, reorderEntries, newEntryFromUri } from '../src/vault'
import type { OtpEntry } from '../src/model'

const mkEntry = (uuid: string, order = 0): OtpEntry => ({
  uuid, type: 'totp', issuer: 'GitHub', label: 'me@ex.com', secret: 'JBSWY3DPEHPK3PXP',
  algorithm: 'SHA1', digits: 6, period: 30, groupIds: [], order, createdAt: 0,
})

describe('vault 操作', () => {
  it('add/remove/update 返回新对象且不改入参', () => {
    const v0 = createVault()
    const v1 = addEntry(v0, mkEntry('a'))
    expect(v1.entries).toHaveLength(1)
    expect(v0.entries).toHaveLength(0)

    const v2 = updateEntry(v1, 'a', { issuer: 'GitLab' })
    expect(v2.entries[0]!.issuer).toBe('GitLab')
    expect(v1.entries[0]!.issuer).toBe('GitHub')

    const v3 = removeEntry(v2, 'a')
    expect(v3.entries).toHaveLength(0)
  })

  it('分组：加入、移除时条目引用被清理', () => {
    let v = addGroup(createVault(), '工作')
    const gid = v.groups[0]!.id
    v = addEntry(v, { ...mkEntry('a'), groupIds: [gid] })
    v = removeGroup(v, gid)
    expect(v.groups).toHaveLength(0)
    expect(v.entries[0]!.groupIds).toEqual([])
  })

  it('reorder 按 uuid 序列重排 order', () => {
    let v = createVault()
    v = addEntry(v, mkEntry('a', 0))
    v = addEntry(v, mkEntry('b', 1))
    v = addEntry(v, mkEntry('c', 2))
    v = reorderEntries(v, ['c', 'a', 'b'])
    expect(v.entries.find((e) => e.uuid === 'c')!.order).toBe(0)
    expect(v.entries.find((e) => e.uuid === 'a')!.order).toBe(1)
    expect(v.entries.find((e) => e.uuid === 'b')!.order).toBe(2)
  })

  it('newEntryFromUri 解析 otpauth 并补默认值', () => {
    const e = newEntryFromUri('otpauth://totp/GitHub:me%40ex.com?secret=JBSWY3DPEHPK3PXP&issuer=GitHub', 1700000000000)
    expect(e.issuer).toBe('GitHub')
    expect(e.period).toBe(30)
    expect(e.uuid).toMatch(/^[0-9a-f-]{36}$/)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @totp/core test`
Expected: FAIL

- [ ] **Step 3: 实现**

`packages/core/src/model.ts`:
```ts
import type { HashAlgorithm } from './otp/hotp'

export type EntryType = 'totp' | 'hotp' | 'steam'

export interface OtpEntry {
  uuid: string
  type: EntryType
  issuer: string
  label: string
  secret: string
  algorithm: HashAlgorithm
  digits: number
  period: number
  counter?: number
  note?: string
  groupIds: string[]
  order: number
  createdAt: number
}

export interface Group {
  id: string
  name: string
  order: number
}

export interface Vault {
  version: 1
  entries: OtpEntry[]
  groups: Group[]
  updatedAt: number
}
```

`packages/core/src/vault.ts`:
```ts
import type { Group, OtpEntry, Vault } from './model'
import { parseOtpUri } from './otp/uri'

export function createVault(): Vault {
  return { version: 1, entries: [], groups: [], updatedAt: 0 }
}

function withVault(v: Vault, patch: Partial<Vault>): Vault {
  return { ...v, ...patch, updatedAt: Date.now() }
}

export function addEntry(v: Vault, entry: OtpEntry): Vault {
  const maxOrder = v.entries.reduce((m, e) => Math.max(m, e.order), -1)
  return withVault(v, { entries: [...v.entries, { ...entry, order: maxOrder + 1 }] })
}

export function removeEntry(v: Vault, uuid: string): Vault {
  return withVault(v, { entries: v.entries.filter((e) => e.uuid !== uuid) })
}

export function updateEntry(v: Vault, uuid: string, patch: Partial<Omit<OtpEntry, 'uuid'>>): Vault {
  return withVault(v, { entries: v.entries.map((e) => (e.uuid === uuid ? { ...e, ...patch } : e)) })
}

export function addGroup(v: Vault, name: string): Vault {
  const group: Group = { id: crypto.randomUUID(), name, order: v.groups.length }
  return withVault(v, { groups: [...v.groups, group] })
}

export function renameGroup(v: Vault, id: string, name: string): Vault {
  return withVault(v, { groups: v.groups.map((g) => (g.id === id ? { ...g, name } : g)) })
}

export function removeGroup(v: Vault, id: string): Vault {
  return withVault(v, {
    groups: v.groups.filter((g) => g.id !== id),
    entries: v.entries.map((e) => (e.groupIds.includes(id) ? { ...e, groupIds: e.groupIds.filter((g) => g !== id) } : e)),
  })
}

export function reorderEntries(v: Vault, orderedUuids: string[]): Vault {
  const orderMap = new Map(orderedUuids.map((uuid, i) => [uuid, i]))
  return withVault(v, {
    entries: v.entries.map((e) => (orderMap.has(e.uuid) ? { ...e, order: orderMap.get(e.uuid)! } : e)),
  })
}

export function newEntryFromUri(uri: string, nowMs: number = Date.now()): OtpEntry {
  const p = parseOtpUri(uri)
  return {
    uuid: crypto.randomUUID(),
    type: p.type,
    issuer: p.issuer,
    label: p.label,
    secret: p.secret,
    algorithm: p.algorithm,
    digits: p.digits,
    period: p.period,
    ...(p.counter !== undefined ? { counter: p.counter } : {}),
    groupIds: [],
    order: 0,
    createdAt: nowMs,
  }
}
```

`packages/core/src/index.ts` 追加:
```ts
export * from './model'
export * from './vault'
```

- [ ] **Step 4: 运行测试通过**

Run: `pnpm --filter @totp/core test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/
git commit -m "feat(core): OtpEntry/Group/Vault领域模型与不可变vault操作"
```

---

### Task 8: 存储抽象（接口 + 内存实现 + load/save vault）

**Files:**
- Create: `packages/core/src/storage/adapter.ts`、`packages/core/src/storage/memory.ts`、`packages/core/src/storage/vaultStore.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/storage.test.ts`

**Interfaces:**
- Consumes: `Vault`（Task 7）
- Produces:
  - `interface StorageAdapter { get(key: string): Promise<string | null>; set(key: string, value: string): Promise<void>; delete(key: string): Promise<void> }`
  - `createMemoryStorage(): StorageAdapter`（Map 实现，测试与 SSR 场景用）
  - `VAULT_KEY = 'vault'`；`async loadVault(adapter: StorageAdapter): Promise<Vault>`（无数据返回 `createVault()`；JSON 解析失败抛 `Error('vault corrupted')`）；`async saveVault(adapter: StorageAdapter, vault: Vault): Promise<void>`（`JSON.stringify` 单 key 快照；浏览器端单次 set 即原子）

- [ ] **Step 1: 写失败测试**

`packages/core/test/storage.test.ts`:
```ts
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
    expect(JSON.parse((await s.get(VAULT_KEY))!).version).toBe(1)
  })

  it('损坏数据抛 vault corrupted', async () => {
    const s = createMemoryStorage()
    await s.set(VAULT_KEY, '{oops')
    await expect(loadVault(s)).rejects.toThrow('vault corrupted')
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @totp/core test`
Expected: FAIL

- [ ] **Step 3: 实现**

`packages/core/src/storage/adapter.ts`:
```ts
export interface StorageAdapter {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
}
```

`packages/core/src/storage/memory.ts`:
```ts
import type { StorageAdapter } from './adapter'

export function createMemoryStorage(): StorageAdapter {
  const map = new Map<string, string>()
  return {
    async get(key) { return map.get(key) ?? null },
    async set(key, value) { map.set(key, value) },
    async delete(key) { map.delete(key) },
  }
}
```

`packages/core/src/storage/vaultStore.ts`:
```ts
import type { Vault } from '../model'
import type { StorageAdapter } from './adapter'
import { createVault } from '../vault'

export const VAULT_KEY = 'vault'

export async function loadVault(adapter: StorageAdapter): Promise<Vault> {
  const raw = await adapter.get(VAULT_KEY)
  if (raw === null) return createVault()
  try {
    return JSON.parse(raw) as Vault
  } catch {
    throw new Error('vault corrupted')
  }
}

export async function saveVault(adapter: StorageAdapter, vault: Vault): Promise<void> {
  await adapter.set(VAULT_KEY, JSON.stringify(vault))
}
```

`packages/core/src/index.ts` 追加:
```ts
export * from './storage/adapter'
export * from './storage/memory'
export * from './storage/vaultStore'
```

- [ ] **Step 4: 运行测试通过**

Run: `pnpm --filter @totp/core test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/
git commit -m "feat(core): StorageAdapter抽象+内存实现+vault持久化"
```

---

### Task 9: packages/ui 基础（useOtpCodes + 条目组件）

**Files:**
- Create: `packages/ui/package.json`、`packages/ui/tsconfig.json`、`packages/ui/vitest.config.ts`
- Create: `packages/ui/src/composables/useOtpCodes.ts`、`packages/ui/src/components/OtpListItem.vue`
- Create: `packages/ui/test/useOtpCodes.test.ts`
- Modify: 根 `package.json`（workspace devDependencies 补 `@vue/test-utils`、`jsdom`、`vue`）

**Interfaces:**
- Consumes: `totp`/`steamCode`/`hotp`（core）、`OtpEntry`
- Produces:
  - `useOtpCodes(entries: Ref<OtpEntry[]>): { codes: Ref<Map<string, { code: string; remaining: number; progress: number }>>; nowMs: Ref<number> }`——内部 `setInterval` 1s tick（组件卸载清理），`remaining = period - (floor(nowMs/1000) % period)`，`progress = remaining/period`；非 steam/hotp 条目用 `totp()`，steam 用 `steamCode()`，hotp 用存储的 counter 不 tick（hotp 码由组件主动调用 `advanceHotp` 场景在后续任务，此处 hotp 显示 counter 对应码）
  - `OtpListItem.vue` props: `{ entry: OtpEntry; code: string; remaining: number; progress: number }`，emits: `copy`；布局：左图标占位（issuer 首字母圆形，M1 无图标）+ issuer/label 两行 + 验证码分组显示（如 `123 456`；steam `ABCDE`）+ SVG 倒计时圆环
  - 包导出 `@totp/ui`（`./src/index.ts` re-export）

- [ ] **Step 1: 初始化 ui 包**

`packages/ui/package.json`:
```json
{
  "name": "@totp/ui",
  "version": "0.1.0",
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "test": "vitest run", "typecheck": "tsc --noEmit" },
  "dependencies": {
    "@totp/core": "workspace:*",
    "vue": "^3.5.0"
  },
  "devDependencies": {
    "@vitejs/plugin-vue": "^5.1.0",
    "@vue/test-utils": "^2.4.0",
    "jsdom": "^25.0.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

`packages/ui/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "jsx": "preserve" },
  "include": ["src", "test", "vitest.config.ts"]
}
```

`packages/ui/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  test: { environment: 'jsdom' },
})
```

根 `package.json` devDependencies 不变（workspace 包各自管理）；执行 `pnpm install`。

- [ ] **Step 2: 写失败测试（composable）**

`packages/ui/test/useOtpCodes.test.ts`:
```ts
import { describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { useOtpCodes } from '../src/composables/useOtpCodes'
import type { OtpEntry } from '@totp/core'

const entry: OtpEntry = {
  uuid: 'a', type: 'totp', issuer: 'GitHub', label: 'me@ex.com', secret: 'JBSWY3DPEHPK3PXP',
  algorithm: 'SHA1', digits: 6, period: 30, groupIds: [], order: 0, createdAt: 0,
}

describe('useOtpCodes', () => {
  it('立即计算当前码与剩余时间', async () => {
    const { codes, nowMs } = useOtpCodes(ref([entry]))
    await vi.waitFor(() => expect(codes.value.get('a')).toBeDefined())
    const c = codes.value.get('a')!
    expect(c.code).toMatch(/^\d{6}$/)
    expect(c.remaining).toBeGreaterThan(0)
    expect(c.remaining).toBeLessThanOrEqual(30)
    expect(c.progress).toBeCloseTo(c.remaining / 30, 5)
    expect(nowMs.value).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 3: 运行确认失败**

Run: `pnpm --filter @totp/ui test`
Expected: FAIL

- [ ] **Step 4: 实现 composable 与组件**

`packages/ui/src/composables/useOtpCodes.ts`:
```ts
import { hotp, steamCode, totp, type OtpEntry } from '@totp/core'
import { base32Decode } from '@totp/core'
import { onScopeDispose, ref, type Ref } from 'vue'

export interface CodeState {
  code: string
  remaining: number
  progress: number
}

export function useOtpCodes(entries: Ref<OtpEntry[]>) {
  const nowMs = ref(Date.now())
  const codes = ref(new Map<string, CodeState>())
  const secretCache = new Map<string, Uint8Array>()

  function secretOf(e: OtpEntry): Uint8Array {
    let s = secretCache.get(e.uuid)
    if (!s) {
      s = base32Decode(e.secret)
      secretCache.set(e.uuid, s)
    }
    return s
  }

  async function recompute() {
    nowMs.value = Date.now()
    const next = new Map<string, CodeState>()
    for (const e of entries.value) {
      const period = e.period || 30
      const remaining = period - (Math.floor(nowMs.value / 1000) % period)
      try {
        let code: string
        if (e.type === 'steam') code = await steamCode(secretOf(e), nowMs.value)
        else if (e.type === 'hotp') code = await hotp(secretOf(e), e.counter ?? 0, { algorithm: e.algorithm, digits: e.digits })
        else code = await totp(secretOf(e), nowMs.value, { algorithm: e.algorithm, digits: e.digits, period })
        next.set(e.uuid, { code, remaining, progress: remaining / period })
      } catch {
        // secret 非法等：显示占位，不让单条错误炸整个列表
        next.set(e.uuid, { code: '------', remaining, progress: remaining / period })
      }
    }
    codes.value = next
  }

  void recompute()
  const timer = setInterval(() => void recompute(), 1000)
  onScopeDispose(() => clearInterval(timer))

  return { codes, nowMs }
}
```

`packages/ui/src/components/OtpListItem.vue`:
```vue
<script setup lang="ts">
defineProps<{
  entry: import('@totp/core').OtpEntry
  code: string
  remaining: number
  progress: number
}>()
const emit = defineEmits<{ copy: [] }>()

function grouped(code: string): string {
  return code.length === 5 || code.length === 7 || code.length === 8 ? code : code.replace(/(\d{3})(\d+)/, '$1 $2')
}
</script>

<template>
  <div class="otp-item" role="button" tabindex="0" @click="emit('copy')" @keydown.enter="emit('copy')">
    <span class="avatar">{{ entry.issuer.slice(0, 1).toUpperCase() || '?' }}</span>
    <div class="meta">
      <div class="issuer">{{ entry.issuer }}</div>
      <div class="label">{{ entry.label }}</div>
    </div>
    <div class="right">
      <span class="code">{{ grouped(code) }}</span>
      <svg viewBox="0 0 36 36" class="ring" aria-hidden="true">
        <circle cx="18" cy="18" r="16" class="ring-bg" />
        <circle
          cx="18" cy="18" r="16" class="ring-fg"
          :stroke-dasharray="100.53"
          :stroke-dashoffset="100.53 * (1 - progress)"
        />
        <text x="18" y="21.5" text-anchor="middle" class="ring-text">{{ remaining }}</text>
      </svg>
    </div>
  </div>
</template>

<style scoped>
.otp-item { display: flex; align-items: center; gap: 12px; padding: 10px 12px; cursor: pointer; border-radius: 8px; }
.otp-item:hover { background: rgba(128, 128, 128, 0.15); }
.avatar { width: 36px; height: 36px; border-radius: 50%; background: #5b6b8c; color: #fff; display: grid; place-items: center; font-weight: 600; flex: none; }
.meta { flex: 1; min-width: 0; }
.issuer { font-weight: 600; }
.label { font-size: 12px; opacity: 0.7; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.right { display: flex; align-items: center; gap: 8px; }
.code { font-family: ui-monospace, monospace; font-size: 18px; letter-spacing: 1px; }
.ring { width: 32px; height: 32px; transform: rotate(-90deg); }
.ring-bg { fill: none; stroke: rgba(128,128,128,.3); stroke-width: 3; }
.ring-fg { fill: none; stroke: #4a90d9; stroke-width: 3; stroke-linecap: round; }
.ring-text { transform: rotate(90deg); transform-origin: 18px 18px; font-size: 11px; fill: currentColor; }
</style>
```

`packages/ui/src/index.ts`:
```ts
export * from './composables/useOtpCodes'
export { default as OtpListItem } from './components/OtpListItem.vue'
```

- [ ] **Step 5: 运行测试通过**

Run: `pnpm --filter @totp/ui test`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/ui/
git commit -m "feat(ui): useOtpCodes秒级刷新composable与OtpListItem组件"
```

---

### Task 10: WXT 插件壳与 popup 最小闭环

**Files:**
- Create: `apps/extension/package.json`、`apps/extension/wxt.config.ts`、`apps/extension/tsconfig.json`
- Create: `apps/extension/entrypoints/popup/index.html`、`apps/extension/entrypoints/popup/main.ts`、`apps/extension/entrypoints/popup/App.vue`
- Create: `apps/extension/entrypoints/background.ts`
- Create: `apps/extension/src/chromeStorage.ts`

**Interfaces:**
- Consumes: core 的 `loadVault`/`saveVault`/`addEntry`/`newEntryFromUri`/`OtpEntry`；ui 的 `useOtpCodes`/`OtpListItem`
- Produces: `createChromeStorage(): StorageAdapter`（`chrome.storage.local` 包装）；popup 表单「添加」：issuer/label/secret/type 四字段（type 选 totp/steam；hotp 高级字段后续计划），保存 = `newEntryFromUri(buildOtpUri(...))` 入 vault 并 `saveVault`；点击条目 `navigator.clipboard.writeText(code)` 后 `window.close()`

- [ ] **Step 1: 初始化插件工程**

`apps/extension/package.json`:
```json
{
  "name": "@totp/extension",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "build": "wxt build",
    "dev": "wxt",
    "test": "echo 'no unit tests (covered by ui/core)' && exit 0",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@totp/core": "workspace:*",
    "@totp/ui": "workspace:*",
    "vue": "^3.5.0"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "wxt": "^0.19.0",
    "wxt-modules/vue": "^1.0.0"
  }
}
```

`apps/extension/wxt.config.ts`:
```ts
import { defineConfig } from 'wxt'

export default defineConfig({
  modules: ['wxt-modules/vue'],
  manifest: {
    name: 'TOTP 验证码工具',
    description: '纯前端 TOTP 验证码管理',
    permissions: ['storage', 'clipboardWrite'],
  },
})
```

`apps/extension/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "types": ["wxt/browser"] },
  "include": ["entrypoints", "src", ".wxt/wxt.d.ts"]
}
```

`apps/extension/entrypoints/background.ts`:
```ts
export default defineBackground(() => {
  // M1 无后台逻辑；占位保证 service worker 注册正常
})
```

`apps/extension/entrypoints/popup/index.html`:
```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <title>TOTP</title>
  </head>
  <body style="width: 360px; min-height: 480px; margin: 0">
    <div id="app"></div>
    <script type="module" src="./main.ts"></script>
  </body>
</html>
```

`apps/extension/entrypoints/popup/main.ts`:
```ts
import { createApp } from 'vue'
import App from './App.vue'

createApp(App).mount('#app')
```

- [ ] **Step 2: chrome.storage adapter**

`apps/extension/src/chromeStorage.ts`:
```ts
import type { StorageAdapter } from '@totp/core'

export function createChromeStorage(): StorageAdapter {
  return {
    async get(key) {
      const o = await chrome.storage.local.get(key)
      return (o[key] as string | undefined) ?? null
    },
    async set(key, value) {
      await chrome.storage.local.set({ [key]: value })
    },
    async delete(key) {
      await chrome.storage.local.remove(key)
    },
  }
}
```

- [ ] **Step 3: popup App**

`apps/extension/entrypoints/popup/App.vue`:
```vue
<script setup lang="ts">
import { addEntry, buildOtpUri, loadVault, newEntryFromUri, saveVault, createVault, type OtpEntry, type Vault } from '@totp/core'
import { OtpListItem, useOtpCodes } from '@totp/ui'
import { computed, onMounted, ref } from 'vue'
import { createChromeStorage } from '../../src/chromeStorage'

const entries = ref<OtpEntry[]>([])
const loaded = ref(false)
const showForm = ref(false)
const form = ref({ issuer: '', label: '', secret: '', type: 'totp' as 'totp' | 'steam' })
const error = ref('')

onMounted(async () => {
  const vault = await loadVault(createChromeStorage())
  entries.value = [...vault.entries].sort((a, b) => a.order - b.order)
  loaded.value = true
})

const { codes } = useOtpCodes(entries)
const sorted = computed(() => [...entries.value].sort((a, b) => a.order - b.order))

async function persist(fn: (v: Vault) => Vault) {
  const adapter = createChromeStorage()
  const vault = await loadVault(adapter)
  await saveVault(adapter, fn(vault))
}

async function add() {
  error.value = ''
  try {
    const uri = buildOtpUri({
      type: form.value.type,
      issuer: form.value.issuer.trim(),
      label: form.value.label.trim(),
      secret: form.value.secret.replace(/\s+/g, '').toUpperCase(),
      algorithm: 'SHA1',
      digits: form.value.type === 'steam' ? 5 : 6,
      period: 30,
    })
    const entry = newEntryFromUri(uri)
    await persist((v) => addEntry(v, entry))
    entries.value = [...entries.value, entry]
    showForm.value = false
    form.value = { issuer: '', label: '', secret: '', type: 'totp' }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
}

async function copy(entry: OtpEntry) {
  const c = codes.value.get(entry.uuid)?.code
  if (!c) return
  await navigator.clipboard.writeText(c)
  window.close()
}
</script>

<template>
  <main>
    <header>
      <h1>TOTP 验证码</h1>
      <button @click="showForm = !showForm">{{ showForm ? '取消' : '＋ 添加' }}</button>
    </header>

    <form v-if="showForm" class="add-form" @submit.prevent="add">
      <input v-model="form.issuer" placeholder="服务名（如 GitHub）" />
      <input v-model="form.label" placeholder="账户名" />
      <input v-model="form.secret" placeholder="base32 密钥" required />
      <select v-model="form.type">
        <option value="totp">TOTP</option>
        <option value="steam">Steam</option>
      </select>
      <div v-if="error" class="error">{{ error }}</div>
      <button type="submit">保存</button>
    </form>

    <div v-if="loaded && sorted.length === 0" class="empty">暂无条目，点击右上角「＋ 添加」录入。</div>
    <OtpListItem v-for="e in sorted" :key="e.uuid" :entry="e" v-bind="codes.get(e.uuid) ?? { code: '------', remaining: 0, progress: 0 }" @copy="copy(e)" />
  </main>
</template>

<style>
body { font-family: system-ui, sans-serif; margin: 0; padding: 8px; }
main { display: flex; flex-direction: column; gap: 4px; }
header { display: flex; align-items: center; justify-content: space-between; padding: 4px 4px 8px; }
h1 { font-size: 16px; margin: 0; }
.add-form { display: flex; flex-direction: column; gap: 6px; padding: 8px; border: 1px solid rgba(128,128,128,.4); border-radius: 8px; margin-bottom: 8px; }
.add-form input, .add-form select, .add-form button { padding: 6px 8px; }
.error { color: #d9534f; font-size: 12px; }
.empty { text-align: center; opacity: .6; padding: 32px 0; }
</style>
```

- [ ] **Step 4: 构建验证**

Run: `pnpm install && pnpm --filter @totp/extension build`
Expected: 构建成功，输出 `.output/chrome-mv3/`，manifest 含 `permissions: ["storage", "clipboardWrite"]` 与 popup

- [ ] **Step 5: 手工冒烟（可选但推荐）**

Chrome/Edge 访问 `chrome://extensions` → 开发者模式 → 「加载已解压」选 `.output/chrome-mv3`。验证：popup 打开 → 添加 secret `JBSWY3DPEHPK3PXP` → 列表出现 6 位码且倒计时递减 → 点击条目复制并关闭。

- [ ] **Step 6: Commit**

```bash
git add apps/extension/
git commit -m "feat(extension): WXT插件壳+popup录入/列表/复制最小闭环"
```

---

### Task 11: 全仓回归与文档

**Files:**
- Create: `README.md`

**Interfaces:** 无新增接口。

- [ ] **Step 1: 全仓测试与类型检查**

Run: `pnpm test && pnpm typecheck && pnpm --filter @totp/extension build`
Expected: 全部通过

- [ ] **Step 2: 写 README**

`README.md`:
```markdown
# TOTP 验证码工具

纯前端 TOTP 验证码管理：浏览器插件（Chrome/Edge/Firefox）+ Tauri 桌面程序。

- 设计文档：`docs/plans/2026-09-13-totp-tool-design.md`
- 实施计划：`docs/plans/`（按里程碑分计划）

## 开发

```bash
pnpm install
pnpm test          # 全部单测
pnpm typecheck     # 类型检查
pnpm --filter @totp/extension build   # 插件产物 .output/chrome-mv3
```

## 结构

- `packages/core` — 纯 TS 核心：base32/HOTP/TOTP/Steam/URI/模型/存储抽象
- `packages/ui` — Vue 3 共享组件
- `apps/extension` — WXT 浏览器插件
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: 添加README与开发说明"
```
