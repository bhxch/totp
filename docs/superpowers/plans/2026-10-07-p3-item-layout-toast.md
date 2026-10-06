# P3 条目布局重构 + toast 体系 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 三端共用的 OtpListItem 改 Aegis 式两行布局（行顶进度条替环形倒计时、上行"服务商/名称"超长跑马灯、下行大号验证码、删行内复制按钮）；新建全仓首个全局 toast 体系并接入复制成功提示；CodesPage 右键菜单加复制验证码/删除；搜索+tab 行冻结顶部。

**Architecture:** OtpListItem 是三端共用组件（桌面 CodesPage、扩展 popup、MiniApp），一处改动三端生效；宿主差异经现有 props（contextMenu/showQr）与新增 props 表达。toast 为模块级事件总线（`useToast()` + ToastHost 单例），MiniApp 不挂载（保留复制后自动隐藏作为反馈）。CodesPage 页面级 batchToast 迁移进新体系后删除。

**Tech Stack:** Vue 3 + vitest + @vue/test-utils（现有 createTestI18n helper）。

**Spec:** `docs/superpowers/specs/2026-10-06-seven-features-design.md` §3

## Global Constraints

- OtpListItem 现有 props（entry/code/remaining/progress/error/icon/contextMenu/index/showQr）与 emits（copy/qr/context）签名不变，只能新增；`showQr` 语义不变（CodesPage 默认 true，popup/MiniApp false）。
- 保留能力零回退：打码 `••• •••`、双击/Shift+Enter 揭示 8s 自动打回、aria-live polite、HOTP 复制递增（宿主层）、多选拼版、拖拽（#lead slot 契约不变）、键盘 Enter 复制、INVALID 展示与 title 提示。
- 进度条保持每秒离散步进，**不得引入 CSS transition 补间**（2026-09-28 GPU profile 实锤：paint 属性补间会把每秒跳变放大为常驻 60fps 重绘）；urgent（progress≤1/3 且非 hotp 非 placeholder）语义保留，进度条转 error 色。
- 复制剪贴板写入仍由宿主 @copy 执行（组件不直写 navigator.clipboard——30s 自动清除链不容绕过）。
- MiniApp 不接 toast（复制后 500ms 自动隐藏即反馈）。
- 测试命令：`pnpm -F @totp/ui exec vitest run <file>`；全量 `pnpm -F @totp/ui test`；三端 typecheck。

---

### Task 1: toast 体系（useToast + ToastHost + 三宿主挂载）

**Files:**
- Create: `packages/ui/src/composables/useToast.ts`
- Create: `packages/ui/src/components/ToastHost.vue`
- Modify: `apps/desktop/src/App.vue`、`apps/extension/entrypoints/options/App.vue`、`apps/extension/entrypoints/popup/App.vue`（根组件挂 `<ToastHost />`）
- Test: `packages/ui/test/useToast.test.ts`、`packages/ui/test/ToastHost.test.ts`

**Interfaces:**
- Produces（Task 2/3 消费）：
  ```ts
  // useToast.ts
  export type ToastKind = 'success' | 'error'
  export interface ToastItem { key: number; message: string; kind: ToastKind }
  export function useToast(): {
    show: (message: string, kind?: ToastKind) => void
    toasts: Readonly<Ref<ToastItem[]>>   // 模块级单例状态，ToastHost 直接渲染它
    dismiss: (key: number) => void
  }
  ```
  - `show`：同 message 的既有 toast 被替换（key 复用）并刷新 3s 计时；不同 message 排队追加，最多同屏 3 条（超出移除最旧）。
  - ToastHost：`fixed bottom: 24px; left: 50%; translateX(-50%)`，深色底（`--md-sys-color-inverse-surface`/`inverse-on-surface`），error 态用 `--md-sys-color-error-container`，圆角 100px，`role="status"` 容器 `aria-live="polite"`；点击单条即 dismiss。
- 挂载位置：三宿主根模板 `<ToastHost />`（无 props）；MiniApp 不挂。

- [ ] Step 1: 失败测试——useToast（show 入队/同 message 替换刷新/超 3 条移最旧/dismiss）+ ToastHost（渲染 message/kind class、点击 dismiss、aria-live）
- [ ] Step 2: 实现 → 绿；`pnpm -F @totp/ui exec vitest run test/useToast.test.ts test/ToastHost.test.ts`
- [ ] Step 3: 三宿主挂载 + `pnpm -F @totp/desktop typecheck && pnpm -F @totp/extension typecheck`
- [ ] Step 4: Commit `feat(ui): 全局 toast 体系（useToast+ToastHost，三宿主挂载）`

### Task 2: OtpListItem Aegis 式两行布局

**Files:**
- Modify: `packages/ui/src/components/OtpListItem.vue`（布局重构；props/emits 只增不改）
- Test: `packages/ui/test/otpListItem.test.ts`（新文件，组件级测试此前缺失）

**Interfaces:**
- Consumes: 现有 props/emits 全保留。
- Produces（新增 props，Task 3 的 CodesPage 可用）：
  ```ts
  /** 行内操作按钮显隐（默认 true 保持 CodesPage 现状；popup/MiniApp 传 false 纯取码行） */
  showQr?: boolean          // 既有，语义不变
  ```
  布局结构（模板骨架）：
  ```html
  <div class="otp-item" ...同现有根属性与事件...>
    <div class="progress-line" aria-hidden="true"><div class="progress-fill" :class="{ urgent }" :style="{ width: progressPct }" /></div>
    <span v-if="$slots.lead || index !== undefined" class="index"><slot name="lead">{{ index }}</slot></span>
    <span class="avatar" ...同现有...>...</span>
    <div class="meta">
      <div class="title-line"><span ref="titleEl" class="title-text" :class="{ marquee: overflowing }">...pin★ + {{ titleLine }}...</span></div>
      <div class="code-line">
        <span :class="['code', ...同现有...]" aria-live="polite">{{ displayed }}</span>
        <MdIconButton v-if="showQrButton" class="show-qr" ... @click.stop="emit('qr')" @dblclick.stop>▣</MdIconButton>
      </div>
    </div>
  </div>
  ```
  - `titleLine = entry.issuer ? (entry.label ? `${entry.issuer}/${entry.label}` : entry.issuer) : entry.label`；label 为空只显 issuer，issuer 为空只显 label。
  - **行内复制按钮删除**（单击行复制语义已覆盖；copy emit 保留）。
  - **环形 SVG 与剩余秒数删除**；`remaining` prop 保留在签名里（不渲染，避免宿主破坏性改动，注释说明）。
  - 进度条：`.progress-line { position:absolute; top:0; left:0; right:0; height:2px; background: var(--md-sys-color-outline-variant); }`，`.progress-fill { height:100%; background: var(--md-sys-color-primary); }`，`.progress-fill.urgent { background: var(--md-sys-color-error); }`；`progressPct = \`${Math.round(progress*100)}%\``；根元素加 `position: relative`。**无 transition**。
  - 跑马灯：`overflowing` 由 `checkOverflow()` 维护（`titleEl.scrollWidth > titleEl.clientWidth`），`onMounted` + `watch([() => props.entry.issuer, () => props.entry.label], checkOverflow, { flush: 'post' })` + `ResizeObserver`（jsdom 缺失则 try/catch 跳过）；`.title-text.marquee` 启用 CSS 动画 `@keyframes marquee { 0%,15% { transform: translateX(0) } 50%,65% { transform: translateX(calc(-100% + 160px)) } 100% { transform: translateX(0) } }`（约 8s/循环，160px≈可视宽；`animation: marquee 8s infinite`）；未溢出无动画。`.title-line { overflow: hidden; white-space: nowrap; }`。
  - urgent 判定复用现有 computed（progress≤1/3、非 hotp、非 placeholder）。
- 测试要点（jsdom 无真实布局，溢出逻辑 stub 处理）：titleLine 三形态（issuer/label、仅 issuer、仅 label）、pin 星标、progress-fill width 与 urgent class、无 `.copy` 按钮、showQr=false 无 QR 钮、`overflowing` 手动置 true 时 title-text 有 marquee class（checkOverflow 用 vi.stubInstance 或直接置 ref 验证 class 绑定）、双击揭示 8s、Enter copy、context 上抛。
- **宿主适配核对（必须全绿）**：CodesPage（showQr 默认 true，无需传）、popup App.vue 与 MiniApp.vue（已传 `:show-qr="false"`——确认 MiniApp 现有传法 `:show-qr=false` 不破坏）；`pnpm -F @totp/ui test && pnpm -F @totp/ui typecheck && pnpm -F @totp/desktop typecheck && pnpm -F @totp/extension typecheck`。现有 CodesPage 系测试若断言了环形/复制按钮结构，按新布局更新断言（行为断言不变，结构选择器改为 `.progress-fill` 等）。

- [ ] Step 1: 新组件测试（红）
- [ ] Step 2: 重构组件（绿）+ 受影响宿主测试更新（绿）
- [ ] Step 3: ui 全量 + 三端 typecheck
- [ ] Step 4: Commit `feat(ui): OtpListItem 改 Aegis 式两行布局（行顶进度条/超长跑马灯/去行内复制）`

### Task 3: CodesPage 右键菜单两项 + 复制 toast + batchToast 迁移 + 冻结

**Files:**
- Modify: `packages/ui/src/pages/CodesPage.vue`
- Test: `packages/ui/test/pages/CodesPage.test.ts`（追加用例）

**Interfaces:**
- Consumes: Task 1 useToast、Task 2 新布局。
- Produces: 行为变更四处——
  1. 右键菜单新增两项（MdMenu 内，顺序：**复制验证码** / 编辑 / 显示二维码 / 复制 otpauth URI / **删除** / 置顶切换）：`contextCopyCode(entry)` 取 `codes.get(uuid)?.code` → `emit('copy', code)` + `toast.show(t('codesPage.copied'))` + 关菜单；`contextDelete(entry)` = 关菜单 + `confirmingDelete.value = entry.uuid`（进入行内两击确认态，复用现有 askRemove 语义与 3s 超时）。
  2. `onCopy` 末尾加 `toast.show(t('codesPage.copied'))`（复制失败仍由宿主横幅负责，本条只做成功提示）。
  3. batchToast 页面级实现删除（batchToast ref/timer/模板 div/样式），`onBatchAdded` 改 `toast.show(t('codesPage.batchImported', { n: count }))`。
  4. 冻结：`SearchBar` 与 `.chips-row` 包进 `<div class="frozen">`，样式 `.frozen { position: sticky; top: 0; z-index: 5; background: var(--md-sys-color-surface); padding-bottom: 4px; }`（滚动祖先为 NavigationShell 内容区；卡片内背景与页面同色不突兀）。
- i18n 新键（zh/en）：`codesPage.copied`（"已复制"/"Copied"）、`codesPage.ctxCopyCode`（"复制验证码"/"Copy code"）、`codesPage.ctxDelete`（"删除"/"Delete"）。

- [ ] Step 1: 失败测试（右键菜单含 6 项、复制验证码 emit copy+toast、删除项进入 confirmingDelete、onCopy 触发 toast、frozen 结构存在、batch-toast div 不再渲染而走 toast）→ 红
- [ ] Step 2: 实现 + i18n → 绿；`pnpm -F @totp/ui exec vitest run test/pages/` + 全量 + 三端 typecheck
- [ ] Step 3: Commit `feat(ui): CodesPage 右键复制/删除项、复制 toast 与筛选区冻结`

### Task 4: popup 复制横幅迁移 toast + 全量回归

**Files:**
- Modify: `apps/extension/entrypoints/popup/App.vue`（"已复制/复制失败"横幅区移除：成功走 toast，失败保留 error toast）
- Test: `apps/extension/test/`（现有 popup 测试按新反馈形态更新断言）

**Interfaces:**
- Consumes: Task 1（popup 已挂 ToastHost）。
- 行为：复制成功横幅替换为 `toast.show(t('popup.copied'))`；复制失败横幅替换为 `toast.show(message, 'error')`。popup 复制后按 `popupCloseDelayMs` 延迟关窗机制不变（toast 在关窗前可见）。

- [ ] Step 1: 更新 popup 测试断言（横幅→toast）→ 红
- [ ] Step 2: 实现 → 绿；`pnpm -F @totp/extension test` + typecheck
- [ ] Step 3: `pnpm -r run test && pnpm -r run typecheck` 全绿
- [ ] Step 4: Commit `feat(extension): popup 复制反馈迁移全局 toast`

### Task 5: 收尾

- [ ] 手动冒烟清单（不阻塞 commit，结果记入执行记录）：桌面 dev——CodesPage 新布局走查（进度条/两行/跑马灯长名/右键 6 项/复制 toast/冻结滚动）；Mini 走查（无操作按钮、复制即隐藏）；扩展 dev——popup 新布局+toast、options CodesPage 同桌面。
- [ ] 如有 i18n 新键未对齐，跑 zh/en deep key-set 对比。
