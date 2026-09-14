# TOTP 工具 计划6：安全与体验收尾（vault 落盘加密 + 解锁 + 体验项）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** vault 本体落盘加密（口令 KEK 模式，P4 密钥分层复用）+ 三端解锁流程 + 整库口令更换；完成原始需求 park 的体验项：secret 遮蔽、复制后 30s 清剪贴板（默认开）、HOTP 点击递增、popup「已复制」2s 关闭、真实应用图标。

**Architecture:** core 新增 `security/`（SecuritySettings schema + setup/unlock/re-wrap/encrypt/decrypt，全部复用 P4 crypto）；`createVueStore` 扩展 locked 状态与 unlock/lock/changePassphrase；ui 新增 LockScreen 组件，popup/options/desktop 挂载；体验项为既有组件小改 + settings 两个新开关。

**Tech Stack:** 现有栈不变（core 仅 hash-wasm）。

**Spec:** `docs/plans/2026-09-13-totp-tool-design.md`（§7 密钥分层口令模式、§12 安全、§10 popup；passkey/DPAPI 解锁属计划 11，本计划只做口令模式）

## Global Constraints

- 沿用全部既有约束（TS strict、TDD、Angular commit、中文 UI、core 运行时依赖仅 hash-wasm）
- vault 加密存储格式：`vault` 键存 `EncryptedVault { v: 1; enc: true; dataNonce: string; ciphertext: string }`（全部 base64）；`security` 键存 `SecuritySettings { v: 1; enabled: true; kdf: { alg: 'argon2id'; m: 65536; t: 3; p: 1; salt: string }; wrapNonce: string; wrappedDek: string }`；DEK 32B 随机、salt 16B、双 nonce 12B 各自独立
- 未加密的 `vault` 键内容保持现有 `Vault` JSON 形状不变（向后兼容：无 security 键 = 无加密，行为与现在完全一致）
- 锁定态语义：locked 时 `commit` 与全部写 op 抛 `Error('vault locked')`；读不到条目（空 vault 展示）；解锁后 DEK 仅存内存（模块级），页面关闭即失
- kdf 钳制沿用 P4（m>2**21/t>10/p>8 → invalid）
- settings 新增两个字段（走既有 sync/持久化）：`clipboardClearEnabled: boolean`（默认 true）、`popupCloseDelayMs: number`（默认 2000）——loadSettings typeof 校验同款收紧
- 涉及图标/manifest/wxt/tauri 配置的任务必须核对构建产物

---

### Task 1: core securityStore（TDD）

**Files:**
- Create: `packages/core/src/security/securityStore.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/security.test.ts`

**Interfaces:**
- Consumes: deriveKek/aesGcmEncrypt/aesGcmDecrypt/randomBytes/bytesToBase64/base64ToBytes（crypto/aesgcm）
- Produces:
  ```ts
  export interface SecuritySettings {
    v: 1
    enabled: true
    kdf: { alg: 'argon2id'; m: number; t: number; p: number; salt: string }
    wrapNonce: string
    wrappedDek: string
  }
  export interface EncryptedVault { v: 1; enc: true; dataNonce: string; ciphertext: string }
  export function isEncryptedVault(x: unknown): x is EncryptedVault
  export function isSecuritySettings(x: unknown): x is SecuritySettings
  export async function setupVaultEncryption(vaultJson: string, password: string, params?: { m?: number; t?: number; p?: number }): Promise<{ security: SecuritySettings; encrypted: EncryptedVault; dek: Uint8Array }>
  export async function unlockVaultEncryption(security: SecuritySettings, password: string): Promise<Uint8Array>   // 返回 DEK；口令错/参数非法→Error('口令错误或数据已损坏')；结构非法→Error('invalid security settings')
  export async function encryptVaultWithDek(dek: Uint8Array, vaultJson: string): Promise<EncryptedVault>
  export async function decryptVaultWithDek(dek: Uint8Array, enc: EncryptedVault): Promise<string>
  export async function changeVaultPassphrase(security: SecuritySettings, dek: Uint8Array, newPassword: string): Promise<SecuritySettings>  // 仅重包裹 DEK（salt/wrapNonce 全新随机）
  export const SECURITY_KEY = 'security'
  ```
- kdf 钳制：unlock/setup 对 security 自带参数 m>2**21/t>10/p>8 → `Error('invalid security settings')`（setup 自定 params 同样钳制）；dek 非 32B → encrypt/decrypt 抛 `Error('invalid dek')`

- [ ] **Step 1: 写失败测试**

`packages/core/test/security.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import {
  changeVaultPassphrase, decryptVaultWithDek, encryptVaultWithDek, isEncryptedVault,
  setupVaultEncryption, unlockVaultEncryption, SECURITY_KEY,
} from '../src/security/securityStore'

const vaultJson = JSON.stringify({ version: 1, entries: [{ uuid: 'a' }], groups: [], updatedAt: 1 })

describe('securityStore', () => {
  it('setup→unlock→encrypt/decrypt 往返', async () => {
    const { security, encrypted, dek } = await setupVaultEncryption(vaultJson, '口令123')
    expect(security.v).toBe(1)
    expect(encrypted.enc).toBe(true)
    expect(isEncryptedVault(encrypted)).toBe(true)
    expect(await decryptVaultWithDek(dek, encrypted)).toBe(vaultJson)
    expect(SECURITY_KEY).toBe('security')

    const dek2 = await unlockVaultEncryption(security, '口令123')
    expect(await decryptVaultWithDek(dek2, encrypted)).toBe(vaultJson)
  })
  it('口令错误报中文错误', async () => {
    const { security } = await setupVaultEncryption(vaultJson, '对')
    await expect(unlockVaultEncryption(security, '错')).rejects.toThrow('口令错误或数据已损坏')
  })
  it('changePassphrase 后新口令可解、旧口令不可', async () => {
    const { security, dek } = await setupVaultEncryption(vaultJson, '旧')
    const s2 = await changeVaultPassphrase(security, dek, '新')
    expect(s2.kdf.salt).not.toBe(security.kdf.salt)
    const dek2 = await unlockVaultEncryption(s2, '新')
    expect(dek2).toEqual(dek) // 同一 DEK：数据无需重加密
    await expect(unlockVaultEncryption(s2, '旧')).rejects.toThrow('口令错误或数据已损坏')
  })
  it('kdf 超钳制参数拒绝', async () => {
    const { security } = await setupVaultEncryption(vaultJson, 'p')
    const bad = { ...security, kdf: { ...security.kdf, t: 99999 } } as typeof security
    await expect(unlockVaultEncryption(bad, 'p')).rejects.toThrow('invalid security settings')
  })
  it('encrypt 对非 32B dek 抛 invalid dek；结构非法拒绝', async () => {
    await expect(encryptVaultWithDek(new Uint8Array(16), '{}')).rejects.toThrow('invalid dek')
    await expect(unlockVaultEncryption({ v: 2 } as never, 'p')).rejects.toThrow('invalid security settings')
  })
  it('两次 setup 产生不同 salt/nonce（随机性）', async () => {
    const a = await setupVaultEncryption(vaultJson, 'p')
    const b = await setupVaultEncryption(vaultJson, 'p')
    expect(a.security.kdf.salt).not.toBe(b.security.kdf.salt)
    expect(a.encrypted.ciphertext).not.toBe(b.encrypted.ciphertext)
  })
})
```

- [ ] **Step 2: 确认失败 → 实现 → 通过 → Commit**

实现要点：setup 生成 DEK/salt/双 nonce；KEK=deriveKek(password, salt, params)（参数钳制后传入）；wrappedDek=aesGcmEncrypt(kek, dek, wrapNonce)；encrypt 每次新 dataNonce；unlock 钳制校验→deriveKek→aesGcmDecrypt(wrappedDek)（失败→口令错误）；change 仅重派生重包裹。

Run: `pnpm --filter @totp/core test`（+6）

```bash
git add packages/core/
git commit -m "feat(core): vault落盘加密securityStore(口令KEK模式+换口令重包裹)"
```

---

### Task 2: createVueStore 加密集成（TDD）+ LockScreen 组件

**Files:**
- Modify: `packages/ui/src/store.ts`、`packages/ui/src/index.ts`
- Create: `packages/ui/src/components/LockScreen.vue`
- Test: `packages/ui/test/store.test.ts`（追加）、`packages/ui/test/LockScreen.test.ts`

**Interfaces:**
- Produces（store 返回对象扩展）:
  ```ts
  locked: Ref<boolean>            // 初始：'vault' 键是 EncryptedVault 且未解锁→true
  hasEncryption: ComputedRef<boolean>
  async unlock(password: string): Promise<void>   // unlockVaultEncryption→缓存 dek→解密 replaceVault→locked=false；口令错抛错（组件展示）
  lock(): void                                    // 清 dek→locked=true（vault 内容清空防内存残留读取）
  async enableEncryption(password: string): Promise<void>   // setup（含当前 vaultJson）→写 security+enc vault→缓存 dek
  async disableEncryption(): Promise<void>        // 需已解锁→解密为明文 Vault 写回→删 security 键（adapter.delete(SECURITY_KEY)）→清 dek
  async changePassphrase(newPassword: string): Promise<void>  // 需已解锁→changeVaultPassphrase→写 security
  ```
  - `commit`/写 op 在 locked 时抛 `Error('vault locked')`（队列不污染：在 fn 执行前检查）
  - initStore 逻辑扩展：loadVault 读到 EncryptedVault 形状 → 若缓存 dek 存在则解密填充（刷新场景），否则 locked=true（vault 置空）；`security` 键经 loadSecurity/saveSecurity 读写（新 core 导出？——直接在 store 内 adapter.get/set SECURITY_KEY JSON）
- `LockScreen.vue` props `{ store: VueStore }`：口令输入+解锁按钮+错误展示+busy；emit 无（解锁成功后由父级响应 locked 变化切换视图）
- 消费端：popup/options/desktop App.vue 在 `<template>` 顶层 `<LockScreen v-if="store.locked" :store="store" />`（popup/extension 的 store 是薄封装——需把 locked/unlock 等新导出加进 extension/src/store.ts 薄封装）；desktop mini 窗 locked 时显示「已锁定」纯文本（MiniApp 加 v-if）

- [ ] **Step 1: store 追加失败测试**

`packages/ui/test/store.test.ts` 追加:
```ts
import { setupVaultEncryption } from '@totp/core'

it('enableEncryption→locked=false；lock 后写操作抛错；unlock 恢复', async () => {
  const adapter = createMemoryStorage()
  const s = createVueStore(adapter)
  await s.initStore()
  await s.addEntryOp(newEntryFromUri('otpauth://totp/A:b?secret=JBSWY3DPEHPK3PXP', 1700000000000))
  await s.enableEncryption('pw')
  expect(s.locked.value).toBe(false)
  const raw = JSON.parse((await adapter.get('vault'))!)
  expect(raw.enc).toBe(true)
  expect(await adapter.get('security')).toBeTruthy()

  s.lock()
  expect(s.locked.value).toBe(true)
  await expect(s.addEntryOp(newEntryFromUri('otpauth://totp/B:c?secret=JBSWY3DPEHPK3PXP', 1700000000000))).rejects.toThrow('vault locked')

  await s.unlock('pw')
  expect(s.locked.value).toBe(false)
  expect(s.vault.entries).toHaveLength(1)
  await s.addEntryOp(newEntryFromUri('otpauth://totp/B:c?secret=JBSWY3DPEHPK3PXP', 1700000000000))
  expect(s.vault.entries).toHaveLength(2)
})

it('initStore 对加密 vault 且未解锁→locked', async () => {
  const adapter = createMemoryStorage()
  const s1 = createVueStore(adapter)
  await s1.initStore()
  await s1.enableEncryption('pw')
  const s2 = createVueStore(adapter)
  await s2.initStore()
  expect(s2.locked.value).toBe(true)
  expect(s2.vault.entries).toHaveLength(0)
  await s2.unlock('pw')
  expect(s2.locked.value).toBe(false)
  expect(s2.vault.entries).toHaveLength(1)
})

it('disableEncryption 回到明文', async () => {
  const adapter = createMemoryStorage()
  const s = createVueStore(adapter)
  await s.initStore()
  await s.enableEncryption('pw')
  await s.disableEncryption()
  expect(s.hasEncryption.value).toBe(false)
  const raw = JSON.parse((await adapter.get('vault'))!)
  expect(raw.enc).toBeUndefined()
  expect(await adapter.get('security')).toBeNull()
})
```
（locked 是 Ref——测试按 s.locked.value 访问；若实现为 computed 同样成立）

- [ ] **Step 2: 实现 store 扩展 → LockScreen 组件（+2 用例：解锁成功隐藏错误清空；口令错显示消息）→ 通过**

- [ ] **Step 3: 三端接线 + 验证 + Commit**

extension/src/store.ts 薄封装补导出（locked/hasEncryption/unlock/lock/enableEncryption/disableEncryption/changePassphrase）；popup/options App.vue 顶层挂 LockScreen（v-if="locked"）；desktop App.vue 同（MiniApp 加锁定提示）。

Run: `pnpm test && pnpm -r run typecheck && pnpm --filter @totp/extension build && pnpm --filter @totp/desktop tauri build`

```bash
git add packages/ apps/ pnpm-lock.yaml
git commit -m "feat(ui): store加密集成(locked/unlock/换口令)+LockScreen三端接线"
```

---

### Task 3: 设置 UI（加密开关/换口令/剪贴板/弹窗延迟）+ EntryForm secret 遮蔽

**Files:**
- Modify: `packages/core/src/storage/vaultStore.ts`（AppSettings 扩展 + DEFAULT + loadSettings 收紧）
- Modify: `packages/core/test/settings.test.ts`、`packages/ui/src/components/EntryForm.vue`
- Create: `packages/ui/src/components/SecurityCard.vue`
- Modify: `packages/ui/src/index.ts`、`packages/ui/src/components/VaultManager.vue`（挂 SecurityCard，platform 可选扩展）
- Test: `packages/ui/test/SecurityCard.test.ts`

**Interfaces:**
- core AppSettings 扩展：`clipboardClearEnabled: boolean`（默认 true）、`popupCloseDelayMs: number`（默认 2000）——loadSettings typeof 收紧（boolean/number），DEFAULT_SETTINGS 同步，settings 形状断言全仓更新
- EntryForm：secret 输入框改 `:type="showSecret ? 'text' : 'password'"` + 右侧「显示/隐藏」toggle 按钮（默认遮蔽）；新建时生成？不做（无随机生成需求）
- SecurityCard props `{ platform: { security: { locked: Ref<boolean>; hasEncryption: ComputedRef<boolean>; enableEncryption(pw): Promise<void>; disableEncryption(): Promise<void>; changePassphrase(pw): Promise<void> } | null; clipboardClearEnabled: ComputedRef<boolean>; setClipboardClear(v): Promise<void>; popupCloseDelayMs?: ComputedRef<number>; setPopupCloseDelay?(ms): Promise<void> } | null }`
  - 未启用：口令+确认口令 →「启用加密」（enableEncryption，busy/错误同 BackupCard 模式）
  - 已启用且解锁：「更换口令」（changePassphrase）+「关闭加密」（先 confirm「将把全部条目以明文存储」→ disableEncryption）
  - 锁定时显示「已锁定」+ 解锁入口提示（主 LockScreen 已处理，卡片只提示）
  - 通用设置区：剪贴板 30s 清空 checkbox（clipboardClearEnabled）；popupCloseDelayMs 数字输入（仅 extension 场景渲染——platform 提供时）
- VaultManager 挂载：SecurityCard 置于 BackupCard 之前；popup 不渲染（platform null 链路既有）

- [ ] **Step 1: core settings 扩展（TDD）→ EntryForm 遮蔽（补测试：secret input 默认 type=password，点 toggle 变 text）**

- [ ] **Step 2: SecurityCard（TDD，4 用例：未启用口令不一致不调用/一致调用 enableEncryption、启用态渲染换口令与关闭按钮、剪贴板 checkbox 触发 setClipboardClear）→ 三端 platform 接线（desktop 与 extension options 组装 security/clipboard 闭包；popupCloseDelayMs 仅 extension 提供）**

- [ ] **Step 3: 验证（pnpm test、typecheck、双 build 产物核对）+ Commit**

```bash
git add packages/ apps/ pnpm-lock.yaml
git commit -m "feat(ui): SecurityCard(加密开关/换口令/剪贴板与弹窗设置)+EntryForm密钥遮蔽"
```

---

### Task 4: 复制体验（30s 清剪贴板 + HOTP 递增 + popup「已复制」2s 关闭）

**Files:**
- Modify: `packages/ui/src/components/VaultManager.vue`（copy 路径统一：emit 前按 settings 处理 HOTP 递增；enableCopy 点击时 HOTP→递增）
- Modify: `apps/extension/entrypoints/popup/App.vue`（copy→「已复制」反馈 + popupCloseDelayMs 后 window.close()；剪贴板 30s 清空定时器）
- Modify: `apps/desktop/src/App.vue`、`apps/desktop/src/MiniApp.vue`、`apps/extension/entrypoints/options/App.vue`（剪贴板 30s 清空）

**Interfaces:**
- 30s 清剪贴板：helper `scheduleClipboardClear(store, writeFn)`——settings.clipboardClearEnabled 为 true 时，复制后启动 30s 定时器写入空串；重复复制重置定时器（ui 包导出 `createClipboardClearer(getEnabled: () => boolean, clear: () => Promise<void>)`，返回 `notifyCopied()`；每端组装 clear 实现：extension=navigator.clipboard.writeText('')，desktop=插件 writeText('')）
- HOTP 递增：VaultManager onCopy 内：若 entry.type==='hotp'，复制当前码后 `store.updateEntryOp(uuid, { counter: (entry.counter ?? 0) + 1 })`（复制的是旧 counter 的码，符合 RFC 语义）；popup 同款（popup 不经 VaultManager——在 popup copy() 中加同逻辑）
- popup「已复制」：copy 成功 → header 下显示「已复制到剪贴板」横幅 → setTimeout(settings.popupCloseDelayMs ?? 2000) → window.close()；期间再次点击重置计时（简单实现：不重置，直接到点关闭）

- [ ] **Step 1: ui createClipboardClearer（TDD，3 用例：启用时 30s 后调用 clear、禁用不调用、重复复制重置计时——用 vi.useFakeTimers）**

- [ ] **Step 2: 各端接线 + 验证 + Commit**

Run: `pnpm test && pnpm -r run typecheck && pnpm --filter @totp/extension build && pnpm --filter @totp/desktop tauri build`

```bash
git add packages/ apps/
git commit -m "feat(ui): 复制体验统一(30s清剪贴板/HOTP递增/popup已复制2s关闭)"
```

---

### Task 5: 真实应用图标（extension + desktop）

**Files:**
- Create: `scripts/gen-app-icons.mjs`（纯 Node 生成 PNG——手写 PNG 编码太重，改用 PowerShell System.Drawing 绘制：蓝色圆角底 + 白色圆环 + 刻度，产出 16/32/48/128/256 PNG + icon.ico + 与桌面共用）
- Modify: `apps/extension/public/icon.png`（WXT 约定 public/ → manifest icons）、`apps/desktop/src-tauri/icons/`（全部替换）

**Interfaces:**
- 图标设计（程序化绘制，无外部资源）：4A90D9 蓝色圆角方底、白色空心圆环（倒计时隐喻）、环上 12 点位置缺口、中心「T」无衬线字符；各尺寸清晰度可接受即可
- extension：WXT manifest icons 16/32/48/128（`apps/extension/public/icon.png` 单文件按 WXT 文档默认即可；若 WXT 需要 `icons` 显式声明则 wxt.config.ts 加 `manifest.icons`）
- desktop：tauri.conf bundle.icon 列表已存在——替换同名文件（32x32.png/128x128.png/icon.ico，补 128x128@2x.png 若 conf 引用）；icon.ico 用多尺寸（16/32/48/256）真 ICO（PowerShell Icon.FromHandle 单尺寸限制→改用 .NET 写 ICO 结构或用单 256 PNG 转——以产物可用为准）

- [ ] **Step 1: 绘制脚本 → 生成 → 双端接线 → 产物核对**

Run: 脚本生成 → `pnpm --filter @totp/extension build`（产物 manifest icons 存在且指向新图）→ `pnpm --filter @totp/desktop tauri build`（bundle 成功）→ 人工描述产物图标外观到报告

- [ ] **Step 2: Commit**

```bash
git add scripts/gen-app-icons.mjs apps/extension/ apps/desktop/ pnpm-lock.yaml
git commit -m "feat: 程序化绘制真实应用图标(extension/desktop)"
```

---

### Task 6: 回归 + README

**Files:**
- Modify: `README.md`（补「安全」段：vault 落盘加密（默认关闭，设置中启用）、口令更换（仅重包裹无需重加密数据）、解锁语义（每窗口独立、页面关闭即锁）、剪贴板 30s 自动清空、secret 遮蔽）

- [ ] **Step 1: 回归**

Run: `pnpm test && pnpm --filter @totp/extension build && pnpm -r run typecheck && pnpm --filter @totp/desktop tauri build`
Expected: 全绿（core ~144、ui ~31）

- [ ] **Step 2: README + Commit**

```bash
git add README.md
git commit -m "docs: README补充安全与加密说明"
```
