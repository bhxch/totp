# miniapp 体验增强与排序/云备份修复 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 spec 四项：云备份 404 根修（WebDAV 建目录 + 完整错误日志 + 尾分隔符目录语义 + 实际目标完整显示）、miniapp 搜索框/托盘定位/无边框/pin、销毁档白屏修复、管理页排序真机修复。

**Architecture:** 批 D→A→B→C 按依赖与诊断需求排序。D 为 core 纯函数 + fetch 层修复（TDD 可离线闭环）；A 横跨 Rust 窗口管理与 mini 前端；B/C 首步真机诊断（tauri-mcp-cli，debug 构建已装配 mcp-bridge），修复代码按诊断分支给出。每批一次原子 commit（spec §5 拆分）。

**Tech Stack:** Tauri 2.11.5（Rust，tray-icon 0.24.2）、Vue 3 + vitest、WXT 扩展、pnpm workspace。

**Spec:** `docs/superpowers/specs/2026-10-06-miniapp-sorting-cloud-fixes-design.md`（执行者须同时读 spec 与本计划；本计划按任务给代码，spec 给验收口径）。

## Global Constraints

- 测试门：根 `pnpm test`（= `vitest run && pnpm -r --no-bail run test`）全绿；`cd apps/desktop/src-tauri && cargo test` 全绿。若 Git Bash 下 pnpm 卡住，用 `cmd /c pnpm …`（仓库既有惯例）。
- 覆盖率 gate 不回退（CI：core 99.4/98.1、ui 95.6/89.5、ext 96.5/91.9、desktop 98/94、Rust 71/54）——每个任务的新代码必须带测试，禁止只写实现。
- i18n 一律 zh/en 双语成对（`packages/ui/src/i18n/locales/{zh,en}/common.json`）；改 `@totp/ui` 导出面时 vi.mock 工厂（importOriginal 展开式）须同步。
- commit 符合 Angular 规范；批内任务不单独提交，批尾统一提交（spec §5 的 5 笔代码 commit + 1 笔 e2e 文档 commit）。
- 仅 Windows 生效的 Rust 符号加 `#[cfg(windows)]`（防 Linux clippy dead_code）。
- Tauri API 事实已核实（勿再自查）：`WebviewWindowBuilder` 有 `decorations/shadow/resizable/always_on_top`；`AppHandle::monitor_from_point(x: f64, y: f64) -> Result<Option<Monitor>>`；`Monitor::work_area() -> &PhysicalRect<i32, u32>`（字段 `position: PhysicalPosition<i32>`、`size: PhysicalSize<u32>`）；`TrayIconEvent::Click { position: PhysicalPosition<f64>, rect: tray_icon::Rect }`（`Rect { position: PhysicalPosition<f64>, size: PhysicalSize<u32> }`）。
- 临时文件放 `E:\tmp\cc` 或仓库 `.temp/`（gitignore 内）。
- 诊断类任务（Task 9/12）使用 `.zcode/skills/tauri-mcp-cli/SKILL.md` 的会话引导方式驱动 debug 构建；**先跑 Task 9/12 的复现，再动 B/C 的修复代码**。

---

## 批 D：云备份（spec §4.2-4.5）→ commit 1 + commit 2

### Task 1: core——ensureHttpOk 完整错误 + WebDAV 逐级建目录 + 路径拒绝 #/?

**Files:**
- Modify: `packages/core/src/cloud/backend.ts:161-176`（CloudHttpError/ensureHttpOk）
- Modify: `packages/core/src/cloud/webdav.ts`（put 前置 ensureDavDir；全部 ensureHttpOk 补 await+method）
- Modify: `packages/core/src/cloud/targetPath.ts:7-15`（拒绝 `#`/`?`）
- Modify（机械同步，仅加 `await` 与 method 实参）: `packages/core/src/cloud/gist.ts:30,44`（GET/PUT）、`packages/core/src/cloud/s3.ts:161,166,171,176,197`、`packages/core/src/cloud/gdrive.ts:42,63,81,97,107,139,158,184`、`packages/core/src/cloud/onedrive.ts:36,41,46,51,61,72`——method 以各调用点 `init.method` 实际值为准
- Test: `packages/core/test/cloudFetch.test.ts`（ensureHttpOk 行为）、`packages/core/test/cloudWebdav.test.ts`（MKCOL 序列）、`packages/core/test/targetPath.test.ts`（#/?? 拒绝）

**Interfaces:**
- Produces: `ensureHttpOk(label: string, res: Response, method?: string): Promise<void>`（**改 async**，全仓库 27 处调用点）；`CloudHttpError` 新只读字段 `method?: string`、`url?: string`（host+pathname，无 query）、`bodySnippet?: string`（≤500 字符）。
- 消费方兼容：`isAuthErrorCode(status)` 与 `errorStatus` 透传（core multiTarget.ts:89 errorFields）不受影响——错误对象仍是 CloudHttpError 且 message 前缀 `「xx 请求失败（HTTP nnn）」` 不变，追加部分在其后。

- [ ] **Step 1: 写失败测试（ensureHttpOk 完整错误）**

在 `packages/core/test/cloudFetch.test.ts` 追加（import 区补 `CloudHttpError`、`ensureHttpOk`，`vi` 已从 vitest 导入则复用）：

```ts
describe('ensureHttpOk（spec §4.3 完整错误现场）', () => {
  it('非 2xx：抛 CloudHttpError 携带 method/url(剥 query)/bodySnippet，console.error 输出全量', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const fake = {
        ok: false, status: 404,
        url: 'https://dav.example.com/a/b/x.totpbackup?token=secret',
        text: async () => 'Directory not found',
      } as unknown as Response
      const err: CloudHttpError = await ensureHttpOk('WebDAV', fake, 'PUT').then(() => { throw new Error('should throw') }, (e) => e)
      expect(err.status).toBe(404)
      expect(err.method).toBe('PUT')
      expect(err.url).toBe('dav.example.com/a/b/x.totpbackup') // query 剥离（防 token 泄漏）
      expect(err.bodySnippet).toBe('Directory not found')
      expect(err.message).toContain('WebDAV 请求失败（HTTP 404）') // 前缀形态不变（既有匹配兜底）
      expect(err.message).toContain('PUT dav.example.com/a/b/x.totpbackup')
      expect(errSpy).toHaveBeenCalledWith('[cloud]', 'WebDAV', 'PUT', 'dav.example.com/a/b/x.totpbackup', 'HTTP 404', 'Directory not found')
    } finally {
      errSpy.mockRestore()
    }
  })
  it('响应体不可读：bodySnippet 缺省仍抛错；2xx：静默通过', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const noBody = { ok: false, status: 500, url: 'https://x/y', text: async () => { throw new Error('body locked') } } as unknown as Response
      const err = await ensureHttpOk('WebDAV', noBody, 'GET').then(() => null, (e) => e)
      expect(err.status).toBe(500)
      await expect(ensureHttpOk('WebDAV', { ok: true, status: 200 } as unknown as Response)).resolves.toBeUndefined()
    } finally {
      errSpy.mockRestore()
    }
  })
})
```

- [ ] **Step 2: 写失败测试（WebDAV MKCOL 序列）**

在 `packages/core/test/cloudWebdav.test.ts` 的 `describe('WebDAV 后端')` 内追加（沿用本文件 `vi.stubGlobal('fetch', …)` 惯例）：

```ts
it('put 前逐级 MKCOL 建父目录（spec §4.2）：405 已存在容忍，随后 PUT', async () => {
  const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'MKCOL') {
      // 第一级成功 201，第二级已存在 405（容忍）
      return new Response(null, String(url).endsWith('/a') ? { status: 201 } : { status: 405 })
    }
    return new Response(null, { status: 201 })
  })
  vi.stubGlobal('fetch', fetchMock)
  const backend = createWebdavBackend({ backend: 'webdav', serverUrl: `${DAV}/dav/`, username: 'user', password: 'pass', objectPath: 'a/b/x.totpbackup' })
  await backend.put('a/b/x.totpbackup', new TextEncoder().encode('hi'))
  const mkcols = fetchMock.mock.calls.filter((c) => c[1]!.method === 'MKCOL').map((c) => String(c[0]))
  expect(mkcols).toEqual([`${DAV}/dav/a`, `${DAV}/dav/a/b`])
  const last = fetchMock.mock.calls.at(-1)!
  expect(last[1]!.method).toBe('PUT')
  expect(String(last[0])).toBe(`${DAV}/dav/a/b/x.totpbackup`)
})

it('put：MKCOL 失败（403）抛错且不发 PUT；根目录对象（无目录段）不 MKCOL', async () => {
  const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => new Response(null, { status: 403 }))
  vi.stubGlobal('fetch', fetchMock)
  const backend = createWebdavBackend({ backend: 'webdav', serverUrl: DAV, username: 'user', password: 'pass', objectPath: 'a/b/x.totpbackup' })
  await expect(backend.put('a/b/x.totpbackup', new Uint8Array([1]))).rejects.toThrow(/403/)
  expect(fetchMock.mock.calls.every((c) => c[1]!.method === 'MKCOL')).toBe(true)

  const rootMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => new Response(null, { status: 201 }))
  vi.stubGlobal('fetch', rootMock)
  const rootBackend = createWebdavBackend({ backend: 'webdav', serverUrl: DAV, username: 'user', password: 'pass' })
  await rootBackend.put(PATH, new Uint8Array([1]))
  expect(rootMock.mock.calls.every((c) => c[1]!.method === 'PUT')).toBe(true)
})
```

- [ ] **Step 3: 写失败测试（#/? 拒绝）**

在 `packages/core/test/targetPath.test.ts` 的 `describe('resolveObjectPath')` 内追加：

```ts
it('拒绝 # 与 ?（URL 截断型 404 根因，spec §4.4）', () => {
  expect(() => resolveObjectPath({ backend: 'webdav', serverUrl: 's', username: 'u', password: 'p', objectPath: 'a#b.totpbackup' })).toThrow(/#/)
  expect(() => resolveObjectPath({ backend: 'webdav', serverUrl: 's', username: 'u', password: 'p', objectPath: 'a?b.totpbackup' })).toThrow(/\?/)
})
```

在 `describe('previewObjectPath…')` 内追加：

```ts
it('invalid：# / ? 折叠为 state:\'invalid\'', () => {
  expect(previewObjectPath({ ...base, objectPath: 'a#b' }, { type: 'overwrite' })).toEqual({ state: 'invalid', path: '' })
  expect(previewObjectPath({ ...base, objectPath: 'a?b' }, { type: 'keep', n: 3 })).toEqual({ state: 'invalid', path: '' })
})
```

- [ ] **Step 4: 运行确认失败**

Run: `pnpm --filter @totp/core test`
Expected: 上述新用例 FAIL（ensureHttpOk 非 async 无 bodySnippet；put 无 MKCOL；#/? 未拒绝）。

- [ ] **Step 5: 实现 backend.ts**

替换 `CloudHttpError` 与 `ensureHttpOk`（保留 I2 注释段落）：

```ts
/** 非 2xx 统一抛中文错误（含状态码）；404 分支由调用方按接口语义处理。
 *  审查 I2：错误对象携带数字 status（CloudHttpError）供结构化判定凭据失效。
 *  spec §4.3（2026-10-06）：补全错误现场——method/url(仅 host+pathname，剥 query 防 token 泄漏)
 *  与响应体摘要(≤500 字符)进只读字段，message 在原前缀形态后追加 method url 与换行 body；
 *  同步 console.error 一行结构化全量输出（控制台可排查，用户显式要求）。
 *  改 async：error 分支消费一次响应体，成功路径零开销。既有字符串匹配仅依赖前缀形态，兼容。 */
export class CloudHttpError extends Error {
  /** HTTP 状态码（数字，结构化判定用） */
  readonly status: number
  /** 请求方法（ensureHttpOk 第三参透传） */
  readonly method?: string
  /** 失败请求 URL（describeUrl 口径：host+pathname，无 query/fragment） */
  readonly url?: string
  /** 响应体摘要（≤500 字符；响应体不可读时缺省） */
  readonly bodySnippet?: string
  constructor(label: string, status: number, detail?: { method?: string; url?: string; bodySnippet?: string }) {
    const where = detail?.method && detail.url ? `：${detail.method} ${detail.url}` : ''
    const body = detail?.bodySnippet ? `\n${detail.bodySnippet}` : ''
    super(`${label} 请求失败（HTTP ${status}）${where}${body}`)
    this.name = 'CloudHttpError'
    this.status = status
    this.method = detail?.method
    this.url = detail?.url
    this.bodySnippet = detail?.bodySnippet
  }
}

export async function ensureHttpOk(label: string, res: Response, method?: string): Promise<void> {
  if (res.ok) return
  let bodySnippet: string | undefined
  try {
    bodySnippet = (await res.text()).slice(0, 500)
  } catch {
    bodySnippet = undefined // 响应体不可读（流已消费等）不阻断抛错
  }
  const url = describeUrl(res.url)
  console.error('[cloud]', label, method ?? '', url, `HTTP ${res.status}`, bodySnippet ?? '(响应体不可读)')
  throw new CloudHttpError(label, res.status, { method, url, bodySnippet })
}
```

- [ ] **Step 6: 实现 webdav.ts（ensureDavDir + 全部调用点 await）**

`createWebdavBackend` 内（`urlOf` 定义之后）加闭包函数；`put` 前置调用；五个调用点全部改 `await ensureHttpOk(LABEL, res, '<方法>')`：

```ts
  /** push 前逐级确保父目录存在（spec §4.2 404 根修）：按段累积 MKCOL；2xx 成功、
   *  405=集合已存在容忍（RFC 4918），其余状态经 ensureHttpOk 抛错（401/403 凭据问题
   *  原地暴露不做目录重试）。每次 put 全量执行无缓存：push 低频开销可忽略换无状态幂等。
   *  dir 为空（根目录对象）直接返回。 */
  async function ensureDavDir(dir: string): Promise<void> {
    if (dir === '') return
    const proxy = proxyOf(cred)
    let acc = ''
    for (const seg of dir.split('/')) {
      acc = acc ? `${acc}/${seg}` : seg
      const res = await cloudFetch(LABEL, urlOf(acc), { method: 'MKCOL', headers: { Authorization: auth } }, proxy)
      if (res.status === 405) continue
      await ensureHttpOk(LABEL, res, 'MKCOL')
    }
  }
```

`put` 改为：

```ts
    async put(path, data) {
      await ensureDavDir(resolveDirPath(cred))
      const res = await cloudFetch(LABEL, urlOf(path), {
        method: 'PUT',
        headers: { Authorization: auth },
        body: new Uint8Array(data),
      }, proxyOf(cred))
      await ensureHttpOk(LABEL, res, 'PUT')
    },
```

get/delete/exists/listBackups 的四个调用点补 `await` 与 method（`'GET'`/`'DELETE'`/`'GET'`/`'PROPFIND'`）；读路径不建目录。

- [ ] **Step 7: 实现 targetPath.ts #/? 拒绝**

`resolveObjectPath` 的 `\0` 检查之后插入：

```ts
  // #/? 不编码会被 URL parser 截断成 fragment/query → 实际写到错误位置（spec §4.4 404 根因之一）
  if (/[#?]/.test(raw)) throw new Error('云端路径不允许包含 # 或 ?')
```

- [ ] **Step 8: 机械同步其余 4 个后端调用点（await + method）**

gist.ts（GET/PUT）、s3.ts（各调用点读 init.method：PUT/GET/DELETE 等）、gdrive.ts（8 处）、onedrive.ts（7 处）。若该处调用点对 404 有语义分支（`res.status === 404` 先行返回），保持分支在 ensureHttpOk 之前不动。

- [ ] **Step 9: 运行 core 全量测试并修复受影响断言**

Run: `pnpm --filter @totp/core test`
Expected: 新用例 PASS；既有错误消息断言若为**精确相等**（少数可能断言完整 message）改为子串/前缀断言（`toThrow(/HTTP 401/)` 形态）；webdav put 既有用例若未配 objectPath（根目录）不受 MKCOL 影响，已配目录的用例需在 fetchMock 上接受 MKCOL 请求（按既有用例实际情况补 `init.method === 'MKCOL'` 分支返回 201）。

- [ ] **Step 10: 提交前标记（不 commit，批尾 Task 2 后统一提交）**

核对 `git diff --stat` 仅含上述文件。

### Task 2: ui——自动备份失败摘要携带错误 + latestKeepPath 留痕

**Files:**
- Modify: `packages/ui/src/components/cloudRunner.ts:348`（runOnce 的 recordStatus 摘要）与该函数内失败目标 console.error
- Modify: `packages/ui/src/components/cloudSyncShared.ts:37-44`（latestKeepPath catch 留痕）
- Test: `packages/ui/test/cloudRunner.test.ts`（扩展既有用例）

**Interfaces:**
- Consumes: Task 1 的 `CloudHttpError`（`x.error` 消息含 `HTTP nnn` 与 method/url；`x.errorStatus` 数字状态码经 core multiTarget errorFields 透传，本任务不改）。
- Produces: 自动备份落盘 summary 形态「源名： 失败（错误消息前 60 字符）」。

- [ ] **Step 1: 写失败测试**

在 `packages/ui/test/cloudRunner.test.ts` 追加用例（复用本文件既有 runOnce deps 构造工厂与 makeBackend/loadState stub 方式；仅在原「失败」断言用例基础上让 backend.put 抛 `new CloudHttpError('WebDAV', 404)`）：

```ts
it('自动 push 目标失败：summary 携带错误消息而非仅「失败」（spec §4.3）', async () => {
  // …沿用本文件既有「单目标失败」用例的 deps 装配，仅替换 backend.put 抛错对象：
  // backend = { id:'webdav', put: async () => { throw new CloudHttpError('WebDAV', 404) }, … }
  // 断言：
  // expect(recordSpy).toHaveBeenCalledWith(false, expect.stringContaining('失败（WebDAV 请求失败（HTTP 404）'))
  // 且 console.error 被 spy 到含 '[cloudRunner]'（put 前缀形如 '源显示名 failed:'）
})
```

（装配细节以该文件既有同构用例为准——本用例新增的断言面即上两行。）

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @totp/ui test -- cloudRunner`
Expected: 新用例 FAIL（summary 仍为「源名： 失败」）。

- [ ] **Step 3: 实现 cloudRunner.ts**

line 348 处改为：

```ts
    // spec §4.3（2026-10-06）：失败目标摘要并入错误消息（截 60 字符，与 CloudCard trunc 同量级），
    // 结构化状态码已在消息内（CloudHttpError 形态）；逐失败目标 console.error 全量现场
    const failLabel = (x: (typeof r.results)[number]): string => {
      if (x.outcome) return deps.t(actionStatusLabelKey(x.outcome))
      const msg = (x.error ?? '').slice(0, 60)
      return msg ? `${deps.t('cloudRunner.failed')}（${msg}）` : deps.t('cloudRunner.failed')
    }
    for (const x of r.results) {
      if (!x.outcome) console.error('[cloudRunner]', displayName(x.key), 'failed:', x.error, x.errorStatus)
    }
    deps.recordStatus?.(allTargetsSettled(r.results), r.results.map((x) => `${displayName(x.key)}: ${failLabel(x)}`).join('; '))
```

- [ ] **Step 4: 实现 cloudSyncShared.ts latestKeepPath**

```ts
  } catch (err) {
    // spec §4.3：吞错返回 null 的首推语义保留（读侧名单失败不得炸整轮），但留痕可排查
    console.warn('[cloud] listBackups 失败，keep 源按云端无对象首推', err)
    return null
  }
```

- [ ] **Step 5: 运行 ui 相关测试**

Run: `pnpm --filter @totp/ui test`
Expected: 全绿（既有 cloudRunner 用例若断言「失败」精确串需放宽为 stringContaining('失败')）。

- [ ] **Step 6: commit 1（批 D 第一笔，含 Task 1+2）**

```bash
git add packages/core/src/cloud packages/core/test packages/ui/src/components/cloudRunner.ts packages/ui/src/components/cloudSyncShared.ts packages/ui/test/cloudRunner.test.ts
git commit -m "fix(core): 云备份 WebDAV 逐级建目录与完整错误日志

why: 用户真机 404——WebDAV 全链路无 MKCOL，父目录不存在 PUT 即 404/409；
ensureHttpOk 丢响应体/方法/URL、自动备份通道只记「失败」二字致不可排查（spec §4.2-4.4）。
what: put 前逐级 MKCOL（405 容忍）；ensureHttpOk 改 async 携带 method/url(剥 query)/
bodySnippet(≤500) 并 console.error 全量；objectPath 拒绝 #/?；自动备份失败摘要
并入错误消息；latestKeepPath 吞错留痕。"
```

### Task 3: core——尾分隔符目录语义（spec §4.5 语义层）

**Files:**
- Modify: `packages/core/src/cloud/targetPath.ts`（仅 `resolveObjectPath`）
- Test: `packages/core/test/targetPath.test.ts`

**Interfaces:**
- Produces: 目录意向判据 = trim 后以 `/` 或 `\` 结尾；`resolveObjectPath` 对目录意向返回 `段.join('/') + '/' + DEFAULT_OBJECT_PATH`（段空回落 DEFAULT）。`resolveDirPath`/`resolveTimestampPath`/`previewObjectPath` **零改动**自动获得语义（三者均经 resolveObjectPath 派生：dir = 全路径剥末段）。
- 不变量：不以分隔符结尾的存量输入（含 undefined/空串/纯分隔符）行为逐字节不变。

- [ ] **Step 1: 写失败测试**

`packages/core/test/targetPath.test.ts` 追加 describe：

```ts
describe('尾分隔符目录语义（spec §4.5：/xxx/ 按目录处理）', () => {
  const base = { backend: 'webdav', serverUrl: 's', username: 'u', password: 'p' } as const
  const NOW = new Date(2026, 9, 6, 10, 0, 0)

  it('overwrite：目录意向追加默认文件名（/totpbackup/ → totpbackup/totp-backup.totpbackup）', () => {
    expect(resolveObjectPath({ ...base, objectPath: '/totpbackup/' })).toBe(`totpbackup/${DEFAULT_OBJECT_PATH}`)
    expect(resolveObjectPath({ ...base, objectPath: 'a\\b\\' })).toBe(`a/b/${DEFAULT_OBJECT_PATH}`)
  })
  it('keep：目录意向全段为目录（resolveTimestampPath 落该目录；resolveDirPath 同步）', () => {
    const cred = { ...base, objectPath: '/totpbackup/' } as const
    expect(resolveDirPath(cred)).toBe('totpbackup')
    expect(resolveTimestampPath(cred, NOW)).toBe(`totpbackup/vault-20261006-100000.totpbackup`)
  })
  it('仅分隔符（/ 或 //）：overwrite 回落默认；keep 目录为根', () => {
    expect(resolveObjectPath({ ...base, objectPath: '/' })).toBe(DEFAULT_OBJECT_PATH)
    expect(resolveDirPath({ ...base, objectPath: '//' })).toBe('')
  })
  it('不以分隔符结尾的存量语义零变化（回归）', () => {
    expect(resolveObjectPath({ ...base, objectPath: 'a/b.totpbackup' })).toBe('a/b.totpbackup')
    expect(resolveDirPath({ ...base, objectPath: 'a/b.totpbackup' })).toBe('a')
    expect(resolveObjectPath({ ...base, objectPath: 'a\\b' })).toBe('a/b')
  })
  it('目录意向同样拒绝穿越与 #/?（校验先于默认名追加）', () => {
    expect(() => resolveObjectPath({ ...base, objectPath: 'a/../b/' })).toThrow()
    expect(() => resolveObjectPath({ ...base, objectPath: 'a#/' })).toThrow()
  })
  it('预览同语义：overwrite 展示追加默认名后的完整目标；keep 展示目录', () => {
    expect(previewObjectPath({ ...base, objectPath: '/totpbackup/' }, { type: 'overwrite' }))
      .toEqual({ state: 'ok', path: `totpbackup/${DEFAULT_OBJECT_PATH}` })
    expect(previewObjectPath({ ...base, objectPath: '/totpbackup/' }, { type: 'keep', n: 3 }))
      .toEqual({ state: 'ok', path: 'totpbackup', keepNamePlaceholder: KEEP_NAME_PLACEHOLDER })
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @totp/core test -- targetPath`
Expected: 新 describe FAIL（`/totpbackup/` 现返回 `totpbackup` 单段文件名）。

- [ ] **Step 3: 实现（仅改 resolveObjectPath）**

```ts
export function resolveObjectPath(cred: CloudCred): string {
  const raw = cred.objectPath?.trim()
  if (raw === undefined || raw === '') return DEFAULT_OBJECT_PATH
  if (raw.includes('\0')) throw new Error('云端路径含非法字符')
  // #/? 不编码会被 URL parser 截断成 fragment/query → 实际写到错误位置（spec §4.4 404 根因之一）
  if (/[#?]/.test(raw)) throw new Error('云端路径不允许包含 # 或 ?')
  const segments = raw.split(/[\\/]/).filter((s) => s !== '')
  if (segments.length === 0) return DEFAULT_OBJECT_PATH
  if (segments.some((s) => s === '.' || s === '..')) throw new Error('云端路径不允许相对段（. / ..）')
  // 尾分隔符 = 目录意向（spec §4.5，2026-10-06 用户真机实证 /totpbackup/ 被当文件名落根目录）：
  // overwrite 补默认文件名成完整对象路径；keep 的目录由 resolveDirPath 对同输入取全段获得。
  // 不以分隔符结尾维持原契约（末段=文件名），存量凭据行为零变化
  if (/[\\/]$/.test(raw)) return `${segments.join('/')}/${DEFAULT_OBJECT_PATH}`
  return segments.join('/')
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm --filter @totp/core test`
Expected: targetPath 全绿（既有用例零改动通过）。

### Task 4: ui——实际目标完整显示 + 忽略回显 + label 切换（spec §4.5 显示层）

**Files:**
- Modify: `packages/ui/src/components/CloudCredFields.vue:26-37,145-151`
- Modify: `packages/ui/src/i18n/locales/zh/common.json:310` 区、`packages/ui/src/i18n/locales/en/common.json` 对应区
- Test: `packages/ui/test/CloudCredFields.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `previewObjectPath`/`resolveObjectPath` 语义；既有 `DEFAULT_OBJECT_PATH`、`KEEP_NAME_PLACEHOLDER` 导出。
- Produces: 预览行展示（webdav: serverUrl 归一 + 目标路径的完整 URL；s3: `s3://{bucket}/{path}`；gist/gdrive/onedrive 维持路径显示）；keep 文件名段忽略警示行；objectPath label 随保留模式切换。

- [ ] **Step 1: 写失败测试**

`packages/ui/test/CloudCredFields.test.ts` 追加（沿用 `mountFields` 工厂）：

```ts
describe('CloudCredFields 实际目标完整显示与目录语义（spec §4.5）', () => {
  it('webdav overwrite：预览拼 serverUrl 完整 URL', () => {
    const w = mountFields({ ...WEBDAV, objectPath: 'dav/sub/my.totpbackup' })
    expect(w.text()).toContain('实际目标：https://dav.example.com/dav/sub/my.totpbackup')
  })
  it('webdav keep + 目录意向：完整 URL + 自动命名占位，无忽略警示', () => {
    const w = mountFields({ ...WEBDAV, objectPath: '/totpbackup/' }, KEEP3)
    expect(w.text()).toContain('实际目标：https://dav.example.com/totpbackup/vault-YYYYMMDD-HHMMSS.totpbackup')
    expect(w.text()).not.toContain('不生效')
  })
  it('webdav keep + 文件名输入：警示行回显被忽略的文件名；仅文件名时提示整体不参与', () => {
    const w = mountFields({ ...WEBDAV, objectPath: 'docs/sub/my.totpbackup' }, KEEP3)
    expect(w.text()).toContain('不生效')
    const noDir = mountFields({ ...WEBDAV, objectPath: 'onlyname.totpbackup' }, KEEP3)
    expect(noDir.text()).toContain('整体不参与')
  })
  it('s3：bucket 已填显示 s3:// URI；bucket 空回落裸路径', () => {
    const s3 = mountFields({ backend: 's3', region: 'r', bucket: 'bk', accessKeyId: 'a', secretAccessKey: 's', objectPath: 'p/x.totpbackup' })
    expect(s3.text()).toContain('s3://bk/p/x.totpbackup')
    const noBucket = mountFields({ backend: 's3', region: 'r', bucket: '', accessKeyId: 'a', secretAccessKey: 's', objectPath: 'p/x.totpbackup' })
    expect(noBucket.text()).toContain('实际目标：p/x.totpbackup')
  })
  it('keep 模式 label 切换为目标目录；overwrite 维持目标文件路径', () => {
    const keep = mountFields({ ...WEBDAV, objectPath: 'dir/' }, KEEP3)
    expect(keep.text()).toContain('目标目录')
    const ow = mountFields({ ...WEBDAV })
    expect(ow.text()).toContain('目标文件路径')
  })
  it('serverUrl 为空/非法时回落裸路径显示（不出错）', () => {
    const w = mountFields({ backend: 'webdav', serverUrl: '', username: 'u', password: 'p', objectPath: 'a/b.totpbackup' })
    expect(w.text()).toContain('实际目标：a/b.totpbackup')
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @totp/ui test -- CloudCredFields`
Expected: 新用例 FAIL；**既有三个断言需按新显示口径更新**（同文件内）：
- `'实际目标：dav/sub/my.totpbackup'` → `'实际目标：https://dav.example.com/dav/sub/my.totpbackup'`
- `'实际目标：totp-backup.totpbackup'` → `'实际目标：https://dav.example.com/totp-backup.totpbackup'`
- keep 用例 `'实际目标：docs/sub/vault-…'` → `'实际目标：https://dav.example.com/docs/sub/vault-…'`；`'实际目标：（根目录）/vault-…'` → `'实际目标：https://dav.example.com/vault-…'`

- [ ] **Step 3: 实现 CloudCredFields.vue script 段**

在 `pathPreviewText` 旁新增（替换原 computed 链）：

```ts
const isKeep = computed(() => (props.retention?.type ?? 'overwrite') === 'keep')
/** spec §4.5：实际目标显示完整地址的 base——webdav=serverUrl 归一（http/https 才认），
 *  s3=s3://bucket；缺失/非法返回 null 回落裸路径。显示原文不预编码（URL 编码属传输细节） */
function urlBaseOf(d: CloudCred | undefined): string | null {
  if (d?.backend === 'webdav') {
    const raw = d.serverUrl.trim()
    try {
      const u = new URL(raw)
      if (u.protocol === 'http:' || u.protocol === 'https:') return raw.replace(/\/+$/, '')
    } catch { /* 回落裸路径 */ }
  }
  if (d?.backend === 's3' && 'bucket' in d && d.bucket.trim() !== '') return `s3://${d.bucket.trim()}`
  return null
}
```

`pathPreviewText` 改为（overwrite 拼 base+完整路径；keep 的 `{dir}` 传 base[/dir] 或裸目录，根目录回占位）：

```ts
const pathPreviewText = computed(() => {
  const p = pathPreview.value
  if (!p || p.state !== 'ok') return ''
  const base = urlBaseOf(props.draft)
  if (p.keepNamePlaceholder === undefined) {
    return t('cloudCard.pathPreviewOverwrite', { path: base ? `${base}/${p.path}` : p.path })
  }
  // keep：目录段显示 base[/dir]（URL 场景）或裸目录；空目录回落「（根目录）」占位
  const dirFull = base ? `${base}${p.path ? `/${p.path}` : ''}` : p.path
  return t('cloudCard.pathPreviewKeep', {
    dir: dirFull === '' ? t('cloudCard.pathPreviewRoot') : dirFull,
    name: p.keepNamePlaceholder,
  })
})
```

keep 忽略警示（script 段）：

```ts
/** keep 文件名段忽略回显（spec §4.5）：目录意向（尾分隔符）不警示；
 *  有目录段警示文件名忽略；仅单段警示整体不参与 */
const keepIgnoreWarn = computed(() => {
  if (!isKeep.value) return null
  const raw = (props.draft?.objectPath ?? '').trim()
  if (raw === '' || /[\\/]$/.test(raw)) return null
  const segs = raw.split(/[\\/]/).filter((s) => s !== '')
  if (segs.length === 0) return null
  if (segs.length === 1) return { key: 'cloudCard.pathPreviewKeepNoDir', params: { raw } }
  return { key: 'cloudCard.pathPreviewKeepFileIgnored', params: { name: segs.at(-1), dir: segs.slice(0, -1).join('/') } }
})
const objectPathLabel = computed(() => (isKeep.value ? t('cloudCard.objectPathLabelKeep') : t('cloudCard.objectPathLabel')))
```

template 段（145 行 MdTextField 与 146-151 预览区）改为：

```html
    <MdTextField v-if="d" :model-value="d.objectPath ?? ''" :label="objectPathLabel" :placeholder="DEFAULT_OBJECT_PATH" :aria-label="objectPathLabel" :disabled="busy" @update:model-value="d.objectPath = $event.trim()" />
    <template v-if="d && pathPreview">
      <p v-if="pathPreview.state === 'ok'" class="hint path-preview">{{ pathPreviewText }}</p>
      <p v-else class="warn path-preview" role="alert">{{ t('cloudCard.pathPreviewInvalid') }}</p>
      <p v-if="keepIgnoreWarn" class="warn" role="alert">{{ t(keepIgnoreWarn.key, keepIgnoreWarn.params) }}</p>
      <p v-if="pathPreview.state === 'ok' && (d.backend === 'gdrive' || d.backend === 'gist')" class="hint">{{ t('cloudCard.pathPreviewFlatHint') }}</p>
    </template>
```

- [ ] **Step 4: 实现 i18n 键（zh/en 成对）**

zh（cloudCard 区，objectPathLabel 后插入）：

```json
    "objectPathLabelKeep": "目标目录（文件名自动生成）",
    "pathPreviewKeepFileIgnored": "文件名「{name}」在保留最近模式下不生效，仅目录「{dir}」参与；如需自定义文件名请改用覆盖模式",
    "pathPreviewKeepNoDir": "你填写的「{raw}」在保留最近模式下整体不参与，请填写以 / 结尾的目录或改用覆盖模式",
```

en（同位置）：

```json
    "objectPathLabelKeep": "Target directory (file name auto-generated)",
    "pathPreviewKeepFileIgnored": "File name \"{name}\" is ignored in keep-latest mode; only directory \"{dir}\" applies. Switch to overwrite mode for a custom file name",
    "pathPreviewKeepNoDir": "\"{raw}\" is ignored entirely in keep-latest mode. Enter a directory ending with / or switch to overwrite mode",
```

- [ ] **Step 5: 运行确认通过**

Run: `pnpm --filter @totp/ui test`
Expected: CloudCredFields 全绿（含更新后的 3 处既有断言）。

- [ ] **Step 6: i18n 校验**

Run: `pnpm check:i18n`（若脚本名不同以 package.json 为准）
Expected: 通过（zh/en 键集一致）。

- [ ] **Step 7: commit 2（批 D 第二笔，含 Task 3+4）**

```bash
git add packages/core/src/cloud/targetPath.ts packages/core/test/targetPath.test.ts packages/ui/src/components/CloudCredFields.vue packages/ui/src/i18n/locales packages/ui/test/CloudCredFields.test.ts
git commit -m "feat(cloud): 目标路径尾分隔符目录语义与实际目标完整显示

why: 用户实填 /totpbackup/（目录意向）被解析层当文件名，keep 模式上传落根
目录且预览与输入完全对不上（spec §4.5，真机实证）；实际目标仅裸路径不足
以核对真实落位。
what: resolveObjectPath 尾分隔符=目录意向（overwrite 补默认文件名，keep 全段
为目录，存量输入行为零变化）；预览拼 serverUrl/s3 完整地址；keep 文件名段
忽略显式回显；label 按保留模式切换。"
```

---

## 批 A：miniapp（spec §1）→ commit 3（Task 5-8 完成后统一提交）

### Task 5: Rust——pin 命令/缓存/失焦守卫 + 无边框 builder + capabilities

**Files:**
- Modify: `apps/desktop/src-tauri/src/lib.rs`（static 区 ~47 行附近、命令区 ~211 行后、ensure_window mini 分支 382-392、on_window_event 650-656、invoke_handler 668-704、setup 610-647）
- Modify: `apps/desktop/src-tauri/capabilities/default.json`
- Test: `apps/desktop/src-tauri/src/settings_io.rs` 测试模块（miniPinned 键 roundtrip）

**Interfaces:**
- Produces: Tauri 命令 `mini_pin_get() -> bool`、`mini_pin_set(pinned: bool)`（前端 invoke 名即此）；Rust `static MINI_PINNED: AtomicBool`；settings.json 键 `miniPinned`。
- 消费方：Task 7 前端 invoke；Task 6 的 remember/restore 与本任务 builder 无耦合。

- [ ] **Step 1: 写失败测试（settings roundtrip）**

在 `settings_io.rs` 测试模块（已有 `write_section_at_creates_dirs_and_roundtrips_foreign_keys` 同款风格）追加：

```rust
    #[test]
    fn mini_pinned_roundtrips_and_preserves_foreign_keys() {
        // miniPinned bool 节写入后可读回，且外来键（releasePolicy/shortcutToggleMini 等）保留
        let tmp = tempfile::tempdir().expect("tmpdir");
        let path = tmp.path().join("settings.json");
        std::fs::write(&path, r#"{"shortcutToggleMini":"ctrl+shift+k"}"#).expect("seed");
        write_section_at(&path, "miniPinned", &true).expect("write");
        assert_eq!(read_section_at(&path, "miniPinned").and_then(|v| v.as_bool()), Some(true));
        assert_eq!(read_section_at(&path, "shortcutToggleMini").and_then(|v| v.as_str()), Some("ctrl+shift+k"));
    }
```

（若该测试文件已有 tempfile 依赖与 helper，按既有 helper 改写；断言面不变。）

- [ ] **Step 2: 运行确认失败**

Run: `cd apps/desktop/src-tauri && cargo test mini_pinned`
Expected: FAIL（write_section_at 通用函数其实已支持任意键——若直接通过则本步作为既有能力验证，直接进入 Step 3；此测试的价值是锁定新键的合并写行为）。

- [ ] **Step 3: 实现 lib.rs**

① static 区（`LAST_FOCUS_HIDE` 定义旁）新增：

```rust
// ---------- mini pin（spec §1.5）：settings.json miniPinned 键 + 内存缓存；失焦/复制后自动隐藏均让位 ----------
static MINI_PINNED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
```

② 命令区（`release_policy_set` 后）新增：

```rust
/// mini pin 读取（spec §1.5）：前端按钮初值与 Rust 失焦守卫共用同一缓存真源
#[tauri::command]
fn mini_pin_get() -> bool {
    MINI_PINNED.load(std::sync::atomic::Ordering::Relaxed)
}

/// mini pin 设置：缓存 + settings.json 合并写 + 对存活窗口即时生效（重建恢复走 builder）
#[tauri::command]
fn mini_pin_set<R: Runtime>(app: AppHandle<R>, pinned: bool) -> Result<(), String> {
    MINI_PINNED.store(pinned, std::sync::atomic::Ordering::Relaxed);
    write_section(&app, "miniPinned", &pinned)?;
    if let Some(mini) = app.get_webview_window("mini") {
        let _ = mini.set_always_on_top(pinned);
    }
    Ok(())
}
```

③ setup（`ensure_window(app.handle(), "mini");` 之后）：

```rust
            // mini pin 初值：settings.json → 内存缓存（builder always_on_top 与失焦守卫共用）
            let mini_pinned = read_section(app.handle(), "miniPinned")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            MINI_PINNED.store(mini_pinned, std::sync::atomic::Ordering::Relaxed);
```

（`read_section` 需加入顶部 `use settings_io::{…}` 导入列表。）

④ `ensure_window` mini 分支 builder 追加（`enable_clipboard_access()` 后）：

```rust
        // spec §1.4/§1.5：无边框 + 系统阴影 + 固定尺寸；pin 存续时重建窗口保持置顶
        .decorations(false)
        .shadow(true)
        .resizable(false)
        .always_on_top(MINI_PINNED.load(std::sync::atomic::Ordering::Relaxed))
```

⑤ `on_window_event` 的 `Focused(false)` 分支：

```rust
                WindowEvent::Focused(false) => {
                    // spec §1.5：pin 后失焦不再自动隐藏、不记录 300ms 防竞态时刻
                    if window.label() == "mini" && !MINI_PINNED.load(std::sync::atomic::Ordering::Relaxed) {
                        if let Ok(mut last) = LAST_FOCUS_HIDE.lock() {
                            *last = Some(Instant::now());
                        }
                        let _ = window.hide();
                    }
                }
```

⑥ `invoke_handler` 列表 `release_policy_set,` 后插入 `mini_pin_get, mini_pin_set,`。

⑦ `capabilities/default.json` permissions 数组追加 `"core:window:allow-start-dragging"`（drag-region 所需）。

- [ ] **Step 4: 运行确认通过**

Run: `cd apps/desktop/src-tauri && cargo test && cargo clippy`
Expected: 全绿；Linux 侧符号无（MINI_PINNED 全平台使用，无需 cfg）。

### Task 6: Rust——托盘锚定定位 + 上次位置记忆

**Files:**
- Modify: `apps/desktop/src-tauri/src/lib.rs`（static 区、纯函数、toggle_mini 213-238、setup_tray 494-508、快捷键两处调用点、on_window_event）
- Test: `apps/desktop/src-tauri/src/lib.rs` 测试模块

**Interfaces:**
- Consumes: Task 5 的 MINI_PINNED（无直接耦合）。
- Produces: `fn mini_position_for_tray(tray_x: f64, tray_y: f64, tray_w: f64, tray_h: f64, win_w: i32, win_h: i32, work_x: i32, work_y: i32, work_w: u32, work_h: u32) -> (i32, i32)`（纯函数）；`fn toggle_mini(app: &AppHandle, anchor: Option<(f64, f64, f64, f64)>)`（**签名变更**，快捷键调用点传 `None`）。

- [ ] **Step 1: 写失败测试**

lib.rs 测试模块追加：

```rust
#[test]
fn mini_position_for_tray_aligns_bottom_right_above_icon() {
    // 图标 (1800,1040,32,32)、窗 320x420、工作区 (0,0,1920,1040)：右缘对齐 1832-320、底贴 1040-420
    assert_eq!(mini_position_for_tray(1800.0, 1040.0, 32.0, 32.0, 320, 420, 0, 0, 1920, 1040), (1512, 620));
}

#[test]
fn mini_position_for_tray_clamps_into_work_area() {
    // 右溢 clamp 到工作区右缘；左溢 clamp 到 work_x；底贴不越界
    assert_eq!(mini_position_for_tray(1900.0, 1040.0, 32.0, 32.0, 320, 420, 0, 0, 1920, 1040), (1600, 620));
    assert_eq!(mini_position_for_tray(10.0, 1000.0, 32.0, 32.0, 320, 420, 0, 0, 1920, 1040), (0, 580));
}

#[test]
fn mini_position_for_tray_window_larger_than_work_area_no_panic() {
    // 窗大于工作区：clamp 区间退化不 panic（max 取 min 兜底）
    let _ = mini_position_for_tray(100.0, 100.0, 32.0, 32.0, 4000, 3000, 0, 0, 1920, 1040);
}
```

- [ ] **Step 2: 运行确认失败**

Run: `cd apps/desktop/src-tauri && cargo test mini_position`
Expected: FAIL（函数不存在，编译错误即视为红）。

- [ ] **Step 3: 实现**

① static 区新增：

```rust
// ---------- mini 托盘定位（spec §1.3）：点击处弹出 + 上次位置恢复 ----------
static LAST_MINI_POS: Mutex<Option<(i32, i32)>> = Mutex::new(None);
```

② 纯函数 + 两个 helper（`toggle_mini` 前定义）：

```rust
/// 纯几何（单测覆盖）：窗口右下角贴近托盘图标——右缘对齐图标右缘、底缘贴图标顶缘；
/// clamp 进显示器工作区（任务栏任意边/多显示器不溢出）。win 大于工作区时 clamp 区间
/// 退化（max 取 min 兜底防 i32::clamp panic）。输入输出全物理像素。
fn mini_position_for_tray(
    tray_x: f64, tray_y: f64, tray_w: f64, tray_h: f64,
    win_w: i32, win_h: i32,
    work_x: i32, work_y: i32, work_w: u32, work_h: u32,
) -> (i32, i32) {
    let max_x = (work_x + work_w as i32 - win_w).max(work_x);
    let max_y = (work_y + work_h as i32 - win_h).max(work_y);
    let x = ((tray_x + tray_w) as i32 - win_w).clamp(work_x, max_x);
    let y = (tray_y as i32 - win_h).clamp(work_y, max_y);
    (x, y)
}

/// 隐藏前记忆 mini 位置（Focused(false)/CloseRequested/托盘 toggle 三路径共用），
/// 供销毁重建后快捷键打开恢复
fn remember_mini_pos(window: &tauri::WebviewWindow) {
    if let Ok(p) = window.outer_position() {
        if let Ok(mut g) = LAST_MINI_POS.lock() {
            *g = Some((p.x, p.y));
        }
    }
}

/// 按托盘 anchor 定位 mini（物理像素）；monitor/尺寸不可得仅留痕不阻塞弹出
fn position_mini_at_tray(mini: &tauri::WebviewWindow, anchor: (f64, f64, f64, f64)) {
    let (tray_x, tray_y, tray_w, tray_h) = anchor;
    let Ok(size) = mini.outer_size() else { return };
    let mon = mini
        .app_handle()
        .monitor_from_point(tray_x + tray_w / 2.0, tray_y + tray_h / 2.0)
        .ok()
        .flatten();
    let (x, y) = match &mon {
        Some(m) => {
            let wa = m.work_area();
            mini_position_for_tray(
                tray_x, tray_y, tray_w, tray_h,
                size.width as i32, size.height as i32,
                wa.position.x, wa.position.y, wa.size.width, wa.size.height,
            )
        }
        None => ((tray_x + tray_w) as i32 - size.width as i32, tray_y as i32 - size.height as i32),
    };
    if let Err(e) = mini.set_position(tauri::PhysicalPosition::new(x, y)) {
        eprintln!("[tray] mini set_position failed: {e}");
    }
}
```

③ `toggle_mini` 签名与 show 分支（隐藏分支加 `remember_mini_pos(&mini);`）：

```rust
fn toggle_mini(app: &AppHandle, anchor: Option<(f64, f64, f64, f64)>) {
    // 释放策略销毁档可能已销毁 webview（仅留托盘进程）：入口先按需重建（brief Task 13）
    ensure_window(app, "mini");
    if let Some(mini) = app.get_webview_window("mini") {
        if mini.is_visible().unwrap_or(false) {
            remember_mini_pos(&mini);
            let _ = mini.hide();
        } else {
            // mini 刚因失焦被隐藏（<300ms）时，本次点击视为「点托盘收起」，保持隐藏
            if let Ok(last) = LAST_FOCUS_HIDE.lock() {
                if let Some(t) = *last {
                    if t.elapsed() < Duration::from_millis(300) {
                        return;
                    }
                }
            }
            // 定位先于 show（不可见期移动无闪烁）：托盘点击=每次锚定托盘；
            // 快捷键=恢复上次位置（销毁重建后亦然），无记忆则 OS 默认
            if let Some(a) = anchor {
                position_mini_at_tray(&mini, a);
            } else if let Ok(g) = LAST_MINI_POS.lock() {
                if let Some((x, y)) = *g {
                    let _ = mini.set_position(tauri::PhysicalPosition::new(x, y));
                }
            }
            let shown = mini.show();
            // （原有 show 留痕注释保留）
            if let Err(e) = shown {
                eprintln!("[shortcut] toggle_mini: mini.show() failed: {e}");
            }
            let _ = mini.set_focus();
        }
    }
}
```

④ `setup_tray` 事件分支显式解构 `rect` 并传 anchor：

```rust
            if let TrayIconEvent::Click {
                button,
                button_state: tauri::tray::MouseButtonState::Up,
                rect,
                ..
            } = event
            {
                let anchor = Some((rect.position.x, rect.position.y, rect.size.width as f64, rect.size.height as f64));
                match button {
                    tauri::tray::MouseButton::Left => toggle_mini(_tray.app_handle(), anchor),
                    tauri::tray::MouseButton::Middle => show_main(_tray.app_handle()),
                    _ => {}
                }
            }
```

⑤ 两处快捷键调用点（`apply_shortcut_override` 内与 global_shortcut builder 内）改 `toggle_mini(a, None)` / `toggle_mini(app, None)`。

⑥ `on_window_event` 的 `Focused(false)`（Task 5 改后）与 `CloseRequested` 分支、hide 前对 mini 记忆：

```rust
                WindowEvent::CloseRequested { api, .. } => {
                    if window.label() == "mini" {
                        remember_mini_pos(window);
                    }
                    api.prevent_close();
                    let _ = window.hide();
                }
```

（Focused(false) 的 hide 前同样插 `remember_mini_pos(window);`——位于 label/pin 判定内。）

- [ ] **Step 4: 运行确认通过**

Run: `cd apps/desktop/src-tauri && cargo test && cargo clippy && cargo fmt --check`
Expected: 全绿。

### Task 7: 前端——标题区 chrome（拖拽区/pin/收起）+ 复制自动隐藏让位

**Files:**
- Modify: `apps/desktop/src/MiniApp.vue`（template 149-161、script、style 163-168）
- Modify: `apps/desktop/test/mocks/tauri.ts`（invoke 分发表补 mini_pin_get/mini_pin_set；如 windowModule 无 hide spy 则补）
- Test: `apps/desktop/src/MiniApp.test.ts`

**Interfaces:**
- Consumes: Task 5 命令 `mini_pin_get`/`mini_pin_set`；既有 `tr()`（mini i18n 胶水）。
- Produces: `pinned` ref（Task 8/10 同文件复用不冲突）；`mini.pinTitle`/`mini.hideTitle` i18n 键。

- [ ] **Step 1: 写失败测试**

`MiniApp.test.ts` 追加（沿用文件既有 mount/flushPromises 惯例）：

```ts
describe('mini 标题区 chrome（spec §1.4/§1.5）', () => {
  it('pin 按钮切换：invoke mini_pin_set(pinned) 且 aria-pressed 同步', async () => {
    const w = await mountMini() // 复用本文件既有挂载 helper
    const btn = w.find('[data-test="pin-btn"]')
    expect(btn.attributes('aria-pressed')).toBe('false')
    await btn.trigger('click')
    await flushPromises()
    expect(tauriMock.invoke).toHaveBeenCalledWith('mini_pin_set', { pinned: true })
    expect(w.find('[data-test="pin-btn"]').attributes('aria-pressed')).toBe('true')
  })
  it('pinned 时复制后不自动隐藏；取消 pin 恢复', async () => {
    const w = await mountMini()
    // 复用既有 500ms 自动隐藏用例的时钟与复制驱动手法：
    vi.useFakeTimers()
    await w.find('[data-test="pin-btn"]').trigger('click') // pin
    await w.find('[data-test="copy"]').trigger('click')
    await vi.advanceTimersByTimeAsync(600)
    expect(tauriMock.window.hide).not.toHaveBeenCalled()
    await w.find('[data-test="pin-btn"]').trigger('click') // 取消
    await w.find('[data-test="copy"]').trigger('click')
    await vi.advanceTimersByTimeAsync(600)
    expect(tauriMock.window.hide).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })
  it('收起按钮：调用 window.hide', async () => {
    const w = await mountMini()
    await w.find('[data-test="hide-btn"]').trigger('click')
    expect(tauriMock.window.hide).toHaveBeenCalled()
  })
})
```

（`tauriMock.invoke`/`window.hide` 的暴露形态以 `test/mocks/tauri.ts` 实际为准——mock 需新增 `mini_pin_get`（返回当前 pin 态变量）与 `mini_pin_set`（记录并更新）分发；windowModule 若无 hide 记录则补 `hide: vi.fn(async () => {})`。）

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter desktop… test`（desktop 包名以 apps/desktop/package.json name 为准，下同）
Expected: FAIL（无 pin-btn/hide-btn 元素、invoke 分发缺失）。

- [ ] **Step 3: 实现 MiniApp.vue**

script 段（autoHide 定义处同步改）：

```ts
/** mini pin（spec §1.5）：状态真源在 Rust（settings.json+缓存），本地 ref 镜像供按钮与自动隐藏判定 */
const pinned = ref(false)
async function togglePin() {
  pinned.value = !pinned.value
  await invoke('mini_pin_set', { pinned: pinned.value }).catch((e) => console.error('[mini] pin set failed:', e))
}
function hideMini() { void getCurrentWindow().hide() }
```

```ts
const autoHide = createCopyAutoHide(500, () => { if (!pinned.value) void getCurrentWindow().hide() })
```

onMounted 内（`await load()` 之前）补初值：

```ts
  pinned.value = await invoke<boolean>('mini_pin_get').catch(() => false)
```

template（`<main class="mini">` 首子元素）：

```html
    <header class="titlebar">
      <span class="title-drag" data-tauri-drag-region>TOTP</span>
      <button class="tb-btn" data-test="pin-btn" :class="{ active: pinned }" :aria-pressed="pinned" :title="tr('mini.pinTitle')" :aria-label="tr('mini.pinTitle')" @click="togglePin">📌</button>
      <button class="tb-btn" data-test="hide-btn" :title="tr('mini.hideTitle')" :aria-label="tr('mini.hideTitle')" @click="hideMini">✕</button>
    </header>
```

style 追加：

```css
.titlebar { display: flex; align-items: center; gap: 2px; height: 34px; padding: 0 4px 0 10px; user-select: none; }
.title-drag { flex: 1; font-size: var(--md-sys-typescale-body-small); opacity: .6; }
.tb-btn { border: none; background: transparent; cursor: pointer; width: 28px; height: 28px; border-radius: 6px; color: inherit; font-size: 12px; line-height: 1; }
.tb-btn:hover { background: var(--md-sys-color-surface-container-highest, rgba(0, 0, 0, .08)); }
.tb-btn.active { color: var(--md-sys-color-primary); }
```

i18n 键（zh/en mini 区成对）：

```json
    "pinTitle": "固定窗口（置顶且不自动隐藏）",
    "hideTitle": "收起",
```
```json
    "pinTitle": "Pin window (always on top, no auto-hide)",
    "hideTitle": "Hide",
```

- [ ] **Step 4: 运行确认通过**

Run: desktop 包 vitest 全量
Expected: 全绿（既有自动隐藏用例不 pin 时行为不变）。

### Task 8: 前端——搜索框（SearchBar + searchEntries 同源谓词）

**Files:**
- Modify: `packages/ui/src/index.ts`（若 `searchEntries` 未导出则补 `export { searchEntries } from './popupFilter'`——先 `rg -n "searchEntries" packages/ui/src/index.ts` 确认）
- Modify: `apps/desktop/src/MiniApp.vue`（script/template/style + load() 内 mountI18n 次序）
- Modify: `packages/ui/src/i18n/locales/{zh,en}/common.json`（mini.searchEmpty）
- Test: `apps/desktop/src/MiniApp.test.ts`

**Interfaces:**
- Consumes: `SearchBar`（`@totp/ui` index.ts:19 已导出）、`searchEntries(entries, q)`（popupFilter.ts:38）、Task 7 的 `pinned`（无关但同文件）。
- 关键约束：SearchBar 内部 `useI18n()`，必须在 i18n 插件装入后才能渲染——mini 的 i18n 在 `load()` 内 `mountI18n(s)` 才装入，故 SearchBar 行需 `i18nReady` 门控，且 `mountI18n` 必须先于 `store.value = s`（否则 store 置位触发的重渲染可能早于装插件）。

- [ ] **Step 1: 写失败测试**

```ts
describe('mini 搜索框（spec §1.2）', () => {
  it('输入过滤列表：命中 issuer 子串；清空恢复；无命中显示 searchEmpty 文案', async () => {
    const w = await mountMini() // 种子两条（GitHub / Legacy），复用文件既有种子
    const input = w.find('input[type="search"]')
    await input.setValue('git')
    expect(w.findAll('[data-test="item"]')).toHaveLength(1)
    await input.setValue('zzz-no-match')
    expect(w.findAll('[data-test="item"]')).toHaveLength(0)
    expect(w.text()).toContain('无匹配条目')
    await input.setValue('')
    expect(w.findAll('[data-test="item"]')).toHaveLength(2)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: desktop 包 vitest
Expected: FAIL（无搜索框、'无匹配条目' 不存在）。

- [ ] **Step 3: 实现**

① `load()` 内次序调整（原 58/64 行）：

```ts
    // i18n 先于 store 置位挂载：SearchBar（useI18n）在 store 触发的重渲染时已可用（spec §1.2）
    mountI18n(s)
    i18nReady.value = true
    store.value = s
```

（原 `store.value = s` 之后的 `mountI18n(s)` 行删除；`if (restoredFromSlot…)` 与 `useTheme(s)` 次序不动。）

② script 段新增：

```ts
/** 搜索状态（spec §1.2）：谓词与 popup 同源（searchEntries），mini 无 tag/URL 语境不用 resolvePopupVisible */
const query = ref('')
const i18nReady = ref(false)
const visible = computed(() => searchEntries(sorted.value, query.value.trim()))
```

import 行补 `searchEntries`（自 `@totp/ui`；index.ts 未导出则先补导出）。

③ template：PersistErrorBanner 之后插入搜索行；列表 v-for 改 `visible`；空态链补 searchEmpty：

```html
    <div v-if="i18nReady" class="search-row"><SearchBar v-model="query" /></div>
```

```html
    <div v-else-if="!store || sorted.length === 0" class="empty">{{ tr('mini.empty') }}</div>
    <div v-else-if="visible.length === 0" class="empty">{{ tr('mini.searchEmpty') }}</div>
```

（`OtpListItem v-for="(e, i) in visible"`；序号即过滤后序位 `i + 1`，与 popup 同口径。）

④ style 补 `.search-row { padding: 2px 0; }`；i18n 键（zh mini 区）：

```json
    "searchEmpty": "无匹配条目",
```
```json
    "searchEmpty": "No matching entries",
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm --filter @totp/ui test && <desktop 包> vitest`
Expected: 全绿。

- [ ] **Step 5: commit 3（批 A 整批，Task 5-8）**

先真机冒烟（debug 构建）：托盘左键弹出位置贴近托盘、标题区可拖拽、pin 后失焦不隐藏且置顶、搜索过滤生效、无边框阴影正常；发现阻塞问题当场修复后再提交。

```bash
git add apps/desktop/src-tauri apps/desktop/src apps/desktop/capabilities packages/ui/src/index.ts packages/ui/src/i18n/locales
git commit -m "feat(desktop): miniapp 搜索框、托盘定位、无边框与 pin

why: miniapp 缺 popup 搜索框、窗口位置随机（OS 级联）、原生标题栏与失焦即
隐藏不可固定（spec §1，用户四问题之一；pin=置顶+不自动隐藏经用户确认）。
what: MiniApp 接入 SearchBar+searchEntries 同源过滤；托盘左键按图标 rect 锚
定弹出（work_area clamp）+ 快捷键恢复上次位置；decorations(false)+自绘标题
区（拖拽/pin/收起）；miniPinned 存 settings.json，失焦守卫与复制后自动隐藏
让位，重建经 builder always_on_top 恢复。"
```

---

## 批 B：销毁档白屏（spec §2）→ commit 4（Task 10-11；诊断记录随后并入 Task 14 文档）

### Task 9: 真机诊断——永久白屏根因定位（先于修复代码）

**Files:**
- 只读诊断 + 结论记录（写入 Task 14 的 e2e 文档草稿 `.temp/` 暂存，批尾归档）

**Interfaces:**
- Produces: 假设判定结论 h1/h2/h3（spec §2.5 表），决定 Task 10/11 之外的追加修复面。

- [ ] **Step 1: 构建 debug 版并起驱动会话**

```bash
cd apps/desktop && pnpm build   # vite 产 dist（脚本名以 package.json 为准）
cd src-tauri && cargo build     # debug exe（mcp-bridge 仅 debug 装配）
```

按 `.zcode/skills/tauri-mcp-cli/SKILL.md` 起 driver-session（参考 9223 端口先例）。

- [ ] **Step 2: 触发销毁档**

经 webview JS `__TAURI__.invoke('release_policy_set', {pauseMinutes: 0, destroyMinutes: 0, lockOnPause: false, lockOnDestroy: false})`（0/0=隐藏即销毁，30s tick 内触发）；把 mini 失焦隐藏后等待两 tick（~60s），确认 `get_webview_window` 语义（invoke 一个任意命令仍通=进程存活）。

- [ ] **Step 3: 重开并取证**

托盘/快捷键重开 → 截图；接 CDP（devtools 远程端口，`devtools_get_config`/环境注入先例见 memory：WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS）读取 console 与网络面板：**零请求零 JS= h3（WebView2 重建缺陷）**；资源 404 = h1；JS 异常 = h2（stack 摘录）。

- [ ] **Step 4: 结论落档**

把判定（含证据截图/console 摘录）记入 `.temp/diag-mini-white.md`；h3 成立时按 spec §2.5 降级预案追加修复：`destroy_releasable_windows`（lib.rs:331-356）中 label=="mini" 的 `w.destroy()` 改 `try_suspend_window(app, "mini")`（主窗维持 destroy），并在该 commit 说明中记「spec §2.5 h3 勘误」。

### Task 10: 前端——错误暴露 + 主题底色

**Files:**
- Modify: `apps/desktop/src/MiniApp.vue`（load catch 70-72、template 空态链、style）
- Modify: `apps/desktop/src/mini.ts`（顶层错误监听）
- Modify: `apps/desktop/mini.html`（内联底色）
- Modify: `packages/ui/src/i18n/locales/{zh,en}/common.json`（mini.loadFailed）
- Test: `apps/desktop/src/MiniApp.test.ts`

**Interfaces:**
- Produces: `loadFailed` ref；`mini.loadFailed` 文案。横幅显示条件 `loadFailed && !store`（聚焦重载成功后自然消失）。

- [ ] **Step 1: 写失败测试**

```ts
describe('mini load 失败暴露（spec §2.2）', () => {
  it('boot 失败：横幅 role=alert 渲染且 console.error 收到错误对象', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    ;(tauriMock.fs.readTextFile as Mock).mockRejectedValueOnce(new Error('disk boom'))
    const w = await mountMini()
    expect(w.find('[role="alert"]').exists()).toBe(true)
    expect(w.text()).toContain('加载失败')
    expect(errSpy).toHaveBeenCalledWith('[mini] load failed:', expect.any(Error))
    errSpy.mockRestore()
  })
})
```

（mountMini 挂载 helper 若在首个 mockRejectedValueOnce 前已读盘，则把 rejection 注入时机对齐到 load 首读——按文件既有 seedFs 时序调整。）

- [ ] **Step 2: 运行确认失败** → Run: desktop 包 vitest；Expected: FAIL。

- [ ] **Step 3: 实现**

① MiniApp.vue script：`const loadFailed = ref(false)`；catch 改：

```ts
  } catch (e) {
    // spec §2.2：不再静默——全栈进 console + 横幅上屏；下次聚焦 onFocusChanged 自动重载恢复
    console.error('[mini] load failed:', e)
    loadFailed.value = true
  }
```

② template 空态链 `copyFailed` 分支后插入：

```html
    <div v-else-if="loadFailed && !store" class="copy-error" role="alert">{{ tr('mini.loadFailed') }}</div>
```

③ mini.ts 顶层（mount 前）：

```ts
// spec §2.2：模块求值/挂载期异常此前完全不可见（永久白屏主嫌疑区）——顶层兜底留痕
window.addEventListener('error', (e) => console.error('[mini] window error:', e.error ?? e.message, e.filename, e.lineno))
window.addEventListener('unhandledrejection', (e) => console.error('[mini] unhandled rejection:', e.reason))
```

④ mini.html head 内联主题脚本后加：

```html
    <style>html{background:#fff}html[data-mode='dark']{background:#1c1b1f}</style>
```

⑤ MiniApp.vue style 追加（CSS 装载后接管精确主题色，html 变量随 useTheme data 属性切换）：

```css
html { background: var(--md-sys-color-background, #fff); }
```

⑥ i18n（zh mini 区）：

```json
    "loadFailed": "加载失败：聚焦本窗口将自动重试",
```
```json
    "loadFailed": "Load failed — refocus this window to retry",
```

- [ ] **Step 4: 运行确认通过** → Run: desktop 包 vitest；Expected: 全绿。

### Task 11: ready 门控 show（前端 emit + Rust 通道等待）

**Files:**
- Modify: `apps/desktop/src/MiniApp.vue`（onMounted load 后 emit）
- Modify: `apps/desktop/test/mocks/tauri.ts`（eventModule 补 emit 记录）
- Modify: `apps/desktop/src-tauri/src/lib.rs`（MINI_READY_TX 静态 + setup listen + toggle_mini 重建路径等待）
- Test: `apps/desktop/src/MiniApp.test.ts`、cargo 侧无新单测（时序逻辑靠真机清单）

**Interfaces:**
- Consumes: Task 6 后的 `toggle_mini(app, anchor)`。
- Produces: 全局事件 `mini-ready`（前端 load 完成 emit；Rust setup 注册一次，重建路径等待 ≤2s）。

- [ ] **Step 1: 写失败测试（前端侧）**

```ts
it('首次 load 完成后 emit mini-ready（spec §2.4）', async () => {
  await mountMini()
  expect(tauriMock.event.emit).toHaveBeenCalledWith('mini-ready')
})
```

（eventModule 缺 emit 则补 `emit: vi.fn(async () => {})` 并在 mock 聚合对象暴露。）

- [ ] **Step 2: 运行确认失败** → Expected: FAIL（无 emit 调用）。

- [ ] **Step 3: 前端实现**

MiniApp.vue：import 补 `emit`（自 `@tauri-apps/api/event`，与 listen 同源导入）；onMounted `await load()` 之后：

```ts
  // spec §2.4：首屏就绪信号（成败都发）——Rust 重建路径收到后再 show，消除冷启动空白窗口
  await emit('mini-ready').catch(() => {})
```

- [ ] **Step 4: Rust 实现**

① static 区：

```rust
// ---------- mini ready 门控（spec §2.4）：重建后等前端首屏就绪再 show（2s 超时兜底） ----------
static MINI_READY_TX: Mutex<Option<std::sync::mpsc::Sender<()>>> = Mutex::new(None);
```

② setup（Task 5 的 pin 初值代码后）：

```rust
            // mini-ready 全局事件：前端首屏 load 完成即发；重建路径经 MINI_READY_TX 消费
            let _ = app.listen("mini-ready", |_| {
                if let Ok(g) = MINI_READY_TX.lock() {
                    if let Some(tx) = g.as_ref() {
                        let _ = tx.send(());
                    }
                }
            });
```

③ `toggle_mini`（Task 6 版本上改）：入口重建判定前挂通道，show 前等待：

```rust
    let mut ready_rx: Option<std::sync::mpsc::Receiver<()>> = None;
    if app.get_webview_window("mini").is_none() {
        let (tx, rx) = std::sync::mpsc::channel();
        // 先挂通道再建窗：前端首屏 emit 不会落在建窗与等待之间丢失
        if let Ok(mut g) = MINI_READY_TX.lock() {
            *g = Some(tx);
        }
        ready_rx = Some(rx);
    }
    ensure_window(app, "mini");
```

show 分支内（300ms 守卫之后、定位与 show 之前）：

```rust
            // 重建路径：等前端 mini-ready（2s 超时兜底，前端卡死不堵弹出）
            if let Some(rx) = ready_rx {
                let _ = rx.recv_timeout(Duration::from_secs(2));
            }
```

- [ ] **Step 5: 运行与真机验证**

Run: `cd apps/desktop/src-tauri && cargo test && cargo clippy` + desktop vitest 全绿；按 Task 9 手法真机复跑销毁档→重开：窗口出现即主题底色、≤2s 内容可见。

- [ ] **Step 6: commit 4（批 B）**

```bash
git add apps/desktop/src apps/desktop/mini.html apps/desktop/src-tauri/src/lib.rs packages/ui/src/i18n/locales
git commit -m "fix(desktop): 销毁档重开白屏——错误暴露/主题底色/ready 门控

why: 销毁档真销毁 webview 后冷建立即 show，前端初始化完成前窗口无内容，
load() 静默吞错使失败停留白屏（spec §2，永久白屏经用户确认）。
what: load 失败横幅+console.error 全栈；顶层 error/unhandledrejection 监听；
html 主题底色；重建路径等 mini-ready 再 show（2s 兜底）。"
```

---

## 批 C：管理页排序真机修复（spec §3）→ commit 5

### Task 12: 真机诊断——拖拽与序号输入复现（先于修复代码）

**Files:**
- 只读诊断，结论记录同 Task 9

**Interfaces:**
- Produces: h1（过滤态误用）/h2（WebView2 DnD 环境）/h3（落库链）判定。

- [ ] **Step 1: debug 构建驱动**（同 Task 9 Step 1）

- [ ] **Step 2: 干净前置复现**

主窗导航 `/codes`：确认搜索框空、无标签筛选（有标签先清）、非多选模式 → ① `evaluate` 合成 DnD（对目标行 dispatchEvent 构造 `new DragEvent('dragstart'|'dragover'|'drop', {dataTransfer: new DataTransfer()})`，把手/行序列按 CodesPage.vue:239-264）→ 断言条目顺序变化且 `store.vault.entries` order 重写；② 序号路径：点击序号 span → 键入数字 → Enter → 同断言。任一在干净前置下成功而用户报告失败 → h1 成立；两步都失败看 console/持久化状态 → h2 或 h3。

- [ ] **Step 3: 结论落档**（`.temp/diag-sort.md`，含 evaluate 脚本与观测输出）

### Task 13: 分支修复 + popup 排序收敛

**Files（按诊断分支取交集，h1/h3 无论如何都做）:**
- Modify: `packages/ui/src/pages/CodesPage.vue:253-284,354-362`（h3 catch + h1 提示；h2 加 dragenter/dragleave 加固）
- Modify: `apps/extension/entrypoints/popup/App.vue:91-96`（内联 comparator → `sortEntries`）
- Modify: `packages/ui/src/i18n/locales/{zh,en}/common.json`（codesPage.sortDisabledHint，h1 路径）
- Test: `packages/ui/test/CodesPage.reorder.test.ts`

**Interfaces:**
- Consumes: `sortEntries`（`@totp/ui` index.ts:72 已导出；popup 现有 `@totp/ui` 导入不动）。
- Produces: 三宿主排序单点 `sortEntries`；过滤态禁用提示。

- [ ] **Step 1: 写失败测试（h1 提示 + h3 catch）**

`CodesPage.reorder.test.ts` 追加（沿用该文件 mountCodesPage/种子惯例）：

```ts
it('过滤态：序号 title 展示禁用提示（h1，spec §3.3）', () => {
  // 装配为带标签筛选（或搜索词）状态——沿用文件既有「过滤态禁拖」用例的前置手法
  const idx = w.find('.index-num')
  expect(idx.attributes('title')).toContain('禁用')
  expect(idx.classes()).not.toContain('clickable')
})

it('reorderOp 落库失败：console.error 留痕不抛断（h3，spec §3.3）', async () => {
  const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  // 沿用文件既有拖拽落库用例装配，令 store.reorderOp reject
  // …dispatch 拖拽事件序列…
  await flushPromises()
  expect(errSpy).toHaveBeenCalledWith('[codes] reorder failed:', expect.any(Error))
  errSpy.mockRestore()
})
```

- [ ] **Step 2: 运行确认失败** → Expected: FAIL。

- [ ] **Step 3: 实现（按诊断分支）**

h1（CodesPage.vue 354-362 与 style 443 行附近）：

```html
            <span
              v-else class="index-num" :class="{ clickable: dragEnabled }"
              :title="dragEnabled ? t('codesPage.indexEditTitle') : t('codesPage.sortDisabledHint')"
```

```css
.index-num:not(.clickable) { cursor: not-allowed; }
```

i18n：

```json
    "sortDisabledHint": "搜索/标签过滤或多选模式下已禁用排序，清除过滤后可拖拽",
```
```json
    "sortDisabledHint": "Sorting is disabled while filtering or in multi-select; clear filters to drag",
```

h2 加固（CodesPage.vue 322 行 row 事件，WebView2 事件序列加固；若诊断 h2 不成立可跳过但建议保留）：

```html
        @dragover="onDragOver($event, e.uuid)" @dragenter.prevent @drop.prevent="onDrop" @dragend="endDrag" @dragleave="onDragLeave(e.uuid)"
```

```ts
/** 拖拽指示离开即清（防指示线滞留；WebView2 dragleave 派发与浏览器存在时序差） */
function onDragLeave(uuid: string) {
  if (dragOver.value?.uuid === uuid) dragOver.value = null
}
```

h3（onDrop 253-264 与 confirmIndexMove 273-284 的落库行，两处同改）：

```ts
  if (next) {
    try { await props.store.reorderOp(next) } catch (e) { console.error('[codes] reorder failed:', e) }
  }
```

（若 h3 诊断为持久层根因，按根因另行最小修复并在 commit 说明；诊断脚本与证据贴 `.temp/diag-sort.md` 归档到 Task 14 文档。）

popup 收敛（App.vue 91-96）：删除内联 comparator，改为：

```ts
import { sortEntries } from '@totp/ui'
const sorted = computed(() => sortEntries(<现有条目数组变量>))
```

（变量名以文件实际为准；断言零变化——口径本就同构，属 R14 收尾。）

- [ ] **Step 4: 运行确认通过**

Run: `pnpm --filter @totp/ui test` + extension 包测试
Expected: 全绿；popup 若有 `@totp/ui` vi.mock 工厂（importOriginal 展开式）无需改（sortEntries 已在实际导出面）。

- [ ] **Step 5: commit 5（批 C）**

```bash
git add packages/ui/src packages/ui/test packages/ui/src/i18n/locales apps/extension/entrypoints/popup/App.vue
git commit -m "fix(ui): 管理页排序真机修复与排序口径单点收敛

why: 用户真机报告管理页拖拽与序号定位移动双双无效（spec §3，单测全绿说
明问题在真机环境：<Task 12 判定结论一句话>）；popup 排序仍是内联
comparator（R14 遗留）。
what: <按实际分支：过滤态禁用提示/拖拽事件加固/落库失败留痕/根因修复>；
popup 收敛 sortEntries 单点。"
```

---

## Task 14: e2e 真机清单 + 全量验证

**Files:**
- Create: `docs/e2e/2026-10-06-miniapp-sorting-cloud-checklist.md`

- [ ] **Step 1: 写真机清单**

按 spec 各项「验收」小节逐条成清单（含：A 的 5 条、B 的 3 条 + Task 9 诊断结论附录、C 的 3 条 + Task 12 结论附录、D 的 5 条；标注人工/可自动化）。文首按 `docs/e2e-test.md` 活文档惯例登记索引行（§4 执行记录索引追加一行）。

- [ ] **Step 2: 全量验证**

```bash
pnpm test
cd apps/desktop/src-tauri && cargo test && cargo clippy && cargo fmt --check
pnpm check:i18n   # 脚本名以根 package.json 为准
```
Expected: 全绿；覆盖率不低于既有 gate（本地抽查 `pnpm --filter @totp/core exec vitest run --coverage` 如 CI 红再补）。

- [ ] **Step 3: commit 6（e2e 文档）**

```bash
git add docs/e2e/2026-10-06-miniapp-sorting-cloud-checklist.md docs/e2e-test.md
git commit -m "docs(e2e): miniapp/排序/云备份批真机清单与诊断结论归档

why: spec 四项验收需真机执行记录载体；Task 9/12 诊断结论按活文档惯例归档。
what: 新增 2026-10-06 清单（A/B/C/D 验收逐条+诊断附录），e2e-test.md 索引登记。"
```

---

## 执行顺序与依赖

Task 1 → 2（commit 1）→ 3 → 4（commit 2）→ 5 → 6 → 7 → 8（commit 3，真机冒烟先行）→ 9（诊断）→ 10 → 11（commit 4）→ 12（诊断）→ 13（commit 5）→ 14（commit 6）。Task 9/12 必须先于对应批的修复代码；其余顺序即依赖顺序（Task 7/8 同文件顺序执行避免冲突；Task 11 依赖 Task 6 的 toggle_mini 新签名）。
