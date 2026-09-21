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
        let huge = "a".repeat(257);
        assert!(!wildcard_match(&huge, "a"), "超长 pattern 视为配置错误，不匹配（fail-closed）");
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
}
