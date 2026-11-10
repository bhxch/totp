# 网络时间源校准（plan24）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** TOTP 时间源可配置——默认设备时钟（零行为变化），可选网络时间校准偏移；出码页/设置页「立即同步」；国内直连源池（SNTP + 毫秒 API）；TTL/跳变/退避自动重校。

**Architecture:** core 纯函数模型（TimeSyncState + 决策）+ ui 模块级单例（timeSource，deps 注入端校准器）+ 两处出码取时点换 `effectiveNowMs()`；扩展端 background HTTPS 源序校准（sendMessage 通道）；桌面端 Rust SNTP 池 racing + 毫秒 API 降级命令。偏移量存设备本地键（扩展 storage.local / 桌面 localStorage），模式开关进 AppSettings（随浏览器同步）。

**Tech Stack:** Vue 3 script setup + vue-i18n、vitest 5 + @vue/test-utils、tauri v2 + tokio + reqwest（均已有依赖，Rust 零新增）、std UdpSocket/std::thread + mpsc。

**Spec:** `docs/plans/2026-11-10-time-source-design.md`（本计划从 spec 论证；执行者两个文件都读）。

## Global Constraints

- 全程中文注释与用户文案；i18n 键 zh/en 双份同步新增（`packages/ui/src/i18n/locales/{zh,en}/common.json`），改后跑 `node scripts/check-i18n-keys.mjs` 守卫。
- Rust 零新增依赖（tokio/reqwest/serde_json 均已在 Cargo.toml）；扩展 manifest 零改动（host_permissions 已全放行，`wxtConfig.test.ts` 既有守卫兜住）。
- 出码永不等待网络：任何校准路径都是后台事务，出码恒取「上次成功偏移或 0」（spec §1/§7）。
- 不接偏移的计时：lockPolicy/剪贴板清除/备份调度保持设备时钟（spec §7，本计划一律不触碰）。
- device 模式与未安装上下文：零网络请求、零行为变化（`timeSource()` 降级实例 offset 恒 0）。
- 测试命令：`pnpm --filter <pkg> exec vitest run <file>`（core/ui/extension/desktop）；typecheck：`pnpm --filter <pkg> run typecheck`；Rust：`cd apps/desktop/src-tauri && cargo test`。
- commit Angular 规范中文消息（why 一句 + what 一句）；每 Task 一提交，**只 add 该 Task 的文件**——工作区已有与本计划无关的脏文件（`apps/desktop/src-tauri/vendor/**`、`packages/core/src/icons/builtin.json`、`packages/ui/src/assets/icons-full.json`、`packages/core/test/__snapshots__/**`），不得纳入。
- 同仓库并行子代理必须**串行**（记忆坑）；vitest 5 clearMocks 默认开（用例内自设 mock 才有值）。
- 源序与可用性依据以 spec「事实基础」实测为准，不得凭搜索结果增删源。

## Review Focus

spec 隐含但无单测直测、最可能咬到真实用户的五类输入（每条已 pin 到拥有该代码的 Task）：

1. **MV3 SW 消息回包时序**：校准最长 12s，listener 必须返回 `true` 保住 sendResponse 通道（cloud-fetch 同款），否则 popup 永远等不到回包 → 测：Task 3 断言 handler 返回 true 且异步回包。
2. **偏移公式的中点假设与纪元换算**：`server - (t0+t1)/2` 错一半 RTT、NTP 1900→1970 纪元差 2208988800000ms 写错 → 偏移差分钟级，验证码整窗错 → 测：Task 1 `computeOffsetMs`、Task 4 `parse_transmit_ms` 已知戳单测。
3. **手动按钮必须无视退避**：失败退避期内「立即同步」仍可重试（仅自动路径受退避约束）→ 测：Task 2 `calibrateNow` 不查 `shouldAutoCalibrate` 单测。
4. **休眠恢复不误判跳变**：长间隔采样（>maxGapMs）只更新基准不触发重校；回退 >5s 恒触发 → 测：Task 1 `clockJumpKind` 阈值矩阵单测。
5. **device 模式/未安装零回归**：未校准/校准失败/模式 device/单例未安装，出码时间恒等于 `Date.now()`，且不发起任何网络请求 → 测：Task 2 降级实例单测 + Task 3 安装后 device 模式不发送消息断言。

---

### Task 1: core 时间源模型 + AppSettings.timeSource

**Files:**
- Create: `packages/core/src/time/timeSync.ts`
- Modify: `packages/core/src/storage/vaultStore.ts`（AppSettings 接口 :113 / DEFAULT_SETTINGS :151 / SETTINGS_VALIDATORS :181）
- Modify: `packages/core/src/index.ts`（`export * from './time/timeSync'`，插在 `export * from './security/lockPolicy'` 之后）
- Test: `packages/core/test/timeSync.test.ts`（新建）
- Modify: `packages/core/test/settings.test.ts`（整对象字面量补新字段，见 Step 5）

**Interfaces:**
- Consumes: `StorageAdapter`（`core/src/storage/adapter.ts`，get/set 异步字符串）。
- Produces（后续所有 Task 消费）：
  - `TIME_SYNC_STATE_KEY = 'timeSyncState'`、`TIME_SYNC_TTL_MS = 21_600_000`（6h）、
    `CLOCK_JUMP_BACKWARD_MS = 5000`、`CLOCK_JUMP_FORWARD_MS = 60_000`、`CLOCK_TICK_MAX_GAP_MS = 5000`
  - `interface TimeSyncState { v: 1; offsetMs: number | null; syncedAt: number | null; sourceId: string | null; lastAttemptAt: number | null; lastAttemptFailed: boolean; preferredSourceId: string | null }`
  - `EMPTY_TIME_SYNC_STATE`（全空常量）、`normalizeTimeSyncState(raw: unknown): TimeSyncState`
  - `shouldAutoCalibrate(state, networkMode: boolean, deviceNowMs: number): boolean`
  - `type ClockJumpKind = 'none' | 'backward' | 'forward'`、`clockJumpKind(prevMs, nowMs, maxGapMs?): ClockJumpKind`
  - `computeOffsetMs(serverEpochMs, requestAtMs, responseAtMs): number`
  - `HTTPS_TIME_SOURCE_IDS = ['taobao-api','suning-api','baidu','qq','gitee','jd','cloudflare-trace'] as const`、`NTP_TIME_SOURCE_IDS = ['aliyun','tencent','tencent-time1','neu','cn-pool','tuna','windows'] as const` 及各自联合类型
  - `createAdapterTimeSyncIo(adapter: StorageAdapter): { load(): Promise<TimeSyncState | null>; save(s: TimeSyncState): Promise<void> }`
  - `AppSettings.timeSource: 'device' | 'network'`（默认 `'device'`）

- [ ] **Step 1: 写失败测试** `packages/core/test/timeSync.test.ts`

```ts
import { describe, expect, it } from 'vitest'
import { createMemoryStorage } from '../src/storage/memory'
import {
  CLOCK_JUMP_BACKWARD_MS, CLOCK_JUMP_FORWARD_MS, CLOCK_TICK_MAX_GAP_MS, EMPTY_TIME_SYNC_STATE,
  TIME_SYNC_STATE_KEY, TIME_SYNC_TTL_MS, computeOffsetMs, createAdapterTimeSyncIo,
  clockJumpKind, normalizeTimeSyncState, shouldAutoCalibrate, HTTPS_TIME_SOURCE_IDS, NTP_TIME_SOURCE_IDS,
} from '../src/time/timeSync'

const OK: ReturnType<typeof normalizeTimeSyncState> = { ...EMPTY_TIME_SYNC_STATE, offsetMs: 1000, syncedAt: 10_000, sourceId: 'baidu' }

describe('shouldAutoCalibrate（plan24 §3）', () => {
  it('device 模式恒 false', () => {
    expect(shouldAutoCalibrate(null as never, false, 0)).toBe(false) // networkMode 短路在前，state 不参与
    expect(shouldAutoCalibrate(OK, false, 0)).toBe(false)
  })
  it('network 模式：无状态/从未成功且从未尝试 → true', () => {
    expect(shouldAutoCalibrate(EMPTY_TIME_SYNC_STATE, true, 0)).toBe(true)
  })
  it('network 模式：从未成功且退避期内 → false；超 TTL → true', () => {
    const failed = { ...EMPTY_TIME_SYNC_STATE, lastAttemptAt: 1000, lastAttemptFailed: true }
    expect(shouldAutoCalibrate(failed, true, 1000 + TIME_SYNC_TTL_MS - 1)).toBe(false)
    expect(shouldAutoCalibrate(failed, true, 1000 + TIME_SYNC_TTL_MS)).toBe(true)
  })
  it('network 模式：已成功按 syncedAt 距离判 TTL；syncedAt 缺失（病态归一）按需重校', () => {
    expect(shouldAutoCalibrate({ ...OK, syncedAt: 1000 }, true, 1000 + TIME_SYNC_TTL_MS - 1)).toBe(false)
    expect(shouldAutoCalibrate({ ...OK, syncedAt: 1000 }, true, 1000 + TIME_SYNC_TTL_MS)).toBe(true)
    expect(shouldAutoCalibrate({ ...OK, syncedAt: null }, true, 0)).toBe(true)
  })
})

describe('clockJumpKind（Review Focus 4）', () => {
  it('回退 ≥5s 判 backward；小幅回退不判', () => {
    expect(clockJumpKind(10_000, 10_000 - CLOCK_JUMP_BACKWARD_MS)).toBe('backward')
    expect(clockJumpKind(10_000, 10_000 - CLOCK_JUMP_BACKWARD_MS + 1)).toBe('none')
  })
  it('短间隔前跳 ≥60s 判 forward', () => {
    expect(clockJumpKind(0, CLOCK_JUMP_FORWARD_MS, CLOCK_TICK_MAX_GAP_MS)).toBe('forward')
    expect(clockJumpKind(0, CLOCK_JUMP_FORWARD_MS - 1, CLOCK_TICK_MAX_GAP_MS)).toBe('none')
  })
  it('长间隔（休眠恢复）不判 forward，只算未知间隔', () => {
    expect(clockJumpKind(0, 60 * 60 * 1000, CLOCK_TICK_MAX_GAP_MS)).toBe('none')
  })
  it('默认 maxGap=5s：4s 间隔 + 大前跳不误判', () => {
    expect(clockJumpKind(0, 4000 + 59_000)).toBe('none')
  })
})

describe('computeOffsetMs（Review Focus 2）', () => {
  it('中点公式：offset = server - (t0+t1)/2', () => {
    expect(computeOffsetMs(100_000, 1000, 2000)).toBe(98_500) // 100000-1500
    expect(computeOffsetMs(100_000, 1000, 3000)).toBe(98_000)
    it 内四舍五入: expect(computeOffsetMs(100_001, 1000, 2001)).toBe(98_501)
  })
})

describe('normalizeTimeSyncState', () => {
  it('非对象/坏字段逐位回默认', () => {
    expect(normalizeTimeSyncState(null)).toEqual(EMPTY_TIME_SYNC_STATE)
    expect(normalizeTimeSyncState('x')).toEqual(EMPTY_TIME_SYNC_STATE)
    expect(normalizeTimeSyncState({ offsetMs: 'x', sourceId: 1, lastAttemptFailed: 'yes', preferredSourceId: 'qq' }))
      .toEqual({ ...EMPTY_TIME_SYNC_STATE, preferredSourceId: 'qq' })
    expect(normalizeTimeSyncState({ offsetMs: NaN })).toEqual(EMPTY_TIME_SYNC_STATE) // 非有限数拒绝
  })
  it('合法字段透传', () => {
    expect(normalizeTimeSyncState({ ...OK, lastAttemptAt: 9, lastAttemptFailed: true })).toEqual({ ...OK, lastAttemptAt: 9, lastAttemptFailed: true })
  })
})

describe('createAdapterTimeSyncIo', () => {
  it('load：缺失→null；坏 JSON→null；合法→归一化', async () => {
    const s = createMemoryStorage()
    const io = createAdapterTimeSyncIo(s)
    expect(await io.load()).toBeNull()
    await s.set(TIME_SYNC_STATE_KEY, '{oops')
    expect(await io.load()).toBeNull()
    await s.set(TIME_SYNC_STATE_KEY, JSON.stringify(OK))
    expect(await io.load()).toEqual(OK)
  })
  it('save/load 往返', async () => {
    const s = createMemoryStorage()
    const io = createAdapterTimeSyncIo(s)
    await io.save(OK)
    expect(await io.load()).toEqual(OK)
  })
})

describe('源 id 清单（spec §2，实测序）', () => {
  it('HTTPS 七源顺序固定', () => {
    expect([...HTTPS_TIME_SOURCE_IDS]).toEqual(['taobao-api', 'suning-api', 'baidu', 'qq', 'gitee', 'jd', 'cloudflare-trace'])
  })
  it('NTP 七源顺序固定', () => {
    expect([...NTP_TIME_SOURCE_IDS]).toEqual(['aliyun', 'tencent', 'tencent-time1', 'neu', 'cn-pool', 'tuna', 'windows'])
  })
})
```

注意：`computeOffsetMs` describe 内第三行误嵌 `it`——修正为独立 `it('非整除中点向上取整规则按 Math.round', () => expect(computeOffsetMs(100_001, 1000, 2001)).toBe(98_501))`。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @totp/core exec vitest run test/timeSync.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现** `packages/core/src/time/timeSync.ts`

```ts
/**
 * 网络时间校准核心模型（时间源特性，spec §1/§2/§3）：纯函数 + 常量，无 IO、无时钟读取
 * （deviceNowMs 恒由调用方注入）。状态 TimeSyncState 存设备本地键（TIME_SYNC_STATE_KEY），
 * 不进 AppSettings——浏览器同步整体覆盖 settings、云备份只携带 vault，偏移量属设备属性。
 * 校准执行（HTTP 源序 / SNTP 池）属端实现，经 ui timeSource 单例注入。
 */

/** 设备本地时间校准状态（v1） */
export interface TimeSyncState {
  v: 1
  /** 校准偏移毫秒（=网络时间-设备时间，effectiveNow=device+offset）；null=从未成功 */
  offsetMs: number | null
  /** 上次成功校准时刻（设备时钟 ms）；offsetMs 非 null 时有效 */
  syncedAt: number | null
  /** 上次成功校准的来源 id（HTTPS/NTP 源清单内） */
  sourceId: string | null
  /** 上次尝试时刻（设备时钟 ms，成败均记；自动重试退避依据） */
  lastAttemptAt: number | null
  /** 上次尝试失败标记：TTL 内不自动重试，手动「立即同步」不受限 */
  lastAttemptFailed: boolean
  /** 用户首选源 id；null=自动（端内置顺序） */
  preferredSourceId: string | null
}

export const TIME_SYNC_STATE_KEY = 'timeSyncState'
/** 自动重校周期（spec §3）：正常钟漂移每天 1-2s、烂钟可达 30s；6h 把最坏累计压进 TOTP 半窗口 */
export const TIME_SYNC_TTL_MS = 6 * 60 * 60 * 1000
/** 跳变阈值：回退 ≥5s（系统时间被改）；短间隔前跳 ≥60s（被外部拉准）。休眠恢复属长间隔不判 */
export const CLOCK_JUMP_BACKWARD_MS = 5000
export const CLOCK_JUMP_FORWARD_MS = 60_000
/** noteDeviceTick 最大可信采样间隔：超过视为未知间隔（休眠恢复/冷启动）不判跳变 */
export const CLOCK_TICK_MAX_GAP_MS = 5000

export const EMPTY_TIME_SYNC_STATE: TimeSyncState = {
  v: 1, offsetMs: null, syncedAt: null, sourceId: null,
  lastAttemptAt: null, lastAttemptFailed: false, preferredSourceId: null,
}

/** 宽容归一化：坏 JSON/缺字段/类型非法逐位回默认（与 loadSettings「非法回 DEFAULT」同口径） */
export function normalizeTimeSyncState(raw: unknown): TimeSyncState {
  if (typeof raw !== 'object' || raw === null) return { ...EMPTY_TIME_SYNC_STATE }
  const p = raw as Record<string, unknown>
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
  return {
    v: 1,
    offsetMs: num(p['offsetMs']),
    syncedAt: num(p['syncedAt']),
    sourceId: str(p['sourceId']),
    lastAttemptAt: num(p['lastAttemptAt']),
    lastAttemptFailed: p['lastAttemptFailed'] === true,
    preferredSourceId: str(p['preferredSourceId']),
  }
}

/** 自动校准决策（纯函数）：network 模式下 TTL 超龄 / 从未成功且退避期已过。
 *  手动校准（立即同步）不走此函数，恒允许 */
export function shouldAutoCalibrate(state: TimeSyncState, networkMode: boolean, deviceNowMs: number): boolean {
  if (!networkMode) return false
  if (state.offsetMs === null) {
    if (state.lastAttemptAt === null) return true // 从未尝试（含首次开启）
    return deviceNowMs - state.lastAttemptAt >= TIME_SYNC_TTL_MS // 失败退避：TTL 内不自动重试
  }
  if (state.syncedAt === null) return true // 病态归一（有偏移无时刻）：按需重校
  return deviceNowMs - state.syncedAt >= TIME_SYNC_TTL_MS
}

export type ClockJumpKind = 'none' | 'backward' | 'forward'

/** 跳变检测（纯函数）：回退 ≥5s 判 backward（系统时间被改，无论间隔都真实）；
 *  前跳仅当采样间隔 ≤maxGapMs（短间隔连续 tick）且 ≥60s 判 forward（被外部拉准）——
 *  长间隔（休眠恢复/冷启动）属未知间隔，offset 仍近似成立，不判（spec §3-④） */
export function clockJumpKind(prevMs: number, nowMs: number, maxGapMs: number = CLOCK_TICK_MAX_GAP_MS): ClockJumpKind {
  const delta = nowMs - prevMs
  if (delta < 0) return -delta >= CLOCK_JUMP_BACKWARD_MS ? 'backward' : 'none'
  if (delta > maxGapMs) return 'none'
  return delta >= CLOCK_JUMP_FORWARD_MS ? 'forward' : 'none'
}

/** NTP 经典中点公式：offset = server - (t0+t1)/2（秒级源 + RTT 补偿，TOTP 30s 窗口足够） */
export function computeOffsetMs(serverEpochMs: number, requestAtMs: number, responseAtMs: number): number {
  return Math.round(serverEpochMs - (requestAtMs + responseAtMs) / 2)
}

/** HTTPS 时间源 id（扩展端；顺序=内置优先级，2026-11-10 家庭宽带实测）：
 *  毫秒 API 在前（动态生成免疫 CDN 缓存，淘宝 HEAD Date 滞后 43s 已剔除该形态） */
export const HTTPS_TIME_SOURCE_IDS = ['taobao-api', 'suning-api', 'baidu', 'qq', 'gitee', 'jd', 'cloudflare-trace'] as const
export type HttpsTimeSourceId = (typeof HTTPS_TIME_SOURCE_IDS)[number]
/** SNTP 源 id（桌面端；顺序=内置优先级；preferred 用户置顶仍全池兜底） */
export const NTP_TIME_SOURCE_IDS = ['aliyun', 'tencent', 'tencent-time1', 'neu', 'cn-pool', 'tuna', 'windows'] as const
export type NtpTimeSourceId = (typeof NTP_TIME_SOURCE_IDS)[number]

/** 基于 StorageAdapter 的设备本地键读写（扩展端宿主用；桌面用 localStorage 手写包装） */
export function createAdapterTimeSyncIo(adapter: import('../storage/adapter').StorageAdapter): {
  load(): Promise<TimeSyncState | null>
  save(state: TimeSyncState): Promise<void>
} {
  return {
    async load(): Promise<TimeSyncState | null> {
      const raw = await adapter.get(TIME_SYNC_STATE_KEY)
      if (raw === null) return null
      try {
        return normalizeTimeSyncState(JSON.parse(raw))
      } catch {
        return null
      }
    },
    async save(state: TimeSyncState): Promise<void> {
      await adapter.set(TIME_SYNC_STATE_KEY, JSON.stringify(state))
    },
  }
}
```

同时改 `vaultStore.ts` 三处：

```ts
// AppSettings 接口（syncPrefs 字段后加）：
  /** 时间源（时间源特性，spec §1）：device=跟随设备时钟；network=用网络校准偏移取码。
   *  偏移量本身存设备本地键（timeSyncState），不随备份/浏览器同步漂移 */
  timeSource: 'device' | 'network'

// DEFAULT_SETTINGS（syncPrefs 行后加）：
  timeSource: 'device',

// SETTINGS_VALIDATORS（syncPrefs 行后加；宽进：非 network 一律 device）：
  timeSource: (v) => (v === 'network' ? 'network' : DEFAULT_SETTINGS.timeSource),
```

`index.ts` 在 `export * from './security/lockPolicy'` 之后加一行：
`export * from './time/timeSync'`

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @totp/core exec vitest run test/timeSync.test.ts`
Expected: PASS

- [ ] **Step 5: 修 settings.test.ts 字面量 + 全包回归**

Run: `pnpm --filter @totp/core exec vitest run`
Expected: 整对象 `toEqual` 字面量用例（`save/load 往返`、`未知字段被丢弃` 等，grep `syncPrefs: {` 定位）因缺 `timeSource: 'device'` FAIL——逐处补 `, timeSource: 'device'` 后 PASS。

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/time/timeSync.ts packages/core/src/storage/vaultStore.ts packages/core/src/index.ts packages/core/test/timeSync.test.ts packages/core/test/settings.test.ts
git commit -m "feat(core): 时间源模型——校准状态/决策/跳变/中点偏移纯函数 + timeSource 设置项"
```

---

### Task 2: ui timeSource 单例 + 出码取时点接线

**Files:**
- Create: `packages/ui/src/timeSource.ts`
- Modify: `packages/ui/src/composables/useOtpCodes.ts:31-42`（取时点）
- Modify: `packages/ui/src/index.ts`（导出 timeSource 模块，与 store.ts 同区）
- Modify: `apps/desktop/src/mcpBridge.ts:54`（MCP get_code 取时点）
- Test: `packages/ui/test/timeSource.test.ts`（新建）

**Interfaces:**
- Consumes: Task 1 全部导出；`useI18n` 不涉及（纯逻辑层）。
- Produces：
  - `interface CalibrateResult { offsetMs: number; sourceId: string }`
  - `interface TimeSyncDeps { load(): Promise<TimeSyncState | null>; save(s: TimeSyncState): Promise<void>; isNetworkMode(): boolean; calibrate(preferredSourceId: string | null): Promise<CalibrateResult> }`
  - `interface TimeSyncController { state: ShallowRef<TimeSyncState>; syncing: Ref<boolean>; effectiveNowMs(): number; noteDeviceTick(deviceNowMs: number, maxGapMs?: number): void; ensureAutoCalibrate(): void; setPreferredSource(id: string | null): Promise<void>; calibrateNow(opts?: { preferredSourceId?: string | null }): Promise<TimeSyncState> }`
  - `initTimeSync(deps): TimeSyncController`（覆盖式安装 + 异步 bootstrap load→ensureAutoCalibrate）
  - `timeSource(): TimeSyncController`（未安装时返回降级实例：offset 恒 0、calibrate 恒 reject、零网络）
  - `setPreferredSource(id: string | null)`：仅更新 state.preferredSourceId 并落盘，不触发校准。

- [ ] **Step 1: 写失败测试** `packages/ui/test/timeSource.test.ts`

```ts
import { describe, expect, it, vi } from 'vitest'
import { EMPTY_TIME_SYNC_STATE, type TimeSyncState } from '@totp/core'
import { initTimeSync, timeSource } from '../src/timeSource'

function okState(offsetMs = 500): TimeSyncState {
  return { ...EMPTY_TIME_SYNC_STATE, offsetMs, syncedAt: 1000, sourceId: 'baidu' }
}
function makeDeps(overrides: Partial<Parameters<typeof initTimeSync>[0]> = {}) {
  const calibrate = vi.fn(async (preferred: string | null) => ({ offsetMs: 1234, sourceId: preferred ?? 'baidu' }))
  return {
    deps: {
      load: vi.fn(async () => null),
      save: vi.fn(async () => {}),
      isNetworkMode: vi.fn(() => true),
      calibrate,
      ...overrides,
    },
    calibrate,
  }
}

describe('未安装降级实例（Review Focus 5）', () => {
  it('fresh 模块态 timeSource()：effectiveNow=Date.now()、calibrate 恒败', () => {
    vi.resetModules()
    const before = Date.now()
    const ts = timeSource()
    expect(Math.abs(ts.effectiveNowMs() - before)).toBeLessThan(50)
    expect(ts.state.value).toEqual(EMPTY_TIME_SYNC_STATE)
    expect(ts.syncing.value).toBe(false)
    void expect(ts.calibrateNow()).rejects.toThrow()
  })
})

describe('initTimeSync 装配', () => {
  it('bootstrap load 装入已存状态', async () => {
    vi.resetModules()
    const { deps } = makeDeps({ load: vi.fn(async () => okState(700)) })
    initTimeSync(deps)
    await vi.waitFor(() => expect(timeSource().state.value.offsetMs).toBe(700))
  })
  it('bootstrap 后 network 模式从未尝试 → 自动校准一次并落盘', async () => {
    vi.resetModules()
    const { deps, calibrate } = makeDeps()
    initTimeSync(deps)
    await vi.waitFor(() => expect(calibrate).toHaveBeenCalledWith(null))
    await vi.waitFor(() => expect(deps.save).toHaveBeenCalled())
    expect(timeSource().state.value.offsetMs).toBe(1234)
    expect(timeSource().state.value.sourceId).toBe('baidu')
  })
})

describe('effectiveNowMs', () => {
  it('network+有偏移：Date.now()+offset', async () => {
    vi.resetModules()
    const { deps } = makeDeps({ load: vi.fn(async () => okState(2000)) })
    initTimeSync(deps)
    await vi.waitFor(() => expect(timeSource().state.value.offsetMs).toBe(2000))
    const before = Date.now()
    const got = timeSource().effectiveNowMs()
    expect(got - before).toBeGreaterThanOrEqual(1990)
    expect(got - before).toBeLessThan(2100)
  })
  it('device 模式：偏移不生效（Review Focus 5）', async () => {
    vi.resetModules()
    const { deps } = makeDeps({ load: vi.fn(async () => okState(2000)), isNetworkMode: () => false })
    initTimeSync(deps)
    await vi.waitFor(() => expect(timeSource().state.value.offsetMs).toBe(2000))
    expect(Math.abs(timeSource().effectiveNowMs() - Date.now())).toBeLessThan(50)
    expect(deps.calibrate).not.toHaveBeenCalled() // 自动路径也被模式短路
  })
  it('偏移 null（未成功过）：回退设备时间', async () => {
    vi.resetModules()
    const { deps } = makeDeps({ load: vi.fn(async () => ({ ...EMPTY_TIME_SYNC_STATE, lastAttemptAt: 1, lastAttemptFailed: true })) })
    initTimeSync(deps)
    await vi.waitFor(() => expect(timeSource().state.value.lastAttemptFailed).toBe(true))
    expect(Math.abs(timeSource().effectiveNowMs() - Date.now())).toBeLessThan(50)
  })
})

describe('noteDeviceTick（spec §3-③④）', () => {
  it('TTL 超龄触发静默重校；失败退避期内不触发', async () => {
    vi.resetModules()
    const stale = { ...okState(100), syncedAt: Date.now() - 7 * 60 * 60 * 1000 }
    const { deps, calibrate } = makeDeps({ load: vi.fn(async () => stale) })
    initTimeSync(deps)
    await vi.waitFor(() => expect(calibrate).toHaveBeenCalled()) // TTL 超龄自动重校
  })
  it('退避期内 noteDeviceTick 不重校（自动路径）', async () => {
    vi.resetModules()
    const backed = { ...EMPTY_TIME_SYNC_STATE, lastAttemptAt: Date.now(), lastAttemptFailed: true }
    const { deps, calibrate } = makeDeps({ load: vi.fn(async () => backed) })
    initTimeSync(deps)
    await vi.waitFor(() => expect(timeSource().state.value.lastAttemptFailed).toBe(true))
    timeSource().noteDeviceTick(Date.now())
    expect(calibrate).not.toHaveBeenCalled()
  })
  it('跳变回退触发静默重校（Review Focus 4 集成侧）', async () => {
    vi.resetModules()
    const { deps, calibrate } = makeDeps({ isNetworkMode: () => false }) // device 模式：跳变也重校（校准与出码解耦）
    initTimeSync(deps)
    await vi.waitFor(() => expect(timeSource().state.value).toEqual(EMPTY_TIME_SYNC_STATE))
    calibrate.mockClear()
    timeSource().noteDeviceTick(1_000_000)
    timeSource().noteDeviceTick(1_000_000 - 10_000) // 回退 10s
    await vi.waitFor(() => expect(calibrate).toHaveBeenCalled())
  })
  it('长间隔大前跳不误判（休眠恢复）', async () => {
    vi.resetModules()
    const { deps, calibrate } = makeDeps()
    initTimeSync(deps)
    await vi.waitFor(() => expect(timeSource().state.value).toEqual(EMPTY_TIME_SYNC_STATE))
    calibrate.mockClear()
    timeSource().noteDeviceTick(0)
    timeSource().noteDeviceTick(60 * 60 * 1000) // 前跳 1h：长间隔未知，不判
    expect(calibrate).not.toHaveBeenCalled()
  })
})

describe('calibrateNow（Review Focus 3）', () => {
  it('成功：更新 state（含 preferred 保留）并落盘', async () => {
    vi.resetModules()
    const { deps } = makeDeps({ load: vi.fn(async () => ({ ...EMPTY_TIME_SYNC_STATE, preferredSourceId: 'jd' })) })
    initTimeSync(deps)
    await vi.waitFor(() => expect(timeSource().state.value.preferredSourceId).toBe('jd'))
    const st = await timeSource().calibrateNow()
    expect(st.offsetMs).toBe(1234)
    expect(st.sourceId).toBe('jd') // preferred 优先于 deps 内置
    expect(st.lastAttemptFailed).toBe(false)
  })
  it('失败：lastAttemptFailed 置位 + 落盘 + rethrow；退避期内手动仍可重试', async () => {
    vi.resetModules()
    const { deps, calibrate } = makeDeps()
    calibrate.mockRejectedValueOnce(new Error('down'))
    initTimeSync(deps)
    await expect(timeSource().calibrateNow()).rejects.toThrow('down')
    await vi.waitFor(() => expect(timeSource().state.value.lastAttemptFailed).toBe(true))
    await expect(timeSource().calibrateNow()).resolves.toBeTruthy() // 退避不约束手动
  })
  it('syncing 互斥：在途调用直接返回当前 state', async () => {
    vi.resetModules()
    const { deps, calibrate } = makeDeps()
    let release!: () => void
    calibrate.mockImplementation(() => new Promise<void>((r) => { release = r as () => void }).then(() => ({ offsetMs: 1, sourceId: 'baidu' })))
    initTimeSync(deps)
    const p1 = timeSource().calibrateNow()
    const st2 = await timeSource().calibrateNow() // 在途：立即返回不二次请求
    expect(st2.offsetMs).toBeNull()
    release()
    await p1
    expect(calibrate).toHaveBeenCalledTimes(1)
  })
})

describe('setPreferredSource', () => {
  it('仅更新偏好并落盘，不触发校准', async () => {
    vi.resetModules()
    const { deps, calibrate } = makeDeps()
    initTimeSync(deps)
    await vi.waitFor(() => expect(timeSource().state.value).toEqual(EMPTY_TIME_SYNC_STATE))
    calibrate.mockClear()
    await timeSource().setPreferredSource('gitee')
    expect(timeSource().state.value.preferredSourceId).toBe('gitee')
    expect(deps.save).toHaveBeenCalled()
    expect(calibrate).not.toHaveBeenCalled()
    await timeSource().setPreferredSource(null)
    expect(timeSource().state.value.preferredSourceId).toBeNull()
  })
})

describe('noteDeviceTick 后 state 替换触发 watch（出码联动）', () => {
  it('state 引用替换（浅 watch 生效）', async () => {
    vi.resetModules()
    const seen: TimeSyncState[] = []
    const { deps } = makeDeps()
    initTimeSync(deps)
    await vi.waitFor(() => expect(timeSource().state.value).toEqual(EMPTY_TIME_SYNC_STATE))
    void import('vue').then(({ watch }) => {
      const stop = watch(timeSource().state, (s) => seen.push(s))
      void timeSource().calibrateNow().then(() => { stop() })
    })
    await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0))
    expect(seen[seen.length - 1]!.offsetMs).toBe(1234)
  })
})
```

注意：`fresh 模块态` 用例依赖 `vi.resetModules()` 后 `timeSource()` 单例重置——resetModules 只对动态 import 生效，静态 import 的 `timeSource` 闭包单例不会被重置。**落地方式改为：单例重置通过 `initTimeSync` 覆盖安装达成**——上面每个用例开头都调用了 `initTimeSync`（覆盖安装），首个「未安装降级」用例在文件**最先执行**（describe 顺序即执行序，该用例不调 initTimeSync，直接验证默认降级实例）。因此删去所有用例开头的 `vi.resetModules()`（对静态导入无效且误导），「未安装」用例只保留文件内首个。执行者落地时按此调整：各用例去掉 resetModules 行，「未安装降级」用例保持在文件最前（vitest 默认顺序执行；若并行分片可改 `it.sequential` 包裹或拆两个文件——本文件用例少，顺序执行即可）。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @totp/ui exec vitest run test/timeSource.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现** `packages/ui/src/timeSource.ts`

```ts
/**
 * 时间源模块级单例（时间源特性，spec §2；useToast 同款装配模式）：宿主 main/App 安装
 * initTimeSync(deps) 注入设备本地键 IO 与端校准器；出码层（useOtpCodes/mcpBridge）与设置
 * 卡消费 timeSource()。未安装时返回降级实例（offset 恒 0、calibrate 恒败、零网络）——
 * 测试与未接线上下文零影响（spec §7 device 模式零回归）。
 */
import {
  CLOCK_TICK_MAX_GAP_MS, EMPTY_TIME_SYNC_STATE, clockJumpKind, normalizeTimeSyncState,
  shouldAutoCalibrate, type TimeSyncState,
} from '@totp/core'
import { ref, shallowRef, type Ref, type ShallowRef } from 'vue'

export interface CalibrateResult {
  /** 校准偏移毫秒（=网络时间-设备时间） */
  offsetMs: number
  /** 成功来源 id */
  sourceId: string
}

/** 宿主注入的端依赖：load/save=设备本地键 IO（实现内自带 try/catch 吞 IO 错误）；
 *  calibrate=端校准器（扩展=background 消息；桌面=Rust SNTP 命令），失败必须 reject */
export interface TimeSyncDeps {
  load(): Promise<TimeSyncState | null>
  save(state: TimeSyncState): Promise<void>
  isNetworkMode(): boolean
  calibrate(preferredSourceId: string | null): Promise<CalibrateResult>
}

export interface TimeSyncController {
  /** 校准状态（引用替换驱动浅 watch → 出码层联动重算） */
  state: ShallowRef<TimeSyncState>
  /** 校准进行中（按钮 spinner/互斥） */
  syncing: Ref<boolean>
  /** 出码取时单点：Date.now() +（network 且有偏移时的 offset；否则 0）——出码永不等待网络 */
  effectiveNowMs(): number
  /** 每秒 tick 入口（useOtpCodes）/事件驱动顺带（mcpBridge）：跳变判定 + TTL 静默重校；
   *  长间隔（>maxGapMs，休眠恢复）不判跳变仅更新基准（spec §3-④） */
  noteDeviceTick(deviceNowMs: number, maxGapMs?: number): void
  /** 上下文激活入口（宿主 boot/聚焦重载后调用一次）：TTL 决策 + 静默重校；幂等互斥 */
  ensureAutoCalibrate(): void
  /** 设置卡改首选源：仅更新偏好并落盘，不触发校准 */
  setPreferredSource(id: string | null): Promise<void>
  /** 手动/模式切换校准（spec §3-①②）：无视退避恒允许；失败 rethrow 供调用方 toast；
   *  在途（syncing）直接返回当前 state 不重复请求 */
  calibrateNow(opts?: { preferredSourceId?: string | null }): Promise<TimeSyncState>
}

function createController(deps: TimeSyncDeps): TimeSyncController {
  const state = shallowRef<TimeSyncState>({ ...EMPTY_TIME_SYNC_STATE })
  const syncing = ref(false)
  let lastTick: number | null = null

  /** 校准事务：成功/失败均刷新 state（引用替换）并落盘；throwOnFail 区分手动（true，rethrow）
   *  与静默（false，吞掉仅留痕）。preferred=null 走端内置顺序 */
  async function runCalibrate(preferred: string | null, throwOnFail: boolean): Promise<TimeSyncState> {
    if (syncing.value) return state.value
    syncing.value = true
    try {
      const r = await deps.calibrate(preferred)
      const now = Date.now()
      const next: TimeSyncState = {
        v: 1, offsetMs: r.offsetMs, syncedAt: now, sourceId: r.sourceId,
        lastAttemptAt: now, lastAttemptFailed: false,
        preferredSourceId: preferred ?? state.value.preferredSourceId,
      }
      state.value = next
      await deps.save(next)
      return next
    } catch (e) {
      const now = Date.now()
      const next: TimeSyncState = {
        ...state.value, lastAttemptAt: now, lastAttemptFailed: true,
        preferredSourceId: preferred ?? state.value.preferredSourceId,
      }
      state.value = next
      await deps.save(next)
      if (throwOnFail) throw e
      return next
    } finally {
      syncing.value = false
    }
  }

  function maybeAutoCalibrate(): void {
    if (syncing.value) return
    if (shouldAutoCalibrate(state.value, deps.isNetworkMode(), Date.now())) {
      void runCalibrate(state.value.preferredSourceId, false)
    }
  }

  return {
    state,
    syncing,
    effectiveNowMs(): number {
      const st = state.value
      return Date.now() + (deps.isNetworkMode() && st.offsetMs !== null ? st.offsetMs : 0)
    },
    noteDeviceTick(deviceNowMs: number, maxGapMs: number = CLOCK_TICK_MAX_GAP_MS): void {
      if (lastTick !== null && clockJumpKind(lastTick, deviceNowMs, maxGapMs) !== 'none') {
        lastTick = deviceNowMs
        void runCalibrate(state.value.preferredSourceId, false) // 跳变：静默重校，出码用旧偏移不阻塞
        return
      }
      lastTick = deviceNowMs
      maybeAutoCalibrate()
    },
    ensureAutoCalibrate: maybeAutoCalibrate,
    async setPreferredSource(id: string | null): Promise<void> {
      if (state.value.preferredSourceId === id) return
      state.value = { ...state.value, preferredSourceId: id }
      await deps.save(state.value)
    },
    async calibrateNow(opts?: { preferredSourceId?: string | null }): Promise<TimeSyncState> {
      const preferred = opts?.preferredSourceId !== undefined ? opts.preferredSourceId : state.value.preferredSourceId
      return runCalibrate(preferred, true)
    },
  }
}

/** 降级实例（未安装/测试默认）：offset 恒 0、calibrate 恒败（手动调用方 toast 失败文案）、零网络 */
const fallback = createController({
  load: async () => null,
  save: async () => {},
  isNetworkMode: () => false,
  calibrate: async () => { throw new Error('time sync not installed') },
})

let singleton: TimeSyncController = fallback

/** 宿主安装（覆盖式；mini 窗聚焦重建 store 后可重复安装）：bootstrap 异步装载本地键，
 *  装载完成后跑一次 TTL 决策（network 模式超龄即静默重校）；装载失败静默保降级语义 */
export function initTimeSync(deps: TimeSyncDeps): TimeSyncController {
  singleton = createController(deps)
  void deps.load()
    .then((st) => {
      if (st) singleton.state.value = st
      singleton.ensureAutoCalibrate()
    })
    .catch(() => {})
  return singleton
}

/** 消费入口：未安装（未调 initTimeSync）返回降级实例 */
export function timeSource(): TimeSyncController {
  return singleton
}
```

`useOtpCodes.ts` 改动（:1-3 import 区 + :31-35 + :38-44 + return 前 watch）：

```ts
// import 区新增：
import { timeSource } from '../timeSource'

// :31-32 初始化改为：
export function useOtpCodes(entries: Ref<OtpEntry[]>) {
  const nowMs = ref(timeSource.effectiveNowMs())

// recompute 内 :42 一行替换（nowSec/counter 均自 nowMs.value 派生，缓存键自动一致）：
      timeSource.noteDeviceTick(Date.now()) // 跳变判定 + TTL 静默重校（spec §3-③④）
      nowMs.value = timeSource.effectiveNowMs()

// setup 末尾（onScopeDispose 之前）加：
  // 偏移变化/模式切换（state 引用替换）→ 立即重算一次，不等下一秒 tick
  watch(timeSource.state, () => { void recompute() })
```

`mcpBridge.ts:54`：`computeEntryCode(e, Date.now())` →
```ts
timeSource.noteDeviceTick(Date.now()) // 事件驱动长间隔不误判跳变，仅 TTL 决策
const r = computeEntryCode(e, timeSource.effectiveNowMs())
```
（`import { timeSource } from './timeSourceBridge'` 不引入——ui 导出即可：`import { timeSource } from '@totp/ui'`；desktop 已依赖 @totp/ui。）

`index.ts`：在 `export * from './store'` 同区加 `export * from './timeSource'`（若 ui index 对 store.ts 是具名导出，则 timeSource 同样具名导出 `initTimeSync`/`timeSource` 与两个类型，避免与既有符号冲突——执行时按 ui/src/index.ts 既有风格落地）。

- [ ] **Step 4: 跑测试确认通过 + 回归**

Run: `pnpm --filter @totp/ui exec vitest run` 与 `pnpm --filter @totp/desktop exec vitest run`
Expected: PASS（既有 useOtpCodes cache/lifecycle 测试在降级实例下 `effectiveNowMs()===Date.now()`，行为不变；desktop mcpBridge 相关测试如有取时断言按新签名微调）

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/timeSource.ts packages/ui/src/composables/useOtpCodes.ts packages/ui/src/index.ts apps/desktop/src/mcpBridge.ts packages/ui/test/timeSource.test.ts
git commit -m "feat(ui): timeSource 单例与出码取时接线——偏移注入/跳变/TTL 静默重校，出码永不等待网络"
```

---

### Task 3: 扩展端校准器 + background 消息 + 页面安装

**Files:**
- Create: `apps/extension/src/timeSyncCalibrator.ts`（background 专用：源表 + fetch 校准）
- Create: `apps/extension/src/timeSyncInstall.ts`（页面端：initTimeSync 装配 + sendMessage 客户端）
- Modify: `apps/extension/entrypoints/background.ts`（onMessage 分支 + import）
- Modify: `apps/extension/entrypoints/popup/main.ts`（安装）
- Modify: `apps/extension/entrypoints/options/App.vue`（setup 安装，store 就地创建处）
- Test: `apps/extension/test/timeSyncCalibrator.test.ts`（新建，mock fetch）

**Interfaces:**
- Consumes: Task 1（`HTTPS_TIME_SOURCE_IDS`/`computeOffsetMs`/`TIME_SYNC_STATE_KEY`/`normalizeTimeSyncState`）、Task 2（`initTimeSync`/`CalibrateResult`）。
- Produces:
  - `calibrateNetworkTime(preferredSourceId: string | null): Promise<CalibrateResult>`（background 内执行）
  - 消息协议：`{ type: 'time-sync-calibrate', preferred: string | null }` → 回包 `{ ok: true, offsetMs: number, sourceId: string } | { ok: false }`
  - `installExtensionTimeSync(store: VueStore): void`（页面端装配）

- [ ] **Step 1: 写失败测试** `apps/extension/test/timeSyncCalibrator.test.ts`

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { calibrateNetworkTime } from '../src/timeSyncCalibrator'

/** stub fetch：url → 响应描述（json 体 / date 头 / 文本 / 抛错 / 挂起） */
function stubFetch(map: Record<string, (() => Promise<Partial<Response>>) | 'reject'>) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (init?.signal?.aborted) throw new Error('aborted')
    const entry = map[url] ?? map[url.replace(/^https?:\/\//, '')]
    if (entry === 'reject' || !entry) throw new Error('network down')
    const r = await entry()
    return r as Response
  })
}
const jsonRes = (body: unknown): Promise<Partial<Response>> => Promise.resolve({ ok: true, status: 200, headers: new Headers(), json: async () => body } as unknown as Partial<Response>)
const headRes = (date: string): Promise<Partial<Response>> => Promise.resolve({ ok: true, status: 200, headers: new Headers({ date }) } as unknown as Partial<Response>)

describe('calibrateNetworkTime 源序与解析（spec §4）', () => {
  beforeEach(() => { vi.stubGlobal('fetch', vi.fn()) })
  afterEach(() => { vi.unstubAllGlobals() })

  it('首选源置顶：preferred=jd 时 jd 成功即返回 jd', async () => {
    const f = stubFetch({ 'https://www.jd.com': headRes(new Date('2026-11-10T12:00:05Z').toUTCString()) })
    vi.stubGlobal('fetch', f)
    vi.setSystemTime(new Date('2026-11-10T12:00:00Z'))
    const r = await calibrateNetworkTime('jd')
    expect(r.sourceId).toBe('jd')
    expect(r.offsetMs).toBe(5000) // 中点≈t0+少量
    vi.useRealTimers()
  })

  it('默认序：首个源成功即停（taobao-api），不发后续请求', async () => {
    const f = stubFetch({ 'https://acs.m.taobao.com/gw/mtop.common.getTimestamp/': jsonRes({ data: { t: String(Date.now() + 250) } }) })
    vi.stubGlobal('fetch', f)
    const r = await calibrateNetworkTime(null)
    expect(r.sourceId).toBe('taobao-api')
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('首选源非法 id：跳过按内置序兜底', async () => {
    const f = stubFetch({ 'https://acs.m.taobao.com/gw/mtop.common.getTimestamp/': jsonRes({ data: { t: String(Date.now()) } }) })
    vi.stubGlobal('fetch', f)
    const r = await calibrateNetworkTime('ntp.aliyun.com') // NTP id 混入扩展端：find 不到跳过
    expect(r.sourceId).toBe('taobao-api')
  })

  it('前源失败按序兜底到 Date 头源（baidu）', async () => {
    const now = new Date('2026-11-10T09:00:10Z')
    const f = stubFetch({
      'https://acs.m.taobao.com/gw/mtop.common.getTimestamp/': 'reject',
      'https://f.m.suning.com/api/ct.do': 'reject',
      'https://www.baidu.com': headRes(now.toUTCString()),
    })
    vi.stubGlobal('fetch', f)
    vi.setSystemTime(now)
    const r = await calibrateNetworkTime(null)
    expect(r.sourceId).toBe('baidu')
    expect(Math.abs(r.offsetMs - 10_000)).toBeLessThan(50)
    vi.useRealTimers()
  })

  it('毫秒 API 解析：taobao data.t 字符串 / suning currentTime 数字', async () => {
    const now = Date.now()
    const f = stubFetch({
      'https://acs.m.taobao.com/gw/mtop.common.getTimestamp/': 'reject',
      'https://f.m.suning.com/api/ct.do': jsonRes({ currentTime: now + 7000 }),
    })
    vi.stubGlobal('fetch', f)
    vi.setSystemTime(new Date(now))
    const r = await calibrateNetworkTime(null)
    expect(r.sourceId).toBe('suning-api')
    expect(Math.abs(r.offsetMs - 7000)).toBeLessThan(50)
    vi.useRealTimers()
  })

  it('Date 头缺失/非法：该源失败继续', async () => {
    const now = Date.now()
    const f = stubFetch({
      'https://acs.m.taobao.com/gw/mtop.common.getTimestamp/': 'reject',
      'https://f.m.suning.com/api/ct.do': 'reject',
      'https://www.baidu.com': headRes(''),
      'https://www.qq.com': jsonRes({ data: { t: String(now + 1000) } }), // qq 实为 HEAD——测试桩仅验证兜底序
    })
    vi.stubGlobal('fetch', f)
    const r = await calibrateNetworkTime(null)
    expect(r.sourceId).toBe('qq')
    vi.useRealTimers()
  })

  it('cloudflare-trace 文本解析 ts= 秒浮点', async () => {
    const now = Date.now()
    const ok = Promise.resolve({ ok: true, status: 200, headers: new Headers(), text: async () => `fl=x\nts=${(now + 3000) / 1000}\n` } as unknown as Partial<Response>)
    const f = stubFetch({ 'https://www.cloudflare.com/cdn-cgi/trace': () => ok })
    vi.stubGlobal('fetch', f)
    const r = await calibrateNetworkTime('cloudflare-trace')
    expect(r.sourceId).toBe('cloudflare-trace')
    expect(Math.abs(r.offsetMs - 3000)).toBeLessThan(50)
  })

  it('全源失败：reject 错误（Review Focus 1 之外的用户可见兜底=设备时间）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down') }))
    await expect(calibrateNetworkTime(null)).rejects.toThrow()
  })

  it('fetch 带 cache:no-store（防缓存层吃掉 Date 新鲜度）', async () => {
    const f = vi.fn(async () => ({ ok: true, status: 200, headers: new Headers(), json: async () => ({ data: { t: String(Date.now()) } }) }))
    vi.stubGlobal('fetch', f)
    await calibrateNetworkTime(null)
    expect(f.mock.calls[0]![1]!.cache).toBe('no-store')
  })
})
```

注意：`首选源置顶` 用例中 offset 断言依赖真实 t0/t1 间隔（stub 下近 0）——断言放宽为 `expect(r.offsetMs).toBeGreaterThanOrEqual(4900)` 并用 `vi.setSystemTime` 固定时钟；执行者以固定系统时钟校准断言（如上写法），若抖动导致 flaky 再收紧为区间断言 `toBeGreaterThan(4000)`。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @totp/extension exec vitest run test/timeSyncCalibrator.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

`apps/extension/src/timeSyncCalibrator.ts`：

```ts
/**
 * 扩展端网络时间校准器（时间源特性 spec §4）：background SW 承载——host_permissions 已全放行
 * （wxt.config.ts:33），SW fetch 不受 CORS 限制；popup/options 经 sendMessage 通道驱动。
 * 源序 = core HTTPS_TIME_SOURCE_IDS（毫秒 API 在前，动态生成免疫 CDN 缓存；海外 trace 兜底，
 * 无代理设备自然超时跳过）。单源 5s 超时（AbortController）、总体 12s 上限；fetch 带
 * cache:'no-store' 防缓存层吃掉 Date 新鲜度（实测：淘宝 HEAD Date 滞后 43s 的教训）。
 */
import { computeOffsetMs, HTTPS_TIME_SOURCE_IDS, type HttpsTimeSourceId } from '@totp/core'
import type { CalibrateResult } from '@totp/ui'

const SOURCE_TIMEOUT_MS = 5000
const TOTAL_TIMEOUT_MS = 12_000

interface HttpsTimeSource {
  id: HttpsTimeSourceId
  url: string
  method: 'GET' | 'HEAD'
  parse: (res: Response) => Promise<number>
}

/** RFC7231 Date 头 → epoch ms（秒级精度，TOTP 30s 窗口足够） */
function parseDateHeader(res: Response): number {
  const v = res.headers.get('date')
  if (!v) throw new Error('time source: no date header')
  const t = new Date(v).getTime()
  if (!Number.isFinite(t)) throw new Error('time source: bad date header')
  return t
}

const SOURCES: HttpsTimeSource[] = [
  {
    id: 'taobao-api', url: 'https://acs.m.taobao.com/gw/mtop.common.getTimestamp/', method: 'GET',
    parse: async (res) => {
      const t = Number((await res.json())?.data?.t)
      if (!Number.isFinite(t)) throw new Error('time source: bad taobao payload')
      return t
    },
  },
  {
    id: 'suning-api', url: 'https://f.m.suning.com/api/ct.do', method: 'GET',
    parse: async (res) => {
      const t = Number((await res.json())?.currentTime)
      if (!Number.isFinite(t)) throw new Error('time source: bad suning payload')
      return t
    },
  },
  { id: 'baidu', url: 'https://www.baidu.com', method: 'HEAD', parse: async (res) => parseDateHeader(res) },
  { id: 'qq', url: 'https://www.qq.com', method: 'HEAD', parse: async (res) => parseDateHeader(res) },
  { id: 'gitee', url: 'https://gitee.com', method: 'HEAD', parse: async (res) => parseDateHeader(res) },
  { id: 'jd', url: 'https://www.jd.com', method: 'HEAD', parse: async (res) => parseDateHeader(res) },
  {
    id: 'cloudflare-trace', url: 'https://www.cloudflare.com/cdn-cgi/trace', method: 'GET',
    parse: async (res) => {
      const m = /ts=(\d+(?:\.\d+)?)/.exec(await res.text())
      if (!m) throw new Error('time source: bad trace payload')
      return Number(m[1]) * 1000
    },
  },
]

/** 源序校准：preferred 置顶（非法 id 跳过按内置序兜底），前源失败继续，全败 reject */
export async function calibrateNetworkTime(preferredSourceId: string | null): Promise<CalibrateResult> {
  const order: string[] = preferredSourceId ? [preferredSourceId, ...HTTPS_TIME_SOURCE_IDS.filter((id) => id !== preferredSourceId)] : [...HTTPS_TIME_SOURCE_IDS]
  const startedAt = Date.now()
  for (const id of order) {
    if (Date.now() - startedAt > TOTAL_TIMEOUT_MS) break
    const src = SOURCES.find((s) => s.id === id)
    if (!src) continue
    const t0 = Date.now()
    try {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), SOURCE_TIMEOUT_MS)
      let res: Response
      try {
        res = await fetch(src.url, { method: src.method, cache: 'no-store', signal: ctrl.signal })
      } finally {
        clearTimeout(timer)
      }
      if (!res.ok) throw new Error(`time source: http ${res.status}`)
      const serverMs = await src.parse(res)
      return { offsetMs: computeOffsetMs(serverMs, t0, Date.now()), sourceId: src.id }
    } catch { /* 该源失败：按序兜底下一源 */ }
  }
  throw new Error('time source: all sources failed')
}
```

`apps/extension/src/timeSyncInstall.ts`：

```ts
/**
 * 扩展端时间源装配（spec §4）：popup/options 各上下文安装一次 ui timeSource 单例——
 * 设备本地键=ext.storage.local['timeSyncState']（与 vault/settings 同 adapter 分区，浏览器
 * sync 同步引擎只同步白名单键，timeSyncState 不在列）；校准器=sendMessage 驱动 background
 * 执行（SW 长驻，popup 关闭中断无碍——下次打开再校）。unlock 窗不安装（无出码列表，解锁自关）。
 */
import { normalizeTimeSyncState, TIME_SYNC_STATE_KEY, type TimeSyncState } from '@totp/core'
import { initTimeSync, type CalibrateResult, type VueStore } from '@totp/ui'
import { ext } from './extApi'

/** 消息回包形状（background time-sync-calibrate 分支） */
interface CalibrateResponse {
  ok: boolean
  offsetMs?: number
  sourceId?: string
}

/** 页面端校准客户端：发消息给 background，等回包（handler 返回 true 保住 sendResponse 通道） */
async function calibrateViaBackground(preferred: string | null): Promise<CalibrateResult> {
  const resp = (await ext!.runtime.sendMessage({ type: 'time-sync-calibrate', preferred })) as CalibrateResponse | undefined
  if (!resp?.ok || typeof resp.offsetMs !== 'number' || typeof resp.sourceId !== 'string') {
    throw new Error('time source: background calibration failed')
  }
  return { offsetMs: resp.offsetMs, sourceId: resp.sourceId }
}

/** 安装（popup main.ts / options App.vue setup 调用）；load/save 的 IO 错误吞掉仅影响本次
 *  读取（内存态回退空状态），不打断出码主流程 */
export function installExtensionTimeSync(store: VueStore): void {
  initTimeSync({
    load: async (): Promise<TimeSyncState | null> => {
      try {
        const got = await ext!.storage.local.get(TIME_SYNC_STATE_KEY)
        const raw = got[TIME_SYNC_STATE_KEY]
        return typeof raw === 'string' ? normalizeTimeSyncState(JSON.parse(raw)) : null
      } catch {
        return null
      }
    },
    save: async (st) => {
      try {
        await ext!.storage.local.set({ [TIME_SYNC_STATE_KEY]: JSON.stringify(st) })
      } catch { /* 落盘失败不影响内存态生效（校准结果本会话仍生效） */ }
    },
    isNetworkMode: () => store.settings.timeSource === 'network',
    calibrate: (preferred) => calibrateViaBackground(preferred),
  })
}
```

`background.ts` onMessage listener 内（`cloud-fetch` 分支后加）：

```ts
    // 时间源校准（时间源特性 spec §4）：popup/options 经消息驱动 SW 执行源序校准。
    // 异步应答：返回 true 保持 sendResponse 通道（cloud-fetch 同款），校准最长 12s
    if (msg?.type === 'time-sync-calibrate') {
      void (async () => {
        try {
          const r = await calibrateNetworkTime(typeof msg.preferred === 'string' ? msg.preferred : null)
          sendResponse({ ok: true, offsetMs: r.offsetMs, sourceId: r.sourceId })
        } catch {
          sendResponse({ ok: false })
        }
      })()
      return true
    }
```
（import 区加 `import { calibrateNetworkTime } from '../src/timeSyncCalibrator'`；**注意该分支必须在 `cloud-fetch` 分支之后、`schedule-clipboard-clear` 之前**，且其他既有分支的 `return handleCloudFetchMessage(...)` 结构保持不动。）

`popup/main.ts`（store 单例可 import，mount 前安装）：

```ts
import { installExtensionTimeSync } from '../../src/timeSyncInstall'
import { store } from '../../src/store'
// installBackgroundCloudFetch() 之后：
installExtensionTimeSync(store)
```

`options/App.vue` setup 顶部（store 就地创建处，`createExtensionStore('options', ...)` 与 `await initStore()` 附近，store 常量声明之后同步调用）：

```ts
installExtensionTimeSync(store)
```
（import 区加对应 import。）

- [ ] **Step 4: 跑测试 + 回归**

Run: `pnpm --filter @totp/extension exec vitest run`
Expected: PASS（既有 background.test.ts/popupApp.test.ts 不受影响；若 background.test.ts 对 onMessage 分支数有断言，按新分支补充）

- [ ] **Step 5: typecheck + Commit**

Run: `pnpm --filter @totp/extension run typecheck`
Expected: PASS

```bash
git add apps/extension/src/timeSyncCalibrator.ts apps/extension/src/timeSyncInstall.ts apps/extension/entrypoints/background.ts apps/extension/entrypoints/popup/main.ts apps/extension/entrypoints/options/App.vue apps/extension/test/timeSyncCalibrator.test.ts
git commit -m "feat(extension): 网络时间校准器——background 七源序校准+消息通道，popup/options 装配 timeSource"
```

---

### Task 4: 桌面 Rust SNTP 校准命令

**Files:**
- Create: `apps/desktop/src-tauri/src/time_sync.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`（`mod time_sync;` + generate_handler 注册 `time_calibrate`）

**Interfaces:**
- Consumes: 既有 `reqwest`/`tokio`/`serde_json` 依赖（零新增）。
- Produces（Task 5 消费）：
  - Tauri 命令 `time_calibrate(preferred: Option<String>) -> Result<TimeCalibrateResult, String>`
  - `#[derive(Serialize, Deserialize)] #[serde(rename_all = "camelCase")] struct TimeCalibrateResult { offset_ms: i64, source_id: String }`（JSON 形态 `{ offsetMs, sourceId }`）
  - source id 取值：NTP 池 id（`aliyun`/`tencent`/`tencent-time1`/`neu`/`cn-pool`/`tuna`/`windows`）或降级毫秒 API id（`taobao-api`/`suning-api`，与扩展端 id 对齐）

- [ ] **Step 1: 写失败测试（time_sync.rs 内 `#[cfg(test)]`，先写骨架后补实现）**

测试用例（实现落地后跑）：

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_packet_is_sntp_v4_client() {
        let p = build_request();
        assert_eq!(p.len(), 48);
        assert_eq!(p[0], 0x23); // LI=0 VN=4 Mode=3(client)
        assert!(p[1..].iter().all(|&b| b == 0));
    }

    #[test]
    fn parse_transmit_timestamp_epoch_conversion() {
        // 已知戳：sec=0xEFAF_3C00（2026-11-10T00:00:00Z 附近锚点），frac=2^32/2 → +500ms
        // 用真实锚点：2026-11-10T00:00:00Z = 1791753600 s since epoch = 4000742400 since NTP 1900
        let sec: u32 = 1_791_753_600 + 2_208_988_800;
        let frac: u32 = 2_147_483_648; // 0.5s
        let mut buf = [0u8; 48];
        buf[40..44].copy_from_slice(&sec.to_be_bytes());
        buf[44..48].copy_from_slice(&frac.to_be_bytes());
        let ms = parse_transmit_ms(&buf).expect("valid packet");
        assert_eq!(ms, 1_791_753_600_500i64); // 1970 基准毫秒 + 500
    }

    #[test]
    fn parse_rejects_kod_and_short_packets() {
        let mut buf = [0u8; 48];
        assert!(parse_transmit_ms(&buf).is_none()); // sec=0（KoD/零戳）
        assert!(parse_transmit_ms(&buf[..40]).is_none()); // 短包
    }

    #[test]
    fn offset_midpoint_formula_matches_core() {
        // 与 core computeOffsetMs 同式（Review Focus 2）：server - (t0+t1)/2
        assert_eq!(offset_from(100_000, 1000, 2000), 98_500);
        assert_eq!(offset_from(1_791_753_600_500, 1_000, 3_000), 1_791_753_600_000 - 1_000);
    }

    #[test]
    fn pool_order_prefers_known_source() {
        let order = pool_order(Some("neu".to_string()));
        assert_eq!(order[0], "neu");
        assert_eq!(order.len(), NTP_POOL.len());
        // 非池内 preferred 被忽略（不产生未知名次的洞）：恒等价于纯内置序
        let order2 = pool_order(Some("evil.example".to_string()));
        let builtin: Vec<&'static str> = NTP_POOL.iter().map(|(id, _)| *id).collect();
        assert_eq!(order2, builtin);
    }
}
```

- [ ] **Step 2: 实现** `apps/desktop/src-tauri/src/time_sync.rs`

```rust
//! 网络时间校准（时间源特性 spec §5）：SNTPv4 池 racing（UDP 123，主路径——不经 TLS，
//! 设备时钟严重错误时仍可校准）+ 毫秒 API HTTPS 降级（reqwest 已有；serde_json 免 RFC7231
//! 日期解析）。源池/源序为 2026-11-10 国内直连实测序（spec 事实基础），preferred 置顶仍全池兜底。

use serde::{Deserialize, Serialize};
use std::net::UdpSocket;
use std::sync::mpsc;
use std::time::{Duration, Instant};

/// NTP 1900 基准 → Unix 1970 基准（毫秒）
const NTP_EPOCH_DELTA_MS: i64 = 2_208_988_800_000;
/// 单 SNTP 查询超时（socket read timeout；线程自然退出防泄漏）
const SNTP_READ_TIMEOUT: Duration = Duration::from_secs(4);
/// 池 racing 总控超时
const POOL_DEADLINE: Duration = Duration::from_secs(5);
/// HTTPS 降级单请求超时
const HTTPS_TIMEOUT: Duration = Duration::from_secs(5);

/// SNTP 池（id 与 core NTP_TIME_SOURCE_IDS 对齐；ui 源 label 按 id 取 i18n）
const NTP_POOL: &[(&str, &str)] = &[
    ("aliyun", "ntp.aliyun.com"),
    ("tencent", "ntp.tencent.com"),
    ("tencent-time1", "time1.cloud.tencent.com"),
    ("neu", "ntp.neu.edu.cn"),
    ("cn-pool", "cn.pool.ntp.org"),
    ("tuna", "ntp.tuna.tsinghua.edu.cn"),
    ("windows", "time.windows.com"),
];

/// HTTPS 降级毫秒 API（id 与扩展端对齐；测试锚点用真实响应形状）
const HTTPS_FALLBACK: &[(&str, &str)] = &[
    ("taobao-api", "https://acs.m.taobao.com/gw/mtop.common.getTimestamp/"),
    ("suning-api", "https://f.m.suning.com/api/ct.do"),
];

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimeCalibrateResult {
    pub offset_ms: i64,
    pub source_id: String,
}

/// SNTPv4 客户端请求包：LI=0 VN=4 Mode=3(client)，其余全零
fn build_request() -> [u8; 48] {
    let mut p = [0u8; 48];
    p[0] = 0x23;
    p
}

/// 解析 transmit timestamp（包尾 8 字节）→ Unix epoch ms；sec=0（KoD/零戳）与短包拒绝
fn parse_transmit_ms(buf: &[u8]) -> Option<i64> {
    if buf.len() < 48 {
        return None;
    }
    let sec = u32::from_be_bytes([buf[40], buf[41], buf[42], buf[43]]) as i64;
    if sec == 0 {
        return None;
    }
    let frac = u32::from_be_bytes([buf[44], buf[45], buf[46], buf[47]]) as i64;
    Some(sec * 1000 + frac * 1000 / (1u64 << 32) as i64 - NTP_EPOCH_DELTA_MS)
}

/// 与 core computeOffsetMs 同式（中点假设）
fn offset_from(server_ms: i64, t0_ms: i64, t1_ms: i64) -> i64 {
    server_ms - (t0_ms + t1_ms) / 2
}

fn now_unix_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 单域名阻塞查询（std::thread 内执行；read timeout 防线程泄漏）。
/// 返回 (server_ms, t0, t1)——send/recv 前后本地毫秒随结果回传，主循环精确中点补偿 RTT
fn sntp_query_once(host: &str) -> Option<(i64, i64, i64)> {
    let sock = UdpSocket::connect((host, 123)).ok()?;
    sock.set_read_timeout(Some(SNTP_READ_TIMEOUT)).ok()?;
    let req = build_request();
    let t0 = now_unix_ms();
    sock.send(&req).ok()?;
    let mut buf = [0u8; 48];
    let n = sock.recv(&mut buf).ok()?;
    let t1 = now_unix_ms();
    parse_transmit_ms(&buf[..n]).map(|server_ms| (server_ms, t0, t1))
}

/// preferred 置顶（仅收池内已知 id；未知 id 忽略），其余按内置序
fn pool_order(preferred: Option<&str>) -> Vec<&'static str> {
    let mut order: Vec<&'static str> = Vec::new();
    if let Some(p) = preferred {
        if let Some((id, _)) = NTP_POOL.iter().find(|(id, _)| *id == p) {
            order.push(id);
        }
    }
    for (id, _) in NTP_POOL {
        if !order.contains(id) {
            order.push(id);
        }
    }
    order
}

/// 池 racing：全池并发线程 + mpsc 收首个成功；总控超时后转 HTTPS 降级
async fn sntp_pool_offset(preferred: Option<&str>) -> Option<TimeCalibrateResult> {
    let (tx, rx) = mpsc::channel::<(&'static str, i64, i64, i64)>();
    let mut spawned = 0usize;
    for id in pool_order(preferred) {
        let host = NTP_POOL.iter().find(|(i, _)| *i == id).map(|(_, h)| *h).unwrap_or_default();
        let tx = tx.clone();
        std::thread::spawn(move || {
            if let Some((server_ms, t0, t1)) = sntp_query_once(host) {
                let _ = tx.send((id, server_ms, t0, t1));
            }
        });
        spawned += 1;
    }
    drop(tx);
    if spawned == 0 {
        return None;
    }
    let deadline = Instant::now() + POOL_DEADLINE;
    loop {
        let remain = deadline.saturating_duration_since(Instant::now());
        if remain.is_zero() {
            return None;
        }
        match rx.recv_timeout(remain) {
            Ok((source_id, server_ms, t0, t1)) => {
                return Some(TimeCalibrateResult {
                    offset_ms: offset_from(server_ms, t0, t1),
                    source_id: source_id.to_string(),
                });
            }
            Err(mpsc::RecvTimeoutError::Timeout) => return None,
            Err(mpsc::RecvTimeoutError::Disconnected) => return None,
        }
    }
}
```

HTTPS 降级：

```rust
/// SNTP 全败后的毫秒 API 降级（serde_json 解析，免日期字符串处理）；任一成功即返回
async fn https_fallback() -> Option<TimeCalibrateResult> {
    let client = reqwest::Client::builder().timeout(HTTPS_TIMEOUT).build().ok()?;
    for (id, url) in HTTPS_FALLBACK {
        let t0 = now_unix_ms();
        let resp = match client.get(*url).send().await {
            Ok(r) if r.status().is_success() => r,
            _ => continue,
        };
        let body: serde_json::Value = match resp.json().await {
            Ok(b) => b,
            Err(_) => continue,
        };
        let server_ms = body
            .pointer("/data/t")
            .and_then(|v| v.as_str())
            .and_then(|s| s.parse::<i64>().ok())
            .or_else(|| body.get("currentTime").and_then(|v| v.as_i64()));
        let Some(server_ms) = server_ms else { continue };
        let t1 = now_unix_ms();
        return Some(TimeCalibrateResult {
            offset_ms: offset_from(server_ms, t0, t1),
            source_id: (*id).to_string(),
        });
    }
    None
}

/// Tauri 命令：SNTP 池 racing → 全败转 HTTPS 降级 → 全败报错（调用方回退设备时间）
#[tauri::command]
pub async fn time_calibrate(preferred: Option<String>) -> Result<TimeCalibrateResult, String> {
    if let Some(r) = sntp_pool_offset(preferred.as_deref()).await {
        return Ok(r);
    }
    https_fallback().await.ok_or_else(|| "time calibrate: all sources failed".to_string())
}
```

`lib.rs`：`mod` 声明区加 `mod time_sync;`；`generate_handler!` 列表（:1149 起，`cloud_http_fetch` :1186 同列）加 `time_sync::time_calibrate,`。

- [ ] **Step 3: 跑 Rust 测试 + 编译**

Run: `cd apps/desktop/src-tauri && cargo test time_sync && cargo check`
Expected: PASS（5 个单测全绿；`cargo check` 无错误。前端 invoke 该命令在 Task 5 接线）

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src-tauri/src/time_sync.rs apps/desktop/src-tauri/src/lib.rs
git commit -m "feat(desktop): Rust SNTP 池 racing 校准命令——UDP 主路径+毫秒 API 降级，时钟严重错误亦可校准"
```

---

### Task 5: 桌面前端接线（localStorage 本地键 + invoke 校准器）

**Files:**
- Create: `apps/desktop/src/timeSyncPlatform.ts`
- Modify: `apps/desktop/src/desktopShell.ts`（`bootDesktopStore` :86-108 内安装——main/mini 双窗共用此 boot 序列，天然覆盖两窗）
- Test: `apps/desktop/test/timeSyncPlatform.test.ts`（新建）

**Interfaces:**
- Consumes: Task 2（`initTimeSync`/`timeSource`）、Task 4（`invoke('time_calibrate', { preferred })` → `{ offsetMs, sourceId }`）。
- Produces: `installDesktopTimeSync(s: VueStore): void`（幂等：mini 聚焦重建 store 后重复安装覆盖单例）。

- [ ] **Step 1: 写失败测试** `apps/desktop/test/timeSyncPlatform.test.ts`

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EMPTY_TIME_SYNC_STATE, type TimeSyncState } from '@totp/core'
import { installDesktopTimeSync, timeSyncStorage } from '../src/timeSyncPlatform'

// mock tauri invoke（tauriFs.test.ts mocks/ 同款手法）
const invokeMock = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }))

function fakeStore(timeSource: 'device' | 'network') {
  return { settings: { timeSource } } as unknown as import('@totp/ui').VueStore
}

describe('timeSyncStorage（localStorage 本地键，spec §1）', () => {
  beforeEach(() => { localStorage.clear(); invokeMock.mockReset() })

  it('缺失 → null；坏 JSON → null；合法 → 归一化', async () => {
    expect(await timeSyncStorage.load()).toBeNull()
    localStorage.setItem('timeSyncState', '{oops')
    expect(await timeSyncStorage.load()).toBeNull()
    const st: TimeSyncState = { ...EMPTY_TIME_SYNC_STATE, offsetMs: 42, syncedAt: 1, sourceId: 'aliyun' }
    localStorage.setItem('timeSyncState', JSON.stringify(st))
    expect(await timeSyncStorage.load()).toEqual(st)
  })

  it('save/load 往返', async () => {
    const st: TimeSyncState = { ...EMPTY_TIME_SYNC_STATE, offsetMs: -5, syncedAt: 2, sourceId: 'neu' }
    await timeSyncStorage.save(st)
    expect(await timeSyncStorage.load()).toEqual(st)
  })
})

describe('installDesktopTimeSync', () => {
  beforeEach(() => { localStorage.clear(); invokeMock.mockReset() })

  it('校准走 invoke time_calibrate：preferred 透传 null、回包转 CalibrateResult', async () => {
    invokeMock.mockResolvedValue({ offsetMs: 123, sourceId: 'aliyun' })
    installDesktopTimeSync(fakeStore('network'))
    const ts = (await import('@totp/ui')).timeSource()
    await ts.calibrateNow()
    expect(invokeMock).toHaveBeenCalledWith('time_calibrate', { preferred: null })
    expect(ts.state.value.offsetMs).toBe(123)
    expect(ts.state.value.sourceId).toBe('aliyun')
  })

  it('preferred 非 null 透传；isNetworkMode 跟随 settings.timeSource', async () => {
    invokeMock.mockResolvedValue({ offsetMs: 1, sourceId: 'neu' })
    const store = fakeStore('network')
    installDesktopTimeSync(store)
    const ts = (await import('@totp/ui')).timeSource()
    await ts.calibrateNow({ preferredSourceId: 'tuna' })
    expect(invokeMock).toHaveBeenCalledWith('time_calibrate', { preferred: 'tuna' })
    expect(ts.effectiveNowMs()).toBeGreaterThan(Date.now()) // network 模式偏移生效
    ;(store.settings as { timeSource: string }).timeSource = 'device'
    expect(Math.abs(ts.effectiveNowMs() - Date.now())).toBeLessThan(50) // device 模式零偏移
  })

  it('invoke 失败：calibrateNow reject（手动 toast 失败），state 记失败', async () => {
    invokeMock.mockRejectedValue(new Error('all sources failed'))
    installDesktopTimeSync(fakeStore('network'))
    const ts = (await import('@totp/ui')).timeSource()
    await expect(ts.calibrateNow()).rejects.toThrow()
    expect(ts.state.value.lastAttemptFailed).toBe(true)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @totp/desktop exec vitest run test/timeSyncPlatform.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现** `apps/desktop/src/timeSyncPlatform.ts`

```ts
/**
 * 桌面端时间源装配（时间源特性 spec §5）：设备本地键=localStorage['timeSyncState']
 * （desktopPrefs 同款模式，main/mini 双窗同 origin 共享）；校准器=invoke('time_calibrate')
 * （Rust SNTP 池 racing + 毫秒 API 降级，Task 4）。bootDesktopStore 内安装——main/mini
 * 双窗共用该 boot 序列，天然覆盖；幂等（重复安装覆盖 ui 单例）。
 */
import { normalizeTimeSyncState, TIME_SYNC_STATE_KEY, type TimeSyncState } from '@totp/core'
import { initTimeSync, type VueStore } from '@totp/ui'
import { invoke } from '@tauri-apps/api/core'

/** localStorage 本地键 IO（desktopPrefs 同款：坏 JSON/不可写静默回退，不打断出码主流程） */
export const timeSyncStorage = {
  async load(): Promise<TimeSyncState | null> {
    try {
      const raw = localStorage.getItem(TIME_SYNC_STATE_KEY)
      return raw ? normalizeTimeSyncState(JSON.parse(raw)) : null
    } catch {
      return null
    }
  },
  async save(st: TimeSyncState): Promise<void> {
    try {
      localStorage.setItem(TIME_SYNC_STATE_KEY, JSON.stringify(st))
    } catch { /* 落盘失败不影响内存态生效 */ }
  },
}

interface TimeCalibrateDto {
  offsetMs: number
  sourceId: string
}

export function installDesktopTimeSync(s: VueStore): void {
  initTimeSync({
    load: () => timeSyncStorage.load(),
    save: (st) => timeSyncStorage.save(st),
    isNetworkMode: () => s.settings.timeSource === 'network',
    calibrate: async (preferred): Promise<{ offsetMs: number; sourceId: string }> => {
      const r = await invoke<TimeCalibrateDto>('time_calibrate', { preferred: preferred ?? null })
      return { offsetMs: r.offsetMs, sourceId: r.sourceId }
    },
  })
}
```

`desktopShell.ts` 的 `bootDesktopStore`（:86-108）在 `await s.initStore()` 之后、`return s` 之前加：

```ts
  // 时间源装配（时间源特性 spec §5）：main/mini 双窗各自安装 ui timeSource 单例
  // （localStorage 本地键共享、invoke 校准器）；幂等覆盖，mini 聚焦重建 store 后同样生效
  installDesktopTimeSync(s)
```
（import 区加 `import { installDesktopTimeSync } from './timeSyncPlatform'`。）

- [ ] **Step 4: 跑测试 + 回归 + typecheck**

Run: `pnpm --filter @totp/desktop exec vitest run && pnpm --filter @totp/desktop run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/timeSyncPlatform.ts apps/desktop/src/desktopShell.ts apps/desktop/test/timeSyncPlatform.test.ts
git commit -m "feat(desktop): 时间源前端接线——localStorage 本地键+SNTP 命令装配，双窗 boot 收敛安装"
```

---

### Task 6: 同步动作 composable + 设置页时间源卡 + i18n

**Files:**
- Create: `packages/ui/src/composables/useTimeSyncAction.ts`
- Modify: `packages/ui/src/pages/SettingsPage.vue`（新卡：外观卡 `</MdCard>`（:171）之后插入）
- Modify: `packages/ui/src/components/iconPaths.ts`（增 sync path）
- Modify: `packages/ui/src/i18n/locales/zh/common.json`、`en/common.json`（settingsPage 域 + timeSync 域）
- Modify: `packages/ui/src/index.ts`（导出 useTimeSyncAction）
- Test: `packages/ui/test/pages/SettingsPage.test.ts`、`SettingsPage.desktop.test.ts`（补时间源卡用例）

**Interfaces:**
- Consumes: Task 2 `timeSource()`（`syncing`/`state`/`calibrateNow`/`setPreferredSource`）、Task 1 源 id 清单、`useToast`。
- Produces:
  - `useTimeSyncAction(): { syncing: Ref<boolean>; syncNow(): Promise<void> }`（校准 + 结果 toast；Task 7 出码页复用）
  - sync 图标：`import { sync } from '../components/iconPaths'`

- [ ] **Step 1: 写失败测试**

`packages/ui/test/pages/SettingsPage.test.ts` 补（沿用既有挂载/dumy store 手法——执行时读该文件既有 setup 复用）：

```ts
describe('时间源卡（plan24 spec §6）', () => {
  it('device 模式：仅模式行渲染，无首选源/同步按钮', async () => {
    // store.settings.timeSource='device' 挂载
    // 断言：模式 segmented 两选项渲染；[data-test="time-preferred"] 与 [data-test="time-sync-now"] 不存在
  })
  it('切到 network：展开首选源与同步区', async () => {
    // 点击 segmented network 项 → settings.timeSource==='network' 且 commitSettings 被调
    // 断言 [data-test="time-preferred"] 渲染
  })
  it('首选源 options：扩展端为 HTTPS 七源+auto（showDesktop=false）', async () => {
    // MdSelect options 断言首项 value==='auto'，其余 7 项与 HTTPS_TIME_SOURCE_IDS 一致
  })
  it('首选源变更：setPreferredSource 落盘不触发校准', async () => {
    // 触发 MdSelect update:model-value='gitee' → timeSource().state.preferredSourceId==='gitee'
  })
  it('立即同步成功：toast 方向文案（offset>0 落后）', async () => {
    // mock calibrateNow resolve offsetMs=2500 → toast.show 被调，文案含 2.5
  })
  it('立即同步失败：toast error', async () => {
    // mock calibrateNow reject → toast.show(…, 'error')
  })
  it('状态行：从未同步 / 上次成功含来源与偏差 / 上次失败', async () => {
    // 分别以 state 三态挂载断言 data-test="time-status" 文本
  })
})
```

（用例代码骨架如上；执行者在既有测试文件语境下补全挂载与查询，**不得**新建平行 setup。`SettingsPage.desktop.test.ts` 补一条：`showDesktop=true 时首选源 options 为 NTP 七源`。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @totp/ui exec vitest run test/pages/SettingsPage.test.ts`
Expected: FAIL（无时间源卡）

- [ ] **Step 3: 实现**

`packages/ui/src/components/iconPaths.ts` 增：

```ts
/** sync（Material Icons 24dp）：网络时间「立即同步」按钮 */
export const sync: IconPath = {
  viewBox: '0 0 24 24',
  d: 'M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z',
}
```

`packages/ui/src/composables/useTimeSyncAction.ts`：

```ts
/**
 * 时间源同步动作（时间源特性 spec §6）：calibrateNow + 结果 toast 三态（落后/超前/已对齐）。
 * SettingsPage 与 CodesPage/popup 出码页按钮共用（Task 7）。toast 文案键在 timeSync.* 顶层域。
 */
import { timeSource } from '../timeSource'
import { useI18n } from 'vue-i18n'
import { useToast } from './useToast'

/** 已对齐阈值：|offset| < 50ms 视为同步无偏差（toast 用「已对齐」文案） */
const ALIGNED_EPS_MS = 50

export function useTimeSyncAction(): { syncing: import('vue').Ref<boolean>; syncNow(): Promise<void> } {
  const ts = timeSource()
  const { t } = useI18n()
  const toast = useToast()
  async function syncNow(): Promise<void> {
    try {
      const st = await ts.calibrateNow()
      const off = st.offsetMs ?? 0
      if (Math.abs(off) < ALIGNED_EPS_MS) {
        toast.show(t('timeSync.toastAligned'))
      } else if (off > 0) {
        toast.show(t('timeSync.toastBehind', { seconds: (off / 1000).toFixed(1) }))
      } else {
        toast.show(t('timeSync.toastAhead', { seconds: (Math.abs(off) / 1000).toFixed(1) }))
      }
    } catch {
      toast.show(t('timeSync.toastFailed'), 'error')
    }
  }
  return { syncing: ts.syncing, syncNow }
}
```

`SettingsPage.vue`：script 增（照 :74-83 LOCALE_OPTIONS/MdSelect 先例与 :140-142 MdSegmentedButton 先例）：

```ts
import { HTTPS_TIME_SOURCE_IDS, NTP_TIME_SOURCE_IDS } from '@totp/core'
import { timeSource } from '../timeSource'
import { useTimeSyncAction } from '../composables/useTimeSyncAction'

const ts = timeSource()
const { syncing: timeSyncing, syncNow: timeSyncNow } = useTimeSyncAction()

/** 源 id → i18n label 键映射（id 单一事实源在 core；两组合并供状态行「来源 xx」展示，
 *  桌面 SNTP 降级可能命中 taobao-api，故扩展源 label 在桌面状态行同样可达） */
const SOURCE_LABEL_KEYS: Record<string, string> = {
  'taobao-api': 'settingsPage.timeSourceSrcTaobaoApi',
  'suning-api': 'settingsPage.timeSourceSrcSuningApi',
  baidu: 'settingsPage.timeSourceSrcBaidu',
  qq: 'settingsPage.timeSourceSrcQq',
  gitee: 'settingsPage.timeSourceSrcGitee',
  jd: 'settingsPage.timeSourceSrcJd',
  'cloudflare-trace': 'settingsPage.timeSourceSrcCloudflareTrace',
  aliyun: 'settingsPage.timeSourceSrcAliyun',
  tencent: 'settingsPage.timeSourceSrcTencent',
  'tencent-time1': 'settingsPage.timeSourceSrcTencentTime1',
  neu: 'settingsPage.timeSourceSrcNeu',
  'cn-pool': 'settingsPage.timeSourceSrcCnPool',
  tuna: 'settingsPage.timeSourceSrcTuna',
  windows: 'settingsPage.timeSourceSrcWindows',
}
function sourceLabel(id: string | null): string {
  return id && SOURCE_LABEL_KEYS[id] ? t(SOURCE_LABEL_KEYS[id]!) : (id ?? '')
}

const TIME_SOURCE_MODE_OPTIONS = computed<Array<{ value: 'device' | 'network'; label: string }>>(() => [
  { value: 'device', label: t('settingsPage.timeSourceModeDevice') },
  { value: 'network', label: t('settingsPage.timeSourceModeNetwork') },
])
/** 首选源 options：auto + 平台源组（桌面=NTP 池，扩展=HTTPS 源） */
const PREFERRED_OPTIONS = computed<Array<{ value: string; label: string }>>(() => [
  { value: 'auto', label: t('settingsPage.timeSourcePreferredAuto') },
  ...(props.showDesktop ? NTP_TIME_SOURCE_IDS : HTTPS_TIME_SOURCE_IDS).map((id) => ({ value: id, label: sourceLabel(id) })),
])
const preferredSelectValue = computed(() => ts.state.value.preferredSourceId ?? 'auto')
async function setTimeSourceMode(v: string) {
  const next = v === 'network' ? 'network' : 'device'
  props.store.settings.timeSource = next
  await props.store.commitSettings()
  // 切到 network 且无有效偏移：立即校准一次（spec §3-②，结果走 toast）
  if (next === 'network' && ts.state.value.offsetMs === null) void timeSyncNow()
}
function setPreferredSource(v: string) {
  void ts.setPreferredSource(v === 'auto' ? null : v)
}
/** 状态行（data-test="time-status"）：从未同步 / 失败 / 上次成功（时刻+来源+偏差方向） */
const timeSyncStatus = computed<string | null>(() => {
  const st = ts.state.value
  if (st.offsetMs !== null && st.syncedAt !== null) {
    const drift = Math.abs(st.offsetMs) < 50
      ? t('settingsPage.timeSourceDriftAligned')
      : st.offsetMs > 0
        ? t('settingsPage.timeSourceDriftBehind', { seconds: (st.offsetMs / 1000).toFixed(1) })
        : t('settingsPage.timeSourceDriftAhead', { seconds: (Math.abs(st.offsetMs) / 1000).toFixed(1) })
    return `${t('settingsPage.timeSourceLastSync', { time: new Date(st.syncedAt).toLocaleTimeString(), source: sourceLabel(st.sourceId) })} · ${drift}`
  }
  if (st.lastAttemptFailed && st.lastAttemptAt !== null) {
    return t('settingsPage.timeSourceLastFailed', { time: new Date(st.lastAttemptAt).toLocaleTimeString() })
  }
  return null
})
```

template（外观卡 `</MdCard>` :171 之后插入）：

```vue
    <MdCard class="block">
      <template #header>{{ t('settingsPage.timeSource') }}</template>
      <div class="appearance-rows">
        <div class="row">
          <span class="row-label">{{ t('settingsPage.timeSourceMode') }}<span class="row-hint">{{ t('settingsPage.timeSourceModeHint') }}</span></span>
          <MdSegmentedButton :model-value="store.settings.timeSource" :options="TIME_SOURCE_MODE_OPTIONS" data-test="time-mode" @update:model-value="setTimeSourceMode" />
        </div>
        <template v-if="store.settings.timeSource === 'network'">
          <div class="row">
            <span class="row-label">{{ t('settingsPage.timeSourcePreferred') }}</span>
            <MdSelect
              class="set-time-source" data-test="time-preferred" :label="t('settingsPage.timeSourcePreferred')" :aria-label="t('settingsPage.timeSourcePreferred')"
              :model-value="preferredSelectValue" :options="PREFERRED_OPTIONS" @update:model-value="setPreferredSource"
            />
          </div>
          <div class="row">
            <span class="row-label" data-test="time-status">{{ timeSyncStatus ?? t('settingsPage.timeSourceNeverSynced') }}</span>
            <MdButton data-test="time-sync-now" :disabled="timeSyncing" @click="timeSyncNow">
              {{ timeSyncing ? t('settingsPage.timeSourceSyncing') : t('settingsPage.timeSourceSyncNow') }}
            </MdButton>
          </div>
        </template>
      </div>
    </MdCard>
```

i18n（zh 侧；en 同键位英文）——`settingsPage` 域追加：

```json
"timeSource": "时间源",
"timeSourceMode": "校时来源",
"timeSourceModeHint": "网络时间通过校准偏移修正设备时钟偏差；偏移量仅保存在本设备",
"timeSourceModeDevice": "设备时间",
"timeSourceModeNetwork": "网络时间",
"timeSourcePreferred": "首选源",
"timeSourcePreferredAuto": "自动（按内置优先级）",
"timeSourceSyncNow": "立即同步",
"timeSourceSyncing": "同步中…",
"timeSourceNeverSynced": "尚未同步",
"timeSourceLastSync": "上次同步 {time} · 来源 {source}",
"timeSourceDriftBehind": "本机落后 {seconds} 秒",
"timeSourceDriftAhead": "本机超前 {seconds} 秒",
"timeSourceDriftAligned": "与网络时间对齐",
"timeSourceLastFailed": "上次同步失败（{time}），仍在使用设备时间",
"timeSourceSrcTaobaoApi": "淘宝时间接口",
"timeSourceSrcSuningApi": "苏宁时间接口",
"timeSourceSrcBaidu": "百度",
"timeSourceSrcQq": "腾讯门户",
"timeSourceSrcGitee": "Gitee",
"timeSourceSrcJd": "京东",
"timeSourceSrcCloudflareTrace": "Cloudflare（海外）",
"timeSourceSrcAliyun": "阿里云 NTP",
"timeSourceSrcTencent": "腾讯云 NTP",
"timeSourceSrcTencentTime1": "腾讯云 NTP 备用",
"timeSourceSrcNeu": "东北大学 NTP",
"timeSourceSrcCnPool": "NTP Pool 中国区",
"timeSourceSrcTuna": "清华大学 NTP",
"timeSourceSrcWindows": "Microsoft NTP",
```

顶层新域 `timeSync`（zh）：

```json
"timeSync": {
  "toastBehind": "本机落后网络时间 {seconds} 秒",
  "toastAhead": "本机超前网络时间 {seconds} 秒",
  "toastAligned": "本机时间已与网络对齐",
  "toastFailed": "时间同步失败，已继续使用设备时间"
}
```

（若 zh/en common.json 为平铺键结构（`"settingsPage.xxx": "…"`），按文件既有形态落地——执行者先读 locale 文件确认嵌套/平铺，两种形态 `t()` 调用无差异；`check-i18n-keys.mjs` 校验键引用一致性。en 侧对应：Time source / Calibration source / Network time corrects device clock drift; the offset is stored locally on this device / Device clock / Network time / Preferred source / Automatic (built-in order) / Sync now / Syncing… / Never synced / Last synced {time} · source {source} / Device is {seconds}s behind / Device is {seconds}s ahead / Aligned with network time / Last sync failed ({time}); using device clock / Taobao time API / Suning time API / Baidu / Tencent portal / Gitee / JD.com / Cloudflare (overseas) / Aliyun NTP / Tencent Cloud NTP / Tencent Cloud NTP backup / NEU NTP / NTP Pool (CN) / Tsinghua NTP / Microsoft NTP；timeSync.toastBehind "Device is {seconds}s behind network time" / toastAhead "Device is {seconds}s ahead of network time" / toastAligned "Device clock is aligned with network time" / toastFailed "Time sync failed; using device clock"。）

`index.ts` 导出 `useTimeSyncAction`（ui/src/index.ts 既有 composables 导出区）。

- [ ] **Step 4: 跑测试 + i18n 守卫 + typecheck**

Run: `pnpm --filter @totp/ui exec vitest run test/pages/SettingsPage.test.ts test/pages/SettingsPage.desktop.test.ts && node scripts/check-i18n-keys.mjs && pnpm --filter @totp/ui run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/composables/useTimeSyncAction.ts packages/ui/src/pages/SettingsPage.vue packages/ui/src/components/iconPaths.ts packages/ui/src/i18n/locales/zh/common.json packages/ui/src/i18n/locales/en/common.json packages/ui/src/index.ts packages/ui/test/pages/SettingsPage.test.ts packages/ui/test/pages/SettingsPage.desktop.test.ts
git commit -m "feat(ui): 设置页时间源卡——模式切换/首选源/立即同步/状态行，toast 三态反馈"
```

---

### Task 7: 出码页/popup 立即同步按钮（齐平不增行）

**Files:**
- Modify: `packages/ui/src/pages/CodesPage.vue`（`.card-head` :402-407 + script）
- Modify: `apps/extension/entrypoints/popup/App.vue`（`.header-ops` :369-377 + script）
- Modify: `packages/ui/src/i18n/locales/zh/common.json`、`en/common.json`（codesPage.syncNow / popup.syncNow）
- Test: `packages/ui/test/pages/CodesPage.test.ts`、`apps/extension/test/popupApp.test.ts`（补条件渲染用例）

**Interfaces:**
- Consumes: Task 6 `useTimeSyncAction`、`sync` iconPath；`store.settings.timeSource`。
- Produces: 无新接口（消费面 UI）。

- [ ] **Step 1: 写失败测试**

`CodesPage.test.ts` 补：

```ts
describe('时间源同步按钮（plan24 spec §6，齐平不增行）', () => {
  it('device 模式：不渲染同步按钮', () => {
    // store.settings.timeSource='device' 挂载 → [data-test="codes-sync-now"] 不存在
  })
  it('network 模式：渲染于 .card-head 行内（与「选择」按钮同级不新增行）', () => {
    // timeSource='network' 挂载 → [data-test="codes-sync-now"] 存在；
    // 断言其父容器为 .card-head（与 select-mode 按钮同父）
  })
  it('点击触发 calibrateNow（mock timeSource）', async () => {
    // vi.spyOn(timeSource(), 'calibrateNow')…点击 → 被调
  })
})
```

`popupApp.test.ts` 补同构两用例（`[data-test="popup-sync-now"]` 存在性 + `.header-ops` 同父断言）。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @totp/ui exec vitest run test/pages/CodesPage.test.ts` 与 `pnpm --filter @totp/extension exec vitest run test/popupApp.test.ts`
Expected: FAIL（按钮不存在）

- [ ] **Step 3: 实现**

`CodesPage.vue` script 增：

```ts
import { sync as syncIcon } from '../components/iconPaths'
import { timeSource } from '../timeSource'
import { useTimeSyncAction } from '../composables/useTimeSyncAction'

// 网络时间「立即同步」（spec §6）：仅 network 模式渲染于 .card-head，与「选择」钮齐平
const { syncing: timeSyncing, syncNow: timeSyncNow } = useTimeSyncAction()
const timeSourceMode = computed(() => props.store.settings.timeSource)
```

`.card-head` 改为：

```vue
      <div class="card-head">
        <h2>{{ t('codesPage.entryCount', { count: store.vault.entries.length }) }}</h2>
        <div class="card-head-ops">
          <MdIconButton
            v-if="timeSourceMode === 'network'" data-test="codes-sync-now"
            :title="t('codesPage.syncNow')" :aria-label="t('codesPage.syncNow')"
            :class="{ 'sync-spinning': timeSyncing }" @click="timeSyncNow"
          ><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path :d="syncIcon.d" /></svg></MdIconButton>
          <MdButton v-if="sorted.length > 0" data-test="select-mode" variant="text" @click="toggleSelectMode">
            {{ selecting ? t('codesPage.cancelSelect') : t('codesPage.select') }}
          </MdButton>
        </div>
      </div>
```
style 追加：

```css
/* 同步钮与「选择」同行：ops 组 flex 对齐；syncing 时图标旋转反馈 */
.card-head-ops { display: flex; align-items: center; gap: 4px; }
.sync-spinning svg { animation: sync-rotate 1s linear infinite; }
@keyframes sync-rotate { to { transform: rotate(360deg); } }
```

`popup/App.vue` script 增：

```ts
import { sync as SYNC_ICON_PATH, /* …既有导入保持 */ } from '@totp/ui'
import { useTimeSyncAction } from '@totp/ui'
// 图标 path 若未从 @totp/ui 导出：popup 现有 NAV_ICONS 先例走 @totp/ui 桶——iconPaths 的 sync
// 随 Task 6 一起从 ui index 导出（export * from './components/iconPaths' 若已有则免）
const { syncing: timeSyncing, syncNow: timeSyncNow } = useTimeSyncAction()
const timeSourceMode = computed(() => settings.timeSource)
```
（执行时核对 `@totp/ui` 对 iconPaths 的既有导出形态——popup 已从 `@totp/ui` 导入 `NAV_ICONS`，iconPaths 若已有桶导出则直接 `import { sync as SYNC_ICON_PATH } from '@totp/ui'`；否则在 ui index 补具名导出。）

`.header-ops` 改为（齿轮钮之前插入，齐平不增行）：

```vue
      <div class="header-ops">
        <MdIconButton
          v-if="timeSourceMode === 'network'" data-test="popup-sync-now"
          :title="t('popup.syncNow')" :aria-label="t('popup.syncNow')"
          :class="{ 'sync-spinning': timeSyncing }" @click="timeSyncNow"
        >
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path :d="SYNC_ICON_PATH" fill="currentColor" /></svg>
        </MdIconButton>
        <!-- 既有：打开主界面 / 设置 两钮不动 -->
```
style 追加（与 CodesPage 同款 keyframes；popup style 非 scoped，类名保持 `sync-spinning`）。

i18n 追加：zh `codesPage.syncNow: "立即同步网络时间"`、`popup.syncNow: "立即同步网络时间"`；en `"Sync network time now"`（两处同文案）。

- [ ] **Step 4: 跑测试 + i18n 守卫 + typecheck（ui+extension）**

Run: `pnpm --filter @totp/ui exec vitest run test/pages/CodesPage.test.ts && pnpm --filter @totp/extension exec vitest run test/popupApp.test.ts && node scripts/check-i18n-keys.mjs && pnpm --filter @totp/ui run typecheck && pnpm --filter @totp/extension run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/pages/CodesPage.vue apps/extension/entrypoints/popup/App.vue packages/ui/src/i18n/locales/zh/common.json packages/ui/src/i18n/locales/en/common.json packages/ui/test/pages/CodesPage.test.ts apps/extension/test/popupApp.test.ts
git commit -m "feat(ui): 出码页与 popup 顶栏立即同步按钮——network 模式齐平渲染，syncing 旋转反馈"
```

---

### Task 8: 全仓回归验证

**Files:** 无新改动（纯验证；发现的回归回到对应 Task 修复后重跑）。

- [ ] **Step 1: 全包单测**

```bash
pnpm --filter @totp/core exec vitest run
pnpm --filter @totp/ui exec vitest run
pnpm --filter @totp/extension exec vitest run
pnpm --filter @totp/desktop exec vitest run
cd apps/desktop/src-tauri && cargo test
```
Expected: 全绿（既有失败若与本计划无关，记录并上报，不在本计划内修）。

- [ ] **Step 2: 全仓 typecheck + i18n 守卫 + locales 测试**

```bash
pnpm -r run typecheck
node scripts/check-i18n-keys.mjs
pnpm --filter @totp/extension exec vitest run test/locales.test.ts
```
Expected: 全绿。

- [ ] **Step 3: 无 diff 收尾确认**

```bash
git status --short
```
Expected: 工作区仅剩与本计划无关的既有脏文件（vendor/builtin.json/icons-full.json/snapshots）；本计划 8 个 commit 落在 `git log --oneline -8`。
