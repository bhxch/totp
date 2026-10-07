# MD3 紧凑化批次 + 安装服务诊断 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 spec `docs/superpowers/specs/2026-10-08-ui-compact-service-fixes-design.md` 的 Phase 1 全部内容（§2.1–§2.11）：悬浮框自适应、冻结区分隔线、窄窗 sticky、条目紧凑化、mini/popup compact 档、安装服务诊断增强、MD3 全量合规修正（token 补齐/触控目标/组件尺寸/页面宿主）。

**Architecture:** 三端共用 `packages/ui`（手写 Md* 组件 + 页面），宿主为 desktop(Tauri)/extension(popup+options)。token 由 `theme/generate.mjs` 构建期生成（产物入库），所有合规修正先补 token 再改组件。Rust 侧仅动 elevation 诊断链路（错误分类前缀协议贯穿 Rust→TS→Vue）。

**Tech Stack:** Vue3 + TS + vitest（前端）；Tauri v2 + windows-service crate（Rust，仅 Windows 生效，符号须 cfg(windows)）。

**Spec:** `docs/superpowers/specs/2026-10-08-ui-compact-service-fixes-design.md`（§2.12 Phase 2 本计划不实施）

## Global Constraints

- 覆盖率不得低于 CI gate 现状：**68.19% / 47.35%**（每任务跑全量测试确认）。
- `tokens.css` / `tokens-palettes.css` 为生成产物勿手改；改 `generate.mjs` 后必须重跑 `pnpm --filter @totp/ui theme`。
- 仅 Windows 的 Rust 符号必须 `#[cfg(windows)]`（防 Linux clippy/编译失败）；提交前 `cargo clippy --all-targets` + `cargo fmt`。
- 前端测试命令：`pnpm -r test`（或 `pnpm --filter @totp/ui test`）；Rust：`cargo test`（在 `apps/desktop/src-tauri`）。
- commit 原子化，message 用 Angular 规范中文（why 一句 + what 一句）；不提交 dist/node_modules。
- mini/popup compact 的 deviation 已在 spec §1 裁定（28px 视觉+≥32px 命中等），执行时不得"顺手纠正"为标准尺寸。
- 同仓库多任务串行执行（子代理逐个跑，git commit 互斥）。

---

### Task 1: token 体系补齐 + MiniApp 背景断链修复 + 首帧防闪

**Files:**
- Modify: `packages/ui/src/theme/generate.mjs`（TYPESCALE 数组 :54-63、CLASSIC 数组 :21-26、schemeVars 新增派生、base 数组 :67-74）
- Regenerate: `packages/ui/src/theme/tokens.css`、`packages/ui/src/theme/tokens-palettes.css`（命令产物）
- Modify: `apps/desktop/mini.html:6`（写死 `#1c1b1f` 的 dark 底色）
- Modify: `apps/desktop/index.html`（补防闪内联）
- Modify: `apps/extension/entrypoints/popup/index.html`（补防闪内联）
- Test: `packages/ui/test/tokens.test.ts`（新建）

**Interfaces:**
- Produces: CSS 变量 `--md-sys-color-background`、`--md-sys-color-on-background`（light/dark/auto×10 palette）、`--md-sys-typescale-label-large/title-small/title-large/headline-small`、`--md-sys-shape-corner-{extra-small,small,medium,large,extra-large,full}`、`--md-sys-state-layer-hover`(8%)、`--md-sys-state-layer-pressed`(12%)。Task 8/9 的组件与页面直接引用这些名字。

- [ ] **Step 1: 写失败的 token 存在性测试**

新建 `packages/ui/test/tokens.test.ts`：

```ts
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const css = readFileSync(join(__dirname, '../src/theme/tokens.css'), 'utf8')

describe('MD3 token 体系完整性（spec §2.8）', () => {
  it('typescale 补齐 4 档', () => {
    for (const k of ['label-large:14px', 'title-small:14px', 'title-large:22px', 'headline-small:24px']) {
      expect(css).toContain(`--md-sys-typescale-${k}`)
    }
  })
  it('background/on-background role 存在（MiniApp 断链修复）', () => {
    expect(css).toMatch(/--md-sys-color-background:#/)
    expect(css).toMatch(/--md-sys-color-on-background:#/)
    // dark 块内也要有（background 是 mode 相关色）
    expect(css).toContain('--md-sys-color-surface:#1b1b1f') // dark 兜底块 sanity
  })
  it('shape token 系存在', () => {
    for (const k of ['extra-small:4px', 'small:8px', 'medium:12px', 'large:16px', 'extra-large:28px', 'full:9999px']) {
      expect(css).toContain(`--md-sys-shape-corner-${k}`)
    }
  })
  it('state-layer token 存在', () => {
    expect(css).toContain('--md-sys-state-layer-hover:8%')
    expect(css).toContain('--md-sys-state-layer-pressed:12%')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @totp/ui test -- tokens.test.ts`
Expected: FAIL（变量不存在）

- [ ] **Step 3: 改 generate.mjs**

1) `CLASSIC` 数组（:21-26）在 `'surface',` 前插入 `'background','onBackground',`（material-color-utilities 0.2.7 的 `scheme.props` 自带这两个 role）。
2) `TYPESCALE`（:55-63）补四档（保持项目档位注释风格）：

```js
const TYPESCALE = [
  ['headline-small', '24px', ''],
  ['title-large', '22px', ''],
  ['title-medium', '16px', ''],
  ['title-small', '14px', ''],
  ['body-large', '16px', ''],
  ['body-medium', '14px', ''],
  ['body-small', '12px', ''],
  ['label-large', '14px', ''],
  ['label-medium', '12px', ''],
  ['label-small', '11px', ''],
  ['code-large', '18px', ' /* 项目自定义档：验证码/密文等宽 */'],
]
```

3) `base` 数组（:67-74）在 `typescaleBlock` 后追加两个 mode 无关的 :root 块（新增局部常量）：

```js
const shapeBlock = `:root {
  --md-sys-shape-corner-extra-small:4px;
  --md-sys-shape-corner-small:8px;
  --md-sys-shape-corner-medium:12px;
  --md-sys-shape-corner-large:16px;
  --md-sys-shape-corner-extra-large:28px;
  --md-sys-shape-corner-full:9999px;
}`
const stateLayerBlock = `:root {
  --md-sys-state-layer-hover:8%;
  --md-sys-state-layer-pressed:12%;
}`
```

并把两者 push 进 `base`（`typescaleBlock` 之后）。

- [ ] **Step 4: 重新生成并跑测试**

Run: `pnpm --filter @totp/ui theme && pnpm --filter @totp/ui test -- tokens.test.ts`
Expected: PASS；`git diff` 显示 tokens.css/tokens-palettes.css 各 mode 块多了 background/on-background 两行。

- [ ] **Step 5: 修 MiniApp 断链与三处首帧底色**

`apps/desktop/mini.html:6`：把 `html[data-mode='dark']{background:#1c1b1f}` 的 `#1c1b1f` 改为 `#1b1b1f`（token dark surface 实际值），旁边注释改为「首帧防闪：值与 tokens.css dark surface 一致，CSS 装载后由 --md-sys-color-background 接管」。

`apps/desktop/index.html` 在现有内联主题镜像脚本旁补：

```html
<style>html { background: #fefbff } html[data-mode='dark'] { background: #1b1b1f }</style>
```

`apps/extension/entrypoints/popup/index.html` 同样补（popup body 白底场景同主窗）。

`MiniApp.vue:269` 的 `html { background: var(--md-sys-color-background, #fff); }` **保留不动**（token 现已存在，回退仅作兜底）。

- [ ] **Step 6: 全量测试 + 提交**

Run: `pnpm -r test`
Expected: 全绿。

```bash
git add packages/ui/src/theme/ apps/desktop/mini.html apps/desktop/index.html apps/extension/entrypoints/popup/index.html packages/ui/test/tokens.test.ts
git commit -m "feat(ui): MD3 token 体系补齐并修 MiniApp 背景断链

why: MiniApp 引用未定义的 --md-sys-color-background 恒回退白底且被
mini.html 写死值压制；type/shape/state-layer 档缺失致组件硬编码。
what: 生成器补 background 两 role、typescale 4 档、shape 6 档、
state-layer 2 档并重生成产物；三端 html 首帧防闪值对齐 token。"
```

---

### Task 2: 触控目标 48dp 统一机制

**Files:**
- Modify: `packages/ui/src/components/md/MdButton.vue:9`、`md/MdIconButton.vue:8`、`md/MdChip.vue:9`、`md/MdSwitch.vue:29`、`md/MdCheckbox.vue:25-27`、`md/MdSegmentedButton.vue:32`
- Modify: `packages/ui/src/pages/CodesPage.vue:566`（.ctx-item）、`pages/NavigationShell.vue:119-123`（rail-action）、`pages/SettingsPage.vue:215-219`（theme-dot）
- Modify: `apps/desktop/src/MiniApp.vue:263`（.tb-btn）
- Modify: `packages/ui/src/components/TagFilterRow.vue:116`（mode-toggle 仅加命中，不改尺寸）
- Modify: `packages/ui/src/components/IconPickerDialog.vue:220-225`、`IconPackImportDialog.vue:74`、`EntryForm.vue:614`（自绘小钮命中区）
- Test: 相关组件测试文件回归（`.md-icon-button.test` 等现有套件）

**Interfaces:**
- Produces: 六个 md 组件根/触点元素带 `position:relative` + `::after` 命中扩展（`inset:-4px` 起）；此实现纯 CSS，无 TS 接口变化。

- [ ] **Step 1: md 六组件统一命中扩展**

每个组件的可交互根元素（button/label）追加（以 MdIconButton 为例，其余同模板）：

```css
.md-icon-button { position: relative; }   /* 若已有则并入 */
.md-icon-button::after {
  content: '';
  position: absolute;
  inset: -4px;          /* 40+8=48；Chip/Switch/Checkbox 用 -8px/-15px 达标 */
  border-radius: inherit;
}
```

数值表：Button/IconButton/SegmentedButton `-4px`（→48）；Chip `-8px`（→48×48，相邻 gap 8 重叠可接受）；Switch track `-8px`（→48 高）；Checkbox 盒 `-15px`（→48）。

- [ ] **Step 2: 自绘控件清单**

- `CodesPage.vue:566` `.ctx-item { height: 36px }` → `height: 48px`。
- `NavigationShell.vue` `.nav-shell__rail-action` 加 `min-height: 48px`（原 padding 8px 4px 保留）并补 `:active` 12% 叠色：`background: color-mix(in srgb, currentColor var(--md-sys-state-layer-pressed), transparent)`。
- `SettingsPage.vue` `.theme-dot` 加 `position: relative` + `::after { inset: -7px }`（30→44 命中）；hover 的 `transform: scale(1.1)` 删除，改 8% 状态层。
- `MiniApp.vue:263` `.tb-btn` 尺寸 28→40（宽高）、radius `var(--md-sys-shape-corner-small)`，加 `::after { inset: -2px }`（→44）。
- `TagFilterRow.vue` `.mode-toggle` 加 `position: relative` + `::after { inset: -4px }`（32→40 命中；尺寸本批 Task 7 compact 再调）。
- `IconPickerDialog.vue` `.chip-remove`/`.chip-remove-confirm`/`.chip-remove-cancel` 加 `min-width: 40px; min-height: 40px`（原 padding 0 2px）；`.picker-chip` 命中：`position:relative` + `::after { inset: -6px }`。
- `IconPackImportDialog.vue` `.quick-chip` 同上 `::after { inset: -6px }`。
- `EntryForm.vue` `.recommend-item` padding 2px→`6px 8px` 且加 `::after { inset: -4px }`。

- [ ] **Step 3: 回归验证**

Run: `pnpm --filter @totp/ui test && rg -n "inset: -4px|inset: -8px|inset: -15px" packages/ui/src apps/desktop/src --glob "*.vue"`
Expected: 测试全绿；rg 能列出六组件命中块。

- [ ] **Step 4: 提交**

```bash
git add -A packages/ui/src apps/desktop/src/MiniApp.vue
git commit -m "fix(ui): 触控目标统一扩至 MD3 48dp 命中区

why: 全库命中区=可视尺寸（md 六组件 40/32/18px，自绘小钮低至 14px），
违背 MD3 触控目标基线（官网核实 icon/小按钮目标 ≥48dp）。
what: md 六组件伪元素命中扩展 + 自绘控件逐项扩区/抬尺寸；
CodesPage 菜单项 48px、mini 标题栏钮 40px。"
```

---

### Task 3: 悬浮框自适应（spec §2.1）

**Files:**
- Modify: `packages/ui/src/components/TagFilterRow.vue:119-125`（.mode-pop CSS）
- Test: `packages/ui/test/TagFilterRow.test.ts`（回归）

**Interfaces:** 无接口变化。

- [ ] **Step 1: 改 .mode-pop 宽度策略**

```css
.mode-pop {
  position: absolute; top: calc(100% + 4px); left: 0; z-index: 10;
  width: max-content;
  max-width: min(360px, calc(100vw - 16px));
  padding: 6px 10px; border-radius: var(--md-sys-shape-corner-small);
  background: var(--md-sys-color-inverse-surface); color: var(--md-sys-color-inverse-on-surface);
  font-size: var(--md-sys-typescale-body-small); white-space: normal;
  box-shadow: 0 2px 8px var(--md-sys-color-shadow);
}
```

（`manage-pop` 保持 `left:auto; right:0` 不动。）

- [ ] **Step 2: 回归 + 提交**

Run: `pnpm --filter @totp/ui test -- TagFilterRow`
Expected: PASS（气泡开合行为不变）。

```bash
git add packages/ui/src/components/TagFilterRow.vue
git commit -m "fix(ui): tab 行说明气泡宽度自适应

why: .mode-pop max-width 240px 硬上限把中英文案压成竖窄条。
what: 改 width:max-content + min(360px, 100vw-16px) 上限，圆角/阴影
走 shape/shadow token。"
```

---

### Task 4: 冻结区分隔线 + 卡片描边保留（spec §2.2）

**Files:**
- Modify: `packages/ui/src/pages/CodesPage.vue:559-560`（.frozen）
- Modify: `packages/ui/src/components/QuickCodesPanel.vue:103-104`（.frozen）
- Test: 现有 CodesPage/QuickCodesPanel 测试回归

**Interfaces:** 无接口变化。

- [ ] **Step 1: 两处 .frozen 加底边线；CodesPage 收边 1px**

CodesPage：

```css
.frozen {
  position: sticky; top: 0; z-index: 5;
  background: var(--md-sys-color-surface);
  padding-bottom: 4px;
  border-bottom: 1px solid var(--md-sys-color-outline-variant);
  margin-inline: calc(-1 * var(--frozen-bleed, 0px) + 1px); /* 收 1px 保卡片描边 */
  padding-inline: var(--frozen-bleed, 0px);
}
```

QuickCodesPanel 的 `.frozen` 同加 `border-bottom: 1px solid var(--md-sys-color-outline-variant);`（负 margin bleed 机制不动）。

- [ ] **Step 2: 回归 + 提交**

Run: `pnpm --filter @totp/ui test`
Expected: PASS。

```bash
git add packages/ui/src/pages/CodesPage.vue packages/ui/src/components/QuickCodesPanel.vue
git commit -m "fix(ui): 搜索/标签冻结区补底边线并保住卡片描边

why: 冻结条负 margin+不透明背景把 MdCard 1px 描边整段擦除，滚动时
内容穿越无分界（用户报「黑线消失」）。
what: 两处 .frozen 加 outline-variant 底边线；CodesPage 侧负 margin
收 1px 使描边可见（同色 surface 无缝）。"
```

---

### Task 5: 窄窗 sticky 恢复（spec §2.3）

**Files:**
- Modify: `packages/ui/src/pages/NavigationShell.vue:115-118` 附近
- Test: 现有测试回归

**Interfaces:** 无接口变化。

- [ ] **Step 1: 窄屏滚动容器交还文档流**

在 `.nav-shell__main` 规则后追加：

```css
/* 窄屏走文档流整页滚动：残留 overflow-y 会让 sticky 挂到永不滚动的容器，冻结失效 */
.nav-shell--narrow .nav-shell__main { overflow: visible; }
```

- [ ] **Step 2: 回归 + 提交**

Run: `pnpm --filter @totp/ui test`
Expected: PASS。

```bash
git add packages/ui/src/pages/NavigationShell.vue
git commit -m "fix(ui): 窄窗下搜索/标签冻结恢复

why: <600px 断点滚动交还 document 但 .nav-shell__main 残留
overflow-y:auto，sticky 挂在永不滚动的容器上致冻结失效。
what: 窄屏模式该容器 overflow:visible。"
```

---

### Task 6: OtpListItem 紧凑化 + QR 移除 + ops 窄窗隐藏（spec §2.4）

**Files:**
- Modify: `packages/ui/src/components/OtpListItem.vue`（全文件重构相关段）
- Modify: `packages/ui/src/components/QuickCodesPanel.vue:84-91`（删 `:show-qr="false"`）
- Modify: `packages/ui/src/pages/CodesPage.vue`（.codes-card compact、gap 4、.ops 32px+媒体查询、FAB 16px）
- Test: `packages/ui/test/OtpListItem.test.ts`（更新）

**Interfaces:**
- Removes: `OtpListItem` 的 `showQr` prop（Boolean，默认 true）与 `show-qr` 事件链——所有调用点不再传；`QuickCodesPanel` 的 `showQr` 透传删除。
- Produces: `OtpListItem` 新增 `compact` prop（Boolean 默认 false，Task 7 使用）；行盒 min-height 56px（compact 48px 由 Task 7 覆写）。

- [ ] **Step 1: 更新失败测试**

`OtpListItem.test.ts`：删除/改写 QR 相关断言（`show-qr` 按钮不再渲染）；新增：

```ts
it('行盒按 MD3 56px 档收敛且整行等宽（进度条等长兜底）', () => {
  const w = mount(OtpListItem, { props: baseProps() })
  expect(w.find('.otp-item').attributes('style')).toBeUndefined() // 宽度由 CSS 保证
  // width:100% / min-height:56px 是 CSS 断言，走构建产物检查（Step 5）
})
it('compact 档收紧行高（Task 7 生效前的占位断言）', () => {
  const w = mount(OtpListItem, { props: { ...baseProps(), compact: true } })
  expect(w.find('.otp-item').classes()).toContain('otp-item--compact')
})
```

（`baseProps()` 指测试文件现有的最小 props 工厂；若无则以现有用例的 props 形态为准。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @totp/ui test -- OtpListItem`
Expected: FAIL（QR 断言仍在 / compact prop 不存在）

- [ ] **Step 3: 实现组件改动**

1) 删 `showQr`/`showQrButton`（props 定义 :32、computed、template :172 的 MdIconButton、`.show-qr` CSS :210）；`withDefaults` 增 `compact: false`。
2) `.otp-item`：`padding: 10px 12px` → `padding: 6px 16px; min-height: 56px; width: 100%;`；`.otp-item:active { background: color-mix(in srgb, var(--md-sys-color-on-surface) var(--md-sys-state-layer-pressed), transparent); }`（现 hover 8% 保留）。
3) `.code` 加 `line-height: 24px;`；`.index` 的 `opacity:.55` → `color: var(--md-sys-color-on-surface-variant)`。
4) compact 变体：`.otp-item--compact { min-height: 48px; padding: 4px 12px; }`。
5) CodesPage：`.codes-card` 换 `<MdCard padding="compact">`（若 prop 名不同以 MdCard.vue 实际为准）且 `.codes-card { gap: 4px }`；`.ops` 内按钮样式覆写 `width/height 32px`（含 `::after` 命中同步缩为 `inset:-4px`→48 命中保持）；新增 `@media (max-width: 599px) { .row .ops { display: none } }`；FAB `right/bottom: 24px` → `16px`。
6) 全链路清理：`rg -n "show-qr|showQr|showQrButton" packages/ apps/` 逐处删除（QuickCodesPanel :88、MiniApp/popup 若有、相关测试）。

- [ ] **Step 4: 跑测试**

Run: `pnpm --filter @totp/ui test -- OtpListItem && pnpm -r test`
Expected: 全绿。

- [ ] **Step 5: 构建产物抽查（CSS 断言）**

Run: `pnpm --filter @totp/ui build 2>&1 | tail -3; rg -o "otp-item\{[^}]*min-height:56px[^}]*\}|otp-item\{[^}]*width:100%[^}]*\}" apps/desktop/dist/assets/*.css | head -2`
Expected: rg 命中（width:100% 与 min-height:56px 进产物）。

- [ ] **Step 6: 提交**

```bash
git add packages/ui apps/extension
git commit -m "refactor(ui): 条目行紧凑至 MD3 56px 档并移除行内二维码按钮

why: 常显 40px QR 钮把 code-line 撑到 40px、ops 隐形占 84px，行高
81px 致单页仅 4 条；进度条等宽缺组件级保证。
what: 删 showQr 全链路（右键菜单承担）、ops 32px 且 <600px 隐藏、
行 56px 档+width:100%、序号列转 on-surface-variant、补 pressed 态。"
```

---

### Task 7: mini/popup compact 档 + contextMenu 默认值（spec §2.5、§2.6）

**Files:**
- Modify: `packages/ui/src/components/md/MdTextField.vue`（dense prop）、`md/MdChip.vue`（compact prop）
- Modify: `packages/ui/src/components/QuickCodesPanel.vue`（compact prop 透传 + withDefaults 补 `contextMenu: false` :37-41）
- Modify: `packages/ui/src/components/TagFilterRow.vue`（compact prop）
- Modify: `apps/desktop/src/MiniApp.vue:238-246,261`、`apps/extension/entrypoints/popup/App.vue:360-368`
- Test: `packages/ui/test/`（MdTextField/MdChip/QuickCodesPanel/TagFilterRow 相关）

**Interfaces:**
- Produces: `MdTextField` 新 prop `dense?: boolean`（默认 false）；`MdChip` 新 prop `compact?: boolean`；`TagFilterRow` 新 prop `compact?: boolean`；`QuickCodesPanel` 新 prop `compact?: boolean`（向下透传给上述三者与 OtpListItem）。

- [ ] **Step 1: 写失败测试**

```ts
// MdTextField.test.ts 追加
it('dense 档渲染紧凑类', () => {
  const w = mount(MdTextField, { props: { label: '搜索', dense: true } })
  expect(w.find('.md-text-field__box').classes()).toContain('md-text-field__box--dense')
})
// MdChip.test.ts 追加
it('compact 档渲染紧凑类', () => {
  const w = mount(MdChip, { props: { label: 'tag', compact: true } })
  expect(w.find('.md-chip').classes()).toContain('md-chip--compact')
})
// QuickCodesPanel.test.ts 追加
it('compact 透传给 SearchBar/TagRow/ListItem；contextMenu 默认 false', () => {
  const w = mount(QuickCodesPanel, { props: { entries: [], codes: {}, icons: {}, compact: true } })
  expect(w.find('.quick-codes-panel').classes()).toContain('quick-codes-panel--compact')
  expect((w.vm as any).contextMenu).toBe(false) // 以实际 expose 方式为准：也可断言子组件 props
})
```

- [ ] **Step 2: 跑失败** — `pnpm --filter @totp/ui test`（新增用例 FAIL）

- [ ] **Step 3: 实现**

1) `MdTextField`：props 加 `dense`（Boolean 显式默认 false——Vue Boolean casting 坑，须 `withDefaults(defineProps<{...}>(), { dense: false })`）；新增：

```css
.md-text-field__box--dense { min-height: 40px; padding: 10px 12px 4px; }
.md-text-field__box--dense .md-text-field__input { font-size: var(--md-sys-typescale-body-medium); line-height: 20px; }
```

（本任务在 Task 8 之前执行，dense 必须自带 min-height 覆写，不依赖 56px 基线。）
2) `MdChip`：`compact` prop；`.md-chip--compact { height: 28px; padding: 0 12px; font-size: var(--md-sys-typescale-body-small); }`。
3) `TagFilterRow`：`compact` prop；`.tag-filter-row--compact { gap: 6px } .tag-filter-row--compact .md-chip { ... }`（经 MdChip compact prop 传入更干净：chips 循环处 `:compact="compact"`）、`.mode-toggle` 在 compact 下 `width/height: 28px` + `::after { inset: -2px }`。
4) `QuickCodesPanel`：`compact` prop + 根类 `quick-codes-panel--compact { gap: 6px } .quick-codes-panel--compact .frozen { gap: 6px }`；透传 `:dense="compact"`（SearchBar 内 MdTextField——SearchBar 加 `dense` prop 透传）、`:compact="compact"` 给 TagFilterRow 与 OtpListItem；**withDefaults 补 `contextMenu: false`**。
5) `MiniApp.vue`：`<QuickCodesPanel ... compact>`；`.titlebar { height: 30px }`；`.mini { gap: 2px }` 保持（sticky bleed 依赖）。
6) popup `App.vue`：面板装配处加 `compact`。

- [ ] **Step 4: 全量测试 + 提交**

Run: `pnpm -r test`
Expected: 全绿。

```bash
git add packages/ui apps/desktop/src/MiniApp.vue apps/extension
git commit -m "feat(ui): mini/popup compact 档并修 contextMenu 默认值

why: 320×420 小窗头部区 136px 占比过大（用户报搜索/tab 占空间）；
QuickCodesPanel contextMenu 缺默认值透传 undefined 命中子组件默认
true，右键 preventDefault 后空转。
what: MdTextField dense/MdChip compact/TagFilterRow 与 QuickCodesPanel
compact 链路（density -4dp 档+type 槽位，spec §2.5 deviation 已裁）；
withDefaults 补 contextMenu:false。"
```

---

### Task 8: 组件尺寸与角色修正（spec §2.10）

**Files:**
- Modify: `packages/ui/src/components/md/MdTextField.vue:43-59`、`md/MdSelect.vue:144-175`、`md/MdMenu.vue:102-106`、`md/MdTabs.vue:7-30`、`md/MdDialog.vue:73-88`、`md/MdCard.vue:11-15`
- Modify: `packages/ui/src/components/ToastHost.vue:65-80`
- Test: 对应组件测试文件

**Interfaces:** 无 TS 接口变化； MdTextField 高度基线 56px 与 Task 7 dense 40px 并存（`.md-text-field__box--dense` 覆写 min-height）。

- [ ] **Step 1: MdTextField / MdSelect 触发框定高 56px + 指示条叠加**

MdTextField：

```css
.md-text-field__box {
  position: relative;
  min-height: 56px;            /* 官网核实 filled 容器 56dp */
  box-sizing: border-box;
  display: flex; flex-direction: column; justify-content: center;
  padding: 0 16px;             /* 顶部空间给浮动 label，由 min-height 保证总高 */
  border-bottom: 1px solid var(--md-sys-color-outline-variant);
}
.md-text-field__box::after {   /* active indicator 覆盖叠加，消 1px 布局位移 */
  content: ''; position: absolute; left: 0; right: 0; bottom: -1px; height: 2px;
  background: var(--md-sys-color-primary);
  transform: scaleX(0); transition: transform .12s;
}
.md-text-field__box:focus-within::after { transform: scaleX(1); }
.md-text-field__box:focus-within { border-bottom-color: transparent; }
.md-text-field__input { font-size: var(--md-sys-typescale-body-large); line-height: 24px; padding: 0; }
.md-text-field__box:hover:not(:focus-within) {
  background: color-mix(in srgb, var(--md-sys-color-on-surface) var(--md-sys-state-layer-hover), transparent);
}
.md-text-field__box--dense { min-height: 40px; }
```

（原 `padding: 22px 16px 6px`、`border-bottom` 聚焦 2px 写法删除；浮动 label 的定位若依赖旧 padding，执行时按实际模板微调 label 的 `top` 值保持视觉。）

MdSelect 触发框同样处理（定高 56、`::after` 指示条、消 border 位移）。

- [ ] **Step 2: 弹层类修正**

- `MdSelect`：`.md-select__option { height: 48px; font-size: var(--md-sys-typescale-body-large); }`；弹层 `min-width: 112px; padding: 8px 0;`、容器 `surface-container`。
- `MdMenu`：`min-width: 112px; padding: 8px 0;` 容器 `surface-container`。
- `MdTabs`：`height: 64px`；指示条改 `width: 30px; left: 50%; transform: translateX(-50%); border-radius: 9999px;`（去 left/right 16 拉伸）；icon 20→24px。
- `MdDialog`：headline `font-size: var(--md-sys-typescale-headline-small); margin-bottom: 16px;`；`.md-dialog { min-width: 280px; }`；`.md-dialog__actions { margin-top: 24px; }`；scrim `background: color-mix(in srgb, var(--md-sys-color-scrim) 32%, transparent);`。
- `ToastHost`：`.toast { border-radius: var(--md-sys-shape-corner-extra-small); min-height: 48px; display: flex; align-items: center; }`；`.toast--error` 上方注释补一行「自定义 error-container 变体（spec §2.10 裁定；错误感知由 role=alert 承担）」。
- `MdCard`：outlined 描边 `var(--md-sys-color-outline)` → `var(--md-sys-color-outline-variant)`；`#header` 字号 body-medium→`var(--md-sys-typescale-title-medium)`。

- [ ] **Step 3: 回归 + 视觉断言**

Run: `pnpm --filter @totp/ui test && pnpm --filter @totp/ui build 2>&1 | tail -2; rg -c "min-height:56px|min-height: 56px" apps/desktop/dist/assets/*.css`
Expected: 测试全绿；产物含 56px。

- [ ] **Step 4: 提交**

```bash
git add packages/ui/src/components
git commit -m "fix(ui): 组件尺寸与角色对齐 MD3（field 56dp/菜单 48/对话框 scrim 等）

why: filled field/select 实际 47px 不足 56dp（官网核实值）；菜单项
40/36px、Tabs 56px、Dialog headline 硬编码 20px、scrim 55% 等偏离。
what: field 定高 56+指示条叠加消位移；option/菜单项 48；Tabs 64+
短指示条；Dialog headline token 化+min-width 280+scrim 32%+间距；
Toast 4px/48px；Card outlined 换 outline-variant、卡头 title-medium。"
```

---

### Task 9: 页面与宿主合规修正（spec §2.11）

**Files:**
- Modify: `packages/ui/src/components/LockScreen.vue:160-202`
- Modify: `packages/ui/src/components/EntryForm.vue:584-615` 及其 dialog 接线处
- Modify: `packages/ui/src/components/IconPickerDialog.vue:220-239`、`IconPackImportDialog.vue:60-77`
- Modify: `apps/extension/entrypoints/options/App.vue:216-233`
- Test: 相关页面组件测试回归

**Interfaces:** 无接口变化（EntryForm 按钮迁 MdDialog `#actions` 槽为模板结构调整）。

- [ ] **Step 1: LockScreen**

- 标题 `h2`（:200-202）字号 → `var(--md-sys-typescale-headline-small)`。
- `.hint`（:171 附近）`opacity:.65` → `color: var(--md-sys-color-on-surface-variant)`。
- emoji `🙈`/`👁` 替换为内联 SVG（24px，`fill: currentColor`，path 用 Material Symbols `visibility` / `visibility_off` 标准路径，与 navIcons 同源方式注册）。
- 显隐 MdIconButton 移入口令输入行右缘（pw-row 结构内贴 field 视觉右缘；MdTextField trailing slot 机制不在本批）。

- [ ] **Step 2: EntryForm**

- `.entry-form` gap 6→8px；`fieldset` radius 6→`var(--md-sys-shape-corner-small)`、gap 10→8px。
- `.rule-error` label-small→`var(--md-sys-typescale-body-small)`。
- `.base32-hint` tertiary→`var(--md-sys-color-on-surface-variant)`。
- `.recommend-item` hover 16%→`var(--md-sys-state-layer-hover)`、补 `:active` pressed 12%。
- 保存/取消按钮自 `.entry-form` body 迁至宿主 MdDialog 的 `#actions` 插槽（EntryForm 以具名 slot 或宿主直接在 dialog 模板放置按钮并调用 EntryForm 暴露的 submit 方法——以现有组件边界最小改动为准，保持 emit 契约不变）。
- `IconPackImportDialog.vue:60-77` 自绘 `.actions` 同迁 `#actions` 槽、margin-top 12 删除。

- [ ] **Step 3: IconPicker / IconPackImport / options / 6px 圆角清零**

- `IconPickerDialog.vue:235` hover 12%→8%、补 `:active` 12%；`.picker-cell-label` 10px→`var(--md-sys-typescale-label-small)`。
- `options/App.vue` loadError 容器加 `background: var(--md-sys-color-error-container); color: var(--md-sys-color-on-error-container); padding: 8px 16px; border-radius: var(--md-sys-shape-corner-small);`。
- §2.8.3 余项：`MiniApp.vue:267` `.copy-error` radius 6px→`var(--md-sys-shape-corner-small)`；`McpConsentDialog.vue` `.consent-ident` radius 6px→同（rg 确认类名后改）。

- [ ] **Step 4: 回归 + 提交**

Run: `pnpm -r test`
Expected: 全绿（SecurityCard/EntryForm 相关用例如涉及按钮位置需同步选择器）。

```bash
git add packages/ui/src/components apps/extension/entrypoints/options
git commit -m "fix(ui): 页面与弹窗合规修正（锁屏/表单/图标选择/错误提示）

why: 锁屏标题与口令显隐 emoji、表单 6/10px 破 4dp 网格、错误文字
11px、hint 乱用 tertiary、按钮自绘双套排布等偏离 MD3。
what: LockScreen headline 化+SVG 图标；EntryForm 间距/角色/动作区
迁 #actions 槽；IconPicker hover 8%/label-small；options 错误容器化。"
```

---

### Task 10: Rust 安装服务诊断（spec §2.7.1-2.3）

**Files:**
- Create: `apps/desktop/src-tauri/src/elevation_log.rs`（elog 落盘薄层）
- Modify: `apps/desktop/src-tauri/src/elevation_install.rs`（trigger_install :682-694、start_if_stopped :440-449、run_install/run_uninstall 的 eprintln 换 elog）
- Modify: `apps/desktop/src-tauri/src/elevation_commands.rs:264-286`（bind_and_wait 错误分类）
- Modify: `apps/desktop/src-tauri/src/lib.rs:806-832`（服务/安装分支 eprintln→elog）
- Modify: `apps/desktop/src-tauri/src/main.rs` 或 lib.rs 模块声明处（`mod elevation_log;`）
- Test: `apps/desktop/src-tauri/src/elevation_install.rs` `#[cfg(test)]` 区（已有 tests mod :696）

**Interfaces:**
- Produces（供 Task 11 前端解析的**错误前缀协议**，写死不得改）：`abe_bind` 的 `Err(String)` 恒为三种前缀之一——`"cancelled:{detail}"`（UAC 取消，runas 退出码 -1/0xFFFFFFFF）、`"failed:{detail}"`（提权进程非零退出含 SCM 错误码 / StartService 后 5s 未达 RUNNING）、`"notready:{detail}"`（安装命令成功但 bind 轮询 10s 超时）。
- Produces: `elevation_log::elog(kind: &str, msg: &str)`——eprintln + 追加写 `%ProgramData%\TotpTools\service\{kind}.log`（kind = `install` | `service`），失败静默；`#[cfg(windows)]`。

- [ ] **Step 1: 写失败测试（分类纯函数 + wait_running 注入轮询）**

`elevation_install.rs` tests mod 追加：

```rust
#[test]
fn classify_cancelled_when_runas_exit_minus_one() {
    assert!(matches!(
        classify_trigger_failure(Some(-1), None),
        TriggerFailure::Cancelled
    ));
}
#[test]
fn classify_failed_on_other_exit_codes() {
    assert!(matches!(
        classify_trigger_failure(Some(1), Some("创建服务失败: 拒绝访问".into())),
        TriggerFailure::Failed(_)
    ));
}
```

`elevation_commands.rs`（或 install）tests 追加 wait_running 注入测试：

```rust
#[test]
fn wait_running_times_out_with_scm_error_in_message() {
    let mut polls = || Err(1078u32); // 模拟 SCM 错误码
    let r = wait_running_n(&mut polls, 2, std::time::Duration::ZERO);
    assert!(r.is_err_and(|e| e.contains("1078")));
}
```

- [ ] **Step 2: 跑失败** — `cargo test`（在 apps/desktop/src-tauri）→ FAIL（函数不存在）

- [ ] **Step 3: 实现**

1) `elevation_log.rs`：

```rust
/// 安装/服务子进程日志：eprintln 全量同步落盘（GUI 子系统 stderr 不可见，
/// 日志是唯一可诊断面）。服务启动即写 started 行——被安全软件击杀则日志断尾。
#[cfg(windows)]
pub fn elog(kind: &str, msg: &str) {
    eprintln!("[elevation-{kind}] {msg}");
    if let Ok(dir) = crate::elevation_install::service_dir() {
        let path = dir.join(format!("{kind}.log"));
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
            use std::io::Write;
            let _ = writeln!(f, "[{}] {}", chrono_like_timestamp(), msg);
        }
    }
}
#[cfg(not(windows))]
pub fn elog(kind: &str, msg: &str) { let _ = kind; eprintln!("[elevation] {msg}"); }

fn chrono_like_timestamp() -> String {
    let s = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("#{s}")
}
```

（`service_dir()` 若为私有，改 `pub(crate)`。时间戳用简单 `SystemTime::now().duration_since(UNIX_EPOCH)` 秒值，不引新依赖。）

2) `elevation_install.rs`：`classify_trigger_failure(exit_code: Option<i32>, detail: Option<String>) -> TriggerFailure`（枚举 `Cancelled`/`Failed(String)`；`Some(-1)` 即 0xFFFFFFFF → Cancelled）；`trigger_install` 失败路径改用分类并返回带前缀错误串 `format!("cancelled:{detail}")` / `format!("failed:{detail}")`；`start_if_stopped` 改为 start 后调 `wait_running`（新函数：`query_status` 轮询至 RUNNING，预算 5s、间隔 500ms，超时 `Err("failed:服务启动未完成（可能被安全软件拦截）, SCM 最后状态/错误: {code}")`；抽 `wait_running_n<P: FnMut() -> Result<u32, u32>>` 可注入形式供单测）；run_install 全部 `eprintln!` → `elog("install", ...)`。
3) `elevation_commands.rs::bind_and_wait`：轮询超时分支返回 `format!("notready:安装命令已完成，但服务未在 {:?} 内可达: {err}", BIND_POLL_BUDGET)`。
4) `lib.rs` 服务分支 `eprintln!` → `elog("service", ...)`，服务循环启动时先 `elog("service", "started, pid=...")`。
5) 所有新增 Windows-only 符号挂 `#[cfg(windows)]`；`cargo clippy --all-targets` + `cargo fmt`。

- [ ] **Step 4: 跑测试**

Run: `cargo test && cargo clippy --all-targets 2>&1 | tail -3`
Expected: 全绿、无新 warning。

- [ ] **Step 5: 提交**

```bash
git add apps/desktop/src-tauri
git commit -m "feat(desktop): 安装/服务诊断日志与错误分类前缀协议

why: UAC 取消/提权失败/服务未就绪三类原因折叠成同一文案且 stderr
GUI 下不可见，本机实证服务装上但 SCM 启动上下文无声消失无从定位。
what: elog 落盘 install/service 日志（服务启动即写 started 行，被
杀软击杀则断尾）；trigger 分类 cancelled/failed、start 后 wait_running
5s 带 SCM 错误码、bind 超时归 notready——Err 前缀协议供前端分流。"
```

---

### Task 11: SecurityCard 分类文案 + i18n（spec §2.7.4）

**Files:**
- Modify: `apps/desktop/src/securityPlatform.ts:121-130`（bind 返回形态）
- Modify: `packages/ui/src/components/SecurityCard.vue:96-129`（abeHint 分类）
- Modify: `packages/ui/src/i18n/locales/zh/common.json:590-602`、`en/common.json`（同 keys）
- Test: `packages/ui/test/SecurityCard.abe.test.ts:185-196`（更新）

**Interfaces:**
- Consumes: Task 10 的 `cancelled:`/`failed:`/`notready:` 前缀协议。
- Produces: `securityPlatform.bindAbe()` 返回 `{ ok: true } | { ok: false; reason: 'cancelled' | 'failed' | 'notready'; detail: string }`（原 `boolean` 返回改为判别联合；调用点仅 SecurityCard 一处）。

- [ ] **Step 1: 更新失败测试**

`SecurityCard.abe.test.ts` 把「bind=false → abeHint=安装未完成」用例改为三分支：

```ts
it.each([
  [{ ok: false, reason: 'cancelled', detail: 'UAC 取消' }, '已取消 UAC 授权，安装中止'],
  [{ ok: false, reason: 'failed', detail: '创建服务失败' }, '安装失败：创建服务失败'],
  [{ ok: false, reason: 'notready', detail: '10s 内不可达' }, '服务未就绪：若安装了第三方安全软件（如 ESET），请将 C:\\ProgramData\\TotpTools\\service\\ 加入信任后重试'],
])('bind 返回 %j → 文案含 %s', async (ret, expected) => {
  // mock ops.bind 返回 ret，触发 onAbeBind，断言 abeHint 文本含 expected
})
```

（`ops` 的 mock 形态以该测试文件现有写法为准；三段文案的实际 i18n key 见 Step 3，断言用 `t()` 同值。）

- [ ] **Step 2: 实现**

1) `securityPlatform.ts`：`invoke('abe_bind')` catch 分支解析 `String(e)` 前缀（`cancelled:`/`failed:`/`notready:`，无前缀的旧格式兜底归 `failed`）返回判别联合；成功 `{ ok: true }`。
2) `SecurityCard.vue`：`abeHint.value` 按 `reason` 选 `t('securityCard.abeBindCancelled' | 'abeBindFailed' | 'abeNotReady')`；`failed` 时拼接 `：${detail}`；`notready` 文案内嵌杀软指引。
3) i18n（zh 与 en 同 key 同行号区）：

```json
"abeBindCancelled": "已取消 UAC 授权，安装中止",
"abeBindFailed": "安装失败：{detail}",
"abeNotReady": "服务未就绪：若安装了第三方安全软件（如 ESET），请将 C:\\ProgramData\\TotpTools\\service\\ 加入信任后重试",
```

en：

```json
"abeBindCancelled": "UAC prompt cancelled; installation aborted",
"abeBindFailed": "Installation failed: {detail}",
"abeNotReady": "Service not ready: if a third-party antivirus (e.g. ESET) is installed, trust C:\\ProgramData\\TotpTools\\service\\ and retry",
```

（`{detail}` 插值方式以仓库 i18n 现有机制为准——若无插值能力则前端拼接，key 只含固定文案。）

- [ ] **Step 3: 全量测试 + 提交**

Run: `pnpm -r test && pnpm --filter @totp/desktop build 2>&1 | tail -2`（前端+TS 编译过）
Expected: 全绿。

```bash
git add apps/desktop/src/securityPlatform.ts packages/ui
git commit -m "fix(ui): 安装服务失败文案按根因分类（UAC/失败/未就绪）

why: 三类失败折叠同一句「已取消或服务未就绪」，真实原因只进
console.warn，用户无从处置（本机 ESET 拦截场景无法自助排查）。
what: Rust Err 前缀协议解析为判别联合，SecurityCard 三分类文案，
notready 内嵌杀软排除指引；en 同步。"
```

---

### Task 12: e2e 真机清单文档（spec §3）

**Files:**
- Create: `docs/e2e/2026-10-08-md3-compact-checklist.md`
- Modify: `docs/e2e/2026-10-07-abe-service-checklist.md`（追加 ESET 排除步骤）

**Interfaces:** 纯文档。

- [ ] **Step 1: 写清单**

新建清单覆盖（沿用仓库 docs(e2e) 惯例格式）：三端宽/窄窗冻结与卡片描边核对；mini/popup 紧凑档观感（头部 ~104px、行 48px）；CodesPage 行 56px 档与单页条目数；进度条逐行等长；悬浮框单行气泡；深浅色+AMOLED 下 mini 底色跟随主题（Task 1 断链验证）；弹窗 headline/scrim 观感；触控命中抽查；安装服务全链路（ESET 排除 `C:\ProgramData\TotpTools\service\` → 安装 → `install.log`/`service.log` 核对 → 绑定 → 换口令 → 卸载）；三类失败文案各触发一次（取消 UAC / 改出失败 / 未就绪）。

`2026-10-07-abe-service-checklist.md` 顶部追加「2026-10-08 勘误：服务未就绪排查先看 install.log/service.log；ESET 需将服务目录加入信任后重试」。

- [ ] **Step 2: 提交**

```bash
git add docs/e2e
git commit -m "docs(e2e): MD3 紧凑批真机清单与 ABE 清单 ESET 勘误"
```

---

## 收尾验收（计划执行完后由主会话执行）

1. `pnpm -r test`、`cargo test`、`cargo clippy --all-targets`、双浏览器扩展构建（`pnpm exec wxt build -b firefox` 及 Chrome 默认）全绿。
2. 覆盖率不低于 68.19/47.35。
3. e2e：桌面真机（tauri-mcp/devtools 桥接）走查 Task 12 清单可自动化子集；扩展 popup 真机抽查。
4. 代码审查（requesting-code-review）→ 修复全部发现（含 minor）→ 复跑测试。
