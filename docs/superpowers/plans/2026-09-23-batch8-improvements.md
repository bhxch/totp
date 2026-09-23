# 八项改进批量实施计划（MV3 / webview 释放 / UI·UX 与文档）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按 spec 依次落地 8 项改进：导入文案补齐、MCP token 体验、壳层滚动、备注控件、剪贴板导入、Firefox MV3 迁移、桌面 webview 三段式释放、README 双语。

**Architecture:** 前六项为小步改造（每项 1-2 commit）；#1 分三步（manifest → API 统一 → 能力收拢）；#7 为 Rust 状态机 + 前端设置卡（3 commit）；#8 收尾同步全部事实。

**Tech Stack:** Vue 3 + vue-i18n + vitest（packages/ui 含 @vue/test-utils）、WXT 0.19（双目标扩展）、Tauri 2 + Rust（cargo test）、pnpm monorepo。

**Spec:** `docs/superpowers/specs/2026-09-23-batch8-improvements-design.md`（实施时与本计划同读；本计划对 spec 有两处实现级修正，见 Task 10 的说明与 Task 12 的说明）。

## Global Constraints

- 构建：`pnpm exec wxt build -b chrome` 与 `pnpm exec wxt build -b firefox`（Firefox 必须 `-b firefox`）；构建产物 `.output/` 不入库。
- 测试：根目录 `pnpm test`（core/ui/extension/desktop 四包全绿）；Rust 侧在 `apps/desktop/src-tauri` 跑 `cargo test`。
- 每个 Task 结束即 commit（Angular 规范：why 一句 + what 一句），不批量提交。
- i18n：`packages/ui/src/i18n/locales/zh/common.json` 与 `en/common.json` 必须同步增删键。
- 扩展产物断言（Task 9 后永久有效）：两产物 `manifest_version === 3`；firefox 产物无 `offscreen` 权限、gecko id `totp@bhxch.github.io`、`strict_min_version === '140.0'`。
- 密钥/口令永不写入日志与错误消息。
- mcpCard/McpServerCard 的实际路径是 `packages/ui/src/components/`（spec 3 节写的 apps/desktop/src 有误，以本计划为准）。

---

## Part 1（spec §2）：导入帮助文案补齐

### Task 1: importCard 三行文案对齐实现清单

**Files:**
- Test: `packages/ui/test/importFormatsI18n.test.ts`（新建）
- Modify: `packages/ui/src/i18n/locales/zh/common.json`（importCard.formatsEncrypted / formatsApps / formatsText 三行，L361-364 附近）
- Modify: `packages/ui/src/i18n/locales/en/common.json`（同上三行）

**Interfaces:**
- Consumes: `packages/core/src/import/types.ts` 的 `ImportFormat` union（aegis/winauth/uriBatch/generic/twoFas/bitwarden/proton/stratum/freeOtp/freeOtpLegacy/totpAuthenticator/andOtp/foxauth）+ 手动下拉专属格式（authy/battleNet/duo/msAuth/sqlite/authenticatorPlus，对应 `fmtAuthy` 等键）。
- Produces: 三行文案覆盖全部格式品牌名；一致性测试 `importFormatsI18n.test.ts`。

- [ ] **Step 1: 写失败测试**

新建 `packages/ui/test/importFormatsI18n.test.ts`：

```ts
import zh from '../src/i18n/locales/zh/common.json'
import en from '../src/i18n/locales/en/common.json'
import { describe, expect, it } from 'vitest'

// 全部导入能力的品牌名（实现源：packages/core/src/import 下 parsers + sniff.ts 判定序 + ImportCard 手动下拉）。
// Ente Auth 明文导出走 uriBatch 通道（types.ts 注释口径），计入文本类。
const BRANDS: ReadonlyArray<{ name: string; lines: Array<'formatsEncrypted' | 'formatsApps' | 'formatsText'> }> = [
  { name: 'Aegis', lines: ['formatsEncrypted'] },
  { name: 'WinAuth', lines: ['formatsEncrypted'] },
  { name: 'Authy', lines: ['formatsEncrypted', 'formatsApps'] },
  { name: 'Authenticator Plus', lines: ['formatsEncrypted', 'formatsApps'] },
  { name: 'FoxAuth', lines: ['formatsEncrypted', 'formatsApps'] },
  { name: '2FAS', lines: ['formatsApps'] },
  { name: 'Bitwarden', lines: ['formatsApps'] },
  { name: 'Proton Authenticator', lines: ['formatsApps'] },
  { name: 'Stratum', lines: ['formatsApps'] },
  { name: 'FreeOTP+', lines: ['formatsApps'] },
  { name: 'FreeOTP', lines: ['formatsApps'] },
  { name: 'andOTP', lines: ['formatsApps'] },
  { name: 'TOTP Authenticator', lines: ['formatsApps'] },
  { name: 'Battle.net', lines: ['formatsApps'] },
  { name: 'Duo', lines: ['formatsApps'] },
  { name: 'Microsoft Authenticator', lines: ['formatsApps'] },
  { name: 'Ente Auth', lines: ['formatsText'] },
  { name: 'otpauth', lines: ['formatsText'] },
  { name: 'JSON', lines: ['formatsText'] },
]

for (const [locale, obj] of [['zh', zh], ['en', en]] as const) {
  describe(`importCard.formats* (${locale})`, () => {
    for (const brand of BRANDS) {
      it(`文案覆盖 ${brand.name}`, () => {
        for (const line of brand.lines) {
          const text = (obj.importCard as Record<string, string>)[line]
          expect(text, `${line} 缺 ${brand.name}`).toContain(brand.name)
        }
      })
    }
  })
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @totp/ui test -- importFormatsI18n`
预期：FAIL——FoxAuth 在 formatsEncrypted/formatsApps 缺失、Ente Auth 在 formatsText 缺失（en 的 WinAuth 在 formatsText 现文案亦无）。

- [ ] **Step 3: 改三行文案**

`zh/common.json` importCard 三行替换为：

```json
    "formatsEncrypted": "加密备份类：Aegis（加密/明文）、FoxAuth（加密/明文）、WinAuth XML、Authy、Authenticator Plus（加密 zip，手动选择格式）",
    "formatsApps": "应用导出类：2FAS、Bitwarden、Proton Authenticator、Stratum、FreeOTP+、旧版 FreeOTP、andOTP、TOTP Authenticator、FoxAuth、Battle.net、Duo、Microsoft Authenticator、Authenticator Plus",
    "formatsText": "文本与通用类：otpauth URI 批量文本（含 Ente Auth 明文导出）、通用 JSON/JSONL/SQLite（可自定义字段映射，映射方案可保存复用）",
```

`en/common.json` 三行替换为：

```json
    "formatsEncrypted": "Encrypted backups: Aegis (encrypted/plain), FoxAuth (encrypted/plain), WinAuth XML, Authy, Authenticator Plus (encrypted zip, pick the format manually)",
    "formatsApps": "App exports: 2FAS, Bitwarden, Proton Authenticator, Stratum, FreeOTP+, legacy FreeOTP, andOTP, TOTP Authenticator, FoxAuth, Battle.net, Duo, Microsoft Authenticator, Authenticator Plus",
    "formatsText": "Text and generic: otpauth URI batch text (including Ente Auth plain exports), generic JSON/JSONL/SQLite (custom field mapping; mapping schemes can be saved and reused)",
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @totp/ui test -- importFormatsI18n`
预期：PASS（全部用例）。

- [ ] **Step 5: 回归 + 提交**

Run: `pnpm test`（全绿）
Commit:

```bash
git add packages/ui/test/importFormatsI18n.test.ts packages/ui/src/i18n/locales/zh/common.json packages/ui/src/i18n/locales/en/common.json
git commit -m "fix(ui): 导入帮助文案补齐FoxAuth/EnteAuth等漏项并加一致性测试

why: ImportCard 帮助区三行文案与实际解析能力不符（漏 FoxAuth/Ente Auth），用户可感知的能力说明缺失
what: zh/en 三行文案按 import 实现清单补齐，新增品牌覆盖一致性测试"
```

---

## Part 2（spec §3）：MCP token 体验修复

### Task 2: connectionSnippet 嵌入真实 token

**Files:**
- Modify: `packages/ui/src/components/mcpCard.ts:79-82`（connectionSnippet）
- Test: `packages/ui/test/mcpCard.test.ts:16-35`（connectionSnippet describe 重写）

**Interfaces:**
- Produces: `connectionSnippet(cfg: Pick<McpConfigDto, 'port' | 'token'>): string`——token 非空时嵌入真值，空时输出 `Bearer <MCP token>` 占位。Task 3 的组件调用点无需改签名（现传完整 cfg）。

**注意**：这是**有意反转**原有安全策略（旧注释"token 不内嵌"）。旧测试 `永不内嵌真实 token` 必须删除替换，不得保留。

- [ ] **Step 1: 重写该 describe 的测试（先失败）**

`packages/ui/test/mcpCard.test.ts` 中 `describe('connectionSnippet', ...)` 整段（L16-35）替换为：

```ts
describe('connectionSnippet', () => {
  it('token 非空：嵌入真实 token，复制片段即可直接使用（2026-09-23 用户决策：片段嵌真 token）', () => {
    const cfg: McpConfigDto = { enabled: true, mode: 'token', port: 47215, token: 'super-secret-token', whitelist: ['Claude*'], exposedTools: ['list_accounts'] }
    const s = connectionSnippet(cfg)
    expect(s).toContain('Bearer super-secret-token')
    expect(s).not.toContain('<MCP token>')
  })
  it('token 为空（未启用/未生成）：输出占位符引导，不输出空 Bearer', () => {
    const s = connectionSnippet({ port: 47215, token: '' })
    expect(s).toContain('Bearer <MCP token>')
    expect(s).not.toContain('Bearer "')
    expect(s).not.toContain('Bearer "}"')
  })
  it('输出为合法 JSON：mcpServers.totp.url 指向 /mcp 且带 Authorization 头', () => {
    const parsed = JSON.parse(connectionSnippet({ port: 47215, token: 'tok' })) as {
      mcpServers: { totp: { url: string; headers: Record<string, string> } }
    }
    expect(parsed.mcpServers.totp.url).toBe('http://127.0.0.1:47215/mcp')
    expect(parsed.mcpServers.totp.headers.Authorization).toBe('Bearer tok')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @totp/ui test -- mcpCard`
预期：FAIL（现实现恒输出占位符）。

- [ ] **Step 3: 实现**

`mcpCard.ts` L79-82 替换为（注释同步反转）：

```ts
/** 客户端连接片段（2026-09-23 用户决策反转旧策略）：token 非空时直接嵌入——复制片段即可用，
 *  token 本就同卡片可见可复制，泄露面不变；token 为空（未启用未生成）时输出占位符引导，
 *  与卡片空值提示（tokenEmptyHint）配合。 */
export function connectionSnippet(cfg: Pick<McpConfigDto, 'port' | 'token'>): string {
  const auth = `Bearer ${cfg.token || '<MCP token>'}`
  return JSON.stringify({ mcpServers: { totp: { url: `http://127.0.0.1:${cfg.port}/mcp`, headers: { Authorization: auth } } } }, null, 2)
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @totp/ui test -- mcpCard`
预期：PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/ui/src/components/mcpCard.ts packages/ui/test/mcpCard.test.ts
git commit -m "feat(ui): MCP连接片段嵌入真实token复制即用

why: 占位符片段需手动替换才能用，用户反馈'默认token为空'的直接痛点
what: connectionSnippet 按用户决策改为嵌入真实token（空时保留占位引导），反转原不内嵌策略并同步测试"
```

### Task 3: McpServerCard 空 token 防护

**Files:**
- Modify: `packages/ui/src/components/McpServerCard.vue`（token 区 L281-297 + script）
- Modify: `packages/ui/src/i18n/locales/zh/common.json`、`en/common.json`（mcpServer 段各加 1 键）
- Test: `packages/ui/test/mcpCard.test.ts`（新增空 token 组件用例）

**Interfaces:**
- Consumes: Task 2 后的 connectionSnippet；`McpPlatform.getConfig`（Rust 侧 `fill_blank_token_if_enabled` 保证启用后 token 非空——前端只需对"未启用"空态防护）。
- Produces: i18n 键 `mcpServer.tokenEmptyHint`。

- [ ] **Step 1: 加 i18n 键**

zh `mcpServer` 段加：`"tokenEmptyHint": "（启用后自动生成）"`；en 加：`"tokenEmptyHint": "(auto-generated when enabled)"`。

- [ ] **Step 2: 写组件测试（先失败）**

`packages/ui/test/mcpCard.test.ts` 末尾追加：

```ts
describe('McpServerCard 空 token 防护', () => {
  const base = { enabled: false, mode: 'token', port: 47215, token: '', whitelist: [], running: false, lastError: null }
  function mkPlatform() {
    return {
      getConfig: vi.fn().mockResolvedValue({ ...base, exposedTools: ['list_accounts', 'get_code'] }),
      setConfig: vi.fn().mockResolvedValue(undefined),
      regenerateToken: vi.fn().mockResolvedValue('new-token'),
      revokeApprovals: vi.fn().mockResolvedValue(0),
      copyText: vi.fn().mockResolvedValue(undefined),
    }
  }
  it('token 为空：显示占位提示、复制按钮置灰、不调用 copyText', async () => {
    const platform = mkPlatform()
    const w = mount(McpServerCard, { global: { plugins: [createTestI18n()] }, props: { platform } })
    await vi.waitFor(() => expect(w.find('.token-block').exists()).toBe(true))
    expect(w.text()).toContain('（启用后自动生成）')
    const copyBtn = w.findAll('.token-block button').find((b) => b.text().includes('复制'))!
    expect((copyBtn.element as HTMLButtonElement).disabled).toBe(true)
    await copyBtn.trigger('click')
    expect(platform.copyText).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm --filter @totp/ui test -- mcpCard`
预期：新增用例 FAIL（现实现复制按钮可用、点击复制空串）。

- [ ] **Step 4: 实现防护**

`McpServerCard.vue`：script 中 `tokenVisible` 声明附近加 `const hasToken = computed(() => !!cfg.value?.token)`；模板 token 区（L282-291）替换为：

```html
      <div class="token-block">
        <div class="token-row">
          <span class="opt-label">{{ t('mcpServer.token') }}</span>
          <code class="token-value">{{ tokenVisible ? (cfg.token || t('mcpServer.tokenEmptyHint')) : '••••' }}</code>
          <MdButton variant="text" :disabled="busy" @click="tokenVisible = !tokenVisible">
            {{ tokenVisible ? t('mcpServer.tokenHide') : t('mcpServer.tokenShow') }}
          </MdButton>
          <MdButton variant="text" :disabled="busy || !hasToken" @click="copyToken">{{ t('mcpServer.tokenCopy') }}</MdButton>
          <span v-if="copied === 'token'" class="copied">{{ t('mcpServer.copied') }}</span>
          <MdButton variant="text" danger :disabled="busy" @click="pendingRegen = true">{{ t('mcpServer.regenerate') }}</MdButton>
        </div>
```

`copyToken` 开头加空值短路：`if (!cur || !cur.token) return`。启用后显示刷新无需额外代码：`persist` 成败均 `refresh()`，Rust 启用时已生成 token。

- [ ] **Step 5: 跑测试 + 回归 + 提交**

Run: `pnpm --filter @totp/ui test -- mcpCard` → PASS；`pnpm test` 全绿。
Commit:

```bash
git add packages/ui/src/components/McpServerCard.vue packages/ui/test/mcpCard.test.ts packages/ui/src/i18n/locales/zh/common.json packages/ui/src/i18n/locales/en/common.json
git commit -m "fix(ui): MCP卡片空token显示占位提示并禁用复制

why: 未启用时 token 空串可被复制为空值，用户误以为功能损坏
what: 空 token 显示'启用后自动生成'占位、复制按钮置灰短路，启用后经 refresh 立即显示生成值"
```

---

## Part 3（spec §4）：壳层统一滚动

### Task 4: NavigationShell 定高 + 内容区内部滚动

**Files:**
- Modify: `packages/ui/src/pages/NavigationShell.vue:119-122`（style 段）

- [ ] **Step 1: 改样式**

`.nav-shell` 与 `.nav-shell__main` 两条规则替换为：

```css
/* 壳层锁高：rail 固定、内容区内部滚动（spec 批⑧ §4）；窄屏顶部 Tabs 布局维持文档流整页滚动 */
.nav-shell { display: flex; height: 100dvh; overflow: hidden; }
.nav-shell--narrow { flex-direction: column; height: auto; overflow: visible; }
.nav-shell__main { flex: 1; min-width: 0; overflow-y: auto; }
```

- [ ] **Step 2: 走查**

Run: `pnpm --filter @totp/desktop tauri dev`（或扩展 `pnpm --filter @totp/extension dev`）
核对：宽窗 ≥600px 时 rail 固定、滚轮滚动发生在右侧内容区、五页均正常、CodesPage 的 FAB（fixed）仍贴视口右下、MdDialog/MdSelect 浮层正常；窗口缩到 <600px 时恢复整页滚动。

- [ ] **Step 3: 回归 + 提交**

Run: `pnpm test`（NavigationShell 相关组件测试全绿）
Commit:

```bash
git add packages/ui/src/pages/NavigationShell.vue
git commit -m "fix(ui): 壳层统一为rail固定+内容区内滚

why: 整页滚动导致左侧导航栏随页面滚走，设置页长内容下导航不可达
what: .nav-shell 定高100dvh锁滚动、main 内滚；窄屏顶部Tab布局维持整页滚动"
```

---

## Part 4（spec §5）：备注控件统一

### Task 5: MdTextField multiline 变体

**Files:**
- Modify: `packages/ui/src/components/md/MdTextField.vue`（全文 58 行，改动见下）
- Test: `packages/ui/test/MdTextField.test.ts`（新建）

**Interfaces:**
- Produces: 新 props `multiline?: boolean`（默认 false）、`rows?: number`（默认 3）。Task 6 消费 `<MdTextField multiline :rows="3">`。

- [ ] **Step 1: 写失败测试**

新建 `packages/ui/test/MdTextField.test.ts`：

```ts
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import MdTextField from '../src/components/md/MdTextField.vue'

describe('MdTextField multiline', () => {
  it('默认渲染 input，multiline 渲染 textarea 且 rows 生效', () => {
    const single = mount(MdTextField, { props: { modelValue: '', label: '备注' } })
    expect(single.find('input').exists()).toBe(true)
    const multi = mount(MdTextField, { props: { modelValue: '', label: '备注', multiline: true, rows: 3 } })
    const ta = multi.find('textarea')
    expect(ta.exists()).toBe(true)
    expect(ta.attributes('rows')).toBe('3')
  })
  it('textarea 双向绑定与输入事件', async () => {
    const w = mount(MdTextField, { props: { modelValue: '', label: '备注', multiline: true, 'onUpdate:modelValue': (v: string) => w.setProps({ modelValue: v }) } })
    await w.find('textarea').setValue('第一行\n第二行')
    expect(w.props('modelValue')).toBe('第一行\n第二行')
  })
  it('multiline 时 label 恒浮动（含空值，textarea 的 label 不再占行中）', () => {
    const w = mount(MdTextField, { props: { modelValue: '', label: '备注', multiline: true } })
    expect(w.find('.md-text-field__label').classes()).toContain('md-text-field__label--floated')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @totp/ui test -- MdTextField`
预期：FAIL（无 multiline props，仍渲染 input）。

- [ ] **Step 3: 实现**

`MdTextField.vue` 改动（三处）：

props 行替换为：

```ts
withDefaults(defineProps<{ modelValue: string; label: string; type?: string; error?: string; placeholder?: string; ariaLabel?: string; multiline?: boolean; rows?: number }>(), { type: 'text', error: '', placeholder: '', multiline: false, rows: 3 })
```

label 浮动条件加 multiline 恒浮动（`md-text-field__label` 的 class 绑定）：

```html
      <span class="md-text-field__label" :class="{ 'md-text-field__label--floated': multiline || !!modelValue || !!placeholder }">{{ label }}</span>
```

input 行后加 textarea 分支（`v-else` 语义用 `v-if="!multiline"` 挂 input 上）：

```html
      <input v-if="!multiline" v-bind="inputAttrs" class="md-text-field__input" :type="type" :value="modelValue" :placeholder="placeholder"
        :aria-label="ariaLabel" :aria-invalid="error ? 'true' : undefined" :aria-describedby="error ? errorId : undefined"
        @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)" />
      <textarea v-else v-bind="inputAttrs" class="md-text-field__input md-text-field__textarea" :rows="rows" :value="modelValue" :placeholder="placeholder"
        :aria-label="ariaLabel" :aria-invalid="error ? 'true' : undefined" :aria-describedby="error ? errorId : undefined"
        @input="emit('update:modelValue', ($event.target as HTMLTextAreaElement).value)" />
```

style 末尾加：

```css
.md-text-field__textarea { resize: vertical; min-height: 72px; line-height: 1.5; }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @totp/ui test -- MdTextField`
预期：PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/ui/src/components/md/MdTextField.vue packages/ui/test/MdTextField.test.ts
git commit -m "feat(ui): MdTextField增加multiline变体

why: 备注字段是表单唯一裸原生textarea，视觉与统一输入控件脱节
what: MdTextField 支持 multiline/rows 渲染 textarea，复用 filled 背景+下边框+浮动标签样式"
```

### Task 6: EntryForm 备注换用 multiline

**Files:**
- Modify: `packages/ui/src/components/EntryForm.vue:428`（textarea 行）与 `:502-504`（裸 textarea 样式删除）

- [ ] **Step 1: 替换控件**

L428 行替换为：

```html
    <MdTextField v-model="form.note" multiline :rows="3" :placeholder="t('entryForm.notePlaceholder')" :aria-label="t('entryForm.noteAria')" />
```

style 段删除两条裸 textarea 规则（L503-504），注释「仅存的原生控件（textarea/file）保留紧凑样式」改为「仅存的原生控件（file input）保留隐藏样式」。

- [ ] **Step 2: 回归**

Run: `pnpm --filter @totp/ui test`（EntryForm 全部测试绿——备注在既有用例中仅透传，无断言需改）+ 走查新建/编辑弹窗备注字段视觉与主题（浅色/深色/AMOLED）。

- [ ] **Step 3: 提交**

```bash
git add packages/ui/src/components/EntryForm.vue
git commit -m "refactor(ui): 备注字段换用MdTextField multiline

why: 裸textarea无设计token颜色不合群（用户反馈）
what: EntryForm 备注改 multiline MdTextField，删除裸textarea补丁样式"
```

---

## Part 5（spec §6）：手动填写页剪贴板导入

### Task 7: clipboardImport 纯函数（读剪贴板 + 意图分流）

**Files:**
- Create: `packages/ui/src/clipboardImport.ts`
- Test: `packages/ui/test/clipboardImport.test.ts`

**Interfaces:**
- Consumes: `parseUriToEntryData`（`../otpauthFlow`，返回 `{ data: OtpEntry } | { error: string }`）；`parsePastedText`（`@totp/core`，返回 `ImportResult | { unsupported: string }`）；`PastedImage` 通道复用 `blobToPixels`。
- Produces（Task 8 消费）:
  - `readClipboardSnapshot(): Promise<{ image: Blob | null; text: string }>`（`navigator.clipboard.read()`；无权限/不可用抛异常由调用方 catch）
  - `type ClipboardIntent = { kind: 'prefill'; entry: OtpEntry } | { kind: 'batch'; entries: OtpEntry[] } | { kind: 'error'; message: string }`
  - `resolveTextIntent(text: string): ClipboardIntent`
  - `toParsedEntry(d: OtpEntry): ParsedEntry`（OtpEntry 哑值→导入判定/落库字段投影，口径同 BatchPastePanel.toParsed）
  - `applyUriPrefill(form, d: OtpEntry)` 的数据来源：entry 即 `parseUriToEntryData` 的 data（OtpEntry 全形状）

- [ ] **Step 1: 写失败测试**

新建 `packages/ui/test/clipboardImport.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { resolveTextIntent, toParsedEntry } from '../src/clipboardImport'

const URI = 'otpauth://totp/Gen:pix?secret=JBSWY3DPEHPK3PXP&issuer=Gen'

describe('resolveTextIntent', () => {
  it('单条 otpauth URI → prefill（uuid 为哑值空串）', () => {
    const r = resolveTextIntent(URI)
    expect(r.kind).toBe('prefill')
    if (r.kind === 'prefill') {
      expect(r.entry.issuer).toBe('Gen')
      expect(r.entry.uuid).toBe('')
    }
  })
  it('多条 URI 文本 → batch（条数=行数）', () => {
    const r = resolveTextIntent(`${URI}\n${URI.replace('Gen', 'Other')}`)
    expect(r.kind).toBe('batch')
    if (r.kind === 'batch') expect(r.entries).toHaveLength(2)
  })
  it('单条目 JSON（2FAS 形态）→ prefill', () => {
    const r = resolveTextIntent(JSON.stringify({ secret: 'JBSWY3DPEHPK3PXP', otp: { account: 'me@x.com' }, name: 'GH' }))
    expect(r.kind).toBe('prefill')
  })
  it('不支持的格式（generic 无映射）→ error 且消息来自 parser', () => {
    const r = resolveTextIntent('{"foo": 1}')
    expect(r.kind).toBe('error')
    if (r.kind === 'error') expect(r.message.length).toBeGreaterThan(0)
  })
  it('空文本 → error', () => {
    expect(resolveTextIntent('   ').kind).toBe('error')
  })
})

describe('toParsedEntry', () => {
  it('投影导入字段、丢弃管理字段', () => {
    const p = toParsedEntry({
      uuid: 'u1', type: 'totp', issuer: 'GH', label: 'me', secret: 'JBSWY3DPEHPK3PXP',
      algorithm: 'SHA1', digits: 6, period: 30, note: 'n', tagIds: ['t'], matchRules: [], order: 3, createdAt: 9,
    })
    expect(p).toEqual({ type: 'totp', issuer: 'GH', label: 'me', secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA1', digits: 6, period: 30 })
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @totp/ui test -- clipboardImport`
预期：FAIL（模块不存在）。

- [ ] **Step 3: 实现**

新建 `packages/ui/src/clipboardImport.ts`：

```ts
import { parsePastedText, type ParsedEntry, type OtpEntry } from '@totp/core'
import { parseUriToEntryData } from './otpauthFlow'

/** 手动填写页「从剪贴板导入」（spec 批⑧ §6）：读剪贴板快照 + 文本意图分流。
 *  读剪贴板需用户手势与 clipboardRead 权限（扩展端，manifest 提供）；失败由调用方 catch 提示。 */
export interface ClipboardSnapshot {
  image: Blob | null
  text: string
}

export async function readClipboardSnapshot(): Promise<ClipboardSnapshot> {
  const items = await navigator.clipboard.read()
  let image: Blob | null = null
  const texts: string[] = []
  for (const item of items) {
    const imgType = item.types.find((t) => t.startsWith('image/'))
    if (imgType && !image) image = await item.getType(imgType)
    if (item.types.includes('text/plain')) texts.push(await (await item.getType('text/plain')).text())
  }
  return { image, text: texts.join('\n') }
}

export type ClipboardIntent =
  | { kind: 'prefill'; entry: OtpEntry }
  | { kind: 'batch'; entries: OtpEntry[] }
  | { kind: 'error'; message: string }

/** 文本意图：单条 otpauth URI / 单条目解析 → prefill；多条 → batch；解析不了 → error。
 *  URI 优先（与 QR 同路径）；其余格式走 parsePastedText 粘贴白名单（加密/需映射格式引导导入页，消息透传）。 */
export function resolveTextIntent(text: string): ClipboardIntent {
  const trimmed = text.trim()
  if (!trimmed) return { kind: 'error', message: '剪贴板没有可用内容' }
  const uri = parseUriToEntryData(trimmed)
  if (!('error' in uri)) return { kind: 'prefill', entry: uri.data }
  // URI 解析失败且文本含换行/非 URI 时按批量解析；单行纯文本（如裸 base32）也试批量通道给明确错误
  let r: ReturnType<typeof parsePastedText>
  try {
    r = parsePastedText(trimmed)
  } catch (e) {
    return { kind: 'error', message: e instanceof Error ? e.message : String(e) }
  }
  if ('unsupported' in r) return { kind: 'error', message: r.unsupported }
  if (r.entries.length === 0) {
    return { kind: 'error', message: r.failures[0]?.message ?? '未能从剪贴板解析出条目' }
  }
  if (r.entries.length === 1) {
    return { kind: 'prefill', entry: prefillFromParsed(r.entries[0]!) }
  }
  return { kind: 'batch', entries: r.entries.map(prefillFromParsed) }
}

/** ParsedEntry → OtpEntry 哑值形状（作 EntryForm initial / 预填；保存时宿主覆盖 uuid/order/createdAt） */
function prefillFromParsed(e: ParsedEntry): OtpEntry {
  return {
    uuid: '',
    type: e.type,
    issuer: e.issuer,
    label: e.label,
    secret: e.secret,
    algorithm: e.algorithm,
    digits: e.digits,
    period: e.period,
    ...(e.counter !== undefined ? { counter: e.counter } : {}),
    ...(e.pin !== undefined ? { pin: e.pin } : {}),
    note: '',
    tagIds: [],
    matchRules: [],
    order: 0,
    createdAt: 0,
  }
}

/** OtpEntry → ParsedEntry 投影（批量落库 applyImport 入参；口径同 BatchPastePanel.toParsed） */
export function toParsedEntry(d: OtpEntry): ParsedEntry {
  return {
    type: d.type,
    issuer: d.issuer,
    label: d.label,
    secret: d.secret,
    algorithm: d.algorithm,
    digits: d.digits,
    period: d.period,
    ...(d.counter !== undefined ? { counter: d.counter } : {}),
    ...(d.pin !== undefined ? { pin: d.pin } : {}),
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @totp/ui test -- clipboardImport`
预期：PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/ui/src/clipboardImport.ts packages/ui/test/clipboardImport.test.ts
git commit -m "feat(ui): 剪贴板导入纯函数（快照读取+意图分流）

why: 手动填写页要从剪贴板一键导入，复用 QR 与多格式解析能力
what: 新增 clipboardImport 模块——readClipboardSnapshot/resolveTextIntent/toParsedEntry 及单测"
```

### Task 8: EntryForm 按钮接线 + Dialog 批量通道 + 权限

**Files:**
- Modify: `packages/ui/src/components/EntryForm.vue`（script + secret-row 模板）
- Modify: `packages/ui/src/components/EntryFormDialog.vue`（传 importBatch + 转发 batch-imported）
- Modify: `apps/extension/wxt.config.ts`（permissions 加 clipboardRead——本任务先行实施，Task 9 迁移时保留）
- Modify: `packages/ui/src/i18n/locales/zh/common.json`、`en/common.json`（entryForm 段加 3 键）

**Interfaces:**
- Consumes: Task 7 的 `readClipboardSnapshot/resolveTextIntent/toParsedEntry`；`applyImport`/`dedupeWithinFile`（`@totp/core`）；Dialog 已有 `batch-added` emit（宿主 CodesPage 已监听关弹窗+提示）。
- Produces: EntryForm 新 prop `importBatch?: (entries: OtpEntry[]) => Promise<number>`；新 emit `'batch-imported': [count: number]`。

- [ ] **Step 1: i18n 键**

zh `entryForm` 段加：

```json
    "fromClipboard": "从剪贴板导入",
    "clipboardEmpty": "剪贴板没有可用内容",
    "clipboardReadFailed": "无法读取剪贴板（需要授权或内容不可读）",
```

en 对应：

```json
    "fromClipboard": "Import from clipboard",
    "clipboardEmpty": "Clipboard has no usable content",
    "clipboardReadFailed": "Cannot read the clipboard (authorization required or content unreadable)",
```

- [ ] **Step 2: EntryForm 接线**

script：imports 加（`OtpEntry` 类型现有 imports 已含，勿重复）：

```ts
import { readClipboardSnapshot, resolveTextIntent } from '../clipboardImport'
```

props 加一项：

```ts
  /** 剪贴板多条批量入库（宿主实现：dedupe + applyImport 落库返回条数）；缺省时 batch 意图降级为错误提示 */
  importBatch?: (entries: OtpEntry[]) => Promise<number>
```

emits 改为 `defineEmits<{ save: [data: EntryFormData]; cancel: []; 'batch-imported': [count: number] }>()`。

onQrFile 的预填段（L94-100）抽为共用函数（`d.data` 即 OtpEntry 全形状）：

```ts
/** URI 预填共用（QR 识别与剪贴板导入同一通道）：覆盖 OTP 字段，保留已填 note/tagIds/icon */
function applyPrefill(d: OtpEntry): void {
  form.type = d.type; form.issuer = d.issuer; form.label = d.label
  form.secret = d.secret; form.algorithm = d.algorithm; form.digits = d.digits
  form.period = d.period; if (d.counter !== undefined) form.counter = d.counter
  if (d.pin !== undefined) form.pin = d.pin
  error.value = ''
}
```

onQrFile 内预填段改调 `applyPrefill(d.data)`。新增按钮处理：

```ts
// ---------- 从剪贴板导入（spec 批⑧ §6）：图片走 QR；文本单条预填/多条批量入库 ----------
const clipboardBusy = ref(false)
async function onClipboardImport(): Promise<void> {
  if (clipboardBusy.value) return
  clipboardBusy.value = true
  try {
    const snap = await readClipboardSnapshot()
    if (snap.image) {
      const r = decodeQrToUri(await blobToPixels(snap.image))
      if ('error' in r) { error.value = r.error; return }
      const d = parseUriToEntryData(r.uri)
      if ('error' in d) { error.value = d.error; return }
      applyPrefill(d.data)
      return
    }
    if (snap.text.trim() !== '') {
      const intent = resolveTextIntent(snap.text)
      if (intent.kind === 'error') { error.value = intent.message; return }
      if (intent.kind === 'prefill') { applyPrefill(intent.entry); return }
      if (!props.importBatch) { error.value = t('entryForm.clipboardReadFailed'); return }
      const n = await props.importBatch(intent.entries)
      emit('batch-imported', n)
      return
    }
    error.value = t('entryForm.clipboardEmpty')
  } catch {
    error.value = t('entryForm.clipboardReadFailed')
  } finally {
    clipboardBusy.value = false
  }
}
```

template secret-row 在「从图片识别」按钮后加：

```html
      <MdButton variant="text" data-test="clipboard-pick" :disabled="clipboardBusy" @click="onClipboardImport">{{ t('entryForm.fromClipboard') }}</MdButton>
```

- [ ] **Step 3: EntryFormDialog 批量通道**

script imports 加 `import { applyImport, dedupeWithinFile, type OtpEntry } from '@totp/core'` 与 `import { toParsedEntry } from '../clipboardImport'`；props 加：

```ts
  /** EntryForm 剪贴板批量入库实现：批内去重后整体落库返回条数（新增优先，与粘贴 Tab 同一 applyImport 通道） */
  store: VueStore  // 已有，无需新增——importBatch 闭包直接用
```

（store prop 已存在。）在 defineProps 之后加：

```ts
/** 剪贴板多条批量入库（spec 批⑧ §6）：批内先去重（同 URI 粘两遍不双写），全部按新增落库
 *  （applyImport 'skip' 策略 + 空冲突集）；与粘贴 Tab 不同点：无预览确认，直接入库并上抛条数 */
async function importBatchEntries(entries: OtpEntry[]): Promise<number> {
  const parsed = entries.map(toParsedEntry)
  const { kept } = dedupeWithinFile(parsed)
  await props.store.commit((v) => applyImport(v, kept, 'skip', new Set<number>()))
  return kept.length
}
```

EntryForm 挂参与与事件转发（template 中 EntryForm 标签）：

```html
    <EntryForm
      v-if="tab === 'manual'"
      :key="editing?.uuid ?? 'new'"
      :initial="editing"
      :tags="tags"
      :create-tag="createTag"
      :icons="icons"
      :icon-store="iconStore"
      :import-batch="importBatchEntries"
      @save="(data) => emit('save', data)"
      @cancel="emit('close')"
      @batch-imported="(count) => emit('batch-added', count)"
    />
```

- [ ] **Step 4: 扩展权限**

`apps/extension/wxt.config.ts` permissions 数组加 `'clipboardRead'`（`'offscreen'` 之后），注释同步：剪贴板读取供手动表单「从剪贴板导入」（Chrome 需权限；Firefox 弹授权提示）。

- [ ] **Step 5: 走查 + 回归 + 提交**

走查：复制一张 otpauth 二维码图片 → 点按钮表单预填；复制多条 URI 文本 → 弹窗关闭且列表新增 N 条；复制无关文本 → 错误提示；桌面端 WebView2 验证 navigator.clipboard.read 行为。
Run: `pnpm test` 全绿。
Commit:

```bash
git add packages/ui/src/components/EntryForm.vue packages/ui/src/components/EntryFormDialog.vue apps/extension/wxt.config.ts packages/ui/src/i18n/locales/zh/common.json packages/ui/src/i18n/locales/en/common.json
git commit -m "feat(ui): 手动填写页从剪贴板导入按钮

why: 图片识别需先开文件选择器不够顺手（用户反馈），剪贴板即得
what: EntryForm 新增剪贴板导入（图片QR预填/单条预填/多条经Dialog批量入库），扩展manifest加clipboardRead"
```

---

## Part 6（spec §1）：Firefox MV3 迁移

### Task 9: manifest 切 MV3 + gecko id + min_version + 权限分支 + CI 断言

**Files:**
- Modify: `apps/extension/wxt.config.ts`（manifest 回调）
- Modify: `.github/workflows/build.yml`（Zip 步骤前加断言步骤）

**说明**：Task 8 已把 `clipboardRead` 加进双端 permissions；本任务将 `offscreen` 收窄为仅 chrome。

- [ ] **Step 1: 改 wxt.config.ts**

manifest 回调整体替换为：

```ts
  // manifest 按目标浏览器差异化：env.browser 来自 CLI -b/--browser（默认 chrome）。
  // 2026-09-23 起双目标统一 MV3（spec 批⑧ §1）：firefox 覆盖 manifest_version=3，
  // background 形态由 WXT 产出（event page 优先；若产出 service worker 亦兼容——代码已按事件驱动编写）
  manifest: ({ browser }) => ({
    name: 'TOTP 验证码工具',
    description: '纯前端 TOTP 验证码管理',
    icons: {
      16: '/icon/16.png',
      32: '/icon/32.png',
      48: '/icon/48.png',
      128: '/icon/128.png',
    },
    // offscreen 仅 Chrome MV3 合法（Firefox 未知权限会告警，且无该 API——运行时降级见 capabilities）；
    // clipboardRead：手动表单「从剪贴板导入」（双端）；其余权限说明见 git history
    permissions: [
      'storage', 'unlimitedStorage', 'clipboardWrite', 'activeTab', 'alarms', 'notifications', 'contextMenus', 'idle',
      ...(browser === 'chrome' ? ['offscreen'] : []),
      'clipboardRead',
    ],
    ...(browser === 'firefox'
      ? {
          manifest_version: 3,
          // 稳定 ID（AMO 一经发布不可改）：email 形式合规且表达 GitHub 归属；
          // min_version 140（2025 ESR 基线，MV3 所需 API 全齐：storage.session 115+/event page/SW 121+）
          browser_specific_settings: { gecko: { id: 'totp@bhxch.github.io', strict_min_version: '140.0' } },
          protocol_handlers: [
            { protocol: 'ext+otpauth', name: 'TOTP 验证码工具', uriTemplate: '/popup.html?uri=%s' },
          ],
        }
      : {}),
  }),
```

- [ ] **Step 2: 双目标构建 + 人工核对产物**

```bash
pnpm exec wxt build -b chrome && pnpm exec wxt build -b firefox
```

核对 `apps/extension/.output/firefox-mv3/manifest.json`：`manifest_version: 3`、无 `offscreen`、gecko id/min_version 正确、background 为 `scripts` 或 `service_worker` 之一且指向存在的文件；`chrome-mv3` 仍含 `offscreen`。

- [ ] **Step 3: CI 断言步骤**

`build.yml` extension job 的 `- name: Zip` 之前插入：

```yaml
      - name: Assert MV3 artifacts
        working-directory: apps/extension
        run: |
          node -e "
            const fs = require('fs');
            const m = JSON.parse(fs.readFileSync('.output/${{ matrix.browser }}-mv3/manifest.json', 'utf8'));
            if (m.manifest_version !== 3) throw new Error('manifest_version != 3: ' + m.manifest_version);
            const bg = m.background || {};
            const bgOk = (bg.service_worker && fs.existsSync('.output/${{ matrix.browser }}-mv3/' + bg.service_worker)) || (bg.scripts || []).every((s) => fs.existsSync('.output/${{ matrix.browser }}-mv3/' + s));
            if (!bgOk) throw new Error('background entry missing: ' + JSON.stringify(bg));
            if ('${{ matrix.browser }}' === 'firefox') {
              if (m.permissions.includes('offscreen')) throw new Error('firefox must not declare offscreen');
              const g = m.browser_specific_settings && m.browser_specific_settings.gecko || {};
              if (g.id !== 'totp@bhxch.github.io') throw new Error('bad gecko id: ' + g.id);
              if (g.strict_min_version !== '140.0') throw new Error('bad strict_min_version: ' + g.strict_min_version);
            } else if (!m.permissions.includes('offscreen')) {
              throw new Error('chrome must declare offscreen');
            }
          "
```

（firefox 产出 mv3 后，现有 `cd .output/${{ matrix.browser }}-mv3` 打包路径随之自然正确。）

- [ ] **Step 4: 提交**

```bash
git add apps/extension/wxt.config.ts .github/workflows/build.yml
git commit -m "feat(ext): firefox目标切MV3+正式gecko id+min_version 140

why: 消除 MV2 时代，双目标统一 MV3；修复 CI firefox 打包路径错配（firefox-mv2 vs 硬编码 mv3）
what: wxt.config firefox 覆盖 manifest_version=3/id/min_version、offscreen 收窄为 chrome 专属；CI 加产物 MV3 断言"
```

### Task 10: 扩展 API 命名空间统一（ext 通道）

**Files:**
- Create: `apps/extension/src/extApi.ts`
- Modify: `apps/extension/src/dekSession.ts`、`apps/extension/src/chromeStorage.ts`、`apps/extension/src/lockEnforcer.ts`、`apps/extension/src/conflictBadge.ts`、`apps/extension/entrypoints/background.ts`、`apps/extension/entrypoints/offscreen/offscreen.ts`、`apps/extension/entrypoints/popup/App.vue`、`apps/extension/entrypoints/options/App.vue`

**对 spec 1.3 的实现级修正（意图不变）**：spec 原文用 `import { browser } from 'wxt/browser'`。实施改用 `globalThis.browser ?? globalThis.chrome` 统一通道——Firefox MV3 全局 `browser`（Promise 风格）与 Chrome MV3 `chrome`（已全 Promise 化）行为对齐，且与现有 `lockEnforcer` 的 globalThis 探测模式一致、vitest 无宿主环境下天然 `undefined`，不引入 wxt polyfill 在测试环境的兼容风险。命名空间统一 + capabilities 收拢的 spec 意图完整保留。

- [ ] **Step 1: 新建 extApi.ts**

```ts
/** 扩展 API 统一通道（spec 批⑧ §1 差异处理模式第 3 层）：
 *  Firefox 全局 browser（Promise 风格）优先，Chrome MV3 chrome（已 Promise 化）兜底；
 *  桌面/测试等无扩展宿主环境为 undefined，调用点须先经 canXxx() 能力探测（capabilities 模式）。
 *  不 import 'wxt/browser'：vitest 无宿主环境下 polyfill 行为不可控，全局探测与
 *  lockEnforcer 既有模式一致（N1 注释口径）。 */
type ChromeLike = typeof chrome
export const ext: ChromeLike | undefined = (globalThis as { browser?: ChromeLike }).browser
  ?? (globalThis as { chrome?: ChromeLike }).chrome

/** offscreen 能力（仅 Chrome MV3；Firefox 无此 API——清剪贴板降级为本地不调度） */
export function canOffscreen(): boolean {
  return typeof ext?.offscreen !== 'undefined'
}

/** idle 能力（Firefox 无 idle 权限时缺失——空闲/锁屏自动锁定降级上报） */
export function canIdle(): boolean {
  return typeof ext?.idle?.queryState === 'function'
}

/** action 徽标能力（旧内核/上下文缺失时静默） */
export function canSetBadge(): boolean {
  return typeof ext?.action?.setBadgeText === 'function'
}

/** openPopup 能力（仅部分 Chromium 版本开放） */
export function canOpenPopup(): boolean {
  return typeof (ext?.action as { openPopup?: unknown } | undefined)?.openPopup === 'function'
}
```

- [ ] **Step 2: 机械替换各文件**

替换规则（全仓 `rg -n "chrome\." apps/extension --glob '!**/*.test.ts'` 逐处处理）：

- `chrome.` → `ext?.` 或 `ext.`（调用点已保证 `ext` 存在的上下文用 `ext.`；能力探测后才调用的用 `ext!.` 或前置判空）
- 文件头按所在目录加 import：`src/` 内文件为 `import { ext } from './extApi'`；`entrypoints/background.ts`、`entrypoints/popup/App.vue`、`entrypoints/options/App.vue`、`entrypoints/offscreen/offscreen.ts` 为 `import { ext } from '../../src/extApi'`（popup/options 的 canOffscreen 同源）
- 保留 `defineBackground` 等 WXT auto-import 不动

代表例——`chromeStorage.ts` 全文改后：

```ts
import type { StorageAdapter } from '@totp/core'
import { ext } from './extApi'

export function createChromeStorage(): StorageAdapter {
  return {
    async get(key) {
      if (!ext) return null
      const o = await ext.storage.local.get(key)
      return (o[key] as string | undefined) ?? null
    },
    async set(key, value) {
      if (!ext) return
      await ext.storage.local.set({ [key]: value })
    },
    async delete(key) {
      if (!ext) return
      await ext.storage.local.remove(key)
    },
  }
}
```

代表例——`popup/App.vue` 与 `options/App.vue` 的 `scheduleClipboardClear` 判断行替换：

```ts
  if (!canOffscreen()) return
```

（相应 import `canOffscreen`；`chrome.runtime.sendMessage` → `ext!.runtime.sendMessage`——同函数内 `canOffscreen()` 为真才到达。）

代表例——`conflictBadge.ts` 守卫行替换：

```ts
    if (!canSetBadge()) return
    void Promise.resolve(ext!.action!.setBadgeText({ text: count > 0 ? '!' : '' })).catch(() => {})
```

`lockEnforcer.ts` 的 `globalThis.chrome?.idle` 探测替换为 `canIdle()`（注释口径保留）；其内部 `chrome.idle.setDetectionInterval/queryState` → `ext!.idle!`（canIdle 为真路径）。`dekSession.ts`/`offscreen.ts`/`background.ts` 同规则机械替换（background.ts 的 `chrome.runtime.lastError` 回调惯用法保持结构，改为 `ext!.runtime.lastError`）。

- [ ] **Step 3: 回归**

Run: `pnpm --filter @totp/extension test && pnpm --filter @totp/extension typecheck`（typecheck 需先有 `.wxt/`，先跑一次 build）；`rg -n "chrome\." apps/extension --glob '!**/*.test.ts' --glob '!extApi.ts'` 应为 0 命中。

- [ ] **Step 4: 提交**

```bash
git add apps/extension/src/extApi.ts apps/extension/src/ apps/extension/entrypoints/
git commit -m "refactor(ext): 扩展API统一ext通道(browser??chrome)+能力探测收拢

why: 双目标 MV3 后 API 面一致，统一命名空间消除双端分支；散落的内联降级判断收拢为能力函数
what: 新增 extApi.ts（ext 通道+canOffscreen/canIdle/canSetBadge/canOpenPopup），全仓 chrome.* 机械替换（spec browser.*意图的实现级落地：globalThis 通道避免 polyfill 测试环境风险）"
```

### Task 11: 消费 capabilities 的调用点收尾核对

**Files:**
- Verify-only: 全仓 grep + 双目标构建 + 真机清单登记

- [ ] **Step 1: 核对四个能力调用点全部走 extApi**

`rg -n "offscreen|idle|setBadgeText|openPopup" apps/extension --glob '!**/*.test.ts'`——每个命中行应来自 `extApi.ts` 定义或 `canXxx()/ext!` 调用；`packages/ui` 中 `rg -n "chrome\.|browser\." packages/ui/src` 应为 0 命中（共享层无扩展 API 引用）。

- [ ] **Step 2: 双目标构建 + 真机验证登记**

Run: `pnpm exec wxt build -b chrome && pnpm exec wxt build -b firefox`（均绿）。
按 spec §10.4 真机清单在 Chrome 与 Firefox 140 各过一遍：popup/options 打开、锁定解锁、contextMenus 两菜单、空闲锁定（Chrome）、清剪贴板（Chrome 走 offscreen；Firefox 提示降级）、图片识别、剪贴板导入、badge。结果记入 PR 描述（真机环境不可用时在 PR 中明确标注未验证项）。

- [ ] **Step 3: 回归 + 提交（如有收尾改动）**

Run: `pnpm test`
Commit（仅当 Step 1/2 产生代码改动）:

```bash
git commit -m "fix(ext): capabilities收尾核对修正<具体点>

why: Part 6 收尾核对发现的遗漏
what: <具体改动>"
```

---

## Part 7（spec §7）：桌面 webview 三段式释放

### Task 12: release_policy.rs——配置读写 + 状态机纯函数 + cargo 单测

**Files:**
- Create: `apps/desktop/src-tauri/src/release_policy.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`（`mod release_policy;` 声明 + 两个命令 + invoke_handler 注册）
- Test: `release_policy.rs` 内 `#[cfg(test)] mod tests`

**对 spec 的说明**：状态机纯函数化（`advance` 不触 Tauri API），TrySuspend/destroy 等副作用留给 Task 13 的接线层——与仓库现有「纯函数直测 + temp_dir 隔离」测试风格一致。

- [ ] **Step 1: 写模块（含失败测试先行的 TDD 顺序：先写 tests 引用advance，再补实现，跑 cargo test 见证 红→绿）**

`release_policy.rs` 全文：

```rust
//! 桌面窗口资源释放策略（spec 批⑧ §7）：隐藏 → N 分钟暂停（WebView2 TrySuspend）→ 再 M 分钟销毁 webview 仅留托盘进程。
//! 配置存 settings.json `releasePolicy` 键（Rust 轨，合并写保留外来键）；分钟数 0=禁用该档。
//! 本模块为纯逻辑：配置解析/合并、状态机 advance；副作用（轮询线程/TrySuspend/destroy/重建）在 lib.rs 接线。

use serde::Deserialize;

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct ReleasePolicyConfig {
    /// 隐藏后多少分钟进入暂停档；0=禁用暂停档
    #[serde(default = "default_pause_minutes")]
    pub pause_minutes: u32,
    /// 暂停后多少分钟销毁；0=禁用销毁档（暂停禁用时从隐藏起算）
    #[serde(default = "default_destroy_minutes")]
    pub destroy_minutes: u32,
    /// 暂停档同时锁定 vault（默认关）
    #[serde(default)]
    pub lock_on_pause: bool,
    /// 销毁档锁定 vault（默认开；关=DEK 暂存 Rust 内存、重建后回注）
    #[serde(default = "default_true")]
    pub lock_on_destroy: bool,
}

fn default_pause_minutes() -> u32 { 5 }
fn default_destroy_minutes() -> u32 { 30 }
fn default_true() -> bool { true }

impl Default for ReleasePolicyConfig {
    fn default() -> Self {
        Self { pause_minutes: 5, destroy_minutes: 30, lock_on_pause: false, lock_on_destroy: true }
    }
}

/// 从 settings.json 文本解析（缺键/类型不符逐字段回默认；整体非 JSON 回全默认）
pub fn from_settings_text(text: &str) -> ReleasePolicyConfig {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(text) else {
        return ReleasePolicyConfig::default();
    };
    let Some(r) = v.get("releasePolicy") else {
        return ReleasePolicyConfig::default();
    };
    let d = ReleasePolicyConfig::default();
    ReleasePolicyConfig {
        pause_minutes: r.get("pauseMinutes").and_then(|x| x.as_u64()).map(|n| n as u32).unwrap_or(d.pause_minutes),
        destroy_minutes: r.get("destroyMinutes").and_then(|x| x.as_u64()).map(|n| n as u32).unwrap_or(d.destroy_minutes),
        lock_on_pause: r.get("lockOnPause").and_then(|x| x.as_bool()).unwrap_or(d.lock_on_pause),
        lock_on_destroy: r.get("lockOnDestroy").and_then(|x| x.as_bool()).unwrap_or(d.lock_on_destroy),
    }
}

/// 合并既有 settings.json 文本，只改 releasePolicy 键（根非对象时重建，与 devtools 合并同口径，不丢外来键）
pub fn merge_into_settings_text(existing: Option<&str>, cfg: &ReleasePolicyConfig) -> Result<String, String> {
    let mut obj: serde_json::Map<String, serde_json::Value> = existing
        .and_then(|t| serde_json::from_str::<serde_json::Value>(t).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default();
    obj.insert(
        "releasePolicy".into(),
        serde_json::json!({
            "pauseMinutes": cfg.pause_minutes,
            "destroyMinutes": cfg.destroy_minutes,
            "lockOnPause": cfg.lock_on_pause,
            "lockOnDestroy": cfg.lock_on_destroy,
        }),
    );
    serde_json::to_string_pretty(&serde_json::Value::Object(obj)).map_err(|e| e.to_string())
}

/// 状态机动作（接线层消费：Pause→TrySuspend；Destroy→锁库/暂存+destroy；None→无操作）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReleaseAction {
    None,
    Pause,
    Destroy,
}

/// 释放状态轨迹（接线层持有；任一窗口可见或窗口重建时调用 reset）
#[derive(Debug Default)]
pub struct ReleaseTrack {
    /// 全部窗口进入隐藏的时刻（可见时为 None）
    pub hidden_since: Option<std::time::Instant>,
    /// 暂停档发生时刻（Pause 动作产出时置位；TrySuspend 失败也置位——销毁计时照常推进，降级仅是「保持隐藏」）
    pub paused_at: Option<std::time::Instant>,
    /// 已销毁（main+mini 均不存在）：保持 None 动作直至 reset
    pub destroyed: bool,
}

impl ReleaseTrack {
    pub fn reset(&mut self) {
        self.hidden_since = None;
        self.paused_at = None;
        self.destroyed = false;
    }
}

fn minutes_to_secs(m: u32) -> u64 {
    m as u64 * 60
}

/// 状态机单步推进（纯函数，单测覆盖）。
/// 语义（spec §7.2）：暂停档从「全部隐藏」起算 pauseMinutes；销毁档从「暂停发生」起算 destroyMinutes，
/// 暂停档禁用（pause_minutes=0）或 Pause 后从隐藏点起算。任一窗口可见即重置并返回 None。
pub fn advance(
    track: &mut ReleaseTrack,
    cfg: &ReleasePolicyConfig,
    main_visible: bool,
    mini_visible: bool,
    now: std::time::Instant,
) -> ReleaseAction {
    if main_visible || mini_visible {
        track.reset();
        return ReleaseAction::None;
    }
    if track.destroyed {
        return ReleaseAction::None; // 已销毁：等重建路径 reset
    }
    let hidden_since = match track.hidden_since {
        Some(t) => t,
        None => {
            track.hidden_since = Some(now);
            return ReleaseAction::None;
        }
    };
    if let Some(paused_at) = track.paused_at {
        return if cfg.destroy_minutes > 0
            && now.duration_since(paused_at) >= std::time::Duration::from_secs(minutes_to_secs(cfg.destroy_minutes))
        {
            track.destroyed = true; // Destroy 由接线层落实（本调用后窗口将消失）
            ReleaseAction::Destroy
        } else {
            ReleaseAction::None
        };
    }
    let hidden_secs = now.duration_since(hidden_since).as_secs();
    if cfg.pause_minutes > 0 && hidden_secs >= minutes_to_secs(cfg.pause_minutes) {
        track.paused_at = Some(now);
        return ReleaseAction::Pause;
    }
    // 暂停档禁用时销毁从隐藏点起算（spec §7.5：pauseMinutes=0 时销毁计时从 hide 起算）
    if cfg.pause_minutes == 0 && cfg.destroy_minutes > 0 && hidden_secs >= minutes_to_secs(cfg.destroy_minutes) {
        track.destroyed = true;
        return ReleaseAction::Destroy;
    }
    ReleaseAction::None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(pause: u32, destroy: u32) -> ReleasePolicyConfig {
        ReleasePolicyConfig { pause_minutes: pause, destroy_minutes: destroy, lock_on_pause: false, lock_on_destroy: true }
    }

    #[test]
    fn visible_window_resets_track() {
        let mut t = ReleaseTrack::default();
        let t0 = std::time::Instant::now();
        assert_eq!(advance(&mut t, &cfg(5, 30), false, false, t0), ReleaseAction::None);
        assert!(t.hidden_since.is_some());
        assert_eq!(advance(&mut t, &cfg(5, 30), true, false, t0), ReleaseAction::None);
        assert!(t.hidden_since.is_none());
    }

    #[test]
    fn pause_fires_after_pause_minutes_then_destroy_after_destroy_minutes() {
        let mut t = ReleaseTrack::default();
        let t0 = std::time::Instant::now();
        let at = |secs: u64| t0 + std::time::Duration::from_secs(secs);
        assert_eq!(advance(&mut t, &cfg(5, 30), false, false, at(299)), ReleaseAction::None);
        assert_eq!(advance(&mut t, &cfg(5, 30), false, false, at(300)), ReleaseAction::Pause);
        assert!(t.paused_at.is_some());
        assert_eq!(advance(&mut t, &cfg(5, 30), false, false, at(300 + 1799)), ReleaseAction::None);
        assert_eq!(advance(&mut t, &cfg(5, 30), false, false, at(300 + 1800)), ReleaseAction::Destroy);
        assert!(t.destroyed);
        // 已销毁后恒 None，直到 reset（重建/show 路径）
        assert_eq!(advance(&mut t, &cfg(5, 30), false, false, at(99999)), ReleaseAction::None);
    }

    #[test]
    fn disabled_pause_lets_destroy_count_from_hide() {
        let mut t = ReleaseTrack::default();
        let t0 = std::time::Instant::now();
        let at = |secs: u64| t0 + std::time::Duration::from_secs(secs);
        assert_eq!(advance(&mut t, &cfg(0, 30), false, false, at(1799)), ReleaseAction::None);
        assert_eq!(advance(&mut t, &cfg(0, 30), false, false, at(1800)), ReleaseAction::Destroy);
    }

    #[test]
    fn all_disabled_means_never_release() {
        let mut t = ReleaseTrack::default();
        let t0 = std::time::Instant::now();
        let far = t0 + std::time::Duration::from_secs(86_400);
        assert_eq!(advance(&mut t, &cfg(0, 0), false, false, far), ReleaseAction::None);
        let mut t2 = ReleaseTrack::default();
        assert_eq!(advance(&mut t2, &cfg(5, 0), false, false, far), ReleaseAction::Pause); // 仅暂停档仍生效
        let mut t3 = ReleaseTrack::default();
        assert_eq!(advance(&mut t3, &cfg(0, 30), false, false, far), ReleaseAction::Destroy);
    }

    #[test]
    fn settings_roundtrip_defaults_and_merge_preserves_foreign_keys() {
        assert_eq!(from_settings_text("{}"), ReleasePolicyConfig::default());
        assert_eq!(from_settings_text("not json"), ReleasePolicyConfig::default());
        let merged = merge_into_settings_text(Some(r#"{"mcp":{"enabled":true},"devtools":{"enabled":false,"port":9222}}"#), &cfg(1, 2)).unwrap();
        let v: serde_json::Value = serde_json::from_str(&merged).unwrap();
        assert_eq!(v["mcp"]["enabled"], serde_json::json!(true));
        assert_eq!(v["releasePolicy"]["pauseMinutes"], serde_json::json!(1));
        assert_eq!(v["releasePolicy"]["destroyMinutes"], serde_json::json!(2));
    }
}
```

- [ ] **Step 2: lib.rs 接线（模块声明 + 命令）**

`lib.rs` 模块声明区加 `mod release_policy;`；devtools 命令后加：

```rust
/// 释放策略读/写（spec 批⑧ §7.5；settings.json `releasePolicy` 键，合并写保留外来键）
#[tauri::command]
fn release_policy_get<R: Runtime>(app: AppHandle<R>) -> Result<serde_json::Value, String> {
    let text = settings_path(&app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .unwrap_or_else(|| "{}".into());
    let cfg = release_policy::from_settings_text(&text);
    Ok(serde_json::json!({
        "pauseMinutes": cfg.pause_minutes,
        "destroyMinutes": cfg.destroy_minutes,
        "lockOnPause": cfg.lock_on_pause,
        "lockOnDestroy": cfg.lock_on_destroy,
    }))
}

#[tauri::command]
fn release_policy_set<R: Runtime>(
    app: AppHandle<R>,
    pauseMinutes: u32,
    destroyMinutes: u32,
    lockOnPause: bool,
    lockOnDestroy: bool,
) -> Result<(), String> {
    let path = settings_path(&app).ok_or("无法定位 settings.json".to_string())?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let cfg = release_policy::ReleasePolicyConfig {
        pause_minutes: pauseMinutes,
        destroy_minutes: destroyMinutes,
        lock_on_pause: lockOnPause,
        lock_on_destroy: lockOnDestroy,
    };
    let text = release_policy::merge_into_settings_text(std::fs::read_to_string(&path).ok().as_deref(), &cfg)?;
    write_text_atomic(&path, &text)
}
```

invoke_handler 列表 `devtools_set_config,` 后加 `release_policy_get, release_policy_set,`。

- [ ] **Step 3: 跑测试**

Run: `cd apps/desktop/src-tauri && cargo test release_policy`
预期：PASS（5 个用例）。

- [ ] **Step 4: 提交**

```bash
git add apps/desktop/src-tauri/src/release_policy.rs apps/desktop/src-tauri/src/lib.rs
git commit -m "feat(desktop): 释放策略配置读写+状态机纯函数（TDD）

why: 三段式释放（隐藏→暂停→销毁）需可测的配置与状态机底座
what: release_policy.rs 配置解析/合并/advance 状态机+cargo单测，release_policy_get/set 命令注册"
```

### Task 13: 释放接线——tick 轮询 + TrySuspend + destroy/重建

**Files:**
- Modify: `apps/desktop/src-tauri/src/lib.rs`（static 状态、tick 线程、suspend/destroy/rebuild、托盘/快捷键入口接 ensure）
- Modify: `apps/desktop/src-tauri/Cargo.toml`（显式声明 webview2-com，版本对齐依赖树）

- [ ] **Step 1: 查 webview2-com 版本并声明依赖**

```bash
cd apps/desktop/src-tauri && cargo tree -i webview2-com 2>/dev/null | head -5
```

以树中版本为准（如 `0.34.x`）在 `[target.'cfg(windows)'.dependencies]` 加 `webview2-com = "0.34"`（版本号按 cargo tree 输出改）。

- [ ] **Step 2: lib.rs 接线代码**

static 区（`LAST_FOCUS_HIDE` 附近）加：

```rust
/// 释放策略状态轨迹（tick 线程独占读写；reset 由 tick 内可见性判定驱动）
static RELEASE_TRACK: Mutex<release_policy::ReleaseTrack> = Mutex::new(release_policy::ReleaseTrack::new);
```

（`ReleaseTrack` 需补 `pub const fn new() -> Self { Self { hidden_since: None, paused_at: None, destroyed: false } }`——在 Task 12 的模块中追加此构造器与对应测试无行为变化。）

锁定/暂存通知静态（Task 14 消费事件，此处只发）不需要 static；DEK 暂存槽在 Task 14 加。

setup 末尾（tray 装配后）启动 tick 线程：

```rust
            // 释放策略 tick：30s 轮询窗口可见性驱动三段释放（spec 批⑧ §7.3——轮询覆盖所有隐藏路径：
            // 关窗拦截/mini 失焦/前端「隐藏到托盘」，无事件盲区；配置每 tick 现读，改设置即时生效）
            let release_handle = app.handle().clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(Duration::from_secs(30));
                release_tick(&release_handle);
            });
```

命令区/辅助区加（文件头若尚无 `use tauri::Emitter;` 需补——Tauri 2 的 `emit` 为 Emitter trait 方法）：

```rust
/// 释放 tick 单步：读配置→窗口可见性→advance→执行副作用
fn release_tick(app: &AppHandle) {
    let cfg = release_policy::from_settings_text(
        &settings_path(app)
            .and_then(|p| std::fs::read_to_string(p).ok())
            .unwrap_or_else(|| "{}".into()),
    );
    let visible = |label: &str| app.get_webview_window(label).map(|w| w.is_visible().unwrap_or(false)).unwrap_or(false);
    let action = {
        let mut track = RELEASE_TRACK.lock().expect("release track poisoned");
        release_policy::advance(&mut track, &cfg, visible("main"), visible("mini"), Instant::now())
    };
    match action {
        release_policy::ReleaseAction::Pause => {
            if cfg.lock_on_pause {
                let _ = app.emit("force-lock", ());
            }
            for label in ["main", "mini"] {
                try_suspend_window(app, label);
            }
        }
        release_policy::ReleaseAction::Destroy => destroy_releasable_windows(app, &cfg),
        release_policy::ReleaseAction::None => {}
    }
}

/// 暂停档：WebView2 TrySuspend（要求窗口不可见）；失败/非 Windows 静默降级为维持隐藏
#[cfg(windows)]
fn try_suspend_window(app: &AppHandle, label: &str) {
    let Some(w) = app.get_webview_window(label) else { return };
    let _ = w.with_webview(move |webview| {
        use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_6;
        unsafe {
            let Ok(core) = webview.controller().CoreWebView2() else { return };
            let Ok(wv6) = core.cast::<ICoreWebView2_6>() else { return };
            // 失败（如已挂起/不可见条件不满足）返回 false：静默，销毁档计时照常推进
            let _ = wv6.TrySuspend();
        }
    });
}

#[cfg(not(windows))]
fn try_suspend_window(_app: &AppHandle, _label: &str) {}

/// 销毁档：锁库或请求 DEK 暂存 → destroy main+mini（进程与托盘保留）
fn destroy_releasable_windows(app: &AppHandle, cfg: &release_policy::ReleasePolicyConfig) {
    if cfg.lock_on_destroy {
        let _ = app.emit("force-lock", ());
    } else {
        // 不锁库：给前端 1s 窗口执行 stash_dek（Task 14 的监听器），再销毁
        let _ = app.emit("stash-dek-request", ());
        std::thread::sleep(Duration::from_secs(1));
    }
    for label in ["main", "mini"] {
        if let Some(w) = app.get_webview_window(label) {
            let _ = w.destroy();
        }
    }
}

/// 按需重建窗口（tauri.conf.json 同参）；返回是否发生了重建（重建后前端冷启动，自动走 DEK 回注）
fn ensure_window(app: &AppHandle, label: &str) -> bool {
    if app.get_webview_window(label).is_some() {
        return false;
    }
    let built = match label {
        "main" => tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::App("index.html".into()))
            .title("TOTP 验证码工具")
            .inner_size(760.0, 560.0)
            .visible(false)
            .build(),
        "mini" => tauri::WebviewWindowBuilder::new(app, "mini", tauri::WebviewUrl::App("mini.html".into()))
            .title("TOTP")
            .inner_size(320.0, 420.0)
            .visible(false)
            .skip_taskbar(true)
            .build(),
        _ => return false,
    };
    if built.is_ok() {
        if let Ok(mut track) = RELEASE_TRACK.lock() {
            track.reset();
        }
        true
    } else {
        false
    }
}
```

`toggle_mini` 与 `show_main` 开头各加一行（已销毁则先重建）：

```rust
    ensure_window(app, "mini");   // toggle_mini 内
    ensure_window(app, "main");   // show_main 内
```

（`show_main` 现有实现的 get_webview_window 判空逻辑在 ensure 之后必然命中。）

- [ ] **Step 3: 编译 + 真机验证**

Run: `cd apps/desktop/src-tauri && cargo test && cargo build`
真机（Windows）：设置 5/30 → 隐藏主窗 → 5 分钟后任务管理器看 GPU/进程活跃下降（TrySuspend）→ 30 分钟后 webview 窗口消失、托盘仍在 → 点托盘左键重建并显示。mac/Linux 编译通过、暂停档 no-op 即可。

- [ ] **Step 4: 提交**

```bash
git add apps/desktop/src-tauri/src/lib.rs apps/desktop/src-tauri/src/release_policy.rs apps/desktop/src-tauri/Cargo.toml apps/desktop/src-tauri/Cargo.lock
git commit -m "feat(desktop): 释放策略接线——tick轮询+TrySuspend+销毁重建

why: 三段式释放的执行层：隐藏后按配置暂停渲染直至销毁webview仅留托盘（spec 批⑧ §7.2-7.3）
what: 30s tick 轮询驱动 advance 状态机，Windows TrySuspend 暂停、destroy/按参重建 main/mini，托盘与快捷键入口先 ensure_window"
```

### Task 14: 锁库联动 + DEK 暂存回注 + 前端设置卡

**Files:**
- Modify: `apps/desktop/src-tauri/src/lib.rs`（stash/take 命令 + quit/锁库清槽）
- Create: `packages/ui/src/components/releasePlatform.ts`
- Modify: `packages/ui/src/pages/NavigationShell.vue`（props releasePlatform → settings 页分发）
- Modify: `packages/ui/src/pages/SettingsPage.vue`（释放策略卡）
- Modify: `apps/desktop/src/App.vue`（platform 桥接 + force-lock/stash-dek-request 监听 + 重建回注）
- Modify: `packages/ui/src/i18n/locales/zh/common.json`、`en/common.json`（settingsPage 段加键）
- Test: `packages/ui/test/releasePolicy.test.ts`（分钟校验纯函数）

**Interfaces:**
- Consumes: Task 12 的 `release_policy_get/set`；Task 13 的 `force-lock`/`stash-dek-request` 事件。
- Produces:
  - Tauri 命令 `stash_dek(dek: string)` / `take_stashed_dek() -> Option<String>`
  - `ReleasePolicyDto { pauseMinutes: number; destroyMinutes: number; lockOnPause: boolean; lockOnDestroy: boolean }`、`ReleasePlatform { getConfig; setConfig }`（仿 DevtoolsPlatform）
  - i18n 键 `settingsPage.release*`（见 Step 5）

**前置说明（store 探查）**：DEK 回注需要 store 暴露「当前 DEK（base64）」读取与「以 DEK 恢复解锁」两个口。先执行：

```bash
rg -n "dekPersist|dek" packages/ui/src/store.ts | head -40
```

若 store 已有等价访问器（如 `store.dek`/`unlockWithDek`）直接用；否则在 `packages/ui/src/store.ts` 增加最小口：`getDekBase64(): string | null`（读 dekPersist 内存值，未解锁 null）与 `restoreFromDek(dekBase64: string): Promise<void>`（等价解锁后状态：写 dekPersist + 刷新 vault + 置解锁态，实现按 store 解锁路径的最短复用）。下述 App.vue 代码按 `store.getDekBase64()/store.restoreFromDek` 书写，实施时按探查结果对齐实际命名，并在 PR 描述注明。

- [ ] **Step 1: Rust stash 命令**

lib.rs static 区加：

```rust
/// 释放销毁档「不锁库」路径的 DEK 暂存槽（仅进程内存，不落盘）：destroy 前前端 stash，重建后前端 take 回注；锁库/退出时清除
static STASHED_DEK: Mutex<Option<String>> = Mutex::new(None);
```

命令区加（并注册进 invoke_handler）：

```rust
/// 前端在 stash-dek-request 事件后上报当前会话 DEK（base64）；只进内存槽
#[tauri::command]
fn stash_dek(dek: String) {
    if let Ok(mut s) = STASHED_DEK.lock() {
        *s = Some(dek);
    }
}

/// 重建后前端启动期取回暂存 DEK（取即清）；无暂存返回 null
#[tauri::command]
fn take_stashed_dek() -> Option<String> {
    STASHED_DEK.lock().ok().and_then(|mut s| s.take())
}
```

托盘菜单 `"quit"` 分支与 `force-lock` 发射点（release_tick Pause 分支）追加清槽：`if let Ok(mut s) = STASHED_DEK.lock() { *s = None; }`（quit 在 `clear_clipboard_if_staged(app);` 后加；force-lock 处同）。

- [ ] **Step 2: releasePlatform.ts（仿 devtoolsPlatform.ts）**

```ts
/** 释放策略 DTO（与 Rust release_policy_get/set 契约对齐；缺省 5/30/false/true） */
export interface ReleasePolicyDto {
  pauseMinutes: number
  destroyMinutes: number
  lockOnPause: boolean
  lockOnDestroy: boolean
}

/** 释放平台能力（桌面宿主桥接 release_policy_* 命令；扩展/Web 宿主不提供，设置卡不渲染） */
export interface ReleasePlatform {
  getConfig: () => Promise<ReleasePolicyDto>
  setConfig: (cfg: ReleasePolicyDto) => Promise<void>
}

/** 分钟数校验：0-1440 整数（0=禁用该档）；返回 null 合法，否则为错误 i18n key 参数 */
export function validateReleaseMinutes(v: number): boolean {
  return Number.isInteger(v) && v >= 0 && v <= 1440
}
```

`packages/ui/src/index.ts` 追加 `export type { ReleasePolicyDto, ReleasePlatform } from './components/releasePlatform'` 与 `export { validateReleaseMinutes } from './components/releasePlatform'`。

- [ ] **Step 3: 失败测试**

新建 `packages/ui/test/releasePolicy.test.ts`：

```ts
import { validateReleaseMinutes } from '../src/components/releasePlatform'
import { describe, expect, it } from 'vitest'

describe('validateReleaseMinutes', () => {
  it('0（禁用）与常规值合法', () => {
    expect(validateReleaseMinutes(0)).toBe(true)
    expect(validateReleaseMinutes(5)).toBe(true)
    expect(validateReleaseMinutes(1440)).toBe(true)
  })
  it('负数/小数/超一天非法', () => {
    expect(validateReleaseMinutes(-1)).toBe(false)
    expect(validateReleaseMinutes(1.5)).toBe(false)
    expect(validateReleaseMinutes(1441)).toBe(false)
  })
})
```

Run: `pnpm --filter @totp/ui test -- releasePolicy` → 红（模块不存在）→ 实现（Step 2 已含）→ 绿。

- [ ] **Step 4: SettingsPage 释放策略卡**

NavigationShell：props 加 `releasePlatform?: ReleasePlatform | null`（默认 null），settings 分发 case 加 `releasePlatform: p.releasePlatform ?? null`。SettingsPage：props 同加；在 MCP 卡之前加卡（加载/保存模式仿其开发者卡 `devtoolsPlatform` 的 getConfig→ref→change 提交）：

```html
    <MdCard v-if="showDesktop && releasePlatform" class="block">
      <h2>{{ t('settingsPage.releaseTitle') }}</h2>
      <div class="row">
        <span>{{ t('settingsPage.releasePause') }}</span>
        <MdTextField
          class="release-min" type="number" min="0" max="1440" :label="t('settingsPage.releaseMinutes')"
          :model-value="String(releaseCfg.pauseMinutes)" @change="onReleaseMinutes('pauseMinutes', $event)"
        />
        <MdSwitch :model-value="releaseCfg.lockOnPause" :aria-label="t('settingsPage.releaseLockOnPause')" @update:model-value="onReleaseFlag('lockOnPause', $event)" />
        <span>{{ t('settingsPage.releaseLockOnPause') }}</span>
      </div>
      <div class="row">
        <span>{{ t('settingsPage.releaseDestroy') }}</span>
        <MdTextField
          class="release-min" type="number" min="0" max="1440" :label="t('settingsPage.releaseMinutes')"
          :model-value="String(releaseCfg.destroyMinutes)" @change="onReleaseMinutes('destroyMinutes', $event)"
        />
        <MdSwitch :model-value="releaseCfg.lockOnDestroy" :aria-label="t('settingsPage.releaseLockOnDestroy')" @update:model-value="onReleaseFlag('lockOnDestroy', $event)" />
        <span>{{ t('settingsPage.releaseLockOnDestroy') }}</span>
      </div>
      <p class="hint">{{ t('settingsPage.releaseHint') }}</p>
    </MdCard>
```

script 相应（`const releaseCfg = reactive<ReleasePolicyDto>({ pauseMinutes: 5, destroyMinutes: 30, lockOnPause: false, lockOnDestroy: true })`；onMounted 时 `props.releasePlatform?.getConfig().then(...)` 填充；`onReleaseMinutes` 校验 `validateReleaseMinutes` 非法回显当前值、合法则 `setConfig`；`onReleaseFlag` 直接 setConfig）。文案语义在 i18n 里写清（Step 5 的 hint）。

- [ ] **Step 5: i18n 键（zh / en）**

zh `settingsPage` 段加：

```json
    "releaseTitle": "窗口资源释放",
    "releasePause": "隐藏后暂停（分钟）",
    "releaseDestroy": "暂停后销毁窗口（分钟）",
    "releaseMinutes": "分钟（0=禁用）",
    "releaseLockOnPause": "暂停时锁定",
    "releaseLockOnDestroy": "销毁时锁定",
    "releaseHint": "关闭窗口后先暂停渲染以省资源，超时后销毁窗口仅保留托盘进程，点托盘/快捷键自动重建；暂停期间空闲锁定暂不生效。「销毁时锁定」关闭时，解锁状态会在重建后自动恢复（密钥仅暂存本机进程内存）。",
```

en 对应（结构相同）：

```json
    "releaseTitle": "Window resource release",
    "releasePause": "Pause after hiding (minutes)",
    "releaseDestroy": "Destroy window after pause (minutes)",
    "releaseMinutes": "minutes (0 = disabled)",
    "releaseLockOnPause": "Lock on pause",
    "releaseLockOnDestroy": "Lock on destroy",
    "releaseHint": "After closing the window, rendering is paused to save resources; after the timeout the window is destroyed leaving only the tray process — click the tray or use the shortcut to rebuild. Idle lock does not fire while paused. With \"Lock on destroy\" off, the unlocked state is restored after rebuild (the key is held only in local process memory).",
```

- [ ] **Step 6: App.vue 桥接**

platform 定义区（mcpPlatform/devtoolsPlatform 旁）加：

```ts
const releasePlatform: ReleasePlatform = {
  getConfig: () => invoke('release_policy_get') as Promise<ReleasePolicyDto>,
  setConfig: (cfg) => invoke('release_policy_set', {
    pauseMinutes: cfg.pauseMinutes, destroyMinutes: cfg.destroyMinutes, lockOnPause: cfg.lockOnPause, lockOnDestroy: cfg.lockOnDestroy,
  }) as Promise<void>,
}
```

NavigationShell 挂 `:release-platform="releasePlatform"`。事件与回注（store 就绪后接线，伪码按前置说明的 store 口对齐）：

```ts
// 释放策略联动（spec 批⑧ §7.4）：暂停/销毁锁库 + 不锁库路径的 DEK 暂存回注
listen('force-lock', () => {
  void store.lock()
}).catch(() => {})
listen('stash-dek-request', () => {
  const dek = store.getDekBase64()
  if (dek) void invoke('stash_dek', { dek }).catch(() => {})
}).catch(() => {})
// 重建/冷启动：有暂存 DEK 则恢复解锁态（锁库路径无暂存，自然落到锁定页）
const stashed = await invoke<string | null>('take_stashed_dek').catch(() => null)
if (stashed) await store.restoreFromDek(stashed)
```

（`listen` 来自 `@tauri-apps/api/event`，import 按文件现有惯例；回注调用点放在 store 初始化完成后、首个页面渲染前。锁库/退出时的暂存槽清除在 Rust 侧完成（Task 14 Step 1），前端不重复处理。）

- [ ] **Step 7: 回归 + 真机 + 提交**

Run: `pnpm test && cd apps/desktop/src-tauri && cargo test`
真机：改设置即时生效；锁库开=重建后锁定页；锁库关=重建后免解锁；暂停期间空闲锁定不生效（hint 已说明）。

```bash
git add packages/ui/src/components/releasePlatform.ts packages/ui/src/pages/NavigationShell.vue packages/ui/src/pages/SettingsPage.vue packages/ui/src/store.ts packages/ui/src/index.ts apps/desktop/src/App.vue apps/desktop/src-tauri/src/lib.rs packages/ui/src/i18n/locales/zh/common.json packages/ui/src/i18n/locales/en/common.json packages/ui/test/releasePolicy.test.ts
git commit -m "feat(desktop): 释放策略锁库双开关+DEK暂存回注+设置卡

why: 每档是否锁库由用户选择（spec 批⑧ §7.4-7.5），销毁不锁库需跨 webview 生命周期的会话恢复
what: stash/take_stashed_dek 内存槽命令、force-lock/stash-dek-request 事件联动、SettingsPage 释放卡与 releasePlatform 桥接、store DEK 读写口、zh/en 文案"
```

---

## Part 8（spec §8）：README 双语化与文档链接化

### Task 15: README 全面刷新 + README_en.md

**Files:**
- Modify: `README.md`（全文重写）
- Create: `README_en.md`（全量英文版）

**前置依赖**：Task 9/13/14 已落定——README 中的事实以最终代码为准（MV3、min_version 140、`clipboardRead`、释放策略设置卡、剪贴板导入按钮）。

- [ ] **Step 1: 重写 README.md**

结构（章节顺序固定，中英一致）：

1. 顶部语言行：`[简体中文](README.md) | [English](README_en.md)`
2. 标题 + 一句话简介（纯前端 TOTP 管理：浏览器扩展 Chrome/Edge/Firefox + Tauri 桌面）
3. 特性列表（沿用现有四条，更新：导入「17+ 格式」、安全、数据各条）
4. 安装（扩展：AMO/自建 zip；桌面：Release 下载）
5. 快速上手（添加条目：手动/otpauth 链接/从图片识别/从剪贴板导入；锁定）
6. 桌面版专节（现有内容 + 释放策略：三段语义、默认 5/30 分钟、锁库双开关与「不锁库=重建自动恢复解锁、密钥仅进程内存」说明）
7. MCP 专节（新增，素材取自 `docs/review/2026-09-21-desktop-mcp-real-machine-test.md` L93-109 与设置页事实）：默认端口 47215、仅 127.0.0.1、Bearer token、四档 gate、工具清单（list_accounts/get_code 只读 + trigger_backup/trigger_sync 可选暴露）、`.mcp.json` 示例（注明 token 在设置页 MCP 卡复制，连接片段已含真 token）
8. 安全（沿用现有「vault 落盘加密/解锁方式/锁定策略/剪贴板清空」各小节）
9. 备份与云同步（沿用现有结构）
10. 浏览器同步（沿用）
11. 导入（沿用「支持格式/去重判定树」，格式清单与扩展内帮助文案一致）
12. 图标（沿用）
13. 开发与构建（现有命令 + 双目标产物路径改为 `.output/chrome-mv3` 与 `.output/firefox-mv3`；Firefox min_version 140）
14. 架构与文档索引：`docs/` 结构说明，**全部用 markdown 相对链接**（如 `[设计文档](docs/plans/2026-09-13-totp-tool-design.md)`、`[审查报告](docs/review/)`）
15. 已知限制（更新：删除「Firefox MV2」相关表述，改为 MV3 下降级行为——offscreen/Idle 仍缺、其余同现状；其余条目保留核对后保留）
16. License（与仓库现有 LICENSE 一致；若无 LICENSE 文件则本节省略）

硬性要求：文内所有文档引用一律 `[文本](相对路径)` 链接格式（现状是反引号纯文本路径）；事实更新点逐条核对代码（不得凭记忆写版本号）。

- [ ] **Step 2: 写 README_en.md**

按 Step 1 结构逐节全量英文翻译（技术名词保留原文：TOTP、otpauth、Argon2id、WebDAV 等；UI 文案给英文对照——以 `packages/ui/src/i18n/locales/en/common.json` 的官方英文名为准）。顶部语言行同 Step 1。

- [ ] **Step 3: 链接校验**

```bash
node -e "
const fs = require('fs');
for (const f of ['README.md', 'README_en.md']) {
  const text = fs.readFileSync(f, 'utf8');
  const links = [...text.matchAll(/\]\(([^)#]+)\)/g)].map((m) => m[1]).filter((p) => !/^https?:/.test(p));
  const missing = links.filter((p) => !fs.existsSync(p));
  if (missing.length) { console.error(f, 'broken:', missing); process.exit(1); }
  console.log(f, links.length, 'relative links OK');
}
"
```

预期：两文件均 `relative links OK`。

- [ ] **Step 4: 中英结构对照走查 + 提交**

走查：两文件章节一一对应、互链可达、MCP 示例与设置页一致、构建命令可复现（`pnpm exec wxt build -b firefox` 产物路径 `firefox-mv3`）。

```bash
git add README.md README_en.md
git commit -m "docs: README全面刷新+新增README_en双语互链

why: README 缺 MCP/释放策略/剪贴板导入等新能力且引用为纯文本路径，无英文版
what: 中文版结构重排+补 MCP 章节+同步 MV3/释放策略/剪贴板导入事实+全链接化；新增 README_en.md 全量英文版并互相链接"
```

---

## 收尾核对（全计划完成时）

- [ ] `pnpm test` 四包全绿；`cd apps/desktop/src-tauri && cargo test` 全绿；`pnpm typecheck` 通过（extension 需先 build）。
- [ ] `rg -n "chrome\." apps/extension --glob '!**/*.test.ts' --glob '!extApi.ts'` 0 命中；`rg -n "example.local" apps/extension` 0 命中。
- [ ] spec §10.4 真机清单逐项过一遍（Chrome、Firefox 140、Windows 桌面、mac/Linux 编译），结果登记 PR。
- [ ] 未完成/降级项如实登记 PR（如真机不可达项），不静默跳过。
