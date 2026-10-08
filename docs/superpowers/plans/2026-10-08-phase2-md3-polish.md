# Phase 2 MD3 合规收口与抛光 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 spec `docs/superpowers/specs/2026-10-08-phase2-md3-polish-design.md` 全部五组改动：主题层收口、组件能力与 a11y、图标体系、宿主与文档、Rust nit。

**Architecture:** 纯收口批次——token 层补 elevation 系并全量替换字面量；组件层加能力（MdChip removable、hint、aria）与共享样式抽取；新建 iconPaths 注册表与 EmptyState 组件；Rust 仅托盘 i18n 与一处 nit。

**Tech Stack:** 同 Phase 1（Vue3+TS+vitest / Tauri v2，仅 Windows 符号 cfg(windows)）。

**Spec:** `docs/superpowers/specs/2026-10-08-phase2-md3-polish-design.md`（决策 D1-D6 已批）

## Global Constraints

- 覆盖率不低于 **68.19/47.35**；每任务 `pnpm -r test` 全绿（当前基线 core 72/ui 118/extension 24/desktop 32 test files 全过）+ `pnpm -r typecheck`。
- `tokens.css`/`tokens-palettes.css` 产物勿手改，改 `generate.mjs` 后跑 `pnpm --filter @totp/ui theme`。
- Rust 符号 `#[cfg(windows)]`；提交前 `cargo fmt` + `clippy --all-targets`（在 apps/desktop/src-tauri）。
- ∧/∨ 保留文本字符（D1）；不做 Rust 诊断本地化（D4）；state-layer 基色统一 on-surface（D5）。
- commit 原子化、Angular 中文 message；不提交 dist/.output/target。
- 同仓库任务串行执行。

---

### Task 1: 主题层收口（elevation token + state-layer/elevation/首帧存量替换）

**Files:**
- Modify: `packages/ui/src/theme/generate.mjs`（base 增 elevation 块）
- Regenerate: `tokens.css`、`tokens-palettes.css`
- Modify: 全库阴影/hover/pressed 字面量（rg 盘点后逐文件：MdCard.vue elevated、ToastHost.vue:73、TagFilterRow.vue 气泡阴影、MdMenu/MdSelect 弹层阴影等）
- Modify: `apps/desktop/index.html`、`apps/extension/entrypoints/popup/index.html`、`apps/desktop/mini.html`（auto 分支 + mini light 值）
- Test: `packages/ui/test/tokens.test.ts`（追加 elevation 断言）

**Interfaces:**
- Produces: `--md-sys-elevation-level0`（none）至 `level5` 六个 CSS 变量，供组件引用。

- [ ] **Step 1: 追加失败的 elevation 断言**

tokens.test.ts 增：

```ts
it('elevation token 六档存在', () => {
  expect(css).toContain('--md-sys-elevation-level0:none')
  for (const k of ['level1', 'level2', 'level3', 'level4', 'level5']) {
    expect(css).toMatch(new RegExp(`--md-sys-elevation-${k}:\\s*0`))
  }
})
```

- [ ] **Step 2: 跑失败** → `pnpm --filter @totp/ui test -- tokens.test`（FAIL）

- [ ] **Step 3: generate.mjs 增 elevation 块**

base 数组追加（M3 官方阴影值，逗号分隔多层须整串进变量）：

```js
const elevationBlock = `:root {
  --md-sys-elevation-level0:none;
  --md-sys-elevation-level1:0 1px 2px 0 rgba(0,0,0,.30), 0 1px 3px 1px rgba(0,0,0,.15);
  --md-sys-elevation-level2:0 1px 2px 0 rgba(0,0,0,.30), 0 2px 6px 2px rgba(0,0,0,.15);
  --md-sys-elevation-level3:0 1px 3px 0 rgba(0,0,0,.30), 0 4px 8px 3px rgba(0,0,0,.15);
  --md-sys-elevation-level4:0 2px 3px 0 rgba(0,0,0,.30), 0 6px 10px 4px rgba(0,0,0,.15);
  --md-sys-elevation-level5:0 4px 4px 0 rgba(0,0,0,.30), 0 8px 12px 6px rgba(0,0,0,.15);
}`
```

重跑 `pnpm --filter @totp/ui theme`。

- [ ] **Step 4: 存量替换（rg 驱动）**

- 阴影：`rg -n "box-shadow: 0 " packages/ui/src apps/desktop/src --glob "*.vue"` 逐处改 `var(--md-sys-elevation-levelN)`（就近档位：卡片/弹窗类 level2、气泡/toast level2、rail pill level1——就近即可，观感由真机清单兜底）；`0 2px 8px`/`0 1px 3px` 等全部收编。
- state-layer：`rg -n "8%, transparent|12%, transparent" packages/ui/src --glob "*.vue"` → `var(--md-sys-state-layer-hover)` / `var(--md-sys-state-layer-pressed)`；EntryForm `.recommend-item` 的 primary 基色改 `on-surface`（D5）。
- 首帧：三端 html 补 `@media (prefers-color-scheme: dark){ html[data-mode='auto']{background:#1b1b1f} }`；mini.html light `#fff`→`#fefbff`。

- [ ] **Step 5: 验证** — `pnpm -r test` + `pnpm --filter @totp/ui theme` 后 tokens.test 过 + `rg "8%, transparent|12%, transparent" packages/ui/src --glob "*.vue"` 零命中（EntryForm 若有正当例外需注释）。

- [ ] **Step 6: 提交**

```bash
git commit -m "feat(ui): elevation token 六档并全量收编 state-layer/阴影字面量

why: Phase 1 仅新增代码走 token，存量约 20 处 8%/12% 与阴影字面量
未收编，调档需全局手改；auto 模式深色首帧仍白闪。
what: 生成 elevation level0-5 并替换存量阴影；state-layer 字面量全量
token 化（基色统一 on-surface）；三端 html 补 auto 深色分支与 mini 色
差收口。"
```

---

### Task 2: MdChip removable + IconPicker 系 chips 收口

**Files:**
- Modify: `packages/ui/src/components/md/MdChip.vue`
- Modify: `packages/ui/src/components/IconPickerDialog.vue`、`IconPackImportDialog.vue`
- Create: `packages/ui/src/components/iconPaths.ts`（本任务先放 `close` path；Task 5 合并其余）
- Test: `packages/ui/test/MdChip.test.ts`、IconPicker 相关

**Interfaces:**
- Produces: `MdChip` 新 prop `removable?: boolean`（默认 false）与新事件 `(remove)`；`iconPaths.close` 导出（`{ viewBox:'0 0 24 24', d:'...' }` 形态）。

- [ ] **Step 1: 失败测试** — MdChip removable 渲染 close 按钮 + click 触发 `remove`；compact/removable 叠加时 close 命中 ≥44。
- [ ] **Step 2: 实现** — MdChip 加 removable（trailing close MdIconButton 24px，命中 `::after inset:-2px` → 28px 视觉下 ≥32，标准 32px chip 下 40+）；iconPaths.ts 建文件导出 `close`（Material Symbols close 24dp：`M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z`，viewBox 0 0 24 24）。
- [ ] **Step 3: 收口** — IconPickerDialog `.picker-chip`（plain/pack 两形态）与 IconPackImportDialog `.quick-chip` 改用 `<MdChip removable @remove>`；删除自绘 chips 样式（含 `.picker-chip::after`/`.picker-chip > button z-index` 修复——随宿主消亡）；确认两处交互语义逐一映射（选包/删除/确认取消——确认/取消两态钮若 MdChip 无法表达可保留原生按钮但样式走 MdChip 视觉类）。
- [ ] **Step 4: 验证** — `pnpm -r test` + 相关组件测试；`rg "picker-chip|quick-chip" packages/ui/src` 仅剩合理残留。
- [ ] **Step 5: 提交**

```bash
git commit -m "feat(ui): MdChip removable 并收口 IconPicker 系自绘 chips

why: 两处自绘 chip 与 MdChip 双标（形状/字号/状态层），命中 hack
（z-index 抬升）系宿主形态缺陷的补丁。
what: MdChip 加 removable/close（含命中区），iconPaths 注册表建文件
（close），IconPicker/IconPackImport 全部收口 MdChip，删自绘样式。"
```

---

### Task 3: 菜单弹层共享样式 + menu-item 48 + disabled hover

**Files:**
- Create: `packages/ui/src/components/md/menu-surface.css`
- Modify: `md/MdMenu.vue`、`md/MdSelect.vue`、`pages/CloudCard.vue`（.menu-item 36→48）
- Test: MdMenu/MdSelect 回归

**Interfaces:** `menu-surface.css` 提供 `.md-menu-surface { min-width:112px; padding:8px 0; background:var(--md-sys-color-surface-container); border-radius:var(--md-sys-shape-corner-extra-small); } .md-menu-surface > button, .md-menu-surface [role=option] { min-height:48px; }`。

- [ ] **Step 1:** 建共享 css；MdMenu/MdSelect 弹层根挂 `md-menu-surface` 类并删除各自重复声明（保留定位逻辑）。
- [ ] **Step 2:** CloudCard `.menu-item` 高度改走 48px 基线（核对消费处布局不破）。
- [ ] **Step 3:** disabled hover 豁免：MdTextField/MdSelect hover 选择器补 `:not(--disabled)`（类名以实际为准）。
- [ ] **Step 4:** `pnpm -r test` 全绿 + 提交：

```bash
git commit -m "refactor(ui): 菜单弹层共享样式抽取并收口 48px 与 disabled hover

why: MdMenu/MdSelect 弹层样式复制粘贴成对偏差（Phase 1 审查记录）；
CloudCard 菜单项 36px 与 ctx-item 48px 不一致；disabled 态缺 hover 豁免。
what: menu-surface.css 单点维护 112/8px/surface-container/48px 基线；
两组件引用；CloudCard 收口；hover 补 disabled 豁免。"
```

---

### Task 4: a11y 补齐 + hint 能力 + MdCard 双层阴影

**Files:**
- Modify: `md/MdSelect.vue`（aria-activedescendant）、`md/MdDialog.vue`（aria-labelledby）、`md/MdTextField.vue` + `md/MdSelect.vue`（hint）、`md/MdCard.vue`（elevated 双层）
- Test: MdSelect/MdDialog/MdTextField 测试追加

**Interfaces:** MdTextField/MdSelect 新 prop `hint?: string`（默认空；常态渲染于 supporting 位置 body-small on-surface-variant，error 态被 error 文本取代）。

- [ ] **Step 1: 失败测试** — hint 渲染断言；MdSelect trigger 带 `aria-activedescendant` 且高亮变化时更新；MdDialog `role=dialog` 带 `aria-labelledby` 指向 headline id。
- [ ] **Step 2: 实现** — hint：supporting 区域 `error || hint` 渲染；activedescendant：option 元素生成 `id="md-select-opt-{idx}"`，trigger 动态绑；dialog：headline 加 id（`md-dialog-title`），dialog 容器 `aria-labelledby`。
- [ ] **Step 3:** MdCard elevated 阴影改 `var(--md-sys-elevation-level1)`（Task 1 产物）。
- [ ] **Step 4:** `pnpm -r test` + typecheck 全绿 + 提交：

```bash
git commit -m "feat(ui): a11y 补齐与 hint 能力

why: Select 键盘高亮未对读屏暴露、Dialog 无 aria-labelledby（Phase 1
审查挂账）；常态 supporting 文本无入口。
what: activedescendant/labelledby 接线；MdTextField/Select 加 hint；
MdCard elevated 换 elevation token 双层。"
```

---

### Task 5: iconPaths 注册表 + 文本图标替换

**Files:**
- Modify: `iconPaths.ts`（并入 lockIcons 的 visibility 系）、`components/lockIcons.ts`（删除，引用点迁移）、`md/MdFab.vue` 消费处 CodesPage.vue:474、CodesPage.vue:440（⠿）、`apps/desktop/src/MiniApp.vue:228`（✕）
- Test: 相关组件测试（LockScreen 引用迁移后回归）

**Interfaces:** `iconPaths.ts` 导出 `add`/`dragIndicator`/`close`/`visibility`/`visibilityOff`（形态同 close）。

- [ ] **Step 1:** 合并 path（add `M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6z`、dragIndicator/drag_handle 24dp 官方 path、close/visibility/visibilityOff 迁入）；lockIcons.ts 删除、LockScreen import 改 iconPaths。
- [ ] **Step 2:** 替换三处文本字符为内联 SVG（24dp，fill currentColor，样式随宿主）：MdFab ＋、拖拽把手 ⠿（替换后核对 #lead slot 的 hover 切换与把手视觉尺寸 16-20px）、MiniApp ✕（32px 按钮内 16px 渲染）。
- [ ] **Step 3:** `rg "⠿|＋</MdFab>|✕" packages/ui/src apps/desktop/src` 清点（∧/∨ 保留；注释除外）；`pnpm -r test` 全绿。
- [ ] **Step 4:** 提交：

```bash
git commit -m "refactor(ui): 文本字符图标统一为 SVG path 注册表

why: ＋/⠿/✕ 文本充当图标视觉重量与对齐不可控（Phase 1 审查共性问题
7）；lockIcons 单文件并入统一注册表。
what: iconPaths 注册表（add/dragIndicator/close/visibility 系）；
MdFab/CodesPage 把手/MiniApp 隐藏钮换内联 SVG；∧/∨ 按决策保留文本。"
```

---

### Task 6: EmptyState 统一空态

**Files:**
- Create: `packages/ui/src/components/EmptyState.vue`
- Modify: `pages/CodesPage.vue`、`components/TagManagerDialog.vue`、`components/QuickCodesPanel.vue`、`apps/desktop/src/MiniApp.vue`
- Test: 新建 EmptyState.test.ts + 四处回归

**Interfaces:** `EmptyState` props：`text: string`、`icon?: string`（可选 SVG 名，走 iconPaths）；统一 `padding: 32px 0`、body-medium、on-surface-variant。

- [ ] **Step 1: 失败测试**（EmptyState 渲染 text/icon 可选）
- [ ] **Step 2: 实现** — 组件 + 四处替换（MiniApp 的 `.empty` 与 QuickCodesPanel 内嵌空态同源，注意 locked/load 失败分支各自文案保留；QuickCodesPanel 两态文案 props 语义不变）。
- [ ] **Step 3:** `pnpm -r test` 全绿 + 提交：

```bash
git commit -m "feat(ui): EmptyState 统一空态组件

why: 四处空态样式不一（padding 16/8/32px、各自 opacity）——Phase 1
审查共性。
what: EmptyState 组件（text+可选 icon，body-medium/on-surface-variant
统一），CodesPage/TagManagerDialog/QuickCodesPanel/MiniApp 接入。"
```

---

### Task 7: 托盘 i18n + wait_running nit（Rust）

**Files:**
- Modify: `apps/desktop/src-tauri/src/lib.rs`（setup_tray 读 locale + 托盘重建）、托盘文案映射（新 fn 或小模块）、`elevation_install.rs`（wait_running 末次 sleep 修正）
- Modify（前端）: `packages/ui/src/pages/SettingsPage.vue` 或 locale 保存处 emit `tray-locale-changed`
- Test: Rust 映射纯函数单测 + 既有托盘测试回归

**Interfaces:**
- Produces: `tray_label(key: &str, locale: &str) -> &'static str`（zh/en 映射：show-main/quit/copy-mcp/tooltip 四键，未知 key 回退 zh）；前端 `emit('tray-locale-changed')` 事件 → Rust 重建托盘菜单。

- [ ] **Step 1: 失败测试** — tray_label 四键×两语言断言（未知 locale/key 回退 zh）。
- [ ] **Step 2: 实现** — 映射 fn（zh：「显示主窗口/退出/复制 MCP 连接信息」+ tooltip「TOTP 验证码工具」；en：「Show Main Window/Quit/Copy MCP Connection Info」+「TOTP Code Tool」）；setup_tray 用它；`app.listen("tray-locale-changed")` 拆旧托盘重建（托盘句柄管理沿用既有 setup_tray 的持有方式）；wait_running_n 循环改「末次尝试后不 sleep」（成功/超时分支均在 sleep 前返回）。
- [ ] **Step 3:** 前端 locale 保存处（SettingsPage 保存 settings 的 invoke 后）`emit('tray-locale-changed')`——rg 定位 locale 持久化点。
- [ ] **Step 4:** `cargo test/clippy/fmt` + `pnpm -r test` 全绿 + 提交：

```bash
git commit -m "feat(desktop): 托盘菜单跟随界面语言并修 wait_running 末次空睡

why: 托盘菜单/tooltip 硬编码中文不随 locale（Phase 1 审查挂账）；
wait_running 末次失败后多睡 500ms。
what: tray_label zh/en 映射纯函数+单测，setup_tray 走映射，前端
locale 保存 emit 重建；wait_running 末次免睡。"
```

---

### Task 8: 文档裁定与勘误

**Files:**
- Modify: `components/QrSheetDialog.vue`（头注释裁定）、`docs/superpowers/specs/2026-10-08-ui-compact-service-fixes-design.md`（§2.6 勘误注 + §2.9 勘误注）

- [ ] **Step 1:** QrSheetDialog 头注释：「max-width 920px 为多码拼版特例，有意突破 dialog 560dp 上限（spec §2.12 D3 裁定保留）」。
- [ ] **Step 2:** Phase 1 spec 两处勘误（行内加「2026-10-08 勘误：」前缀）：§2.6 contextMenu 归因（Boolean casting 实证已兜底，非线上缺陷）；§2.9 mode-toggle 行（40px 落实于终审修复波 ba7bf63）。
- [ ] **Step 3:** 提交：

```bash
git commit -m "docs: QrSheetDialog 拼版裁定留档与 Phase 1 spec 两处勘误"
```

---

## 收尾验收（主会话执行）

`pnpm -r test`/`typecheck`、cargo 三连、双浏览器构建、覆盖率 gate；终审 code review → 修复全部发现（含 minor）；真机项并入 Phase 1 人工清单（新增：菜单项 48 观感、SVG 图标观感、托盘菜单语言跟随）。
