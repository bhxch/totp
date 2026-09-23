# 批⑧ 八项改进真机测试记录（2026-09-23）

- 环境：Windows 10.0.26200 x64，debug 构建（`tauri dev` / `target/debug/totp-desktop.exe`），tauri-plugin-mcp-bridge 0.13（仅 debug）
- 前置：完整 e2e 已全绿（core 734 / ui 823 / desktop 128 / extension 108 前端用例 + cargo 75；双目标构建产物断言；README 链接校验 29×2；四包 typecheck；cargo clippy 0 告警）
- 执行方式：tauri-mcp driver-session（9223）+ headless MCP（curl JSON-RPC）

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

## 三、待解锁后的复测清单（需要活动桌面）

1. **壳层滚动**（Task 4）：rail 固定、内容区内滚、<600px 顶部 Tab 回退整页滚动、FAB 贴视口右下、浮层正常
2. **设置页释放卡**（Task 14）：两档分钟输入（含空串回显守卫）、锁库双开关、保存后 `release_policy_get` 回读一致
3. **MCP 卡片**（Task 2/3）：未启用空 token 占位与复制置灰；启用即生成 token 并刷新；连接片段含真实 token 复制即用
4. **剪贴板导入**（Task 6/7/8）：图片→QR 预填；单条 otpauth URI 预填；多条批量入库（含与库内重复→identical 跳过、条数如实）；无关文本错误提示；popup 单条路径
5. **备注 multiline**（Task 5/6）：备注字段与表单其他 MdTextField 视觉一致（浅色/深色/AMOLED 三主题）
6. **释放策略三段真机**（Task 13）：配置 5/30 → 关窗隐藏 → 5 分钟 TrySuspend（CPU/GPU 下降）→ 30 分钟销毁（内存回落、托盘存活）→ 托盘点击重建；锁库开=重建落锁定页；锁库关=重建恢复解锁（pause=0 路径）；锁屏挂起吞 emit 推断的真机裁决
7. **Firefox 140 空闲锁定裁决**：`idle` 权限已声明、min_version 140，验证 `canIdle()` 是否实际可用（决定 README idle 表述与降级提示是否触发）
8. **mini 窗**：Alt+Shift+T 弹出/失焦隐藏、复制后自动隐藏、force-lock 旁路修复后锁定联动

## 四、发现与处置

- 无代码缺陷发现。阻塞项为锁屏环境（需用户解锁后执行第三节清单）。
- 测试期间的 settings.json 临时写入（releasePolicy 0/0）保留为用户可用配置（等价默认关闭释放功能），如需恢复默认 5/30 在设置页调整即可。
