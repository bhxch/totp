# 云备份 CORS 规避、每源代理与保留天数 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 五个云后端的 HTTP 请求全部经宿主原生通道出网（扩展 background 代理 / 桌面 Rust reqwest），彻底消除 CORS；每个云源可配网络代理；保留策略增加「最近 n 天」维度（本地备份同享）。

**Architecture:** core `cloudFetch` 单点改为可注入（`setCloudFetch`，默认仍全局 fetch，未注入宿主零变化）；provider 每处调用透传 `cred.proxy`。扩展端 `host_permissions` + background `cloud-fetch` 消息代理（base64 往返、页面端重建真 Response）；桌面端自写 `cloud_http_fetch` command（reqwest，按代理键缓存 Client）。保留策略 `Retention` 加 `days?: number`（0=忽略天数），删除条件 = 超出 n 份 **且** 超过 n 天。

**Tech Stack:** TypeScript（core/ui/extension）、Rust（reqwest 0.12 + socks feature + base64 0.22）、WXT MV3、vitest / cargo test。

**Spec:** `docs/plans/2026-09-30-cloud-http-cors-proxy-retention-design.md`

## Global Constraints

- S3 SigV4 签名仍在页面层完成，代理只转发已签名 headers——签名逻辑零改动。
- `proxy` 字段随 CloudCred 走现有 `saveCred` 通道（secretBag 加密持久化），不新增存储路径。
- 保留语义：`n ≥ 1`（整数，默认 1）；`days ≥ 0`（整数，**缺省/0 = 忽略天数条件**）；删除条件 = 超出 n 份 **且**（days > 0 时）超过 n 天，两条件同时不满足才删。旧数据无 days 字段行为逐字节不变。
- 扩展端每源代理不生效（浏览器无法 per-request 代理）：UI 置灰 + hint 文案，文档引导浏览器/系统代理。
- extension 构建验证用 `pnpm exec wxt build -b chrome` 与 `pnpm exec wxt build -b firefox`（Firefox 必须显式 `-b firefox`）；CI 环境 typecheck 前先 `pnpm exec wxt prepare`。
- 每任务结束跑所在包 vitest + `pnpm typecheck`；Rust 任务跑 `cargo test` + `cargo fmt` + `cargo clippy`。

---

### Task 1: core 网络层可注入 + CloudProxy 类型

**Files:**
- Modify: `packages/core/src/cloud/backend.ts`（cloudFetch 96-112 行；CloudCred 五成员接口 25-91 行）
- Test: `packages/core/test/cloudFetch.test.ts`（新建）

**Interfaces:**
- Produces（后续 Task 2/6/7 依赖，均自 `@totp/core` 再导出——index.ts 已 `export * from './cloud/backend'`）:
  - `interface CloudProxy { mode: 'none' | 'system' | 'custom'; url?: string }`
  - `type CloudFetchImpl = (label: string, url: string, init?: RequestInit, proxy?: CloudProxy) => Promise<Response>`
  - `setCloudFetch(impl: CloudFetchImpl): void`、`__resetCloudFetchForTest(): void`
  - `proxyOf(cred: CloudCred): CloudProxy`（缺省 `{ mode: 'none' }`）
  - `cloudFetch(label, url, init?, proxy?)` 增第 4 参；`CloudCred` 五成员各增 `proxy?: CloudProxy`

- [ ] **Step 1: 写失败测试**（packages/core/test/cloudFetch.test.ts）

```ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import { __resetCloudFetchForTest, cloudFetch, proxyOf, setCloudFetch, type CloudProxy } from '../src/cloud/backend'

afterEach(() => __resetCloudFetchForTest())

describe('cloudFetch 可注入网络层（③ CORS 规避）', () => {
  it('未注入=全局 fetch 直连（默认行为零变化）', async () => {
    const f = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }))
    vi.stubGlobal('fetch', f)
    await cloudFetch('测试', 'https://x/y')
    expect(f).toHaveBeenCalledTimes(1)
    vi.unstubAllGlobals()
  })
  it('注入后走注入实现并透传 label/url/init/proxy；TypeError 错误包装保留 CORS 提示', async () => {
    const impl = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
    setCloudFetch(impl)
    const proxy: CloudProxy = { mode: 'custom', url: 'socks5h://127.0.0.1:7890' }
    await expect(cloudFetch('WebDAV', 'https://dav/x', { method: 'PUT' }, proxy)).rejects.toThrow('CORS 配置')
    expect(impl).toHaveBeenCalledWith('WebDAV', 'https://dav/x', { method: 'PUT' }, proxy)
  })
  it('proxyOf：缺省直连、有值原样返回', () => {
    expect(proxyOf({ backend: 'webdav', serverUrl: 's', username: 'u', password: 'p' })).toEqual({ mode: 'none' })
    const p: CloudProxy = { mode: 'system' }
    expect(proxyOf({ backend: 'webdav', serverUrl: 's', username: 'u', password: 'p', proxy: p })).toBe(p)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/core && pnpm exec vitest run test/cloudFetch.test.ts`
Expected: FAIL（`setCloudFetch`/`proxyOf` 未导出；proxy 字段类型不存在）

- [ ] **Step 3: 实现 backend.ts**

1. `CloudCred` 五个成员接口（`WebdavCred`/`GistCred`/`S3Cred`/`GDriveCred`/`OneDriveCred`）各追加同一可选字段：

```ts
  /** 每源网络代理（2026-09-30 CORS/代理设计）：缺省直连；仅桌面版宿主生效（扩展端置灰提示走浏览器代理） */
  proxy?: CloudProxy
```

2. cloudFetch 段（96-112 行）改为可注入（错误包装原样保留）：

```ts
/** 每源网络代理配置（③）：none=显式直连；system=宿主环境默认代理（桌面 reqwest env/浏览器代理）；
 *  custom=自定义 url（http:// https:// socks5:// socks5h://） */
export interface CloudProxy {
  mode: 'none' | 'system' | 'custom'
  url?: string
}

export type CloudFetchImpl = (label: string, url: string, init?: RequestInit, proxy?: CloudProxy) => Promise<Response>

let fetchImpl: CloudFetchImpl = (_label, url, init) => fetch(url, init)

/** 宿主注入网络实现（扩展 background 代理 / 桌面 Rust command）。未注入=全局 fetch（core 测试与未注入宿主零变化） */
export function setCloudFetch(impl: CloudFetchImpl): void {
  fetchImpl = impl
}

/** 测试隔离：恢复默认全局 fetch（先例 __resetOAuthCacheForTest 同款） */
export function __resetCloudFetchForTest(): void {
  fetchImpl = (_label, url, init) => fetch(url, init)
}

/** provider 统一取源代理参数：缺省直连 */
export function proxyOf(cred: CloudCred): CloudProxy {
  return cred.proxy ?? { mode: 'none' }
}

/** fetch 网络层包装（错误文案注释同旧版，此处略）：第四参 proxy 由 provider 从 cred 透传 */
export async function cloudFetch(label: string, url: string, init?: RequestInit, proxy?: CloudProxy): Promise<Response> {
  try {
    return await fetchImpl(label, url, init, proxy)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    const isCorsLikely = err instanceof TypeError
      && /fetch failed|NetworkError when attempting to fetch resource/i.test(reason)
    const hint = isCorsLikely ? ' — 若为自建 WebDAV/S3(MinIO)请检查服务端 CORS 配置' : ''
    const where = describeUrl(url)
    throw new Error(`${label} 网络请求失败：${reason}${hint}（${where}）`)
  }
}
```

（旧注释两段 JSDoc 原样保留在 cloudFetch 上方。）

- [ ] **Step 4: 跑测试与回归**

Run: `cd packages/core && pnpm exec vitest run && pnpm typecheck`
Expected: 全绿（既有 1000+ 例不破）

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/cloud/backend.ts packages/core/test/cloudFetch.test.ts
git commit -m "feat(cloud): cloudFetch 网络层可注入与每源 CloudProxy 类型"
```

---

### Task 2: 五 provider 与 OAuth 链透传 proxy

**Files:**
- Modify: `packages/core/src/cloud/webdav.ts`（40, 48, 54, 58, 67 行五处 cloudFetch）
- Modify: `packages/core/src/cloud/s3.ts`（156, 164, 170, 174, 196 行五处）
- Modify: `packages/core/src/cloud/gist.ts`（28, 39 行两处）
- Modify: `packages/core/src/cloud/oauthRefresh.ts`（createAuthFetch 52-65 行两处 + refreshAccessToken 114 行原生 fetch）
- Test: `packages/core/test/cloudWebdav.test.ts`（追加透传用例）

**Interfaces:**
- Consumes: Task 1 `proxyOf`/`CloudProxy`。
- Produces: 全部 provider 请求携带 `cred.proxy`（Task 6/7 的注入实现按此参数路由）。

- [ ] **Step 1: 写失败测试**（cloudWebdav.test.ts 末尾；import 行补 `setCloudFetch, __resetCloudFetchForTest, proxyOf` 自 `../src/cloud/backend` 与 `afterEach`）

```ts
describe('WebDAV proxy 透传（③）', () => {
  afterEach(() => __resetCloudFetchForTest())

  it('cred.proxy 经 cloudFetch 第 4 参到达注入层', async () => {
    const seen: Array<CloudProxy | undefined> = []
    setCloudFetch(async (_label, _url, _init, proxy) => {
      seen.push(proxy)
      return new Response(null, { status: 200 })
    })
    const cred = { backend: 'webdav' as const, serverUrl: 'https://dav', username: 'u', password: 'p', objectPath: 'a.totpbackup', proxy: { mode: 'custom' as const, url: 'socks5h://127.0.0.1:7890' } }
    await createWebdavBackend(cred).put('a.totpbackup', new Uint8Array([1]))
    expect(seen.length).toBeGreaterThan(0)
    expect(seen[0]).toEqual({ mode: 'custom', url: 'socks5h://127.0.0.1:7890' })
  })
})
```

（`createWebdavBackend` 的导出名与构造形态以该测试文件既有用例为准——复制一个既有 put 用例、给 cred 加 proxy 字段、把 stub 全局 fetch 的手法换成 `setCloudFetch` 捕获。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/core && pnpm exec vitest run test/cloudWebdav.test.ts`
Expected: FAIL（seen[0] 为 `{ mode: 'none' }` 或 undefined）

- [ ] **Step 3: 实现**——统一改法（每处只加第 4 参）：

1. `webdav.ts` / `s3.ts` / `gist.ts` 的 import 行改为 `import { cloudFetch, ensureHttpOk, proxyOf } from './backend'`（s3 若还引其他成员照旧保留）。以下调用点每处 `cloudFetch(LABEL, ...)` 的实参列表末尾追加 `, proxyOf(cred)`（cred 为各文件工厂闭包形参名，如不同以实际为准）：
   - webdav.ts:40, 48, 54, 58, 67
   - s3.ts:156, 164, 170, 174, 196
   - gist.ts:28, 39
2. `oauthRefresh.ts`：import 补 `proxyOf`；`createAuthFetch` 内两处 `cloudFetch(label, url, init)`（59、62 行）均改为 `cloudFetch(label, url, init, proxyOf(cred))`；`refreshAccessToken` 的 token 端点请求（114 行 `res = await fetch(tokenUrlOf(cred.backend), {...})`）改为 `res = await cloudFetch('oauth', tokenUrlOf(cred.backend), {...})`（token 端点跨源同样受 CORS，必须走注入层；`{...}` 原样）。

- [ ] **Step 4: 跑 core 全量与 typecheck**

Run: `cd packages/core && pnpm exec vitest run && pnpm typecheck`
Expected: 全绿（既有 provider 用例 stub 全局 fetch 仍生效——注入默认即全局 fetch）

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/cloud/webdav.ts packages/core/src/cloud/s3.ts packages/core/src/cloud/gist.ts packages/core/src/cloud/oauthRefresh.ts packages/core/test/cloudWebdav.test.ts
git commit -m "feat(cloud): 五 provider 与 OAuth 刷新链透传每源代理参数"
```

---

### Task 3: Retention 增 days 维度（类型/校验/滚动删除）

**Files:**
- Modify: `packages/core/src/backup/sources.ts`（Retention 10 行；normalizeRetention 51-55 行；isRetentionShape 71-76 行）
- Modify: `packages/core/src/backup/policy.ts`（selectBackupsToKeep 30-34 行）
- Test: `packages/core/test/backupPolicy.test.ts`、`packages/core/test/sources.test.ts`（若校验用例在别处，rg `normalizeRetention` 定位）

**Interfaces:**
- Produces: `Retention` keep 成员 `{ type: 'keep'; n: number; days?: number }`；`selectBackupsToKeep(names: string[], keep: number, days?: number): string[]`（days 缺省 0）。Task 4/5 消费。

- [ ] **Step 1: 写失败测试**（backupPolicy.test.ts 追加；时间戳构造用 `new Date(2026, 8, 1, 12, 0, 0)` 风格避免时区歧义，名单字符串按 `vault-YYYYMMDD-HHMMSS.totpbackup` 手写）

```ts
describe('selectBackupsToKeep days 维度（③ 保留最近 n 天）', () => {
  const OLD = 'vault-20260901-120000.totpbackup'   // 相对 mock now 约 29 天前
  const MID = 'vault-20260928-120000.totpbackup'   // 约 2 天前
  const NEW = 'vault-20260930-120000.totpbackup'   // 当天

  it('days 缺省/0：与旧版一致（仅份数）', () => {
    expect(selectBackupsToKeep([OLD, MID, NEW], 2)).toEqual([OLD])
    expect(selectBackupsToKeep([OLD, MID, NEW], 2, 0)).toEqual([OLD])
  })
  it('days>0：超额但未超龄的保留——超 n 份且超 n 天才删', () => {
    vi.spyOn(Date, 'now').mockReturnValue(new Date(2026, 8, 30, 12, 30, 0).getTime())
    expect(selectBackupsToKeep([OLD, MID, NEW], 1, 7)).toEqual([OLD]) // MID 超 1 份但龄 2 天 < 7 天，保留
    expect(selectBackupsToKeep([OLD, MID, NEW], 1, 3)).toEqual([OLD, MID]) // 两份均超 1 份且超 3 天龄
    vi.restoreAllMocks()
  })
  it('龄恰等于 days 天不删（严格大于才删）', () => {
    vi.spyOn(Date, 'now').mockReturnValue(new Date(2026, 8, 8, 12, 0, 0).getTime())
    expect(selectBackupsToKeep(['vault-20260901-120000.totpbackup'], 0, 7)).toEqual([])
    vi.restoreAllMocks()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/core && pnpm exec vitest run test/backupPolicy.test.ts`
Expected: FAIL（第 3 参被忽略 → days 用例不符）

- [ ] **Step 3: 实现**

1. `sources.ts:10`：

```ts
export type Retention = { type: 'overwrite' } | { type: 'keep'; n: number; days?: number }
```

2. `normalizeRetention`（51-55 行）：

```ts
export function normalizeRetention(x: unknown): Retention {
  const r = x as { type?: unknown; n?: unknown; days?: unknown } | null
  if (r?.type === 'keep' && typeof r.n === 'number' && Number.isInteger(r.n) && r.n >= 1) {
    // days 缺省=0=忽略天数条件（向后兼容旧数据无 days 字段）；存在但非法一律归 0
    const days = typeof r.days === 'number' && Number.isInteger(r.days) && r.days >= 0 ? r.days : 0
    return days > 0 ? { type: 'keep', n: r.n, days } : { type: 'keep', n: r.n }
  }
  return { type: 'overwrite' }
}
```

3. `isRetentionShape`（71-76 行）keep 分支同步：days 缺省合法；存在时须 `Number.isInteger(days) && days >= 0`（非法整条拒绝，保持该函数既有 fail-closed 风格）。
4. `policy.ts`：

```ts
/** 从 vault-YYYYMMDD-HHMMSS 名解析本地时间戳（ms）；不匹配返回 null */
export function backupNameTimestampMs(name: string): number | null {
  const m = /^vault-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.totpbackup$/.exec(name)
  if (!m) return null
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])).getTime()
}

/** 滚动删除名单（③ 加 days 维度）：字典序=时间序；候选=超出最近 keep 份的超额名单；
 *  days>0 时仅删「超 keep 份 且 文件龄 > days 天」者（任一条件不满足即保留）。
 *  days 缺省/0=忽略天数条件，行为与旧版逐字节一致。 */
export function selectBackupsToKeep(names: string[], keep: number, days = 0): string[] {
  const valid = names.filter((n) => BACKUP_NAME_RE.test(n)).sort() // 字典序=时间序
  const excess = keep > 0 ? valid.slice(0, Math.max(0, valid.length - keep)) : valid
  if (!(days > 0)) return excess
  const now = Date.now()
  return excess.filter((n) => {
    const ts = backupNameTimestampMs(n)
    return ts !== null && now - ts > days * 86_400_000
  })
}
```

（`backupPolicy.test.ts` 头部 import 补 `vi` 与新函数；既有用例不动。）

- [ ] **Step 4: 跑测试与回归**

Run: `cd packages/core && pnpm exec vitest run && pnpm typecheck`
Expected: 全绿（backupService/cloudSync 既有 days=0 路径不破）

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/backup/sources.ts packages/core/src/backup/policy.ts packages/core/test/backupPolicy.test.ts
git commit -m "feat(core): Retention 增 days 维度，滚动删除改双条件"
```

---

### Task 4: 保留天数消费点透传（云端 + 本地）

**Files:**
- Modify: `packages/core/src/cloud/retention.ts`（17, 26 行）
- Modify: `apps/desktop/src/backupService.ts`（152 行）
- Modify: `packages/ui/src/components/cloudSyncShared.ts`（99 行）
- Test: `packages/core/test/retention.test.ts`、`apps/desktop/src/backupService.test.ts`

**Interfaces:**
- Consumes: Task 3 `selectBackupsToKeep(names, keep, days)`。
- Produces: `enforceRemoteRetention(backend: CloudBackend, keep: number, days?: number)`——days 缺省 0，旧调用方兼容。

- [ ] **Step 1: 写失败测试**（retention.test.ts 追加，参照该文件既有 fake backend 手法）

```ts
it('days 透传：超份数但未超龄的远端备份不删（③）', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(new Date(2026, 8, 30, 12, 0, 0).getTime())
  const names = ['vault-20260901-120000.totpbackup', 'vault-20260929-120000.totpbackup', 'vault-20260930-120000.totpbackup']
  const deleted: string[] = []
  const backend = { listBackups: async () => names, delete: async (p: string) => { deleted.push(p) } }
  await enforceRemoteRetention(backend as unknown as CloudBackend, 1, 7)
  expect(deleted).toEqual(['vault-20260901-120000.totpbackup']) // 29 日份龄 1 天受天数保护
  vi.restoreAllMocks()
})
```

（`CloudBackend` import 若该文件未有则补 `import type { CloudBackend } from '../src/cloud/backend'`。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/core && pnpm exec vitest run test/retention.test.ts`
Expected: FAIL（days 参被忽略，29 日份被删）

- [ ] **Step 3: 实现三处透传**

1. `retention.ts:17` 签名与 26 行调用：

```ts
export async function enforceRemoteRetention(backend: CloudBackend, keep: number, days = 0): Promise<RetentionOutcome> {
```
```ts
  const stale = selectBackupsToKeep([...originalByBasename.keys()], keep, days)
```

2. `backupService.ts:152`：

```ts
  const stale = selectBackupsToKeep(await sink.listNames(), retention.n, retention.days ?? 0)
```

3. `cloudSyncShared.ts:99`：

```ts
    const r = await enforceRemoteRetention(input.backend, input.source.retention.n, input.source.retention.days ?? 0)
```

- [ ] **Step 4: 跑相关包回归**

Run: `cd packages/core && pnpm exec vitest run && cd ../../apps/desktop && pnpm exec vitest run && cd ../../packages/ui && pnpm exec vitest run`
Expected: 全绿（cloudRunner.test 若对 enforceRemoteRetention 参数有 mock 断言，按新实参数量更新该断言——只加参数不改语义）

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/cloud/retention.ts packages/core/test/retention.test.ts apps/desktop/src/backupService.ts apps/desktop/src/backupService.test.ts packages/ui/src/components/cloudSyncShared.ts packages/ui/test/cloudRunner.test.ts
git commit -m "feat(cloud): 云端与本地滚动删除透传保留天数"
```

---

### Task 5: 保留天数与每源代理 UI（CloudCard + BackupCard + CloudCredFields）

**Files:**
- Modify: `packages/ui/src/components/CloudCard.vue`（204-211 行 handlers；634-644 行 retention-row；649 行 CloudCredFields）
- Modify: `packages/ui/src/components/BackupCard.vue`（253-265 行 handlers；440-450 行 retention-row）
- Modify: `packages/ui/src/components/CloudCredFields.vue`（代理行）
- Modify: `packages/ui/src/components/cloudPlatform.ts`（CloudPlatform 接口加 `proxySupport?: boolean`）
- Modify: `apps/desktop/src/cloudPlatforms.ts`（返回对象加 `proxySupport: true`）
- Modify: `apps/extension/src/optionsPlatforms.ts`（返回对象加 `proxySupport: false`）
- Modify: `packages/ui/src/i18n/locales/zh/common.json`、`packages/ui/src/i18n/locales/en/common.json`
- Test: `packages/ui/test/CloudCredFields.test.ts`、`packages/ui/test/CloudCard.test.ts`（如该卡有 retention 断言则同步）

**Interfaces:**
- Consumes: Task 3 `Retention.days`；Task 1 `CloudCred.proxy`。
- Produces: `CloudPlatform.proxySupport?: boolean`（宿主能力声明：desktop true / extension false / 缺省 false）；CloudCredFields props 增 `proxySupport?: boolean`。

- [ ] **Step 1: 写失败测试**（CloudCredFields.test.ts 追加）

```ts
describe('CloudCredFields 每源代理（③）', () => {
  const mountP = (draft: CloudCred | undefined, proxySupport: boolean) =>
    mount(CloudCredFields, { global: { plugins: [createTestI18n()] }, props: { draft, busy: false, retention: OVERWRITE, proxySupport } })

  it('proxySupport=false：不渲染代理控件，显示扩展端提示', () => {
    const w = mountP(WEBDAV, false)
    expect(w.text()).toContain('扩展端不支持每源代理')
    expect(w.find('.proxy-mode').exists()).toBe(false)
  })
  it('三段切换与 url 输入：custom 出地址框，none 清 proxy 字段', async () => {
    const draft: CloudCred = { ...WEBDAV }
    const w = mountP(draft, true)
    await w.find('.proxy-mode button:nth-child(3)').trigger('click')  // MdSegmentedButton 触发方式按既有组件测试先例（如 retention 断言用例）调整
    await flushPromises()
    expect(draft.proxy?.mode).toBe('custom')
    await w.find('input[aria-label="代理地址"]').setValue('socks5h://127.0.0.1:7890')
    expect(draft.proxy).toEqual({ mode: 'custom', url: 'socks5h://127.0.0.1:7890' })
  })
})
```

（MdSegmentedButton 的测试触发手法以仓库既有用例为准——rg `MdSegmentedButton` in `packages/ui/test/` 找先例；断言核心是 draft.proxy 的状态变化与提示文案。）

- [ ] **Step 2: 跑测试确认失败** → **Step 3: 实现**

1. `cloudPlatform.ts` CloudPlatform 接口加一行：

```ts
  /** 宿主是否支持每源网络代理（③ desktop reqwest 生效；扩展 false——UI 置灰并提示走浏览器代理） */
  proxySupport?: boolean
```

2. `cloudPlatforms.ts`（desktop）返回对象加 `proxySupport: true,`；`optionsPlatforms.ts`（extension）返回对象加 `proxySupport: false,`。
3. `CloudCard.vue` 649 行：`<CloudCredFields :draft="credDrafts[s.id]" :busy="busy" :retention="s.retention" :proxy-support="platform.proxySupport === true" />`。
4. `CloudCredFields.vue`：props 加 `proxySupport?: boolean`；script 加：

```ts
const PROXY_MODE_OPTIONS = [
  { value: 'none', label: t('cloudCard.proxyModeNone') },
  { value: 'system', label: t('cloudCard.proxyModeSystem') },
  { value: 'custom', label: t('cloudCard.proxyModeCustom') },
]
function onProxyMode(d: CloudCred, mode: string | number): void {
  d.proxy = mode === 'none' ? undefined : { mode: mode as 'system' | 'custom', url: d.proxy?.url }
}
function onProxyUrl(d: CloudCred, v: string): void {
  if (d.proxy?.mode !== 'custom') return
  d.proxy = { mode: 'custom', url: v.trim() }
}
```

模板（目标路径预览 template 之后追加；draft 就地编辑=随保存凭据整体落 secretBag，无需改保存链）：

```html
    <!-- ③ 每源网络代理：桌面 reqwest 生效；扩展端置灰（浏览器无法 per-request 代理） -->
    <template v-if="d && proxySupport">
      <MdSegmentedButton
        class="proxy-mode" :options="PROXY_MODE_OPTIONS" :model-value="d.proxy?.mode ?? 'none'"
        :aria-label="t('cloudCard.proxyModeAria')" @update:model-value="onProxyMode(d, $event)"
      />
      <MdTextField
        v-if="d.proxy?.mode === 'custom'" :model-value="d.proxy.url ?? ''" :label="t('cloudCard.proxyUrlLabel')"
        :placeholder="t('cloudCard.proxyUrlPlaceholder')" :aria-label="t('cloudCard.proxyUrlLabel')" autocomplete="off"
        @update:model-value="onProxyUrl(d, $event)"
      />
    </template>
    <p v-if="d && !proxySupport" class="hint">{{ t('cloudCard.proxyUnsupportedHint') }}</p>
```

5. 保留天数输入：`CloudCard.vue` onKeepN 旁加（且 onRetentionType 切 keep 时带 `days: 0`——`{ type: 'keep', n: 3 }` 缺省即 0，无需显式）：

```ts
function onKeepDays(s: BackupSource, v: string | number): void {
  if (s.retention.type !== 'keep') return
  const parsed = v === '' ? NaN : Number(v)
  s.retention = { type: 'keep', n: s.retention.n, days: Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : 0 }
}
```

retention-row 模板（634-644 行）keep 分支的 MdTextField 后追加：

```html
            <MdTextField
              v-if="s.retention.type === 'keep'" class="keep-days"
              :model-value="String(s.retention.days ?? 0)" type="number" :min="0" :label="t('cloudCard.keepDaysLabel')" :aria-label="t('cloudCard.keepDaysLabel')"
              :disabled="busy" @update:model-value="onKeepDays(s, $event)"
            />
```

6. `BackupCard.vue` 同型改动：`onKeepDays(s: LocalSourceView, ...)`（`if (s.retention.type !== 'keep') return` 同款）+ 模板 440-450 行 keep 分支追加 keep-days 输入 + `@change="onKeepDaysCommit(s)"` 若需落盘则新增 `function onKeepDaysCommit(s: LocalSourceView): void { void persistSource(s) }`（与 onKeepNCommit 同型）。
7. i18n（zh / en 对应）：

```
cloudCard.keepDaysLabel: "保留天数" / "Keep days"
cloudCard.proxyModeAria: "代理模式" / "Proxy mode"
cloudCard.proxyModeNone: "直连" / "Direct"
cloudCard.proxyModeSystem: "系统代理" / "System proxy"
cloudCard.proxyModeCustom: "自定义" / "Custom"
cloudCard.proxyUrlLabel: "代理地址" / "Proxy URL"
cloudCard.proxyUrlPlaceholder: "http:// 或 socks5h://host:port" / "http:// or socks5h://host:port"
cloudCard.proxyUnsupportedHint: "扩展端不支持每源代理，请配置浏览器或系统代理" / "Per-source proxy is desktop-only; configure your browser or system proxy instead"
backupCard.keepDaysLabel: "保留天数" / "Keep days"
```

- [ ] **Step 4: 跑 ui 全量与 typecheck**

Run: `cd packages/ui && pnpm exec vitest run && pnpm typecheck && cd ../../apps/extension && pnpm typecheck && cd ../desktop && pnpm typecheck`
Expected: 全绿

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/components/CloudCard.vue packages/ui/src/components/BackupCard.vue packages/ui/src/components/CloudCredFields.vue packages/ui/src/components/cloudPlatform.ts packages/ui/test/CloudCredFields.test.ts apps/desktop/src/cloudPlatforms.ts apps/extension/src/optionsPlatforms.ts packages/ui/src/i18n/locales/zh/common.json packages/ui/src/i18n/locales/en/common.json
git commit -m "feat(ui): 保留天数输入与每源代理配置（桌面生效/扩展置灰）"
```

---

### Task 6: 扩展端 background 代理与 host_permissions

**Files:**
- Modify: `apps/extension/wxt.config.ts`（permissions 平级加 host_permissions）
- Create: `apps/extension/src/cloudFetchHandler.ts`（SW 内请求执行，纯函数可测）
- Create: `apps/extension/src/cloudFetchProxy.ts`（页面端注入实现）
- Modify: `apps/extension/entrypoints/background.ts`（onMessage listener 139-154 行加分支）
- Modify: `apps/extension/entrypoints/popup/main.ts`、`apps/extension/entrypoints/options/main.ts`（装配）
- Test: `apps/extension/src/cloudFetchHandler.test.ts`、`apps/extension/src/cloudFetchProxy.test.ts`（新建）

**Interfaces:**
- Consumes: Task 1 `setCloudFetch`/`CloudFetchImpl`；core `bytesToBase64`/`base64ToBytes`。
- Produces: 消息协议 `{ type: 'cloud-fetch', url, method, headers, bodyB64 }` → `{ status, statusText, headers, bodyB64 } | { error }`；`installBackgroundCloudFetch(): void`（popup/options 装配调用）。

- [ ] **Step 1: 写失败测试**

`cloudFetchHandler.test.ts`：

```ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import { base64ToBytes, bytesToBase64 } from '@totp/core'
import { handleCloudFetch } from './cloudFetchHandler'

afterEach(() => vi.unstubAllGlobals())

describe('background cloud-fetch 处理（③）', () => {
  it('GET 往返：status/headers/base64 body 正确组包', async () => {
    const body = new Uint8Array([1, 2, 3])
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { status: 207, headers: { 'x-a': 'b' } })))
    const r = await handleCloudFetch('https://x/y', 'PROPFIND', { Depth: '1' }, null)
    expect(r).toMatchObject({ status: 207, headers: { 'x-a': 'b' } })
    expect(base64ToBytes((r as { bodyB64: string }).bodyB64)).toEqual(body)
  })
  it('PUT 携带 b64 body；空 body 回 null；网络错回结构化 error 不抛', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
    vi.stubGlobal('fetch', fetchMock)
    const ok = await handleCloudFetch('https://x', 'PUT', {}, bytesToBase64(new Uint8Array([9])))
    expect(ok).toMatchObject({ status: 200, bodyB64: null })
    expect(new Uint8Array((fetchMock.mock.calls[0]![1] as RequestInit).body as ArrayBuffer)).toEqual(new Uint8Array([9]))
    const err = await handleCloudFetch('https://x', 'GET', {}, null)
    expect((err as { error: string }).error).toContain('Failed to fetch')
  })
  it('缺 url 拒绝', async () => {
    expect(await handleCloudFetch('', 'GET', {}, null)).toMatchObject({ error: expect.any(String) })
  })
})
```

`cloudFetchProxy.test.ts`：

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { bytesToBase64 } from '@totp/core'

const sendMessage = vi.fn()
vi.mock('./extApi', () => ({ ext: { runtime: { sendMessage } } }))

import { backgroundProxiedFetch } from './cloudFetchProxy'

describe('页面端 background 代理 fetch（③）', () => {
  beforeEach(() => sendMessage.mockReset())

  it('组消息形状（method 默认 GET、Uint8Array→b64）；应答重建真 Response', async () => {
    sendMessage.mockResolvedValue({ status: 201, statusText: 'Made', headers: { 'x-k': 'v' }, bodyB64: bytesToBase64(new Uint8Array([4, 5])) })
    const res = await backgroundProxiedFetch('WebDAV', 'https://dav/f', { method: 'PUT', body: new Uint8Array([4, 5]) })
    expect(sendMessage).toHaveBeenCalledWith({ type: 'cloud-fetch', url: 'https://dav/f', method: 'PUT', headers: {}, bodyB64: bytesToBase64(new Uint8Array([4, 5])) })
    expect(res.status).toBe(201)
    expect(res.ok).toBe(true)
    expect(res.headers.get('x-k')).toBe('v')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([4, 5]))
  })
  it('error 应答转 throw（交 cloudFetch 包装中文错误）', async () => {
    sendMessage.mockResolvedValue({ error: 'boom' })
    await expect(backgroundProxiedFetch('L', 'https://x')).rejects.toThrow('boom')
  })
})
```

（`vi.mock('./extApi', ...)` 的导出名以 `apps/extension/src/extApi.ts` 实际导出为准——rg `export const ext` 确认；页面端 import 路径写法与 `optionsPlatforms.ts` 对 ext 的 import 完全一致。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/extension && pnpm exec vitest run src/cloudFetchHandler.test.ts src/cloudFetchProxy.test.ts`
Expected: FAIL（两文件不存在）

- [ ] **Step 3: 实现**

1. `wxt.config.ts` manifest 内 `permissions` 数组同层加：`host_permissions: ['http://*/*', 'https://*/*'],`。

2. `cloudFetchHandler.ts`：

```ts
import { base64ToBytes, bytesToBase64 } from '@totp/core'

export interface CloudFetchOk { status: number; statusText: string; headers: Record<string, string>; bodyB64: string | null }
export interface CloudFetchErr { error: string }

/** SW 内执行云请求并组应答消息（③）：错误结构化返回不抛（sendResponse 通道一次性） */
export async function handleCloudFetch(url: unknown, method: unknown, headers: unknown, bodyB64: unknown): Promise<CloudFetchOk | CloudFetchErr> {
  if (typeof url !== 'string' || url === '') return { error: 'cloud-fetch: 缺 url' }
  try {
    const init: RequestInit = { method: typeof method === 'string' ? method : 'GET', headers: (headers as Record<string, string>) ?? {} }
    if (typeof bodyB64 === 'string' && bodyB64 !== '') init.body = base64ToBytes(bodyB64)
    const res = await fetch(url, init)
    const buf = await res.arrayBuffer()
    return {
      status: res.status,
      statusText: res.statusText,
      headers: Object.fromEntries(res.headers.entries()),
      bodyB64: buf.byteLength > 0 ? bytesToBase64(new Uint8Array(buf)) : null,
    }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
}
```

3. `cloudFetchProxy.ts`：

```ts
import { base64ToBytes, bytesToBase64, setCloudFetch, type CloudFetchImpl } from '@totp/core'
import { ext } from './extApi'  // ← import 路径/写法与 optionsPlatforms.ts 现有 ext 用法完全一致

/** 页面端经 background 出网（③）：host_permissions 内 SW fetch 不受 CORS 限制。
 *  每源 proxy 参数扩展端不生效（浏览器无法 per-request 代理），UI 已置灰声明。 */
export const backgroundProxiedFetch: CloudFetchImpl = async (_label, url, init) => {
  const body = init?.body instanceof Uint8Array
    ? init.body
    : init?.body != null ? new TextEncoder().encode(String(init.body)) : null
  const res = await ext!.runtime.sendMessage({
    type: 'cloud-fetch',
    url,
    method: init?.method ?? 'GET',
    headers: (init?.headers as Record<string, string>) ?? {},
    bodyB64: body ? bytesToBase64(body) : null,
  })
  if (!res || res.error) throw new Error(res?.error ?? 'background 无响应（service worker 不可用）')
  return new Response(res.bodyB64 ? base64ToBytes(res.bodyB64) : null, {
    status: res.status,
    statusText: res.statusText ?? '',
    headers: res.headers ?? {},
  })
}

/** 页面装配点调用（popup/options main.ts 顶部）：此后全部 provider 云请求走 background */
export function installBackgroundCloudFetch(): void {
  setCloudFetch(backgroundProxiedFetch)
}
```

4. `background.ts` listener（139 行 `ext!.runtime.onMessage.addListener((msg) => {`）改签名为 `(msg, _sender, sendResponse)`，分支体最前加：

```ts
    if (msg?.type === 'cloud-fetch') {
      void handleCloudFetch(msg.url, msg.method, msg.headers, msg.bodyB64).then(sendResponse)
      return true // MV3：异步应答保持通道开放
    }
```

（import `handleCloudFetch` 自 `../src/cloudFetchHandler`。其余分支不动、无返回值。）

5. 装配：`entrypoints/popup/main.ts` 与 `entrypoints/options/main.ts` 的 import 段之后、`createApp` 之前：

```ts
import { installBackgroundCloudFetch } from '../../src/cloudFetchProxy'

installBackgroundCloudFetch()
```

（import 相对路径以两个 main.ts 现有对 `src/` 的引用惯例为准；若项目用 `@/` 别名则随同款。）

- [ ] **Step 4: 跑测试、全量与双浏览器构建**

Run: `cd apps/extension && pnpm exec vitest run && pnpm typecheck && pnpm exec wxt prepare && pnpm exec wxt build -b chrome && pnpm exec wxt build -b firefox`
Expected: 全绿；构建产物 manifest 含 `host_permissions`

- [ ] **Step 5: Commit**

```bash
git add apps/extension/wxt.config.ts apps/extension/src/cloudFetchHandler.ts apps/extension/src/cloudFetchHandler.test.ts apps/extension/src/cloudFetchProxy.ts apps/extension/src/cloudFetchProxy.test.ts apps/extension/entrypoints/background.ts apps/extension/entrypoints/popup/main.ts apps/extension/entrypoints/options/main.ts
git commit -m "feat(extension): 云请求经 background 代理出网规避 CORS"
```

---

### Task 7: 桌面端 Rust cloud_http_fetch 与注入

**Files:**
- Modify: `apps/desktop/src-tauri/Cargo.toml`（[dependencies] 加 base64 与 reqwest）
- Create: `apps/desktop/src-tauri/src/cloud_http.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`（`mod cloud_http;` + generate_handler 注册）
- Create: `apps/desktop/src/cloudHttp.ts`
- Modify: `apps/desktop/src/main.ts`（装配）
- Test: `cloud_http.rs` 内 `#[cfg(test)]`（先例 mcp_server.rs 13 处 `#[tokio::test]`）；`apps/desktop/src/cloudHttp.test.ts`

**Interfaces:**
- Consumes: Task 1 `setCloudFetch`/`CloudFetchImpl`；core `bytesToBase64`/`base64ToBytes`。
- Produces: Tauri command `cloud_http_fetch(req: CloudHttpReq) -> Result<CloudHttpResp, String>`（camelCase serde）；`installTauriCloudFetch(): void`。

- [ ] **Step 1: Cargo 依赖**（`[dependencies]` 段；reqwest 版本与 Cargo.lock 既有条目对齐——lock 已有 reqwest 传递依赖，`version` 字段写 lock 中的大版本避免重复编译）

```toml
base64 = "0.22"
reqwest = { version = "0.12", features = ["socks"] }
```

- [ ] **Step 2: 写失败测试**（cloud_http.rs 内）

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    #[test]
    fn client_for_caches_by_proxy_key_and_rejects_custom_without_url() {
        let a = client_for(None).unwrap();
        let b = client_for(Some(&CloudProxyCfg { mode: "none".into(), url: None })).unwrap();
        // reqwest::Client 是 Arc 句柄：同键缓存返回同一连接池实例
        assert!(std::ptr::eq(a.as_ref() as *const _, b.as_ref() as *const _) || format!("{:p}", a.as_ref()) == format!("{:p}", b.as_ref()));
        assert!(client_for(Some(&CloudProxyCfg { mode: "custom".into(), url: None })).is_err());
        assert!(client_for(Some(&CloudProxyCfg { mode: "custom".into(), url: Some(":::".into()) })).is_err());
    }

    #[tokio::test]
    async fn fetch_roundtrip_local_loopback() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            let mut buf = [0u8; 4096];
            let _ = s.read(&mut buf);
            s.write_all(b"HTTP/1.1 201 Made\r\nContent-Type: text/plain\r\nContent-Length: 5\r\n\r\nhello").unwrap();
        });
        let resp = cloud_http_fetch(CloudHttpReq {
            url: format!("http://{addr}/x"),
            method: "PUT".into(),
            headers: [("x-a".to_string(), "b".to_string())].into_iter().collect(),
            body_b64: Some(B64.encode([1u8, 2])),
            proxy: Some(CloudProxyCfg { mode: "none".into(), url: None }),
            timeout_ms: Some(5000),
        })
        .await
        .unwrap();
        server.join().unwrap();
        assert_eq!(resp.status, 201);
        assert_eq!(resp.headers.get("content-type").map(String::as_str), Some("text/plain"));
        assert_eq!(B64.decode(resp.body_b64.unwrap()).unwrap(), vec![104u8, 101, 108, 108, 111]);
    }
}
```

（`std::ptr::eq` 对 reqwest Client 内部 Arc 不可靠时删去该断言，仅保留缓存无 panic 与错误分支断言；loopback 用例是正向主路径的确定性覆盖。）

- [ ] **Step 3: 实现 cloud_http.rs**

```rust
//! 云备份出网 command（2026-09-30 CORS/代理设计）：reqwest 天然无 CORS，替代页面层 fetch。
//! PROPFIND/自定义 header 全开放；S3 SigV4 签名仍在页面层，本层只转发。
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudProxyCfg {
    pub mode: String,
    pub url: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudHttpReq {
    pub url: String,
    pub method: String,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    pub body_b64: Option<String>,
    pub proxy: Option<CloudProxyCfg>,
    pub timeout_ms: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudHttpResp {
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub body_b64: Option<String>,
}

/// Client 按 (mode, url) 键缓存（连接池复用；进程内存）
static CLIENTS: Mutex<Option<HashMap<String, reqwest::Client>>> = Mutex::new(None);

const DEFAULT_TIMEOUT_MS: u64 = 60_000;

fn client_for(proxy: Option<&CloudProxyCfg>) -> Result<reqwest::Client, String> {
    let (key, builder) = match proxy {
        Some(p) if p.mode == "custom" => {
            let url = p.url.as_deref().ok_or_else(|| "cloud_http_fetch: custom 代理缺 url".to_string())?;
            let pg = reqwest::Proxy::all(url).map_err(|e| format!("代理地址无效：{e}"))?;
            (format!("custom:{url}"), reqwest::Client::builder().proxy(pg))
        }
        // system=宿主环境默认（reqwest 读 HTTP_PROXY/HTTPS_PROXY/ALL_PROXY）；none=显式直连
        Some(p) if p.mode == "system" => ("system".to_string(), reqwest::Client::builder()),
        _ => ("none".to_string(), reqwest::Client::builder().no_proxy()),
    };
    let mut guard = CLIENTS.lock().map_err(|_| "client cache poisoned".to_string())?;
    if let Some(c) = guard.get_or_insert_with(HashMap::new).get(&key) {
        return Ok(c.clone());
    }
    let c = builder.build().map_err(|e| format!("HTTP client 构建失败：{e}"))?;
    guard.get_or_insert_with(HashMap::new).insert(key, c.clone());
    Ok(c)
}

/// 云备份 HTTP 出网（桌面注入 cloudFetch 的实现载体）：入参/出参均 base64，二进制安全
#[tauri::command]
pub async fn cloud_http_fetch(req: CloudHttpReq) -> Result<CloudHttpResp, String> {
    let client = client_for(req.proxy.as_ref())?;
    let method = reqwest::Method::from_bytes(req.method.as_bytes()).map_err(|e| format!("非法 HTTP 方法：{e}"))?;
    let mut rb = client.request(method, &req.url).timeout(Duration::from_millis(req.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS)));
    for (k, v) in &req.headers {
        rb = rb.header(k, v);
    }
    if let Some(b) = &req.body_b64 {
        let bytes = B64.decode(b).map_err(|e| format!("请求体 base64 解码失败：{e}"))?;
        rb = rb.body(bytes);
    }
    let resp = rb.send().await.map_err(|e| format!("网络请求失败：{e}"))?;
    let status = resp.status().as_u16();
    let mut headers = HashMap::new();
    for (k, v) in resp.headers() {
        if let Ok(vv) = v.to_str() {
            headers.insert(k.as_str().to_string(), vv.to_string());
        }
    }
    let body = resp.bytes().await.map_err(|e| format!("读取响应失败：{e}"))?;
    Ok(CloudHttpResp {
        status,
        headers,
        body_b64: if body.is_empty() { None } else { Some(B64.encode(&body)) },
    })
}
```

- [ ] **Step 4: 注册**：lib.rs 模块声明区加 `mod cloud_http;`；generate_handler 清单末尾（`mcp_server::mcp_revoke_approvals` 后）加 `cloud_http::cloud_http_fetch,`。

- [ ] **Step 5: 跑 Rust 门禁**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml && cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml --all && cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets`
Expected: 全绿（fmt 后以 fmt 结果为准微调测试代码排版）

- [ ] **Step 6: TS 注入层**（先写 cloudHttp.test.ts 再实现，TDD 同前几任务）

```ts
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { bytesToBase64 } from '@totp/core'

const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

import { installTauriCloudFetch, tauriCloudFetch } from './cloudHttp'

describe('桌面 cloudFetch 注入（③）', () => {
  beforeEach(() => invoke.mockReset())

  it('请求形状（b64 body/proxy 透传/默认 GET）与 Response 重建', async () => {
    invoke.mockResolvedValue({ status: 200, headers: { 'x-a': 'b' }, bodyB64: bytesToBase64(new Uint8Array([7])) })
    const res = await tauriCloudFetch('WebDAV', 'https://dav/f', { method: 'PUT', body: new Uint8Array([7]) }, { mode: 'custom', url: 'socks5h://p' })
    expect(invoke).toHaveBeenCalledWith('cloud_http_fetch', { req: { url: 'https://dav/f', method: 'PUT', headers: {}, bodyB64: bytesToBase64(new Uint8Array([7])), proxy: { mode: 'custom', url: 'socks5h://p' }, timeoutMs: null } })
    expect(res.status).toBe(200)
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([7]))
  })
  it('install 后 cloudFetch 走注入实现（setCloudFetch 生效）', async () => {
    const { __resetCloudFetchForTest, cloudFetch } = await import('@totp/core')
    installTauriCloudFetch()
    invoke.mockResolvedValue({ status: 204, headers: {}, bodyB64: null })
    await cloudFetch('L', 'https://x')
    expect(invoke).toHaveBeenCalled()
    __resetCloudFetchForTest()
  })
})
```

`cloudHttp.ts` 实现：

```ts
import { invoke } from '@tauri-apps/api/core'
import { base64ToBytes, bytesToBase64, setCloudFetch, type CloudFetchImpl } from '@totp/core'

/** ③ 桌面注入：云请求经 Rust reqwest 出网（无 CORS；每源 proxy 在 command 内生效） */
export const tauriCloudFetch: CloudFetchImpl = async (_label, url, init, proxy) => {
  const body = init?.body instanceof Uint8Array
    ? init.body
    : init?.body != null ? new TextEncoder().encode(String(init.body)) : null
  const r = await invoke<{ status: number; headers: Record<string, string>; bodyB64: string | null }>('cloud_http_fetch', {
    req: {
      url,
      method: init?.method ?? 'GET',
      headers: (init?.headers as Record<string, string>) ?? {},
      bodyB64: body ? bytesToBase64(body) : null,
      proxy: proxy ?? { mode: 'none' },
      timeoutMs: null,
    },
  })
  return new Response(r.bodyB64 ? base64ToBytes(r.bodyB64) : null, { status: r.status, headers: r.headers })
}

export function installTauriCloudFetch(): void {
  setCloudFetch(tauriCloudFetch)
}
```

装配：`apps/desktop/src/main.ts` import 段后、`createApp` 之前 `import { installTauriCloudFetch } from './cloudHttp'` + `installTauriCloudFetch()`。

- [ ] **Step 7: desktop 测试与 typecheck**

Run: `cd apps/desktop && pnpm exec vitest run && pnpm typecheck`
Expected: 全绿

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src-tauri/Cargo.toml apps/desktop/src-tauri/Cargo.lock apps/desktop/src-tauri/src/cloud_http.rs apps/desktop/src-tauri/src/lib.rs apps/desktop/src/cloudHttp.ts apps/desktop/src/cloudHttp.test.ts apps/desktop/src/main.ts
git commit -m "feat(desktop): cloud_http_fetch 出网 command 与 cloudFetch 注入"
```

---

### Task 8: README host 权限理由（中英）

**Files:**
- Modify: `README.md`、`README_en.md`

**Interfaces:** 无代码接口。

- [ ] **Step 1: 定位插入点**：`rg -n "权限|Permission|已知限制|Known" README.md README_en.md`——若有「权限说明」类小节则在其中追加；否则在「已知限制」节之前新增 `## 权限说明`（en: `## Permissions`）小节。

- [ ] **Step 2: 写入文案**

zh（README.md）：

```markdown
## 权限说明

扩展申请全部 http/https 站点权限（host_permissions）的原因：云备份目标由您自行配置（WebDAV / S3 / GitHub Gist / Google Drive / OneDrive，地址可以是任意服务），而浏览器会对页面直连的跨源请求施加 CORS 限制；因此云备份请求统一由扩展 background 发出，host_permissions 是其出网前提。这些权限仅用于与您配置的备份目标及 OAuth 令牌端点之间的备份数据往返，不用于读取任何网页内容。
```

en（README_en.md）：

```markdown
## Permissions

Why the extension requests access to all http/https sites (host_permissions): cloud backup targets are user-configured (WebDAV / S3 / GitHub Gist / Google Drive / OneDrive — the address can be any service), and browsers enforce CORS on cross-origin requests made from extension pages. Cloud backup requests are therefore routed through the extension background, which requires host_permissions to reach the network. These permissions are used solely for backup data exchange with the backup targets you configure and the OAuth token endpoints — never for reading web page content.
```

- [ ] **Step 3: Commit**

```bash
git add README.md README_en.md
git commit -m "docs(readme): 扩展全量 host 权限的理由说明"
```

---

### Task 9: 真机验证清单（人工，不阻塞合并）

**Files:**
- Create: `docs/e2e/2026-09-30-cloud-cors-proxy-checklist.md`

- [ ] 按 `docs/e2e-test.md` §6 登记（并入批次 E 验证会话）：
  1. 坚果云 WebDAV：扩展端配置并手动同步（复现原 CORS 报错的场景应成功上传/下载/列目录）；桌面端同源再验。
  2. socks5h 代理：桌面端某源配置 `socks5h://127.0.0.1:<本地代理端口>`，GDrive/OneDrive 源上传/列/删经代理成功（本地代理日志佐证）。
  3. 「系统代理」档与「直连」档行为差异可观测。
  4. GDrive OAuth：access token 过期后自动刷新仍工作（token 端点已改走注入层）。
  5. 保留天数：云端 keep 源 n=1 days=7，上传多份后仅超龄旧份被滚删；本地备份源同验。
  6. Firefox 构建下 background 代理全流程冒烟（MV3 event page 生命周期）。

## Self-Review 记录

- Spec 覆盖：core 注入（Task 1）、每源代理透传（Task 2）、代理 UI 与宿主能力声明（Task 5）、扩展 background 代理 + host_permissions + 装配（Task 6）、桌面自写 command（Task 7）、README 理由（Task 8）、保留 n 份/n 天全链（Task 3/4/5）、真机项（Task 9）。spec「非目标」（扩展端 per-request 代理、keepalive、分片）未越界。✔
- 占位符扫描：所有代码步骤含完整代码；「按既有用例先例调整」处均给出核心断言与数据（MdSegmentedButton 触发手法、extApi import 写法、Cargo 版本对齐）——为防与真实代码漂移的精确指令，非 TBD。✔
- 类型一致：`CloudFetchImpl` 四参签名在 Task 1 定义、Task 2/6/7 消费一致；消息协议字段名 `cloud-fetch`/`bodyB64` 两端一致；`Retention.days` 与 `normalizeRetention`/`isRetentionShape`/`selectBackupsToKeep`/`enforceRemoteRetention` 链一致。✔
