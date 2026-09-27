# 批次 D:遗留清理·功能批(含 4 项用户裁定实施)计划(plan21)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实施四项用户裁定(foxauth 免输入、lockOnRestart 置灰说明、gdrive 隐藏 keep 配置、D3 挂账无代码)与七项功能增强/文案/告警任务(F4-F11)。

**Architecture:** F1 改 core 导入链与 ImportCard 口令页路由;F2 把 lockOnRestart 从「隐藏」改为「置灰+角标」(lockOnSystemLock 维持隐藏);F3/F4 为 CloudCard 条件渲染与提示;F6 为 CloudBackend 截断感知(listBackupsEx)与保留清理告警;F7-F11 为小项。每任务独立可合入,任务内先改测试再改实现。

**Tech Stack:** TypeScript / Vue 3 / vitest / Rust(tauri command)。

**Spec:** `docs/plans/2026-09-27-leftover-cleanup-design.md`(§1 裁定表 D1-D4、§5 功能批 F1-F11)。执行者需同时读 spec。

## Global Constraints

- 每任务原子 commit;`git add` 只加本任务文件。
- 涉 Rust 任务(F8)定向跑 `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml <过滤>`;批次收尾跑全量门禁(含 cargo 三件套)。
- i18n 键 zh/en 同步;README 已知限制的对应行在本批各任务内同步更正(②→F3、⑥→F6)。
- 定向测试:core/ui/extension/desktop vitest 按包 `pnpm --filter <pkg> exec vitest run <file>`。
- D3 裁定(挂账)无代码任务;F9/F11 经研究员核实已部分/全部由既有代码覆盖,任务为复核+登记划线。

---

### Task 1: F1a foxauth 免输入——core 导入链

**Files:**
- Modify: `packages/core/src/import/jsonApps.ts:305-351`(importFoxauth)
- Modify: `packages/core/src/import/registry.ts:241-247`(foxauth 条目删 needsPassword)
- Modify: `packages/core/src/import/paste.ts`(:31 needsPasswordFor 拦截对 foxauth 自然失效,无需改代码——验证)
- Test: `packages/core/test/foxauth.test.ts`(:53 用例改写、:145/:152/:281/:288 调整)、`packages/core/test/importNeedsPassword.test.ts:27-29`、`packages/core/test/importPaste.test.ts:30`

**Interfaces:**
- Produces: `importFoxauth(text: string): Promise<ImportResult>`——**删除 password 参数**(registry descriptor `parse` 统一签名按 `(text)` 对齐;ui 侧 Task 2 消费)。加密分支解密口令恒取文件内 `passwordInfo.encryptPassword`;删「需要口令」守卫与「pwd !== password」比对(裁定 D1:口令 Base64 明文可还原,比对属伪安全)。
- 保留:encryptPassword 缺失/非法 Base64/encryptIV 非法/密文篡改(GCM 失败)等结构级与解密级错误路径不动。

- [ ] **Step 1: 改写测试为先红**

`foxauth.test.ts` 改动清单:
1. `:53` 用例「加密备份未给口令:明确报错(需要口令)」替换为「加密备份免口令直接解密导入(D1)」——用该文件既有合法加密 fixture,调用 `importFoxauth(text)`(无第二参),断言导入成功、条目数与字段同 `:145` 用例的期望;
2. `:145` 用例「正确口令解密导入」改为不传口令 `importFoxauth(text)`,断言不变(解密口令取自文件);
3. `:152` 用例「错误口令」**删除**(不再有用户口令比对路径;密文篡改由 :156 覆盖);
4. `:281`/`:288` 非 ASCII 口令用例:改为断言「encryptPassword 含 U+0080–U+00FF 的 latin1 视图经 UTF-8 TextDecoder 还原正确」——即用非 ASCII 口令的导出 fixture,`importFoxauth(text)` 免输入直接解密成功,条目 secret 与明文 fixture 一致;
5. `importNeedsPassword.test.ts:27-29` foxauth 两态断言:改为「明文/加密均 false」(加密 foxauth 不再进口令页);
6. `importPaste.test.ts:30` 用例「foxauth 加密→提示走导入页」改为「foxauth 加密→免口令直接解析确认」。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @totp/core exec vitest run test/foxauth.test.ts test/importNeedsPassword.test.ts test/importPaste.test.ts`
Expected: 上述改写用例 FAIL(现状无口令即抛「需要口令」)。

- [ ] **Step 3: 实现**

`jsonApps.ts:305-351` 改(仅列改动段;collectFoxauthRows/decryptFoxauth/parseFoxauthPlaintextObject 不动):

```ts
export async function importFoxauth(text: string): Promise<ImportResult> {
  const obj = parseJsonObject(text, 'FoxAuth')
  // 加密判定先于 accountInfos 形态检查:加密但缺口令数据时应报「备份不含口令」而非「缺少 accountInfos」
  const encrypted = obj.isEncrypted === true
  if (encrypted) {
    const pwdInfo = asObject(obj.passwordInfo)
    if (!pwdInfo) throw new Error('FoxAuth 文件结构非法：加密备份缺少 passwordInfo')
    const b64pwd = pwdInfo.encryptPassword
    if (typeof b64pwd !== 'string' || b64pwd === '') {
      // FoxAuth 官方支持口令仅存 sessionStorage（此时文件只有 encryptIV，结构合法）——提示而非结构错误
      throw new Error('FoxAuth 备份不包含口令（导出时口令可能保存在浏览器会话中），无法解密')
    }
    let pwd: string
    try {
      // encryptPassword = Base64(UTF-8(口令))（FoxAuth import.js base64Decode = new TextDecoder().decode，
      // UTF-8 语义）。atob 直接得到的字符串是 UTF-8 字节的 latin1 视图，含 U+0080–U+00FF 的口令
      // （如 é/ü）必须先经 UTF-8 TextDecoder 还原明文再作解密密钥。
      pwd = new TextDecoder().decode(Uint8Array.from(atob(b64pwd), (c) => c.charCodeAt(0)))
    } catch {
      throw new Error('FoxAuth 文件结构非法：passwordInfo.encryptPassword 不是合法 Base64')
    }
    // D1 裁定（2026-09-27）：取消用户口令比对——官方导出口令 Base64 同存于 encryptPassword，
    // 本就是解密口令（FoxAuth 自身导入亦从文件还原口令，不向用户询问）；比对属伪安全（口令可还原）。
    // 解密失败（密文篡改/损坏）由 GCM 层报错，见下方 decryptFoxauth。
    const iv = pwdInfo.encryptIV
    if (!Array.isArray(iv) || iv.length !== 12 || iv.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      throw new Error('FoxAuth 文件结构非法：加密备份缺少合法的 passwordInfo.encryptIV（12 字节数组）')
    }
    return collectFoxauthRows(await decryptFoxauth(obj.accountInfos, pwd, iv))
  }
  return parseFoxauthPlaintextObject(obj)
}
```

`registry.ts:241-247` foxauth 条目删 `needsPassword: sniffFoxauthEncrypted,` 行(连同行上注释「两态…」改为「明文/加密均免口令直接解析(D1):解密口令取自文件内 encryptPassword」);`sniffFoxauthEncrypted`/`sniffFoxauthEncryptedObject`(:178-180/:58-60)若无其余消费(先 `rg -n sniffFoxauthEncrypted packages/core/src packages/ui/src` 核实,paste.ts :31-36 的 needsPasswordFor 拦截经注册表自然失效)则一并删除。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @totp/core typecheck && pnpm --filter @totp/core test`
Expected: core 全量绿;`importSniffOrder` 快照不涉 needsPassword 不受影响。

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/import/jsonApps.ts packages/core/src/import/registry.ts packages/core/test/foxauth.test.ts packages/core/test/importNeedsPassword.test.ts packages/core/test/importPaste.test.ts
git commit -m "feat(core): foxauth 导入免口令,解密口令取自文件内 encryptPassword(F1a/D1)(batch D)

why: 用户裁定 D1——口令 Base64 可还原地存于备份文件,输入口令仅比对
不参与解密,属伪安全误导;官方体验为免输入。
what: 删 password 参数/需要口令守卫/口令比对,加密分支直接以文件内口令
经 UTF-8 TextDecoder 还原解密;注册表删 needsPassword 谓词(口令页不再
拦截),错误路径(缺 encryptPassword/非法 Base64/IV 非法/GCM 篡改)全保留。"
```

---

### Task 2: F1b foxauth 免输入——ImportCard 口令页路由收口

**Files:**
- Modify: `packages/ui/src/components/ImportCard.vue:525-533,573-577`(:415 TEXT_PARSERS 不动)
- Modify: `packages/ui/src/i18n/locales/{zh,en}/common.json`(删 foxauthPwHint,zh:472)
- Test: 既有 `packages/ui/test/ImportCard*.test.ts` 兜底;如 foxauth 路由有用例则同步(研究员核实 ImportCard.test 无 foxauth 专项用例)

**Interfaces:**
- Consumes: Task 1 的 `importFoxauth(text)`(单参);`needsPasswordFor('foxauth', …)` 恒 false。
- Produces: ImportCard 对 foxauth 不再进入口令页;口令页仅剩 aegis(无条件)与 totpAuthenticator(条件)。

- [ ] **Step 1: 改条件口令页拦截与口令页分支**

`:525-533` 改:

```ts
  // 条件口令页入口(两态格式,判定由 core 注册表 needsPassword 内容谓词派生,R5):
  // totpAuthenticator 外部分享为 Base64 密文(非 '[' 明文数组)→ 口令页;foxauth 已免口令
  // (D1,解密口令取自文件),不再拦截;两态明文保持下方分派表直接解析
  if (f === 'totpAuthenticator' && needsPasswordFor(f, fileText.value)) {
    passwordHint.value = t('importCard.totpAuthPwHint')
    step.value = 'password'
    return
  }
  await parseAndConfirm(TEXT_PARSERS[f])
```

`:573-577` 口令页 foxauth 分支删除:

```ts
  if (f === 'foxauth') {
    if (!password.value) return fail(new Error(t('importCard.passphraseRequired')))
    await parseAndConfirm(() => importFoxauth(fileText.value, password.value))
    return
  }
```

(连带检查 `importFoxauth` 在 :4 的导入是否仍被 :415 `registryParse('foxauth')` 之外的路径使用——TEXT_PARSERS 走注册表统一签名,若 importFoxauth 直接导入不再被引用则从导入清单删除。)

- [ ] **Step 2: 删 i18n 键**

zh `:472` `"foxauthPwHint": "该 FoxAuth 备份已加密，请输入导出口令",` 与 en 对应行删除(先 rg 取精确行号)。

- [ ] **Step 3: 验证**

Run: `pnpm --filter @totp/ui typecheck && pnpm --filter @totp/ui test`
Expected: 全绿(1062 例)。

- [ ] **Step 4: Commit**

```bash
git add packages/ui/src/components/ImportCard.vue packages/ui/src/i18n/locales/zh/common.json packages/ui/src/i18n/locales/en/common.json
git commit -m "feat(ui): ImportCard 对 foxauth 不再进入口令页(F1b/D1)(batch D)

why: F1a 后 foxauth 加密备份免口令解析,口令页拦截与输入分支成为死路径。
what: 条件口令页拦截收窄为 totpAuthenticator,删 foxauth 分支与
foxauthPwHint 键(zh/en)。"
```

---

### Task 3: F2 lockOnRestart 隐藏改置灰+角标说明

**Files:**
- Modify: `packages/ui/src/components/SecurityCard.vue:320-328`(模板)、`:86` 附近(computed 不变)
- Modify: `packages/ui/src/components/md/MdSwitch.vue` 不动(已有 disabled prop)
- Modify: `packages/ui/src/i18n/locales/{zh,en}/common.json`(securityCard 段新增 lockOnRestartDisabledHint)
- Modify: `packages/ui/src/host/securityOps.ts:19-20,34-35`(注释与契约说明)
- Modify: `apps/desktop/src/lockPrefs.ts:1-15`(注释措辞)
- Test: `packages/ui/test/securityCard.plan16.test.ts:224-237`(用例改写)

**Interfaces:**
- Produces: SecurityCard 对 `unsupported` 含 `lockOnRestart` 的端渲染**置灰开关+禁用说明**(不再 v-if 隐藏);`lockPrefsUnsupported` 契约语义更新为「该键置灰禁用」(lockOnSystemLock 例外,仍隐藏——见模板注释)。
- i18n 新键:`securityCard.lockOnRestartDisabledHint`。

- [ ] **Step 1: 改写测试为先红**

`securityCard.plan16.test.ts:224` 用例「unsupported 声明 lockOnRestart(审查 Minor:ext 无效果开关)→ 隐藏该控件,其余两控件照常渲染与写回」替换为:

```ts
  it('unsupported 声明 lockOnRestart → 置灰禁用+角标说明(D2),其余两控件照常渲染与写回', async () => {
    // ...(沿用原用例的 platform 装配:lockPrefs.unsupported = ['lockOnRestart'])
    expect(w.find('.lock-restart input').attributes('disabled')).toBeDefined()
    expect(w.find('.lock-restart').exists()).toBe(true)
    expect(w.text()).toContain('当前版本重启后均会锁定')
    // 置灰下切换不写回:disabled input 不触发 change
    await w.find('.lock-restart input').setValue(true)
    expect(lp.api.set).not.toHaveBeenCalled()
    // 其余两控件照常
    expect(w.find('.idle-min').exists()).toBe(true)
    expect(w.find('.lock-syslock').exists()).toBe(true)
  })
```

(原用例 :226-236 的装配代码保留;删除断言 `expect(w.find('.lock-restart').exists()).toBe(false)` 与「文本不含重启后保持锁定」。)

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @totp/ui exec vitest run test/securityCard.plan16.test.ts -t "置灰"`
Expected: FAIL(现状控件不存在)。

- [ ] **Step 3: 改模板与 i18n**

`SecurityCard.vue:320-328` 的 lockOnRestart 分支改为(lockOnSystemLock 的 v-if 隐藏**不动**):

```html
        <!-- 重启后保持锁定:两端均无会话级凭据存储(桌面无会话 DEK;扩展 DEK 存 session 浏览器退出即清,
             见 host/securityOps.ts 注释),D2 裁定置灰+角标说明保留入口,预示未来支持会话保持的端;
             系统锁屏开关维持「平台不支持即隐藏」语义(v-if,真平台缺失) -->
        <div class="opt" :class="{ 'opt--unsupported': unsupportedLockPrefs.has('lockOnRestart') }">
          <MdSwitch
            class="lock-restart" :model-value="lockPrefsState.lockOnRestart"
            :disabled="unsupportedLockPrefs.has('lockOnRestart')" :aria-label="t('securityCard.lockOnRestart')"
            @update:model-value="(v: boolean) => onLockPrefChange({ lockOnRestart: v })"
          />
          <span>{{ t('securityCard.lockOnRestart') }}</span>
          <span class="opt-hint">{{ unsupportedLockPrefs.has('lockOnRestart') ? t('securityCard.lockOnRestartDisabledHint') : t('securityCard.lockOnRestartHint') }}</span>
        </div>
```

securityCard scoped style 追加:

```css
.opt--unsupported { opacity: 0.55; }
```

zh(en 对应英文)新增键(securityCard 段内,lockOnRestartHint 旁):

```json
      "lockOnRestartDisabledHint": "当前版本重启后均会锁定：桌面端无会话级凭据存储；扩展端凭据仅存会话，浏览器退出即清",
```

- [ ] **Step 4: 更新契约注释**

`securityOps.ts:19-20` 注释改:`lockPrefsUnsupported:ext=['lockOnRestart'](D2 裁定置灰+角标,不再隐藏;lockOnSystemLock 仍隐藏)/ desktop=lockPrefsUnsupportedKeys(ua)(系统锁事件源仅 Windows)`;`:34-35` 参数注释「SecurityCard 隐藏对应控件防无效设置」改「SecurityCard 置灰禁用对应控件(lockOnRestart)或隐藏(lockOnSystemLock)防无效设置」。`lockPrefs.ts:1-15` 注释中两处「隐藏防无效设置」同步改「置灰防无效设置」(lockOnSystemLock 处保留隐藏措辞)。两端 overrides 传值(optionsPlatforms.ts:173 / securityPlatform.ts:105)**不变**。

- [ ] **Step 5: 验证 + README④ 更正**

Run: `pnpm --filter @totp/ui exec vitest run test/securityCard.plan16.test.ts test/SecurityCard.test.ts && pnpm --filter @totp/desktop exec vitest run src/securityPlatform.test.ts src/lockPrefs.test.ts && pnpm --filter @totp/ui test`
Expected: 全绿。

README `:362` 行替换为:

```markdown
- **「重启后保持锁定」开关当前在桌面/扩展两端均置灰禁用**（两端均无会话级凭据存储：桌面重启后必为锁定态；扩展端凭据仅存会话，浏览器退出即清）；mac/Linux 的「系统锁屏时锁定」触发器不可用（挂账）
```

- [ ] **Step 6: Commit**

```bash
git add packages/ui/src/components/SecurityCard.vue packages/ui/src/i18n/locales/zh/common.json packages/ui/src/i18n/locales/en/common.json packages/ui/src/host/securityOps.ts apps/desktop/src/lockPrefs.ts README.md
git commit -m "feat(ui): lockOnRestart 从隐藏改为置灰+角标说明(F2/D2 裁定)(batch D)

why: 用户裁定 D2 保留开关入口预示未来会话级 DEK 支持;现状 v-if 隐藏
(审查 I10)改为 disabled+说明,空转风险由角标文案消除。
what: SecurityCard lockOnRestart 分支改 disabled+opt--unsupported 角标
(lockOnSystemLock 隐藏语义不变),新增 DisabledHint 键,契约注释与
README 已知限制④同步更正。"
```

---

### Task 4: F3 gdrive 源隐藏 keep 配置 + README②

**Files:**
- Modify: `packages/ui/src/components/CloudCard.vue:630-640`(retention-row 模板)
- Test: `packages/ui/test/cloudCard.sources.test.ts`(追加 gdrive 用例)
- Modify: `README.md:360`

**Interfaces:** 无新接口;`s.kind`(SourceKind)既有字段驱动条件渲染。

- [ ] **Step 1: 追加失败测试**

`cloudCard.sources.test.ts` 追加(仿 :157 S3 用例的装配手段,gdrive 源构造参照该文件既有源行工厂):

```ts
  it('gdrive 源不渲染保留策略配置(D4:该后端 keep 等价覆盖,隐藏防误配)', async () => {
    // ...以 gdrive kind 装配一条启用源,打开卡
    expect(w.find('.retention-row').exists()).toBe(false)
    // 非 gdrive 源不受影响(既有 S3 用例覆盖 webdav/s3 路径)
  })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @totp/ui exec vitest run test/cloudCard.sources.test.ts -t "gdrive"`
Expected: FAIL(现状 retention-row 恒渲染)。

- [ ] **Step 3: 改模板**

`CloudCard.vue:630-640` 的 `.retention-row` 外层加条件:

```html
          <!-- F3/D4:gdrive 后端时间戳文件名不生效,keep 等价覆盖——隐藏保留策略配置消歧义
               (README 已知限制②;多对象保留挂账) -->
          <div v-if="s.kind !== 'gdrive'" class="retention-row">
```

(内部两控件不变;`:210-212` onRetentionType/onKeepN 逻辑不动——gdrive 行不再触发。)

- [ ] **Step 4: README② 更正并验证**

`README.md:360` 替换为:

```markdown
- **Google Drive 源仅保留 1 份远端对象**（时间戳文件名对 gdrive 不生效，后端按名覆盖；keep 配置对该后端已隐藏）
```

Run: `pnpm --filter @totp/ui test`
Expected: 全绿。

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/components/CloudCard.vue packages/ui/test/cloudCard.sources.test.ts README.md
git commit -m "feat(ui): gdrive 源隐藏 keep 份数配置(F3/D4 裁定)(batch D)

why: 用户裁定 D4——gdrive 后端 keep 实际等价覆盖(远端单对象),暴露
半效配置误导用户;隐藏即消歧义,多对象保留挂账。
what: retention-row 加 s.kind!=='gdrive' 条件;README 已知限制②同步
更正为如实描述。"
```

---

### Task 5: F4 手动同步按钮 tooltip

**Files:**
- Modify: `packages/ui/src/components/CloudCard.vue:666`
- Modify: `packages/ui/src/i18n/locales/{zh,en}/common.json`(cloudCard 段新增 syncNowHint)

**Interfaces:** 无;`:298` 既有 autoHint 键风格参照。

- [ ] **Step 1: 改按钮与文案**

`CloudCard.vue:666`:

```html
      <MdButton class="cloud-sync" :disabled="busy || !sessionSecret || confirmPending" :title="t('cloudCard.syncNowHint')" @click="onSync">{{ t('cloudCard.syncNow') }}</MdButton>
```

zh 新增键(`:298` autoHint 旁):`"syncNowHint": "手动同步始终完整推拉（即使内容无变化也会重写云端）；自动轮才有内容门",`。en 对应英文。

- [ ] **Step 2: 验证 + Commit**

Run: `pnpm --filter @totp/ui test`

```bash
git add packages/ui/src/components/CloudCard.vue packages/ui/src/i18n/locales/zh/common.json packages/ui/src/i18n/locales/en/common.json
git commit -m "feat(ui): 手动同步按钮补「始终完整推拉」提示(F4)(batch D)

why: 手动通道不设内容门是有意设计(README 已知限制①),但用户不可见。
what: 按钮 title 提示;README ① 行语义不变不动。"
```

---

### Task 6: F5 Firefox 剪贴板说明(host 注入文案)

**Files:**
- Modify: `packages/ui/src/host/securityOps.ts`(SecurityOpsOverrides 增 `clipboardNote?: string`,装配透传)
- Modify: `packages/ui/src/components/SecurityCard.vue:348-354`(clipboardHint 处按 `platform.clipboardNote` 切换)
- Modify: `apps/extension/src/optionsPlatforms.ts`(createSecurityOpsFromStore overrides:`canOffscreen()` 为 false 时传 Firefox 文案)
- Modify: `packages/ui/src/i18n/locales/{zh,en}/common.json`(securityCard 新增 clipboardHintFirefox)
- Test: `packages/ui/test/securityCard.plan16.test.ts` 追加用例

**Interfaces:**
- Consumes: `canOffscreen()`(`apps/extension/src/extApi.ts:10-12`,Firefox 无 offscreen API 恒 false)。
- Produces: `SecurityPlatform` 增可选只读成员 `clipboardNote?: string`(host 工厂经 overrides 透传;desktop 不传,UI 走默认 hint 键)。

- [ ] **Step 1: 追加失败测试**

`securityCard.plan16.test.ts` 追加:

```ts
  it('clipboardNote 注入时剪贴板说明切换为宿主文案(F5:Firefox 无 offscreen)', async () => {
    // platform.security 正常装配 + platform.clipboardNote = 'FIREFOX_NOTE'
    expect(w.text()).toContain('FIREFOX_NOTE')
    expect(w.text()).not.toContain(默认 hint 文案片段)
  })
```

- [ ] **Step 2: 实现**

`securityOps.ts` overrides 增:

```ts
  /** 剪贴板自动清空说明覆写(F5):Firefox 无 offscreen API,清空承诺不可用——
   *  宿主探测后注入降级文案;缺省用 securityCard.clipboardHint 默认键 */
  clipboardNote?: string
```

装配段(SecurityPlatform 返回对象)透传:`clipboardNote: o.clipboardNote`。`SecurityCard.vue:348-354` 的 `<span class="opt-hint">` 改:

```html
      <span class="opt-hint">{{ platform.clipboardNote ?? t('securityCard.clipboardHint') }}</span>
```

(需确认 SecurityCard 的 platform props 类型已含该可选成员——SecurityPlatform 接口在 `packages/ui/src/components/securityPlatform.ts` 或同目录,加 `readonly clipboardNote?: string`。)

`optionsPlatforms.ts` 的 `createSecurityOpsFromStore(store, {...})` overrides 追加:

```ts
    // F5:Firefox 无 offscreen API,30s 自动清空承诺不可用(E5 行为可预期)——注入降级说明
    ...(canOffscreen() ? {} : { clipboardNote: t('securityCard.clipboardHintFirefox') }),
```

(注意该函数当前无 t 依赖——若 createOptionsSecurityPlatform 无取词通道,把文案改为预置中文/由调用方传入,或经 store 的 i18n;以最小侵入为准:overrides 传 `canOffscreen() ? undefined : 'firefox'` 哨兵、SecurityCard 按 `clipboardNote === 'firefox'` 选键亦可,执行时取更简方案并保持测试对齐。)

i18n 新键(zh):`"clipboardHintFirefox": "当前浏览器(Firefox)无 offscreen 能力,复制后不会自动清空,请手动清理",`。

- [ ] **Step 3: 验证 + Commit**

Run: `pnpm --filter @totp/ui test && pnpm --filter @totp/extension test`

```bash
git add packages/ui/src/host/securityOps.ts packages/ui/src/components/SecurityCard.vue packages/ui/src/components/securityPlatform.ts apps/extension/src/optionsPlatforms.ts packages/ui/src/i18n/locales/zh/common.json packages/ui/src/i18n/locales/en/common.json packages/ui/test/securityCard.plan16.test.ts
git commit -m "feat(ui): Firefox 下剪贴板自动清空说明降级提示(F5)(batch D)

why: 平台硬限制(无 offscreen),E5 手测确认行为可预期但用户无感知,
复制后不清空易被当缺陷。
what: SecurityPlatform 增 clipboardNote 可选成员,extension 端探测
canOffscreen() 为 false 时注入 Firefox 降级文案,desktop 不传走默认。"
```

---

### Task 7: F6 云端滚动删除截断感知与告警

**Files:**
- Modify: `packages/core/src/cloud/backend.ts:6-17`(接口增 listBackupsEx)
- Modify: `packages/core/src/cloud/{s3,gdrive,onedrive}.ts`(listBackups 改造/新增 Ex 实现,达 10 页上限仍有续页时 complete=false)
- Modify: `packages/core/src/cloud/retention.ts:9-27`(enforceRemoteRetention 返回 `{deleted, truncated}`,优先 Ex)
- Modify: `packages/ui/src/components/cloudSyncShared.ts:85-99`(runKeepRetention 透传 truncated)
- Modify: `packages/ui/src/components/CloudCard.vue:459-469`(状态文案附 truncated 提示)
- Modify: `packages/ui/src/i18n/locales/{zh,en}/common.json`(cloudCard 新增 retentionTruncated)
- Test: `packages/core/test/` cloudSync/retention 相关、`packages/ui/test/cloudRunner.test.ts`(:230 S5 组)与 `cloudCard.sources.test.ts`(:230/:256/:279 S5 组)同步
- Modify: `README.md:364`

**Interfaces:**
- Produces: `CloudBackend.listBackupsEx?(): Promise<{ names: string[]; complete: boolean }>`;`enforceRemoteRetention(backend, keep): Promise<{ deleted: number; truncated: boolean }>`(**签名变更**,消费方 cloudSyncShared 与 CloudCard 同步;`deleted === -1` 仍表示后端不支持,语义不变)。webdav/gist 无 Ex 实现 → 走 `listBackups` 回退,`truncated` 恒 false。

- [ ] **Step 1: core 测试先行(先红)**

在 core 测试(retention/enforceRemoteRetention 现有测试文件,rg 定位)追加:

```ts
  it('listBackupsEx 报 complete=false → outcome.truncated 为 true(F6)', async () => {
    const backend: CloudBackend = { ...最小合法 backend,
      listBackupsEx: async () => ({ names: ['vault-1.totpbackup', 'vault-2.totpbackup'], complete: false }) }
    const r = await enforceRemoteRetention(backend, 1)
    expect(r.truncated).toBe(true)
  })
  it('仅 listBackups 的后端 → truncated 恒 false(回退兼容)', async () => {
    const backend: CloudBackend = { ...最小合法 backend, listBackups: async () => [] }
    const r = await enforceRemoteRetention(backend, 3)
    expect(r.truncated).toBe(false)
  })
```

- [ ] **Step 2: 实现 core**

`backend.ts` 接口在 `listBackups?` 后追加:

```ts
  /** [可选] listBackups 的截断感知版(F6):complete=false 表示分页达上限仍有更多对象,
   *  滚动删除可能不完整——UI 据此提示手动清理。实现方:三聚合后端(s3/gdrive/onedrive) */
  listBackupsEx?(): Promise<{ names: string[]; complete: boolean }>
```

`retention.ts:9-27` 改:

```ts
export interface RetentionOutcome {
  /** 实际删除份数;-1=后端不支持 listBackups(既有语义) */
  deleted: number
  /** F6:名单来自截断分页,滚动删除可能不完整(UI 据此告警) */
  truncated: boolean
}

export async function enforceRemoteRetention(backend: CloudBackend, keep: number): Promise<RetentionOutcome> {
  if (!backend.listBackupsEx && !backend.listBackups) return { deleted: -1, truncated: false }
  if (!Number.isInteger(keep) || keep < 1) return { deleted: 0, truncated: false }
  const listed = backend.listBackupsEx
    ? await backend.listBackupsEx()
    : { names: await backend.listBackups!(), complete: true }
  // (原 originalByBasename/stale/删除循环逐字保留,末尾返回:)
  return { deleted, truncated: !listed.complete }
}
```

三后端:在各自现有分页聚合循环(s3.ts:184-202 / gdrive.ts:171-190 / onedrive.ts:65-77)把 `listBackups` 主体改为内部聚合函数并在达到 `page < 10` 上限**且仍有续页 token** 时 `complete: false`:
- s3:`complete: token === null`(token 为第 10 页解析出的 NextContinuationToken,非 null 即截断);
- gdrive:`complete: !pageToken`(:189-190 既有容错保留);
- onedrive:`complete: url === null`。
各自导出 `listBackupsEx` 实现,`listBackups` 保留为 `listBackupsEx` 的薄包装(既有消费方兼容)。

- [ ] **Step 3: UI 透传与文案**

`cloudSyncShared.ts:85-99` 的 `runKeepRetention`:`const r = await enforceRemoteRetention(...)`,`onDeleted(res.key, r.deleted)` 改签名携带截断——`onDeleted(res.key, r)`(宿主回调形态同步:`packages/ui/src/host/cloudRunner.ts` 对应回调类型注释更新);`CloudCard.vue:459-469` 手动通道状态行:`deleted === -1` → `retentionUnsupported`(不变);`truncated === true` → 附加 `t('cloudCard.retentionTruncated')`(zh:「(对象数超出分页上限,滚动删除可能不完整,请手动清理)」)。

- [ ] **Step 4: 测试同步与 README**

cloudRunner.test.ts/cloudCard.sources.test.ts 中 `onDeleted`/retention 文案相关断言按新形态更新(S5/S5b/S5c 用例);README `:364` 替换:

```markdown
- **云端列表无分页**：单目录/前缀下对象数超过云接口单页上限时（如 S3 1000 条），滚动删除可能漏删最旧份；达到分页上限时状态行会提示手动清理（gdrive/onedrive/s3 已实现截断感知）
```

Run: `pnpm --filter @totp/core test && pnpm --filter @totp/ui test`
Expected: 全绿。

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/cloud/backend.ts packages/core/src/cloud/s3.ts packages/core/src/cloud/gdrive.ts packages/core/src/cloud/onedrive.ts packages/core/src/cloud/retention.ts packages/core/test packages/ui/src/components/cloudSyncShared.ts packages/ui/src/components/CloudCard.vue packages/ui/src/host/cloudRunner.ts packages/ui/src/i18n/locales/zh/common.json packages/ui/src/i18n/locales/en/common.json packages/ui/test README.md
git commit -m "feat(core): 云端滚动删除截断感知与状态行告警(F6)(batch D)

why: 三聚合后端(s3/gdrive/onedrive)达 10 页上限时静默截断,滚动删除
可能漏删最旧份且用户无感知(README 已知限制⑥)。
what: CloudBackend 增 listBackupsEx(截断感知),enforceRemoteRetention
返回 {deleted, truncated},UI 状态行附「可能不完整,请手动清理」告警;
webdav/gist 走 listBackups 回退 truncated 恒 false。"
```

---

### Task 8: F7 验证码键盘揭示(Shift+Enter)

**Files:**
- Modify: `packages/ui/src/components/OtpListItem.vue:80-90`
- Test: `packages/ui/test/OtpListItem.interaction.test.ts`(追加用例)

**Interfaces:** 无新接口;复用 `onDblclick()`(33-46 行)的揭示+8s 自动打回。

- [ ] **Step 1: 追加失败测试**

```ts
  it('Shift+Enter 键盘揭示真实码,8 秒后自动打回(B3)', async () => {
    const w = mount(OtpListItem, { props: { ...基线 props } })
    await w.find('.otp-item').trigger('keydown', { key: 'Enter', shiftKey: true })
    expect(码文本不再为 MASK_CODE)  // 按该文件 :39 双击用例的断言手法
    vi.advanceTimersByTime(8000)  // 仿 :39 用例的 fake timer 手法
    expect(...).toBe(MASK_CODE)
  })
```

- [ ] **Step 2: 实现**

`:80-90` 根元素事件补一行(与 `@keydown.enter="emit('copy')"` 并列):

```html
    @keydown.shift.enter.prevent="onDblclick"
```

- [ ] **Step 3: 验证 + Commit**

Run: `pnpm --filter @totp/ui exec vitest run test/OtpListItem.interaction.test.ts test/OtpListItem.edges.test.ts && pnpm --filter @totp/ui test`

```bash
git add packages/ui/src/components/OtpListItem.vue packages/ui/test/OtpListItem.interaction.test.ts
git commit -m "feat(ui): 验证码 Shift+Enter 键盘揭示(B3/F7)(batch D)

why: 揭示(看码)此前仅鼠标双击可达,键盘/AT 用户可复制不可见(无障碍)。
what: 根元素 keydown.shift.enter 复用 onDblclick 揭示链(8s 自动打回,
计时器清理既有 onScopeDispose 兜底)。"
```

---

### Task 9: F8 devtools_get_config 附 envPreset

**Files:**
- Modify: `apps/desktop/src-tauri/src/lib.rs:131-135`(devtools_get_config)
- Modify: `packages/ui/src/components/devtoolsPlatform.ts:1-11`(DTO 增 envPreset)
- Modify: `packages/ui/src/components/DevtoolsCard.vue:22-30` 附近(挂载读 cfg 后置警示态)+ 模板警示行
- Modify: `packages/ui/src/i18n/locales/{zh,en}/common.json`(settingsPage 新增 devtoolsEnvPresetHint)
- Test: Rust devtools 测试组 + DevtoolsCard 测试(如存在)

**Interfaces:**
- Produces: `devtools_get_config` 返回 `{ enabled: bool, port: u16, envPreset: bool }`;`DevtoolsConfigDto` 增 `envPreset: boolean`。
- 语义:`envPreset=true` 表示外部已设 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`,应用内注入被跳过(apply_devtools_env_inner lib.rs:88-99 的 external_preset 分支)——解释用户「设置页已开启但 CDP 无响应」。

- [ ] **Step 1: Rust 实现**

`lib.rs:131-135` 改:

```rust
#[tauri::command]
fn devtools_get_config<R: Runtime>(app: AppHandle<R>) -> Result<serde_json::Value, String> {
    let (enabled, port) = read_devtools_from_settings_text(&read_settings_text(&app));
    // F8(B4):外部已预设 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS 时注入被跳过(apply_devtools_env
    // 的 external_preset 分支)——随配置返回,前端提示「CDP 无响应的可能原因」
    let env_preset = std::env::var_os("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").is_some();
    Ok(serde_json::json!({ "enabled": enabled, "port": port, "envPreset": env_preset }))
}
```

- [ ] **Step 2: 前端 DTO 与卡片**

`devtoolsPlatform.ts` DTO 增:

```ts
/** F8:外部已设 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS(注入被跳过) */
envPreset: boolean
```

`DevtoolsCard.vue` onMounted 读 `cfg.envPreset` 存 ref;模板在启用开关旁条件渲染:

```html
      <p v-if="devtoolsEnvPreset" class="meta">{{ t('settingsPage.devtoolsEnvPresetHint') }}</p>
```

zh 键:`"devtoolsEnvPresetHint": "检测到外部已设置 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS,应用内注入已被跳过——CDP 连不上时先检查该环境变量",`。

- [ ] **Step 3: 验证 + Commit**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml devtools && pnpm --filter @totp/ui test`
(Rust devtools 测试组含 env 哨兵用例与 EnvGuard;get_config 返回形状断言按现有测试手法补 `envPreset` 字段断言。)

```bash
git add apps/desktop/src-tauri/src/lib.rs packages/ui/src/components/devtoolsPlatform.ts packages/ui/src/components/DevtoolsCard.vue packages/ui/src/i18n/locales/zh/common.json packages/ui/src/i18n/locales/en/common.json
git commit -m "feat(desktop): devtools 配置附 envPreset 外部预设提示(F8/B4)(batch D)

why: 外部已设 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS 时注入被跳过,
设置页仍显示已开启,用户无从得知 CDP 为何无响应。
what: devtools_get_config 返回 envPreset,DevtoolsCard 条件渲染解释文案。"
```

---

### Task 10: F9 复核 mini aria 死声明(B6)——预期划线

**Files:** 无改动(研究员核实)。

- [ ] **Step 1: 复核**

Run: `rg -n "aria-haspopup" packages/ui/src/components/OtpListItem.vue apps/desktop/src/MiniApp.vue`
Expected: `OtpListItem.vue:85` 为 `:aria-haspopup="hasContextMenu ? 'menu' : undefined"`,`hasContextMenu = computed(() => props.contextMenu !== false)`(:30);`MiniApp.vue:119` 传 `:context-menu="false"` → mini 侧渲染 undefined。**B6 描述的「未接宿主仍声明 aria-haspopup」已不存在**(contextMenu 门控已落地)。

- [ ] **Step 2: 登记划线**

`docs/plans/2026-09-22-review-backlog.md` B6 行划线:`~~mini aria 死声明~~ **已失效（2026-09-27 复核:OtpListItem contextMenu prop 门控已落地,mini 传 false 不声明 aria-haspopup;登记于 batch D plan Task 10）**`。

- [ ] **Step 3: Commit**

```bash
git add docs/plans/2026-09-22-review-backlog.md
git commit -m "docs(backlog): B6 划线(contextMenu 门控已使 mini 不声明 aria-haspopup)(batch D)"
```

---

### Task 11: F10 云同步状态 ok 语义如实(部分失败记 false)

**Files:**
- Modify: `packages/ui/src/components/cloudRunner.ts:251,341`(两处 recordStatus ok 判定)
- Test: `packages/ui/test/cloudRunner.test.ts`(锚定断言同步——先 rg 确认哪些用例锁定「部分失败 ok=true」现状)

**Interfaces:**
- Consumes: `allTargetsSettled(results)`(`cloudSyncShared.ts:77-78`,既有)。
- Produces: recordStatus 的 ok 语义:任一源 outcome=null 或 convergeError → ok=false;全部收敛 → true。null(跳过/锁定)路径不变。

- [ ] **Step 1: 定位锚定用例并改期望(先红)**

Run: `rg -n "recordStatus" packages/ui/test/cloudRunner.test.ts | head -20`,找到断言 `ok=true` 且 results 含失败源的用例(B9/S4 同源现状),把期望改为 false 并加注释「F10:部分失败如实记 false」;若已有用例覆盖「部分失败 → true」的反向断言,直接改该断言。

- [ ] **Step 2: 实现**

`cloudRunner.ts:341`(apply 通道)与 `:251`(pullAll)两处,ok 参数改:

```ts
      // F10(B9):ok 语义如实——任一源失败(outcome=null)或收敛失败(convergeError)记 false;
      // summary 逐源拼接(含失败源文案)不变。「部分失败仍 ok=true」为既有缺陷语义,随本修复废止
      deps.recordStatus?.(allTargetsSettled(r.results), ...)
```

(:341 原 `true` 改 `allTargetsSettled(r.results)`;:251 pullAll 同构——以该处实际 results 变量名为准。)

- [ ] **Step 3: 验证 + Commit**

Run: `pnpm --filter @totp/ui exec vitest run test/cloudRunner.test.ts && pnpm --filter @totp/ui test`

```bash
git add packages/ui/src/components/cloudRunner.ts packages/ui/test/cloudRunner.test.ts
git commit -m "fix(ui): 云同步自动状态 ok 语义如实,部分失败记 false(F10/B9/S4)(batch D)

why: 存在目标级失败(含 401)时 ok 仍记 true,「上次同步成功」与失败
摘要并置误导(B9);S4 pullAll 全源失败同款。
what: 两处 recordStatus ok 改 allTargetsSettled 判定;锚定断言随修复更新。"
```

---

### Task 12: F11 复核 M1/M2——M1 已覆盖,M2 视前端常量定

**Files:**
- Modify: `docs/plans/2026-09-22-review-backlog.md`(M1 划线;M2 视复核结果)

**Interfaces:** 无。

- [ ] **Step 1: M1 复核**

Run: `rg -n "needs_restart" apps/desktop/src-tauri/src/mcp_server.rs`
Expected: `:2313` 用例 `restart_only_when_lifecycle_fields_change` 已断言「档位/白名单变化 → !needs_restart」(:2330)——M1 要求的显式断言**已存在**,划线:`~~M1 needs_restart 显式断言~~ **已覆盖（mcp_server.rs:2313 用例 :2330 断言;2026-09-27 复核登记于 batch D plan Task 12）**`。

- [ ] **Step 2: M2 复核**

Run: `rg -n "DEFAULT_EXPOSED_TOOLS" apps packages`
Expected 处置:Rust 侧现为函数 `default_exposed_tools()`(mcp_server.rs:53-56,无 const,无类型卫生问题);若前端存在 `DEFAULT_EXPOSED_TOOLS` 字符串数组常量,改 `as const`/`readonly string[]` 并一并提交;若前端无此常量,M2 划线为「已失效(Rust 为函数形态,前端无常量)」。

- [ ] **Step 3: Commit**

```bash
git add docs/plans/2026-09-22-review-backlog.md
git commit -m "docs(backlog): M1 划线(既有用例覆盖)/M2 按复核结果处置(batch D)"
```

---

## 批次收尾

- [ ] 全仓门禁:`pnpm typecheck && pnpm -r --no-bail run test` + cargo fmt/clippy/test(F8 涉 Rust),全绿后批次 D 完成。
- [ ] README 已知限制终态核对:①(不动)/②(F3 更正)/③(A 批删除)/④(F2 更正)/⑤(F5 语义不变,可不动)/⑥(F6 更正)。
