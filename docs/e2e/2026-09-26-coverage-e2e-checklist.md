# 覆盖率 E2E 真机兜底清单（2026-09-26）

> **本文件为 2026-09-26 批次的执行记录归档**（`docs/e2e/` 按日期归档）。用例目录、范围口径与扩充指南见活文档 **`docs/e2e-test.md`**；后续每次执行的记录新建 `docs/e2e/YYYY-MM-DD-<主题>.md` 并在活文档 §4 索引表登记。

状态：**桌面 7 条已于 2026-09-26 执行完毕（6 条自动化通过、1 条人工项登记；详见「三、执行记录」）**。
扩展 6 条保持 **[手测]** 待人工。本清单承接
`docs/plans/2026-09-25-coverage-design.md` §4（L3 集成胶水层不折算百分比，以真机场景清单管理），
执行记录沿用 `docs/review/2026-09-23-batch8-real-machine-test.md` 的惯例
（逐项「方法/结果」留档，发现缺陷当批修复并回写）。

- 桌面 7 条：可经 tauri-mcp 驱动（driver-session + headless MCP，基建现成），
  标注 **[可自动化]**；托盘点击/系统锁屏等少数子步骤需人工配合，在条目内注明。
- 扩展 6 条：Chrome + Firefox 双浏览器 **[手测]**。
- 每条含：前置条件 / 操作步骤 / 预期行为 / 对应源码位置。
- 截图与原始日志存 `.temp/e2e/` 与 `E:\tmp\cc\totp-e2e\`（不入库）。

## 一、desktop（tauri-mcp 驱动）

### D1 释放策略三档联动 [可自动化]

- 前置：debug 构建（`target/debug/totp-desktop.exe --headless-mcp` 或 `tauri dev`），
  driver-session 已连接；设置页可写 `releasePolicy`。
- 操作：分三档写 settings.json 后等待 tick（测试用分钟值可写小数加速?——不可，u32 分钟，
  用 0/1 边界 + 隐藏窗口挂起语义推演）：
  1. Pause 档（`{pause:1,destroy:0,lockOnPause:true}`）：隐藏到托盘 → 到点 TrySuspend。
  2. Destroy 档不锁库（`{pause:0,destroy:1,lockOnDestroy:false}`）：隐藏挂起 → 到点销毁 webview，
     观察前端收到 `stash-dek-request` 后 Rust 槽持有 DEK；托盘点击重建（人工）→ 免解锁恢复。
  3. Destroy 失败回滚：销毁档触发后立即观察进程/托盘存活与重试（复测批⑧ Task 13 已验证进程存活，
     本条聚焦「destroy 调用抛错 → 状态机回滚重试」分支）。
- 预期：Pause 档锁库 + 清 DEK 槽（`clear_stashed_dek`）；Destroy 档 stash-dek-request →
  重建后 `take_stashed_dek` 回注免解锁；销毁失败不丢 DEK、下轮重试。
- 源码：`apps/desktop/src-tauri/src/release_policy.rs`（状态机 advance/合并）；
  `apps/desktop/src-tauri/src/lib.rs:390`（release_tick 副作用接线）、`lib.rs:108`（take_stashed_dek）；
  前端 `apps/desktop/src/desktopShell.ts:224-286`（force-lock / stash-dek-request / 回注）。

### D2 剪贴板 stage/clear 真机（含第三方占用） [可自动化]

- 前置：debug 构建；剪贴板可写。
- 操作：① 复制某验证码（真机写入剪贴板）；② 用第三方工具打开剪贴板并锁定/占用句柄
  （如 CLCL/ClipBurst 类占用工具，或打开 Office 剪贴板窗格）；③ 触发 stage→30s 后 clear 链路。
- 预期：正常路径 30s 后剪贴板清空；占用导致 clear 失败时 UI 出失败横幅（fail-safe 清空语义），
  不静默成功。
- 源码：`apps/desktop/src-tauri/src/lib.rs`（`clipboard_stage` 命令四分支，P5 已参数化单测）；
  前端复制链路 `packages/ui/src/components/OtpListItem.vue`（复制入口）与 desktop 平台适配。

### D3 锁屏广播（Win+L）→ system-lock → 锁库 [可自动化·锁屏触发需人工]

- 前置：应用运行，`settings.lockOnSystemLock` 开启；lock_events 消息泵已订阅 WTS 通知。
- 操作：人工按 Win+L 锁屏（或 `rundll32.exe user32.dll,LockWorkStation`）→ 解锁回观。
- 预期：收到 `WM_WTSSESSION_CHANGE`（WTS_SESSION_LOCK）→ 发 `system-lock` 事件 → 前端锁库；
  关闭设置后锁屏不锁库。
- 源码：`apps/desktop/src-tauri/src/lock_events.rs`（extern "system" wndproc + 消息泵，豁免区）；
  `apps/desktop/src-tauri/src/lib.rs:1471`（事件转发注释）；前端 `desktopShell.ts` force-lock 处理。

### D4 MCP 首连审批 UI 三键 + 工具确认两键 + deny 冷却 + trust 持久化 [可自动化]

- 前置：debug 构建（非 headless，审批弹窗需 UI）；MCP 客户端（curl JSON-RPC）就绪。
- 操作：
  1. 首连（无 token 档或首客户端）→ 弹「允许连接?」→ 分别测 deny / once / trust 三键。
  2. deny 后 60s 内同 ident 再连 → 预期直接拒（冷却）；60s 后再连 → 重新弹审批。
  3. trust 后重连 → 免弹窗；重启应用再连 → 仍免弹窗（持久化）。
  4. 非 token 档勾选某 action 工具 → MCP 调用 → 弹「允许执行 X?」Allow/Deny 两键。
- 预期：三键/两键行为与 §2 设计一致；冷却/持久化语义如上；headless 下无人值守 fail-closed
  （批⑧表一第 7 项已验）。
- 源码：`apps/desktop/src-tauri/src/mcp_server.rs`（`GateOutcome` 决策链、`cooldown` 表 :451、
  trust 持久化、`mcp_respond` :1621 注册）；前端 `apps/desktop/src/McpConsentDialog.vue` + `App.vue` 审批队列。

### D5 自动备份真机落盘与 lastBackupHash 语义 [可自动化]

- 前置：debug 构建；设置自动备份目录（真机盘符路径）；vault 有数据。
- 操作：改 vault 触发自动备份轮 → 检查落盘文件；再触发一轮内容无变化 → 预期跳过；
  手改/删落盘文件（hash 失配）→ 下轮预期重写。
- 预期：文件落盘内容可被「导入」通道还原；lastBackupHash 命中跳过、失配重写。
- 源码：`apps/desktop/src/autoBackup.ts`；`apps/desktop/src/backupPlatform.ts`；
  `apps/desktop/src/desktopPrefs.ts`（lastBackupHash 读写）；
  Rust 侧 `read_import_file_*`/写盘命令（P5 已抽 `*_granted` inner 单测）。

### D6 DPAPI 真机 roundtrip（跨会话解锁） [可自动化·跨会话需人工重登]

- 前置：debug 构建；加密已启用。
- 操作：① 开启 os_auto_protect → 重启应用 → 免口令解锁（DPAPI 当前用户态）；② 导出/再导入
  os_protect 数据 roundtrip；③ 换会话（人工：注销其他用户/受保护用户登录）→ 预期解不开（fail-closed）。
- 预期：同用户 roundtrip 无损；跨用户/跨会话拒绝；unprotect 通道与 auto 通道一致。
- 源码：`apps/desktop/src-tauri/src/lib.rs:1301-1357`（os_auto_protect 三 cfg 分支）与相邻
  os_unprotect；前端解锁链 `desktopShell.ts`。

### D7 devtools 端口与 MCP 端口冲突拦截 [可自动化]

- 前置：debug 构建；CLI 可传 `--headless-mcp --mcp-port`。
- 操作：① 用一个进程先占用某端口（如 `python -m http.server 48300`）；② 启动应用让 devtools
  注入与 MCP 同绑该端口 → 预期启动报错/如实回传 UI（bind 失败不静默）；
  ③ 换互不冲突端口 → 正常监听。
- 预期：冲突时 UI 得到明确错误（审查 I-1 语义：bind 失败直接回传）；无冲突时连接行仅真实
  监听成功后输出（批⑧表一第 3 项已验）。
- 源码：`apps/desktop/src-tauri/src/lib.rs:205-249`（devtools env 注入判定/`devtools_get_config`）；
  `apps/desktop/src-tauri/src/mcp_server.rs:1190` 附近（start_server_inner 空 token fail-closed、
  bind 失败 Err 回传）、`:851`（listener 由调用方同步 bind 注释）。

## 二、extension（Chrome + Firefox 双浏览器手测）

### E1 SW 休眠唤醒后右键菜单仍在（C11） [手测]

- 前置：扩展已加载（Chrome MV3 / Firefox 140）；右键菜单已注册。
- 操作：触发 SW 休眠（chrome://serviceworker-internals 手动 Stop，或等 30s 空闲）→ 唤醒
  （点开 popup 或发消息）→ 右键页面与右键图片看菜单项。
- 预期：菜单项仍在且可点（注册幂等，不重复叠加）。
- 源码：`apps/extension/entrypoints/background.ts:69-83`（contextMenus.create ×2 + onClicked）。

### E2 右键图片 QR 识别 → pendingOtpauth → popup 保存全链 [手测]

- 前置：准备含 otpauth QR 的图片（本地文件或网页内）。
- 操作：右键该图片 → 「识别 QR」→ 打开 popup。
- 预期：popup 预填解析出的条目（issuer/label/secret 正确）→ 保存入库；坏图/非 QR 图预期
  提示不可识别不误存。
- 源码：`apps/extension/entrypoints/background.ts:79`（onClicked → qrDecode → pendingOtpauth）；
  `apps/extension/entrypoints/popup/App.vue:224`（后台导入入口消费即清除）；
  `apps/extension/src/qrDecode.ts`。

### E3 30s 清剪贴板承诺（offscreen 重试链路） [手测]

- 前置：Chrome（offscreen 权限在）。
- 操作：复制任一验证码 → 关闭 popup → 手动复制其他内容干扰 → 等 30s → 查看剪贴板。
- 预期：30s 后剪贴板被清空；SW 冷启动场景（复制后立即 devtools 手动 Stop SW 再唤醒）仍能清空
  （重试 + ensureOffscreen 竞态防护）。
- 源码：`apps/extension/entrypoints/background.ts:40-45`（clearClipboardWithRetry 3 次重试 + 1s 超时）；
  `apps/extension/entrypoints/offscreen/offscreen.ts`（clear-clipboard 回执 + ack）。

### E4 Firefox `ext+otpauth://` 协议回调 → popup 预填 [手测]

- 前置：Firefox 140+，扩展已安装（gecko id `totp@bhxch.github.io`）。
- 操作：系统级唤起 `ext+otpauth://otpauth-migration://...`（可从测试页 link 或命令行触发）。
- 预期：Firefox 弹协议处理询问 → 选本扩展 → popup 打开并预填 URI 内容 → 保存入库。
- 源码：`apps/extension/wxt.config.ts:31-32`（protocol_handlers，firefox 分支）；
  `apps/extension/entrypoints/popup/App.vue:224`（`?uri=` 消费）。

### E5 Firefox 无 offscreen 降级（清剪贴板不调度，行为可预期） [手测]

- 前置：Firefox（无 offscreen API）。
- 操作：复制验证码 → 等 30s → 查看剪贴板；同时看扩展 console 无 unhandled rejection 刷屏。
- 预期：清剪贴板链路整体不调度（createDocument 缺 API 走放弃分支），行为可预期、无报错噪声。
- 源码：`apps/extension/entrypoints/background.ts:21-31`（ensureOffscreenDocument 捕获即放弃）；
  对照 `wxt.config.ts` 双渠道 manifest 差异断言（chrome 有 offscreen 权限、firefox 无）。

### E6 大库接近 chrome.storage.sync 配额时 quota 状态展示 [手测]

- 前置：Chrome；构造接近 `QUOTA_BYTES` 的同步负载（大量条目 + 多设备分片）。
- 操作：观察 popup/options 同步卡状态区；再增一条触发越界写。
- 预期：用量 >90% 时状态切 `quota` 展示（而非静默 error）；真实越界写失败走 error 分支可恢复。
- 源码：`apps/extension/src/syncEngine.ts:165`（`QUOTA_BYTES * 0.9` 判定）、`:38`（状态机含 quota）；
  options 同步卡状态行。

## 执行留档惯例

执行后在本文件追加「三、执行记录」节：逐项「方法/结果/截图（assets/）」，发现缺陷当批修复并
在「四、发现与处置」登记（对齐 batch8 文档结构）。

## 三、执行记录（2026-09-26，debug 构建 target/debug/totp-desktop.exe，bridge 0.13.0 @ 9223）

环境：Windows 10.0.26200 x64；测试金库 `%APPDATA%\com.totp.desktop`（口令 Test-Pw!234，
解锁后 9 条目）；MCP wildcard 48215 + settings 内 token + 白名单 ['mcp-e2e']。
驱动方式：tauri-mcp driver-session（webview JS `__TAURI__.invoke` 直驱命令，绕开
ipc-execute-command 带参不兼容坑）+ curl JSON-RPC（Streamable HTTP，`POST /mcp`）。

| # | 项 | 方法 | 结果 |
| --- | --- | --- | --- |
| D1 | 释放策略三档 | ①DEK 暂存回环：`ipc-emit-event stash-dek-request` → 前端自动 `stash_dek` → JS `take_stashed_dek` 返回 44 字符 base64（=32B DEK）→ 二次 take 返回 null（取即清）✅ ②Pause 档（1/0/lockOnPause=true）：`release_policy_set` → JS 隐藏双窗 → 90s 后库自动锁定（唯一锁定源=force-lock；空闲锁定为 0 关闭）✅ ③Destroy 档（0/1/lockOnDestroy=false）：隐藏 95s 后 **webview 全销毁（totalCount:0）+ 进程存活**（与批⑧ Task13 一致）✅ | **通过**（托盘重建回注与 destroy 失败回滚为人工子项/P5 单测覆盖；TrySuspend 挂起为 WebView2 内部行为本机 JS 仍可执行，未单独观测） |
| D2 | 剪贴板 stage/clear | 复制验证码 → PowerShell Get-Clipboard 读回 `370477` ✅ → 等 30s+ → 剪贴板为空 ✅ | **通过**（第三方占用分支的 fail-safe 语义由 P5 `should_clear_clipboard` 单测覆盖，占用工具构造留人工可选） |
| D3 | 锁屏广播 | 未执行：Win+L/LockWorkStation 锁的是整个交互会话，自动化触发会把使用者锁在会话外 | **登记人工项**（lock_events 消息泵为豁免区；接线语义有 system-lock→lock 的前端单测兜底） |
| D4 | MCP 审批全链 | curl JSON-RPC initialize→initialized→tools/call：①curl-probe 首连弹审批框（Client/Requested tool 文案正确）✅ ②Deny→60s 内重连 `approval denied; try again in about a minute` ✅ ③60s 过期后重新弹窗 ✅ ④Allow once→list_accounts 返回 9 条目 ✅（once=15min 会话授权，窗口内重连免弹窗为设计语义）⑤新 ident curl-probe-2→Add to whitelist→立即放行+白名单落盘 ✅ ⑥重启后 curl-probe-2 直连成功无弹窗（持久化）✅ ⑦工具确认两键（trigger_backup，exposedTools 临时加入）：弹「Allow trigger_backup?」Deny/Allow；Deny→`tool confirmation timed out or failed` fail-closed ✅；干净单发 Allow→`{"triggered":true}` ✅ | **通过**（连续请求下队列异常→见四-2 缺陷候选） |
| D5 | 自动备份语义 | 设会话备份口令（remember→secretBag.json 落盘）→ 开 Back up on change → 编辑条目提交 → 10s 防抖后 `vault-20260926-194859.totpbackup` 落盘 + lastBackupHash 基线 + 状态「已备份到 1 个目录」✅ → 内容未变 trigger_backup（runBackupNow 绕偏好、守护照常）→ 静默跳过（无新文件、基线/状态不动）✅ → 删除备份文件→再改库→`vault-20260926-200334.totpbackup` 重写 ✅ | **通过**（落盘文件经「导入」通道还原需本地文件选择器，envelope 往返已有单测，留人工可选） |
| D6 | DPAPI 跨会话 | Security→Enable Windows auto-unlock（os_auto_protect）→ 卡片出现「Windows auto-unlock（DPAPI）/Remove」✅ → 重启应用 → **直达 Codes 页无锁定页**（DPAPI 免口令解锁）✅ | **通过**（跨用户会话拒绝为人工项，DPAPI 用户态绑定由 OS 保证） |
| D7 | 端口冲突 | ①devtools_set_config 端口=MCP 端口 48215 → `ERR:端口 48215 已被 MCP 服务器占用（两者同绑 127.0.0.1）` ✅ ②合法端口 disabled=true → OK ✅ ③headless 实例 vs 127.0.0.1:48215 被占 → `autostart failed: bind ... (os error 10048)` + exit=2 ✅ | **通过**（注记：python http.server 绑 0.0.0.0 不阻塞 127.0.0.1 具体绑定——Windows 通配/具体多层绑定语义，复测本条需用 127.0.0.1 精确占用，见四-3） |

**扩展 E1-E6**：保持手测（SW 停启、协议处理器、Firefox 双渠道、storage 配额构造均为浏览器人工域，
本会话未自动化），步骤与预期已在上文列全，可独立执行。

**测试遗留痕迹**（沿用批⑧惯例保留）：vault 含 E2ED5 测试条目；`mcp.whitelist` 含 curl-probe-2；
`backups/` 保留一份 20260926 备份；`releasePolicy` 已恢复默认 {5,30,false,true}；exposedTools 已复位只读档。

## 四、发现与处置

1. **[平台行为·注记] 双实例启动 panic**：主实例运行时再启动第二实例（含 headless 探针），
   因全局快捷键 ALT+SHIFT+T 已注册，tauri_plugin_global_shortcut 初始化 panic（exit 101，
   "HotKey already registered"），非优雅的"已在运行"提示。建议 backlog（低）：单实例检测或
   快捷键注册失败的降级处理。注：batch8 的 headless 用例均在无主实例时执行，未暴露此路径。
2. **[已修复+真机复验 ✅ 2026-09-26] MCP 工具确认在连续请求下异常**：Deny 第一个工具确认后立即发起第二个
   trigger_backup，第二个请求未等用户操作即返回 `tool confirmation timed out or failed`
   （预期应挂起等待审批）；且积压的旧确认框首次 Allow/Deny 点击不生效（响应迟到被静默忽略），
   需二次点击才前进。单发路径（请求→弹窗→Allow）完全正常。建议代码级 triage：
   mcpApprovalQueue 队列 churn 与 Rust pending 回收时序（复现序列：连续两次 tools/call
   trigger_backup，间隔 <2s，第一次点 Deny 后立刻观察第二次响应）。
   修复后真机复验（同序列）：callA=「tool call denied by user」、callB 挂起等待用户
   Allow 后返回 {"triggered":true}、对话框干净前进——两症状均消除。commit 91abb0c/763184d。
3. **[平台行为·注记] Windows 多层端口绑定**：0.0.0.0:48215 通配占用不阻塞 127.0.0.1:48215
   具体绑定（反之亦然需 SO_EXCLUSIVEADDRUSE）。应用「连接行仅真实监听成功后输出」的承诺未被
   违反（headless 实例确实绑定成功），但 D7-③ 类测试必须用 127.0.0.1 精确占用才能构造 AddrInUse。
4. **[观察] TrySuspend 未观测**：Pause 档触发后 webview JS 仍可执行（本机非锁屏环境），
   WebView2 挂起语义未直接观测（批⑧曾在锁屏环境观察到等效挂起）。锁库语义不受影响。
