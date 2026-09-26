//! 桌面应用 settings.json 读写基础件（R9 单点化）：路径解析、分节读（读失败/缺键回 None）、
//! 分节合并写。settings.json 为 Rust 四组配置（shortcutToggleMini/devtools/releasePolicy/mcp）
//! + 前端 AppSettings 共写文件，两条不变式收口在本模块：
//!
//! 1. 「合并写不丢外来键，根非对象回落空对象重建」（审查 I-5/M3，写侧必经
//!    merge_section_text/write_section，禁止整文件覆盖）；
//! 2. 「读失败回默认」（读侧经 read_section/read_section_at/read_section_text 取 None 后回落）；
//!
//! write_text_atomic 为全部写侧共用的原子落盘通道。

use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime};

// 桌面应用 settings.json：存于 app_data_dir（与前端 createTauriFs 的 baseDir 对齐）。
// 当前唯一可配项为 shortcutToggleMini（toggle mini 的全局快捷键），默认 alt+shift+t；
// 解析失败/字段缺失一律回落到默认值，保证老版本 settings.json 不破坏启动。
pub fn settings_path<R: Runtime>(app: &AppHandle<R>) -> Option<std::path::PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("settings.json"))
}

// ---------- 读侧（「读失败回默认」外壳单点：取分节得 None，由调用方回默认） ----------

/// 解析既有 settings 文本取分节（纯函数）：解析失败/根非对象/缺键 → None。
/// 分节类型与键名是否合法由调用方裁定（如 from_settings_text 的逐字段回默认）
pub fn read_section_text(text: &str, key: &str) -> Option<serde_json::Value> {
    serde_json::from_str::<serde_json::Value>(text)
        .ok()?
        .get(key)
        .cloned()
}

/// 读分节（路径级）：读文件失败 → None（供路径注入的测试/无 AppHandle 场景，如 mcp 配置）
pub fn read_section_at(path: &std::path::Path, key: &str) -> Option<serde_json::Value> {
    read_section_text(&std::fs::read_to_string(path).ok()?, key)
}

/// 读分节（app 级）：settings.json 路径不可定位 → None
pub fn read_section<R: Runtime>(app: &AppHandle<R>, key: &str) -> Option<serde_json::Value> {
    read_section_at(&settings_path(app)?, key)
}

/// 读 settings.json 全文；读不到/路径不可定位回 "{}"（下游文本解析器走「缺键回默认」统一回落）
pub fn read_settings_text<R: Runtime>(app: &AppHandle<R>) -> String {
    settings_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .unwrap_or_else(|| "{}".into())
}

pub fn read_shortcut_from_settings<R: Runtime>(app: &AppHandle<R>) -> String {
    const DEFAULT: &str = "alt+shift+t";
    read_section(app, "shortcutToggleMini")
        .and_then(|x| x.as_str().map(|s| s.to_string()))
        .unwrap_or_else(|| DEFAULT.into())
}

// ---------- 写侧（「合并不丢外来键 + 根非对象回落」不变式单点） ----------

/// 合并既有 settings 文本只改 key 分节，返回落盘文本（纯函数）：
/// existing 缺失/解析失败/根为合法 JSON 但非对象（[] / "x" / 标量——serde_json IndexMut
/// 直写非对象根会 panic，审查 M3）一律回落空对象重建；只替换 key，外来键原样保留；
/// 输出 pretty 文本与既有各写侧口径一致
pub fn merge_section_text<S: Serialize>(
    existing: Option<&str>,
    key: &str,
    section: &S,
) -> Result<String, String> {
    let mut obj: serde_json::Map<String, serde_json::Value> = existing
        .and_then(|t| serde_json::from_str::<serde_json::Value>(t).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default();
    let value = serde_json::to_value(section).map_err(|e| e.to_string())?;
    obj.insert(key.into(), value);
    serde_json::to_string_pretty(&serde_json::Value::Object(obj)).map_err(|e| e.to_string())
}

/// 合并写分节（路径级）：建目录 + 读既有 + merge_section_text + write_text_atomic 原子落盘
pub fn write_section_at<S: Serialize>(
    path: &std::path::Path,
    key: &str,
    section: &S,
) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let existing = std::fs::read_to_string(path).ok();
    let text = merge_section_text(existing.as_deref(), key, section)?;
    write_text_atomic(path, &text)
}

/// 合并写分节（app 级）：settings.json 路径不可定位报错
pub fn write_section<R: Runtime, S: Serialize>(
    app: &AppHandle<R>,
    key: &str,
    section: &S,
) -> Result<(), String> {
    let path = settings_path(app).ok_or_else(|| "无法定位 settings.json".to_string())?;
    write_section_at(&path, key, section)
}

/// 原子写文本（审查 I-5）：先写同目录临时文件再 rename 覆盖目标——崩溃中途不再留下半截
/// settings.json（旧实现 fs::write 直覆，损坏即丢全部外来键）。临时文件与目标同目录保证
/// 同盘 rename 原子性；Windows 上 std::fs::rename 以 MOVEFILE_REPLACE_EXISTING 语义可覆盖
/// 已存在文件。临时名带进程号+进程内自增序号，防并发写互撞；失败时兜底清理临时文件。
pub fn write_text_atomic(path: &std::path::Path, contents: &str) -> Result<(), String> {
    use std::sync::atomic::Ordering;
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("file");
    let tmp = path.with_file_name(format!(
        "{name}.tmp-{}-{}",
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    match std::fs::write(&tmp, contents).and_then(|()| std::fs::rename(&tmp, path)) {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            Err(e.to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // 审查 I-5：原子写覆盖既有文件且无临时文件残留（rename 成功后 tmp 不存在）
    #[test]
    fn write_text_atomic_replaces_target_without_tmp_leftover() {
        let base = std::env::temp_dir().join("totp_write_text_atomic");
        std::fs::create_dir_all(&base).unwrap();
        let p = base.join("settings.json");
        std::fs::write(&p, "{\"old\":1}").unwrap();
        write_text_atomic(&p, "{\"new\":2}").unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "{\"new\":2}");
        // 不存在目标已更新而临时文件残留的中间态（并发写用不同 tmp 名，均被 rename 吸走）
        let leftovers: Vec<_> = std::fs::read_dir(&base)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.contains(".tmp-"))
            .collect();
        assert!(
            leftovers.is_empty(),
            "临时文件必须被 rename 吸走，残留: {leftovers:?}"
        );
        std::fs::remove_dir_all(&base).ok();
    }

    // ---- 读侧分节（R9 单点化；自 lib.rs devtools 测试与 release_policy 解析口径收口）----

    #[test]
    fn read_section_text_returns_none_on_invalid_json_missing_key_and_non_object_root() {
        // 非 JSON 文本 → None
        assert_eq!(read_section_text("not json", "devtools"), None);
        // 合法 JSON 但缺键 → None
        assert_eq!(read_section_text(r#"{"mcp":{}}"#, "devtools"), None);
        // 根非对象（数组/标量）取键 → None（get 对非对象返回 None，不 panic）
        for root in [r#"["legacy"]"#, r#""x""#, "42", "true", "null"] {
            assert_eq!(read_section_text(root, "devtools"), None, "根 {root}");
        }
    }

    #[test]
    fn read_section_text_returns_section_value_verbatim() {
        let v =
            read_section_text(r#"{"devtools":{"enabled":true,"port":9333}}"#, "devtools").unwrap();
        assert_eq!(v["enabled"], serde_json::json!(true));
        assert_eq!(v["port"], serde_json::json!(9333));
        // 分节类型不符（字符串）原样返回 Some——类型回默认是调用方职责，读取层不越权裁定
        assert_eq!(
            read_section_text(r#"{"devtools":"on"}"#, "devtools"),
            Some(serde_json::json!("on"))
        );
    }

    // ---- 写侧合并（R9 单点化；自 devtools_merge_* 与 release merge 测试移植，守护口径不变）----

    // 审查 M3：settings.json 根为合法 JSON 但非对象（[] / "x" / 标量）时合并不得 panic，
    // 目标键落到新对象（as_object 回落重建口径；旧实现 IndexMut 直写非对象根会 panic）
    #[test]
    fn merge_section_text_non_object_root_rebuilds_without_panic() {
        for root in [r#"["legacy"]"#, r#""x""#, "42", "true", "null"] {
            let text = merge_section_text(
                Some(root),
                "devtools",
                &serde_json::json!({
                    "enabled": true,
                    "port": 9333u16,
                }),
            )
            .unwrap_or_else(|e| panic!("根 {root} 合并不应失败: {e}"));
            let v: serde_json::Value = serde_json::from_str(&text).unwrap();
            assert_eq!(v["devtools"]["enabled"], serde_json::json!(true));
            assert_eq!(v["devtools"]["port"], serde_json::json!(9333));
        }
        // 无既有文件（None）：同口径落到新对象
        let text =
            merge_section_text(None, "devtools", &serde_json::json!({ "port": 9222u16 })).unwrap();
        let v: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(v["devtools"]["port"], serde_json::json!(9222));
    }

    // 合并不丢外来键（settings.json 各写侧共同承诺）：shortcutToggleMini / mcp 原样保留
    #[test]
    fn merge_section_text_preserves_foreign_keys_and_replaces_only_target() {
        let existing = r#"{"shortcutToggleMini":"alt+shift+t","mcp":{"enabled":true},"devtools":{"enabled":false,"port":9222}}"#;
        let text = merge_section_text(
            Some(existing),
            "devtools",
            &serde_json::json!({ "enabled": true, "port": 9333u16 }),
        )
        .unwrap();
        let v: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(v["shortcutToggleMini"], "alt+shift+t");
        assert_eq!(v["mcp"]["enabled"], serde_json::json!(true));
        // 仅目标键被替换（含子键整节覆写，不残留旧子键）
        assert_eq!(
            v["devtools"],
            serde_json::json!({ "enabled": true, "port": 9333 })
        );
    }

    // 端到端（路径级）：建目录 + 合并写 + 原子落盘 + 二次写不丢首轮键
    #[test]
    fn write_section_at_creates_dirs_and_roundtrips_foreign_keys() {
        let base = std::env::temp_dir().join("totp_write_section_at");
        let p = base.join("nested/dir/settings.json");
        std::fs::remove_dir_all(&base).ok();
        write_section_at(&p, "mcp", &serde_json::json!({ "enabled": true })).unwrap();
        write_section_at(&p, "devtools", &serde_json::json!({ "enabled": false })).unwrap();
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&p).unwrap()).unwrap();
        assert_eq!(v["mcp"]["enabled"], serde_json::json!(true));
        assert_eq!(v["devtools"]["enabled"], serde_json::json!(false));
        std::fs::remove_dir_all(&base).ok();
    }

    // 路径级读：写后可读回同节；读不存在文件 → None
    #[test]
    fn read_section_at_roundtrip_and_missing_file_none() {
        let base = std::env::temp_dir().join("totp_read_section_at");
        std::fs::create_dir_all(&base).unwrap();
        let p = base.join("settings.json");
        std::fs::remove_file(&p).ok();
        assert_eq!(read_section_at(&p, "mcp"), None);
        write_section_at(&p, "mcp", &serde_json::json!({ "enabled": true })).unwrap();
        assert_eq!(
            read_section_at(&p, "mcp").unwrap()["enabled"],
            serde_json::json!(true)
        );
        std::fs::remove_dir_all(&base).ok();
    }
}
