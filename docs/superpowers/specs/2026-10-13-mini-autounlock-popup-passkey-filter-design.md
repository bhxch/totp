# 设计：mini 窗自动解锁 / popup Passkey 解锁窗 / 站点无匹配提示收行

日期：2026-10-13
状态：待评审
来源：用户评审对话（mini 看不了 → 对齐主窗；popup 无 Passkey 入口 → 方案 A；无匹配提示占行 → 收进过滤行）

三个独立但同批的特性，各自可单独实现与回滚：

- **A** 桌面端 mini 窗在锁定态打开/聚焦时静默自动解锁（对齐主窗 LockScreen 行为）。
- **B** 扩展端 popup 锁定屏提供 Passkey 解锁入口，经独立解锁窗口完成 WebAuthn（方案 A：跳窗）。
- **C** 扩展端 popup 站点过滤无匹配时的回退提示从独立行收进过滤行（与「匹配 N 条」同一行）。

非目标：

- 不给扩展端引入 OS 凭据（DPAPI/keyring/ABE）或 nativeMessaging 通道（另立项目才考虑）。
- 不改锁定语义本身：空闲/系统锁屏触发条件、lock() 清理范围均不动。
- 不动 desktop 的 ABE/DPAPI 绑定与解绑流程（os_auto_protect / os_auto_forget / abe_bind/wrap/remove 仍仅主窗）。

---

## A. 桌面端 mini 窗自动解锁

### 现状

主窗「OS 自动解锁」链路：锁定 → App.vue 渲染 LockScreen（`apps/desktop/src/App.vue:136`）→ 其 onMounted 静默尝试 ABE unwrap，失败回退 DPAPI/keyring（`packages/ui/src/components/LockScreen.vue:47-90`）。三条解锁通道在 Rust 侧均门控 `label=="main"`：

| 通道 | 门控位置 |
|---|---|
| Windows DPAPI | `dek_unprotect_inner`（`platform_security.rs:261`） |
| macOS/Linux keyring | `os_auto_unprotect`（`platform_security.rs:320`） |
| ABE 提权服务 | `abe_unwrap_impl`（`elevation_commands.rs:173`） |

mini 是同进程第二个独立 WebView（`mini.html` 入口，`apps/desktop/src/MiniApp.vue`），不渲染 LockScreen、不传 dpapi/abe ops，唯一解锁来源是主窗写的进程内 `MINI_DEK` 槽（`session_vaults.rs`）+ `mini-session` 事件。主窗锁定即清槽并推锁，mini 只剩「主窗口解锁后此窗口可用」空态。

### 变更

**Rust（2 文件）**：

1. `platform_security.rs` 新增 `ensure_auto_unlock_label(label)`：放行 `"main" | "mini"`，其余拒绝；与既有 `ensure_main_window_label`（`platform_security.rs:10-16`）并排。
2. 三处解锁通道的门控由 `ensure_main_window_label` 换为 `ensure_auto_unlock_label`：
   - `dek_unprotect_inner`（Windows DPAPI 解）
   - keyring 分支 `os_auto_unprotect`（macOS/Linux）
   - `abe_unwrap_impl`（Windows ABE unwrap；非 Windows 桩不变）

   **保持 main-only 不变**：`dek_protect_inner` / keyring `os_auto_protect` / `os_auto_forget`（写/删来源是设置动作）、`abe_bind` / `abe_wrap` / `abe_remove`、`decrypt_dpapi`（WinAuth 导入，现有测试 `platform_security.rs:497` 断言 mini 拒绝，保留）。`set/peek/clear_mini_dek` 的 label 所有权不变。
3. 更新相关注释（`platform_security.rs:283`「仅主窗口可调用」等）为「仅 main/mini 可调用」。

**前端（2 文件 + 测试）**：

1. `packages/ui`：把 LockScreen.vue:47-90 的静默解锁（ABE 优先 → DPAPI 回退，含 1s 失败「重试」态）原样抽为共享函数（如 `src/store/osAutoUnlock.ts` 导出 `attemptOsAutoUnlock(store, ops): void`）；LockScreen 改为调用，行为与现测试不变。
2. `apps/desktop/src/MiniApp.vue`：`load()` 中 boot 完成后若仍锁定（槽空），调用共享函数（dpapi/abe ops 直接复用 `securityPlatform.ts` 既有对象，App.vue 同源）。时序：先 peek 槽（主窗已解锁的免费路径），槽空才走 OS 通道；OS 通道不可用（未启用自动解锁/失败）维持现有空态文案，无新增 i18n。

### 行为语义

- mini 打开与聚焦都会重建 store（`MiniApp.vue:122-124`），故语义为「打开/聚焦时若锁定即静默解锁」——与主窗「锁定即渲染 LockScreen 即静默解锁」完全对齐。
- 主窗推来的锁（`mini-session locked:true`）会触发 mini 重跑 `load()` → 立即静默解回。这是主窗自身行为的镜像，属预期：OS 自动解锁开启时，「锁」在两端都只挡到下一次打开/聚焦为止。
- mini 自解不回写 `MINI_DEK` 槽（`set_mini_dek` 仍 main-only）：mini 的 DEK 持在自己的 windowId 会话里，槽保持「主窗解锁态镜像」语义。

### 安全边界（诚实边界，登记进代码注释）

`platform_security.rs:237-239` 已登记：锁定态下 webview 可解出 DEK 即「静默自动解锁」特性本身。mini 与主窗同进程、同 capabilities（`capabilities/default.json` 同组）、同用户会话，放宽后信任边界无外扩；能操作桌面会话者本就可打开主窗触发同样的静默解锁。净新增暴露 ≈ 0，但「可自解的 webview」从 1 个变 2 个。

### 测试

- Rust：现有门控单测翻转（三通道 mini 现在放行；`"popup"` 等其他 label 与 protect/forget/bind/wrap/remove 的 main-only 断言保留）；`decrypt_dpapi` mini 拒绝断言不动。
- 前端 vitest：共享函数单测（ABE 成功/失败回退 DPAPI/全败）；MiniApp 锁定 boot 调用路径（mock invoke）。
- 真机：Windows DPAPI 实跑（锁定 → alt+shift+t 开 mini → 静默出码）；mac/linux keyring 走 CI + 真机验证登记 backlog。

---

## B. 扩展 popup Passkey 解锁（方案 A：独立解锁窗）

### 现状与根因

popup 锁定屏只门口令：`popup/App.vue:330` 传 `:allow-passkey="false"`，`LockScreen.vue:43` 据此不渲染 Passkey 按钮。根因（提交 3af7bf3 审查结论）：popup 是失焦即销毁的临时窗口，WebAuthn 认证器弹窗夺焦即销毁 popup、`get()` 中断，该入口在 popup 恒失败。options 页为普通标签页不受影响，已有可用入口。

### 变更

**新入口页（`apps/extension/entrypoints/unlock/`，镜像 options 的 `index.html + main.ts + App.vue` 结构）**：

- WXT 无列表页，构建产物 `unlock.html`（`chrome-extension://<id>/unlock.html`），manifest 无需声明、无需新权限。
- boot 与 options 同构（windowId=`'unlock'` 的独立会话；`dekPersist` 读写 `chrome.storage.session` 同 options）。
- 渲染完整 LockScreen（allowPasskey 默认 true，含口令表单与 Passkey 按钮——真窗口内 inline WebAuthn 可正常完成）。
- **自动发起**：URL 带 `?unlock=passkey` 时，挂载后待 PRF 能力探测完成，若可用且已绑定来源则自动触发一次 Passkey 解锁（等价用户点击）；不可用则停留完整锁屏（口令兜底）。LockScreen 增 prop `autoPasskey?: boolean` 支撑，自动发起复用 `onPasskeyUnlock` 既有 busy/msg 通道。
- **关闭时机**：boot 时已解锁（session DEK 在）→ 立即 `window.close()`；解锁成功 → `window.close()`；失败/取消 → 停留（完整锁屏可重试或改口令）。
- 窗口：`ext.windows.create({ url: runtime.getURL('unlock.html?unlock=passkey'), type: 'popup', width: 400, height: 560 })`；窗口标题用 `t('lock.title')`（无新增 i18n 键）。

**popup 侧（`popup/App.vue` + LockScreen API）**：

- `LockScreen` 增 prop `passkeyMode?: 'inline' | 'external'`（默认 `'inline'`，desktop/options 不受影响）。`external` 时按钮显隐与禁用逻辑不变（prfSources 非空 + 能力探测），点击不执行 inline 解锁，改为 emit `external-unlock` 事件，由宿主决定跳转动作。
- `popup/App.vue:330` 改为移除 `:allow-passkey="false"`、传 `passkey-mode="external"` 并监听 `@external-unlock` → `ext.windows.create(...)` 打开解锁窗。popup 随之因失焦销毁，属预期流程：用户在解锁窗完成验证 → session DEK 写入（`dekSession.ts`，所有上下文共享）→ 窗自关 → 用户再点工具栏 popup → `initStore` 读 session DEK 自动免密。无法编程重开 popup（`action.openPopup` 受限），不做。
- 若 PRF 不可用/未绑定：按钮照旧不显示或禁用，popup 行为与现状一致（口令解锁）。

### 测试

- LockScreen vitest：`passkeyMode='external'` 点击改 emit 不执行 inline；`autoPasskey` 自动发起一次（能力 unknown 时等待、false 时不发）。
- unlock 页 vitest：`?unlock=passkey` 自动发起；已解锁 boot 即关窗（mock window.close）；失败停留。
- 手测（Chrome + Firefox）：popup 点击 → 解锁窗弹出 → UV 完成 → 自关 → 重开 popup 免密；取消路径停留可重试。

---

## C. popup 站点无匹配提示收进过滤行

> 解读假设（请评审确认）：「显示全部放同一行」指**回退提示文案**与过滤控件同一行——现状无匹配时已回退显示全部条目（`packages/ui/src/popupFilter.ts:60-65`），但提示（如「当前站点无匹配，显示全部」）单独占一行（`popup/App.vue:356`），浪费 popup 纵向空间。若本意是别的（如条目列表布局变化），评审时指出，本节重写。

### 现状

四级回退链（搜索 → tag → URL）在无 URL 命中时返回 `visible=tagged 全部` + hint key。渲染端：过滤行内仅在命中时显示「匹配 N 条」（`popup/App.vue:353`，条件含 `!filterResult.hint`）；回退 hint 恒在下方独立行（`popup/App.vue:356`，且不受 tabUrl 门控——无标签页 URL 时也靠它）。

### 变更

仅动 `popup/App.vue` 模板（过滤编排 `resolvePopupVisible` 纯函数不动）：

- `tabUrl` 存在（过滤行可见）时，hint 收进过滤行与 checkbox 同行，替换「匹配 N 条」的位置：有 hint 显示 hint，无 hint 且命中显示「匹配 N 条」（二者互斥，恰覆盖现有两个 span 的条件并集）。
- `tabUrl` 不存在时，保持现有独立 hint 行（`v-if` 收紧为 `!tabUrl && filterResult.hint`），否则 hint 无处渲染。
- 布局：inline hint 加 `min-width: 0` + ellipsis 溢出省略（popup 窄，hint 最长「当前站点无匹配，显示全部」≈ 12 CJK 字符，与「按站点过滤」checkbox 同行放得下；省略防极端 i18n 长串撑行）。
- i18n 零新增（复用 `popupFilter.hint*` 四键与 `popup.matchCount`）。

### 测试

popup App 组件测试：命中态（行内「匹配 N 条」）、无匹配态（行内 hint、独立行消失）、无 tabUrl 态（独立行保留）三态断言。

---

## 实施与验收顺序

1. A（desktop，独立可发布）→ 2. C（最小，先落一个纯 UI 批）→ 3. B（含新入口页，单独一批）。
每项独立 commit（源码 + 测试 + CHANGELOG），随下个版本发布。验收基准：三批各自全量 vitest + desktop cargo test 绿；A 加 Windows 真机一项；B 加双浏览器手测一项。
