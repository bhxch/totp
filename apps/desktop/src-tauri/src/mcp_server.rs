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
    if !cfg.whitelist.iter().any(|w| w == pattern) {
        cfg.whitelist.push(pattern.to_string());
    }
    save_mcp_config_inner(settings_file, cfg)
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
}
