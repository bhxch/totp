# TOTP Tools E2E 测试文档

| | |
|---|---|
| 文档性质 | **活文档**——E2E/真机测试的唯一权威文档。用例扩充、执行记录、缺陷登记均在本文件进行，不另开日期文档 |
| 当前版本 | v1.0（2026-09-26，由日期文档整合而成，见 §7 变更记录） |
| 范围口径来源 | 覆盖率方案 §1.2/§1.3/§4/§7（已归档：`docs/plans/2026-09-25-coverage-design.md`） |
| 记录格式先例 | `docs/review/2026-09-23-batch8-real-machine-test.md`（已归档） |

---

## 1. 范围与口径

### 1.1 E2E 管什么

测试分层采用 L1/L2/L3 三层口径：L1 纯逻辑与 L2 组件宿主由单元测试覆盖并受 CI 覆盖率 gate 约束；
**L3 集成胶水层不折算覆盖率百分比，以真机场景清单（即本文档）管理**。归属 E2E 的内容：

1. 豁免清单中的代码（无法单测的 OS/浏览器/WebView2/托盘/系统对话框接线）；
2. 依赖真实环境才能验证行为的场景（DPAPI、锁屏广播、剪贴板占用、端口绑定、跨进程审批 UI 等）。

### 1.2 豁免清单（不要求覆盖、走 E2E 或接受不测的部分）

| 豁免项 | 理由 |
|---|---|
| apps/desktop/src/main.ts、mini.ts | createApp 三行入口装配（已登记 coverage exclude） |
| src-tauri main.rs、lib.rs run() 装配段 | Tauri Builder/generate_context/托盘/快捷键装配，无 AppHandle 不可构造 |
| src-tauri lock_events.rs 消息泵 | extern "system" wndproc + Win32 消息循环，走真机（D3） |
| src-tauri pick_dir_os / pick_open_file_os / pick_save_file_os | 系统对话框 |
| src-tauri try_suspend_window | WebView2 COM 调用 |
| src-tauri on_window_event 主体 | 窗口事件接线 |
| apps/extension popup/main.ts、options/main.ts | createApp 入口 |
| packages/ui theme/generate.mjs、纯类型 *Platform.ts | 构建脚本/无运行时逻辑 |

不豁免的关键项：`background.ts`（defineBackground stub 后单测覆盖）与 `wxt.config.ts`（manifest
断言单测覆盖）——这两者的业务逻辑不依赖真机，不在 E2E 范围内。

### 1.3 三选一规则

`docs/plans/2026-09-25-coverage-inventory.md` 盘点的每条业务场景必须落在
**单元测试 / E2E 清单项（本文档）/ 豁免理由** 三选一，无遗漏。扩充用例时同规则约束。

### 1.4 分发渠道 → 代码映射

- Chrome 扩展 = packages/core + packages/ui + apps/extension（含 offscreen 通道）
- Firefox 扩展 = 同上（无 offscreen、含 `ext+otpauth` 协议回调）
- 桌面版（NSIS 安装版/便携版/rpm·deb）= core + ui + apps/desktop/src + src-tauri

---

## 2. 环境与工具

### 2.1 构建与启动

```bash
cd apps/desktop && pnpm tauri build --debug   # mcp-bridge 仅 debug 构建注册
# 产物：apps/desktop/src-tauri/target/debug/totp-desktop.exe
# GUI 模式：直接运行 exe；headless MCP：--headless-mcp --mcp-port N --mcp-token T（T≥16 字符、N≥1024；CLI token 不落盘）
```

### 2.2 驱动方式

| 通道 | 用法 |
|---|---|
| tauri-mcp driver-session | `tauri-mcp driver-session start --port 9223`；status --json 必须 `connected:true` |
| 命令直驱 | `webview-execute-js` 内 `window.__TAURI__.core.invoke('命令', 参数)`——绕开 ipc-execute-command 带参不兼容坑 |
| 事件注入 | `ipc-emit-event --event-name X --payload '{}'`（可直驱 stash-dek-request 等前端监听事件） |
| headless MCP | `curl POST http://127.0.0.1:<port>/mcp`，`Authorization: Bearer <token>`，`Accept: application/json, text/event-stream`；时序 initialize→(mcp-session-id 头)→notifications/initialized→tools/call。**审批在 tools/call 触发**，非 initialize |
| UI 操作 | webview-interact/keyboard（trusted input）；Vue patch 异步，合成事件后须 `await setTimeout` 再读 DOM |

### 2.3 测试金库与凭据

- 位置 `%APPDATA%\com.totp.desktop`；主口令 `Test-Pw!234`；内置条目 8 条 + 历史测试条目。
- 备份口令（会话/保管区）`Test-Backup!234`；本地备份源（keep n=3，AppData/backups）。
- **Windows auto-unlock（DPAPI）已启用**：重启免口令直达解锁态；如需测锁定页，先在 Security 页移除该来源。
- MCP：wildcard 档，端口 48215，token 见 settings.json `mcp.token`；白名单含 `mcp-e2e`、`curl-probe-2`（测试客户端，用于免审批调用）。

### 2.4 已知平台/工具坑（执行前必读）

| 坑 | 说明与对策 |
|---|---|
| 锁屏渲染挂起 | LogonUI 状态下 WebView2 挂起渲染，eval/IPC/截图全部超时——平台固有行为。E2E 期间勿锁屏；D3 需人工配合 |
| EntryForm 两个 Add | 表单内标签区的「+ Add」（createTagAndCheck）与真正的提交按钮（`button[type=submit]`，新建时文案也是 Add）并存——自动化必须选 `button[type=submit]` |
| 0.0.0.0 不阻塞 127.0.0.1 | Windows 多层绑定语义：通配占用不阻止具体地址绑定。端口冲突测试必须用 `127.0.0.1` 精确占用（python http.server 绑 0.0.0.0 无效） |
| once=15min 会话授权 | 首连审批「Allow once」是 15 分钟会话授权，非单次放行；窗口内重连免弹窗属预期 |
| settings 热改 | 应用运行中直接编辑 settings.json 安全（tauriFs 写路径合并保外来键）；mcp 的 mode/whitelist/exposedTools 每请求重读即时生效，enabled/port/token 改动需重启 |
| 隐藏窗 JS 仍可执行 | 隐藏≠挂起：TrySuspend 挂起与否是 WebView2 内部行为，勿以「JS 冻结」推断挂起发生 |
| 单实例 | 已接 tauri-plugin-single-instance：第二实例（GUI/headless）干净 exit 0 并聚焦主窗（B22 修复） |

---

## 3. 测试用例目录

用例编号规则：桌面 `D<n>`、扩展 `E<n>`，扩充续接（当前 D1–D7、E1–E6）。
每条用例变更须同步更新「变更记录」。状态含义：✅ 通过（最近执行）/ ⏳ 待执行 / 人工=需人工配合的子步骤。

### D1 释放策略三档联动 [可自动化；托盘重建回注=人工]

- **前置**：debug 构建；driver-session 连接；金库解锁。
- **步骤**：①DEK 暂存回环：`ipc-emit-event stash-dek-request` → JS `take_stashed_dek` 应返回 44 字符 base64（32B DEK）、二次 take 返回 null。②Pause 档：`release_policy_set {pauseMinutes:1,destroyMinutes:0,lockOnPause:true}` → JS 隐藏双窗 → 90s 后库应自动锁定（空闲锁定需为 0）。③Destroy 档：`{pauseMinutes:0,destroyMinutes:1,lockOnDestroy:false}` → 隐藏 95s 后 webview 全销毁（manage-window totalCount:0）且进程存活。
- **预期**：①②③如上；托盘点击重建后 `take_stashed_dek` 回注免解锁【人工】；destroy 失败回滚由单测覆盖（apply_destroy_with_rollback）。
- **源码**：`src-tauri/src/release_policy.rs`；`src-tauri/src/lib.rs` release_tick/take_stashed_dek；前端 `src/desktopShell.ts`。

### D2 剪贴板 stage/clear 真机 [可自动化；第三方占用=人工]

- **前置**：金库解锁；`clipboardClearEnabled=true`。
- **步骤**：复制任一验证码 → PowerShell `Get-Clipboard` 读回验证码本体 → 等 30s+ → 剪贴板为空。
- **预期**：stage 写入成功；30s 自动清空。第三方独占剪贴板时复制失败横幅、clear 走 fail-safe 清空（该分支由 `should_clear_clipboard` 单测覆盖）。
- **源码**：`src-tauri/src/lib.rs`（CLIPBOARD_STAGE/should_clear_clipboard）；前端 desktopCopy/clearer 链路。

### D3 锁屏广播 → system-lock → 锁库 [锁屏触发=人工]

- **前置**：应用运行；`lockOnSystemLock=true`。
- **步骤**：人工 Win+L（或 `rundll32.exe user32.dll,LockWorkStation`，会锁整个交互会话，自动化勿触发）→ 解锁回观。
- **预期**：WTS_SESSION_LOCK → `system-lock` 事件 → 前端锁库；关闭开关后锁屏不锁库。
- **源码**：`src-tauri/src/lock_events.rs`；前端 desktopShell force-lock 处理。
- **注意**：锁屏期间 WebView2 挂起，解锁前无法驱动应用（见 2.4）。

### D4 MCP 首连审批三键 + 工具确认两键 + 冷却 + trust 持久化 [可自动化]

- **前置**：debug 构建（非 headless，审批需 UI）；curl JSON-RPC 通道就绪；金库解锁（list_accounts 才有内容）。
- **步骤**：①新 ident（白名单外 clientInfo.name）tools/call → 弹审批框（Client/Requested tool 文案）→ Deny → 60s 内重连应得 `approval denied; try again in about a minute`；②60s 过期后重弹 → Allow once → 工具成功（once=15min 会话授权，窗口内重连免弹窗属预期）；③新 ident → Add to whitelist → 立即放行 + settings.json 白名单落盘 → **重启应用**重连仍免弹窗；④exposedTools 含 trigger_backup（Action 工具）→ tools/call → 弹「Allow trigger_backup?」两键：Deny → `tool call denied by user`；Allow → `{"triggered":true}`。
- **预期**：全链如上；无人值守（headless）fail-closed。
- **源码**：`src-tauri/src/mcp_server.rs`（GateOutcome 决策链/冷却/once-TTL/trust）；前端 `McpConsentDialog.vue` + `mcpApprovalQueue.ts`。

### D5 自动备份落盘与 lastBackupHash 语义 [可自动化；还原通道=人工可选]

- **前置**：金库解锁；会话备份口令已设；本地源启用；Back up on change 开启。
- **步骤**：①改库（编辑条目备注经 `button[type=submit]` 提交）→ 10s 防抖后 backups 目录出现 `vault-<ts>.totpbackup`，lastBackupHash 基线 + backupAutoStatus=ok；②内容未变时 `trigger_backup`（runBackupNow 绕偏好门、守护照常）→ 静默跳过（无新文件、基线/状态不动）；③删除落盘文件 → 再改库 → 文件重写。
- **预期**：如上三段；落盘文件可被「恢复」通道还原（需本地文件选择器，人工可选；envelope 往返有单测）。
- **源码**：`src/autoBackup.ts`、`src/backupPlatform.ts`、`src/desktopPrefs.ts`；Rust 读盘命令 `*_granted`。

### D6 DPAPI 真机 roundtrip [可自动化；跨用户会话=人工]

- **前置**：金库解锁；加密已启用。
- **步骤**：Security → Enable Windows auto-unlock（卡片出现 Remove）→ 重启应用。
- **预期**：重启直达解锁态（无锁定页），DPAPI 当前用户态解包 DEK；跨用户/跨会话解不开 fail-closed【人工：另一用户登录验证】。
- **源码**：`src-tauri/src/lib.rs` os_auto_protect/unprotect；前端 desktopShell 解锁链。

### D7 devtools/MCP 端口冲突拦截 [可自动化]

- **步骤**：①`devtools_set_config` 端口=MCP 端口 → Err「已被 MCP 服务器占用」；②合法端口 → OK；③占住 `127.0.0.1:<port>`（精确绑定！见 2.4）后启动 `--headless-mcp --mcp-port <port>` → stderr 报 bind failed (os error 10048) 且 exit=2。
- **预期**：配置期与启动期冲突均明确报错不静默。
- **源码**：`src-tauri/src/lib.rs`（devtools 判定）、`mcp_server.rs`（start_server_with 空 token/bind 失败）。

### E1 SW 休眠唤醒后右键菜单仍在 [手测·Chrome/Firefox]

SW 休眠（chrome://serviceworker-internals 手动 Stop 或等空闲）→ 唤醒（点 popup）→ 右键页面/图片看菜单项仍在不叠加。源码 `entrypoints/background.ts`（contextMenus.create ×2 + onClicked）。

### E2 右键图片 QR 识别 → pendingOtpauth → popup 保存全链 [手测·Chrome]

右键含 otpauth QR 的图片 → 「识别 QR」→ popup 预填（issuer/label/secret 正确）→ 保存入库；坏图/非 QR 提示不可识别。源码 `background.ts` onClicked → `src/qrDecode.ts`；`popup/App.vue` 消费即清除。

### E3 30s 清剪贴板承诺（offscreen 重试链路） [手测·Chrome]

复制验证码 → 关 popup → 手动复制其他内容干扰 → 30s 后剪贴板清空；复制后手动 Stop SW 再唤醒仍能清空（3 次重试 + ensureOffscreen 竞态防护）。源码 `background.ts` clearClipboardWithRetry；`offscreen.ts`。

### E4 Firefox `ext+otpauth://` 协议回调 → popup 预填 [手测·Firefox 140+]

系统级唤起 `ext+otpauth://...` → 选本扩展 → popup 打开并预填 → 保存入库。源码 `wxt.config.ts` protocol_handlers；`popup/App.vue` ?uri= 消费。

### E5 Firefox 无 offscreen 降级 [手测·Firefox]

复制验证码 → 30s 后剪贴板不清（行为可预期）→ 扩展 console 无 unhandled rejection 刷屏。源码 `background.ts` ensureOffscreenDocument 放弃分支；对照 `wxt.config.ts` manifest 差异。

### E6 大库接近 chrome.storage.sync 配额时 quota 状态展示 [手测·Chrome]

构造接近 QUOTA_BYTES 的同步负载（大量条目分片）→ 用量 >90% 时状态切 `quota` 展示；真实越界写失败走 error 分支可恢复。源码 `src/syncEngine.ts` quota 判定；options 同步卡。

---

## 4. 执行记录索引

**归档规则**：每次执行的详细记录（逐项方法/结果、当日发现与处置）写入
`docs/e2e/YYYY-MM-DD-<主题>.md`（按日期归档），并在下表登记一行索引。
截图与原始日志放 `.temp/` 或 `E:\tmp\cc\`，不入库。

| 日期 | 范围 | 结果 | 记录文件 |
|---|---|---|---|
| 2026-09-26 | D1–D7、E1–E6、B22/B23 复验（覆盖率批次） | 桌面 6/7 自动化通过（D3 登记人工）；E1–E6 保持手测；发现 B22/B23 当日修复并复验 | `docs/e2e/2026-09-26-coverage-e2e-checklist.md` |
| 2026-09-23~24 | batch⑧ 八项改进（8/8 有结论，3 缺陷当批修复；Firefox idle README 勘误） | 通过 | `docs/review/2026-09-23-batch8-real-machine-test.md`（归档先例，早于 `docs/e2e/` 归档规则） |

---

## 5. 缺陷与处置登记索引

各批次发现的缺陷与处置**明细在对应日期的记录文件内**（见 §4 记录文件列）；
**未修复项必须同步登记 `docs/plans/2026-09-22-review-backlog.md`（活文档）**。已修复缺陷速查：

| 日期 | 缺陷 | 处置 | 明细 |
|---|---|---|---|
| 2026-09-26 | B22 双实例启动 panic（全局快捷键冲突 exit 101） | 已修复+复验：tauri-plugin-single-instance（90d9ab2） | `docs/e2e/2026-09-26-coverage-e2e-checklist.md` §四 |
| 2026-09-26 | B23 MCP 工具确认连续请求异常（10s 去重窗误合并不同 oneshot id） | 已修复+真机复验：工具确认独立入队、去重仅保留首连审批（91abb0c/763184d） | 同上 |
| 2026-09-24 | 壳层锁高隐性滚动 / 桌面剪贴板权限挂起 / 销毁档进程退出 | 已修复（三项） | `docs/review/2026-09-23-batch8-real-machine-test.md` §四 |
| 2026-09-23 | README「Firefox 空闲锁定不可用」表述过时 | 已勘误（idle API 已支持，min_version 140） | 同上 |

---

## 6. 扩充指南

1. **新增用例**：编号续接（D8+ / E7+），按 §3 格式补全「自动化标注/前置/步骤/预期/源码」五要素，并在 §7 变更记录追加一行。范围判定参照 §1：只有依赖真实环境、单测不可达的行为才进 E2E。
2. **执行与记录**：每次执行新建 `docs/e2e/YYYY-MM-DD-<主题>.md`（逐项方法/结果 + 当日发现与处置），并在 §4 索引表登记一行。
3. **发现缺陷**：当批修复则在当日记录文件登记「已修复」；不能当批修复的，登记 `docs/plans/2026-09-22-review-backlog.md` 并在记录文件注明编号。
4. **口径变更**（豁免增减、分层调整）：本文档 §1 修改即可生效，无需新开日期文档；若与已归档的覆盖率方案冲突，以本文档为准并在变更记录注明。

## 7. 变更记录

| 日期 | 变更 | 备注 |
|---|---|---|
| 2026-09-26 | v1.1 执行记录与缺陷登记改为 `docs/e2e/` 按日期归档，§4/§5 改为索引制 | 09-26 批次记录移至 `docs/e2e/2026-09-26-coverage-e2e-checklist.md`（git mv 保留历史） |
| 2026-09-26 | v1.0 整合成文 | 吸收 `docs/plans/2026-09-25-coverage-design.md` §1.2/§1.3/§4/§7 口径、`docs/e2e/2026-09-26-coverage-e2e-checklist.md`（原 docs/review/ 下）全部用例与执行记录、`docs/review/2026-09-23-batch8-real-machine-test.md` 缺陷登记；并含 B22/B23 修复后真机复验结果（90d9ab2/91abb0c/763184d） |
