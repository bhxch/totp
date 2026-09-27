# 批次 B:遗留清理·行为缺陷批 实施计划(plan19)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复两个用户可感知的行为缺陷:远端 sync:settings 坏 JSON 会覆盖本端 settings(B10)、popup URI 导入时表单提交的 period 被静默重置为 30(B11)。

**Architecture:** 两项均为小修,核心纪律是**锚定断言连测试一起改**(缺陷行为此前被测试按现状固化),并为修复后的行为补回归用例。两项各一个原子 commit,互不依赖。

**Tech Stack:** TypeScript / Vue 3 / vitest(chrome storage mock)。

**Spec:** `docs/plans/2026-09-27-leftover-cleanup-design.md`(§4 批次 B 表 B10/B11)。执行者需同时读 spec。

## Global Constraints

- 每任务原子 commit;`git add` 只加本任务文件。
- 改锚定断言时必须在 commit 正文写明「锚定的是缺陷现状,随修复更新」。
- 定向测试命令:`pnpm --filter @totp/extension exec vitest run <file>`。

---

### Task 1: B10 远端 sync:settings 坏 JSON 不再写盘,保留本端

**Files:**
- Modify: `apps/extension/src/syncEngine.ts:116-126`(mergeRemoteSettingsKeepingLocalSyncEnabled)、`:260-264`(调用点)
- Test: `apps/extension/test/syncEngine.test.ts:588-604`(改锚定断言)+ 追加 2 个用例

**Interfaces:**
- Consumes: `ext.storage.local`(既有);`SETTINGS_KEY` 常量(同文件)。
- Produces: `mergeRemoteSettingsKeepingLocalSyncEnabled(remoteRaw: string): Promise<string | null>`——返回 `null` 表示「远端坏 JSON 且本端无 settings 键」,调用点据此跳过写 settings 键。唯一调用方是同文件 `pullOnce`(263 行),无导出消费方。

- [ ] **Step 1: 改写锚定用例为修复后期望(先红)**

`apps/extension/test/syncEngine.test.ts:588-604` 的用例「远端 settings 键为坏 JSON → merge 退化整体采用远端原串(catch 分支,实现行为锚定)」整体替换为:

```ts
  it('远端 settings 键为坏 JSON → 放弃 merge 保留本端 settings,仅 vault 更新（B10）', async () => {
    const remotePayload = JSON.stringify({ version: 2, entries: [], tags: [], updatedAt: 2 })
    const { local } = installChrome(
      {
        [VAULT_KEY]: JSON.stringify({ entries: ['old'] }),
        [SETTINGS_KEY]: JSON.stringify({ syncEnabled: true, theme: 'dark' }),
      },
      { ...remotePush(remotePayload, 2), 'sync:settings': '{broken-remote-settings' },
    )

    await pullSyncIfNewer()

    // B10:坏串不得写盘——本端 settings 原样保留,syncEnabled 不被远端坏数据波及
    expect(local.data[SETTINGS_KEY]).toBe(JSON.stringify({ syncEnabled: true, theme: 'dark' }))
    expect(local.data[VAULT_KEY]).toBe(remotePayload)
  })

  it('远端 settings 坏 JSON 且本端无 settings 键 → 不写入 settings 键（B10）', async () => {
    const remotePayload = JSON.stringify({ version: 2, entries: [], tags: [], updatedAt: 2 })
    const { local } = installChrome(
      { [VAULT_KEY]: JSON.stringify({ entries: ['old'] }) },
      { ...remotePush(remotePayload, 2), 'sync:settings': '{broken' },
    )

    await pullSyncIfNewer()

    expect(local.data[SETTINGS_KEY]).toBeUndefined()
    expect(local.data[VAULT_KEY]).toBe(remotePayload)
  })

  it('远端 settings 合法但本端 settings 读失败 → merge 仍产出,开关位按 false（原 catch 降级语义收窄后）', async () => {
    const remotePayload = JSON.stringify({ version: 2, entries: [], tags: [], updatedAt: 2 })
    const remoteSettings = JSON.stringify({ syncEnabled: true, theme: 'light' })
    const { local } = installChrome(
      { [VAULT_KEY]: JSON.stringify({ entries: ['old'] }) },
      { ...remotePush(remotePayload, 2), 'sync:settings': remoteSettings },
    )
    // 本端 storage.local.get 抛错:开关位保留语义等价 false(函数头注释既有口径),其余字段整体采用远端
    vi.spyOn(chrome.storage.local, 'get').mockRejectedValueOnce(new Error('quota'))

    await pullSyncIfNewer()

    expect(JSON.parse(local.data[SETTINGS_KEY] as string)).toEqual({ syncEnabled: false, theme: 'light' })
    expect(local.data[VAULT_KEY]).toBe(remotePayload)
  })
```

(第三个用例中 chrome mock 的 spy 写法若与该测试文件既有 `installChrome` 替身不兼容,改用该文件既有的错误注入手段——读文件头 mock 说明后对齐,断言不变。)

- [ ] **Step 2: 跑测试确认新期望失败**

Run: `pnpm --filter @totp/extension exec vitest run test/syncEngine.test.ts -t "B10"`
Expected: 前两个用例 FAIL(现状把坏串写盘)、第三个 FAIL(现状 catch 整体采用远端原串)。

- [ ] **Step 3: 实现修复**

`syncEngine.ts:116-126` 整函数替换:

```ts
/** 远端 settings 整体采用，但 syncEnabled 位保留本端值（缺失/损坏时保留语义等价于 false）。
 *  B10：远端坏 JSON 时放弃 merge、保留本端原样（本端无 settings 键 → null，调用点跳过写 settings）——
 *  坏串不得落盘替换本端 settings。本端读失败/损坏仅影响开关位（按 false），不影响其余字段采用远端 */
async function mergeRemoteSettingsKeepingLocalSyncEnabled(remoteRaw: string): Promise<string | null> {
  let remote: Record<string, unknown>
  try {
    remote = JSON.parse(remoteRaw) as Record<string, unknown>
  } catch {
    const localRaw = (await ext!.storage.local.get([SETTINGS_KEY]))[SETTINGS_KEY]
    return typeof localRaw === 'string' ? localRaw : null
  }
  let localEnabled = false
  try {
    const localRaw = (await ext!.storage.local.get([SETTINGS_KEY]))[SETTINGS_KEY]
    localEnabled = typeof localRaw === 'string' && (JSON.parse(localRaw) as Record<string, unknown>).syncEnabled === true
  } catch { /* 本端读失败/损坏：开关位按 false（「缺失/损坏保留等价 false」既有口径） */ }
  return JSON.stringify({ ...remote, syncEnabled: localEnabled })
}
```

`syncEngine.ts:260-264` 调用点改为:

```ts
    if (typeof syncAll[SETTINGS_SYNC_KEY] === 'string') {
      // 保留本端 syncEnabled 位：同步开关是每设备显式意志，远端 settings 整体采用但开关位不跟随
      // （否则 B 关闭同步后 A 的推送会把 B 重新拉开）。B10：远端坏 JSON 返回 null → 不写 settings 键
      const merged = await mergeRemoteSettingsKeepingLocalSyncEnabled(syncAll[SETTINGS_SYNC_KEY])
      if (merged !== null) batch[SETTINGS_KEY] = merged
    }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @totp/extension exec vitest run test/syncEngine.test.ts`
Expected: PASS(全文件含 :343-364 合法路径用例「远端较新:应用合法 payload 并保留本端 syncEnabled 位」不回归——该用例断言 `syncEnabled: true` 保留,新实现 localEnabled 路径语义一致)。

- [ ] **Step 5: 包级 typecheck + 全量**

Run: `pnpm --filter @totp/extension exec vue-tsc --noEmit && pnpm --filter @totp/extension test`
Expected: 全绿(280 例)。

- [ ] **Step 6: Commit**

```bash
git add apps/extension/src/syncEngine.ts apps/extension/test/syncEngine.test.ts
git commit -m "fix(extension): 远端 sync:settings 坏 JSON 不再覆盖本端 settings(B10)(batch B)

why: mergeRemoteSettings 的 catch 把解析失败的远端原串返回并由 pullOnce
整体采用写盘,本端 settings 被坏串替换(数据破坏);该缺陷行为此前被测试
按现状锚定(syncEngine.test.ts:588)。
what: catch 语义收窄——远端坏 JSON 放弃 merge 保留本端(无本端键则跳过
写入);本端读失败仅开关位按 false,其余字段照常采用远端。锚定断言随修复
更新,补坏 JSON/无本端键/读失败三个用例。"
```

---

### Task 2: B11 popup onSave period 尊重表单提交值

**Files:**
- Modify: `apps/extension/entrypoints/popup/App.vue:298`
- Test: `apps/extension/test/popupApp.test.ts:820-857`(用例二断言更新;用例一不变)

**Interfaces:** 无跨文件接口;`addEntryOp` 输入 `period` 字段取值链变化:`carried?.period ?? data.period ?? 30`。

- [ ] **Step 1: 更新锚定断言(先红)**

`popupApp.test.ts:838-857` 用例「URI 导入 type 变更(hotp→totp):carried 失效,counter 不透传,digits 按表单收口」中,末两行:

```ts
    // 现状锚定：carried=null 时 period 恒 30（`period: carried?.period ?? 30` 覆盖 ...data 的表单值）
    expect(entry.period).toBe(30)   // ← 855-856 行锚定；修复后应改为 toBe(45)
```

替换为:

```ts
    // B11 修复：carried=null 时 period 取表单提交值，不再被 30 覆盖
    expect(entry.period).toBe(45)
```

用例一(:820-836,carried 同 type 透传 `expect(entry.period).toBe(30)`)不变——carried.period=30 本就正确。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @totp/extension exec vitest run test/popupApp.test.ts -t "type 变更"`
Expected: FAIL(现状 `entry.period` 为 30,期望 45)。

- [ ] **Step 3: 一行修复**

`App.vue:298`:

```ts
      period: carried?.period ?? 30,
```

改为:

```ts
      period: carried?.period ?? data.period ?? 30,
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @totp/extension exec vitest run test/popupApp.test.ts`
Expected: PASS(全文件;用例一 30 透传不受影响)。

- [ ] **Step 5: Commit**

```bash
git add apps/extension/entrypoints/popup/App.vue apps/extension/test/popupApp.test.ts
git commit -m "fix(extension): popup URI 导入 carried 失效时 period 取表单提交值(B11)(batch B)

why: `period: carried?.period ?? 30` 在 type 变使 carried 失效时恒落 30,
覆盖表单提交值(编辑同路径同害);digits 已同口径收口而 period 漏改。
锚定断言按缺陷现状固化(popupApp.test.ts:855)。
what: 补 `?? data.period ?? 30` 一行,锚定断言随修复更新为 45。"
```

---

## 批次收尾

- [ ] 全仓门禁:`pnpm typecheck && pnpm -r --no-bail run test`,全绿后批次 B 完成。
