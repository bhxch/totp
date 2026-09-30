# 桌面 Miniapp 跟随主窗解锁 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 主窗解锁后桌面 mini 迷你窗自动解锁、主窗锁定后 mini 同步锁定；DEK 全程仅进程内存。

**Architecture:** Rust 新增 `MINI_DEK` 进程内槽（set/clear/peek，base64 String，同 `STASHED_DEK` 模式）；主窗在解锁/锁定汇聚点写槽并 `emitTo('mini', 'mini-session', {locked})`；mini 侧经 `dekPersist.get = peek_mini_dek` 走 `initStore` 既有自动恢复分支，并监听事件实时联动。

**Tech Stack:** Tauri v2（Rust command + event）、Vue 3、vitest（desktop 包 `test/mocks/tauri.ts` mock 体系）。

**Spec:** `docs/plans/2026-09-30-mini-dek-follow-design.md`

## Global Constraints

- DEK 只存进程内存（Rust Mutex 槽 + 各 WebView JS 内存）；不落盘、不进事件 payload（事件只传 `{ locked: boolean }`）。
- mini 槽语义 = **peek 不 take**（mini 聚焦重建 store 每次都要能取）；槽所有权在主窗，mini 的 `dekPersist.set/clear` 必须为 no-op。
- 锁定汇聚点唯一：`packages/ui/src/store.ts` `lock()` → `opts.onLocked`；解锁汇聚点唯一：`packages/ui/src/store/encryptionSession.ts` `applyDekAndUnlock` 尾部（口令/unlockWithDek/initStore 恢复三路均汇此）。
- 每任务结束跑对应包 vitest + `pnpm typecheck`；Rust 任务跑 `cargo test` + `cargo fmt` + `cargo clippy`。测试命令一律在对应包目录执行（`packages/ui`、`apps/desktop`、`apps/desktop/src-tauri`）。

---

### Task 1: Rust MINI_DEK 槽与三个 command

**Files:**
- Modify: `apps/desktop/src-tauri/src/session_vaults.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`（generate_handler 清单，658-690 行段）
- Test: `apps/desktop/src-tauri/src/session_vaults.rs`（文件内 `#[cfg(test)]` 若无则新建）

**Interfaces:**
- Produces: `set_mini_dek(dek: String)`、`peek_mini_dek() -> Option<String>`、`clear_mini_dek()`（Tauri command，前端 `invoke('peek_mini_dek')` 等）。槽常量 `pub static MINI_DEK: Mutex<Option<String>>`。

- [ ] **Step 1: 写失败测试**（session_vaults.rs 末尾，沿用文件内既有测试风格；若无测试模块则新增）

```rust
#[cfg(test)]
mod mini_dek_tests {
    use super::*;

    fn peek_inner() -> Option<String> {
        MINI_DEK.lock().ok().and_then(|s| s.clone())
    }

    #[test]
    fn mini_dek_set_peek_clear_cycle() {
        dek_slot_clear(&MINI_DEK);
        assert_eq!(peek_inner(), None);
        dek_slot_stash(&MINI_DEK, "ZGVr".into());
        assert_eq!(peek_inner(), Some("ZGVr".into()));
        assert_eq!(peek_inner(), Some("ZGVr".into())); // peek 保留语义：mini 聚焦重建 store 依赖此
        dek_slot_clear(&MINI_DEK);
        assert_eq!(peek_inner(), None);
    }
}
```

- [ ] **Step 2: 跑测试确认编译失败**

Run: `cargo test mini_dek --manifest-path apps/desktop/src-tauri/Cargo.toml`
Expected: FAIL（`peek_mini_dek_inner`/`MINI_DEK` 未定义）

- [ ] **Step 3: 实现**（session_vaults.rs，紧随 STASHED_DEK 定义与既有命令之后，风格一致）

```rust
/// mini 迷你窗跟随主窗解锁的 DEK 槽（仅进程内存，不落盘；2026-09-30 设计）：主窗解锁 set、
/// 锁定 clear、mini 启动/聚焦重建 peek——peek 保留槽值（mini 每次重建 store 都要能再取）
pub static MINI_DEK: Mutex<Option<String>> = Mutex::new(None);

/// 主窗解锁成功后下发 mini 窗解锁用 DEK（base64；前端 bytesToBase64）
#[tauri::command]
pub fn set_mini_dek(dek: String) {
    dek_slot_stash(&MINI_DEK, dek);
}

/// mini 窗读取槽中 DEK（保留语义，非 take；无则 null=主窗未解锁）
#[tauri::command]
pub fn peek_mini_dek() -> Option<String> {
    MINI_DEK.lock().ok().and_then(|s| s.clone())
}

/// 主窗锁定时清空 mini 槽（mini 收事件同步锁窗）
#[tauri::command]
pub fn clear_mini_dek() {
    dek_slot_clear(&MINI_DEK);
}

#[cfg(test)]
mod mini_dek_tests {
    fn peek_mini_dek_inner() -> Option<String> {
        MINI_DEK.lock().ok().and_then(|s| s.clone())
    }
    // …Step 1 的测试用例放这里
}
```

（`peek_mini_dek` command 体与测试 `peek_mini_dek_inner` 同式；command 直接内联 `MINI_DEK.lock().ok().and_then(|s| s.clone())`，测试走 inner 避免跨 crate 调 command 宏产物。）

- [ ] **Step 4: lib.rs 注册**：`generate_handler!` 清单中 `clear_stashed_dek,` 之后追加三行 `set_mini_dek,` `peek_mini_dek,` `clear_mini_dek,`；并在 lib.rs 顶部 `use session_vaults::{...}` 导入清单追加同名三项（对齐现有导入写法）。

- [ ] **Step 5: 跑测试与门禁**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml && cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml --all && cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets`
Expected: 全绿（现有 118 例不破）

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src-tauri/src/session_vaults.rs apps/desktop/src-tauri/src/lib.rs
git commit -m "feat(desktop): MINI_DEK 进程内槽与 set/peek/clear 三命令"
```

---

### Task 2: ui 解锁汇聚点暴露 onUnlocked 回调

**Files:**
- Modify: `packages/ui/src/store.ts`（opts 类型 19-46 行段 + `createEncryptionSession` 装配 161-177 行段）
- Modify: `packages/ui/src/store/encryptionSession.ts`（deps 类型 + `applyDekAndUnlock` 400-421 行）
- Test: `packages/ui/test/store.test.ts`

**Interfaces:**
- Produces: `createVueStore` opts 新增 `onUnlocked?: () => void`——**所有解锁路径（口令/unlockWithDek/initStore dekPersist 恢复）在 `applyDekAndUnlock` 成功完成后回调一次**。后续 Task 3 依赖。

- [ ] **Step 1: 写失败测试**（store.test.ts 末尾追加）

```ts
describe('onUnlocked（① mini 跟随主窗解锁）', () => {
  it('解锁路径（口令）触发一次 onUnlocked；锁定后不触发', async () => {
    const adapter = createMemoryStorage()
    const onUnlocked = vi.fn()
    const s = createVueStore(adapter, { onUnlocked })
    await s.initStore()
    // 启用加密并锁定，再口令解锁
    const { setupVaultEncryption: setup } = await import('@totp/core')
    await s.addEntryOp({ ...newEntryFromUri('otpauth://totp/A:x?secret=JBSWY3DPEHPK3PXP', 1), uuid: 'u1' })
    const pw = 'test-passphrase-123'
    await setup(adapter, pw, s) // 启用加密（api 以 core 实际签名为准，见 Step 3 注）
    s.lock()
    expect(onUnlocked).not.toHaveBeenCalled()
    await s.unlock(pw)
    expect(onUnlocked).toHaveBeenCalledTimes(1)
  })
})
```

注意：`setupVaultEncryption` 与 `store.unlock` 的真实签名以 `packages/core` 导出与 `store.ts` 现有解锁 op 为准（store.test.ts 既有加密用例有完整先例——先搜 `setupVaultEncryption` 在 store.test.ts 的既有用法，复制其初始化套路，仅在其上追加 `onUnlocked` 断言；不要自创新 API）。若既有用例以 `unlockWithPrf` 走 PRF 路径解锁，也可复用该先例——断言不变：解锁成功后 `onUnlocked` 恰一次。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/ui && pnpm exec vitest run test/store.test.ts`
Expected: FAIL（`createVueStore` opts 无 `onUnlocked`——多余属性被忽略则断言 0 次调用失败）

- [ ] **Step 3: 实现**

1. `store.ts` opts 类型（34 行 `dekPersist` 行后）加：

```ts
    /** 解锁成功回调（① mini 跟随主窗解锁）：所有解锁路径在 applyDekAndUnlock 成功完成后触发一次 */
    onUnlocked?: () => void
```

2. `store.ts` 161-177 行 `createEncryptionSession({...})` deps 中追加 `onUnlock: opts.onUnlocked,`（与 `dekPersist: opts.dekPersist,` 同段）。

3. `encryptionSession.ts`：deps 接口（`dekPersist` 字段 15-16 行同段）加 `onUnlock?: () => void`；`applyDekAndUnlock` 尾部（420 行 `await conflicts.reload()` 之后）追加：

```ts
    // ① 解锁汇聚点回调（口令/unlockWithDek/initStore 恢复三路均经此；desktop 宿主经此同步 mini 窗）
    deps.onUnlock?.()
```

（回调同步执行、不 await——宿主自行 catch 内部异步。）

- [ ] **Step 4: 跑测试与回归**

Run: `cd packages/ui && pnpm exec vitest run && pnpm typecheck`
Expected: 全绿

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/store.ts packages/ui/src/store/encryptionSession.ts packages/ui/test/store.test.ts
git commit -m "feat(ui): 解锁汇聚点暴露 onUnlocked 回调"
```

---

### Task 3: desktopShell 主窗侧联动（publish helpers + boot 接线）

**Files:**
- Create: `apps/desktop/src/miniSession.ts`
- Modify: `apps/desktop/src/desktopShell.ts`（bootDesktopStore opts 76-88 行；onLocked 注入 314 行段）
- Modify: `apps/desktop/src/App.vue`（主窗 `bootDesktopStore(` 调用处）
- Test: `apps/desktop/src/miniSession.test.ts`（新建）；`apps/desktop/test/mocks/tauri.ts`（INVOKE_COMMANDS 补命令名；event mock 补 emitTo）

**Interfaces:**
- Consumes: Task 1 的 `set_mini_dek`/`clear_mini_dek`；Task 2 的 `onUnlocked`。
- Produces: `publishMiniUnlock(dek: Uint8Array): Promise<void>`、`publishMiniLock(): Promise<void>`（miniSession.ts 导出）；`bootDesktopStore` opts 新增 `onUnlocked?: () => void` 与 `dekPersist?: { get(): Promise<string | null>; set(dek: Uint8Array): Promise<void>; clear(): Promise<void> }` 透传（Task 4 的 mini 侧消费 dekPersist）。

- [ ] **Step 1: 扩展 tauri mock**（`apps/desktop/test/mocks/tauri.ts`）：INVOKE_COMMANDS 清单（31-70 行）追加 `'set_mini_dek'`、`'peek_mini_dek'`、`'clear_mini_dek'`；事件模块 `eventModule()` 若无 `emitTo` 则补 `emitTo: vi.fn()`（与既有 `emit` 同层）并在 `reset()` 中清调用记录。

- [ ] **Step 2: 写失败测试**（apps/desktop/src/miniSession.test.ts，mock 套路同 desktopShell.test.ts:20-23）

```ts
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { bytesToBase64 } from '@totp/core'

vi.mock('@tauri-apps/api/core', async () => (await import('../test/mocks/tauri')).invokeModule())
vi.mock('@tauri-apps/api/event', async () => (await import('../test/mocks/tauri')).eventModule())

import { publishMiniLock, publishMiniUnlock } from '../src/miniSession'
import { tauriMock } from '../test/mocks/tauri'

describe('miniSession（① 主窗→mini 解锁态同步）', () => {
  beforeEach(() => tauriMock.reset())

  it('publishMiniUnlock：DEK base64 入槽 + emitTo mini locked:false', async () => {
    const dek = new Uint8Array(32).fill(7)
    await publishMiniUnlock(dek)
    expect(tauriMock.calls('set_mini_dek')).toEqual([{ dek: bytesToBase64(dek) }])
    const { tauriMock: t } = await import('../test/mocks/tauri')
    expect(t.emitToCalls()).toEqual([['mini', 'mini-session', { locked: false }]])
  })

  it('publishMiniLock：clear_mini_dek + emitTo locked:true；槽清失败不阻断事件', async () => {
    await publishMiniLock()
    expect(tauriMock.calls('clear_mini_dek')).toHaveLength(1)
    const { tauriMock: t } = await import('../test/mocks/tauri')
    expect(t.emitToCalls()).toEqual([['mini', 'mini-session', { locked: true }]])
  })
})
```

（`tauriMock.emitToCalls()` 若 mock 工厂无此 helper，按 `calls()` 现有风格补一个等价 helper；断言口径以 mock 工厂实际 API 为准，行为不变：mini 窗收到 `('mini', 'mini-session', { locked })`。）

- [ ] **Step 3: 实现 miniSession.ts**

```ts
import { invoke } from '@tauri-apps/api/core'
import { emitTo } from '@tauri-apps/api/event'
import { bytesToBase64 } from '@totp/core'

/** 主窗→mini 解锁态同步（2026-09-30 设计）：DEK 只进 Rust 进程内槽，事件只传状态布尔不传密钥 */
export async function publishMiniUnlock(dek: Uint8Array): Promise<void> {
  await invoke('set_mini_dek', { dek: bytesToBase64(dek) })
  await emitTo('mini', 'mini-session', { locked: false })
}

export async function publishMiniLock(): Promise<void> {
  await invoke('clear_mini_dek').catch(() => {})
  await emitTo('mini', 'mini-session', { locked: true }).catch(() => {})
}
```

- [ ] **Step 4: desktopShell 接线**

1. `bootDesktopStore` opts（76-88 行）追加两个可选字段并透传：

```ts
export async function bootDesktopStore(
  adapter: StorageAdapter,
  opts: {
    windowId: string
    onCommitted?: () => void
    onLocked?: () => void
    onPersistError?: (e: unknown) => void
    /** ① mini 跟随主窗解锁：主窗 boot 传（Task 3），mini boot 不传 */
    onUnlocked?: () => void
    /** ① mini 侧 peek 主窗槽自动恢复；主窗不传 */
    dekPersist?: { get(): Promise<string | null>; set(dek: Uint8Array): Promise<void>; clear(): Promise<void> }
  },
): Promise<VueStore> {
  const s = createVueStore(adapter, {
    windowId: opts.windowId,
    onCommitted: opts.onCommitted,
    onLocked: opts.onLocked,
    onPersistError: opts.onPersistError,
    onUnlocked: opts.onUnlocked,
    dekPersist: opts.dekPersist,
  })
  await s.initStore()
  return s
}
```

2. 主窗 onLocked 注入处（314 行 `onLocked: () => { void invoke('clear_stashed_dek').catch(() => {}) }`）追加一行：`void publishMiniLock().catch(() => {})`（import 自 `./miniSession`）。

3. 主窗 `bootDesktopStore(` 调用处（`App.vue`；若存在多处，仅主窗 `windowId: 'main'` 的那处）：改为先声明可变引用再 boot，使 onUnlocked 闭包能拿到 store 实例：

```ts
let s: VueStore | null = null
s = await bootDesktopStore(adapter, {
  windowId: 'main',
  onLocked: () => { void invoke('clear_stashed_dek').catch(() => {}) },
  // ① mini 跟随：解锁汇聚点回调解锁成功 → DEK 入槽 + 通知 mini
  onUnlocked: () => {
    const dek = s?.getCurrentDek()
    if (dek) void publishMiniUnlock(dek).catch(() => {})
  },
  onPersistError: (e) => { /* 保持该调用处原有实现不变 */ },
})
```

（以该调用处现有字段为准——已有字段一律保留，只新增 `onUnlocked`。`onLocked` 若在 desktopShell 内部 314 行已注入则不在此重复。）

- [ ] **Step 5: 跑 desktop 测试与 typecheck**

Run: `cd apps/desktop && pnpm exec vitest run && pnpm typecheck`
Expected: 全绿（desktopShell.test 现有用例不破——opts 新字段可选）

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/miniSession.ts apps/desktop/src/miniSession.test.ts apps/desktop/src/desktopShell.ts apps/desktop/src/App.vue apps/desktop/test/mocks/tauri.ts
git commit -m "feat(desktop): 主窗解锁/锁定汇聚点联动 mini 槽与事件"
```

---

### Task 4: mini 侧接入（dekPersist peek + 事件联动 + 文案）

**Files:**
- Modify: `apps/desktop/src/MiniApp.vue`（load() 25-54 行；onMounted 61-74 行；lockedNote 模板 120 行）
- Modify: `packages/ui/src/i18n/locales/zh/common.json:764`、`packages/ui/src/i18n/locales/en/common.json:764`
- Test: `apps/desktop/src/MiniApp.test.ts`

**Interfaces:**
- Consumes: Task 1 `peek_mini_dek`；Task 3 `mini-session` 事件与 `bootDesktopStore` 的 `dekPersist`/`onUnlocked` 透传。

- [ ] **Step 1: 写失败测试**（MiniApp.test.ts 追加；mock 套路同文件既有用例）

```ts
describe('mini 跟随主窗解锁（①）', () => {
  it('boot 传 dekPersist（peek_mini_dek）；槽有 DEK 时 initStore 自动解锁', async () => {
    const dekB64 = bytesToBase64(new Uint8Array(32).fill(3))
    tauriMock.onReturn('peek_mini_dek', dekB64)
    // …按该测试文件既有 mount 流程挂载 MiniApp
    // 断言：组件渲染出条目列表（.otp-item 存在），锁定文案未出现
    expect(wrapper.find('.empty').text()).not.toContain('主窗口解锁后')
  })

  it('mini-session locked:true → 调 store.lock()；locked:false 且锁定中 → 重载', async () => {
    // 先挂载（槽空=锁定态），随后 tauriMock.emit('mini-session', { locked: false }) 模拟主窗解锁
    // 断言 peek_mini_dek 被再次调用（load 重建）且列表渲染
    tauriMock.onReturn('peek_mini_dek', bytesToBase64(new Uint8Array(32).fill(3)))
    tauriMock.emit('mini-session', { locked: false })
    await flushPromises()
    expect(tauriMock.calls('peek_mini_dek').length).toBeGreaterThanOrEqual(2)
  })
})
```

（mount 流程、`locked` 断言方式以该测试文件既有用例为准；核心断言两点：`invoke('peek_mini_dek')` 被 boot 调用、事件两分支行为。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/desktop && pnpm exec vitest run src/MiniApp.test.ts`
Expected: FAIL（peek 未被调用 / 事件未监听）

- [ ] **Step 3: 实现 MiniApp.vue**

1. `load()`（25-54 行）bootDesktopStore 调用追加 `dekPersist`（mini 槽只读——set/clear 恒 no-op，槽所有权在主窗）：

```ts
    const s = await bootDesktopStore(adapter, {
      windowId: 'mini',
      onLocked: () => { void invoke('clear_stashed_dek').catch(() => {}) },
      onPersistError: (e) => {
        console.error('[store] persist failed:', e)
        persistFailed.value = true
      },
      // ① mini 跟随主窗解锁：槽有 DEK（主窗已解锁）即自动恢复；set/clear no-op——槽由主窗写清
      dekPersist: {
        get: () => invoke<string | null>('peek_mini_dek').catch(() => null),
        set: async () => {},
        clear: async () => {},
      },
    })
```

（同时更新 28-31 行的旧注释「mini 窗口独立保持锁定」→「mini 跟随主窗解锁态：槽 peek + mini-session 事件（2026-09-30 设计）」。）

2. `onMounted`（61-74 行）追加事件监听（与 force-lock 监听同款；unlisten 句柄同样在 onUnmounted 清理——对齐该文件既有 unlistenForceLock 模式）：

```ts
  unlistenMiniSession = await listen<{ locked: boolean }>('mini-session', (e) => {
    if (e.payload.locked) store.value?.lock()
    else if (store.value && locked.value) void load()
  }).catch(() => null)
```

（`locked` 为该组件既有锁定 computed/ref——按 120 行模板 `v-if="store && locked"` 的同一来源引用。）

3. 文案：zh `common.json:764` `"lockedNote": "主窗口解锁后此窗口可用"`；en `"lockedNote": "Available once the main window is unlocked"`。

- [ ] **Step 4: 跑测试与三宿主回归**

Run: `cd apps/desktop && pnpm exec vitest run && pnpm typecheck && cd ../../packages/ui && pnpm exec vitest run`
Expected: 全绿

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/MiniApp.vue apps/desktop/src/MiniApp.test.ts packages/ui/src/i18n/locales/zh/common.json packages/ui/src/i18n/locales/en/common.json
git commit -m "feat(desktop): mini 跟随主窗解锁（槽 peek 自动恢复+事件联动）"
```

---

### Task 5: 真机验证清单（人工，不阻塞合并）

**Files:**
- Create: `docs/e2e/2026-09-30-mini-dek-follow-checklist.md`

- [ ] 按 `docs/e2e-test.md` §6 指南登记以下人工项（合并后并入批次 E 验证会话执行，不在本计划自动化）：
  1. 口令解锁主窗 → 呼出 mini（Alt+Shift+T）→ mini 直接显示验证码列表（不出现锁定文案）。
  2. mini 已开且锁定时主窗解锁 → mini 不聚焦状态下收到事件自动解锁（可用第二窗口遮挡验证或日志）。
  3. 主窗锁定（托盘/快捷键/空闲锁任一路径）→ mini 回到「主窗口解锁后此窗口可用」。
  4. mini 聚焦重建（失焦再聚焦）不丢解锁态。
  5. 应用完全退出重启 → mini 恢复锁定提示（槽随进程消失）。
  6. PRF 与 DPAPI 两解锁路径重复第 1 项。

## Self-Review 记录

- Spec 覆盖：安全模型（Task 1/3 事件不传密钥、槽进程内存）、机制三件套（Task 1 槽 / Task 2+3 主窗挂钩 / Task 4 mini 接入）、行为序列七场景（Task 5 清单 1-5 覆盖 + 明文库不涉 DEK 天然成立）、文案（Task 4 Step 3.3）、非目标未越界。✔
- 占位符扫描：Task 2 Step 1 的 setup 套路、Task 4 Step 1 的 mount 流程均显式指向「既有测试文件先例 + 复制既有套路」并给出核心断言——属精确指令而非 TBD。✔
- 类型一致：`dekPersist` 三方法签名与 `packages/ui/src/store.ts:34` 一致；`publishMiniUnlock(dek: Uint8Array)` 与 `getCurrentDek(): Uint8Array | null` 衔接；事件名 `mini-session` 两端一致。✔
