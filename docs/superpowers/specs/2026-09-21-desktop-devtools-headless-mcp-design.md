# 设计：桌面端开发者能力——MCP 随机端口 / WebView Remote Debug / 无头 MCP（验收条目 1/4/13）

## 背景与目标

三项桌面端能力增强：MCP 端口一键随机；设置内开启 WebView 远程调试（像 VSCode）；
启动参数支持无头模式仅运行 MCP server 并打印连接信息。

## 现状

- MCP server（`apps/desktop/src-tauri/src/mcp_server.rs`）：Streamable HTTP（rmcp + axum），
  恒绑 `127.0.0.1`；配置 `McpConfig { enabled, mode, port, token, whitelist }` 明文存
  `settings.json`（默认端口 47215，限 1024–65535）；token 首次启用时 CSPRNG 生成
  32B base64url；装配在 `lib.rs` setup 钩子 `init_state_and_autostart`（enabled 即起，不依赖解锁态）。
  数据路径：请求 → `emit_to("main")` → 前端 `requireEntries()`（锁定回 "vault locked"）→ oneshot 回传。
- UI：`packages/ui/src/components/McpServerCard.vue` 端口输入
  `onPortInput`/`onPortCommit` 校验提交；无随机按钮。
- 无 CLI 参数解析（全仓无 `env::args`）；窗口在 `tauri.conf.json` 静态声明
  （`main` 760×560 visible + `mini` 隐藏）；关闭一律 `prevent_close()` + hide 到托盘。
- Tauri 2，无 `devtools` feature，无 additionalBrowserArgs 配置。

## 设计

### §1 MCP 随机端口按钮（条目 1）

`McpServerCard.vue` 的 `.cfg-row` 内、端口输入框旁新增图标按钮（refresh/casino 图标）：

- 点击生成 `49152–65535`（IANA 动态端口段）随机值，填入 `portText` 后走
  现有 `onPortCommit` 同路径校验与 `persist`（端口变更触发服务重启的现有机制不变）。
- i18n：按钮 aria-label/tooltip 双语。

### §2 WebView Remote Debug（条目 4）

**设置 UI**（桌面专属区，`SettingsPage.vue` 新增「开发者」卡片，dev-only 场景但生产可开）：

- 开关「WebView 远程调试」（默认关）+ 端口输入（默认 9222，复用端口校验）。
- 固定红色警示文案：**开放期间本机任意进程可经 CDP 读取窗口内的明文 secret，
  仅限本机诊断，用完即关**。改端口/开关需重启应用生效（UI 提示）。

**存储**：`settings.json` 明文区新增 `devtools: { enabled, port }`（与 security.json 分离，
不进加密区——调试开关必须在无解锁状态下可读）。

**Rust 侧**（`lib.rs` `run()` 最早处、任何窗口/WebView2 环境创建之前）：

- 直读 settings.json；`enabled=true` 时
  `std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", "--remote-debugging-port=<port>")`。
- `Cargo.toml` tauri features 增加 `"devtools"`（release 构建可用 inspector）。

**平台差异（明示）**：CDP remote-debugging-port 仅 Windows/WebView2 支持（VSCode 同款通道）；
macOS（WKWebView Safari Inspector）与 Linux（WebKitGTK Inspector）经 devtools feature
获得应用内 inspector，无网络 CDP 端口。

**安全边界**：默认关；不提供绑定非 loopback 地址的选项（与 MCP server 恒绑 127.0.0.1 同理）。

### §3 无头模式 MCP server（条目 13）

**架构约束（决定了实现形态）**：MCP 取数通道全在前端（Rust → main 窗口 webview →
`requireEntries()`）。真无窗需在 Rust 重写 vault 解密链，不做。
无头 = **隐藏窗口的全功能前端**。

**CLI 参数**（`std::env::args` 手写解析，不引 tauri-plugin-cli）：

- `--headless-mcp`：启用无头模式；
- `--mcp-port <n>`：本次运行覆盖端口（1024–65535）；
- `--mcp-token <tok>`：本次运行覆盖 token（非空，≥16 字符）。
- 解析失败：stderr 说明 + 退出码 2（显式失败优于静默忽略）。
- 覆盖值**仅本次运行生效，不回写 settings.json**。

**行为**：

1. headless 下 `main` 窗口以隐藏方式创建（`tauri.conf.json` 将 main 改 `visible: false`，
   `setup` 里非 headless 路径同步 `show()`——窗口在 setup 前创建但不显示，无闪现；
   实现时验证一帧闪现，如有则改回 setup-hide 方案）；`mini` 本就隐藏，不受影响。
2. 前端照常运转：MCP bridge 监听、已绑定来源的 OS 自动解锁照常尝试。
3. MCP 配置在 `init_state_and_autostart` 前以 CLI 值内存覆盖，强制 `enabled=true`。
4. **连接信息输出**：stdout 打印 `MCP: http://127.0.0.1:<port>  token: <token>  gate: <mode>`。
   注意 `windows_subsystem="windows"` 下 stdout 不可见——headless 模式启动时调用
   `AttachConsole(ATTACH_PARENT_PROCESS)`（win32）尽力恢复；**托盘菜单新增
   「复制 MCP 连接信息」**（地址+token 进剪贴板）作为不依赖终端的兜底。
5. 托盘保留（退出出口）；「显示主窗口」菜单项在 headless 下保留（诊断入口）。

**语义限制（文档明示）**：

- 解锁依赖已绑定的 OS 自动解锁来源（DPAPI/keyring）；只有口令来源时无头模式下
  MCP 恒回 "vault locked"。
- 白名单外请求的审批事件发往隐藏窗口 = 无人批准 → fail-closed。无头场景应配
  `token` 档或显式白名单。
- `--mcp-token` 出现在 shell 历史与进程列表——长驻场景建议仍用 settings.json 持久 token。

## 错误处理

- CLI 端口冲突/被占：沿用现有 server 启动失败上报链路（McpServerCard `lastError` 同源，
  headless 下额外 stderr 打印）。
- `set_var` 失败（理论上不失败）：忽略，devtools 不生效不阻断启动。
- AttachConsole 失败：静默（托盘兜底存在）。

## 验收

- 单测：CLI 解析（合法/非法/缺参）、随机端口范围。
- Rust 测试：配置覆盖不回写 settings.json。
- 手动/E2E：`--headless-mcp` 从终端启动 → stdout 见连接信息 → mcp-e2e.mjs 或外部 MCP 客户端
  连通 `get_code`；托盘「复制 MCP 连接信息」可用；非 headless 启动无窗口闪现。
- devtools：开启后重启，`http://127.0.0.1:<port>/json` 可访问；关闭后不可访问。

## 非目标

- Rust 侧原生 vault 解密（真无头）。
- 非 loopback 绑定、远程（跨机）调试。
- tauri-plugin-cli 引入。
- macOS/Linux 的 CDP 网络端口。
