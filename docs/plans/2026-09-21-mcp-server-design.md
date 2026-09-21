# 设计：desktop 应用内嵌 MCP 服务器（只读验证码，rmcp + 事件桥）

日期：2026-09-21
状态：已评审定稿（brainstorming 分节确认，含两轮修订）

## 背景与目标

给 desktop（Tauri 2）应用版本增加 MCP（Model Context Protocol）功能：让 AI 客户端（ZCode、Claude 等）能列出账户、获取当前验证码，实现"agent 代取验证码"的工作流。

评审确认的边界：

1. **只读**——只暴露列表与取码，不暴露增删改、导入导出，绝不返回 `secret`/`pin` 原文。
2. **应用内嵌本地 HTTP**（MCP Streamable HTTP），仅监听 `127.0.0.1`，不引入独立 stdio 进程。
3. **默认关闭 + 金库解锁才可用 + 客户端分级授权**（粗到细四档，见 §3）。
4. **列表筛选对齐插件版**——支持按 URL 走 match 引擎筛选（评审追加）。

## 现状结论（评审时核实）

- 金库解锁态与 TOTP 计算都在前端 TS 侧（`packages/core/otp`，CodesPage 同源 store）；Rust 侧不持有金库数据。
- webview 内开不了监听 socket → HTTP 服务必须在 Rust 侧；数据流绕不开前端。
- 仓库无任何 MCP 既有代码；`getrandom`（CSPRNG）已在 Cargo 依赖树中。
- `packages/core/src/match/engine.ts` 已导出 `entryMatchesUrl(entry, url)`（extension 弹窗同源，baseDomain/host/exact/startsWith/regex 五策略，含 F13 regex 防回溯限额）。
- desktop 设置走 Rust 侧 `settings.json`（`settings_path`，"解析失败/字段缺失回落默认"约定）。
- i18n 在 `packages/ui/src/i18n`。

## §1 总体架构与组件

**① Rust MCP 服务器（`apps/desktop/src-tauri/src/mcp_server.rs`）**
官方 `rmcp` crate（`server` + `transport-streamable-http-server` feature，底层 axum/tokio 与 Tauri 2 同栈）实现 Streamable HTTP。仅绑 `127.0.0.1`，端口默认 `47215`（可配）。持有 Bearer token、授权模式、白名单，负责协议、鉴权与门控判定。

**② 事件桥（Rust ↔ 前端）**
rmcp tool handler 收到调用 → `emit_to(webview, "mcp://req", {id, tool, args})` + 注册带 5 秒超时的 oneshot 回传通道；前端 `apps/desktop/src/mcpBridge.ts` 监听、处理后 `invoke("mcp_respond", {id, result|error})`。**金库数据始终不落 Rust。**

**③ 前端 handler（`mcpBridge.ts`）**
复用 CodesPage 同源解锁态 store，`packages/core/otp` 现算验证码（totp/steam/yandex/hotp 四类型分发）。

**④ 设置 UI（设置页新 "MCP 服务器" 卡片）**
开关、授权模式、白名单编辑、端口、token 显示/复制/重生成、已批准客户端吊销、AI 客户端连接配置 JSON 片段复制。持久化进 Rust 侧 `settings.json`（扩展字段，沿用回落默认约定）。

生命周期：启动时 `mcp.enabled=true` 自动起服务；开关切换即时起停。

## §2 MCP 接口面

只暴露两个工具（无 copy 工具——agent 拿到 code 本身即可代填，YAGNI）：

- **`list_accounts(filter?, url?)`** → `[{id, issuer, label, type, tags}]`。
  - `filter`：issuer/label 大小写不敏感包含匹配。
  - `url`：`entryMatchesUrl` 筛选（与 extension 同一套策略语义），与 `filter` 取交集。
  - 典型 agent 流：当前页面 URL → url 筛出账户 → `get_code`。
  - 绝不返回 `secret`/`pin`/`algorithm`/`counter` 等多余字段。
- **`get_code(account_id)`**：
  - totp/steam/yandex → `{code, expires_in_seconds, period}`（yandex 用条目内 pin 计算）；
  - **hotp 只窥视当前 counter 的码、不推进计数器**（避免 AI 消耗一次性口令），返回 `{code, counter, note: "counter not advanced"}`。

## §3 安全模型（粗到细四档授权）

**客户端身份**：MCP `initialize` 握手的 `clientInfo.name`（产品级稳定标识，跨版本不变——版本升级不触发重新授权）；缺失时回落 HTTP User-Agent。白名单匹配只看 name、不看 version。

**授权模式**（设置全局四选一，默认 `wildcard`）：

| 档位 | 语义 |
|---|---|
| `token` | 持有效 token 即放行（最粗） |
| `wildcard` | token + 客户端名命中白名单通配符模式（如 `Claude*`，大小写不敏感） |
| `exact` | token + 客户端名与白名单条目精确相等（版本无关） |
| `alwaysAsk` | token + 每次新会话 initialize 都弹窗人工确认（最严） |

白名单为同一字符串列表，`wildcard`/`exact` 复用。`wildcard`/`exact` 档下未知客户端首连弹确认框：**拒绝 / 仅本次 / 加入白名单**。

**传输层防护**：Bearer token（`getrandom` 32B base64url，可重生成）；仅绑 loopback；Host/Origin 校验防 DNS rebinding；无 CORS 放行。

**锁定语义**：所有档位下金库锁定一律返回错误（ CodesPage 同源解锁态即闸门）。

**不记录验证码**：服务端不落任何含 code 的日志。

## §4 错误语义

| 场景 | 返回 |
|---|---|
| 金库锁定 | "vault locked" |
| 未批准客户端 | "approval pending"（提示让用户去应用里批准） |
| 未知 `account_id` | 错误 + 建议先 `list_accounts` |
| 事件桥 5 秒超时 | "app busy" |

## §5 测试与验收

- **Rust `cargo test`**：token 鉴权、Host/Origin 校验、四档门控矩阵（含通配符/精确匹配与版本无关性）、settings 兼容回落。
- **前端 vitest**：`mcpBridge.ts` 锁定/未知账户/四种 OTP 类型分发、url∩filter 交集筛选、hotp 不推进计数器。
- **端到端**：`@modelcontextprotocol/sdk` 脚本真连 dev 应用跑通 initialize → list_accounts → get_code；终验：ZCode 真连一次。

## 决策记录

- **传输**：应用内嵌本地 HTTP，不做 stdio（跨进程共享解锁态复杂度高；预留日后 stdio 桥接）。
- **架构**：rmcp + 事件桥，否决全 Rust（解锁态数据多驻留一份，安全面变大）与手写协议（合规风险）。
- **工具面**：仅 `list_accounts`/`get_code`；无 copy（YAGNI）、无管理类工具（只读边界）。
- **客户端标识**：`clientInfo.name` 而非 UA（UA 随 HTTP 库/版本漂移，会导致升级即失效）。
