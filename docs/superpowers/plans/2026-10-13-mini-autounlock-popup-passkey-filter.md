# mini 自动解锁 / popup Passkey 解锁窗 / 站点提示收行 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 spec 三特性：A 桌面 mini 窗锁定态打开/聚焦时静默自动解锁；B 扩展 popup 经独立解锁窗完成 Passkey 解锁；C popup 站点无匹配回退提示收进过滤行。

**Architecture:** A = Rust 解锁通道门控从 main 收窄集放宽为 main|mini（写/删类保持 main-only），前端把 LockScreen 的静默解锁抽成共享函数供 MiniApp 复用。B = LockScreen 增 `passkeyMode`/`autoPasskey` 两 prop，popup 点击开 `unlock.html` 真窗口（WXT 无列表页）自动发起 PRF，成功写 session DEK 后自关。C = `popupFilter.ts` 增纯函数 `popupFilterRowAffix`，popup 模板据此把 hint 与「匹配 N 条」同位互斥渲染。

**Tech Stack:** Tauri 2 / Rust（cfg(windows) DPAPI + keyring + ABE elevation）、Vue 3 + vue-i18n、Vitest 5、WXT 0.21（Chrome MV3 + Firefox MV3）、WebAuthn PRF。

**Spec:** `docs/superpowers/specs/2026-10-13-mini-autounlock-popup-passkey-filter-design.md`（本计划从 spec 论证，执行者两份都读）

## Global Constraints

- 包名过滤：`@totp/desktop`、`@totp/ui`、`@totp/extension`；测试一律 `pnpm --filter <pkg> test`（Vitest 5，不可拆批）。
- 扩展 Firefox 构建必须 `pnpm --filter @totp/extension exec wxt build -b firefox`，产物 `.output/firefox-mv3`；类型检查前先 `pnpm --filter @totp/extension exec wxt prepare`，再根目录 `pnpm typecheck`。
- 工作区现有未提交脏文件（`packages/core/src/icons/builtin.json`、`packages/ui/src/assets/icons-full.json`、三个 core snapshot）与本计划无关：**git add 只加本计划明确列出的文件**，禁止 `git add -A`/`git add .`。
- Rust：新增函数须全平台可编译（Linux CI `clippy -D warnings`）；命令错误消息保持中文，与既有门控消息同风格。
- i18n：本计划**零新增用户可见文案键**（zh/en 语言包不动）； unlock 页窗口标题复用 `lock.title`。
- commit 遵循 Angular 规范、原子化，why 前置；每 Task 一个 commit。
- 与既有行为逐字兼容的部分（LockScreen 静默解锁序列、门控错误消息、`decrypt_dpapi` mini 拒绝）不得漂移，有既有测试锁定。

## Review Focus

1. **OS 自动解锁未启用的 mini**（无 dpapi/abe 源）：打开 mini 不得报错、不得误发起解锁，维持「主窗口解锁后此窗口可用」空态 → Task 2 helper 测试 `no channels bound`；Task 3 接线以 `s.locked.value` 为条件且 helper 内部短路。
2. **PRF 能力不可用（部分 Firefox）**：popup passkey 按钮禁用且点击无效，**不得弹出解锁窗** → Task 5 测试 `autoPasskey：PRF 能力 false 时不自动发起` 与 external 模式 disabled 断言（既有「PRF 能力不可用」用例 + 新 external 用例）。
3. **解锁窗 boot 时已解锁**（session DEK 在）：必须立即自关，不闪现锁屏、不留死窗 → Task 6 测试 `已解锁 boot 即自关`。
4. **无 tabUrl（新标签页等）时**回退 hint 仍须可达：独立 hint 行保留，不得因收行逻辑丢失 → Task 4 纯函数三态测试 + 模板 `!tabUrl && hint` 分支。
5. **非 main/mini label**（未来新增窗口）调解锁命令仍拒绝、写/删类命令 mini 仍拒绝 → Task 1 Rust 门控测试（`ensure_auto_unlock_label` 三态 + protect/bind/wrap/remove mini 拒绝断言保留）。

---

### Task 1: Rust 门控放宽——解锁通道放行 mini

**Files:**
- Modify: `apps/desktop/src-tauri/src/platform_security.rs`（新增 helper、2 处门控替换、注释、测试翻转）
- Modify: `apps/desktop/src-tauri/src/elevation_commands.rs`（abe_unwrap 门控替换、测试翻转）

**Interfaces:**
- Consumes: 既有 `ensure_main_window_label`（`platform_security.rs:10-16`）。
- Produces: `pub(crate) fn ensure_auto_unlock_label(label: &str) -> Result<(), String>`——放行 `"main" | "mini"`，其余 `Err("仅主窗口或 mini 窗口可调用此命令")`。Task 3 的前端解锁调用依赖本门控放行 mini。

- [ ] **Step 1: 写失败测试（翻转既有断言 + 新 helper 三态测试）**

`platform_security.rs` 测试模块（`mod tests` 内，替换现有 `dek_channel_gated_to_main_window`，约 :467-474）：

```rust
    // 2026-10-13 spec §A：DEK 解锁通道放行 main|mini（mini 打开/聚焦静默自动解锁，与主窗
    // LockScreen 同权）；protect（写来源）仍 mini 拒绝。WinAuth decrypt_dpapi 的 mini 拒绝
    // 断言在 decrypt_dpapi_inner_gating_and_shape，不动
    #[cfg(windows)]
    #[test]
    fn dek_unprotect_channel_allows_mini() {
        // 解锁：main 包裹的 DEK mini 可解（roundtrip 跨 label）
        let wrapped = dek_protect_inner("main", &base64_encode(&[1u8; 32])).expect("protect");
        let out = dek_unprotect_inner("mini", &wrapped).expect("mini unprotect");
        assert_eq!(out, base64_encode(&[1u8; 32]));
        // 写入：mini 恒拒绝（设置动作仅主窗）
        assert!(dek_protect_inner("mini", &base64_encode(&[1u8; 32])).is_err());
    }

    // 解锁门控 helper 纯函数三态（全平台编译，无 cfg）
    #[test]
    fn auto_unlock_label_gates() {
        assert!(ensure_auto_unlock_label("main").is_ok());
        assert!(ensure_auto_unlock_label("mini").is_ok());
        assert_eq!(
            ensure_auto_unlock_label("popup").unwrap_err(),
            "仅主窗口或 mini 窗口可调用此命令"
        );
    }
```

`elevation_commands.rs` 测试模块（替换现有 `abe_unwrap_impl_gates_mini_window`，约 :409-417）：

```rust
    // ---- abe_unwrap 解锁通道放行 main|mini（2026-10-13 spec §A）----

    #[cfg(windows)]
    #[test]
    fn abe_unwrap_impl_allows_mini_window() {
        // mini webview 内脚本 invoke：门控放行（至 unwrap 阶段因测试环境无服务管道而失败——
        // 非门控错误即达门控后方）；bind/wrap/remove 仍 mini 拒绝（各自既有测试不动）
        let err = abe_unwrap_impl("mini").unwrap_err();
        assert_ne!(err, "仅主窗口可调用此命令");
        let err_main = abe_unwrap_impl("main").unwrap_err();
        assert_ne!(err_main, "仅主窗口可调用此命令");
    }
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd apps/desktop/src-tauri && cargo test 2>&1 | tail -20
```
Expected: 编译失败（`ensure_auto_unlock_label` 未定义）或断言失败（mini 被 `仅主窗口可调用此命令` 拒绝）。

- [ ] **Step 3: 实现**

`platform_security.rs` 在 `ensure_main_window_label`（:16）之后新增：

```rust
// 解锁类命令门控（2026-10-13 spec §A）：放行 main|mini——mini 打开/聚焦时静默自动解锁与主窗
// LockScreen 同源同权（同进程同 capabilities 同用户，信任边界见 spec 诚实边界）；写/删来源类
// （protect/forget/bind/wrap/remove）与 WinAuth 导入仍走 ensure_main_window_label。
pub(crate) fn ensure_auto_unlock_label(label: &str) -> Result<(), String> {
    if label == "main" || label == "mini" {
        Ok(())
    } else {
        Err("仅主窗口或 mini 窗口可调用此命令".into())
    }
}
```

门控替换（3 处，仅「解」方向）：
- `dek_unprotect_inner`（:261）：`ensure_main_window_label(window_label)?;` → `ensure_auto_unlock_label(window_label)?;`
- keyring 分支 `os_auto_unprotect`（:320）：同上替换。
- `elevation_commands.rs` `abe_unwrap_impl`（:173）：`crate::platform_security::ensure_main_window_label(window_label)?;` → `crate::platform_security::ensure_auto_unlock_label(window_label)?;`

**不动**：`dek_protect_inner`(:247)、keyring `os_auto_protect`(:308)、`os_auto_forget`、`abe_bind_impl`(:119)、`abe_wrap_impl`(:133)、`abe_remove_impl`(:159)、`decrypt_dpapi_inner`(:80)。

注释同步（防文档漂移）：
- `platform_security.rs:283` 附近「仅主窗口可调用。」→「解锁（unprotect）main/mini 均可调用；写入（protect）仅主窗口（2026-10-13 spec §A）。」
- `platform_security.rs:6-8` 模块头「mini 恒不执行导入/解锁/安全卡操作」→「mini 仅放行解锁类命令（os_auto_unprotect/abe_unwrap，2026-10-13 spec §A）；导入/写来源/安全卡操作仍仅主窗口」。

- [ ] **Step 4: 跑测试确认通过**

```bash
cd apps/desktop/src-tauri && cargo test 2>&1 | tail -8
```
Expected: 全绿（含翻转后的两个用例与未动的 `decrypt_dpapi_inner_gating_and_shape`、`abe_bind/remove/wrap_impl_gates_mini_window`）。macOS/Linux CI 编译经 GitHub Actions 验证，本机 Windows 不编译 keyring 分支属预期。

- [ ] **Step 5: Commit**

```bash
cd F:/browser/totp && git add apps/desktop/src-tauri/src/platform_security.rs apps/desktop/src-tauri/src/elevation_commands.rs
git commit -m "feat(desktop): OS 解锁通道门控放行 mini 窗（spec §A 前置）

why: mini 快速窗锁定态打开时只能等主窗解锁，与主窗「锁定页挂载即静默
自动解锁」不一致；放宽仅『解』方向三条通道（DPAPI/keyring/ABE unwrap）
到 main|mini，写/删来源与 WinAuth 导入维持仅主窗，信任边界不变（同进程
同 capabilities，见 spec 诚实边界）。

what: 新增 ensure_auto_unlock_label(main|mini) 替换 dek_unprotect_inner、
keyring os_auto_unprotect、abe_unwrap_impl 三处门控；测试翻转 + helper
三态用例；注释同步。"
```

---

### Task 2: 前端共享静默解锁函数 attemptOsAutoUnlock

**Files:**
- Create: `packages/ui/src/components/osAutoUnlock.ts`
- Modify: `packages/ui/src/components/LockScreen.vue`（onMounted 内联逻辑改调共享函数，`silentDpapiUnlock` 删除，`onRetryDpapi`/`dpapiFailed` 保留）
- Test: Create `packages/ui/test/osAutoUnlock.test.ts`；既有 `packages/ui/test/LockScreen.test.ts` 必须不改一行全绿（行为保持的铁证）

**Interfaces:**
- Consumes: `DpapiUnlockOps`/`AbeOps` 类型（`packages/ui/src/components/securityPlatform.ts`，经 `./securityPlatform` 相对导入）；`VueStore`（`../store`）。
- Produces: `attemptOsAutoUnlock(store: VueStore, dpapi?: DpapiUnlockOps | null, abe?: AbeOps | null): Promise<boolean>`——true=已 unlockWithDek 注入解锁（宿主接 `emit('unlocked')`/刷新视图），false=静默失败（宿主维持锁定 UI）。Task 3 MiniApp 与 Task 5 前的 LockScreen 消费。

- [ ] **Step 1: 写失败测试**

`packages/ui/test/osAutoUnlock.test.ts`：

```typescript
import { describe, expect, it, vi } from 'vitest'
import { computed, ref } from 'vue'
import { randomBytes } from '@totp/core'
import { attemptOsAutoUnlock } from '../src/components/osAutoUnlock'
import type { AbeOps, DpapiUnlockOps, VueStore } from '../src/store'

function mockStore(over: Partial<VueStore> = {}): VueStore {
  return {
    abeSource: computed(() => null),
    unlockWithDek: vi.fn().mockResolvedValue(undefined),
    ...over,
  } as unknown as VueStore
}

function makeDpapi(over: Partial<DpapiUnlockOps> = {}): DpapiUnlockOps {
  return {
    label: 'Windows 自动解锁',
    techSuffix: '',
    source: computed(() => ({ wrappedDekD: 'WRAPPED' })),
    getCurrentDek: () => null,
    protect: vi.fn(),
    unprotect: vi.fn().mockResolvedValue(randomBytes(32)),
    add: vi.fn(),
    remove: vi.fn(),
    ...over,
  }
}

function makeAbe(over: Partial<AbeOps> = {}): AbeOps {
  return {
    supported: true,
    source: computed(() => ({ kind: 'abe' })),
    status: vi.fn(),
    bind: vi.fn(),
    wrap: vi.fn(),
    remove: vi.fn(),
    addSource: vi.fn(),
    removeSource: vi.fn(),
    unwrap: vi.fn().mockResolvedValue(randomBytes(32)),
    ...over,
  }
}

describe('attemptOsAutoUnlock', () => {
  it('ABE 成功：unwrap→unlockWithDek→true，不触 DPAPI', async () => {
    const dek = randomBytes(32)
    const unlockWithDek = vi.fn().mockResolvedValue(undefined)
    const dpapi = makeDpapi()
    const ok = await attemptOsAutoUnlock(mockStore({ abeSource: computed(() => ({ kind: 'abe' })), unlockWithDek }), dpapi, makeAbe({ unwrap: vi.fn().mockResolvedValue(dek) }))
    expect(ok).toBe(true)
    expect(unlockWithDek).toHaveBeenCalledWith(dek)
    expect(dpapi.unprotect).not.toHaveBeenCalled()
  })

  it('ABE 失败（null/异常/注入失败）：无声回退 DPAPI', async () => {
    const dek = randomBytes(32)
    const unlockWithDek = vi.fn()
      .mockRejectedValueOnce(new Error('inject fail'))
      .mockResolvedValueOnce(undefined)
    const store = mockStore({ abeSource: computed(() => ({ kind: 'abe' })), unlockWithDek })
    const ok = await attemptOsAutoUnlock(store, makeDpapi({ unprotect: vi.fn().mockResolvedValue(dek) }), makeAbe({ unwrap: vi.fn().mockResolvedValue(null) }))
    expect(ok).toBe(true)
    expect(store.unlockWithDek).toHaveBeenCalledTimes(2)
  })

  it('ABE 失败且 DPAPI 也失败：false 静默（不抛错）', async () => {
    const store = mockStore({ abeSource: computed(() => ({ kind: 'abe' })) })
    const ok = await attemptOsAutoUnlock(
      store,
      makeDpapi({ unprotect: vi.fn().mockRejectedValue(new Error('DPAPI 解密失败')) }),
      makeAbe({ unwrap: vi.fn().mockRejectedValue(new Error('服务不可达')) }),
    )
    expect(ok).toBe(false)
    expect(store.unlockWithDek).not.toHaveBeenCalled()
  })

  it('无 ABE 绑定：直接走 DPAPI', async () => {
    const dek = randomBytes(32)
    const abe = makeAbe({ unwrap: vi.fn() })
    const ok = await attemptOsAutoUnlock(mockStore(), makeDpapi({ unprotect: vi.fn().mockResolvedValue(dek) }), abe)
    expect(ok).toBe(true)
    expect(abe.unwrap).not.toHaveBeenCalled()
  })

  it('无任何通道/未绑定来源：false 且不发起任何调用（Review Focus 1）', async () => {
    const dpapi = makeDpapi({ source: computed(() => null) })
    const store = mockStore()
    expect(await attemptOsAutoUnlock(store, dpapi, undefined)).toBe(false)
    expect(await attemptOsAutoUnlock(store, undefined, undefined)).toBe(false)
    expect(dpapi.unprotect).not.toHaveBeenCalled()
    expect(store.unlockWithDek).not.toHaveBeenCalled()
  })

  it('abe.supported=false（非 Windows）：跳过 ABE 直接 DPAPI', async () => {
    const dek = randomBytes(32)
    const abe = makeAbe({ supported: false, unwrap: vi.fn() })
    const ok = await attemptOsAutoUnlock(mockStore({ abeSource: computed(() => ({ kind: 'abe' })) }), makeDpapi({ unprotect: vi.fn().mockResolvedValue(dek) }), abe)
    expect(ok).toBe(true)
    expect(abe.unwrap).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @totp/ui test -- osAutoUnlock 2>&1 | tail -6
```
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 helper**

`packages/ui/src/components/osAutoUnlock.ts`：

```typescript
import type { AbeOps, DpapiUnlockOps } from './securityPlatform'
import type { VueStore } from '../store'

/** OS 静默自动解锁共享编排（spec 2026-10-13 §A，原 LockScreen onMounted 内联逻辑原样抽出）：
 * ABE 优先（supported 且已绑定标记源）→ 失败无声回退 DPAPI → 两者皆败静默返回 false。
 * 供 LockScreen（主窗锁定页挂载）与 MiniApp（mini 打开/聚焦 boot，2026-10-13 §A）共用；
 * 解锁完成经 store.locked 翻转观察，成功后宿主自行 emit unlocked/切换视图。
 * DPAPI 静默失败属预期（换机/换用户），不打断手动解锁路径（重试入口由宿主渲染，I44）。 */
export async function attemptOsAutoUnlock(
  store: VueStore,
  dpapi?: DpapiUnlockOps | null,
  abe?: AbeOps | null,
): Promise<boolean> {
  if (abe?.supported && store.abeSource.value) {
    try {
      const dek = await abe.unwrap()
      if (!dek) throw new Error('ABE unwrap 不可用（服务未装/失配/不可达）')
      await store.unlockWithDek(dek)
      return true
    } catch (e) {
      console.warn('[lock] ABE 静默解锁失败，回退 OS 自动解锁通道', e)
    }
  }
  const src = dpapi?.source.value
  if (!dpapi || !src) return false
  try {
    const dek = await dpapi.unprotect(src.wrappedDekD)
    await store.unlockWithDek(dek)
    return true
  } catch {
    return false
  }
}
```

注意导入类型路径核对：`packages/ui/src/components/securityPlatform.ts` 若未从包根导出 `AbeOps`/`DpapiUnlockOps`，以 `rg -n "export (interface|type) (AbeOps|DpapiUnlockOps)" packages/ui/src` 的实际位置为准（LockScreen.vue 现以 `./securityPlatform` 导入，同路径即可）。

- [ ] **Step 4: 重构 LockScreen 用 helper**

`packages/ui/src/components/LockScreen.vue`：
1. import 区加 `import { attemptOsAutoUnlock } from './osAutoUnlock'`。
2. `onMounted`（:47-72）替换为：

```typescript
onMounted(() => {
  // 1) PRF 能力探测：仅在入口可见时执行；探测完前按钮 disabled 防用户点击
  if (showPasskey.value) {
    prfSupported()
      .then((ok) => { prfCap.value = ok })
      .catch(() => { prfCap.value = false })
  }
  // 2) 静默自动解锁（spec §A 抽至 osAutoUnlock.ts 共享）：abe 优先 dpapi 回退的序列在
  //    helper 内；此处只消费结果——成功 emit unlocked，静默失败且 DPAPI 已绑定则 1s 后
  //    暴露「重试」入口（I44，仅 DPAPI 通道与原行为一致：未绑定时不武装）
  void attemptOsAutoUnlock(props.store, props.dpapi, props.abe).then((ok) => {
    if (ok) {
      emit('unlocked')
      return
    }
    if (props.dpapi?.source.value) {
      setTimeout(() => {
        if (props.store.locked.value) dpapiFailed.value = true
      }, 1000)
    }
  })
})
```

3. 删除 `silentDpapiUnlock` 函数（:74-90）与其在 onMounted 的两处调用（已随替换消失）。`dpapiFailed`/`dpapiRetrying`/`onRetryDpapi`（:92-109）与模板不动。

- [ ] **Step 5: 跑测试确认通过**

```bash
pnpm --filter @totp/ui test 2>&1 | tail -6
```
Expected: 全绿——**特别是既有 `LockScreen.test.ts` 全部用例零改动通过**（挂载静默解锁、ABE 路径 `encryptionSession.abe.test.ts` 不受影响、I44 重试时序）。

- [ ] **Step 6: Commit**

```bash
cd F:/browser/totp && git add packages/ui/src/components/osAutoUnlock.ts packages/ui/src/components/LockScreen.vue packages/ui/test/osAutoUnlock.test.ts
git commit -m "refactor(ui): LockScreen 静默自动解锁抽共享函数 attemptOsAutoUnlock

why: mini 窗（Task 3）要与主窗锁定页同源复用静默解锁编排，内联逻辑
锁在组件 onMounted 里无法复用；行为由既有 LockScreen 测试全量锁定。

what: 新增 components/osAutoUnlock.ts（abe 优先 dpapi 回退，返回是否
解锁成功），LockScreen onMounted 改为消费结果（成功 emit、失败按 I44
武装重试）；删除组件内 silentDpapiUnlock，onRetryDpapi 保留。"
```

---

### Task 3: MiniApp 接线（desktop）

**Files:**
- Modify: `apps/desktop/src/MiniApp.vue`（setup 增 platform 装配 + load() 增解锁尝试）

**Interfaces:**
- Consumes: Task 1 的 Rust 门控（mini 可调 `os_auto_unprotect`/`abe_unwrap`）；Task 2 的 `attemptOsAutoUnlock`（`@totp/ui` 需确认包根已导出——`packages/ui/src/index.ts` 或 `components` 出口；若未导出则在该出口补 `export { attemptOsAutoUnlock } from './components/osAutoUnlock'` 一行）；`createSecurityPlatform`（`./securityPlatform`）；`desktopUaFlags`/`unlockNamingFor`（`./unlockNaming`）。

- [ ] **Step 1: 确认 `@totp/ui` 出口导出 helper**

```bash
rg -n "attemptOsAutoUnlock|LockScreen" F:/browser/totp/packages/ui/src/index.ts | head -5
```
若无 `attemptOsAutoUnlock` 导出，在 `packages/ui/src/index.ts` 的 LockScreen 导出行旁补：

```typescript
export { attemptOsAutoUnlock } from './components/osAutoUnlock'
```

- [ ] **Step 2: MiniApp.vue 装配与调用**

script setup 顶部 import 区加：

```typescript
import { attemptOsAutoUnlock, type VueStore } from '@totp/ui'  // VueStore 已有则并入既有行
import { createSecurityPlatform } from './securityPlatform'
import { desktopUaFlags, unlockNamingFor } from './unlockNaming'
```

`const { tr, mountI18n } = useDesktopI18n()`（:30）之后加（与 App.vue :56-59 同款装配，一次装配复用，不在 load() 内重建）：

```typescript
// OS 静默自动解锁通道（spec §A）：与主窗同源 createSecurityPlatform——mini 不渲染
// SecurityCard，dpapi/abe ops 仅供锁定 boot 时的 attemptOsAutoUnlock 使用（LockScreen 同款
// 静默路径）；naming 调用时求值保持 locale 响应式，与 App.vue 口径一致
const uaFlags = desktopUaFlags(navigator.userAgent)
const secPlatform = createSecurityPlatform({
  getStore: () => store.value,
  tr,
  naming: () => unlockNamingFor(uaFlags, tr),
  flags: uaFlags,
  ua: navigator.userAgent,
})
```

`load()` 内、槽复查块（`if (restoredFromSlot && !s.locked.value) { ... }`，:70-73）之后、`useTheme(s)` 之前加：

```typescript
    // spec §A：槽空仍锁定 → OS 静默自动解锁（对齐主窗 LockScreen 挂载行为）。失败静默维持
    // 锁定空态（mini.lockedNote），下次聚焦 load() 重试；打开/聚焦两条路径均汇于本 load()
    if (s.locked.value) void attemptOsAutoUnlock(s, secPlatform.dpapi, secPlatform.abe)
```

- [ ] **Step 3: 类型检查与回归**

```bash
pnpm typecheck 2>&1 | tail -5
pnpm --filter @totp/desktop test 2>&1 | tail -4
```
Expected: 根 typecheck 无错误；desktop vitest 全绿。

说明：MiniApp 为重 Tauri 依赖组件，不为 3 行接线搭 mount 桩（spec 测试行按此落地：行为由 Task 2 helper 测试 + 真机 DPAPI 验收覆盖，属对 spec 的最小偏离，执行者无需额外补桩）。

- [ ] **Step 4: Commit**

```bash
cd F:/browser/totp && git add apps/desktop/src/MiniApp.vue packages/ui/src/index.ts
git commit -m "feat(desktop): mini 窗锁定态打开/聚焦时静默自动解锁（spec §A）

why: mini 与主窗同源一套 OS 自动解锁通道（门控已放宽），此前 mini 只
能等主窗解锁经槽跟随，主窗自动锁定后 mini 完全不可用。

what: MiniApp setup 装配 createSecurityPlatform（复用主窗工厂），load()
boot 后仍锁定即调 attemptOsAutoUnlock（槽 peek 之后的第二通道）；失败
维持既有 lockedNote 空态，零新增 i18n。"
```

---

### Task 4: popupFilterRowAffix 纯函数 + popup 过滤行内联（spec §C）

**Files:**
- Modify: `packages/ui/src/popupFilter.ts`（文件尾追加类型 + 函数）
- Modify: `apps/extension/entrypoints/popup/App.vue`（script 加 computed、模板 :350-356 重排、style 加 ellipsis）
- Test: Modify `packages/ui/test/popupFilter.test.ts`（追加 describe）

**Interfaces:**
- Consumes: 既有 `PopupFilterResult`（`popupFilter.ts:22-28`，含 `hint: string`、`urlMatchCount: number`）。
- Produces: `type PopupRowAffix = { kind: 'hint'; key: string } | { kind: 'matchCount'; count: number } | null` 与 `popupFilterRowAffix(result: PopupFilterResult, filterOn: boolean): PopupRowAffix`。popup App.vue 的 `rowAffix` computed 消费。

- [ ] **Step 1: 写失败测试（追加到 `packages/ui/test/popupFilter.test.ts` 文件尾）**

```typescript
import { popupFilterRowAffix } from '../src/popupFilter'  // 并入文件头既有 import

describe('popupFilterRowAffix（spec §C：过滤行行内缀三态）', () => {
  const base = { visible: [], urlMatchCount: 0 } as const
  it('有 hint：hint 优先（与匹配数互斥）', () => {
    expect(popupFilterRowAffix({ ...base, hint: 'popupFilter.hintSitePlain', urlMatchCount: 0 }, true))
      .toEqual({ kind: 'hint', key: 'popupFilter.hintSitePlain' })
    expect(popupFilterRowAffix({ ...base, hint: 'popupFilter.hintTagRelaxed', urlMatchCount: 3 }, true))
      .toEqual({ kind: 'hint', key: 'popupFilter.hintTagRelaxed' })
  })
  it('无 hint 且开启站点过滤且有命中：匹配数', () => {
    expect(popupFilterRowAffix({ ...base, hint: '', urlMatchCount: 3 }, true))
      .toEqual({ kind: 'matchCount', count: 3 })
  })
  it('无 hint、未开过滤或零命中：null（行内不渲染）', () => {
    expect(popupFilterRowAffix({ ...base, hint: '', urlMatchCount: 0 }, true)).toBeNull()
    expect(popupFilterRowAffix({ ...base, hint: '', urlMatchCount: 3 }, false)).toBeNull()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @totp/ui test -- popupFilter 2>&1 | tail -5
```
Expected: FAIL（popupFilterRowAffix 未导出）。

- [ ] **Step 3: 实现纯函数（`popupFilter.ts` 文件尾追加）**

```typescript
/** 过滤行行内缀（spec 2026-10-13 §C）：回退 hint 与「匹配 N 条」同位互斥渲染的数据源。
 * hint 优先（无匹配回退语义压过命中计数）；无 hint 且开启站点过滤且有命中 → 匹配数；
 * 其余 null（行内不渲染）。独立 hint 行仅剩 !tabUrl 场景（渲染端门控）。 */
export type PopupRowAffix = { kind: 'hint'; key: string } | { kind: 'matchCount'; count: number } | null

export function popupFilterRowAffix(result: PopupFilterResult, filterOn: boolean): PopupRowAffix {
  if (result.hint) return { kind: 'hint', key: result.hint }
  if (filterOn && result.urlMatchCount > 0) return { kind: 'matchCount', count: result.urlMatchCount }
  return null
}
```

出口核对（Step 3 之前先跑）：

```bash
rg -n "popupFilter" F:/browser/totp/packages/ui/src/index.ts
```
若为 `export * from './popupFilter'` 则新导出自动可用；若为逐名字具名导出，补 `export { popupFilterRowAffix } from './popupFilter'` 并在 Step 6 commit 一并 `git add packages/ui/src/index.ts`（popup App.vue :3 从 `@totp/ui` 包根导入）。

- [ ] **Step 4: popup App.vue 接线**

`apps/extension/entrypoints/popup/App.vue`：
1. import（:3 的 `@totp/ui` 命名导入）加入 `popupFilterRowAffix`（按字母序并入既有清单）。
2. script 中 `const visible = computed(...)`（:149）之后加：

```typescript
/** 过滤行行内缀（spec §C）：回退 hint 与「匹配 N 条」同位互斥 */
const rowAffix = computed(() => popupFilterRowAffix(filterResult.value, filterOn.value))
```

3. 模板 :350-356 替换为：

```html
    <!-- URL 过滤行留在面板上方（宿主管辖）：行内缀 = 回退 hint 与「匹配 N 条」同位互斥（spec §C） -->
    <div class="filter-row" v-if="tabUrl">
      <!-- M3 MdCheckbox(审查 X10):原 UA 原生 checkbox 深色 scheme 下未选中即深灰填充,即「复选框底色偏深」根因 -->
      <MdCheckbox :model-value="filterOn" :label="t('popup.filterBySite')" @update:model-value="toggleFilter" />
      <span v-if="rowAffix" class="hint row-affix" :title="rowAffix.kind === 'hint' ? t(rowAffix.key) : undefined">
        {{ rowAffix.kind === 'hint' ? t(rowAffix.key) : t('popup.matchCount', { count: rowAffix.count }) }}
      </span>
    </div>
    <!-- 独立 hint 行仅剩无 tabUrl 场景（读不到当前标签页时过滤行不存在，回退提示仍须可达） -->
    <span v-if="!tabUrl && filterResult.hint" class="hint hint-row">{{ t(filterResult.hint) }}</span>
```

4. style 尾部（`.hint-row` 规则后）加：

```css
/* 行内缀（spec §C）：ellipsis 防极端 i18n 长串把过滤行撑出横向滚动（popup 360px 窄幅） */
.row-affix { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
```

- [ ] **Step 5: 跑测试确认通过**

```bash
pnpm --filter @totp/ui test -- popupFilter 2>&1 | tail -4 && pnpm --filter @totp/extension test 2>&1 | tail -4
```
Expected: 两包全绿。

- [ ] **Step 6: Commit**

```bash
cd F:/browser/totp && git add packages/ui/src/popupFilter.ts packages/ui/test/popupFilter.test.ts apps/extension/entrypoints/popup/App.vue
git commit -m "feat(extension): popup 站点无匹配回退提示收进过滤行（spec §C）

why: 「当前站点无匹配，显示全部」等回退提示单独占一行，popup 360px
窄幅下浪费纵向空间；条目本身无匹配时已回退显示全部，仅提示位置要收。

what: popupFilter 增纯函数 popupFilterRowAffix（hint 与匹配数同位互斥，
三态单测），popup 模板据此渲染行内缀并加 ellipsis；独立 hint 行收敛到
无 tabUrl 场景；resolvePopupVisible 编排零改动，i18n 零新增。"
```

---

### Task 5: LockScreen 增 passkeyMode / autoPasskey

**Files:**
- Modify: `packages/ui/src/components/LockScreen.vue`
- Test: Modify `packages/ui/test/LockScreen.test.ts`（追加 3 用例）

**Interfaces:**
- Produces: props `passkeyMode?: 'inline' | 'external'`（默认 `'inline'`）、`autoPasskey?: boolean`（默认 `false`）；emit 增 `(e: 'external-unlock'): void`。Task 6 的 popup（external）与 unlock 页（inline + autoPasskey）消费。

- [ ] **Step 1: 写失败测试（追加到 LockScreen.test.ts 主 describe 之后）**

```typescript
describe('LockScreen passkeyMode / autoPasskey（spec §B）', () => {
  it("passkeyMode='external'：点击仅 emit external-unlock，不执行 inline WebAuthn", async () => {
    const store = mockStore({
      prfSources: computed(() => [{ credentialId: 'Y3JlZC0x', salt: 'cw==' }]),
      securitySettings: ref(null),
    })
    const w = mount(LockScreen, { props: { store, passkeyMode: 'external' }, global: { plugins: [createTestI18n()] } })
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 5))
    await w.find('button.passkey').trigger('click')
    expect(w.emitted('external-unlock')).toHaveLength(1)
    expect(w.emitted('unlocked')).toBeUndefined()
    expect((navigator as unknown as { credentials?: unknown }).credentials).toBeUndefined()
  })

  it('autoPasskey：PRF 探测通过后自动发起一次（等价点击，走完整解锁链）', async () => {
    const { security, dek, prfOutput, salt } = await prfFixture()
    const unlockWithDek = vi.fn().mockResolvedValue(undefined)
    const store = mockStore({
      prfSources: computed(() => [{ credentialId: 'Y3JlZC0x', salt }]),
      securitySettings: ref(security),
      unlockWithDek,
    })
    mockWebAuthnGet([prfOutput])
    mount(LockScreen, { props: { store, autoPasskey: true }, global: { plugins: [createTestI18n()] } })
    const getCred = (navigator as unknown as { credentials: { get: ReturnType<typeof vi.fn> } }).credentials.get
    await vi.waitFor(() => expect(getCred).toHaveBeenCalled(), { timeout: 2000, interval: 5 })
    await vi.waitFor(() => expect(unlockWithDek).toHaveBeenCalledWith(dek))
  })

  it('autoPasskey：PRF 能力 false 时不自动发起（Review Focus 2），无绑定来源也不发起', async () => {
    const Stub = class {
      static isUserVerifyingPlatformAuthenticatorAvailable = vi.fn().mockResolvedValue(false)
      static getClientCapabilities = vi.fn().mockResolvedValue({ prf: false })
    }
    Object.defineProperty(globalThis, 'PublicKeyCredential', { configurable: true, value: Stub, writable: true })
    const { security, salt } = await prfFixture()
    const getSpy = vi.fn()
    ;(navigator as unknown as { credentials: unknown }).credentials = { get: getSpy }
    mount(LockScreen, {
      props: { store: mockStore({ prfSources: computed(() => [{ credentialId: 'Y3JlZC0x', salt }]), securitySettings: ref(security) }), autoPasskey: true },
      global: { plugins: [createTestI18n()] },
    })
    mount(LockScreen, {
      props: { store: mockStore({ prfSources: computed(() => []), securitySettings: ref(null) }), autoPasskey: true },
      global: { plugins: [createTestI18n()] },
    })
    await new Promise((r) => setTimeout(r, 60))
    expect(getSpy).not.toHaveBeenCalled()
    stubPrfSupported() // 恢复全局 stub 供后续用例
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @totp/ui test -- LockScreen 2>&1 | tail -5
```
Expected: 新 3 用例 FAIL（点击触发 inline 解锁而非 emit；autoPasskey 不生效）。

- [ ] **Step 3: 实现**

`packages/ui/src/components/LockScreen.vue`：
1. props 类型（:14-25）追加两成员、withDefaults（:27）补默认：

```typescript
    /** [可选] Passkey 入口形态（spec §B）：inline=组件内直接跑 WebAuthn（desktop/options 默认）；
     *  external=点击仅 emit external-unlock——popup 失焦即销毁，认证在宿主打开的独立解锁窗完成。
     *  两形态的按钮显隐/禁用逻辑一致（prfSources 非空 + 能力探测） */
    passkeyMode?: 'inline' | 'external'
    /** [可选] 挂载后自动发起一次 Passkey 解锁（unlock.html?unlock=passkey 专用）：PRF 能力探测为
     *  true 且入口可见时触发一次（与用户点击同一 onPasskeyUnlock 通道）；探测 false/无绑定不触发 */
    autoPasskey?: boolean
```

```typescript
  { allowPasskey: true, passkeyMode: 'inline', autoPasskey: false },
```

2. emits（:30）改为：

```typescript
const emit = defineEmits<{ (e: 'unlocked'): void; (e: 'external-unlock'): void }>()
```

3. `passkeySupported` computed（:45）之后加自动发起 watch 与点击分派：

```typescript
/** autoPasskey 自动发起（spec §B）：能力探测落定为 true 且入口可见时触发一次；autoFired 防
 *  prfCap 抖动/重探测导致二次弹窗。探测 false 或无绑定（showPasskey=false 不探测）永不触发 */
let autoPasskeyFired = false
watch(prfCap, (cap) => {
  if (!props.autoPasskey || autoPasskeyFired || cap !== true || !showPasskey.value) return
  autoPasskeyFired = true
  void onPasskeyUnlock()
})

/** 按钮点击分派：external 模式不上抛 WebAuthn（popup 夺焦销毁），交宿主开解锁窗 */
function onPasskeyClick(): void {
  if (props.passkeyMode === 'external') {
    emit('external-unlock')
    return
  }
  void onPasskeyUnlock()
}
```

（`watch` 并入 :3 的 vue import。）

4. 模板 passkey 按钮（:188）`@click="onPasskeyUnlock"` → `@click="onPasskeyClick"`。

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm --filter @totp/ui test 2>&1 | tail -4
```
Expected: 全绿（既有用例不受默认值影响）。

- [ ] **Step 5: Commit**

```bash
cd F:/browser/totp && git add packages/ui/src/components/LockScreen.vue packages/ui/test/LockScreen.test.ts
git commit -m "feat(ui): LockScreen 增 passkeyMode/autoPasskey 支撑 popup 解锁窗（spec §B）

why: popup 内 inline WebAuthn 因认证器夺焦销毁窗口恒失败（3af7bf3 门控
隐藏）；方案 A 需宿主（popup）接管入口点击、解锁窗自动发起，LockScreen
需暴露两种形态而显隐/禁用逻辑共用。

what: passkeyMode=external 时点击仅 emit external-unlock；autoPasskey
在能力探测通过后自动发起一次 onPasskeyUnlock；默认值保持 desktop/options
行为不变，新增 3 用例。"
```

---

### Task 6: unlock 入口页 + popup 接线（extension）

**Files:**
- Create: `apps/extension/entrypoints/unlock/index.html`
- Create: `apps/extension/entrypoints/unlock/main.ts`
- Create: `apps/extension/entrypoints/unlock/App.vue`
- Modify: `apps/extension/entrypoints/popup/App.vue`（LockScreen props 与 @external-unlock 接线）
- Test: Create `apps/extension/src/unlockWindow.test.ts`

**Interfaces:**
- Consumes: Task 5 的 `passkeyMode`/`autoPasskey`/`external-unlock`；`createExtensionStore`（`../../src/store`）、`createDekSession`（`../../src/dekSession`）；`ext`（`../../src/extApi`，chrome.windows.create / runtime.getURL，无新权限）。
- Produces: 可路由产物 `unlock.html`（WXT 无列表页，manifest 零声明）；popup 的 `openUnlockWindow()`。

- [ ] **Step 1: 写失败测试（`apps/extension/src/unlockWindow.test.ts`）**

关键约束：vi.mock 工厂会被提升到文件顶、且在测试文件模块体求值**之前**因 `import App` 触发执行——工厂内不得引用模块体 `let/const`（TDZ），跨工厂共享的桩用 `vi.hoisted`；`ref` 在工厂内 `await import('vue')` 取（工厂执行时 vue 已求值）。

```typescript
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent } from 'vue'
import { mount } from '@vue/test-utils'

const { closeMock, initStoreMock, stubProps } = vi.hoisted(() => ({
  closeMock: vi.fn(),
  initStoreMock: vi.fn(),
  stubProps: {} as Record<string, unknown>,
}))
Object.defineProperty(window, 'close', { value: closeMock, writable: true, configurable: true })

// unlock 页对宿主模块的全部依赖打桩：store 工厂（locked 用真 ref 供模板响应）/ dekSession /
// @totp/ui（LockScreen 用点击 emit unlocked 的桩替代，i18n 桩带 install 防 Vue 告警）。
// __testLocked 导出供测试翻转锁定态（App 只解构 initStore/locked，多余导出无碍）
vi.mock('./store', async () => {
  const { ref } = await import('vue')
  const locked = ref(true)
  return {
    __testLocked: locked,
    createExtensionStore: vi.fn(() => ({ initStore: initStoreMock, locked })),
    persistFailed: ref(false),
    storageAdapter: {},
  }
})
vi.mock('./dekSession', () => ({
  createDekSession: () => ({ get: async () => null, set: async () => {}, clear: async () => {} }),
}))
vi.mock('@totp/ui', () => ({
  createAppI18n: () => ({ install() {}, global: { t: (k: string) => k } }),
  useTheme: vi.fn(),
  LockScreen: defineComponent({
    props: { store: { type: Object, required: true }, autoPasskey: { type: Boolean, default: false } },
    emits: ['unlocked'],
    setup(props) {
      for (const k of Object.keys(stubProps)) delete stubProps[k]
      Object.assign(stubProps, props)
      return () => window.document.createElement('div')
    },
    template: '<button data-test="stub-unlock" @click="$emit(\'unlocked\')"></button>',
  }),
}))

import App from '../entrypoints/unlock/App.vue'
import { __testLocked } from './store'

describe('unlock 解锁窗 App（spec §B）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    initStoreMock.mockResolvedValue(undefined)
    __testLocked.value = true
    window.history.replaceState(null, '', '/')
  })

  const mountApp = async () => {
    const w = mount(App)
    await new Promise((r) => setTimeout(r, 0))
    return w
  }

  it('boot 已解锁（session DEK 在）：立即自关，不渲染锁屏（Review Focus 3）', async () => {
    __testLocked.value = false
    const w = await mountApp()
    expect(closeMock).toHaveBeenCalled()
    expect(w.find('[data-test="stub-unlock"]').exists()).toBe(false)
  })

  it('锁定态：渲染 LockScreen，?unlock=passkey 时透传 autoPasskey=true', async () => {
    window.history.replaceState(null, '', '/?unlock=passkey')
    const w = await mountApp()
    expect(closeMock).not.toHaveBeenCalled()
    expect(w.find('[data-test="stub-unlock"]').exists()).toBe(true)
    expect(stubProps.autoPasskey).toBe(true)
  })

  it('解锁成功（unlocked 事件）：window.close 自关', async () => {
    const w = await mountApp()
    await w.find('[data-test="stub-unlock"]').trigger('click')
    expect(closeMock).toHaveBeenCalledTimes(1)
  })

  it('boot 异常：自关回退 popup 口令路径，不留死窗', async () => {
    initStoreMock.mockRejectedValueOnce(new Error('storage broken'))
    await mountApp()
    expect(closeMock).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @totp/extension test -- unlockWindow 2>&1 | tail -5
```
Expected: FAIL（`../entrypoints/unlock/App.vue` 不存在）。

- [ ] **Step 3: 创建 unlock 入口三件套**

`apps/extension/entrypoints/unlock/index.html`（popup 同款主题防闪，无 360px 定宽——窗尺寸由 windows.create 决定）：

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <script src="/theme-seed.js"></script>
    <!-- 首帧防闪：与 tokens.css 默认种子 light/dark surface 值一致（popup/index.html 同款） -->
    <style>html { background: #fefbff } html[data-mode='dark'] { background: #1b1b1f } @media (prefers-color-scheme: dark) { html[data-mode='auto'] { background: #1b1b1f } }</style>
    <meta charset="UTF-8" />
    <title>TOTP</title>
  </head>
  <body style="margin: 0">
    <div id="app"></div>
    <script type="module" src="./main.ts"></script>
  </body>
</html>
```

`apps/extension/entrypoints/unlock/main.ts`：

```typescript
import { createApp } from 'vue'
import '@totp/ui/src/theme/tokens.css'
import App from './App.vue'

// WXT 无列表页：entrypoints/unlock/index.html → 构建产物 unlock.html，manifest 零声明。
// i18n 由 App.vue 内 createAppI18n(store) 装入（options 同款，store 为本页独立实例）
createApp(App).mount('#app')
```

`apps/extension/entrypoints/unlock/App.vue`：

```vue
<script setup lang="ts">
import { createAppI18n, LockScreen, useTheme } from '@totp/ui'
import { getCurrentInstance, onMounted } from 'vue'
import { createDekSession } from '../../src/dekSession'
import { createExtensionStore, persistFailed } from '../../src/store'

// spec §B（方案 A）：独立解锁窗——popup 失焦即销毁，WebAuthn 认证须在真窗口完成；成功写
// session DEK（createDekSession 共享区）后自关，重开 popup 即免密。windowId='unlock' 独立
// 会话与 popup/options 隔离；PersistErrorBanner 不渲染（本页无写路径，persistFailed 仅为
// createExtensionStore 宿主接线占位消费）
const store = createExtensionStore('unlock', {
  dekPersist: createDekSession(),
  onPersistError: (e) => {
    console.error('[store] persist failed:', e)
    persistFailed.value = true
  },
})
const { initStore, locked } = store
// D1 i18n：本组件 setup 创建 store，同 options 口径装入 app 供 LockScreen 的 useI18n
const i18n = createAppI18n(store)
getCurrentInstance()?.appContext.app.use(i18n)
/** ?unlock=passkey → LockScreen 挂载后自动发起一次 PRF 求值（popup 点击入口的续场） */
const autoPasskey = new URLSearchParams(window.location.search).get('unlock') === 'passkey'

onMounted(async () => {
  try {
    await initStore()
    useTheme(store)
    document.title = i18n.global.t('lock.title')
  } catch (e) {
    // boot 异常（storage 不可用等）：自关回退 popup 口令路径，不留死窗
    console.error('[unlock] boot failed:', e)
    window.close()
    return
  }
  // 已解锁（session DEK 恢复 / 未加密库）：无事可做，立即自关
  if (!locked.value) window.close()
})

function onUnlocked(): void {
  window.close()
}
</script>

<template>
  <LockScreen v-if="locked" :store="store" :auto-passkey="autoPasskey" @unlocked="onUnlocked" />
</template>
```

- [ ] **Step 4: popup 接线**

`apps/extension/entrypoints/popup/App.vue`：
1. 模板 :330 改为：

```html
  <LockScreen v-if="locked" :store="store" passkey-mode="external" @external-unlock="openUnlockWindow" />
```

2. script（`openSettings` 函数 :53 之后）加：

```typescript
/** Passkey 解锁（spec §B 方案 A）：popup 失焦即销毁、WebAuthn 认证须在真窗口完成——开
 * 独立解锁窗自动发起 PRF，成功自关后重开 popup 经 session DEK 免密。本 popup 随窗口失焦
 * 销毁属预期流程，不做回流（action.openPopup 受限不可编程重开） */
function openUnlockWindow(): void {
  try {
    void ext!.windows.create({
      url: ext!.runtime.getURL('unlock.html?unlock=passkey'),
      type: 'popup',
      width: 400,
      height: 560,
    })
  } catch (e) {
    console.warn('[popup] 打开解锁窗口失败', e)
  }
}
```

- [ ] **Step 5: 跑测试 + 构建断言**

```bash
pnpm --filter @totp/extension test 2>&1 | tail -4
pnpm --filter @totp/extension exec wxt prepare && pnpm typecheck 2>&1 | tail -4
pnpm --filter @totp/extension exec wxt build -b firefox 2>&1 | tail -3
ls F:/browser/totp/apps/extension/.output/firefox-mv3/unlock.html
```
Expected: 测试全绿；typecheck 无错；`unlock.html` 存在于 Firefox 产物（WXT 自动把非保留名目录当无列表页，无需配置变更；若构建产物缺失，检查目录名是否为 `unlock`）。

- [ ] **Step 6: Commit**

```bash
cd F:/browser/totp && git add apps/extension/entrypoints/unlock apps/extension/entrypoints/popup/App.vue apps/extension/src/unlockWindow.test.ts
git commit -m "feat(extension): popup Passkey 解锁经独立解锁窗完成（spec §B 方案A）

why: popup 失焦即销毁，WebAuthn 认证器弹窗夺焦即中断 get()，Passkey
入口在 popup 恒失败（3af7bf3 门控隐藏）；真窗口中认证可正常完成，成功
写 session DEK 后重开 popup 即免密。

what: 新增 WXT 无列表页 unlock.html（windowId='unlock' 独立会话，boot
已解锁/成功/异常即自关，?unlock=passkey 自动发起 PRF）；popup LockScreen
改 external 形态，点击 windows.create 开 400×560 解锁窗；新增 4 用例 +
Firefox 构建产物断言。"
```

---

### Task 7: 文档（CHANGELOG + README 中英）与全量验证

**Files:**
- Modify: `CHANGELOG.md`（`## [未发布]` 小节）
- Modify: `README.md` / `README_en.md`（对应特性小节）

- [ ] **Step 1: CHANGELOG `## [未发布]` 下追加**

```markdown
### 新增

- **桌面版：mini 快速窗打开/聚焦时自动解锁**。此前主窗口经 OS 自动解锁（Windows DPAPI / macOS 钥匙串 / Linux 密钥环 / ABE 服务）锁定页静默解锁，mini 快速窗只能等主窗口解锁后跟随；现 mini 打开或聚焦时同样静默解锁，两端行为一致。未启用 OS 自动解锁时 mini 仍显示「主窗口解锁后此窗口可用」
- **扩展（Chrome/Firefox）：popup 弹出框新增 Passkey 解锁入口**。popup 因认证器弹窗夺焦即销毁窗口、无法就地完成 WebAuthn 验证，现点击「使用 Passkey 解锁」会打开独立解锁窗口自动发起验证，成功后窗口自动关闭，重新打开 popup 即已解锁；口令解锁入口保持不变，验证取消/失败时可在解锁窗重试或改用口令
- **扩展（Chrome/Firefox）：popup 站点过滤无匹配时的提示移入过滤行**。「当前站点无匹配，显示全部」等回退提示不再单独占一行，与「匹配 N 条」同位显示，验证码列表纵向空间更大（无匹配时仍回退显示全部条目，行为不变）
```

- [ ] **Step 2: README 中英同步**

- `README.md`「安全」章节 Passkey 小节（:125-128 锚点「**Passkey 解锁（PRF 扩展）**」列表尾）追加一条：

```markdown
  - 扩展 popup 弹出框同样提供「使用 Passkey 解锁」：点击后打开独立解锁窗口自动发起验证（popup 窗口失焦即销毁，认证须在真窗口完成），成功后窗口自动关闭，重新打开 popup 即已解锁
```

- `README.md` :48 行「解锁方式（口令 / Passkey / 原生自动解锁）」后如无补充则不动；「原生自动解锁（仅桌面版）」小节（:131-132）末尾追加：

```markdown
  - mini 快速窗与主窗口同权：锁定态打开或聚焦 mini 时同样静默自动解锁（未启用 OS 自动解锁时仍提示需主窗口解锁）
```

- `README_en.md` 对应两节（`Passkey unlock (PRF extension)` 与 `Native auto-unlock (desktop only)` 锚点，以 `rg -n "Passkey unlock|Native auto-unlock" README_en.md` 定位）追加同义英文两条。

- [ ] **Step 3: 全量验证**

```bash
pnpm test 2>&1 | tail -6
cd apps/desktop/src-tauri && cargo test 2>&1 | tail -3
pnpm typecheck 2>&1 | tail -3
```
Expected: 全绿。手动验收（不在本计划自动化范围）：① Windows 真机启用 OS 自动解锁 → 主窗锁定 → alt+shift+t 开 mini → 静默出码；② Chrome/Firefox 加载扩展 → 绑定 Passkey → 锁定 → popup 点击 → 解锁窗 UV → 自关 → 重开 popup 免密。

- [ ] **Step 4: Commit**

```bash
cd F:/browser/totp && git add CHANGELOG.md README.md README_en.md
git commit -m "docs: 三特性用户可见变更落 CHANGELOG 未发布小节与 README 中英同步

why: mini 自动解锁、popup Passkey 解锁窗、站点提示收行为用户可见变更，
随下个版本发布需进 release 自动截取与商店文案基线。

what: CHANGELOG 未发布小节三条新增；README 中英各补 popup Passkey 入
口与 mini 自动解锁说明。"
```
