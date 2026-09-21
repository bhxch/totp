# UI 修复与 Entry 交互重构 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 4 处 UI 样式问题与弹窗滚动可访问性，并把 entry 列表重构为「验证码默认打码、单击复制、双击显示 8 秒」，三端（desktop 主窗 / mini 小窗 / 扩展 popup）经共享组件自动一致。

**Architecture:** 样式修复落在共享组件（MdSegmentedButton / MdDialog / SecurityCard / SettingsPage）；entry 交互重构核心在共享组件 `OtpListItem.vue`，三宿主仅清理 🔑 揭示容器的死代码。

**Tech Stack:** Vue 3 `<script setup>` + vitest + @vue/test-utils（packages/ui）；无新依赖。

**Spec:** `docs/superpowers/specs/2026-09-21-ui-fixes-entry-interaction-design.md`

## Global Constraints

- 验证码打码形态恒为 `••• •••`；双击显示时长恒 8000ms（spec §6，不可配置）。
- 复制链路必须走宿主 `emit('copy')`，不得直写 `navigator.clipboard`（CodesPage.vue:186 审查 I14 既有约束）。
- HOTP 复制后 counter 递增语义不变（CodesPage `onCopy`）。
- i18n 双语：键改动须同时改 `packages/ui/src/i18n/locales/zh/common.json` 与 `en/common.json`。
- 不新增任何依赖；不改 MdCard 全局布局（间距修复局部化）。

---

### Task 1: MdSegmentedButton 选中段圆角（条目 7）

**Files:**
- Modify: `packages/ui/src/components/md/MdSegmentedButton.vue`（style 块，`.md-seg__item` 附近）

**Interfaces:**
- Consumes: 无
- Produces: 无接口变化（纯 CSS）

- [ ] **Step 1: 修改样式**

在 `.md-seg__item` 规则后追加：

```css
.md-seg__item:first-child { border-radius: 100px 0 0 100px; }
.md-seg__item:last-child { border-radius: 0 100px 100px 0; }
.md-seg__item:only-child { border-radius: 100px; }
```

- [ ] **Step 2: 回归测试**

Run: `pnpm --filter @totp/ui test`
Expected: 全绿（纯 CSS 无逻辑变化）

- [ ] **Step 3: Commit**

```bash
git add packages/ui/src/components/md/MdSegmentedButton.vue
git commit -m "fix(ui): 分段按钮选中段贴合胶囊圆角（验收条目7）"
```

### Task 2: 外观卡片行间距（条目 8）

**Files:**
- Modify: `packages/ui/src/pages/SettingsPage.vue`（92-114 行的行结构 + style 块）

**Interfaces:**
- Consumes: 无
- Produces: 无接口变化

- [ ] **Step 1: 包裹行容器**

外观主题卡片（含 MdSegmentedButton 行、Theme color 行、AMOLED 行）default slot 内容包一层：

```html
<div class="appearance-rows">
  <!-- 现有 .row 三行原样移入 -->
</div>
```

style 块追加：

```css
.appearance-rows { display: flex; flex-direction: column; gap: 16px; }
.appearance-rows .row { min-height: 32px; }
```

- [ ] **Step 2: 回归测试**

Run: `pnpm --filter @totp/ui test && pnpm --filter @totp/ui typecheck`
Expected: 全绿

- [ ] **Step 3: Commit**

```bash
git add packages/ui/src/pages/SettingsPage.vue
git commit -m "fix(ui): 外观卡片行距统一 16px 并对齐行高（验收条目8）"
```

### Task 3: 安全卡片解锁方式按钮间距（条目 9）

**Files:**
- Modify: `packages/ui/src/components/SecurityCard.vue`（style 块 `.unlock-methods`）

**Interfaces:**
- Consumes: 无
- Produces: 无接口变化

- [ ] **Step 1: 修改样式**

`.unlock-methods` 改为：

```css
.unlock-methods { display: flex; flex-direction: column; gap: 12px; }
```

（保留该类原有其他声明，仅补齐布局属性；若已有 display 声明则合并。）

- [ ] **Step 2: 回归测试**

Run: `pnpm --filter @totp/ui test`
Expected: 全绿（SecurityCard 现有测试 `securityCard.plan16.test.ts` 等通过）

- [ ] **Step 3: Commit**

```bash
git add packages/ui/src/components/SecurityCard.vue
git commit -m "fix(ui): 解锁方式区块按钮纵向间距 12px（验收条目9）"
```

### Task 4: OtpListItem 交互重构（条目 3 核心）

**Files:**
- Modify: `packages/ui/src/components/OtpListItem.vue`（全文改造）
- Create: `packages/ui/test/OtpListItem.interaction.test.ts`

**Interfaces:**
- Consumes: 现有 props `{ entry, code, remaining, progress, error?, icon? }`
- Produces: emits 变为 `{ copy: []; qr: []; context: [event: MouseEvent] }`（**移除 `reveal`**）；新增打码常量 `MASK_CODE = '••• •••'`；行为：单击/Enter=copy、双击=显示 8000ms、`.copy` 按钮=copy（不冒泡）

- [ ] **Step 1: 写失败测试**

`packages/ui/test/OtpListItem.interaction.test.ts`：

```ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import OtpListItem from '../src/components/OtpListItem.vue'
import { createTestI18n } from './helpers/i18n'

const entry = {
  uuid: 'u1', issuer: 'GitHub', label: 'a@b.c', type: 'totp', secret: 'JBSWY3DP',
  algorithm: 'SHA1', digits: 6, period: 30, icon: '', pinned: false, order: 0, tags: [],
} as never

function mountItem(code = '123456') {
  return mount(OtpListItem, {
    props: { entry, code, remaining: 30, progress: 1 },
    global: { plugins: [createTestI18n()] },
  })
}

afterEach(() => vi.useRealTimers())

describe('OtpListItem 打码与复制', () => {
  it('默认打码，不渲染真实验证码', () => {
    const w = mountItem()
    expect(w.text()).not.toContain('123456')
    expect(w.text()).toContain('••• •••')
  })

  it('单击条目 emit copy', async () => {
    const w = mountItem()
    await w.find('.otp-item').trigger('click')
    expect(w.emitted('copy')).toHaveLength(1)
  })

  it('复制按钮 emit copy 且不冒泡重复触发', async () => {
    const w = mountItem()
    await w.find('button.copy').trigger('click')
    expect(w.emitted('copy')).toHaveLength(1)
  })

  it('双击显示真实码，8 秒后自动打回', async () => {
    vi.useFakeTimers()
    const w = mountItem()
    await w.find('.otp-item').trigger('dblclick')
    expect(w.text()).toContain('123 456')
    vi.advanceTimersByTime(8000)
    await vi.runOnlyPendingTimersAsync()
    expect(w.text()).toContain('••• •••')
    expect(w.text()).not.toContain('123456')
  })

  it('不再提供 🔑 reveal 按钮与 reveal 事件', async () => {
    const w = mountItem()
    expect(w.find('.reveal').exists()).toBe(false)
    await w.find('.otp-item').trigger('dblclick')
    expect(w.emitted('reveal')).toBeUndefined()
  })

  it('INVALID 状态不受打码影响（保留错误提示可见）', () => {
    const w = mountItem('INVALID')
    expect(w.find('.code.invalid').exists()).toBe(true)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm --filter @totp/ui test -- OtpListItem.interaction`
Expected: FAIL（无打码逻辑、reveal 按钮仍存在）

- [ ] **Step 3: 实现改造**

`OtpListItem.vue` script setup 段：

```ts
import { computed, onScopeDispose, ref } from 'vue'

const emit = defineEmits<{ copy: []; qr: []; context: [event: MouseEvent] }>()

/** 验收条目3：6 位码默认打码；双击显示 8 秒后自动打回（spec §6 固定时长，不可配置） */
const MASK_CODE = '••• •••'
const REVEAL_MS = 8000
const revealed = ref(false)
let revealTimer: ReturnType<typeof setTimeout> | null = null
function onDblclick(): void {
  revealed.value = true
  if (revealTimer) clearTimeout(revealTimer)
  revealTimer = setTimeout(() => {
    revealed.value = false
    revealTimer = null
  }, REVEAL_MS)
}
onScopeDispose(() => { if (revealTimer) clearTimeout(revealTimer) })

/** 显示口径：INVALID 优先（错误提示非秘密）；打码态恒 MASK；显示态走 grouped 分组 */
const displayed = computed(() => {
  if (props.code === 'INVALID') return t('otpListItem.invalid')
  if (!revealed.value) return MASK_CODE
  return grouped(props.code)
})
```

template `.right` 段替换为：

```html
<div class="right">
  <span
    :class="['code', { invalid: code === 'INVALID' }]"
    :title="code === 'INVALID' ? t('otpListItem.invalidTitle', { message: error ?? '' }) : undefined"
  >{{ displayed }}</span>
  <MdIconButton class="copy" :title="t('otpListItem.copyTitle')" :aria-label="t('otpListItem.copyTitle')" @click.stop="emit('copy')">⧉</MdIconButton>
  <MdIconButton class="show-qr" :title="t('otpListItem.qrTitle')" :aria-label="t('otpListItem.qrTitle')" @click.stop="emit('qr')">▣</MdIconButton>
  <!-- 倒计时环 SVG 原样保留 -->
</div>
```

根元素补 `@dblclick="onDblclick"`（与现有 `@click="emit('copy')"` 并列；双击先触发两次 copy 为可接受行为，spec §6 已裁定）。

style：`.reveal` 规则删除，`.code` 规则改（见 Task 6，若先行合并实现则以 Task 6 为准）。

i18n 两个 locale 的 `otpListItem` 节点：删 `revealTitle`，加 `"copyTitle": "复制验证码"` / `"copyTitle": "Copy code"`。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm --filter @totp/ui test -- OtpListItem.interaction`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/components/OtpListItem.vue packages/ui/test/OtpListItem.interaction.test.ts packages/ui/src/i18n/locales/zh/common.json packages/ui/src/i18n/locales/en/common.json
git commit -m "feat(ui): 验证码默认打码+单击复制+双击显示8秒，移除reveal入口（验收条目3）"
```

### Task 5: 三宿主揭示容器死代码清理

**Files:**
- Modify: `packages/ui/src/pages/CodesPage.vue`（`onReveal`/`closeReveal`/`revealing` 约 161-170 行；`<RevealDialog>` 约 306 行）
- Modify: `apps/desktop/src/MiniApp.vue`（`revealing`/`maskSecret` 约 73-81 行；模板 reveal-mask 块约 108-118 行；`.reveal-*` 样式约 121-125 行）
- Modify: `apps/extension/entrypoints/popup/App.vue`（`onReveal`/`closeReveal`/`revealing` 约 116-133 行；模板 reveal 模态约 384-390 行）
- Delete（若仅 CodesPage 使用）: `packages/ui/src/components/RevealDialog.vue` 及其测试文件（若有）

**Interfaces:**
- Consumes: Task 4 后 `OtpListItem` 不再 emit `reveal`
- Produces: 无（纯删除）

- [ ] **Step 1: 全仓确认 RevealDialog 使用方**

Run: `rg -l "RevealDialog" packages apps --glob '!node_modules'`
Expected: 仅 CodesPage.vue 与组件自身（及测试）。若 popup/mini 也引用，则保留组件只删引用。

- [ ] **Step 2: 逐宿主删除**

- CodesPage.vue：删 `revealing` ref、`onReveal`、`closeReveal`、`<RevealDialog ... />` 行与 import；`<OtpListItem>` 上删 `@reveal="onReveal"`。
- MiniApp.vue：删 `revealing` ref、`maskSecret`、`@reveal="revealing = e"`、整个 `<!-- F1：reveal 模态 -->` 块与 `.reveal-mask/.reveal-card/.reveal-secret/.reveal-hint/.reveal-close` 样式。
- popup/App.vue：删 `revealing` ref、`onReveal`、`closeReveal`、`@reveal="onReveal(e)"`、reveal 模态模板块。
- 各 locale：删 `mini.revealTitle`/`mini.revealHint`/`popup.revealTitle`/`popup.revealHint`（rg 确认无残留引用后删）。

- [ ] **Step 3: 全量验证**

Run: `pnpm typecheck && pnpm test`
Expected: 全绿（若有测试引用 reveal 语义，按新交互修剪）

- [ ] **Step 4: Commit**

```bash
git add -A packages/ui apps/desktop/src/MiniApp.vue apps/extension/entrypoints/popup/App.vue
git commit -m "refactor(ui): 移除三端查看secret揭示容器，seed出口收敛至编辑表单与QR（验收条目3）"
```

### Task 6: 验证码字体改无衬线黑体（条目 10）

**Files:**
- Modify: `packages/ui/src/components/OtpListItem.vue`（`.code` 规则）

**Interfaces:**
- Consumes: 无
- Produces: 无接口变化

- [ ] **Step 1: 修改样式**

`.code` 改为：

```css
.code { font-family: system-ui, sans-serif; font-weight: 700; font-variant-numeric: tabular-nums; font-size: var(--md-sys-typescale-code-large); letter-spacing: 1px; }
```

（Task 5 已删除 MiniApp/RevealDialog 揭示样式，验证码唯一展示点即此处，三端共享。）

- [ ] **Step 2: 回归测试**

Run: `pnpm --filter @totp/ui test`
Expected: 全绿

- [ ] **Step 3: Commit**

```bash
git add packages/ui/src/components/OtpListItem.vue
git commit -m "fix(ui): 验证码改无衬线黑体+tabular-nums（验收条目10）"
```

### Task 7: MdDialog 滚动与全仓弹窗审计（条目 12）

**Files:**
- Modify: `packages/ui/src/components/md/MdDialog.vue`（`.md-dialog` 规则）
- Modify（审计后按需）: 各自定义弹层组件

**Interfaces:**
- Consumes: 无
- Produces: MdDialog 内容超高时容器内滚动，小视口可达底部

- [ ] **Step 1: MdDialog 加滚动约束**

`.md-dialog` 规则追加：

```css
.md-dialog { /* 现有声明保留 */ max-height: 85vh; overflow-y: auto; }
```

- [ ] **Step 2: 全仓弹层审计**

Run: `rg -n "position: fixed" packages/ui/src apps --glob '*.vue'` 与 `rg -l "MdDialog" packages/ui/src apps --glob '*.vue'`

对清单逐个核对，标准：**内容超高时可在弹层内滚动、底部操作按钮在小视口可达**。
走 MdDialog 的组件（EntryFormDialog、OtpQrDialog、TagManagerDialog、批量面板宿主等）自动继承 Step 1；
自定义 fixed 弹层（如 MCP 审批弹窗、右键菜单非弹窗类豁免）逐个补 `max-height: 85vh; overflow-y: auto;` 同款约束。
审计结论（每组件一行：继承/已补/豁免原因）记入本 plan 文件末尾附录。

- [ ] **Step 3: 回归测试**

Run: `pnpm typecheck && pnpm test`
Expected: 全绿

- [ ] **Step 4: 手动验收（三端冒烟）**

desktop `pnpm tauri dev`：窗口压到约 500px 高，逐个打开编辑弹窗/QR/导入，确认可滚动、按钮可达。
entry 交互三端各点一遍：desktop 主窗（单击复制/双击显示 8s）、mini 小窗（alt+shift+t）、
扩展 popup（`pnpm --filter @totp/extension dev` 加载）——打码/复制/双击行为一致。

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/components/md/MdDialog.vue packages/ui/src apps
git commit -m "fix(ui): 弹窗max-height 85vh内滚+全仓弹层审计补齐（验收条目12）"
```

---

## 附录：弹层审计结论

（Task 7 执行时填写：组件名 — 继承 MdDialog / 已补约束 / 豁免原因）
