//! 桌面应用 settings.json 读写基础件：路径解析、单键读取、原子写（审查 I-5）。
//! 配置分节的具体读写（devtools/releasePolicy/mcp）在各消费方；「合并写保留外来键」
//! 与「读失败回默认」的不变式见各分节实现，write_text_atomic 为全部写侧共用的落盘通道。

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

pub fn read_shortcut_from_settings<R: Runtime>(app: &AppHandle<R>) -> String {
    const DEFAULT: &str = "alt+shift+t";
    let Some(p) = settings_path(app) else {
        return DEFAULT.into();
    };
    let Ok(text) = std::fs::read_to_string(&p) else {
        return DEFAULT.into();
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else {
        return DEFAULT.into();
    };
    v.get("shortcutToggleMini")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| DEFAULT.into())
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
}
