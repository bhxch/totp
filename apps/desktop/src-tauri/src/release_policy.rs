//! 桌面窗口资源释放策略（spec 批⑧ §7）：隐藏 → N 分钟暂停（WebView2 TrySuspend）→ 再 M 分钟销毁 webview 仅留托盘进程。
//! 配置存 settings.json `releasePolicy` 键（Rust 轨，合并写保留外来键）；分钟数 0=禁用该档。
//! 本模块为纯逻辑：配置解析/合并、状态机 advance；副作用（轮询线程/TrySuspend/destroy/重建）在 lib.rs 接线。

use serde::Deserialize;

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct ReleasePolicyConfig {
    /// 隐藏后多少分钟进入暂停档；0=禁用暂停档
    #[serde(default = "default_pause_minutes")]
    pub pause_minutes: u32,
    /// 暂停后多少分钟销毁；0=禁用销毁档（暂停禁用时从隐藏起算）
    #[serde(default = "default_destroy_minutes")]
    pub destroy_minutes: u32,
    /// 暂停档同时锁定 vault（默认关）
    #[serde(default)]
    pub lock_on_pause: bool,
    /// 销毁档锁定 vault（默认开；关=DEK 暂存 Rust 内存、重建后回注）
    #[serde(default = "default_true")]
    pub lock_on_destroy: bool,
}

fn default_pause_minutes() -> u32 { 5 }
fn default_destroy_minutes() -> u32 { 30 }
fn default_true() -> bool { true }

impl Default for ReleasePolicyConfig {
    fn default() -> Self {
        Self { pause_minutes: 5, destroy_minutes: 30, lock_on_pause: false, lock_on_destroy: true }
    }
}

/// 从 settings.json 文本解析（缺键/类型不符逐字段回默认；整体非 JSON 回全默认）
pub fn from_settings_text(text: &str) -> ReleasePolicyConfig {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(text) else {
        return ReleasePolicyConfig::default();
    };
    let Some(r) = v.get("releasePolicy") else {
        return ReleasePolicyConfig::default();
    };
    let d = ReleasePolicyConfig::default();
    ReleasePolicyConfig {
        pause_minutes: r.get("pauseMinutes").and_then(|x| x.as_u64()).map(|n| n as u32).unwrap_or(d.pause_minutes),
        destroy_minutes: r.get("destroyMinutes").and_then(|x| x.as_u64()).map(|n| n as u32).unwrap_or(d.destroy_minutes),
        lock_on_pause: r.get("lockOnPause").and_then(|x| x.as_bool()).unwrap_or(d.lock_on_pause),
        lock_on_destroy: r.get("lockOnDestroy").and_then(|x| x.as_bool()).unwrap_or(d.lock_on_destroy),
    }
}

/// 合并既有 settings.json 文本，只改 releasePolicy 键（根非对象时重建，与 devtools 合并同口径，不丢外来键）
pub fn merge_into_settings_text(existing: Option<&str>, cfg: &ReleasePolicyConfig) -> Result<String, String> {
    let mut obj: serde_json::Map<String, serde_json::Value> = existing
        .and_then(|t| serde_json::from_str::<serde_json::Value>(t).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default();
    obj.insert(
        "releasePolicy".into(),
        serde_json::json!({
            "pauseMinutes": cfg.pause_minutes,
            "destroyMinutes": cfg.destroy_minutes,
            "lockOnPause": cfg.lock_on_pause,
            "lockOnDestroy": cfg.lock_on_destroy,
        }),
    );
    serde_json::to_string_pretty(&serde_json::Value::Object(obj)).map_err(|e| e.to_string())
}

/// 状态机动作（接线层消费：Pause→TrySuspend；Destroy→锁库/暂存+destroy；None→无操作）。
/// 本任务仅落纯函数底座，Task 13 轮询接线前 dead_code 允许（接线后移除）
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReleaseAction {
    None,
    Pause,
    Destroy,
}

/// 释放状态轨迹（接线层持有；任一窗口可见或窗口重建时调用 reset）
#[allow(dead_code)]
#[derive(Debug, Default)]
pub struct ReleaseTrack {
    /// 全部窗口进入隐藏的时刻（可见时为 None）
    pub hidden_since: Option<std::time::Instant>,
    /// 暂停档发生时刻（Pause 动作产出时置位；TrySuspend 失败也置位——销毁计时照常推进，降级仅是「保持隐藏」）
    pub paused_at: Option<std::time::Instant>,
    /// 已销毁（main+mini 均不存在）：保持 None 动作直至 reset
    pub destroyed: bool,
}

#[allow(dead_code)]
impl ReleaseTrack {
    /// const 构造器：Task 13 接线层以 `Mutex::new(ReleaseTrack::new)` 建 static
    ///（Mutex::new 是 const fn 但 Default::default 不是，Default 派生仅供测试/局部用）
    pub const fn new() -> Self {
        Self { hidden_since: None, paused_at: None, destroyed: false }
    }

    pub fn reset(&mut self) {
        self.hidden_since = None;
        self.paused_at = None;
        self.destroyed = false;
    }
}

#[allow(dead_code)]
fn minutes_to_secs(m: u32) -> u64 {
    m as u64 * 60
}

/// 状态机单步推进（纯函数，单测覆盖）。
/// 语义（spec §7.2）：暂停档从「全部隐藏」起算 pauseMinutes；销毁档从「暂停发生」起算 destroyMinutes，
/// 暂停档禁用（pause_minutes=0）或 Pause 后从隐藏点起算。任一窗口可见即重置并返回 None。
#[allow(dead_code)]
pub fn advance(
    track: &mut ReleaseTrack,
    cfg: &ReleasePolicyConfig,
    main_visible: bool,
    mini_visible: bool,
    now: std::time::Instant,
) -> ReleaseAction {
    if main_visible || mini_visible {
        track.reset();
        return ReleaseAction::None;
    }
    if track.destroyed {
        return ReleaseAction::None; // 已销毁：等重建路径 reset
    }
    let hidden_since = match track.hidden_since {
        Some(t) => t,
        None => {
            track.hidden_since = Some(now);
            return ReleaseAction::None;
        }
    };
    if let Some(paused_at) = track.paused_at {
        return if cfg.destroy_minutes > 0
            && now.duration_since(paused_at) >= std::time::Duration::from_secs(minutes_to_secs(cfg.destroy_minutes))
        {
            track.destroyed = true; // Destroy 由接线层落实（本调用后窗口将消失）
            ReleaseAction::Destroy
        } else {
            ReleaseAction::None
        };
    }
    let hidden_secs = now.duration_since(hidden_since).as_secs();
    if cfg.pause_minutes > 0 && hidden_secs >= minutes_to_secs(cfg.pause_minutes) {
        track.paused_at = Some(now);
        return ReleaseAction::Pause;
    }
    // 暂停档禁用时销毁从隐藏点起算（spec §7.5：pauseMinutes=0 时销毁计时从 hide 起算）
    if cfg.pause_minutes == 0 && cfg.destroy_minutes > 0 && hidden_secs >= minutes_to_secs(cfg.destroy_minutes) {
        track.destroyed = true;
        return ReleaseAction::Destroy;
    }
    ReleaseAction::None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(pause: u32, destroy: u32) -> ReleasePolicyConfig {
        ReleasePolicyConfig { pause_minutes: pause, destroy_minutes: destroy, lock_on_pause: false, lock_on_destroy: true }
    }

    #[test]
    fn visible_window_resets_track() {
        let mut t = ReleaseTrack::default();
        let t0 = std::time::Instant::now();
        assert_eq!(advance(&mut t, &cfg(5, 30), false, false, t0), ReleaseAction::None);
        assert!(t.hidden_since.is_some());
        assert_eq!(advance(&mut t, &cfg(5, 30), true, false, t0), ReleaseAction::None);
        assert!(t.hidden_since.is_none());
    }

    #[test]
    fn pause_fires_after_pause_minutes_then_destroy_after_destroy_minutes() {
        let mut t = ReleaseTrack::default();
        let t0 = std::time::Instant::now();
        let at = |secs: u64| t0 + std::time::Duration::from_secs(secs);
        // 隐藏瞬间 tick：播种 hidden_since=t0（首次 advance 只记时刻不产动作）
        assert_eq!(advance(&mut t, &cfg(5, 30), false, false, t0), ReleaseAction::None);
        assert_eq!(advance(&mut t, &cfg(5, 30), false, false, at(299)), ReleaseAction::None);
        assert_eq!(advance(&mut t, &cfg(5, 30), false, false, at(300)), ReleaseAction::Pause);
        assert!(t.paused_at.is_some());
        assert_eq!(advance(&mut t, &cfg(5, 30), false, false, at(300 + 1799)), ReleaseAction::None);
        assert_eq!(advance(&mut t, &cfg(5, 30), false, false, at(300 + 1800)), ReleaseAction::Destroy);
        assert!(t.destroyed);
        // 已销毁后恒 None，直到 reset（重建/show 路径）
        assert_eq!(advance(&mut t, &cfg(5, 30), false, false, at(99999)), ReleaseAction::None);
    }

    #[test]
    fn disabled_pause_lets_destroy_count_from_hide() {
        let mut t = ReleaseTrack::default();
        let t0 = std::time::Instant::now();
        let at = |secs: u64| t0 + std::time::Duration::from_secs(secs);
        // 隐藏瞬间 tick：播种 hidden_since=t0
        assert_eq!(advance(&mut t, &cfg(0, 30), false, false, t0), ReleaseAction::None);
        assert_eq!(advance(&mut t, &cfg(0, 30), false, false, at(1799)), ReleaseAction::None);
        assert_eq!(advance(&mut t, &cfg(0, 30), false, false, at(1800)), ReleaseAction::Destroy);
    }

    #[test]
    fn all_disabled_means_never_release() {
        let mut t = ReleaseTrack::default();
        let t0 = std::time::Instant::now();
        let far = t0 + std::time::Duration::from_secs(86_400);
        // 各轨道先在隐藏瞬间 t0 播种 hidden_since，far 为其后一天的轮询 tick
        assert_eq!(advance(&mut t, &cfg(0, 0), false, false, t0), ReleaseAction::None);
        assert_eq!(advance(&mut t, &cfg(0, 0), false, false, far), ReleaseAction::None);
        let mut t2 = ReleaseTrack::default();
        assert_eq!(advance(&mut t2, &cfg(5, 0), false, false, t0), ReleaseAction::None);
        assert_eq!(advance(&mut t2, &cfg(5, 0), false, false, far), ReleaseAction::Pause); // 仅暂停档仍生效
        let mut t3 = ReleaseTrack::default();
        assert_eq!(advance(&mut t3, &cfg(0, 30), false, false, t0), ReleaseAction::None);
        assert_eq!(advance(&mut t3, &cfg(0, 30), false, false, far), ReleaseAction::Destroy);
    }

    #[test]
    fn settings_roundtrip_defaults_and_merge_preserves_foreign_keys() {
        assert_eq!(from_settings_text("{}"), ReleasePolicyConfig::default());
        assert_eq!(from_settings_text("not json"), ReleasePolicyConfig::default());
        let merged = merge_into_settings_text(Some(r#"{"mcp":{"enabled":true},"devtools":{"enabled":false,"port":9222}}"#), &cfg(1, 2)).unwrap();
        let v: serde_json::Value = serde_json::from_str(&merged).unwrap();
        assert_eq!(v["mcp"]["enabled"], serde_json::json!(true));
        assert_eq!(v["releasePolicy"]["pauseMinutes"], serde_json::json!(1));
        assert_eq!(v["releasePolicy"]["destroyMinutes"], serde_json::json!(2));
    }
}
