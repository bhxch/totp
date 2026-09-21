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
    // 原子写（审查 I-5）：与 lib.rs 的 write_shortcut_to_settings 共用同一临时文件+rename 通道，
    // 崩溃中途不损坏 settings.json
    crate::write_text_atomic(settings_file, &serde_json::to_string_pretty(&obj).map_err(|e| e.to_string())?)
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
    /// 清空全部审批记账（once 批准 + deny 冷却）：「重置审批状态」入口。返回清空条目总数。
    /// 用户主动吊销语义：once 有效批准立即失效（客户端须重新走审批弹窗），
    /// deny 冷却一并清（主动操作无需再等 60s）；锁中毒按 0 条计（与其他方法口径一致）
    pub fn clear_all(&self) -> usize {
        let once = self.once.lock().map(|mut m| {
            let n = m.len();
            m.clear();
            n
        });
        let cooldown = self.cooldown.lock().map(|mut m| {
            let n = m.len();
            m.clear();
            n
        });
        once.unwrap_or(0) + cooldown.unwrap_or(0)
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

/// 剥 Authorization 的 auth-scheme 前缀（审查 I-9）：RFC 7235/6750 规定 scheme 大小写
/// 不敏感，前 7 字节 ASCII 不敏感比对 `bearer `；恒时比较只作用于其后的 token 值
/// （scheme 恒定，不参与恒时比较对象）
fn strip_bearer_scheme(value: &str) -> Option<&str> {
    const SCHEME: &[u8; 7] = b"bearer ";
    let bytes = value.as_bytes();
    if bytes.len() >= SCHEME.len() && bytes[..SCHEME.len()].eq_ignore_ascii_case(SCHEME) {
        // 命中即前 7 字节均为 ASCII（5 字母+空格），索引 7 必是字符边界
        value.get(SCHEME.len()..)
    } else {
        None
    }
}

/// Bearer + Host/Origin 校验中间件（每请求）：validate_host_origin 防 DNS rebinding，
/// token_eq 恒时比较防时序侧信道。403=非 loopback 语境；401=凭据缺失/不匹配
async fn mcp_auth_middleware(
    token: std::sync::Arc<String>,
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
        .and_then(strip_bearer_scheme)
        .is_some_and(|t| token_eq(t, token.as_str()));
    if !auth_ok {
        return axum::http::StatusCode::UNAUTHORIZED.into_response();
    }
    next.run(req).await
}

/// router 装配（审查 I-6）：鉴权中间件 → nest_service("/mcp")。内层 service 抽象为泛型
/// 入参，测试以 200 桩 service 经 tower::ServiceExt::oneshot 直测中间件（此前装配零覆盖，
/// 删掉 .layer(middleware) 测试依旧全绿）；生产路径传 StreamableHttpService。
/// 现有 nest_service 调用点即 axum 0.8 对内层 service 的既有约束，不新增语义
pub(crate) fn mcp_router<S>(token: std::sync::Arc<String>, inner: S) -> axum::Router
where
    S: tower::Service<http::Request<axum::body::Body>, Error = std::convert::Infallible>
        + Clone
        + Send
        + Sync
        + 'static,
    S::Response: axum::response::IntoResponse,
    S::Future: Send + 'static,
{
    let middleware = axum::middleware::from_fn(move |req, next| {
        let token = token.clone();
        async move { mcp_auth_middleware(token, req, next).await }
    });
    axum::Router::new().nest_service("/mcp", inner).layer(middleware)
}

/// MCP 服务主循环：Bearer/Host/Origin 中间件 → nest_service("/mcp") → graceful shutdown
/// （shutdown 通道变化即优雅停机）。listener 由调用方同步 bind 后传入（bind 失败直接回传
/// UI，审查 I-1），本函数只做 tokio 化转换，不再 bind。
/// cancellation_token 由调用方（start_server）创建并持有引用：stop_server cancel 它终止
/// GET SSE 长连接，graceful shutdown 才能完成（审查 I-3）。
/// 配置每请求重读（cfg_file），设置页改动即时生效；port 变更由调用方（6c）重启服务
// 第 8 参即审查 I-3 的取消令牌：比重构成参数结构体更直接，参数列表全部具名自解释
#[allow(clippy::too_many_arguments)]
pub async fn serve_forever(
    app: AppHandle,
    bridge: std::sync::Arc<BridgeShared>,
    sessions: std::sync::Arc<GateSessions>,
    cfg: McpConfig,
    cfg_file: std::path::PathBuf,
    mut shutdown: tokio::sync::watch::Receiver<bool>,
    listener: std::net::TcpListener,
    cancellation_token: tokio_util::sync::CancellationToken,
) -> Result<(), String> {
    // fail-closed：空 token=未生成，绝不允许 "Bearer " 成为有效凭据（生成入口仅两处：
    // 启动期 init_state_and_autostart、设置页保存 mcp_set_config，均先落盘再起服）
    if cfg.token.is_empty() {
        return Err("mcp token not generated".into());
    }
    let token = std::sync::Arc::new(cfg.token.clone());

    // 工厂闭包：每请求构造一次 TotpMcp，句柄均先克隆再 move 进闭包。
    // cancellation_token 接线（审查 I-3，查证 rmcp 3.4.0 源码）：StreamableHttpService 对每个
    // SSE 响应体用 config.cancellation_token 的 child token 做 take_until（sse_stream_response），
    // cancel 即终止 GET SSE 这类永不自然完成的 in-flight 响应——仅靠 watch+graceful shutdown
    // 会被 hyper 无限等待（真实客户端在线时重启/禁用/重生成 token 全部卡死）
    let cancellation = cancellation_token.clone();
    let service: StreamableHttpService<TotpMcp, LocalSessionManager> = StreamableHttpService::new(
        move || Ok(TotpMcp::new(app.clone(), bridge.clone(), sessions.clone(), cfg_file.clone())),
        LocalSessionManager::default().into(),
        StreamableHttpServerConfig::default()
            .with_json_response(true)
            .with_cancellation_token(cancellation),
    );

    let router = mcp_router(token, service);
    // std listener → tokio：须已设 nonblocking（start_server 在 spawn 前 set_nonblocking(true)）；
    // from_std 需在 tokio runtime 上下文调用，本 async fn 即在其上
    let listener = tokio::net::TcpListener::from_std(listener)
        .map_err(|e| format!("listener conversion failed: {e}"))?;
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

/// 停机槽载荷（type alias 仅为可读性）：watch 信号发送端 + rmcp 取消令牌 + serve 任务句柄
pub type ShutdownSlot = (
    tokio::sync::watch::Sender<bool>,
    tokio_util::sync::CancellationToken,
    tauri::async_runtime::JoinHandle<()>,
);

/// manage 进 App 的全局句柄（bridge/sessions 必须跨请求同一实例）
pub struct McpState {
    pub bridge: std::sync::Arc<BridgeShared>,
    pub sessions: std::sync::Arc<GateSessions>,
    /// 运行中服务的停机槽（None=未运行）。
    /// 令牌供 stop_server cancel 终止 GET SSE 长连接（审查 I-3）；句柄供 stop_server
    /// 有界等待旧任务退出（端口释放）后再重启（审查 I-2）
    pub shutdown: Mutex<Option<ShutdownSlot>>,
    /// settings.json 文件路径（load/save *_inner 直接可用）
    pub settings_file: std::path::PathBuf,
    /// 服务运行态（UI 可见，mcp_get_config 上报）：true=当前监听在位
    pub running: std::sync::atomic::AtomicBool,
    /// 最近一次启动失败/异常退出原因（中文，None=无）。autostart 失败原仅 eprintln
    /// （GUI 不可见），落在此处后设置页 enabled=true 但没起来时可对账
    pub last_error: Mutex<Option<String>>,
}

impl McpState {
    /// 吊销全部一次性审批（once 批准 + deny 冷却），返回清空条目数（UI 提示用）
    pub fn revoke_approvals(&self) -> u32 {
        self.sessions.clear_all() as u32
    }
    /// 启动成功：运行态置位、上次错误清空
    pub fn mark_started(&self) {
        self.running.store(true, std::sync::atomic::Ordering::Release);
        if let Ok(mut e) = self.last_error.lock() {
            *e = None;
        }
    }
    /// 启动失败/异常退出：运行态清零并记录原因（GUI 可见的唯一失败通道）
    pub fn mark_start_failed(&self, err: String) {
        self.running.store(false, std::sync::atomic::Ordering::Release);
        if let Ok(mut e) = self.last_error.lock() {
            *e = Some(err);
        }
    }
    /// 停机完成：仅清运行态。last_error 保留——「失败后关闭开关」时失败原因仍应可见
    pub fn mark_stopped(&self) {
        self.running.store(false, std::sync::atomic::Ordering::Release);
    }
    pub fn is_running(&self) -> bool {
        self.running.load(std::sync::atomic::Ordering::Acquire)
    }
    pub fn last_error(&self) -> Option<String> {
        self.last_error.lock().ok().and_then(|e| e.clone())
    }
}

/// mcp_get_config 返回：配置平铺（flatten，前端 McpConfigDto 形状不变）+ 运行态两字段。
/// running/lastError 使设置页能对账「enabled=true 但服务实际没起」（端口占用、双开实例等）
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpConfigWithStatus {
    #[serde(flatten)]
    pub cfg: McpConfig,
    pub running: bool,
    pub last_error: Option<String>,
}

#[tauri::command]
pub fn mcp_get_config(state: State<'_, McpState>) -> McpConfigWithStatus {
    McpConfigWithStatus {
        cfg: load_mcp_config_inner(&state.settings_file),
        running: state.is_running(),
        last_error: state.last_error(),
    }
}

/// 命令层端口断言（审查 I-10）：前端已限 1024-65535，Rust 侧同口径兜底；
/// 上限由 u16 类型天然保证，0-1023 特权端口一律拒绝
fn validate_port(port: u16) -> Result<(), String> {
    if port < 1024 {
        return Err(format!("端口 {port} 不在允许范围 1024-65535"));
    }
    Ok(())
}

/// enabled 且空 token ⇒ 就地生成填充（与 prepare_mcp_config 的启动期生成同语义）。
/// 纯函数便于单测；生成唯一触发条件是 enabled（未启用时空 token 恒保留）
pub fn fill_blank_token_if_enabled(mut cfg: McpConfig) -> McpConfig {
    if cfg.enabled && cfg.token.is_empty() {
        cfg.token = generate_token();
    }
    cfg
}

/// async fn（审查 I-4）：needs_restart 时 stop_server 须异步等待旧任务退出（最长 3s），
/// 同步 fn + 阻塞 recv 会冻结 UI
#[tauri::command]
pub async fn mcp_set_config(app: AppHandle, state: State<'_, McpState>, cfg: McpConfig) -> Result<(), String> {
    validate_port(cfg.port)?;
    // 终审修复（回归）：首启用主流程（全新安装 token 未生成 → 设置页开开关）在落盘前
    // 补生成 token。7f7a72c 把生成收敛到启动期 init_state_and_autostart 后，这里以
    // enabled:true+空 token 落盘，下次启动 start_server_inner 空 token fail-closed 拒启，
    // 服务永远起不来。拒启本身保留作纵深防线（此处保证空 token 不再落盘）
    let cfg = fill_blank_token_if_enabled(cfg);
    let old = load_mcp_config_inner(&state.settings_file);
    save_mcp_config_inner(&state.settings_file, &cfg)?;
    if needs_restart(&old, &cfg) {
        restart_if_needed(&app, &state, &cfg).await?;
    }
    Ok(())
}

/// 生成新 token 并持久化。重生成意味着旧 bearer 快照立即失效（用户重生成正因怀疑
/// 旧 token 泄露），故与 mcp_set_config 同构：token 变更即按需重启使新 token 即刻生效
/// async fn（审查 I-4）：同 mcp_set_config，重启路径须异步等待
#[tauri::command]
pub async fn mcp_regenerate_token(app: AppHandle, state: State<'_, McpState>) -> Result<String, String> {
    let old = load_mcp_config_inner(&state.settings_file);
    let mut cfg = old.clone();
    cfg.token = generate_token();
    save_mcp_config_inner(&state.settings_file, &cfg)?;
    if needs_restart(&old, &cfg) {
        restart_if_needed(&app, &state, &cfg).await?;
    }
    Ok(cfg.token)
}

/// 吊销全部一次性授权（once 批准 + deny 冷却，语义=「重置审批状态」），返回清空条目数。
/// 白名单吊销走 mcp_set_config；本命令补上「仅本次」批准只能等 15 分钟 TTL 的缺口。
/// 纯内存操作（同 mcp_approval_response 的同步口径），无 await 点
#[tauri::command]
pub fn mcp_revoke_approvals(state: State<'_, McpState>) -> u32 {
    state.revoke_approvals()
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

/// 生命周期：enabled=false 或停不下来时只停；enabled=true 先停后起（端口/token 变更重绑）。
/// async fn（审查 I-4）：stop_server 的有界等待为异步，命令层可安全 await
pub async fn restart_if_needed(app: &AppHandle, state: &State<'_, McpState>, cfg: &McpConfig) -> Result<(), String> {
    stop_server(state).await;
    if cfg.enabled { start_server(app, state, cfg) } else { Ok(()) }
}

pub async fn stop_server(state: &State<'_, McpState>) {
    let handle = if let Ok(mut g) = state.shutdown.lock() {
        g.take().map(|(tx, token, handle)| {
            // 先 cancel rmcp 取消令牌（终止 GET SSE 长连接，审查 I-3），再发 watch 信号触发
            // graceful shutdown：仅后者会被 hyper 无限等待永不完成的 in-flight SSE
            token.cancel();
            let _ = tx.send(true);
            handle
        })
    } else {
        None
    };
    // 有界异步等待旧任务真正退出（≤3s，审查 I-4）：graceful shutdown 需要时间收尾既有连接，
    // 不等就重启会在 Windows（无 SO_REUSEADDR）上撞 AddrInUse（审查 I-2）。
    // tokio timeout + await 而非阻塞轮询（原实现 thread::sleep 最坏冻结 UI 3s）；
    // 超时后放行，后续新 bind 失败会如实报错给设置页。超时放弃等待不 abort 任务：
    // JoinHandle drop 仅 detach，任务仍会自行收尾退出
    if let Some(handle) = handle {
        let _ = tokio::time::timeout(Duration::from_secs(3), handle).await;
    }
    // 运行态清零（UI 对账）；last_error 保留，失败原因在重启成功前仍应可见
    state.mark_stopped();
}

/// start_server 薄包装：成功/失败统一写运行态（覆盖 set_config、autostart 全部调用路径），
/// inner 的每个 Err 出口无需各自记一笔
pub fn start_server(app: &AppHandle, state: &State<'_, McpState>, cfg: &McpConfig) -> Result<(), String> {
    let result = start_server_inner(app, state, cfg);
    match &result {
        Ok(()) => state.mark_started(),
        Err(e) => state.mark_start_failed(e.clone()),
    }
    result
}

fn start_server_inner(app: &AppHandle, state: &State<'_, McpState>, cfg: &McpConfig) -> Result<(), String> {
    // 审查修复（Finding 2 收敛）：空 token 的生成+落盘入口在 init_state_and_autostart
    // （启动期）与 mcp_set_config（设置页保存，终审修复补回），此处不再生成。空 token
    // fail-closed 拒启（纵深防线：bearer 中间件虽也拦空 token 请求，但服务不该带空凭据
    // 起来——两条生成路径之外的未知传入一概拒绝）
    if cfg.token.is_empty() {
        return Err("token 为空，拒绝启动（请先在设置页生成/重置 token）".into());
    }
    let cfg = cfg.clone();
    let (tx, rx) = tokio::sync::watch::channel(false);
    // 应用侧持有 rmcp 取消令牌：stop_server cancel 它以终止 SSE 长连接（审查 I-3）
    let cancellation_token = tokio_util::sync::CancellationToken::new();
    // bind 前置到本函数同步执行（审查 I-1/I-2）：端口占用立即以 Err 回传设置页；
    // 本轮尝试的 tx 尚未入槽，失败即 drop（槽保持 None），不留僵尸停机通道
    let listener = match std::net::TcpListener::bind(("127.0.0.1", cfg.port)) {
        Ok(l) => l,
        Err(e) => {
            drop(tx);
            return Err(format!("bind 127.0.0.1:{} failed: {e}", cfg.port));
        }
    };
    // from_std 前置条件：std listener 必须非阻塞
    if let Err(e) = listener.set_nonblocking(true) {
        drop(tx);
        return Err(format!("set_nonblocking failed: {e}"));
    }
    let app = app.clone();
    let bridge = state.bridge.clone();
    let sessions = state.sessions.clone();
    let settings_file = state.settings_file.clone();
    // 终态错误不再吞掉：进程外可见的最小日志（本 crate 无 tracing）；
    // 同步写运行态+last_error——服务中途异常退出（罕见：runtime 崩溃）设置页也能对账
    let serve_token = cancellation_token.clone();
    let handle = tauri::async_runtime::spawn(async move {
        if let Err(e) = serve_forever(app.clone(), bridge, sessions, cfg, settings_file, rx, listener, serve_token).await {
            eprintln!("[mcp] server terminated: {e}");
            use tauri::Manager;
            app.state::<McpState>().mark_start_failed(format!("服务异常退出: {e}"));
        }
    });
    *state.shutdown.lock().map_err(|_| "lock poisoned")? = Some((tx, cancellation_token, handle));
    Ok(())
}

/// 无头模式 CLI 内存覆盖（验收条目13）：仅本次运行生效，不回写 settings.json。
/// force_enabled（--headless-mcp，终审修复：不再要求必须伴随 port/token 覆盖）或
/// port/token 任一给出即强制 enabled——无头模式下 MCP 是唯一交互入口
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct McpOverride {
    pub port: Option<u16>,
    pub token: Option<String>,
    /// headless（无人值守）下无条件强制启用，无论有无 port/token 覆盖
    pub force_enabled: bool,
}

/// 覆盖合并（纯函数，单测友好）：基于读盘 cfg 的内存副本合并 CLI 覆盖，
/// 全程不触碰 settings.json（save 路径只在 mcp_set_config / regenerate / 空 token 落盘走）
pub fn apply_mcp_override(mut cfg: McpConfig, ov: &McpOverride) -> McpConfig {
    if ov.force_enabled || ov.port.is_some() || ov.token.is_some() {
        cfg.enabled = true;
    }
    if let Some(p) = ov.port {
        cfg.port = p;
    }
    if let Some(t) = &ov.token {
        cfg.token = t.clone();
    }
    cfg
}

/// 装配前的配置准备（纯函数，单测友好）：读盘原始 cfg → 合并 CLI 覆盖 → 空 token 生成。
/// 返回 (生效 cfg, 待落盘 cfg)。待落盘恒为剥离覆盖的原始值（审查修复 Finding 1：覆盖端口/
/// 强制 enabled 绝不进 settings.json，仅新生成的 token 持久化到原始 cfg 上）；None=无需落盘。
pub fn prepare_mcp_config(raw: McpConfig, ov: &McpOverride) -> (McpConfig, Option<McpConfig>) {
    let mut cfg = apply_mcp_override(raw.clone(), ov);
    let mut to_persist = None;
    // 生效 token 为空才生成：覆盖提供 token 时生效 token 非空，恒不进入此分支
    // （生效 token 为空 ⟺ 覆盖未提供 token 且 raw.token 为空，故分支内 raw.token 必为空）
    if cfg.enabled && cfg.token.is_empty() {
        let token = generate_token();
        cfg.token = token.clone();
        let mut persisted = raw;
        persisted.token = token;
        to_persist = Some(persisted);
    }
    (cfg, to_persist)
}

/// setup 阶段装配：manage 全局状态 + 按配置自动拉起。返回 (生效 cfg（含 CLI 覆盖）, 启动结果)：
/// 启动结果 Ok=服务已监听（或按配置本就不启动）；Err=启动失败原因（落盘失败/autostart 失败）。
/// headless 由 run() 据此 stderr+exit(2) 让脚本消费方感知失败；非 headless 失败仅 eprintln
/// + 运行态记录，不拦应用启动（设置页可对账）。app 为 &mut App（setup 闭包入参）
pub fn init_state_and_autostart(
    app: &mut tauri::App,
    ov: &McpOverride,
) -> Result<(McpConfig, Result<(), String>), String> {
    use tauri::Manager;
    let settings_file =
        app.path().app_data_dir().map_err(|e| e.to_string())?.join("settings.json");
    let state = McpState {
        bridge: Default::default(),
        sessions: Default::default(),
        shutdown: Default::default(),
        settings_file,
        running: std::sync::atomic::AtomicBool::new(false),
        last_error: Default::default(),
    };
    // manage 前读配置：避免 manage 后再借 state 的 borrow 纠缠
    let raw_cfg = load_mcp_config_inner(&state.settings_file);
    let (cfg, to_persist) = prepare_mcp_config(raw_cfg, ov);
    // token 生成落盘入口之一（启动期；另一处为设置页保存 mcp_set_config，终审修复补回）。
    // start_server_inner 不生成。
    // 落盘对象是剥离覆盖的原始 cfg（Finding 1：覆盖端口/强制 enabled 不落盘）；
    // 落盘失败对齐原 inner 口径：服务不启、不拦应用启动，错误进运行态供设置页对账
    // （headless 下宁可不启服务，也不让内存 token 与盘上状态漂移）
    let mut start_error: Option<String> = None;
    if let Some(persisted) = &to_persist {
        if let Err(e) = save_mcp_config_inner(&state.settings_file, persisted) {
            let msg = format!("token 落盘失败: {e}");
            eprintln!("[mcp] {msg}");
            start_error = Some(msg);
        }
    }
    app.manage(state);
    let start_result = match start_error {
        Some(msg) => {
            app.state::<McpState>().mark_start_failed(msg.clone());
            Err(msg)
        }
        None if cfg.enabled => {
            let handle = app.handle().clone();
            let st = handle.state::<McpState>();
            // autostart 失败（bind 占用等）不拦 GUI 启动：setup fatal 只留给状态构造/manage，
            // 失败原因经返回值外传（headless exit(2)），并仅记日志+运行态供设置页重开开关重试
            match start_server(&handle, &st, &cfg) {
                Ok(()) => Ok(()),
                Err(e) => {
                    eprintln!("[mcp] autostart failed: {e}");
                    Err(e)
                }
            }
        }
        None => Ok(()),
    };
    Ok((cfg, start_result))
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

    // CLI 覆盖合并（验收条目13）：强制 enabled + 字段生效（纯函数语义；
    // 真实落盘路径回归见下方 override_with_blank_token_persists_raw_cfg_never_override_values）
    #[test]
    fn override_forces_enabled_and_applies_fields() {
        let cfg = apply_mcp_override(
            McpConfig::default(),
            &McpOverride { port: Some(47216), token: Some("0123456789abcdef".into()), force_enabled: false },
        );
        assert!(cfg.enabled, "任一覆盖项存在即强制启用");
        assert_eq!(cfg.port, 47216);
        assert_eq!(cfg.token, "0123456789abcdef");
    }

    // 审查修复回归（Finding 1/3）：--mcp-port 覆盖 + 存量空 token 组合——token 生成落盘
    // 必须走剥离覆盖的原始 cfg：落盘文件不含覆盖端口、不被强制 enabled:true，仅新 token 持久化
    #[test]
    fn override_with_blank_token_persists_raw_cfg_never_override_values() {
        let p = tmp_path("override-persist");
        std::fs::write(
            &p,
            r#"{"mcp":{"enabled":false,"mode":"wildcard","port":47215,"token":"","whitelist":[]}}"#,
        )
        .unwrap();
        let raw = load_mcp_config_inner(&p);
        let (cfg, to_persist) = prepare_mcp_config(
            raw,
            &McpOverride { port: Some(47216), token: None, force_enabled: false },
        );
        // 生效配置：覆盖全部生效
        assert!(cfg.enabled);
        assert_eq!(cfg.port, 47216);
        assert!(!cfg.token.is_empty(), "空 token 存量须生成");
        // 真实落盘路径：save 待落盘 cfg 后读回断言（不再对纯函数做永真的「不回写」断言）
        let persisted = to_persist.expect("空 token 须产生待落盘配置");
        save_mcp_config_inner(&p, &persisted).unwrap();
        let back = load_mcp_config_inner(&p);
        assert_eq!(back.port, 47215, "覆盖端口不得落盘");
        assert!(!back.enabled, "覆盖强制的 enabled 不得落盘");
        assert_eq!(back.token, cfg.token, "新生成 token 落盘到原始 cfg 通道");
        let _ = std::fs::remove_file(&p);
    }

    // 覆盖提供 token（--mcp-token）时：生效 token 非空，不得触发二次生成、不得产生任何落盘
    #[test]
    fn override_with_token_skips_generation_and_persistence() {
        let (cfg, to_persist) = prepare_mcp_config(
            McpConfig::default(),
            &McpOverride { port: None, token: Some("0123456789abcdef".into()), force_enabled: false },
        );
        assert!(cfg.enabled);
        assert_eq!(cfg.token, "0123456789abcdef");
        assert!(to_persist.is_none(), "覆盖 token 路径不得有任何落盘");
    }

    // 终审修复回归（Finding 1）：设置页首启用主流程——全新安装 token 未生成，前端整体回写
    // {enabled:true, token:""}。7f7a72c 回归：空 token 落盘后 start_server_inner fail-closed
    // 拒启，服务永远起不来。沿 mcp_set_config 的真实链路（load→fill→save→load）验证补生成
    #[test]
    fn set_config_with_enabled_blank_token_generates_and_persists() {
        let p = tmp_path("set-config-blank-token");
        std::fs::write(
            &p,
            r#"{"mcp":{"enabled":false,"mode":"wildcard","port":47215,"token":"","whitelist":[]}}"#,
        )
        .unwrap();
        let old = load_mcp_config_inner(&p);
        // 模拟前端首启用：读盘 cfg 翻转 enabled、token 仍为空（整体回写通道）
        let mut submitted = old.clone();
        submitted.enabled = true;
        let cfg = fill_blank_token_if_enabled(submitted);
        assert!(!cfg.token.is_empty(), "enabled+空 token 必须在落盘前补生成");
        save_mcp_config_inner(&p, &cfg).unwrap();
        let back = load_mcp_config_inner(&p);
        assert_eq!(back.token, cfg.token, "落盘 token 与生效 token 一致，下次启动可起服");
        // token 空→非空必然触发重启：restart_if_needed→start_server_inner 的空 token
        // 拒启不再可达（服务可启）
        assert!(needs_restart(&old, &cfg));
        let _ = std::fs::remove_file(&p);
    }

    // 未启用时空 token 恒不生成（生成唯一触发条件是 enabled，与 prepare_mcp_config 同口径）
    #[test]
    fn disabled_blank_token_stays_blank() {
        let cfg = fill_blank_token_if_enabled(McpConfig::default());
        assert!(!cfg.enabled);
        assert!(cfg.token.is_empty(), "未启用不得偷偷生成 token");
    }

    // 终审修复回归（Finding 2）：裸 --headless-mcp（无 port/token 覆盖、settings 中 MCP 关闭）
    // 无条件强制启用且空 token 存量在启动期生成——此前不强制，打印空 token 连接行误导消费方
    #[test]
    fn headless_override_forces_enabled_and_generates_token() {
        let (cfg, to_persist) =
            prepare_mcp_config(McpConfig::default(), &McpOverride { force_enabled: true, ..McpOverride::default() });
        assert!(cfg.enabled);
        assert!(!cfg.token.is_empty(), "headless 空 token 存量必须生成，连接行才有效");
        let persisted = to_persist.expect("空 token 须产生待落盘配置");
        assert!(!persisted.enabled, "headless 强制的 enabled 不得落盘（同 CLI 覆盖口径）");
        assert_eq!(persisted.token, cfg.token);
    }

    #[test]
    fn override_default_is_noop() {
        let base = McpConfig::default();
        let cfg = apply_mcp_override(base.clone(), &McpOverride::default());
        assert!(!cfg.enabled);
        assert_eq!(cfg.port, base.port);
        assert_eq!(cfg.token, base.token);
        assert_eq!(cfg.mode, base.mode);
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
        assert!(
            std::fs::read_to_string(&p).unwrap().contains("shortcutToggleMini"),
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

    // ==== 一次性授权主动吊销（clear_all / mcp_revoke_approvals 底座）====

    #[test]
    fn clear_all_wipes_once_and_cooldown() {
        let s = GateSessions::default();
        s.grant_once("claude".into());
        s.grant_once("cursor".into());
        s.mark_denied("zed");
        assert_eq!(s.clear_all(), 3, "返回清空条目总数（once+deny）");
        assert!(!s.once_valid("claude"), "once 批准吊销后必须重新弹窗");
        assert!(!s.once_valid("cursor"));
        assert!(!s.denied_recently("zed"), "deny 冷却一并清除（主动吊销无需再等 60s）");
        assert_eq!(s.clear_all(), 0, "重复吊销幂等");
    }

    /// McpState 字段全 pub，测试内直接构造（同 tmp_path 模式：不依赖 Tauri runtime）
    fn test_state() -> McpState {
        McpState {
            bridge: Default::default(),
            sessions: Default::default(),
            shutdown: Mutex::new(None),
            settings_file: PathBuf::new(),
            running: std::sync::atomic::AtomicBool::new(false),
            last_error: Mutex::new(None),
        }
    }

    #[test]
    fn revoke_approvals_clears_sessions_and_returns_count() {
        let st = test_state();
        st.sessions.grant_once("a".into());
        st.sessions.mark_denied("b");
        assert_eq!(st.revoke_approvals(), 2);
        assert_eq!(st.revoke_approvals(), 0, "重复吊销幂等");
    }

    // ==== 服务运行态可见（mcp_get_config 的 running/lastError 底座）====

    #[test]
    fn runtime_state_flips_and_last_error_roundtrip() {
        let st = test_state();
        assert!(!st.is_running(), "初始未运行");
        assert_eq!(st.last_error(), None);
        // 启动失败（如端口占用）：running=false + last_error 有值
        st.mark_start_failed("bind 127.0.0.1:47215 failed: AddrInUse".into());
        assert!(!st.is_running());
        assert_eq!(st.last_error().as_deref(), Some("bind 127.0.0.1:47215 failed: AddrInUse"));
        // 重启成功：running=true + 错误清空
        st.mark_started();
        assert!(st.is_running());
        assert_eq!(st.last_error(), None, "启动成功须清空上次错误");
        // 停机：running=false，last_error 保留（失败后关闭开关仍可对账）
        st.mark_start_failed("port busy".into());
        st.mark_stopped();
        assert!(!st.is_running());
        assert_eq!(st.last_error().as_deref(), Some("port busy"), "stop 不清 last_error");
    }

    #[test]
    fn get_config_dto_serializes_running_and_last_error_flattened() {
        // 契约：cfg 字段平铺（前端 McpConfigDto 形状不变）+ running/lastError camelCase
        let dto = McpConfigWithStatus { cfg: McpConfig::default(), running: true, last_error: None };
        let v: serde_json::Value = serde_json::to_value(&dto).unwrap();
        assert_eq!(v["running"], true);
        assert!(v.get("lastError").is_some_and(|x| x.is_null()), "lastError=None 序列化为 null");
        assert_eq!(v["port"], 47215, "配置字段经 flatten 平铺在同一层");
        assert_eq!(v["enabled"], false);
        let dto = McpConfigWithStatus { cfg: McpConfig::default(), running: false, last_error: Some("端口被占用".into()) };
        let v: serde_json::Value = serde_json::to_value(&dto).unwrap();
        assert_eq!(v["lastError"], "端口被占用");
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

    // ==== 审查 I-6：鉴权中间件装配 oneshot 直测（此前删掉 .layer(middleware) 测试依旧全绿）====

    /// 200 桩内层的 router：中间件放行即 200，拒绝即 401/403
    fn test_router() -> axum::Router {
        let inner = axum::Router::new().fallback(|| async { axum::http::StatusCode::OK });
        mcp_router(std::sync::Arc::new("secret-token".to_string()), inner)
    }

    fn oneshot_request(host: &str, auth: Option<&str>) -> http::Request<axum::body::Body> {
        let mut builder = http::Request::builder().uri("/mcp").header(http::header::HOST, host);
        if let Some(a) = auth {
            builder = builder.header(http::header::AUTHORIZATION, a);
        }
        builder.body(axum::body::Body::empty()).unwrap()
    }

    async fn oneshot_status(host: &str, auth: Option<&str>) -> axum::http::StatusCode {
        use tower::ServiceExt;
        test_router().oneshot(oneshot_request(host, auth)).await.unwrap().status()
    }

    #[tokio::test]
    async fn auth_middleware_rejects_missing_and_wrong_credentials() {
        // 无 Authorization 头 → 401
        assert_eq!(
            oneshot_status("127.0.0.1:47215", None).await,
            axum::http::StatusCode::UNAUTHORIZED
        );
        // Bearer 错 token → 401
        assert_eq!(
            oneshot_status("127.0.0.1:47215", Some("Bearer wrong-token")).await,
            axum::http::StatusCode::UNAUTHORIZED
        );
    }

    #[tokio::test]
    async fn auth_middleware_rejects_non_loopback_host() {
        // Bearer 对 token + 恶意 Host → 403（DNS rebinding 防护先于凭据判定）
        assert_eq!(
            oneshot_status("evil.com", Some("Bearer secret-token")).await,
            axum::http::StatusCode::FORBIDDEN
        );
    }

    #[tokio::test]
    async fn auth_middleware_allows_good_token_and_loopback_host() {
        // Bearer 对 token + loopback Host → 放行（桩内层 200）
        assert_eq!(
            oneshot_status("127.0.0.1:47215", Some("Bearer secret-token")).await,
            axum::http::StatusCode::OK
        );
    }

    #[tokio::test]
    async fn auth_middleware_accepts_case_insensitive_bearer_scheme() {
        // RFC 7235/6750：auth-scheme 大小写不敏感（审查 I-9）
        assert_eq!(
            oneshot_status("127.0.0.1:47215", Some("bearer secret-token")).await,
            axum::http::StatusCode::OK
        );
        assert_eq!(
            oneshot_status("127.0.0.1:47215", Some("BeArEr secret-token")).await,
            axum::http::StatusCode::OK
        );
        // 非 bearer scheme（Basic）与 token 值本身的大小写差异仍拒绝
        assert_eq!(
            oneshot_status("127.0.0.1:47215", Some("Basic secret-token")).await,
            axum::http::StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            oneshot_status("127.0.0.1:47215", Some("Bearer SECRET-TOKEN")).await,
            axum::http::StatusCode::UNAUTHORIZED
        );
    }

    // ==== 审查 I-10：命令层端口断言 ====

    #[test]
    fn port_validation_matches_frontend_bounds() {
        assert!(validate_port(1024).is_ok());
        assert!(validate_port(47215).is_ok());
        assert!(validate_port(65535).is_ok(), "上限由 u16 类型天然保证");
        assert!(validate_port(0).is_err());
        assert!(validate_port(80).is_err());
        assert!(validate_port(1023).is_err(), "0-1023 特权端口一律拒绝（与前端 1024-65535 同口径）");
    }

    // ==== 审查 I-3：GET SSE 长连接下的停机集成测试 ====
    // serve_forever 依赖 AppHandle（单测无法构造），故按同一装配路径复刻 serve 循环：
    // mcp_router + 真实 StreamableHttpService（应用侧 cancellation_token + watch graceful
    // shutdown）。客户端先 POST initialize 取 Mcp-Session-Id（legacy_session_mode 默认开，
    // GET SSE 必须带会话 id），再开 GET SSE 挂住连接；随后 cancel 令牌 + watch 信号，
    // 断言 serve 在 5s 内返回且端口可重 bind（旧监听已释放）。
    #[tokio::test]
    async fn stop_completes_within_bound_with_live_sse_connection() {
        use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
        use rmcp::transport::streamable_http_server::{StreamableHttpServerConfig, StreamableHttpService};
        use tokio::io::AsyncWriteExt;

        // 无工具的最小 ServerHandler：只做传输层长连接载体
        #[derive(Clone, Default)]
        struct StubHandler;
        impl rmcp::ServerHandler for StubHandler {}

        let token = tokio_util::sync::CancellationToken::new();
        let service: StreamableHttpService<StubHandler, LocalSessionManager> = StreamableHttpService::new(
            || Ok(StubHandler),
            LocalSessionManager::default().into(),
            StreamableHttpServerConfig::default()
                .with_json_response(true)
                .with_cancellation_token(token.clone()),
        );
        let router = mcp_router(std::sync::Arc::new("secret".to_string()), service);

        let std_listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = std_listener.local_addr().unwrap();
        std_listener.set_nonblocking(true).unwrap();
        let listener = tokio::net::TcpListener::from_std(std_listener).unwrap();
        let (tx, mut rx) = tokio::sync::watch::channel(false);
        let server = tokio::spawn(async move {
            axum::serve(listener, router)
                .with_graceful_shutdown(async move { let _ = rx.changed().await; })
                .await
        });

        // 累积读至响应头结束（\r\n\r\n 前），返回头文本
        async fn read_http_head(conn: &mut tokio::net::TcpStream) -> String {
            use tokio::io::AsyncReadExt;
            let mut raw = Vec::new();
            let mut chunk = [0u8; 4096];
            loop {
                let n = conn.read(&mut chunk).await.unwrap();
                assert!(n > 0, "连接被提前关闭");
                raw.extend_from_slice(&chunk[..n]);
                if let Some(p) = raw.windows(4).position(|w| w == b"\r\n\r\n") {
                    return String::from_utf8_lossy(&raw[..p]).to_string();
                }
            }
        }

        let mut conn = tokio::net::TcpStream::connect(addr).await.unwrap();

        // ① POST initialize：取得 Mcp-Session-Id
        let init_body = serde_json::json!({
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {
                "protocolVersion": "2025-03-26",
                "capabilities": {},
                "clientInfo": { "name": "sse-stop-test", "version": "0.0.0" }
            }
        })
        .to_string();
        let req = format!(
            "POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer secret\r\n\
             Accept: application/json, text/event-stream\r\nContent-Type: application/json\r\n\
             Content-Length: {}\r\nConnection: keep-alive\r\n\r\n{init_body}",
            init_body.len()
        );
        conn.write_all(req.as_bytes()).await.unwrap();
        let head = read_http_head(&mut conn).await;
        assert!(head.starts_with("HTTP/1.1 200"), "initialize 应 200：{head}");
        let session_id = head
            .lines()
            .find_map(|l| {
                let (k, v) = l.split_once(':')?;
                k.trim().eq_ignore_ascii_case("mcp-session-id").then(|| v.trim().to_string())
            })
            .expect("initialize 响应必须带 Mcp-Session-Id");

        // ② GET SSE 长连接（同一 keep-alive 连接）：读到 200 开流即挂住，不读完
        let get = format!(
            "GET /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer secret\r\n\
             Accept: text/event-stream\r\nMcp-Session-Id: {session_id}\r\n\r\n"
        );
        conn.write_all(get.as_bytes()).await.unwrap();
        let sse_head = read_http_head(&mut conn).await;
        assert!(sse_head.starts_with("HTTP/1.1 200"), "GET SSE 应 200 开流：{sse_head}");

        // ③ 停机：cancel 令牌 + watch 信号 → graceful shutdown 必须有限时间完成
        token.cancel();
        let _ = tx.send(true);
        tokio::time::timeout(Duration::from_secs(5), server)
            .await
            .expect("持 GET SSE 长连接时停机必须在 5s 内完成（审查 I-3）")
            .unwrap()
            .unwrap();

        // ④ 端口已释放：重 bind 成功（Windows 无 SO_REUSEADDR，旧监听未释放会 AddrInUse）
        assert!(std::net::TcpListener::bind(addr).is_ok(), "停机后端口必须已释放以便重启");
    }
}
