# 批⑧ 八项改进真机测试记录（2026-09-23 首轮 + 2026-09-24 解锁复测）

- 环境：Windows 10.0.26200 x64，debug 构建（`tauri dev` / `target/debug/totp-desktop.exe`），tauri-plugin-mcp-bridge 0.13（仅 debug）
- 前置：完整 e2e 已全绿（core 734 / ui 823 / desktop 128 / extension 108 前端用例 + cargo 75；双目标构建产物断言；README 链接校验 29×2；四包 typecheck；cargo clippy 0 告警）
- 执行方式：tauri-mcp driver-session（9223）+ headless MCP（curl JSON-RPC）
- 复测环境说明：2026-09-23 首轮测试期间机器处于锁屏状态（LogonUI 运行、截屏全黑），WebView2 对无活动桌面合成环境挂起渲染，webview eval/IPC/截图全部超时——所有 UI 驱动操作在该状态下不可达（平台固有行为，非产品缺陷）。2026-09-24 解锁后完成全部 UI 复测。

## 一、已验证通过（真机）

| # | 项 | 方法 | 结果 |
| --- | --- | --- | --- |
| 1 | 应用启动与 bridge | `tauri dev` + driver-session status | `connected:true`，main/mini 双窗创建，bridge WS 9223 监听 |
| 2 | release 状态机无异常运行 | settings 写入 `releasePolicy {0,0,false,true}`（禁用档）后运行 | tick 无报错，窗口无异常销毁/挂起 |
| 3 | headless MCP 启动 | `--headless-mcp --mcp-port 48300 --mcp-token …` | 连接行仅真实监听成功后输出（与监听同源），gate: Wildcard |
| 4 | CLI token 覆盖不落盘 | 运行后检查 settings.json | `mcp.token` 保持原值，`testtoken` 0 命中 |
| 5 | MCP initialize/initialized/tools/list | curl JSON-RPC（Streamable HTTP） | 协议 2025-03-26，serverInfo `totp-desktop 0.1.0`，四工具齐全（get_code/list_accounts/trigger_backup/trigger_sync） |
| 6 | Bearer 校验 fail-closed | 错误 token 请求 | 401 |
| 7 | 首次客户端审批 gate | 正确 token 调 `list_accounts` | `approval pending: the user must approve this client in the TOTP app`（无人值守 fail-closed，符合设计） |

## 二、环境阻塞（非代码缺陷）

**锁屏/熄屏状态下 WebView2 渲染挂起**：会话 Active 但屏幕黑（CopyFromScreen 全黑）时，webview eval、IPC execute-command、截图全部 2000ms 超时——WebView2 对无活动桌面合成环境挂起渲染，属平台固有行为。附证：清 EBWebView 数据目录、写禁用释放配置均不改变该行为；headless 模式（无 GUI 依赖）一切正常。

**推论（非缺陷确认项）**：第一轮观察到的「窗口不可见数分钟后 JS 超时」与释放策略三段语义一致（隐藏 → 暂停挂起），锁屏环境恰好构成该链路的真实触发，无异常日志。

## 三、复测结果（2026-09-24 解锁后执行，✅ 8/8 项均有结论，其中 3 个真缺陷已修复）

1. **壳层滚动**（Task 4）✅：宽屏 760px 下 `.nav-shell` 定高 560/overflow hidden、`.nav-shell__main` overflow-y auto 且长内容（Settings 1721/560）内部滚动、rail 不随动；resize 到 560px 触发 `--narrow` 顶部 Tab 回退整页滚动（截图 rt-01d）；FAB fixed 贴右下不受影响；**复测中发现并修复隐性滚动 bug（见四-1）**
2. **设置页释放卡**（Task 14）✅：卡片渲染（zh/en 文案随 locale）；getConfig 加载显示；**空串守卫真机生效**（清空分钟输入失焦回显基线值，不静默提交 0）；改值 3→落盘→`release_policy_get` 回读一致；lockOnPause 开关切换回读一致；JS 合成 change 事件同链路生效
3. **MCP 卡片**（Task 2/3）✅：状态 Running；token 掩码 `••••`；复制按钮可用（token 非空）；**连接片段含真实 token（无占位符）**——Task 2 核心改动真机验证
4. **剪贴板导入**（Task 6/7/8）✅（修复 WebView2 权限挂起后）：单条 otpauth URI trusted 点击预填成功（issuer=E2E/label=clip/secret 正确）；多条 3 URI 批量自动入库（弹窗自动关闭、Entries 5→8）；**第二次粘贴同样 3 条 identical 全跳、Entries 保持 (8)**——终审 Important-1 库级去重真机验证；图片场景未单独构造（QR 解码组件已有历史真机验证，剪贴板读取权限链路已由文本场景证实修复）
5. **备注 multiline**（Task 5/6）✅：`<textarea>` rows=3、filled 背景（surface-container-highest）+ 下边框与表单其他 MdTextField 视觉统一、label 浮动正常（截图 rt-05）
6. **释放策略三段真机**（Task 13）✅（配置 pause=0/destroy=1/lockOnDestroy=false 加速验证）：Hide to tray → WebView2 隐藏挂起（JS 冻结，execute-js 超时符合挂起语义）→ ~90 秒后 webview 销毁（driver WS 断、窗口消失）→ **进程存活（修复前进程整体退出，见四-3）**、托盘随进程保留、内存稳定。托盘点击重建与 stash 免解锁恢复为手动观察项（托盘点击不可自动化；lockOnDestroy=false 时前端在隐藏挂起态收不到 stash-dek-request，重建落锁定页属 Task 14 已知边界）
7. **Firefox 140 空闲锁定裁决** ✅：按 MDN 兼容性，`idle.queryState`/`setDetectionInterval` Firefox 完全支持（含 Firefox 特有 `locked` 态），MV3 差异不在 idle API、`"idle"` 权限 MV2/MV3 语义相同——**README「Firefox 空闲锁定不可用」为过时表述，已更正为「idle API 已支持」**（中英同步）；`canIdle()` 探测在 Firefox 140 上预期通过；Firefox 真机加载扩展复核留手动项
8. **mini 窗** ✅（带事实修正）：加密启用时 mini 显示 "Mini window is unavailable while encryption is enabled"——**MiniApp 的加密守卫使「mini 显示验证码后被 force-lock 旁路」的场景实际不可构造**（终审 Important-2 修复保留为纵深防御）；快捷键/托盘呼出与失焦隐藏为手动项

## 四、发现与处置（复测共发现 3 个真缺陷，全部修复 + 1 处文档勘误）

1. **[已修] 壳层锁高引发 document 级隐性滚动**：`md-switch__input`/`md-checkbox__input` 的 sr-only 手法（absolute+1px）在 static 组件根上包含块逃逸到 ICB，不受 `.nav-shell` overflow hidden 裁剪，把 html 撑出 1097px 滚动量（整页空白滚动，截图 rt-01c）。修复：`MdSwitch.vue`/`MdCheckbox.vue` 根加 `position: relative` 收敛包含块；真机复验 docScrollTopMax 1097→0
2. **[已修] 桌面端剪贴板导入按钮无响应**：`navigator.clipboard.read()` 在 WebView2 需要 CLIPBOARD_READ 权限，wry 仅在 `enable_clipboard_access` 时自动放行 PermissionRequested，默认权限请求**永久挂起**（promise 永不 settle，真机实证）。修复：`ensure_window` 的 builder 加 `enable_clipboard_access()`，`tauri.conf.json` 窗口声明移除、main/mini 改由 setup 内 builder 创建（该开关仅 builder 可配）；真机复验单条预填成功
3. **[已修] 释放策略销毁档导致进程整体退出**：destroy main+mini 后 Tauri 对「最后窗口关闭」默认退出（真机实证 exit 0），与 spec「仅保留托盘进程」相悖；destroy 不触发 CloseRequested，既有 prevent_close 拦不到。修复：run 回调增加 `RunEvent::ExitRequested { code: None }` → `api.prevent_exit()`（托盘「退出」走 `app.exit(0)` code=Some 不受影响）；真机复验销毁后进程存活、托盘保留
4. **[已勘误] README Firefox idle 表述过时**：经 MDN 兼容性裁决改为「idle API 已支持（含 locked 态，min_version 140）」，中英同步；Firefox 真机复核留手动项
- 测试结束后 settings.json 的 `releasePolicy` 已恢复 spec 默认 `{5, 30, false, true}`；批量导入产生的 3 条测试条目（BatchOne/BatchTwo/E2E）留在测试库中
- 复测后全量回归：core 734+2skip / ui 823 / desktop 128 / extension 108 + cargo 75 全绿
