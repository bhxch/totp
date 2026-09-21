# 跨端同步（扩展端跟随）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 桌面端推送维持现状；扩展端在**解锁前台**跟随云端——popup/options 打开或解锁完成时即时拉取，options 存活期 3 分钟轻轮询，锁定态零网络行为。

**Architecture:** 新共享模块 `apps/extension/src/syncScheduler.ts` 封装「解锁态下拉取调度」（popup 以 `pullOnStart` 模式使用、options 以 `pullOnStart + interval` 模式使用，避免双 interval 并发）；拉取执行复用既有 `createCloudSyncRunner` 与 `syncOrchestrator`（云端胜出+冲突副本语义不变）。设置开关 `syncPrefs.autoFollow` 归一化进 core `loadSettings`。

**Tech Stack:** WXT/Chrome 扩展 MV3、vitest（apps/extension 既有测试栈）。

**Spec:** `docs/superpowers/specs/2026-09-21-cross-device-sync-design.md`（注意其「方案修正」节：一期不做 chrome.alarms 后台检查——锁定态 SW 无凭据无 DEK）

## Global Constraints

- 锁定态（无 DEK）**禁止任何云盘网络请求**；凭据仅在解锁态经 DEK 保管区读取。
- 不把云盘凭据写入 `chrome.storage.session`（spec 非目标，安全评审未做）。
- 冲突语义沿用 `syncOrchestrator`（远端新+本地变 → 云端胜出 + 本地加密冲突副本），不新增冲突逻辑。
- 轮询间隔默认 3 分钟；开关关闭时退回纯手动。
- 已知接受风险（记录用）：popup 打开拉取与 options interval 极小概率并发 → orchestrator 兜底语义可容忍，一期不做跨 context 锁。

---

### Task 1: 共享调度模块 syncScheduler

**Files:**
- Create: `apps/extension/src/syncScheduler.ts`
- Create: `apps/extension/src/syncScheduler.test.ts`

**Interfaces:**
- Consumes: options 页现有 `createCloudSyncRunner` 依赖集合（`storageAdapter`、cloud cred 读取、`t` 注入等——实现时以 `options/App.vue` 现有 runner 创建代码为准整体搬移）
- Produces: `createSyncScheduler(deps: SyncSchedulerDeps): SyncScheduler`；

```ts
export interface SyncSchedulerDeps {
  isUnlocked(): boolean
  /** 解锁状态翻转通知（false→true 边沿触发 syncNow） */
  onUnlocked(cb: () => void): () => void
  runPull(): Promise<unknown>   // 既有 cloudSync.run('pull') 或整体 run——按现有 runner 模式
  /** 自动跟随开关（core settings.syncPrefs.autoFollow，Task 3 接入前可恒 true） */
  autoFollowEnabled(): boolean
  intervalMs(): number | null   // popup 传 null；options 传 180_000（开关开启时）
  onError(err: unknown): void
}
export interface SyncScheduler {
  start(): void   // 启动轮询（若 intervalMs 非 null）+ 注册解锁钩子
  stop(): void    // 清 interval 与钩子（popup/options 卸载时）
  syncNow(): Promise<void>  // 解锁态才执行；锁定静默跳过
}
```

- [ ] **Step 1: 写失败测试**

`syncScheduler.test.ts`：

```ts
import { describe, expect, it, vi } from 'vitest'
import { createSyncScheduler } from './syncScheduler'

function makeDeps(overrides: Partial<Parameters<typeof createSyncScheduler>[0]> = {}) {
  const unlockCbs: Array<() => void> = []
  return {
    deps: {
      isUnlocked: vi.fn(() => true),
      onUnlocked: (cb: () => void) => { unlockCbs.push(cb); return () => {} },
      runPull: vi.fn().mockResolvedValue(undefined),
      autoFollowEnabled: vi.fn(() => true),
      intervalMs: () => null,
      onError: vi.fn(),
      ...overrides,
    },
    fireUnlock: () => unlockCbs.forEach((cb) => cb()),
  }
}

describe('syncScheduler', () => {
  it('解锁边沿触发 syncNow', async () => {
    const { deps, fireUnlock } = makeDeps()
    const s = createSyncScheduler(deps)
    s.start()
    fireUnlock()
    await vi.waitFor(() => expect(deps.runPull).toHaveBeenCalledOnce())
  })

  it('锁定态 syncNow 与解锁钩子均不触发网络', async () => {
    const { deps, fireUnlock } = makeDeps({ isUnlocked: vi.fn(() => false) })
    const s = createSyncScheduler(deps)
    s.start()
    await s.syncNow()
    fireUnlock()
    await new Promise((r) => setTimeout(r, 0))
    expect(deps.runPull).not.toHaveBeenCalled()
  })

  it('开关关闭：钩子与轮询均不动作', async () => {
    const { deps, fireUnlock } = makeDeps({ autoFollowEnabled: vi.fn(() => false) })
    const s = createSyncScheduler(deps)
    s.start()
    fireUnlock()
    await s.syncNow()
    expect(deps.runPull).not.toHaveBeenCalled()
  })

  it('interval 到点触发拉取，stop 后停止', async () => {
    vi.useFakeTimers()
    const { deps } = makeDeps({ intervalMs: () => 180_000 })
    const s = createSyncScheduler(deps)
    s.start()
    await vi.advanceTimersByTimeAsync(180_000)
    expect(deps.runPull).toHaveBeenCalledOnce()
    s.stop()
    await vi.advanceTimersByTimeAsync(360_000)
    expect(deps.runPull).toHaveBeenCalledOnce() // 不再增长
    vi.useRealTimers()
  })

  it('runPull 抛错走 onError 不中断调度', async () => {
    const { deps, fireUnlock } = makeDeps({ runPull: vi.fn().mockRejectedValue(new Error('boom')) })
    const s = createSyncScheduler(deps)
    s.start()
    fireUnlock()
    await vi.waitFor(() => expect(deps.onError).toHaveBeenCalled())
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `cd apps/extension && pnpm test -- syncScheduler`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

`syncScheduler.ts` 按上述接口实现：`start()` 注册 `onUnlocked` 回调（边沿且 `isUnlocked() && autoFollowEnabled()` 时 `void syncNow()`）+ `intervalMs()` 非 null 时 `setInterval(() => void syncNow(), ms)`；`syncNow()` 先查 `isUnlocked() && autoFollowEnabled()`，未过 gate 直接 return，过则 `await runPull()`，try/catch 走 `onError`；并发防抖：in-flight 标志，进行中重入直接跳过。

- [ ] **Step 4: 运行确认通过**

Run: `cd apps/extension && pnpm test -- syncScheduler`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/extension/src/syncScheduler.ts apps/extension/src/syncScheduler.test.ts
git commit -m "feat(ext): 解锁前台云同步跟随调度模块（验收条目2）"
```

### Task 2: popup 与 options 接线

**Files:**
- Modify: `apps/extension/entrypoints/popup/App.vue`（onMounted/解锁 watch + onScopeDispose）
- Modify: `apps/extension/entrypoints/options/App.vue`（既有 runner+scheduler 改经 syncScheduler，或保留 runner 仅将调度切换为该模块——以改动最小、行为一致为准）

**Interfaces:**
- Consumes: `createSyncScheduler`（Task 1）、popup 既有 `locked` 状态、options 既有 `cloudSync` runner
- Produces: 无新接口

- [ ] **Step 1: popup 接线**

popup/App.vue setup 段：

```ts
const sync = createSyncScheduler({
  isUnlocked: () => !locked.value,            // 以 popup 实际锁定 ref 为准
  onUnlocked: (cb) => watch(locked, (v) => { if (!v) cb() }),
  runPull: () => cloudSyncRef.current!.run(), // popup 侧 runner 实例来源见 Step 2 说明
  autoFollowEnabled: () => settings.value?.syncPrefs?.autoFollow !== false,
  intervalMs: () => null,                     // popup 不跑 interval
  onError: (e) => console.warn('[syncFollow]', e),
})
onMounted(() => sync.start())
onScopeDispose(() => sync.stop())
```

popup 侧 runner 来源二选一（实现时按现状择一并在 PR 描述记录）：
a) popup 已有等价 cloud runner → 直接用；
b) 无 → 从 `syncScheduler.ts` 导出 `createExtensionCloudRunner(deps)`（整体搬移 options 的 runner 创建代码），popup 与 options 共用该工厂。**注意 deps 中的 i18n `t` 注入在 popup 用 `useI18n` 的 `t`**。

- [ ] **Step 2: options 接线**

options 改为经 `createSyncScheduler` 调度（`intervalMs: () => cloudAutoPrefs.onInterval ? 180_000 : null`——注意既有 cloud 备份通道偏好与本次「跟随拉取」开关独立，勿互相覆盖）；既有 `createAutoRunScheduler` 若同时服务备份与云同步，保持其备份职责不动，仅把「拉取跟随」职责迁到新模块，避免行为回归。

- [ ] **Step 3: 验证**

Run: `cd apps/extension && pnpm typecheck && pnpm test`
Expected: 全绿。手动：`pnpm dev`（chrome）加载扩展 → 桌面端改一条目并等推送 → 打开 popup（已解锁）→ 秒级出现新条目。

- [ ] **Step 4: Commit**

```bash
git add apps/extension
git commit -m "feat(ext): popup/options接入解锁态云同步跟随（验收条目2）"
```

### Task 3: 设置开关 syncPrefs.autoFollow

**Files:**
- Modify: `packages/core/src/settings.ts`（`loadSettings` 归一化；文件名以 `rg -l "loadSettings" packages/core/src` 为准）
- Modify: `packages/ui` 设置区（SyncCard 或设置页，跟随现有开关渲染位置）
- Modify: `packages/ui/src/i18n/locales/zh/common.json`、`en/common.json`

**Interfaces:**
- Consumes: core `loadSettings` 既有归一化模式、settings 持久化通道
- Produces: `settings.syncPrefs.autoFollow: boolean`（默认 `true`）

- [ ] **Step 1: 写失败测试**

core settings 测试内追加：

```ts
it('syncPrefs.autoFollow 缺省 true 且可显式关闭', () => {
  expect(loadSettings({}).syncPrefs.autoFollow).toBe(true)
  expect(loadSettings({ syncPrefs: { autoFollow: false } }).syncPrefs.autoFollow).toBe(false)
})
```

- [ ] **Step 2: 运行确认失败 → 实现 → 通过**

按既有 `loadSettings` 归一化模式（缺失/非法回默认）实现 `syncPrefs: { autoFollow: boolean }`。

Run: `pnpm --filter @totp/core test -- settings`
Expected: PASS

- [ ] **Step 3: UI 开关**

在扩展设置区（SyncCard 所在页）加 MdSwitch「自动跟随云同步」，文案 zh「自动跟随云同步（解锁时自动拉取云端更新）」/ en 对应；读写经现有 settings 持久化通道。Task 2 的 `autoFollowEnabled()` 改读该字段。

- [ ] **Step 4: Commit**

```bash
git add packages/core packages/ui apps/extension
git commit -m "feat(ext): 自动跟随云同步开关（默认开，关闭退回手动）（验收条目2）"
```

### Task 4: 凭据失效处理

**Files:**
- Modify: `apps/extension/src/syncScheduler.ts`（`runPull` 错误分类）
- Modify: SyncCard 状态提示（`packages/ui/src/components/SyncCard.vue` 既有状态区）

**Interfaces:**
- Consumes: runner 抛出的错误（含 HTTP 状态信息的既有形态）
- Produces: 认证类错误（401/403 字样匹配）→ 暂停调度（`intervalMs` 置停）+ SyncCard 提示文案

- [ ] **Step 1: 实现分类与暂停**

syncScheduler 内：`runPull` reject 时若 `String(err)` 匹配 `/401|403/` → 停 interval、置 `authFailed` 状态标志（经 deps 回调 `onAuthFailed()` 上抛）；下次 `start()` 或用户手动同步成功后复位。

- [ ] **Step 2: SyncCard 提示**

SyncCard 状态区在 `authFailed` 时渲染「云端凭据已失效，请重新授权」（`syncCard.authFailed` 键，双语）。

- [ ] **Step 3: 测试**

syncScheduler.test.ts 追加：401 错误触发 `onAuthFailed` 且后续 interval 不再拉取；非认证错误不触发。

- [ ] **Step 4: Commit**

```bash
git add apps/extension packages/ui
git commit -m "feat(ext): 云凭据失效暂停自动跟随并提示（验收条目2）"
```

### Task 5: 两设备手动验收

**Files:** 无代码改动（验收记录写入 PR 描述）

- [ ] **Step 1: 场景走查**

1. 桌面 + 扩展均配同一 WebDAV/Gist 目标，均解锁。
2. 桌面新增条目 → ≤15s 上云（现有防抖推送）→ 打开扩展 popup → 新条目出现。
3. options 页停留 >3min，期间桌面改条目 → options 不操作自动出现。
4. 扩展锁定 → 桌面改条目 → 刷新扩展（锁定态）→ DevTools Network 确认**零云盘请求**。
5. 关闭「自动跟随云同步」→ 打开 popup 不再自动拉取，手动同步按钮仍可用。
6. 改错 WebDAV 密码 → 触发拉取 → SyncCard 出现凭据失效提示且不再风暴重试。

- [ ] **Step 2: 回归确认**

手动备份/恢复、多目标同步、冲突副本路径各点一遍，行为与现状一致。

---

## 附：与 spec 的对应速查

| spec 节 | 任务 |
|---|---|
| §1 调度器抽取 | Task 1/2 |
| §2.1 解锁完成钩子 | Task 1（边沿）+ Task 2（接线） |
| §2.2 前台轻轮询（3min） | Task 1 interval + Task 2 options 接线 |
| §2.4 设置开关 | Task 3 |
| §错误处理·凭据失效 | Task 4 |
| §验收 | Task 5 |
| 方案修正（不做 alarms） | Global Constraints 第 1/2 条固化 |
