//! plan17：内嵌 MCP 服务器（只读验证码）。协议/鉴权在 rmcp 侧，金库数据经事件桥留在前端。
//! 设计：docs/plans/2026-09-21-mcp-server-design.md
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tokio::sync::oneshot;

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

pub fn load_mcp_config_inner(settings_file: &std::path::Path) -> McpConfig {
    // 与 read_shortcut_from_settings 同口径：读不到/解析失败一律默认（默认=关闭，安全侧）
    let Ok(text) = std::fs::read_to_string(settings_file) else { return McpConfig::default() };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else { return McpConfig::default() };
    v.get("mcp").map(|m| serde_json::from_value::<McpConfig>(m.clone()).unwrap_or_default()).unwrap_or_default()
}

/// 合并写：只动 `mcp` 键，外来键（shortcutToggleMini 等）原样保留。
/// 参数为 settings.json 文件路径本身（测试注入临时文件即可全链路验证）
pub fn save_mcp_config_inner(settings_file: &std::path::Path, cfg: &McpConfig) -> Result<(), String> {
    if let Some(parent) = settings_file.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut obj: serde_json::Map<String, serde_json::Value> = std::fs::read_to_string(settings_file)
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default();
    obj.insert("mcp".into(), serde_json::to_value(cfg).map_err(|e| e.to_string())?);
    std::fs::write(settings_file, serde_json::to_string_pretty(&obj).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}

pub fn add_whitelist_inner(settings_file: &std::path::Path, cfg: &mut McpConfig, pattern: &str) -> Result<(), String> {
    // 去重比较大小写不敏感：与 wildcard 匹配口径一致，避免 claude*/Claude* 积累两条等价条目；
    // 命中去重直接返回，不重写文件
    if cfg.whitelist.iter().any(|w| w.eq_ignore_ascii_case(pattern)) {
        return Ok(());
    }
    cfg.whitelist.push(pattern.to_string());
    save_mcp_config_inner(settings_file, cfg)
}

/// 大小写不敏感通配符匹配：仅支持 `*`（任意长度），无 `?`——白名单语义保持可预期。
/// 迭代式双指针单回溯点贪心匹配（星号只记最后一个，失配回退重试）：
/// O(p*s) 时间 O(1) 空间，无递归栈，规避病态模式的深递归/指数回溯。
pub fn wildcard_match(pattern: &str, name: &str) -> bool {
    // 防御性长度守卫：pattern 来自本机用户白名单而非攻击者输入，>256B 视为配置错误直接不匹配
    if pattern.len() > 256 {
        return false;
    }
    let (p, s) = (pattern.as_bytes(), name.as_bytes());
    let (mut pi, mut si) = (0usize, 0usize);
    // star=最后遇到的 `*` 下标（usize::MAX=尚无），ss=回退时该 `*` 已吞入的名字起点
    let (mut star, mut ss) = (usize::MAX, 0usize);
    while si < s.len() {
        if pi < p.len() && (p[pi] == b'*' || p[pi].eq_ignore_ascii_case(&s[si])) {
            if p[pi] == b'*' {
                star = pi;
                ss = si;
                pi += 1;
            } else {
                pi += 1;
                si += 1;
            }
        } else if star != usize::MAX {
            // 失配：回到最近的 `*`，让它多吞一个字符再试
            pi = star + 1;
            ss += 1;
            si = ss;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == b'*' {
        pi += 1;
    }
    pi == p.len()
}

/// 门控判定结果：Allow=放行；NeedsApproval=触发审批事件 + 本次调用回 pending 错误
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GateDecision {
    Allow,
    /// 触发审批事件 + 本次调用回 pending 错误
    NeedsApproval,
}

/// 一次性门控判定（纯函数）。once-TTL 记账不在此处（见 GateSessions，Task 6）。
pub fn decide_gate(cfg: &McpConfig, client_name: Option<&str>) -> GateDecision {
    use GateMode::*;
    match cfg.mode {
        Token => GateDecision::Allow,
        Wildcard | Exact => {
            // 身份缺失 fail-closed：clientInfo 与 UA 全无时除 token 档外一律待批准
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

/// getrandom 已在依赖树（tauri 传递）；base64url 手写避免引 base64 crate
pub fn generate_token() -> String {
    let mut buf = [0u8; 32];
    getrandom::fill(&mut buf).expect("CSPRNG 不可用属致命环境错误");
    base64url_nopad(&buf)
}

/// 手写 base64url 无填充编码：bit 迭代法，字节流按 6bit 查表输出；
/// 余位（len*8 % 6 != 0 时）左移补零出末字符。已知答案见 tests::base64url_nopad_known_answers
fn base64url_nopad(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity(bytes.len().div_ceil(6) * 4);
    let mut acc: u32 = 0;
    let mut bits: u32 = 0;
    for &b in bytes {
        acc = (acc << 8) | b as u32;
        bits += 8;
        while bits >= 6 {
            bits -= 6;
            let idx = ((acc >> bits) & 0x3f) as usize;
            out.push(TABLE[idx] as char);
        }
    }
    if bits > 0 {
        let idx = ((acc << (6 - bits)) & 0x3f) as usize;
        out.push(TABLE[idx] as char);
    }
    out
}

/// 前端回传通道共享表：id → oneshot。事件桥的核心数据结构
#[derive(Debug, Default)]
pub struct BridgeShared {
    pending: Mutex<HashMap<u64, oneshot::Sender<Result<serde_json::Value, String>>>>,
    next_id: std::sync::atomic::AtomicU64,
}

impl BridgeShared {
    pub fn alloc_id(&self) -> u64 {
        self.next_id.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    }
    pub fn insert(&self, id: u64, tx: oneshot::Sender<Result<serde_json::Value, String>>) {
        if let Ok(mut p) = self.pending.lock() {
            p.insert(id, tx);
        }
    }
    pub fn take(&self, id: u64) -> Option<oneshot::Sender<Result<serde_json::Value, String>>> {
        self.pending.lock().ok()?.remove(&id)
    }
    /// 前端迟到回传（超时后）静默丢弃，返回 Err 供命令层忽略
    pub fn respond(&self, id: u64, result: Result<serde_json::Value, String>) -> Result<(), String> {
        self.take(id)
            .ok_or_else(|| "unknown id".to_string())?
            .send(result)
            .map_err(|_| "receiver dropped".to_string())
    }
}

/// 工具调用 → webview 事件 → 前端回传，全程 5 秒超时。
/// （window 参数：目标 webview 窗口 label，主窗口恒 "main"。Task 6 由 rmcp tool handler 调用。）
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
        .map_err(|e| { bridge.take(id); format!("emit failed: {e}") })?;
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

/// Host 必须是 loopback（DNS rebinding 防护）；Origin 出现时必须是 http loopback 同机（不比端口）
pub fn validate_host_origin(host: Option<&str>, origin: Option<&str>) -> Result<(), &'static str> {
    fn is_loopback_host(h: &str) -> bool {
        // 去端口：取 ':' 前的主机段；IPv6 字面量（"::1"）解析为空串直接不匹配——
        // 本服务仅绑 127.0.0.1，IPv6 fail-closed。
        // localhost 比较大小写不敏感：兼容非规范化客户端（127.0.0.1 本就无大小写）
        let host = h.split(':').next().unwrap_or(h);
        host == "127.0.0.1" || host.eq_ignore_ascii_case("localhost")
    }
    let Some(h) = host else { return Err("missing host") };
    if !is_loopback_host(h) {
        return Err("host not loopback");
    }
    if let Some(o) = origin {
        let after = o.strip_prefix("http://").ok_or("origin not http")?;
        if !is_loopback_host(after) {
            return Err("origin not loopback");
        }
    }
    Ok(())
}

/// 恒时比较（长度差立即短路可接受：token 定长 43，长度本身不泄密）。
/// 空串永不匹配：空 token =「未生成」，未生成的凭据不与任何输入相等（fail-closed）
pub fn token_eq(a: &str, b: &str) -> bool {
    if a.is_empty() || a.len() != b.len() {
        return false;
    }
    a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// 审批态记账：once = 「仅本次」（15 分钟 TTL）；deny 后短窗冷却防弹窗轰炸。
/// 内存态，不落盘——重启即清，与「批准不跨进程生命周期」的安全预期一致
#[derive(Debug, Default)]
pub struct GateSessions {
    once: Mutex<HashMap<String, Instant>>,
    cooldown: Mutex<HashMap<String, Instant>>,
}
pub const ONCE_TTL: Duration = Duration::from_secs(15 * 60);
pub const DENY_COOLDOWN: Duration = Duration::from_secs(60);

impl GateSessions {
    pub fn grant_once(&self, ident: String) {
        if let Ok(mut m) = self.once.lock() {
            m.insert(ident, Instant::now());
        }
    }
    pub fn once_valid(&self, ident: &str) -> bool {
        let entry = self.once.lock().ok().and_then(|m| m.get(ident).copied());
        match entry {
            Some(t) if t.elapsed() < ONCE_TTL => true,
            // 命中过期条目即回收：进程生命周期内存有界（每 ident 至多一条，过期即删）
            Some(_) => {
                if let Ok(mut m) = self.once.lock() {
                    m.remove(ident);
                }
                false
            }
            None => false,
        }
    }
    pub fn mark_denied(&self, ident: &str) {
        if let Ok(mut m) = self.cooldown.lock() {
            m.insert(ident.to_string(), Instant::now());
        }
    }
    pub fn denied_recently(&self, ident: &str) -> bool {
        let entry = self.cooldown.lock().ok().and_then(|m| m.get(ident).copied());
        match entry {
            Some(t) if t.elapsed() < DENY_COOLDOWN => true,
            // 同 once：过期冷却条目即回收，内存有界
            Some(_) => {
                if let Ok(mut m) = self.cooldown.lock() {
                    m.remove(ident);
                }
                false
            }
            None => false,
        }
    }
    #[cfg(test)]
    pub fn expire_all_for_test(&mut self) {
        if let Ok(mut m) = self.once.lock() {
            m.clear();
        }
    }
}

// ==== Task 6b：rmcp 服务本体 ====
// 协议合规交给官方 SDK（StreamableHttpService 为 Tower service），传输防护（Bearer 恒时
// 比较 + loopback Host/Origin 校验）在挂载层中间件落地；金库数据经事件桥留在前端。

use rmcp::handler::server::wrapper::Parameters;
// 引入顶层 `schemars` 名：JsonSchema derive 展开的代码引用裸 `schemars::` 路径
use rmcp::model::{CallToolResult, ContentBlock, Implementation, ServerCapabilities, ServerConfig};
use rmcp::schemars;
use rmcp::service::{RequestContext, RoleServer};
use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
use rmcp::transport::streamable_http_server::{StreamableHttpServerConfig, StreamableHttpService};
use rmcp::{ErrorData as McpError, ServerHandler, tool, tool_handler, tool_router};
use tauri::{AppHandle, State};

/// MCP 服务端对象。工厂每请求构造一次，字段均为轻量 Clone 句柄
#[derive(Debug, Clone)]
pub struct TotpMcp {
    app: AppHandle,
    bridge: std::sync::Arc<BridgeShared>,
    sessions: std::sync::Arc<GateSessions>,
    /// settings.json 文件路径（Task 2 语义），每请求重读配置使设置页改动即时生效
    cfg_file: std::path::PathBuf,
}

/// 恒定身份串：clientInfo.name 优先，回落 UA，再回落 <unknown>（fail-closed）。
/// 门控匹配（wildcard/exact）与 once/deny 记账全部作用在此串上
fn identity_of(context: &RequestContext<RoleServer>) -> String {
    if let Some(ci) = context.client_info() {
        return ci.name;
    }
    if let Some(parts) = context.extensions.get::<http::request::Parts>() {
        if let Some(ua) = parts.headers.get(http::header::USER_AGENT).and_then(|v| v.to_str().ok()) {
            return ua.to_string();
        }
    }
    "<unknown>".into()
}

impl TotpMcp {
    pub fn new(
        app: AppHandle,
        bridge: std::sync::Arc<BridgeShared>,
        sessions: std::sync::Arc<GateSessions>,
        cfg_file: std::path::PathBuf,
    ) -> Self {
        Self { app, bridge, sessions, cfg_file }
    }

    /// 门控 + 事件桥转发（两个工具共用）：
    /// 配置每请求重读 → decide_gate → once/denied 分支 → 审批事件或 bridge_call
    async fn gated_call(
        &self,
        context: &RequestContext<RoleServer>,
        tool: &str,
        args: serde_json::Value,
    ) -> Result<serde_json::Value, McpError> {
        // 配置每请求重读：覆盖 enabled/档位/白名单，设置页改动即时生效；
        // token/端口变更经 restart_if_needed 重启生效（bearer 快照与端口绑定在 serve_forever 启动时定型，6c 落地）
        let cfg = load_mcp_config_inner(&self.cfg_file);
        if !cfg.enabled {
            return Err(McpError::invalid_params("mcp disabled", None));
        }
        let ident = identity_of(context);
        match decide_gate(&cfg, Some(&ident)) {
            GateDecision::Allow => {}
            // NeedsApproval 分支序：once 批准期内放行 → deny 冷却期拒绝 → 首次弹审批事件
            GateDecision::NeedsApproval if self.sessions.once_valid(&ident) => {}
            GateDecision::NeedsApproval if self.sessions.denied_recently(&ident) => {
                return Err(McpError::invalid_params(
                    "approval denied; try again in about a minute to trigger a new approval dialog",
                    None,
                ));
            }
            GateDecision::NeedsApproval => {
                use tauri::Emitter;
                self.app
                    .emit_to("main", "mcp://approval", serde_json::json!({ "ident": ident, "tool": tool }))
                    .map_err(|e| McpError::invalid_params(format!("approval dialog unavailable: {e}"), None))?;
                // fail-closed：本次调用不执行，等用户批准后客户端重试
                return Err(McpError::invalid_params(
                    "approval pending: the user must approve this client in the TOTP app",
                    None,
                ));
            }
        }
        bridge_call(&self.app, &self.bridge, "main", tool, args)
            .await
            .map_err(|e| McpError::invalid_params(e, None))
    }
}

#[derive(Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub struct ListAccountsParams {
    #[schemars(description = "Optional case-insensitive substring filter over issuer and label")]
    pub filter: Option<String>,
    #[schemars(description = "Optional page URL; returns entries whose match rules match it")]
    pub url: Option<String>,
}

#[derive(Debug, serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
pub struct GetCodeParams {
    #[schemars(description = "Account id as returned by list_accounts")]
    pub account_id: String,
}

#[tool_router]
impl TotpMcp {
    #[tool(description = "List TOTP accounts (id, issuer, label, type, tags). Never returns secrets.")]
    async fn list_accounts(
        &self,
        Parameters(p): Parameters<ListAccountsParams>,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, McpError> {
        let args = serde_json::to_value(&p).map_err(|e| McpError::invalid_params(e.to_string(), None))?;
        let result = self.gated_call(&context, "list_accounts", args).await?;
        Ok(CallToolResult::success(vec![ContentBlock::text(result.to_string())]))
    }

    #[tool(description = "Get the current one-time code for an account. HOTP counter is peeked, not advanced.")]
    async fn get_code(
        &self,
        Parameters(p): Parameters<GetCodeParams>,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResult, McpError> {
        let args = serde_json::to_value(&p).map_err(|e| McpError::invalid_params(e.to_string(), None))?;
        let result = self.gated_call(&context, "get_code", args).await?;
        Ok(CallToolResult::success(vec![ContentBlock::text(result.to_string())]))
    }
}

#[tool_handler]
impl ServerHandler for TotpMcp {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new("totp-desktop", env!("CARGO_PKG_VERSION")))
    }
}

/// Bearer + Host/Origin 校验中间件（每请求）：validate_host_origin 防 DNS rebinding，
/// token_eq 恒时比较防时序侧信道。403=非 loopback 语境；401=凭据缺失/不匹配
async fn mcp_auth_middleware(
    bearer: std::sync::Arc<String>,
    req: http::Request<axum::body::Body>,
    next: axum::middleware::Next,
) -> axum::response::Response {
    use axum::response::IntoResponse;
    let host = req.headers().get(http::header::HOST).and_then(|v| v.to_str().ok());
    let origin = req.headers().get(http::header::ORIGIN).and_then(|v| v.to_str().ok());
    if validate_host_origin(host, origin).is_err() {
        return axum::http::StatusCode::FORBIDDEN.into_response();
    }
    let auth_ok = req
        .headers()
        .get(http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|a| token_eq(a, bearer.as_str()));
    if !auth_ok {
        return axum::http::StatusCode::UNAUTHORIZED.into_response();
    }
    next.run(req).await
}

/// MCP 服务主循环：bind 127.0.0.1:port → Bearer/Host/Origin 中间件 → nest_service("/mcp")
/// → graceful shutdown（shutdown 通道变化即优雅停机）。
/// 配置每请求重读（cfg_file），设置页改动即时生效；port 变更由调用方（6c）重启服务
pub async fn serve_forever(
    app: AppHandle,
    bridge: std::sync::Arc<BridgeShared>,
    sessions: std::sync::Arc<GateSessions>,
    cfg: McpConfig,
    cfg_file: std::path::PathBuf,
    mut shutdown: tokio::sync::watch::Receiver<bool>,
) -> Result<(), String> {
    // fail-closed：空 token=未生成，绝不允许 "Bearer " 成为有效凭据（生成与持久化归 start_server，6c）
    if cfg.token.is_empty() {
        return Err("mcp token not generated".into());
    }
    let bearer = std::sync::Arc::new(format!("Bearer {}", cfg.token));

    // 工厂闭包：每请求构造一次 TotpMcp，句柄均先克隆再 move 进闭包
    let service: StreamableHttpService<TotpMcp, LocalSessionManager> = StreamableHttpService::new(
        move || Ok(TotpMcp::new(app.clone(), bridge.clone(), sessions.clone(), cfg_file.clone())),
        LocalSessionManager::default().into(),
        StreamableHttpServerConfig::default().with_json_response(true),
    );

    let middleware = axum::middleware::from_fn(move |req, next| {
        let bearer = bearer.clone();
        async move { mcp_auth_middleware(bearer, req, next).await }
    });

    let router = axum::Router::new().nest_service("/mcp", service).layer(middleware);
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", cfg.port))
        .await
        .map_err(|e| format!("bind 127.0.0.1:{} failed: {e}", cfg.port))?;
    axum::serve(listener, router)
        .with_graceful_shutdown(async move {
            let _ = shutdown.changed().await;
        })
        .await
        .map_err(|e| e.to_string())
}

// ==== Task 6c：Tauri 命令 + 生命周期接线 ====
// manage 进 App 的 McpState 保证 bridge/sessions 跨请求同一实例；配置写入（*_inner）与
// 运行中服务的启停在此汇合：enabled/档位/白名单每请求重读即时生效，token/端口变更重启生效。

/// 仅 enabled/port/token 变化需要重启（bearer/绑定在启动时定型）；档位/白名单每请求重读已即时生效
fn needs_restart(old: &McpConfig, new: &McpConfig) -> bool {
    old.enabled != new.enabled || old.port != new.port || old.token != new.token
}

/// manage 进 App 的全局句柄（bridge/sessions 必须跨请求同一实例）
pub struct McpState {
    pub bridge: std::sync::Arc<BridgeShared>,
    pub sessions: std::sync::Arc<GateSessions>,
    /// 运行中服务的停机通道（None=未运行）
    pub shutdown: Mutex<Option<tokio::sync::watch::Sender<bool>>>,
    /// settings.json 文件路径（load/save *_inner 直接可用）
    pub settings_file: std::path::PathBuf,
}

#[tauri::command]
pub fn mcp_get_config(state: State<'_, McpState>) -> McpConfig {
    load_mcp_config_inner(&state.settings_file)
}

#[tauri::command]
pub fn mcp_set_config(app: AppHandle, state: State<'_, McpState>, cfg: McpConfig) -> Result<(), String> {
    let old = load_mcp_config_inner(&state.settings_file);
    save_mcp_config_inner(&state.settings_file, &cfg)?;
    if needs_restart(&old, &cfg) {
        restart_if_needed(&app, &state, &cfg)?;
    }
    Ok(())
}

/// 生成新 token 并持久化。运行中服务的 bearer 是启动时快照：新 token 经下一次
/// mcp_set_config（enabled/端口变更均触发重启）或应用重启后生效
#[tauri::command]
pub fn mcp_regenerate_token(state: State<'_, McpState>) -> Result<String, String> {
    let mut cfg = load_mcp_config_inner(&state.settings_file);
    cfg.token = generate_token();
    save_mcp_config_inner(&state.settings_file, &cfg)?;
    Ok(cfg.token)
}

/// 前端审批对话框回执：deny=冷却 60s；once=15 分钟内放行；trust=写白名单并持久化
#[tauri::command]
pub fn mcp_approval_response(state: State<'_, McpState>, ident: String, action: String) -> Result<(), String> {
    match action.as_str() {
        "deny" => {
            state.sessions.mark_denied(&ident);
            Ok(())
        }
        "once" => {
            state.sessions.grant_once(ident);
            Ok(())
        }
        "trust" => {
            let mut cfg = load_mcp_config_inner(&state.settings_file);
            add_whitelist_inner(&state.settings_file, &mut cfg, &ident)
        }
        _ => Err(format!("unknown action: {action}")),
    }
}

/// 前端事件桥回传；迟到（超时后）静默忽略
#[tauri::command]
pub fn mcp_respond(state: State<'_, McpState>, id: u64, ok: bool, result: Option<serde_json::Value>, error: Option<String>) {
    let payload = if ok {
        result.ok_or_else(|| "empty result".to_string())
    } else {
        Err(error.unwrap_or_else(|| "unknown error".into()))
    };
    let _ = state.bridge.respond(id, payload);
}

/// 生命周期：enabled=false 或停不下来时只停；enabled=true 先停后起（端口/token 变更重绑）
pub fn restart_if_needed(app: &AppHandle, state: &State<'_, McpState>, cfg: &McpConfig) -> Result<(), String> {
    stop_server(state);
    if cfg.enabled { start_server(app, state, cfg) } else { Ok(()) }
}

pub fn stop_server(state: &State<'_, McpState>) {
    if let Ok(mut g) = state.shutdown.lock() {
        if let Some(tx) = g.take() {
            let _ = tx.send(true);
        }
    }
}

pub fn start_server(app: &AppHandle, state: &State<'_, McpState>, cfg: &McpConfig) -> Result<(), String> {
    let mut cfg = cfg.clone();
    if cfg.token.is_empty() {
        cfg.token = generate_token();
        save_mcp_config_inner(&state.settings_file, &cfg)?;
    }
    let (tx, rx) = tokio::sync::watch::channel(false);
    *state.shutdown.lock().map_err(|_| "lock poisoned")? = Some(tx);
    let app = app.clone();
    let bridge = state.bridge.clone();
    let sessions = state.sessions.clone();
    let settings_file = state.settings_file.clone();
    tauri::async_runtime::spawn(async move {
        let _ = serve_forever(app, bridge, sessions, cfg, settings_file, rx).await;
    });
    Ok(())
}

/// setup 阶段装配：manage 全局状态 + 按配置自动拉起。app 为 &mut App（setup 闭包入参）
pub fn init_state_and_autostart(app: &mut tauri::App) -> Result<(), String> {
    use tauri::Manager;
    let settings_file =
        app.path().app_data_dir().map_err(|e| e.to_string())?.join("settings.json");
    let state = McpState {
        bridge: Default::default(),
        sessions: Default::default(),
        shutdown: Default::default(),
        settings_file,
    };
    // manage 前读配置：避免 manage 后再借 state 的 borrow 纠缠
    let cfg = load_mcp_config_inner(&state.settings_file);
    app.manage(state);
    if cfg.enabled {
        let handle = app.handle().clone();
        let st = handle.state::<McpState>();
        start_server(&handle, &st, &cfg)?;
    }
    Ok(())
}

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

    #[test]
    fn token_shape_and_uniqueness() {
        let t1 = generate_token();
        let t2 = generate_token();
        assert_eq!(t1.len(), 43, "32B base64url 无填充 = 43 字符");
        assert!(t1.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
        assert_ne!(t1, t2);
    }

    #[test]
    fn whitelist_add_dedupes() {
        let p = tmp_path("dedupe");
        let mut cfg = load_mcp_config_inner(&p);
        add_whitelist_inner(&p, &mut cfg, "Claude*").unwrap();
        add_whitelist_inner(&p, &mut cfg, "Claude*").unwrap();
        assert_eq!(cfg.whitelist.len(), 1, "重复 add 不产生重复条目");
        add_whitelist_inner(&p, &mut cfg, "CLAUDE*").unwrap();
        assert_eq!(cfg.whitelist.len(), 1, "大小写变体视为同一条目（与 wildcard 匹配口径一致）");
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn base64url_nopad_known_answers() {
        // 期望值经 node Buffer.toString('base64url') 独立验证，防位序/查表错误
        assert_eq!(base64url_nopad(&[]), "");
        assert_eq!(base64url_nopad(&[0xfb, 0xff]), "-_8", "62='-',63='_'，URL-safe 表非标准表");
        assert_eq!(base64url_nopad(&[1, 2, 3]), "AQID", "整 3B 无余位");
    }

    #[test]
    fn wildcard_match_is_case_insensitive() {
        assert!(wildcard_match("Claude*", "claude-desktop"));
        assert!(wildcard_match("*zcode*", "ZCode CLI"));
        assert!(wildcard_match("exact-name", "exact-name"));
        assert!(!wildcard_match("claude*", "cursor"));
        assert!(wildcard_match("*", "anything"));
        assert!(!wildcard_match(&"*".repeat(257), "anything"), "超长 pattern 视为配置错误，不匹配（fail-closed）");
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
        assert!(matches!(decide_gate(&base(Exact, &["ZCode"]), Some("zcode")), GateDecision::Allow), "Exact 档大小写不敏感语义");
        assert!(matches!(decide_gate(&base(Exact, &["ZCode"]), Some("ZCode 2.0")), GateDecision::NeedsApproval));
        // 身份缺失（clientInfo 与 UA 全无）除 token 档外一律待批准
        assert!(matches!(decide_gate(&base(Wildcard, &["*"]), None), GateDecision::NeedsApproval));
        // alwaysAsk 恒待批准（once-TTL 由调用方 GateSessions 管）
        assert!(matches!(decide_gate(&base(AlwaysAsk, &[]), Some("claude")), GateDecision::NeedsApproval));
    }

    #[test]
    fn host_and_origin_validation() {
        assert!(validate_host_origin(Some("127.0.0.1:47215"), None).is_ok());
        assert!(validate_host_origin(Some("127.0.0.1:1"), None).is_ok(), "去端口解析：非标端口仍是 loopback");
        assert!(validate_host_origin(Some("localhost:47215"), None).is_ok());
        assert!(validate_host_origin(Some("evil.com"), None).is_err(), "DNS rebinding：Host 必须是 loopback");
        assert!(validate_host_origin(None, None).is_err());
        assert!(validate_host_origin(Some("127.0.0.1:47215"), Some("http://127.0.0.1:47215")).is_ok());
        assert!(validate_host_origin(Some("127.0.0.1:47215"), Some("http://evil.com")).is_err());
        // 跨端口 loopback Origin 属同机，放行（Bearer 才是主闸门）；https 语境被拒
        assert!(validate_host_origin(Some("127.0.0.1:47215"), Some("http://127.0.0.1:9999")).is_ok());
        assert!(validate_host_origin(Some("127.0.0.1:47215"), Some("https://127.0.0.1:47215")).is_err());
        assert!(validate_host_origin(Some("LOCALHOST:47215"), None).is_ok(), "localhost 比较大小写不敏感");
    }

    #[test]
    fn constant_time_token_compare() {
        assert!(token_eq("abc", "abc"));
        assert!(!token_eq("abc", "abd"));
        assert!(!token_eq("abc", "ab"));
        assert!(!token_eq("", ""));
        assert!(!token_eq("", "abc"), "空 token=未生成，不与任何输入相等");
    }

    #[test]
    fn approval_session_ttl() {
        let mut s = GateSessions::default();
        s.grant_once("claude".into());
        assert!(s.once_valid("claude"));
        s.expire_all_for_test();
        assert!(!s.once_valid("claude"), "once 授权过期后必须重新弹窗");
        s.mark_denied("claude");
        assert!(s.denied_recently("claude"), "deny 后短窗冷却为真");
        assert!(!s.denied_recently("other"), "冷却不跨 ident 泄漏");
    }

    #[test]
    fn bridge_respond_resolves_pending() {
        let bridge = BridgeShared::default();
        let (tx, mut rx) = tokio::sync::oneshot::channel::<Result<serde_json::Value, String>>();
        bridge.insert(7, tx);
        bridge.respond(7, Ok(serde_json::json!({"code": "123456"}))).expect("首次回传应成功");
        assert_eq!(rx.try_recv().unwrap().unwrap()["code"], "123456");
        assert!(bridge.respond(7, Ok(serde_json::json!({}))).is_err(), "重复回传同一 id 应报 unknown id");
    }

    #[test]
    fn restart_only_when_lifecycle_fields_change() {
        let a = McpConfig { enabled: true, mode: GateMode::Wildcard, port: 47215, token: "t1".into(), whitelist: vec!["A".into()] };
        // 白名单/档位变化：每请求重读已覆盖，无需重启
        let b = McpConfig { mode: GateMode::Exact, whitelist: vec!["B".into()], ..a.clone() };
        assert!(!needs_restart(&a, &b));
        // enabled 变化：要重启
        let c = McpConfig { enabled: false, ..a.clone() };
        assert!(needs_restart(&a, &c));
        // 端口变化：要重启
        let d = McpConfig { port: 50000, ..a.clone() };
        assert!(needs_restart(&a, &d));
        // token 变化：要重启（bearer 为启动时快照，6b 审查 Important）
        let e = McpConfig { token: "t2".into(), ..a.clone() };
        assert!(needs_restart(&a, &e));
    }
}
