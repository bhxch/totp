# desktop 内嵌 MCP 服务器实施计划（plan17）

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** desktop（Tauri 2）应用内嵌只读 MCP 服务器（Streamable HTTP），让 AI 客户端在金库解锁期间列出账户、获取当前验证码。

**Architecture:** 官方 `rmcp` crate 在 Rust 侧起 127.0.0.1 HTTP 服务并负责 MCP 协议/鉴权/四档客户端门控；工具调用经 Tauri 事件桥转发到前端 TS（金库数据不落 Rust），前端用 `packages/core` 现算验证码后回传。配置持久化进 Rust 侧 `settings.json`；设置页新增 MCP 卡片（`showDesktop` 门控）+ 首连审批对话框。

**Tech Stack:** rmcp 3.x（`server`+`macros`+`transport-streamable-http-server`，自带 axum 0.8/tokio）、Tauri 2 事件与 command、Vue 3 + `packages/ui`、vitest + cargo test。

**设计文档:** `docs/plans/2026-09-21-mcp-server-design.md`（先读它，本计划不再重复论证）。

**API 事实核查结论（2026-09-21 对照 rmcp main 分支源码，实施时以实际拉到版本为准）：**
- `StreamableHttpService::new(factory, LocalSessionManager::default().into(), StreamableHttpServerConfig)` 是 Tower service，`axum::Router::new().nest_service("/mcp", service)` 挂载后 `tokio::net::TcpListener::bind` + `axum::serve` 启动；factory 每请求调用一次（无状态），共享状态靠闭包捕获 `Clone` handle。
- `#[tool_router]` + `#[tool_handler]` 宏生成 ServerHandler；`#[tool(description=...)]` 异步方法参数支持 `Parameters<T>`（schemars 自动生成 inputSchema）与 `context: RequestContext<RoleServer>`（`handler/server/common.rs:152` 有 FromContextPart impl）。
- `RequestContext::client_info() -> Option<Implementation>`：取客户端 `initialize` 的 `clientInfo.name`，无状态模式从每请求 `_meta` 回落（`service.rs:1250` 附近）。
- rmcp 会把 HTTP `http::request::Parts` 注入 `RequestContext.extensions`，tool 方法可用 `Extension(parts): Extension<Parts>` 参数拿到 headers（tower.rs:989 文档示例）——UA 回落与 Host/Origin 信息都从这里来。
- 工具级错误（模型能看到文案）用 `Ok(CallToolResult::error(vec![ContentBlock::text(msg)]))`；协议级错误用 `Err(McpError)`。成功返回 `CallToolResult::success(vec![ContentBlock::text(json)])`。
- 默认 `StreamableHttpServerConfig` 开 legacy session mode；`.with_json_response(true)` 让简单请求回纯 JSON（便于 E2E 脚本用裸 fetch）。

**前端锚点（已核实）：**
- 解锁态：`store.locked`（`Ref<boolean>`，`packages/ui/src/store.ts:823` 返回成员）；条目在 `store.vault.entries`（reactive `Vault`）；标签 `store.vault.tags`。
- 取码统一分发：`packages/ui/src/composables/useOtpCodes.ts`（totp/steamCode/yandexCode/hotp 四分支 + base32Decode）——Task 7 抽成 core 纯函数共用。
- URL 匹配：`entryMatchesUrl(entry, url)`（`packages/core/src/match/engine.ts:186`）。
- settings 卡片门控惯例：`SettingsPage.vue` props `showDesktop`（NavigationShell 按 `railActions?.length` 判定，桌面恒 true）；平台能力用可空 platform prop（`securityPlatform` 惯例）。
- desktop 设置走 Rust `settings.json`（`lib.rs:57-88`，合并写、解析失败回落默认）。
- 事件：`import { listen } from '@tauri-apps/api/event'`；App.vue 已有同款用法。
- i18n：`packages/ui/src/i18n/locales/{zh,en}/common.json`，命名空间式（如 `settingsPage.*`）。
- 测试：desktop vitest `environment: 'node'`，纯逻辑 + 依赖注入风格（不 mock Tauri 全局）；Rust 测试在 `lib.rs`/模块尾部 `#[cfg(test)]`（`*_inner` 纯函数模式）。
- 命令：`pnpm -r test`、`pnpm -r typecheck`、desktop 下 `cargo test`（src-tauri 目录）。

**约定：** 每个任务做完即 commit（Angular 规范、中文主题，先 why 后 what，与仓库近期风格一致）。任务内「写测试→跑红→实现→跑绿→提交」严格 TDD；纯编译性步骤（Task 1）除外。

---

### Task 1: 引入 rmcp 依赖并验证可编译

**Files:**
- Modify: `apps/desktop/src-tauri/Cargo.toml`

**Step 1: 加依赖**

在 `[dependencies]` 末尾追加：

```toml
# plan17：内嵌 MCP 服务器（Streamable HTTP）。rmcp 自带 axum/tokio 栈，与 tauri 2 同源
rmcp = { version = "3", features = ["server", "macros", "transport-streamable-http-server"] }
```

**Step 2: 验证编译**

Run: `cd apps/desktop/src-tauri && cargo check`
Expected: 编译通过（新增依赖较多，首次拉取编译耗时可接受）。若 rmcp 3.x 的 feature 名有出入（如 `transport-streamable-http-server` 改名），以 `cargo add rmcp --features server` 的报错提示修正。

**Step 3: Commit**

```bash
git add apps/desktop/src-tauri/Cargo.toml apps/desktop/src-tauri/Cargo.lock
git commit -m "build(desktop): 引入 rmcp 依赖

why: plan17 内嵌 MCP 服务器需要官方 Rust SDK 的 Streamable HTTP 服务端
what: rmcp 3.x（server+macros+transport-streamable-http-server 三 feature）"
```

---

### Task 2: MCP 配置模型与 settings.json 持久化（Rust）

**Files:**
- Create: `apps/desktop/src-tauri/src/mcp_server.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`（顶部加 `mod mcp_server;`）

**要点：** 配置读写全部走「以 `PathBuf` 为参数的 `*_inner` 纯函数」（同 `settings_path`/`read_shortcut_from_settings` 惯例），`AppHandle` 版薄包装在 Task 6 提供。

**Step 1: 写失败测试（放 `mcp_server.rs` 尾部 `#[cfg(test)]`）**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn tmp_path(name: &str) -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("mcp-test-{}-{}.json", std::process::id(), name));
        let _ = std::fs::remove_file(&p);
        p
    }

    #[test]
    fn config_defaults_are_secure() {
        let c = McpConfig::default();
        assert!(!c.enabled, "默认必须关闭");
        assert_eq!(c.mode, GateMode::Wildcard, "默认 wildcard 档");
        assert_eq!(c.port, 47215);
        assert!(c.token.is_empty(), "token 首次由 Rust 生成，缺省为空");
        assert!(c.whitelist.is_empty());
    }

    #[test]
    fn settings_roundtrip_and_foreign_keys_preserved() {
        let p = tmp_path("roundtrip");
        // 预置一个外来键（shortcutToggleMini），验证合并写不覆盖
        std::fs::write(&p, r#"{"shortcutToggleMini":"alt+shift+t"}"#).unwrap();
        let cfg = McpConfig { enabled: true, ..McpConfig::default() };
        save_mcp_config_inner(&p, &cfg).unwrap();
        let back = load_mcp_config_inner(&p);
        assert!(back.enabled);
        assert_eq!(
            std::fs::read_to_string(&p).unwrap().contains("shortcutToggleMini"),
            true,
            "外来键必须保留"
        );
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn corrupt_settings_falls_back_to_defaults() {
        let p = tmp_path("corrupt");
        std::fs::write(&p, "{not json").unwrap();
        let c = load_mcp_config_inner(&p);
        assert!(!c.enabled, "损坏文件回落默认=关闭");
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn whitelist_add_persists() {
        let p = tmp_path("whitelist");
        let mut cfg = load_mcp_config_inner(&p);
        add_whitelist_inner(&p, &mut cfg, "Claude*").unwrap();
        assert!(load_mcp_config_inner(&p).whitelist.contains(&"Claude*".to_string()));
        let _ = std::fs::remove_file(&p);
    }
}
```

**Step 2: 跑红**

Run: `cd apps/desktop/src-tauri && cargo test mcp_server 2>&1 | tail -5`
Expected: 编译失败（`McpConfig`/函数未定义）。

**Step 3: 最小实现（`mcp_server.rs`）**

```rust
//! plan17：内嵌 MCP 服务器（只读验证码）。协议/鉴权在 rmcp 侧，金库数据经事件桥留在前端。
//! 设计：docs/plans/2026-09-21-mcp-server-design.md
use serde::{Deserialize, Serialize};

/// 客户端授权档位：粗到细。匹配对象恒为 clientInfo.name（不看 version，升级不失效）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GateMode {
    /// 持 token 即放行
    Token,
    /// 白名单通配符（`Claude*`，大小写不敏感）
    Wildcard,
    /// 白名单精确相等
    Exact,
    /// 每次调用前都需有效批准（内存态 15 分钟 TTL，过期再弹窗；不写白名单）
    AlwaysAsk,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct McpConfig {
    pub enabled: bool,
    pub mode: GateMode,
    pub port: u16,
    /// base64url(32B CSPRNG)；空串=未生成（启用时由 Rust 首次生成）
    pub token: String,
    /// 白名单 pattern 列表（wildcard/exact 两档共用）
    pub whitelist: Vec<String>,
}

impl Default for McpConfig {
    fn default() -> Self {
        Self { enabled: false, mode: GateMode::Wildcard, port: 47215, token: String::new(), whitelist: Vec::new() }
    }
}

fn settings_path_inner(dir: &std::path::Path) -> std::path::PathBuf {
    dir.join("settings.json")
}

pub fn load_mcp_config_inner(app_data: &std::path::Path) -> McpConfig {
    // 与 read_shortcut_from_settings 同口径：读不到/解析失败一律默认（默认=关闭，安全侧）
    let Ok(text) = std::fs::read_to_string(settings_path_inner(app_data)) else { return McpConfig::default() };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else { return McpConfig::default() };
    v.get("mcp").map(|m| serde_json::from_value::<McpConfig>(m.clone()).unwrap_or_default()).unwrap_or_default()
}

/// 合并写：只动 `mcp` 键，外来键（shortcutToggleMini 等）原样保留
pub fn save_mcp_config_inner(app_data: &std::path::Path, cfg: &McpConfig) -> Result<(), String> {
    let p = settings_path_inner(app_data);
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut obj: serde_json::Map<String, serde_json::Value> = std::fs::read_to_string(&p)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default();
    obj.insert("mcp".into(), serde_json::to_value(cfg).map_err(|e| e.to_string())?);
    std::fs::write(&p, serde_json::to_string_pretty(&obj).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}

pub fn add_whitelist_inner(app_data: &std::path::Path, cfg: &mut McpConfig, pattern: &str) -> Result<(), String> {
    if !cfg.whitelist.iter().any(|w| w == pattern) {
        cfg.whitelist.push(pattern.to_string());
    }
    save_mcp_config_inner(app_data, cfg)
}
```

（`mod tests` 如 Step 1；`lib.rs` 顶部加 `mod mcp_server;`。）

**Step 4: 跑绿**

Run: `cd apps/desktop/src-tauri && cargo test mcp_server`
Expected: 4 passed。

**Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/mcp_server.rs apps/desktop/src-tauri/src/lib.rs
git commit -m "feat(mcp): 配置模型与 settings.json 合并持久化

why: plan17 MCP 开关/档位/白名单/token 需要设备侧持久化，且不得破坏既有键
what: McpConfig 四档 GateMode + load/save/addWhitelist 纯函数（PathBuf 注入可测，损坏回落默认=关闭）"
```

---

### Task 3: token 生成（CSPRNG + base64url，无新依赖）

**Files:**
- Modify: `apps/desktop/src-tauri/src/mcp_server.rs`

**Step 1: 写失败测试**

```rust
    #[test]
    fn token_shape_and_uniqueness() {
        let t1 = generate_token();
        let t2 = generate_token();
        assert_eq!(t1.len(), 43, "32B base64url 无填充 = 43 字符");
        assert!(t1.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
        assert_ne!(t1, t2);
    }
```

**Step 2: 跑红** — `cargo test mcp_server`，Expected: 编译失败。

**Step 3: 实现**

```rust
/// getrandom 已在依赖树（tauri 传递）；base64url 手写避免引 base64 crate
pub fn generate_token() -> String {
    use std::io::Read as _;
    let mut buf = [0u8; 32];
    getrandom::fill(&mut buf).expect("CSPRNG 不可用属致命环境错误");
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity(43);
    for chunk in buf.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = u32::from_be_bytes([0, b[0], b[1], b[2]]);
        for i in 0..4 {
            if i * 8 < chunk.len() * 8 + 2 {
                out.push(TABLE[(n >> (26 - 6 * i)) as usize & 63] as char);
            }
        }
    }
    // 32B = 10 组 3B + 1 组 2B(尾组 3 字符)，恒 43 字符
    let mut r = [0u8; 1];
    std::io::empty().read_exact(&mut r).ok(); // no-op：占位防误删 use
    out
}
```

> 注：上面循环的手写 base64url 容易出错——实现时若测试不过，改用更直白的查表法（逐 6bit 取表）或保留此注释提醒实施者以测试为准。禁止为此引入新 crate。

**Step 4: 跑绿** — `cargo test mcp_server`，Expected: 5 passed。

**Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/mcp_server.rs
git commit -m "feat(mcp): 连接 token 生成（getrandom 32B + 手写 base64url）

why: Bearer token 是全部档位共用的第一道门
what: generate_token 纯函数，不新增依赖"
```

---

### Task 4: 客户端门控决策（wildcard/精确/alwaysAsk 纯函数）

**Files:**
- Modify: `apps/desktop/src-tauri/src/mcp_server.rs`

**Step 1: 写失败测试**

```rust
    #[test]
    fn wildcard_match_is_case_insensitive() {
        assert!(wildcard_match("Claude*", "claude-desktop"));
        assert!(wildcard_match("*zcode*", "ZCode CLI"));
        assert!(wildcard_match("exact-name", "exact-name"));
        assert!(!wildcard_match("claude*", "cursor"));
        assert!(wildcard_match("*", "anything"));
    }

    #[test]
    fn gate_decision_matrix() {
        use GateMode::*;
        let base = |mode: GateMode, whitelist: &[&str]| McpConfig {
            enabled: true, mode, port: 0,
            token: "t".into(),
            whitelist: whitelist.iter().map(|s| s.to_string()).collect(),
        };
        // token 档：不看名字
        assert!(matches!(decide_gate(&base(Token, &[]), Some("anything")), GateDecision::Allow));
        // wildcard 档：命中放行
        assert!(matches!(decide_gate(&base(Wildcard, &["Claude*"]), Some("claude-desktop")), GateDecision::Allow));
        // wildcard 档：未命中 → 待批准（首次触发审批弹窗）
        assert!(matches!(decide_gate(&base(Wildcard, &["Claude*"]), Some("cursor")), GateDecision::NeedsApproval));
        // exact 档：精确相等（版本无关，decide 不接收 version）
        assert!(matches!(decide_gate(&base(Exact, &["ZCode"]), Some("ZCode")), GateDecision::Allow));
        assert!(matches!(decide_gate(&base(Exact, &["ZCode"]), Some("ZCode 2.0")), GateDecision::NeedsApproval));
        // 身份缺失（clientInfo 与 UA 全无）除 token 档外一律待批准
        assert!(matches!(decide_gate(&base(Wildcard, &["*"]), None), GateDecision::NeedsApproval));
        // alwaysAsk 恒待批准（once-TTL 由调用方 GateSessions 管）
        assert!(matches!(decide_gate(&base(AlwaysAsk, &[]), Some("claude")), GateDecision::NeedsApproval));
    }
```

**Step 2: 跑红** — Expected: 编译失败。

**Step 3: 实现**

```rust
/// 大小写不敏感通配符匹配：仅支持 `*`（任意长度），无 `?`——白名单语义保持可预期
pub fn wildcard_match(pattern: &str, name: &str) -> bool {
    fn rec(p: &[u8], s: &[u8]) -> bool {
        if p.is_empty() { return s.is_empty() }
        if p[0] == b'*' {
            for i in 0..=s.len() { if rec(&p[1..], &s[i..]) { return true } }
            false
        } else {
            !s.is_empty() && p[0].eq_ignore_ascii_case(&s[0]) && rec(&p[1..], &s[1..])
        }
    }
    rec(pattern.as_bytes(), name.as_bytes())
}

/// 一次性门控判定（纯函数）。once-TTL 记账不在此处（见 GateSessions）。
pub fn decide_gate(cfg: &McpConfig, client_name: Option<&str>) -> GateDecision {
    use GateMode::*;
    match cfg.mode {
        Token => GateDecision::Allow,
        Wildcard | Exact => {
            let Some(name) = client_name else { return GateDecision::NeedsApproval };
            let hit = match cfg.mode {
                Exact => cfg.whitelist.iter().any(|w| w.eq_ignore_ascii_case(name)),
                _ => cfg.whitelist.iter().any(|w| wildcard_match(w, name)),
            };
            if hit { GateDecision::Allow } else { GateDecision::NeedsApproval }
        }
        AlwaysAsk => GateDecision::NeedsApproval,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GateDecision {
    Allow,
    /// 触发审批事件 + 本次调用回 pending 错误
    NeedsApproval,
}
```

**Step 4: 跑绿** — `cargo test mcp_server`，Expected: 7 passed。

**Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/mcp_server.rs
git commit -m "feat(mcp): 四档客户端门控纯函数

why: token→wildcard→exact→alwaysAsk 粗到细授权是评审定稿的安全模型核心
what: wildcard_match + decide_gate（匹配只看 clientInfo.name，版本升级不失效；身份缺失 fail-closed）"
```

---

### Task 5: 事件桥（pending 表 + 5 秒超时回传）

**Files:**
- Modify: `apps/desktop/src-tauri/src/mcp_server.rs`

**Step 1: 写失败测试**

```rust
    #[test]
    fn bridge_respond_resolves_pending() {
        let bridge = BridgeShared::default();
        let (tx, mut rx) = tokio::sync::oneshot::channel::<Result<serde_json::Value, String>>();
        bridge.insert(7, tx);
        assert!(bridge.take(7).is_some());
        assert!(bridge.respond(7, Ok(serde_json::json!({"code": "123456"}))).is_err(), "已 take 的 id 不应存在");
        assert_eq!(rx.try_recv().unwrap().unwrap()["code"], "123456");
    }
```

> 测试需要 tokio oneshot 但不需要 async runtime（`try_recv` 同步可用）。若编译器要求 tokio 依赖可见：在 `Cargo.toml` `[dependencies]` 显式加 `tokio = { version = "1", features = ["sync", "macros"] }`（tauri 已传递引入同版本，不新增编译产物体积）。

**Step 2: 跑红** — Expected: 编译失败。

**Step 3: 实现**

```rust
use std::collections::HashMap;
use std::sync::Mutex;
use tokio::sync::oneshot;

/// 前端回传通道共享表：id → oneshot。事件桥的核心数据结构
#[derive(Default)]
pub struct BridgeShared {
    pending: Mutex<HashMap<u64, oneshot::Sender<Result<serde_json::Value, String>>>>,
    next_id: std::sync::atomic::AtomicU64,
}

impl BridgeShared {
    pub fn alloc_id(&self) -> u64 {
        self.next_id.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    }
    pub fn insert(&self, id: u64, tx: oneshot::Sender<Result<serde_json::Value, String>>) {
        if let Ok(mut p) = self.pending.lock() { p.insert(id, tx); }
    }
    pub fn take(&self, id: u64) -> Option<oneshot::Sender<Result<serde_json::Value, String>>> {
        self.pending.lock().ok()?.remove(&id)
    }
    /// 前端迟到回传（超时后）静默丢弃，返回 Err 供命令层忽略
    pub fn respond(&self, id: u64, result: Result<serde_json::Value, String>) -> Result<(), String> {
        self.take(id).ok_or_else(|| "unknown id".to_string())?
            .send(result).map_err(|_| "receiver dropped".to_string())
    }
}

/// 工具调用 → webview 事件 → 前端回传，全程 5 秒超时
pub async fn bridge_call(
    app: &tauri::AppHandle,
    bridge: &BridgeShared,
    window: &str,
    tool: &str,
    args: serde_json::Value,
) -> Result<serde_json::Value, String> {
    use tauri::Emitter;
    let id = bridge.alloc_id();
    let (tx, rx) = oneshot::channel();
    bridge.insert(id, tx);
    app.emit_to(window, "mcp://req", serde_json::json!({ "id": id, "tool": tool, "args": args }))
        .map_err(|e| format!("emit failed: {e}"))?;
    // 5 秒超时（设计 §4 app busy）；超时后手动 take 防表泄漏
    match tokio::time::timeout(std::time::Duration::from_secs(5), rx).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err("frontend dropped the request".into()),
        Err(_) => {
            bridge.take(id);
            Err("app busy".into())
        }
    }
}
```

**Step 4: 跑绿** — `cargo test mcp_server`，Expected: 8 passed。

**Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/mcp_server.rs apps/desktop/src-tauri/Cargo.toml
git commit -m "feat(mcp): 事件桥 pending 表与 5 秒超时回传

why: 金库数据只在 webview，Rust 侧工具调用必须经事件桥向前端取数
what: BridgeShared(alloc/insert/take/respond) + bridge_call（mcp://req 事件 + mcp_respond 回传）"
```

---

### Task 6: 审批会话 + rmcp 服务组装 + 传输层防护 + Tauri 命令

**Files:**
- Modify: `apps/desktop/src-tauri/src/mcp_server.rs`（主体）
- Modify: `apps/desktop/src-tauri/src/lib.rs`（mod 引用已有；`.invoke_handler` 注册 + `.manage()` + setup 启动）

**Step 1: 写失败测试**

```rust
    #[test]
    fn host_and_origin_validation() {
        assert!(validate_host_origin(Some("127.0.0.1:47215"), None).is_ok());
        assert!(validate_host_origin(Some("localhost:47215"), None).is_ok());
        assert!(validate_host_origin(Some("evil.com"), None).is_err(), "DNS rebinding：Host 必须是 loopback");
        assert!(validate_host_origin(None, None).is_err());
        assert!(validate_host_origin(Some("127.0.0.1:47215"), Some("http://127.0.0.1:47215")).is_ok());
        assert!(validate_host_origin(Some("127.0.0.1:47215"), Some("http://evil.com")).is_err());
    }

    #[test]
    fn constant_time_token_compare() {
        assert!(token_eq("abc", "abc"));
        assert!(!token_eq("abc", "abd"));
        assert!(!token_eq("abc", "ab"));
        assert!(!token_eq("", ""));
    }

    #[test]
    fn approval_session_ttl() {
        let mut s = GateSessions::default();
        s.grant_once("claude".into());
        assert!(s.once_valid("claude"));
        s.expire_all_for_test();
        assert!(!s.once_valid("claude"));
    }
```

**Step 2: 跑红** — Expected: 编译失败。

**Step 3: 实现（本任务代码量大，按小节落）**

3a. 传输层防护 + token 比较：

```rust
/// Host 必须是 loopback（DNS rebinding 防护）；Origin 出现时必须是同源 http loopback
pub fn validate_host_origin(host: Option<&str>, origin: Option<&str>) -> Result<(), &'static str> {
    fn is_loopback_host(h: &str) -> bool {
        let host = h.rsplit(':').next().unwrap_or(h); // 去端口（IPv6 场景仅 loopback 字面量，不支持 [::1] 域外场景）
        host == "127.0.0.1" || host == "localhost"
    }
    let Some(h) = host else { return Err("missing host") };
    if !is_loopback_host(h) { return Err("host not loopback") }
    if let Some(o) = origin {
        // Origin 形如 http://127.0.0.1:47215
        let after = o.strip_prefix("http://").ok_or("origin not http")?;
        if !is_loopback_host(after) { return Err("origin not loopback") }
    }
    Ok(())
}

/// 恒时比较（长度差立即短路可接受：长度本身不泄密——token 定长 43）
pub fn token_eq(a: &str, b: &str) -> bool {
    if a.len() != b.len() { return false }
    a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}
```

3b. 审批会话（once-TTL 内存态）：

```rust
use std::time::{Duration, Instant};

/// 审批态记账：once = 「仅本次」（15 分钟 TTL）；deny 后短窗内不重复弹窗防轰炸
#[derive(Default)]
pub struct GateSessions {
    once: Mutex<HashMap<String, Instant>>,
    cooldown: Mutex<HashMap<String, Instant>>,
}
pub const ONCE_TTL: Duration = Duration::from_secs(15 * 60);
pub const DENY_COOLDOWN: Duration = Duration::from_secs(60);

impl GateSessions {
    pub fn grant_once(&self, ident: String) {
        if let Ok(mut m) = self.once.lock() { m.insert(ident, Instant::now()); }
    }
    pub fn once_valid(&self, ident: &str) -> bool {
        self.once.lock().ok()
            .and_then(|m| m.get(ident).copied())
            .map(|t| t.elapsed() < ONCE_TTL)
            .unwrap_or(false)
    }
    pub fn mark_denied(&self, ident: &str) {
        if let Ok(mut m) = self.cooldown.lock() { m.insert(ident.to_string(), Instant::now()); }
    }
    pub fn denied_recently(&self, ident: &str) -> bool {
        self.cooldown.lock().ok()
            .and_then(|m| m.get(ident).copied())
            .map(|t| t.elapsed() < DENY_COOLDOWN)
            .unwrap_or(false)
    }
    #[cfg(test)]
    pub fn expire_all_for_test(&mut self) { self.once.clear(); }
}
```

3c. 共享状态与 Tauri 命令（`mcp_respond`、配置读写、审批响应；`McpState` 作为 `.manage()` 对象）：

```rust
use tauri::{AppHandle, Manager, State};

/// manage 进 App 的全局句柄
pub struct McpState {
    pub bridge: std::sync::Arc<BridgeShared>,
    pub sessions: std::sync::Arc<GateSessions>,
    /// 运行中服务的停机通道（None=未运行）
    pub shutdown: Mutex<Option<tokio::sync::watch::Sender<bool>>>,
    pub app_data_dir: std::path::PathBuf,
}

#[tauri::command]
pub fn mcp_get_config(state: State<'_, McpState>) -> McpConfig {
    load_mcp_config_inner(&state.app_data_dir)
}

#[tauri::command]
pub fn mcp_set_config(app: AppHandle, state: State<'_, McpState>, cfg: McpConfig) -> Result<(), String> {
    save_mcp_config_inner(&state.app_data_dir, &cfg)?;
    restart_if_needed(&app, &state, &cfg)
}

#[tauri::command]
pub fn mcp_regenerate_token(state: State<'_, McpState>) -> Result<String, String> {
    let mut cfg = load_mcp_config_inner(&state.app_data_dir);
    cfg.token = generate_token();
    save_mcp_config_inner(&state.app_data_dir, &cfg)?;
    Ok(cfg.token)
}

/// 前端审批对话框回执：deny=冷却 60s；once=15 分钟内放行；trust=写白名单并持久化
#[tauri::command]
pub fn mcp_approval_response(state: State<'_, McpState>, ident: String, action: String) -> Result<(), String> {
    match action.as_str() {
        "deny" => state.sessions.mark_denied(&ident),
        "once" => state.sessions.grant_once(ident),
        "trust" => {
            let mut cfg = load_mcp_config_inner(&state.app_data_dir);
            add_whitelist_inner(&state.app_data_dir, &mut cfg, &ident)?;
        }
        _ => return Err(format!("unknown action: {action}")),
    }
    Ok(())
}

#[tauri::command]
pub fn mcp_respond(state: State<'_, McpState>, id: u64, ok: bool, result: Option<serde_json::Value>, error: Option<String>) {
    let payload = if ok {
        result.map(Ok).unwrap_or_else(|| Err("empty result".into()))
    } else {
        Err(error.unwrap_or_else(|| "unknown error".into()))
    };
    let _ = state.bridge.respond(id, payload); // 迟到回传静默丢弃
}

/// enabled/port 变化即重启；纯白名单/档位/token 变更即时生效（每次请求重读配置，无需重启）
fn restart_if_needed(app: &AppHandle, state: &State<'_, McpState>, cfg: &McpConfig) -> Result<(), String> {
    stop_server(state);
    if cfg.enabled { start_server(app, state, cfg) } else { Ok(()) }
}

fn stop_server(state: &State<'_, McpState>) {
    if let Ok(mut g) = state.shutdown.lock() {
        if let Some(tx) = g.take() { let _ = tx.send(true); }
    }
}

pub fn start_server(app: &AppHandle, state: &State<'_, McpState>, cfg: &McpConfig) -> Result<(), String> {
    let mut cfg = cfg.clone();
    if cfg.token.is_empty() {
        cfg.token = generate_token();
        save_mcp_config_inner(&state.app_data_dir, &cfg)?;
    }
    let (tx, rx) = tokio::sync::watch::channel(false);
    *state.shutdown.lock().map_err(|_| "lock poisoned")? = Some(tx);
    let app = app.clone();
    let bridge = state.bridge.clone();
    let sessions = state.sessions.clone();
    let port = cfg.port;
    tauri::async_runtime::spawn(async move {
        let _ = serve_forever(app, bridge, sessions, cfg, port, rx).await;
    });
    Ok(())
}
```

3d. rmcp 服务本体（`serve_forever` + 工具定义 + 门控接线）：

```rust
use rmcp::handler::server::tool::Extension;
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{CallToolResult, ContentBlock, Implementation, ServerInfo};
use rmcp::schemars;
use rmcp::{ErrorData as McpError, ServerHandler, ServiceRole, tool, tool_handler, tool_router};
use rmcp::service::{RequestContext, RoleServer};
use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
use rmcp::transport::streamable_http_server::{StreamableHttpServerConfig, StreamableHttpService};
use http::request::Parts;

#[derive(Debug, Clone)]
pub struct TotpMcp {
    app: AppHandle,
    bridge: std::sync::Arc<BridgeShared>,
    sessions: std::sync::Arc<GateSessions>,
    cfg: McpConfig,
}

/// 恒定身份串：clientInfo.name 优先，回落 UA，再回落 <unknown>（fail-closed）
fn identity_of(context: &RequestContext<RoleServer>) -> String {
    if let Some(ci) = context.client_info() { return ci.name.clone() }
    if let Some(parts) = context.extensions.get::<Parts>() {
        if let Some(ua) = parts.headers.get(http::header::USER_AGENT).and_then(|v| v.to_str().ok()) {
            return ua.to_string();
        }
    }
    "<unknown>".into()
}

async fn gated_call(
    mcp: &TotpMcp,
    context: &RequestContext<RoleServer>,
    tool: &str,
    args: serde_json::Value,
) -> Result<serde_json::Value, McpError> {
    // 配置每请求重读：设置页改动即时生效（免重启的档位/白名单/token）
    let cfg = load_mcp_config_inner(&mcp.cfg_path);
    if !cfg.enabled { return Err(McpError::invalid_params("mcp disabled", None)) }
    let ident = identity_of(context);
    match decide_gate(&cfg, Some(&ident)) {
        Ok(()) => {}
        Err(()) => {
            if mcp.sessions.once_valid(&ident) { /* once 批准期内放行 */ }
            else if mcp.sessions.denied_recently(&ident) {
                return Err(McpError::invalid_params("approval denied; ask the user to reopen the approval dialog", None));
            } else {
                let _ = tauri::Emitter::emit_to(&mcp.app, "main", "mcp://approval",
                    serde_json::json!({ "ident": ident, "tool": tool }));
                return Err(McpError::invalid_params("approval pending: the user must approve this client in the TOTP app", None));
            }
        }
    }
    bridge_call(&mcp.app, &mcp.bridge, "main", tool, args)
        .await
        .map_err(|e| McpError::invalid_params(e, None))
}
```

> 实施注记：`decide_gate` 在 Task 4 返回枚举 `GateDecision`；此处按枚举 match（`Allow/NeedsApproval`），`once_valid` 分支放在 `NeedsApproval` 内先判——上面伪代码标注了意图，落码时统一为：
> `Allow => {}` / `NeedsApproval if once_valid => {}` / 其余 => 事件+pending 错误。`mcp.cfg_path` 把 app_data_dir 存进 TotpMcp。`McpError::invalid_params` 若语义不合可换 `McpError::custom(code, msg, None)`——以能到达模型的可读文案为准。

```rust
#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub struct ListAccountsParams {
    /// issuer/label 大小写不敏感包含匹配
    #[schemars(description = "Optional case-insensitive substring filter over issuer and label")]
    pub filter: Option<String>,
    /// 站点 URL：走条目 matchRules（baseDomain/host/exact/startsWith/regex）筛选
    #[schemars(description = "Optional page URL; returns entries whose match rules match it")]
    pub url: Option<String>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
pub struct GetCodeParams {
    /// list_accounts 返回的 id
    #[schemars(description = "Account id as returned by list_accounts")]
    pub account_id: String,
}

#[tool_router]
impl TotpMcp {
    pub fn new(app: AppHandle, bridge: std::sync::Arc<BridgeShared>, sessions: std::sync::Arc<GateSessions>, cfg: McpConfig, cfg_path: std::path::PathBuf) -> Self {
        Self { app, bridge, sessions, cfg, cfg_path }
    }

    #[tool(description = "List TOTP accounts (id, issuer, label, type, tags). Never returns secrets.")]
    async fn list_accounts(
        &self,
        Parameters(p): Parameters<ListAccountsParams>,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, McpError> {
        let result = gated_call(self, &context, "list_accounts", serde_json::to_value(&p).unwrap()).await?;
        Ok(CallToolResult::success(vec![ContentBlock::text(result.to_string())]))
    }

    #[tool(description = "Get the current one-time code for an account. HOTP counter is peeked, not advanced.")]
    async fn get_code(
        &self,
        Parameters(p): Parameters<GetCodeParams>,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, McpError> {
        let result = gated_call(self, &context, "get_code", serde_json::to_value(&p).unwrap()).await?;
        Ok(CallToolResult::success(vec![ContentBlock::text(result.to_string())]))
    }
}

#[tool_handler]
impl ServerHandler for TotpMcp {
    fn get_info(&self) -> ServerInfo {
        ServerInfo {
            server_info: Implementation { name: "totp-desktop".into(), version: env!("CARGO_PKG_VERSION").into(), ..Default::default() },
            ..Default::default()
        }
    }
}

pub async fn serve_forever(
    app: AppHandle,
    bridge: std::sync::Arc<BridgeShared>,
    sessions: std::sync::Arc<GateSessions>,
    cfg: McpConfig,
    port: u16,
    mut shutdown: tokio::sync::watch::Receiver<bool>,
) -> Result<(), String> {
    let state_for_factory = (app.clone(), bridge.clone(), sessions.clone(), cfg.clone(), app.path().app_data_dir().map_err(|e| e.to_string())?);
    let service: StreamableHttpService<TotpMcp, LocalSessionManager> = StreamableHttpService::new(
        move || Ok(TotpMcp::new(state_for_factory.0.clone(), state_for_factory.1.clone(), state_for_factory.2.clone(), state_for_factory.3.clone(), state_for_factory.4.clone())),
        LocalSessionManager::default().into(),
        StreamableHttpServerConfig::default().with_json_response(true),
    );
    let bearer = format!("Bearer {}", cfg.token);
    let middleware = axum::middleware::from_fn(move |req: axum::http::Request<axum::body::Body>, next: axum::middleware::Next| {
        let bearer = bearer.clone();
        async move {
            let (parts, body) = req.into_parts();
            // 1) Host/Origin 防DNS rebinding 2) Bearer 恒时比较
            let host = parts.headers.get(axum::http::header::HOST).and_then(|v| v.to_str().ok());
            let origin = parts.headers.get(axum::http::header::ORIGIN).and_then(|v| v.to_str().ok());
            if validate_host_origin(host, origin).is_err() {
                return axum::http::StatusCode::FORBIDDEN.into_response();
            }
            let auth = parts.headers.get(axum::http::header::AUTHORIZATION).and_then(|v| v.to_str().ok());
            if !auth.map(|a| token_eq(a, &bearer)).unwrap_or(false) {
                return axum::http::StatusCode::UNAUTHORIZED.into_response();
            }
            Ok(next.run(axum::body::Body::from(body)).await)
        }
    });
    let router = axum::Router::new().nest_service("/mcp", service).layer(middleware);
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await
        .map_err(|e| format!("bind 127.0.0.1:{port} failed: {e}"))?;
    axum::serve(listener, router)
        .with_graceful_shutdown(async move { let _ = shutdown.changed().await; })
        .await
        .map_err(|e| e.to_string())
}
```

> 实施注记：`Implementation` 字段集（是否有 `title`）与 `ServerInfo::..Default::default()` 的可用性以拉到的 rmcp 版本为准；`getrandom` 版本 0.3 的 API 是 `getrandom::fill(&mut buf)`（0.2 是 `getrandom::getrandom`，按 Cargo.toml 实际版本选）。`http` crate 已随 rmcp/tauri 传递引入，若 cargo 报缺依赖则在 Cargo.toml 显式加 `http = "1"`。

3e. `lib.rs` 接线两处：
- `.invoke_handler(tauri::generate_handler![...])` 列表追加 `mcp_server::mcp_get_config, mcp_server::mcp_set_config, mcp_server::mcp_regenerate_token, mcp_server::mcp_approval_response, mcp_server::mcp_respond`；
- `.manage(mcp_server::McpState { bridge: Default::default(), sessions: Default::default(), shutdown: Default::default(), app_data_dir: app.path().app_data_dir().expect("app data dir") })`（在 `.setup(|app| {...})` 内首行附近）；随后若 `mcp_server::load_mcp_config_inner(&dir).enabled` 则 `mcp_server::start_server(&app.handle(), &state, &cfg)`——manage 返回的 State 生命周期在 setup 内可通过 `app.state::<McpState>()` 拿。

**Step 4: 跑绿**

Run: `cd apps/desktop/src-tauri && cargo test && cargo check`
Expected: 全部测试通过（3 个新测试 + 既有 21 个），编译无警告。

**Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/mcp_server.rs apps/desktop/src-tauri/src/lib.rs apps/desktop/src-tauri/Cargo.toml
git commit -m "feat(mcp): rmcp 服务组装、传输防护与 Tauri 命令

why: 协议/鉴权/门控在 Rust 侧成型，事件桥对前端只暴露两个只读工具
what: TotpMcp(list_accounts/get_code) + Bearer 恒时比较 + Host/Origin 校验 + once-TTL 审批会话 + mcp_* 五命令 + 启动自动拉起"
```

---

### Task 7: core 取码纯函数 `computeEntryCode`（useOtpCodes 重构共用）

**Files:**
- Create: `packages/core/src/otp/entryCode.ts`
- Modify: `packages/core/src/index.ts`（`export * from './otp/entryCode'`）
- Modify: `packages/ui/src/composables/useOtpCodes.ts`（四分支替换为调用）
- Test: `packages/core/test/entryCode.test.ts`（若 core 测试目录不同，沿现有目录惯例放置）

**Step 1: 写失败测试**

```ts
import { describe, expect, it } from 'vitest'
import { computeEntryCode } from '../src/otp/entryCode'
import type { OtpEntry } from '../src/model'

const base = { uuid: 'u', issuer: 'I', label: 'L', secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', algorithm: 'SHA1' as const, digits: 6 as const, period: 30, tagIds: [], order: 0, createdAt: 0 }
// RFC 6238 附录 B 参考密钥 "12345678901234567890"（ASCII）对应 base32 GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ
const T59 = 59_000 // RFC 6238 T=59 → SHA1 8 位码 94287082，6 位截取见各实现

describe('computeEntryCode', () => {
  it('totp 分发并携带剩余秒数', async () => {
    const r = await computeEntryCode({ ...base, type: 'totp' }, T59)
    expect(r.code).toMatch(/^\d{6}$/)
    expect(r.period).toBe(30)
    expect(r.remaining).toBeGreaterThan(0)
    expect(r.remaining).toBeLessThanOrEqual(30)
  })
  it('hotp 窥视当前 counter 且不推进（纯函数天然不推进）', async () => {
    const e = { ...base, type: 'hotp' as const, counter: 5 }
    const r1 = await computeEntryCode(e, T59)
    const r2 = await computeEntryCode(e, T59)
    expect(r1.code).toBe(r2.code)
    expect(r2.counter).toBe(5)
  })
  it('unknown 类型抛错', async () => {
    await expect(computeEntryCode({ ...base, type: 'unknown' as never }, T59)).rejects.toThrow()
  })
})
```

**Step 2: 跑红** — Run: `cd packages/core && pnpm vitest run test/entryCode.test.ts`，Expected: 模块不存在。

**Step 3: 实现（把 useOtpCodes 的四分支原样上提）**

```ts
import { base32Decode, hotp, steamCode, totp, yandexCode, type OtpEntry } from '../index'

export interface EntryCode {
  code: string
  /** 剩余秒数（hotp 无周期语义时取 period 字段照算，仅供展示） */
  remaining: number
  period: number
  /** hotp 专有：窥视的当前 counter（不推进） */
  counter?: number
}

/** 四类型取码统一分发（plan17 MCP 事件桥与列表 UI 共用）；secret 非法由底层抛错，调用方 catch */
export async function computeEntryCode(
  e: Pick<OtpEntry, 'type' | 'secret' | 'algorithm' | 'digits' | 'period' | 'counter' | 'pin'>,
  nowMs: number,
): Promise<EntryCode> {
  const period = e.period || 30
  const remaining = period - (Math.floor(nowMs / 1000) % period)
  if (e.type === 'steam') return { code: await steamCode(base32Decode(e.secret), nowMs), remaining, period }
  if (e.type === 'yandex') return { code: await yandexCode(e.secret, e.pin ?? '', nowMs, period, e.digits), remaining, period }
  if (e.type === 'hotp') return { code: await hotp(base32Decode(e.secret), e.counter ?? 0, { algorithm: e.algorithm, digits: e.digits }), remaining, period, counter: e.counter ?? 0 }
  return { code: await totp(base32Decode(e.secret), nowMs, { algorithm: e.algorithm, digits: e.digits, period }), remaining, period }
}
```

**Step 4: 重构 `useOtpCodes.recompute` 内四分支** 为：

```ts
const r = await computeEntryCode(e, nowMs.value)
next.set(e.uuid, { code: r.code, remaining: r.remaining, progress: r.remaining / r.period })
```

（catch 分支与 `secretCache` 保持不变——`computeEntryCode` 每次自己 decode，列表路径仍有 secretCache 性能层，二者不冲突。）

**Step 5: 跑绿 + 回归**

Run: `cd packages/core && pnpm vitest run && cd ../../packages/ui && pnpm vitest run`
Expected: core 全绿（新增 ≥3），ui 全绿（useOtpCodes 行为不变）。

**Step 6: Commit**

```bash
git add packages/core/src/otp/entryCode.ts packages/core/src/index.ts packages/core/test/entryCode.test.ts packages/ui/src/composables/useOtpCodes.ts
git commit -m "refactor(core): 抽取 computeEntryCode 四类型取码纯函数

why: MCP 事件桥与列表 UI 需要同一条取码分发路径（DRY），hotp 窥视语义随纯函数天然成立
what: entryCode.ts 上提 useOtpCodes 四分支，useOtpCodes 改为调用"
```

---

### Task 8: 前端事件桥 `mcpBridge.ts`

**Files:**
- Create: `apps/desktop/src/mcpBridge.ts`
- Test: `apps/desktop/src/mcpBridge.test.ts`

**Step 1: 写失败测试（依赖全注入，node 环境无 Tauri）**

```ts
import { describe, expect, it } from 'vitest'
import { filterAccounts, handleMcpRequest, type McpBridgeDeps } from './mcpBridge'
import type { OtpEntry } from '@totp/core'

const mkEntry = (o: Partial<OtpEntry>): OtpEntry => ({
  uuid: 'u1', type: 'totp', issuer: 'GitHub', label: 'a@x.com', secret: 'GEZDGNBVGY3TQOJQ',
  algorithm: 'SHA1', digits: 6, period: 30, tagIds: [], order: 0, createdAt: 0, ...o,
})

describe('filterAccounts', () => {
  const entries = [
    mkEntry({ uuid: '1', issuer: 'GitHub', label: 'a@x.com' }),
    mkEntry({ uuid: '2', issuer: 'GitLab', label: 'b@x.com', matchRules: [{ strategy: 'baseDomain', pattern: 'gitlab.com' }] }),
  ]
  it('文本 filter 命中 issuer/label', () => {
    expect(filterAccounts(entries, 'github', undefined).map((e) => e.uuid)).toEqual(['1'])
  })
  it('url 走 match 引擎', () => {
    expect(filterAccounts(entries, undefined, 'https://gitlab.com/u/1').map((e) => e.uuid)).toEqual(['2'])
  })
  it('filter 与 url 取交集', () => {
    expect(filterAccounts(entries, 'gitlab', 'https://gitlab.com/u/1').map((e) => e.uuid)).toEqual(['2'])
    expect(filterAccounts(entries, 'github', 'https://gitlab.com/u/1')).toEqual([])
  })
})

describe('handleMcpRequest', () => {
  const entries = [mkEntry({ uuid: '1' }), mkEntry({ uuid: '2', type: 'hotp', counter: 3 })]
  const deps = (locked: boolean): McpBridgeDeps => ({
    requireEntries: () => {
      if (locked) throw new Error('vault locked')
      return entries
    },
    tagsOf: () => ['work'],
  })
  it('锁定 → vault locked 错误', async () => {
    const r = await handleMcpRequest(deps(true), { id: 1, tool: 'list_accounts', args: {} })
    expect(r).toEqual({ ok: false, error: 'vault locked' })
  })
  it('list_accounts 输出无 secret/pin', async () => {
    const r = await handleMcpRequest(deps(false), { id: 1, tool: 'list_accounts', args: {} })
    expect(r.ok).toBe(true)
    const list = (r as { ok: true; result: { accounts: OtpEntry[] } }).result.accounts
    expect(list[0]).not.toHaveProperty('secret')
    expect(list[0].tags).toEqual(['work'])
  })
  it('get_code hotp 窥视不推进', async () => {
    const r = await handleMcpRequest(deps(false), { id: 2, tool: 'get_code', args: { account_id: '2' } })
    expect(r.ok).toBe(true)
    const out = (r as { result: { code: string; counter: number; note?: string } }).result
    expect(out.counter).toBe(3)
    expect(out.note).toContain('not advanced')
  })
  it('未知 account_id → 错误附提示', async () => {
    const r = await handleMcpRequest(deps(false), { id: 3, tool: 'get_code', args: { account_id: 'nope' } })
    expect(r.ok).toBe(false)
    expect((r as { error: string }).error).toContain('list_accounts')
  })
  it('未知 tool → 错误', async () => {
    const r = await handleMcpRequest(deps(false), { id: 4, tool: 'delete_all', args: {} })
    expect(r.ok).toBe(false)
  })
})
```

**Step 2: 跑红** — Run: `cd apps/desktop && pnpm vitest run src/mcpBridge.test.ts`，Expected: 模块不存在。

**Step 3: 实现**

```ts
import { entryMatchesUrl, type OtpEntry } from '@totp/core'
import { computeEntryCode } from '@totp/core'

/** 响应载荷（mcp_respond 契约，与 Rust BridgeShared 对齐） */
export type McpResult = { ok: true; result: unknown } | { ok: false; error: string }

export interface McpBridgeDeps {
  /** 解锁则返回当前条目；锁定/未就绪抛错（文案即 MCP 错误文案） */
  requireEntries: () => readonly OtpEntry[]
  tagsOf: (e: OtpEntry) => string[]
}

export interface McpRequestPayload {
  id: number
  tool: string
  args: { filter?: string; url?: string; account_id?: string }
}

/** list_accounts 的筛选：文本 filter（issuer/label 包含，大小写不敏感）∩ url match 引擎 */
export function filterAccounts(
  entries: readonly OtpEntry[],
  filter?: string,
  url?: string,
): OtpEntry[] {
  let list = [...entries]
  if (filter) {
    const f = filter.toLowerCase()
    list = list.filter((e) => e.issuer.toLowerCase().includes(f) || e.label.toLowerCase().includes(f))
  }
  if (url) list = list.filter((e) => entryMatchesUrl(e, url))
  return list
}

function toPublic(e: OtpEntry, tagsOf: (e: OtpEntry) => string[]) {
  return { id: e.uuid, issuer: e.issuer, label: e.label, type: e.type, tags: tagsOf(e) }
}

/** 事件桥请求处理（纯逻辑，可测）；错误文案直接到达 AI 模型，保持可执行性 */
export async function handleMcpRequest(deps: McpBridgeDeps, payload: McpRequestPayload): Promise<McpResult> {
  try {
    if (payload.tool === 'list_accounts') {
      const accounts = filterAccounts(deps.requireEntries(), payload.args.filter, payload.args.url)
        .map((e) => toPublic(e, deps.tagsOf))
      return { ok: true, result: { accounts } }
    }
    if (payload.tool === 'get_code') {
      const id = payload.args.account_id
      if (!id) return { ok: false, error: 'account_id is required' }
      const e = deps.requireEntries().find((x) => x.uuid === id)
      if (!e) return { ok: false, error: `unknown account_id: ${id}; call list_accounts first` }
      const r = await computeEntryCode(e, Date.now())
      if (e.type === 'hotp') {
        return { ok: true, result: { code: r.code, counter: r.counter, note: 'HOTP counter was peeked, not advanced' } }
      }
      return { ok: true, result: { code: r.code, expires_in_seconds: r.remaining, period: r.period } }
    }
    return { ok: false, error: `unknown tool: ${payload.tool}` }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** 装配（App.vue 专用）：listen 注入便于未来扩展；返回卸载函数 */
export async function startMcpBridge(
  deps: McpBridgeDeps,
  io: { listen: (event: string, cb: (e: { payload: McpRequestPayload }) => void) => Promise<() => void>; invoke: (cmd: string, args: unknown) => Promise<void> },
): Promise<() => void> {
  const unlisten = await io.listen('mcp://req', (e) => {
    void handleMcpRequest(deps, e.payload).then((r) =>
      io.invoke('mcp_respond', {
        id: e.payload.id,
        ok: r.ok,
        result: r.ok ? r.result : null,
        error: r.ok ? null : r.error,
      }),
    )
  })
  return unlisten
}
```

> 注：`tagsOf` 在 App.vue 装配处实现为 `(e) => e.tagIds.map((id) => store.vault.tags.find((t) => t.id === id)?.name).filter(Boolean)`；`requireEntries` 实现：`store.locked.value` 或 store 未就绪时 `throw new Error('vault locked')`，否则返回 `store.vault.entries`。

**Step 4: 跑绿**

Run: `cd apps/desktop && pnpm vitest run`
Expected: 新增 8 用例 + 既有 desktop 测试全绿。

**Step 5: Commit**

```bash
git add apps/desktop/src/mcpBridge.ts apps/desktop/src/mcpBridge.test.ts
git commit -m "feat(desktop): MCP 事件桥前端处理器

why: Rust 侧工具调用需要前端按解锁态/账户完成筛选与取码
what: mcpBridge（filter/url 交集筛选 + 四类型取码分发 + 无 secret 输出契约），依赖全注入可 node 测"
```

---

### Task 9: `McpPlatform` 接口 + 设置卡片 + i18n（packages/ui）

**Files:**
- Create: `packages/ui/src/components/McpServerCard.vue`
- Modify: `packages/ui/src/pages/SettingsPage.vue`（新增可选 prop `mcpPlatform`，`showDesktop && mcpPlatform` 时渲染卡片）
- Modify: `packages/ui/src/index.ts`（导出类型与组件）
- Modify: `packages/ui/src/i18n/locales/{zh,en}/common.json`（`mcpServer.*` 命名空间）
- Test: `packages/ui/src/components/__tests__/` 若无组件测试惯例则改为纯逻辑抽出的 `mcpCard.ts` + 同目录 test（沿 `entryForm.ts` 先例：逻辑抽 `.ts`，`.vue` 薄壳）

**Step 1: 定义平台接口（`packages/ui/src/components/mcpCard.ts` + 失败测试）**

```ts
/** MCP 配置（与 Rust McpConfig 契约对齐，camelCase） */
export interface McpConfigDto {
  enabled: boolean
  mode: 'token' | 'wildcard' | 'exact' | 'alwaysAsk'
  port: number
  token: string
  whitelist: string[]
}

export interface McpPlatform {
  getConfig: () => Promise<McpConfigDto>
  setConfig: (cfg: McpConfigDto) => Promise<void>
  regenerateToken: () => Promise<string>
}

export const MCP_MODE_OPTIONS: ReadonlyArray<{ value: McpConfigDto['mode']; key: string }> = [
  { value: 'token', key: 'mcpServer.modeToken' },
  { value: 'wildcard', key: 'mcpServer.modeWildcard' },
  { value: 'exact', key: 'mcpServer.modeExact' },
  { value: 'alwaysAsk', key: 'mcpServer.modeAlwaysAsk' },
]

/** 客户端连接片段：给 AI 客户端配置文件粘贴用（token 运行时拼接，不含 token 明文——卡片上另行复制） */
export function connectionSnippet(cfg: Pick<McpConfigDto, 'port'>): string {
  return JSON.stringify({ mcpServers: { totp: { url: `http://127.0.0.1:${cfg.port}/mcp`, headers: { Authorization: 'Bearer <MCP token>' } } } }, null, 2)
}
```

测试 `mcpCard.test.ts`：断言 `connectionSnippet` 输出含 `http://127.0.0.1:47215/mcp` 与 `Bearer <MCP token>`；`MCP_MODE_OPTIONS` 四项齐。写测试 → 跑红 → 实现 → 跑绿。

**Step 2: `McpServerCard.vue`（薄壳，Md 组件）**

结构（沿用 BackupCard 的 md 组件用法，不逐行给模板——以 `packages/ui/src/components/BackupCard.vue` 现有排版为准）：

- `MdSwitch`：启用（v-model → setConfig({...cfg, enabled})）
- `MdSelect`：授权档位（`MCP_MODE_OPTIONS`，i18n label）
- 白名单：文本输入 + 添加按钮（`MdTextField`+`MdButton`），每条 pattern 行删除按钮
- 端口：数字输入（`MdTextField type=number`），失焦校验 1024-65535
- Token 区：掩码显示（`show` 切换）、复制按钮、`重新生成` 按钮（`regenerateToken` 后刷新本地 cfg）
- 连接片段：只读文本 + 复制按钮
- 错误横幅：任何 invoke 失败展示 message

props：`{ platform: McpPlatform }`；onMounted 拉 `getConfig`；所有写操作 try/catch 置 `error`。

**Step 3: SettingsPage 接线 + i18n**

- `SettingsPage.vue` props 增加 `mcpPlatform?: McpPlatform | null`（默认 null）；模板在 `showDesktop` 区块内 `v-if="mcpPlatform"` 渲染 `<McpServerCard :platform="mcpPlatform" />`。
- `NavigationShell.vue` 的 `case 'settings'` pageProps 透传：新增 shell prop `mcpPlatform?: McpPlatform | null` 并塞进 settings 页 props（沿 `securityPlatform` 同款）。
- `locales/zh/common.json` 增加：

```json
"mcpServer": {
  "title": "MCP 服务器",
  "enable": "启用 MCP 服务器",
  "enableHint": "允许 AI 客户端在本机 127.0.0.1 通过 MCP 读取验证码；金库锁定时不可用，绝不暴露密钥原文。",
  "mode": "客户端授权档位",
  "modeToken": "仅 Token（任何持令牌客户端可用）",
  "modeWildcard": "白名单通配符（推荐）",
  "modeExact": "白名单精确匹配",
  "modeAlwaysAsk": "每次连接人工确认",
  "whitelist": "客户端白名单",
  "whitelistHint": "匹配客户端名（如 Claude*），不含版本号；仅通配符/精确两档生效。",
  "add": "添加",
  "port": "端口",
  "token": "连接 Token",
  "tokenShow": "显示",
  "tokenHide": "隐藏",
  "tokenCopy": "复制 Token",
  "regenerate": "重新生成",
  "regenConfirm": "重新生成会使现有客户端连接失效，确定？",
  "snippet": "客户端连接配置（JSON）",
  "snippetCopy": "复制配置",
  "copied": "已复制",
  "error": "操作失败"
}
```

`en/common.json` 同键英文（自行翻译，勿留中文）。

**Step 4: 跑绿 + typecheck**

Run: `cd packages/ui && pnpm vitest run && pnpm typecheck`
Expected: 全绿。

**Step 5: Commit**

```bash
git add packages/ui/src/components/McpServerCard.vue packages/ui/src/components/mcpCard.ts packages/ui/src/components/mcpCard.test.ts packages/ui/src/pages/SettingsPage.vue packages/ui/src/pages/NavigationShell.vue packages/ui/src/index.ts packages/ui/src/i18n/locales/zh/common.json packages/ui/src/i18n/locales/en/common.json
git commit -m "feat(ui): MCP 设置卡片与平台接口

why: 桌面专属 MCP 配置需要设置页入口；扩展宿主传 null platform 自动隐藏
what: McpPlatform 接口 + McpServerCard（开关/四档/白名单/端口/token/连接片段）+ i18n zh/en"
```

---

### Task 10: App.vue 装配（bridge + platform 适配器 + 审批对话框）

**Files:**
- Modify: `apps/desktop/src/App.vue`
- Create: `apps/desktop/src/McpConsentDialog.vue`（薄壳 MdDialog，三按钮）

**Step 1: mcpBridge 装配**

App.vue `<script setup>` 增加（沿现有 onMounted/onScopeDispose 惯例）：

```ts
import { startMcpBridge, type McpBridgeDeps } from './mcpBridge'
import { listen } from '@tauri-apps/api/event'
import { invoke as tauriInvoke } from '@tauri-apps/api/core'

const mcpDeps: McpBridgeDeps = {
  requireEntries: () => {
    const s = store.value
    if (!s || s.locked.value) throw new Error('vault locked')
    return s.vault.entries
  },
  tagsOf: (e) => {
    const tags = store.value?.vault.tags ?? []
    return e.tagIds.map((id) => tags.find((t) => t.id === id)?.name).filter((n): n is string => !!n)
  },
}
let mcpStop: (() => void) | null = null
// store 就绪后启动（mountI18n 同位置）；主窗口专用——mini 入口（MiniApp.vue）不装配
```

onMounted 里 store 就绪后：`mcpStop = await startMcpBridge(mcpDeps, { listen, invoke: (c, a) => tauriInvoke(c, a as never) })`；`onScopeDispose(() => mcpStop?.())`。

**Step 2: McpPlatform 适配器 + 审批对话框**

```ts
const mcpPlatform: McpPlatform = {
  getConfig: () => tauriInvoke('mcp_get_config') as Promise<McpConfigDto>,
  setConfig: (cfg) => tauriInvoke('mcp_set_config', { cfg }) as Promise<void>,
  regenerateToken: () => tauriInvoke('mcp_regenerate_token') as Promise<string>,
}
```

审批：`onMounted` 里 `listen<{ ident: string; tool: string }>('mcp://approval', (e) => { approval.value = e.payload })`；模板锁定区外渲染 `<McpConsentDialog v-if="approval" ... />`（MdDialog：标题「MCP 客户端请求访问」，正文 ident + tool + 恒显提示「金库解锁期间该客户端可读取验证码；绝不暴露密钥原文」；三按钮 拒绝/仅本次/加入白名单 → `tauriInvoke('mcp_approval_response', { ident, action })` 后清 `approval`）。锁定态下照样可弹（tool 调用随后因 locked 报错，属预期语义）。

NavigationShell 传参：`:mcp-platform="mcpPlatform"`。

**Step 3: 验证**

Run: `cd apps/desktop && pnpm typecheck && pnpm vitest run && cd ../.. && pnpm -r typecheck`
Expected: 全绿。

**Step 4: Commit**

```bash
git add apps/desktop/src/App.vue apps/desktop/src/McpConsentDialog.vue
git commit -m "feat(desktop): MCP 事件桥装配与首连审批对话框

why: 前端取码与审批交互需要宿主装配；mini 窗口不暴露 MCP
what: startMcpBridge 接线 + McpPlatform 适配器 + mcp://approval 三键对话框（拒绝/仅本次/加白）"
```

---

### Task 11: E2E 脚本 + 手动验收清单

**Files:**
- Create: `scripts/mcp-e2e.mjs`

**Step 1: 脚本（裸 fetch 走 JSON 回复模式，零新依赖）**

```js
#!/usr/bin/env node
/** plan17 MCP E2E：对运行中的 desktop 应用验证 initialize → tools/list → tools/call。
 *  用法：先在设置页启用 MCP（token 从设置页复制），然后
 *  node scripts/mcp-e2e.mjs <token> [port=47215]
 *  断言：未带 token 401；带 token initialize 得 serverInfo=totp-desktop；
 *  tools/list 恰含 list_accounts/get_code；get_code(不存在 id) 报 unknown account_id。 */
const [token, port = '47215'] = process.argv.slice(2)
if (!token) { console.error('usage: node scripts/mcp-e2e.mjs <token> [port]'); process.exit(1) }
const base = `http://127.0.0.1:${port}/mcp`
const post = async (body, withAuth = true) => {
  const res = await fetch(base, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      ...(withAuth ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}
let fail = 0
const check = (name, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${name}`); if (!cond) fail++ }

const noAuth = await post({ jsonrpc: '2.0', id: 0, method: 'tools/list' }, false)
check('missing token → 401', noAuth.status === 401)

const init = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'mcp-e2e', version: '0.0.1' } } })
const serverInfo = init.json?.result?.serverInfo
check('initialize → serverInfo.name=totp-desktop', serverInfo?.name === 'totp-desktop')

const tools = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
const names = (tools.json?.result?.tools ?? []).map((t) => t.name).sort()
check('tools == [get_code, list_accounts]', JSON.stringify(names) === JSON.stringify(['get_code', 'list_accounts']))

const unknown = await post({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_code', arguments: { account_id: 'nonexistent' } } })
check('unknown account_id → isError/文案', JSON.stringify(unknown.json)).includes('unknown account_id') && check('unknown account_id 文案', true)

process.exit(fail ? 1 : 0)
```

> 实施注记：Streamable HTTP 的 tools/call 在 `with_json_response(true)` 下回纯 JSON；若实际回 SSE（`text/event-stream`），脚本补 `data:` 行解析。tools/call 的错误形态（`isError: true` + content 文案 vs JSON-RPC error）以实际为准——断言放宽为「响应中含 unknown account_id 字样」，先跑通再收紧。

**Step 2: 手动验收清单（写入本计划，验收时逐项勾）**

1. `pnpm tauri build`（或 `tauri dev`）启动应用 → 设置页出现「MCP 服务器」卡片，默认关闭。
2. 启用 → token 自动生成；`node scripts/mcp-e2e.mjs <token>` 全 PASS。
3. 金库锁定（重启或手动锁）→ `get_code` 返回 vault locked；解锁后恢复。
4. wildcard 档 + 白名单空 → e2e（clientInfo name=mcp-e2e）触发应用内审批弹窗；「仅本次」后 15 分钟内不再弹；「加入白名单」后 settings.json 的 `mcp.whitelist` 出现 `mcp-e2e`。
5. `alwaysAsk` 档 → 每过 once-TTL 再调即弹窗。
6. `list_accounts(url=https://github.com/x)` 只返回带匹配规则的 GitHub 条目。
7. 输出契约：工具结果里无 `secret`/`pin` 字样（e2e 顺手断言 list 全量字段）。
8. ZCode 真连一次（连接片段粘贴进配置）→ agent 成功取到一条真实验证码（终验收）。

**Step 3: Commit**

```bash
git add scripts/mcp-e2e.mjs
git commit -m "test(mcp): E2E 脚本与手动验收清单

why: 协议链路（鉴权/初始化/工具发现/调用）需要真实 HTTP 客户端验证
what: scripts/mcp-e2e.mjs 裸 fetch 四断言 + 8 项真机清单（含 ZCode 真连终验）"
```

---

### Task 12: 全量回归 + 构建验证

**Step 1: 全仓测试与类型检查**

Run: `pnpm -r test && pnpm -r typecheck && cd apps/desktop/src-tauri && cargo test`
Expected: 四包 vitest 全绿 + vue-tsc/tsc 全绿 + cargo 全绿（含新增 mcp_server 测试）。

**Step 2: 桌面构建**

Run: `cd apps/desktop && pnpm tauri build`
Expected: 增量编译通过，产物 `src-tauri/target/release/totp-desktop.exe` 正常启动。

**Step 3: 文档收尾**

- 设计文档 `docs/plans/2026-09-21-mcp-server-design.md` 状态行追加「已实施（plan17）」。
- README 若有功能列表，追加 MCP 一行（简述 + 安全边界）。

**Step 4: Commit**

```bash
git add -A -- docs/plans/2026-09-21-mcp-server-design.md README.md
git commit -m "docs(plan): plan17 实施收尾

why: 设计状态与用户文档同步实施结果
what: 设计文档标记已实施；README 增补 MCP 功能与安全边界说明"
```

---

## 风险与实施注意（评审附录）

1. **rmcp 版本漂移**：本计划 API 事实核查基于 2026-09-21 main 分支；若 crates.io 3.4.0 与之有出入（宏参数名、`Implementation` 字段、`with_json_response` 缺失），以编译器/文档为准局部调整，**安全语义（恒时比较、loopback 校验、fail-closed）不可让步**。
2. **SSE vs JSON**：`with_json_response(true)` 若未生效，E2E 脚本与 ZCode 连接都走 SSE——rmcp 客户端兼容，脚本需解析 SSE；先按 Task 11 注记处理。
3. **多窗口**：事件桥固定 emit 到 `main` 窗口；`mini` 窗口不装配 bridge。（已核实 `tauri.conf.json`：主窗口 label=`main`，mini=`mini`。）
4. **token 明文位置**：token 存 settings.json 明文（与既有 shortcut/凭据同域，设备侧风险面一致）；设置卡片默认掩码显示。
5. **alwaysAsk 语义**：实现为「once 批准 15 分钟 TTL」，等价于「会话级确认」，比逐调用弹窗可预期（防弹窗轰炸），已在设计文档 §3 记录。
6. **真机验证缺口**（继承项目惯例）：Windows 真机的托盘隐藏态下 MCP 取码（webview 存活性）、防火墙首次监听提示（127.0.0.1 通常不触发）需人工过一遍。
