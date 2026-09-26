# 覆盖率 E2E 真机兜底清单（2026-09-26）

状态：**清单已录，真机执行待人工/后续会话执行**。本清单承接
`docs/plans/2026-09-25-coverage-design.md` §4（L3 集成胶水层不折算百分比，以真机场景清单管理），
执行记录沿用 `docs/review/2026-09-23-batch8-real-machine-test.md` 的惯例
（逐项「方法/结果」留档，发现缺陷当批修复并回写）。

- 桌面 7 条：可经 tauri-mcp 驱动（driver-session + headless MCP，基建现成），
  标注 **[可自动化]**；托盘点击/系统锁屏等少数子步骤需人工配合，在条目内注明。
- 扩展 6 条：Chrome + Firefox 双浏览器 **[手测]**。
- 每条含：前置条件 / 操作步骤 / 预期行为 / 对应源码位置。

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
