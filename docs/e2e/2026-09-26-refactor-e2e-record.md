# 重构后桌面 E2E 回归记录（2026-09-26 批次 · 执行于 2026-09-27）

> **本文件为重构批次的 E2E 执行记录归档**（`docs/e2e/` 按日期归档；文件名沿用重构批次日期
> 2026-09-26，实际执行窗口为 2026-09-27 06:45–08:05）。用例目录、范围口径与扩充指南见活文档
> **`docs/e2e-test.md`**；格式先例 `docs/e2e/2026-09-26-coverage-e2e-checklist.md`。

状态：**桌面 D1–D7 回归完毕——6 条自动化通过，D2 受阻（宿主机剪贴板被提权第三方进程锁死，
经六项只读核查归因为环境故障、非重构引入，refactorCaused=false）**。D3 未执行（锁屏触发=人工，
沿用前批登记）。未发现产品缺陷，无需登记 backlog。扩展 E1–E6 不在本次回归范围（保持手测）。

## 一、执行环境与范围

| 项 | 值 |
|---|---|
| 回归对象 | 重构基线 `a385f1b`（docs(review): 全项目代码设计审视与重构方案）→ 执行时 HEAD `21fd241`，共 79 个提交，覆盖 R1–R16 十六项重构 |
| 构建 | `cd apps/desktop && pnpm tauri build --debug` 成功（vite build ✓ + cargo dev profile 23.82s）；产物 `apps/desktop/src-tauri/target/debug/totp-desktop.exe` 时间戳 2026-09-27 06:45:04（新构建，非残留） |
| 驱动 | `tauri-mcp driver-session start --port 9223` → status --json `connected:true`、identifier `com.totp.desktop`（netstat 确认 127.0.0.1:9223 LISTENING 属应用进程 PID） |
| 环境 | Windows 10.0.26200 x64；测试金库 `%APPDATA%\com.totp.desktop`（口令 `Test-Pw!234`，解锁后 Entries (9)）；DPAPI 自动解锁启用（直达 #/codes，无锁定页）；MCP wildcard 48215 + settings 内 token + 白名单 `['mcp-e2e','curl-probe-2']` |
| 锁屏 | 执行期间未锁屏（§2.4 坑规避） |

重构项概览（重构批次内验证状态，登记备查）：

| 项 | 状态 | 项 | 状态 |
|---|---|---|---|
| R2 | 已通过（返工后） | R10 | 已通过 |
| R8 | 已通过 | R6 | 已通过 |
| R1 | 已通过 | R5 | 已通过 |
| R3 | 已通过（返工后） | R4 | 已通过 |
| R9+R11 | 已通过 | R16-rust | 已通过 |
| R15+R12 | 已通过 | R16-core | 已通过 |
| R13 | 已通过 | R7 | 已通过 |
| R14 | 已通过 | R16-uiext | 受阻 |

## 二、结果总览

| # | 用例 | 结果 |
|---|---|---|
| D1 | 释放策略三档联动 | ✅ 通过（托盘重建回注=人工项未执行） |
| D2 | 剪贴板 stage/clear 真机 | ⛔ 受阻（宿主剪贴板被提权进程锁死；失败横幅分支意外真机触发半边通过；归因非重构引入） |
| D3 | 锁屏广播 | ➖ 未执行（锁屏触发=人工，沿用前批登记） |
| D4 | MCP 首连审批/工具确认/冷却/trust | ✅ 通过（四段全通过） |
| D5 | 自动备份落盘与 lastBackupHash 语义 | ✅ 通过（三段全通过） |
| D6 | DPAPI 真机 roundtrip | ✅ 通过（自动化部分；跨用户会话=人工项） |
| D7 | devtools/MCP 端口冲突拦截 | ✅ 通过（三段全通过） |

## 三、逐用例记录

### D1 释放策略三档联动 ✅

**方法与证据**（GUI PID 25352，driver-session 9223 connected:true，金库经 DPAPI 自动解锁直达 #/codes，Entries (9)，无锁定页）：

1. **①DEK 暂存回环 ✓**：`ipc-emit-event --event-name stash-dek-request` 后 JS invoke `take_stashed_dek` 返回 `"0fLfCViLHqkjEHUswpVeLgBgOlg8Hr+WX92UUnwYuDA="`（长度 44，32B DEK base64）；二次 take 返回 null（取即清，`apps/desktop/src-tauri/src/session_vaults.rs:89` dek_slot_take）。
2. **②Pause 档 ✓**：`release_policy_set {pauseMinutes:1,destroyMinutes:0,lockOnPause:true,lockOnDestroy:false}` 落盘确认；前置 `lockIdleMinutes:0`（settings.json）。双窗隐藏于 07:11:44（hideT=1790464304212）→ 页内 force-lock 事件监听捕获事件于 1790464365737（隐藏后 +61.5s，符合 60s 阈值 + 30s tick 粒度窗口）→ +49ms 后 DOM 出现 `form.unlock-form` 且持续锁定：200ms 采样 287 帧全 locked，末帧 1790464422989、nowLocked=true。锁后 `take_stashed_dek=null`（LockAndSuspend 清槽，`apps/desktop/src-tauri/src/lib.rs:253`）。
3. **③Destroy 档 ✓**：口令解锁后设 `{pauseMinutes:0,destroyMinutes:1,lockOnPause:false,lockOnDestroy:false}` 落盘；双窗保持可见 40s（track reset）后隐藏于 07:17:45（hideT3=1790464665042）；07:19:41 `manage-window --action list --json` → `{"windows":[],"totalCount":0}`，进程存活（tasklist PID 25352），msedgewebview2 子进程数 0（PowerShell Get-CimInstance 计数=0），桥侧 ipc-execute-command 报 "Window 'main' not found" 佐证 webview 全销毁。

环境恢复：releasePolicy 回滚 `{5,30,lockOnPause:false,lockOnDestroy:true}` ✓；DPAPI auto-unlock 经 Security 页 `button.enable-dpapi` 重新启用（security.json kekSources 恢复 2 源）✓；应用以 Test-Pw!234 解锁运行中（新 PID 15660，session connected:true）。

**人工项（按 ask 跳过）**：

- 托盘点击重建后 `take_stashed_dek` 回注免解锁未执行——托盘点击不可自动化，且回注仅存在于 desktopShell main boot（`apps/desktop/src/MiniApp.vue:52` 注释确认 mini 只读无回注路径）。
- 销毁前 1s stash 窗口的「DEK 已落槽」无法事后直读（页内监听器随 webview 销毁，销毁后无 webview 可 invoke）——同一 stash 监听器与处理链已在①实证工作，Rust 侧为 destroy_releasable_windows（`apps/desktop/src-tauri/src/lib.rs:314-320`）。
- destroy 失败回滚按用例口径由单测覆盖（apply_destroy_with_rollback），本机未重复跑该单测。

**测试方法发现（非产品缺陷，复测必读）**：

- (a) `apps/desktop/src/components/LockScreen.vue:49-64` 挂载即 DPAPI 静默自动解锁——手动 emit force-lock 实测锁定帧仅存续 1302ms→1415ms（约 113ms 即被解开），首轮②观测到假阴性。按活文档 §2.3「如需测锁定页，先在 Security 页移除该来源」经 `button.remove-dpapi` 移除后复测通过。
- (b) `apps/desktop/src-tauri/src/release_policy.rs` advance 状态机 paused_at 置位后仅在 tick 观测到任一窗口可见时 reset——1.2s 的短暂 show 不足以复位；复测保持可见 40s（>30s tick 周期）确保 reset。
- 计时口径：活文档 90s/95s 观测点含 30s tick 粒度，实际落点 force-lock +61.5s / 销毁确认 +116s，均在 60~90s 触发窗口之后的合理观测位。

### D2 剪贴板 stage/clear 真机 ⛔ 受阻（环境故障，非重构引入）

**前置已满足**：driver-session connected:true（沿用 D1 后的 PID 15660 实例），金库解锁（#/codes，`/Entries \(/` 命中），settings.json clipboardClearEnabled=true。

**执行受阻**：07:28:36 点击首条目复制按钮（`button.copy`，`packages/ui/src/components/OtpListItem.vue:110`）后 PowerShell `Get-Clipboard` 连续 5 次报 "Requested Clipboard operation did not succeed"；同时应用 DOM 出现失败横幅（role=alert）"Copy failed: clipboard busy or unwritable"（`apps/desktop/src/App.vue:124` v-if=copyFailed，desktopCopy.ts stage 失败分支）。

**诊断链**：python ctypes OpenClipboard 返回 0 且 GetLastError=5（ACCESS_DENIED）；`Set-Clipboard -Value 'probe123'`、`printf ... | clip`（"ERROR: Access is denied."）写路径同样失败——系统剪贴板被锁，写读均拒；GetOpenClipboardWindow 返回 Zero（占用者非普通窗口可枚举）；cbdhsvc_3ebb6c（Clipboard User Service）Running 但 Restart-Service 被拒（权限不足）。排除法：结束 snipaste、Listary、localsend_app、CmdPalCatFunExtension 四个可杀进程后剪贴板仍锁死；剩余高嫌疑 PowerToys.AdvancedPaste(PID 49080，社区已知剪贴板锁死者)、AutoGLM(37212)、eOppFrame(8196)、eServiceHost(15548)、eguiProxy(39996) 全部为提权进程（Stop-Process Access denied），非提权 shell 无法解除。正常路径「复制验证码 → Get-Clipboard 读回本体 → 30s+ 后为空」无法执行，主验证目标未达成，不编造通过。

**附带真机验证（环境意外触发，横幅半边通过）**：D2 用例「第三方独占剪贴板时复制失败横幅」分支的横幅半边观测成功——stage_clipboard_write（`apps/desktop/src-tauri/src/session_vaults.rs:44-52`，write_text 失败→Err）→ 前端 copyFailed 横幅出现且不武装 30s 清空（desktopCopy.ts catch 分支 return），横幅文案与 3s 复位逻辑存在。

**归因：非重构引入（refactorCaused=false，全部只读核查）**：

1. Rust 侧剪贴板写入路径逐字等价：失败点 stage_clipboard_write 在当前 `apps/desktop/src-tauri/src/session_vaults.rs:44-53`（`app.clipboard().write_text(value.clone()).map_err(...)`），与基线 `git show a385f1b1:apps/desktop/src-tauri/src/lib.rs:64-72` 的实现逐字一致——重构提交 5d9470c（R8「抽出 session_vaults.rs 收编剪贴板/DEK 暂存槽」）为纯移动，should_clear_clipboard/clear_clipboard_if_staged 同样逐字平移（当前 session_vaults.rs:20-42 = 基线 lib.rs:39-62）。
2. 底层剪贴板依赖未变：`apps/desktop/src-tauri/Cargo.toml:16` `tauri-plugin-clipboard-manager = "2"`，且 `git diff a385f1b1..HEAD -- Cargo.toml Cargo.lock` 无任何输出——clipboard 插件版本与能力面在重构前后完全一致。
3. 前端失败横幅分支基线已存在、本次改动与之无冲突：`git diff a385f1b1..HEAD -- apps/desktop/src/App.vue` 输出为空（零改动），App.vue:82-86 的 createDesktopCopy 接线与 App.vue:124 v-if="copyFailed" role=alert 横幅均为基线原状；desktopCopy.ts 的 catch 分支（`apps/desktop/src/desktopCopy.ts:52-57`，stage 失败→copyFailed=true+3s 复位+return 不武装清空）在基线已逐字存在（基线注释即写明「真机发现：剪贴板被第三方进程独占时 stage 命令拒绝，原实现静默无提示」——该横幅正是为真实剪贴板锁死场景设计的 fail-visible 行为）。R13 提交 2123de3 对 desktopCopy.ts 的 24 行改动仅新增「stage 成功撤横幅」（desktopCopy.ts:59）与 onStaged 扩展点（desktopCopy.ts:30-33,61），且 commit message 明示其目的是修复 mini 端横幅永不复位的既有漂移，只触及 MiniApp.vue+desktopCopy.ts 两文件，是修复而非引入。
4. 其余链路文件零改动：`packages/ui/src/components/OtpListItem.vue`（复制按钮 button.copy 所在）在 a385f1b1..HEAD 零 diff；`packages/ui/src/clipboardClearer.ts`（30s 清空 clearer）零 diff；`packages/ui/src/index.ts` 的 6 行新增仅为 normalizeAutoPrefs/formatAutoStatusText/sortEntries 导出，与剪贴板无关。
5. 根因在宿主环境而非应用代码：PowerShell Get-Clipboard/Set-Clipboard 与 clip.exe 等非本应用系统工具同样报 Access denied，python ctypes OpenClipboard 返回 0/GetLastError=5，GetOpenClipboardWindow 返回零、嫌疑进程为提权第三方（PowerToys.AdvancedPaste 等）——若失败由重构引入，无法解释系统级写路径同样被拒；应用按设计正确进入 stage 失败分支并显示横幅，恰证明重构后错误传播链（session_vaults.rs:46-48 Err → 前端 catch）工作正常。
6. 单测验证（本次实际运行）：在 apps/desktop 下执行 `npx vitest run src/desktopCopy.test.ts`，结果 5/5 通过（"Test Files 1 passed, Tests 5 passed"），确认 HEAD 代码中失败横幅 3s 复位与不武装清空行为符合设计。

**人工项（按 ask 跳过）**：第三方独占剪贴板的受控注入未执行（环境已自发处于独占状态，横幅分支被意外真机触发——但仅横幅半边；clear 的 fail-safe 清空半边因无 staged 内容无法触发，该分支由 `should_clear_clipboard` 单测覆盖，本机未重跑单测）。

**处置建议**：提权结束 PowerToys.AdvancedPaste（首要嫌疑）或重启 Clipboard User Service/系统后重跑本用例（整用例重跑，含「复制→读回→30s 清空」主路径）。

**环境副作用披露**：诊断过程中结束了 snipaste、Listary、localsend_app、CmdPalCatFunExtension 四个用户进程（均普通权限、可自启/手动重开）；应用侧无状态残留（未改 settings，横幅 3s 自动复位），vault 仍解锁，driver-session 正常。

### D3 锁屏广播 ➖ 未执行

锁屏触发=人工（Win+L/LockWorkStation 锁整个交互会话，自动化勿触发，活文档 §2.4），本批未执行，沿用前批（2026-09-26 覆盖率批次）人工项登记。

### D4 MCP 首连审批三键 + 工具确认两键 + 冷却 + trust 持久化 ✅

**前置**：debug 构建 GUI 实例（PID 45456，重启后），driver-session connected:true，金库解锁（#/codes），MCP 服务器 127.0.0.1:48215 LISTENING 属应用进程（netstat），curl JSON-RPC 通道就绪（initialize 返回 SSE，serverInfo totp-desktop 0.1.0，响应头 mcp-session-id）。

1. **①Deny+冷却 ✓**：新 ident=e2e-probe-a initialize（session a02505f2…）→ tools/call list_accounts 立即回 `{"code":-32602,"message":"approval pending: the user must approve this client in the TOTP app"}`（fail-closed，`apps/desktop/src-tauri/src/mcp_server.rs:629-644`）且 GUI 弹 McpConsentDialog（headline "MCP client requesting access"，Client=e2e-probe-a / Requested tool=list_accounts，三键 Deny/Allow once/Add to whitelist）→ 点 Deny 后 51s 内重发 tools/call 得 `{"code":-32602,"message":"approval denied; try again in about a minute to trigger a new approval dialog"}`（07:44:38，DENY_COOLDOWN=60s，`mcp_server.rs:477/593`）。
2. **②Allow once ✓**：62s 后重发 → pending 错误 + 重弹（ident=e2e-probe-a）→ 点 Allow once → tools/call 成功返回 list_accounts 账户列表（GitLab/Example/HOTPTest/GitHub/Steam…）；once 窗口内再调 get_code 直接返回 `{"code":"000631","expires_in_seconds":8,"period":30}`，dialogOpen=false——免弹窗符合活文档 §2.4 once=15min 会话授权（ONCE_TTL，`mcp_server.rs:476`）。
3. **③trust 持久化 ✓**：新 ident=e2e-probe-b（session 8d02b5d5…）tools/call → 弹框 → 点 Add to whitelist → settings.json mcp.whitelist 变为 `["mcp-e2e","curl-probe-2","e2e-probe-b"]` 且立即重发 tools/call 成功；taskkill 15660 重启应用（新 PID 45456，DPAPI 自动解锁）后同 ident 重新 initialize+tools/call 直接成功返回账户列表，dialogOpen=false（07:48:22）——白名单跨重启免弹窗。
4. **④工具确认两键 ✓**：先热改 settings.json 加 mcp.exposedTools=[list_accounts,get_code,trigger_backup]（§2.4 每请求重读即时生效）；已授权 ident 的 session（6e8ba011…）tools/call trigger_backup → curl 挂起，GUI 弹 headline "Allow trigger_backup?" 两键 [Deny,Allow]（tool_confirm 60s 窗口，`mcp_server.rs:362/375`）→ 点 Deny → 挂起请求返回 `{"message":"tool call denied by user in the TOTP app"}`；再次 tools/call → 重弹 → 点 Allow → 返回 `{"jsonrpc":"2.0","id":9,"result":{"content":[{"type":"text","text":"{\"triggered\":true}"}],"isError":false}}`（07:49:26）。

收尾：exposedTools 键已从 settings.json 移除（恢复 serde default 行为）。

**说明与边界**：(1) ①② 中 get_code 首次误用参数名 id 报参数反序列化错误——错误发生在门控之后的参数层（无弹窗），恰佐证 once 放行，随后以正确参数 account_id 取得真码。(2) trigger_backup 触发后 backups 目录无新文件（最新仍为 vault-20260926-200334.totpbackup）——符合「内容未变静默跳过」语义（D5② 同源），不影响④以 `{"triggered":true}` 为判据的结论。(3) 用例预期末句「无人值守（headless）fail-closed」为设计裁定引用（mcp_server.rs tool_confirm 注释：无头确认无人响应 → 60s 超时拒绝），当前为 GUI 模式，headless 分支本机未单独验证（属单测/代码裁定口径，非本用例步骤）。

**人工项**：无（D4 无锁屏/托盘类人工子步）。**副作用**：应用重启一次（③ trust 持久化验证要求，重启后经 DPAPI 自动解锁）；settings.json 曾临时加 exposedTools 三值、验后已删除恢复原状；白名单新增的 e2e-probe-b 按用例③语义保留（trust 持久化的产物，与用例预期一致，如需可人工移除）。执行期间未锁屏。

### D5 自动备份落盘与 lastBackupHash 语义 ✅

**前置**：金库解锁（#/codes，driver-session connected:true）；Back up on change 已开启（localStorage backupAutoPrefs=`{"onChange":true,"onInterval":false,"intervalMinutes":60}`）；本地源启用（backupSources.json local-default enabled=true, keep n=3）；会话备份口令由保管区自动恢复（①备份成功执行即证）。基线快照：backups 目录仅 vault-20260926-200334.totpbackup(3648B)，lastBackupHash=11a5d01c…，backupAutoStatus at=1790424214224。

1. **①改库→防抖落盘 ✓**：07:54:27 点首条目（GitLab）Edit → 表单备注空 → 输入 "e2e-d5-mark-1" → 经 `form.entry-form button[type=submit]` 提交（`packages/ui/src/components/EntryForm.vue:418`，活文档 §2.4 坑规避）→ 07:54:34 新文件 vault-20260927-075434.totpbackup(3736B) 落盘；lastBackupHash 推进 11a5d01c…→87280e6d2d…；backupAutoStatus 更新 at=1790466874461、ok:true、「已备份到 1 个目录（本地备份）」（10s 防抖 DEFAULT_DEBOUNCE_MS=10_000，`apps/desktop/src/autoBackup.ts:49`）。
2. **②内容未变 trigger_backup 静默跳过 ✓**：热改 settings.json 临时加 exposedTools 含 trigger_backup（§2.4 每请求重读）→ ident=e2e-probe-b（白名单内）tools/call trigger_backup → 弹「Allow trigger_backup?」→ 点 Allow → 返回 `{"triggered":true}`（runBackupNow 绕偏好门，`apps/desktop/src/autoBackup.ts:41-46`）；backups 目录无新文件、lastBackupHash 仍 87280e6d2d…、backupAutoStatus at 仍 1790466874461——unchanged 静默不记（decideAutoRun 守护照常，`autoBackup.ts:100-108`）。
3. **③删文件→改库→重写 ✓**：rm vault-20260927-075434.totpbackup → 同条目备注改 "e2e-d5-mark-2"（清空重输，提交 07:56:54）→ 07:57:01 新文件 vault-20260927-075701.totpbackup(3736B) 重写；基线推进 87280e6d2d…→6ccb2f9757…，status ok:true at=1790467021274。

收尾：备注还原为原空值（触发 vault-20260927-075803.totpbackup 落盘、基线→04642859…，change 链路补证）；exposedTools 键已移除恢复默认。

**人工项（按 ask 跳过）**：「落盘文件可被恢复通道还原」未验证——需本地文件选择器交互，用例本身标注人工可选；envelope 往返有单测覆盖（用例口径）。

**说明**：(1) ② 的 trigger_backup 经 MCP 通道执行（与用例字面一致），工具确认弹窗复用 D4④ 已验证的两键链路（Allow）；(2) 备份口令会话语义：D4 重启后未手动设口令而①直接成功，证明会话口令经保管区（secretBag）自动恢复，无「未设置备份口令」null 态出现；(3) 副作用与还原：GitLab 条目备注已还原为原空值（该次改库按设计正常产生第三个备份文件，keep n=3 下目录现为 3 文件=retention 上限，属预期）；settings.json exposedTools 临时键已删；lastBackupHash/backupAutoStatus 为测试过程自然推进的基线，无异常。执行期间未锁屏。

### D6 DPAPI 真机 roundtrip ✅（自动化部分）

**前置**：金库解锁（#/codes，driver-session connected:true）、加密已启用（security.json enabled=True，kekSources 含 password+dpapi）。步骤完整走 Enable 动作（因 D1 收尾时已绑定，先 Remove 再 Enable 以真实验证「卡片出现 Remove」）：

1. ① #/security 点 `button.remove-dpapi` → security.json kekSources `['password','dpapi']`→`['password']` 落盘、按钮切 Enable。
2. ② 点 `button.enable-dpapi`（07:59:43）→ 卡片出现 Remove（hasRemove:true, hasEnable:false）、security.json kekSources 恢复 `['password','dpapi']`，dpapi 源含 wrappedDekD（base64 合法，解码 270B = DEK_WRAP_MARKER + CryptProtectData v2 密文）。
3. ③ taskkill 45456 重启应用（新 PID 14832）→ 08:00:24 观测：route=#/codes、lockedForm=false（无 form.unlock-form 锁定页）、unlockedCodes=true（Entries (9) 可见）——重启直达解锁态，DPAPI 当前用户态解包 DEK 成功；应用 MCP 48215 正常自起。driver-session 重启后 connected:true。

机制佐证（源码）：Windows 通道为 os_auto_protect/unprotect → dek_protect_inner/dek_unprotect_inner（`apps/desktop/src-tauri/src/platform_security.rs:282-294`）→ dpapi_protect_bytes/dpapi_unprotect_bytes（CryptProtectData/CryptUnprotectData，应用附加熵 DEK_WRAP_ENTROPY 绑定 + v2 前缀 + 32B 旧格式兼容，`platform_security.rs:246-266`）；密文以 wrappedDekD 明文落盘 security.json（`platform_security.rs:297` 注释）；前端解锁链为 desktopShell boot → `LockScreen.vue:49-64` 挂载静默 os_auto_unprotect → store.unlockWithDek。

**人工项（按 ask 跳过）**：跨用户/跨会话解不开 fail-closed【人工：另一用户登录验证】未执行——需另一 Windows 用户会话登录，单会话环境不可达；代码层对应保障为 CryptUnprotectData 的当前用户态绑定（其他用户/会话解密恒失败）+ dek_unprotect_inner 的应用熵与 32B 校验（`platform_security.rs:255-267`，非本应用密文恒解密失败）。

**说明**：(1) 用例步骤因 DPAPI 已在绑定态，先 Remove 再 Enable 完整覆盖「Enable（卡片出现 Remove）」动作，两向落盘均已验证；(2) 补充排查记录：Windows 通道不使用 Windows Credential Manager（keyring 仅 mac/linux 编译门控，`platform_security.rs:299-301` 注释），故 CredEnumerate('totp*') 无匹配属预期，非异常；(3) 环境副作用：应用重启一次（用例要求），无其他状态残留。执行期间未锁屏。

### D7 devtools/MCP 端口冲突拦截 ✅

1. **①配置期拦截 ✓**：经 driver-session 在运行中实例 invoke `devtools_set_config {enabled:false, port:48215}`（=运行中 MCP 端口）→ 返回 Err「端口 48215 已被 MCP 服务器占用（两者同绑 127.0.0.1），请为 WebView 调试另选端口」（`apps/desktop/src-tauri/src/lib.rs:160-169` ensure_devtools_port_free 文案精确命中）；settings.json 未被写入（Err 路径不落盘）。
2. **②合法端口 ✓**：`devtools_set_config {enabled:false, port:9225}` → 返回 OK，settings.json devtools=`{'enabled':False,'port':9225}` 落盘（write_section 合并写）。
3. **③启动期拦截 ✓**：先 taskkill GUI 主实例（避免 §2.4 单实例语义下第二实例 exit 0 截获），python 以 `s.bind(('127.0.0.1',48317))` 精确绑定（§2.4 坑规避；netstat 确认 127.0.0.1:48317 LISTENING PID 45496），启动 `./totp-desktop.exe --headless-mcp --mcp-port 48317`：**exit code=2**；stderr 含 `[mcp] autostart failed: bind 127.0.0.1:48317 failed: Only one usage of each socket address (protocol/network address/port) is normally permitted. (os error 10048)` 与 `[mcp] headless 启动失败: bind 127.0.0.1:48317 failed: … (os error 10048)`（`mcp_server.rs:1203` bind Err 文案 + `lib.rs:403` eprintln+exit(2)，用例期望的 bind failed 与 os error 10048 双命中）。

收尾：占位进程已停止（48317 无监听）、devtools.port 已恢复 9222、GUI 重启（PID 7596）经 DPAPI 自动解锁（#/codes 解锁态）、driver-session 正常。

**说明**：(1) ③ 必须先停 GUI 主实例——§2.4 单实例语义下第二实例（GUI/headless）会被 tauri-plugin-single-instance 干净 exit 0 走不到 bind，停主实例后 headless 实例即唯一实例，完整走到 start_server_with 的 bind 失败路径；测后已重启 GUI 恢复环境。(2) stderr 可捕获依赖 `lib.rs:514-518` attach_parent_console（带参启动时接管父控制台），bash 重定向实测有效。(3) stderr 末尾的 Chromium window_impl.cc ERROR 为 WebView2 退出噪声，与判定无关。(4) 第一次尝试因 bash `&` 误将整条链放后台导致 cwd 错乱（exit 127），已分步重试，占位进程当时已自行退出、无残留。

**人工项**：无（D7 无托盘/锁屏类人工子步）。**副作用**：应用重启一次（DPAPI 自动解锁）；settings.json devtools.port 曾临时改 9225、验后已恢复 9222。执行期间未锁屏。

## 四、人工项清单（汇总）

| 用例 | 人工项 | 状态 |
|---|---|---|
| D1 | 托盘点击重建后 `take_stashed_dek` 回注免解锁 | 未执行（托盘点击不可自动化；回注仅存在于 desktopShell main boot，MiniApp 无回注路径） |
| D1 | destroy 失败回滚 | 按用例口径由单测覆盖（apply_destroy_with_rollback），本机未重跑 |
| D2 | 第三方独占剪贴板受控注入 | 未执行（环境自发独占，横幅半边意外真机触发；clear fail-safe 半边由 `should_clear_clipboard` 单测覆盖，本机未重跑）。**整用例待环境修复后重跑** |
| D3 | 锁屏广播（Win+L） | 未执行（沿用前批人工登记） |
| D5 | 落盘文件经「恢复」通道还原 | 未执行（需本地文件选择器，用例标注人工可选；envelope 往返有单测） |
| D6 | 跨用户/跨会话解不开 fail-closed | 未执行（需另一 Windows 用户会话登录） |
| D4 / D7 | 无人工项 | — |

## 五、发现与处置

1. **[环境故障·非产品缺陷] D2 受阻：宿主机剪贴板被提权第三方进程锁死**。OpenClipboard ERROR_ACCESS_DENIED(5)、无持有窗口可枚举、系统级写路径（Set-Clipboard/clip.exe）同样被拒、高嫌疑进程（PowerToys.AdvancedPaste 等）均为提权进程，非提权 shell 无法解除。经六项只读核查（见「三、D2」归因节：Rust 写入路径逐字等价、Cargo 依赖未变、前端横幅分支基线已存在、链路文件零 diff、系统工具同样被拒、desktopCopy 单测 5/5 实跑通过）归因为**非重构引入（refactorCaused=false）**。不登记 backlog（非产品缺陷）；重跑条件：提权结束 PowerToys.AdvancedPaste（首要嫌疑）或重启 Clipboard User Service/系统。
2. **[测试方法发现] D1 首轮假阴性两根因**（复测必读，建议后续增补活文档 §2.4 坑表，本次仅在此留档）：(a) LockScreen 挂载即 DPAPI 静默自动解锁，force-lock 锁定帧仅存续约 113ms——测锁定页必须先在 Security 页移除 DPAPI 来源（§2.3 已有口径）；(b) release_policy paused_at 置位后仅在 tick 观测到任一窗口可见时 reset——隐藏前需保持窗口可见 40s（>30s tick 周期）确保状态机复位。
3. **[计时口径] 释放策略观测点含 30s tick 粒度**：文档 90s/95s 观测点的实际落点为 force-lock +61.5s / 销毁确认 +116s，均在 60~90s 触发窗口之后的合理观测位，非异常。
4. **[环境副作用汇总]**：应用进程更替 5 代（25352→15660→45456→14832→7596），终态 PID 7596 运行中、DPAPI 自动解锁、driver-session connected:true；诊断 D2 时结束 4 个用户进程（snipaste、Listary、localsend_app、CmdPalCatFunExtension，均普通权限可自启/手动重开）。
5. **测试遗留痕迹**（沿用前批惯例留档）：`mcp.whitelist` 含 e2e-probe-b（D4③ trust 持久化用例语义产物，如需可人工移除）；backups 目录 3 文件=keep n=3 retention 上限（vault-20260926-200334 / 20260927-075701 / 20260927-075803，预期）；GitLab 条目备注已还原原空值；settings.json 临时键均验后恢复（exposedTools 已删、devtools.port=9222）；releasePolicy 恢复默认 {5,30,lockOnPause:false,lockOnDestroy:true}；DPAPI 保持启用（kekSources 2 源）；vault 9 条目。
