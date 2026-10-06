# P4 miniapp/popup 功能统一 + pin 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 抽共享"快速取码面板"组件 QuickCodesPanel，MiniApp 与扩展 popup 装配同一组件（"popup 跟 miniapp 一样"由组件同一性保证）；两者都带标签筛选 tab 行（∧/∨ 切换、无管理入口）、搜索与 tab 行冻结顶部、条目纯取码（无管理操作）；popup 精简（管理面挪主界面态、顶部加"打开主界面"按钮、快捷新增保留确认态）；background 右键菜单直达主界面态。

**Architecture:** QuickCodesPanel 只共享**视觉结构与冻结**（SearchBar + TagFilterRow(manageable=false) + sticky 容器 + OtpListItem 列表 + 空态），业务差异留宿主——popup 的四级回退过滤/URL 站点过滤/pending 预填确认态、mini 的 desktopCopy 通道/复制后自动隐藏/锁定跟随不动。popup 移除：常驻"添加"按钮、otpauth 粘贴导入 details、内联新建双 tab（BatchPastePanel 从 popup 移除）、条目右键菜单、行内 ops、OtpQrDialog；保留：URL 过滤行+hint、`?uri=`/pendingOtpauth → EntryForm 确认态（仅 manual tab 路径）、跟随拉取、延迟关窗。

**Tech Stack:** Vue 3 + vitest；扩展端 WXT background（contextMenus）。

**Spec:** `docs/superpowers/specs/2026-10-06-seven-features-design.md` §4；依赖 P1 产出（TagFilterRow `manageable` prop）与 P3 产出（OtpListItem 新布局、toast、CodesPage 冻结先例）。

## Global Constraints

- QuickCodesPanel 的 props/emits 一旦定义即三端契约，Task 2/3 按其装配，不得临时改签名（要改先回计划层裁决）。
- popup 移除的功能**去向**（spec §4.2 表）：粘贴导入→浏览器右键菜单与主界面态承担；内联新建常驻入口→主界面态；条目右键菜单/行内 ops→主界面态；OtpQrDialog→主界面态。**不删** `?uri=`/pendingOtpauth 预填确认态（P5 依赖）。
- MiniApp 现有机制零回退：无边框标题栏/pin 置顶/失焦自动隐藏/复制后 500ms 自动隐藏（pinned 让位）/锁定跟随/托盘锚定/mini-ready 门控/HOTP 递增/双击揭示。
- popup 现有机制零回退：四级回退过滤（resolvePopupVisible）、URL 过滤行、跟随拉取（syncFollow）、HOTP 递增、双击揭示取消自动关窗（I-1 代次守卫）、延迟关窗、PersistErrorBanner、LockScreen。
- toast 不接入 MiniApp（复制后自动隐藏即反馈）；popup 已挂 ToastHost（P3）。
- 测试命令：`pnpm -F @totp/ui test`、`pnpm -F @totp/desktop test`、`pnpm -F @totp/extension test`；三端 typecheck。

---

### Task 1: QuickCodesPanel 共享面板组件

**Files:**
- Create: `packages/ui/src/components/QuickCodesPanel.vue`
- Modify: `packages/ui/src/index.ts`（导出）
- Test: `packages/ui/test/quickCodesPanel.test.ts`

**Interfaces:**
- Produces（Task 2/3 装配契约）：
  ```ts
  props: {
    entries: OtpEntry[]                     // 宿主过滤后的可见列表
    codes: Map<string, { code: string; remaining: number; progress: number }>
    icons?: IconStore | null
    loading?: boolean                       // popup loaded 门控（true 前不渲染列表与空态）
    emptyText?: string                      // 全空列表文案（宿主 i18n 后传入）
    noMatchText?: string                    // 有 entries 但过滤后空文案
    query: string                           // v-model:query（SearchBar）
    searchSecret?: boolean                  // v-model:search-secret（SearchBar 透传）
    tagRow?: boolean                        // 默认 false；true 渲染 TagFilterRow
    tags?: Tag[]                            // tagRow 时必传
    selectedTagIds?: string[]               // v-model:selected-tag-ids
    tagMode?: TagFilterMode                 // v-model:tag-mode
    contextMenu?: boolean                   // 默认 false（透传 OtpListItem）
    showIndex?: boolean                     // 默认 true（OtpListItem index=i+1）
  }
  emits: 'update:query' | 'update:searchSecret' | 'update:selectedTagIds' | 'update:tagMode' | 'copy' [entry: OtpEntry] | 'dblclick' [event: MouseEvent]
  ```
  - 结构：`.frozen { position: sticky; top: 0; z-index: 5; background: var(--md-sys-color-surface); }` 包 SearchBar + TagFilterRow（`manageable` 恒 false——组件内固定传，不留 prop）；列表 v-for OtpListItem（`@copy="emit('copy', e)" @dblclick` 透传，`v-bind="codes.get(e.uuid) ?? { code: '------', remaining: 0, progress: 1 }"` 同现有宿主写法）；loading=true 时不渲染空态与列表。
  - 空态判定：`entries.length===0 && !query && 无标签选中` → emptyText；否则 noMatchText（对齐 popup 现有 empty/noMatch 两态语义）。
  - TagFilterRow 仅在 `tagRow && tags.length > 0` 时渲染（空 tags 隐藏——mini/popup 快速窗语义，无管理入口，与 CodesPage 的恒渲染不同）。
- 测试要点：props 开关（tagRow 显隐/manageable 恒 false/无管理钮）、冻结结构 class、v-model 五路透传（query/searchSecret/selectedTagIds/tagMode 触发对应 emit）、copy/dblclick 上抛、loading 门控、两态空文案。

- [ ] Step 1: 失败测试 → 红
- [ ] Step 2: 实现 + index.ts 导出 → 绿；`pnpm -F @totp/ui test`
- [ ] Step 3: Commit `feat(ui): QuickCodesPanel 共享快速取码面板（冻结+筛选行+纯取码列表）`

### Task 2: MiniApp 装配 QuickCodesPanel（tag 筛选 + 冻结）

**Files:**
- Modify: `apps/desktop/src/MiniApp.vue`（搜索行+列表区替换为 QuickCodesPanel；新增标签筛选编排）
- Test: `apps/desktop/test/miniApp*.test.ts`（按现有文件追加；tag 过滤编排新用例）

**Interfaces:**
- Consumes: Task 1 面板；现有 `searchEntries`、`filterByTags`（core，同 CodesPage 组合口径）。
- 行为变更：mini 获得标签筛选——`selectedTagIds` 本地 ref（**不持久化**，快速窗会话语义；与 popup 的 settings 持久化刻意不同，注释说明）；`tagMode` 走 `store.settings.tagFilterMode` + `commitSettings`（与 CodesPage 同款全局共享）；`visible = filterByTags(searchEntries(sorted, query), new Set(selectedTagIds), tagMode)`（仅 tagRow 有选中时走 filterByTags，空选中集合直通）。悬空 tag 清理 watch 照 CodesPage 同款（防同步删除后悬空 id）。
- 保留不动：titlebar/pin/自动隐藏/desktopCopy/HOTP/双击/锁定分支/PersistErrorBanner/load 失败横幅/mini-ready/onFocusChanged 重载。

- [ ] Step 1: 更新 mini 测试（面板装配结构 + tag 过滤编排 + 悬空清理；现有断言按面板结构调整但行为断言保留）→ 红
- [ ] Step 2: 实现 → 绿；`pnpm -F @totp/desktop test` + typecheck
- [ ] Step 3: Commit `feat(desktop): MiniApp 装配 QuickCodesPanel，补标签筛选（任一/全部）与冻结`

### Task 3: popup 精简改造（主界面态移交 + 快捷新增确认态保留）

**Files:**
- Modify: `apps/extension/entrypoints/popup/App.vue`（大改，见下）
- Test: `apps/extension/test/` popup 相关测试（移除项断言删除、新增项断言补充）

**popup App.vue 改造清单（逐项）：**
1. header：删除「添加」`MdButton`（startCreate 常驻入口移除）；新增「打开主界面」`MdIconButton`（icon 用 `NAV_ICONS.codes`——读 `packages/ui/src/pages/routes.ts` 取 codes 页 icon path）→ `ext.tabs.create({ url: ext.runtime.getURL('options.html#/codes') })`；设置齿轮保留（→ `#/settings`）。
2. 移除模板与逻辑：otpauth 粘贴导入 `<details>`（`otpauthUri/importOpen/onImportToggle/importOtpauth`）、`MdSegmentedButton` 双 tab 与 `BatchPastePanel`（`formTab/FORM_TAB_OPTIONS/watch(creating)` 一并删）、条目右键菜单 `MdMenu` 与 `contextEdit/contextCopyUri/contextTogglePin/onContextMenu/closeContextMenu`、行内 `.ops`（editing 入口/askRemove/confirmingDelete/confirmTimer）、`OtpQrDialog` 与 `qrEntry`。
3. **保留**：`applyOtpauthPrefill`/`consumePendingOtpauth`（`?uri=`/pending 键 → `prefill`+`creating=true`）；creating 且 editing 为空时渲染 `EntryForm`（无 Tab，仅 manual；`:key="prefill ? 'prefill-'+formKey : 'new'"`、`@save="onSave"`、`@cancel="closeForm"`）；`onSave` 新建分支原样（carried 字段保留）；URL 过滤行与 hint、四级回退过滤、跟随拉取、`copy()`（P3 已接 toast）+I-1 代次守卫+延迟关窗、`cancelAutoClose`。
4. 列表装配：`<QuickCodesPanel :entries="visible" :codes="codes" :icons="icons" :loading="!loaded" :query="query" v-model:query 透传 … tag-row :tags="vault.tags" v-model:selected-tag-ids v-model:tag-mode … @copy="copy(e)" @dblclick="cancelAutoClose" />`——注意 `@copy` 需要拿到 entry：面板 emit 的是 entry，写法 `@copy="(e) => copy(e)"`；URL 过滤行与 hint 留在面板上方（宿主管辖，不进面板）。
5. `editing` ref 与 EntryForm 编辑路径移除（popup 不再编辑条目——管理在主界面态）；`onSave` 只保留新建分支。
- 测试更新：移除项（添加按钮/粘贴 details/右键菜单/QR dialog/行内 ops）断言删除；新增「打开主界面」按钮（点击 tabs.create options.html#/codes）；prefill 确认态（pending 键 → EntryForm 渲染 → save 落库）；tagRow 面板装配。

- [ ] Step 1: 更新测试（新断言先行，红）
- [ ] Step 2: 改造 → 绿；`pnpm -F @totp/extension test` + `pnpm -F @totp/extension typecheck`
- [ ] Step 3: Commit `feat(extension): popup 精简为快速取码面板（管理面移交主界面态，快捷新增确认态保留）`

### Task 4: background「打开主界面」右键菜单项

**Files:**
- Modify: `apps/extension/entrypoints/background.ts`（菜单注册数组加一项 `otp-open-main`：contexts `['action', 'page']`、标题 i18n 或中文字面量——与现有两菜单同风格；点击处理 `tabs.create({ url: runtime.getURL('options.html#/codes') })`）
- Test: `apps/extension/test/background*.test.ts`（菜单注册幂等与点击分派两用例）

- [ ] Step 1: 失败测试（三个菜单项注册、otp-open-main 点击建 options 标签页）→ 红
- [ ] Step 2: 实现 → 绿；`pnpm -F @totp/extension test`
- [ ] Step 3: Commit `feat(extension): 右键菜单直达主界面态（options#/codes）`

### Task 5: 回归与冒烟清单

- [ ] `pnpm -r run test && pnpm -r run typecheck` 全绿
- [ ] 手动冒烟清单（记入执行记录）：popup——打开主界面按钮/URL 过滤/标签筛选（∧/∨ 切换）/冻结滚动/快捷新增（pendingOtpauth 模拟）→确认态→落库；mini——标签筛选/冻结/pin/复制自动隐藏；Firefox 与 Chrome 各一轮。
