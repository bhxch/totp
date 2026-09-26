use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, Runtime, WindowEvent,
};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

/// 验收条目13：无头 MCP 启动参数解析（--headless-mcp / --mcp-port / --mcp-token）
mod cli;
// 对话框授权登记（F4）与备份/导入文件命令（dirToken 遏制 + 扩展名白名单）
mod dialog_grants;
mod lock_events;
// plan17：内嵌 MCP 服务器（配置/门控/事件桥/Streamable HTTP，接线见 setup 与 invoke_handler）
mod mcp_server;
// 批⑧ §7：窗口资源释放策略（配置读写 + 状态机纯函数；接线层副作用在 lib.rs/Task 13）
mod release_policy;
// 会话暂存槽：剪贴板暂存（F16）与 DEK 暂存槽（销毁档「不锁库」路径）
mod session_vaults;
// settings.json 读写基础件（路径/单键读取/原子写；各分节配置读写见消费方）
mod settings_io;

use dialog_grants::{
    dir_token_os, list_backup_files_os, load_grants, pick_dir_os, pick_open_file_os,
    pick_save_file_os, read_import_file_bytes_os, read_import_file_os, read_text_file_os,
    remove_backup_file, remove_backup_file_os, write_bytes_file_os, write_text_file_os,
    DialogGrants,
};
use session_vaults::{
    clear_clipboard_if_staged, clear_stashed_dek, clipboard_clear_if_staged, dek_slot_clear,
    stash_dek, stage_clipboard_write, take_stashed_dek, CLIPBOARD_STAGE, STASHED_DEK,
};
use settings_io::{read_shortcut_from_settings, settings_path, write_text_atomic};

// mini 最近一次因失焦而隐藏的时刻，用于缓解「托盘点击收起」与「失焦自动隐藏」的竞态
static LAST_FOCUS_HIDE: Mutex<Option<Instant>> = Mutex::new(None);

/// 释放策略状态轨迹（spec 批⑧ §7.2；tick 线程独占读写；任一窗口可见由 advance 内 reset，
/// 窗口重建成功由 ensure_window reset）
static RELEASE_TRACK: Mutex<release_policy::ReleaseTrack> =
    Mutex::new(release_policy::ReleaseTrack::new());

/// 验收条目4：WebView 远程调试配置（settings.json `devtools` 键；明文区——须在无解锁态可读）。
/// 返回 (enabled, port)；缺省 (false, 9222)，enabled=true 而 port<1024 时端口回落 9222
fn read_devtools_from_settings_text(text: &str) -> (bool, u16) {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(text) else {
        return (false, 9222);
    };
    let Some(d) = v.get("devtools") else {
        return (false, 9222);
    };
    let enabled = d.get("enabled").and_then(|x| x.as_bool()).unwrap_or(false);
    let port = d
        .get("port")
        .and_then(|x| x.as_u64())
        .filter(|p| (1024..=65535).contains(p))
        .unwrap_or(9222) as u16;
    (enabled, port)
}

/// 无头模式（windows_subsystem=windows，验收条目13）下尽力附加父进程控制台，使
/// stdout 连接信息在终端启动可见；附加失败（双击启动无宿主控制台等）静默——
/// 托盘「复制 MCP 连接信息」兜底
#[cfg(windows)]
fn attach_parent_console() {
    use windows::Win32::System::Console::{AttachConsole, ATTACH_PARENT_PROCESS};
    unsafe {
        let _ = AttachConsole(ATTACH_PARENT_PROCESS);
    }
}

/// 非 Windows no-op 桩：终端启动天然有 stdout，保持跨平台编译（调用点仅 cfg(windows)，桩防 dead_code）
#[cfg(not(windows))]
#[allow(dead_code)]
fn attach_parent_console() {}

/// devtools 环境注入判定（apply_devtools_env 的可测核心，env 读写留薄壳）：给定 APPDATA 根、
/// tauri.conf 解析值与外部预设态，返回应注入的 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS 值。
/// identifier 缺失/settings.json 读不到/未启用/外部已预设 → None（静默不动，不挤外部参数）
#[cfg(windows)]
fn apply_devtools_env_inner(
    appdata: &std::path::Path,
    conf: &serde_json::Value,
    external_preset: bool,
) -> Option<String> {
    let id = conf.get("identifier")?.as_str()?;
    let text = std::fs::read_to_string(appdata.join(id).join("settings.json")).ok()?;
    let (enabled, port) = read_devtools_from_settings_text(&text);
    if enabled && !external_preset {
        Some(format!("--remote-debugging-port={port}"))
    } else {
        None
    }
}

/// 须在任何 WebView 创建前调用（run() 最早期）；settings.json 路径按
/// Windows app_data_dir 规则 %APPDATA%/{identifier} 解析（mac/linux 无 CDP 端口通道，恒 no-op）
fn apply_devtools_env() {
    #[cfg(windows)]
    {
        let Ok(appdata) = std::env::var("APPDATA") else {
            return;
        };
        let Ok(conf) = include_str!("../tauri.conf.json").parse::<serde_json::Value>() else {
            return;
        };
        // 终审修复：仅在环境变量未设置时注入——外部（调试器/CI/用户 shell）预设的
        // WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS 可能携带其他浏览器参数，无条件覆写会挤掉它们
        let external_preset = std::env::var_os("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").is_some();
        if let Some(value) =
            apply_devtools_env_inner(std::path::Path::new(&appdata), &conf, external_preset)
        {
            std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", value);
        }
    }
}

/// devtools 设置读/写（明文 settings.json；读经 settings_path + 文本解析，写走
/// read-modify-write 合并既有键——settings.json 为 Rust 四组配置 + 前端 AppSettings 共写文件，
/// 任何写侧均不得整文件覆盖丢外来键；落盘复用 write_text_atomic（审查 I-5 原子写））
#[tauri::command]
fn devtools_get_config<R: Runtime>(app: AppHandle<R>) -> Result<serde_json::Value, String> {
    let text = settings_path(&app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .unwrap_or_else(|| "{}".into());
    let (enabled, port) = read_devtools_from_settings_text(&text);
    Ok(serde_json::json!({ "enabled": enabled, "port": port }))
}

#[tauri::command]
fn devtools_set_config<R: Runtime>(
    app: AppHandle<R>,
    enabled: bool,
    port: u16,
) -> Result<(), String> {
    if port < 1024 {
        return Err(format!("端口 {port} 不在允许范围 1024-65535"));
    }
    let path = settings_path(&app).ok_or("无法定位 settings.json".to_string())?;
    // 审查 M6：CDP 与 MCP 同绑 127.0.0.1，端口相同时后启动者 bind 失败且 CDP 侧完全无提示，
    // 保存时前置拒绝（Err 经 invoke 回传设置页展示）；MCP 未启用不拦截
    let mcp = mcp_server::load_mcp_config_inner(&path);
    ensure_devtools_port_free(&mcp, port)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    // 合并既有键：读全文解析后只改 devtools 键，不丢外来键（shortcutToggleMini/mcp 等）
    let text = merge_devtools_config_text(
        std::fs::read_to_string(&path).ok().as_deref(),
        enabled,
        port,
    )?;
    write_text_atomic(&path, &text)
}

/// 审查 M6：devtools 端口与 MCP 端口冲突判定（纯函数便于单测）。两者同绑 127.0.0.1，
/// MCP 已启用且端口相同即拒绝（先启动者占位、后启动者静默失败）；MCP 关闭时同端口
/// 不冲突（未监听），不拦截
fn ensure_devtools_port_free(mcp: &mcp_server::McpConfig, port: u16) -> Result<(), String> {
    if mcp.enabled && mcp.port == port {
        return Err(format!(
            "端口 {port} 已被 MCP 服务器占用（两者同绑 127.0.0.1），请为 WebView 调试另选端口"
        ));
    }
    Ok(())
}

/// 审查 M3：读取既有 settings.json 文本合并 devtools 键，返回落盘文本。根为合法 JSON 但
/// 非对象（[] / "x" 等）时不得走 serde_json IndexMut（root["devtools"]=… 对非对象根 panic），
/// 统一口径 as_object().cloned() 回落空对象重建，不丢外来键
fn merge_devtools_config_text(
    existing: Option<&str>,
    enabled: bool,
    port: u16,
) -> Result<String, String> {
    let mut obj: serde_json::Map<String, serde_json::Value> = existing
        .and_then(|t| serde_json::from_str::<serde_json::Value>(t).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default();
    obj.insert(
        "devtools".into(),
        serde_json::json!({ "enabled": enabled, "port": port }),
    );
    serde_json::to_string_pretty(&serde_json::Value::Object(obj)).map_err(|e| e.to_string())
}

/// 释放策略读/写（spec 批⑧ §7.5；settings.json `releasePolicy` 键，合并写保留外来键）。
/// 参数名 Rust 侧 snake_case + rename_all="camelCase"：前端 invoke 键仍为 pauseMinutes 等（与
/// brief 契约一致），同时满足非 snake_case lint
#[tauri::command(rename_all = "camelCase")]
fn release_policy_get<R: Runtime>(app: AppHandle<R>) -> Result<serde_json::Value, String> {
    let text = settings_path(&app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .unwrap_or_else(|| "{}".into());
    let cfg = release_policy::from_settings_text(&text);
    Ok(serde_json::json!({
        "pauseMinutes": cfg.pause_minutes,
        "destroyMinutes": cfg.destroy_minutes,
        "lockOnPause": cfg.lock_on_pause,
        "lockOnDestroy": cfg.lock_on_destroy,
    }))
}

#[tauri::command(rename_all = "camelCase")]
fn release_policy_set<R: Runtime>(
    app: AppHandle<R>,
    pause_minutes: u32,
    destroy_minutes: u32,
    lock_on_pause: bool,
    lock_on_destroy: bool,
) -> Result<(), String> {
    let path = settings_path(&app).ok_or("无法定位 settings.json".to_string())?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let cfg = release_policy::ReleasePolicyConfig {
        pause_minutes,
        destroy_minutes,
        lock_on_pause,
        lock_on_destroy,
    };
    let text = release_policy::merge_into_settings_text(
        std::fs::read_to_string(&path).ok().as_deref(),
        &cfg,
    )?;
    write_text_atomic(&path, &text)
}

fn toggle_mini(app: &AppHandle) {
    // 释放策略销毁档可能已销毁 webview（仅留托盘进程）：入口先按需重建（brief Task 13）
    ensure_window(app, "mini");
    if let Some(mini) = app.get_webview_window("mini") {
        if mini.is_visible().unwrap_or(false) {
            let _ = mini.hide();
        } else {
            // mini 刚因失焦被隐藏（<300ms）时，本次点击视为「点托盘收起」，保持隐藏
            if let Ok(last) = LAST_FOCUS_HIDE.lock() {
                if let Some(t) = *last {
                    if t.elapsed() < Duration::from_millis(300) {
                        return;
                    }
                }
            }
            let _ = mini.show();
            let _ = mini.set_focus();
        }
    }
}

fn show_main(app: &AppHandle) {
    // 同 toggle_mini：销毁档后先重建再显示（重建窗口 visible:false，此处 show 即恢复可见）
    ensure_window(app, "main");
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.show();
        let _ = main.unminimize();
        let _ = main.set_focus();
    }
}

// ---------- 释放策略接线（spec 批⑧ §7.2-7.3；纯逻辑在 release_policy.rs） ----------

/// 释放 tick 单步：读配置→窗口可见性→advance→执行副作用。30s 轮询由 setup 启动的线程驱动
fn release_tick(app: &AppHandle) {
    let cfg = release_policy::from_settings_text(
        &settings_path(app)
            .and_then(|p| std::fs::read_to_string(p).ok())
            .unwrap_or_else(|| "{}".into()),
    );
    let visible = |label: &str| {
        app.get_webview_window(label)
            .map(|w| w.is_visible().unwrap_or(false))
            .unwrap_or(false)
    };
    // is_visible 是阻塞 getter（dispatcher 请求需主线程事件循环回复），必须在持锁前取值：
    // 持锁调用时若主线程恰在 ensure_window（build 后竞争 RELEASE_TRACK），会形成
    // 「tick 持锁等 is_visible 回复、主线程等 tick 释放锁」的循环等待，应用整体冻结。
    // 锁内只做纯 advance 计算并立刻释放，副作用统一在锁外执行
    let (main_visible, mini_visible) = (visible("main"), visible("mini"));
    let action = {
        let mut track = RELEASE_TRACK.lock().expect("release track poisoned");
        release_policy::advance(&mut track, &cfg, main_visible, mini_visible, Instant::now())
    };
    match release_policy::plan_for(action, &cfg) {
        release_policy::ReleasePlan::LockAndSuspend => {
            let _ = app.emit("force-lock", ());
            // 锁库即清 DEK 暂存槽（Task 14）：锁库路径绝不留跨重建的免解锁通道
            dek_slot_clear(&STASHED_DEK);
            for label in ["main", "mini"] {
                try_suspend_window(app, label);
            }
        }
        release_policy::ReleasePlan::Suspend => {
            for label in ["main", "mini"] {
                try_suspend_window(app, label);
            }
        }
        release_policy::ReleasePlan::Destroy => {
            // 销毁在锁外执行（emit/sleep/destroy 副作用不得持锁，见上方 advance 注释）；
            // 任一 destroy 失败由 apply_destroy_with_rollback 回滚销毁标记（advance 内已
            // 提前置位），下一 tick 重试，防止「轨迹已销毁而窗口仍在」的状态与事实脱节
            //（审查 Task 12 交接项）
            let all_destroyed = destroy_releasable_windows(app, &cfg);
            let mut track = RELEASE_TRACK.lock().expect("release track poisoned");
            release_policy::apply_destroy_with_rollback(&mut track, || all_destroyed);
        }
        release_policy::ReleasePlan::Idle => {}
    }
}

/// 暂停档：WebView2 TrySuspend（要求窗口不可见）；失败/非 Windows 静默降级为维持隐藏
#[cfg(windows)]
fn try_suspend_window(app: &AppHandle, label: &str) {
    let Some(w) = app.get_webview_window(label) else {
        return;
    };
    let _ = w.with_webview(move |webview| {
        use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_3;
        use windows::core::Interface;
        unsafe {
            let Ok(core) = webview.controller().CoreWebView2() else {
                return;
            };
            // brief 原拟 cast ICoreWebView2_6：webview2-com 0.38 绑定中 TrySuspend 实际声明在
            // ICoreWebView2_3（_6 仅有 OpenTaskManagerWindow），以真实绑定为准
            let Ok(wv3) = core.cast::<ICoreWebView2_3>() else {
                return;
            };
            // TrySuspend 为异步：completed handler 在挂起完成后于 UI 线程回调，no-op 即可不阻塞
            //（webview2-com 的 callback 模块私有，TrySuspendCompletedHandler re-export 在 crate 根）
            let handler =
                webview2_com::TrySuspendCompletedHandler::create(Box::new(|_ec, _res| Ok(())));
            // 失败（如已挂起/不可见条件不满足）返回 Err：静默，销毁档计时照常推进
            let _ = wv3.TrySuspend(&handler);
        }
    });
}

/// 非 Windows 桩：暂停档降级为仅维持隐藏（销毁/重建档与平台无关，照常工作）
#[cfg(not(windows))]
fn try_suspend_window(_app: &AppHandle, _label: &str) {}

/// 销毁档：锁库或请求 DEK 暂存 → destroy main+mini（进程与托盘保留）。
/// 返回是否全部销毁成功（任一失败由调用方回滚 RELEASE_TRACK.destroyed 重试）
fn destroy_releasable_windows(app: &AppHandle, cfg: &release_policy::ReleasePolicyConfig) -> bool {
    if cfg.lock_on_destroy {
        let _ = app.emit("force-lock", ());
        // 锁库即清 DEK 暂存槽（Task 14）：同 release_tick Pause 分支，销毁锁库不留免解锁残留
        dek_slot_clear(&STASHED_DEK);
    } else {
        // 不锁库：给前端 1s 窗口执行 stash_dek（Task 14 的监听器），再销毁
        let _ = app.emit("stash-dek-request", ());
        std::thread::sleep(Duration::from_secs(1));
    }
    let mut all_destroyed = true;
    for label in ["main", "mini"] {
        if let Some(w) = app.get_webview_window(label) {
            if w.destroy().is_err() {
                all_destroyed = false;
            }
        }
    }
    all_destroyed
}

/// 按需重建窗口（参数在本函数 builder 内硬编码，非 tauri.conf.json——conf 的 windows 已为 []，
/// 窗口改由代码创建以启用 enable_clipboard_access，见下）；返回是否发生了重建（重建后前端冷启动，
/// 自动走 DEK 回注）。重建成功即 reset 释放轨迹：销毁档置位的 destroyed 由重建解除，隐藏计时从头起算
/// 按需确保窗口存在。enable_clipboard_access（批⑧ 真机修复 2026-09-24）：
/// navigator.clipboard.read 在 WebView2 需要 CLIPBOARD_READ 权限，wry 仅在
/// attributes.clipboard（enable_clipboard_access）时对 PermissionRequested 自动 ALLOW，
/// 默认权限请求永久挂起（promise 永不 settle、按钮无响应——真机实证）。
/// 该开关仅 WebviewWindowBuilder 可配（tauri.conf.json 无对应键），故 main/mini
/// 改由 setup 内经本函数创建（conf 不再声明窗口），销毁重建路径同样生效。
fn ensure_window(app: &AppHandle, label: &str) -> bool {
    if app.get_webview_window(label).is_some() {
        return false;
    }
    let built = match label {
        "main" => tauri::WebviewWindowBuilder::new(
            app,
            "main",
            tauri::WebviewUrl::App("index.html".into()),
        )
        .title("TOTP 验证码工具")
        .inner_size(760.0, 560.0)
        .visible(false)
        .enable_clipboard_access()
        .build(),
        "mini" => tauri::WebviewWindowBuilder::new(
            app,
            "mini",
            tauri::WebviewUrl::App("mini.html".into()),
        )
        .title("TOTP")
        .inner_size(320.0, 420.0)
        .visible(false)
        .skip_taskbar(true)
        .enable_clipboard_access()
        .build(),
        _ => return false,
    };
    if built.is_ok() {
        if let Ok(mut track) = RELEASE_TRACK.lock() {
            track.reset();
        }
        true
    } else {
        false
    }
}

// ---------- DPAPI 解密命令的通用门控（F3） ----------
// 命令注册给 main/mini 两个窗口，Tauri capabilities 无法约束应用自有命令（仅约束插件权限），
// 故在命令体内按窗口 label 收窄：mini 恒不执行导入/解锁/安全卡操作（锁定态迷你窗不可用），
// 暴露面从两个 webview 收窄到主窗口。主窗口 webview 内的脚本仍可调用（该残余边界见各命令注释）。
fn ensure_main_window_label(label: &str) -> Result<(), String> {
    if label == "main" {
        Ok(())
    } else {
        Err("仅主窗口可调用此命令".into())
    }
}

// WinAuth DPAPI 层解密（ CryptUnprotectData，无附加熵，CRYPTPROTECT_UI_FORBIDDEN）。
// 输入/输出约定与 core importWinauth 的 decryptDpapi 回调对齐：输入 base64(密文)，
// 输出 UTF-8 明文——WinAuth 的 DPAPI 明文恒为下一层 payload 的 hex ASCII
// （Authenticator.cs DecryptSequenceNoHash decode=false 路径），故 UTF-8 往返无损。
// F3 门控（诚实边界）：① purpose 须显式为 "winauth-import"——由前端传入，不是安全边界，
// 仅把通用命令收窄为单一用途声明；真正的形状收窄在 ②：明文必须为非空 hex ASCII
// （WinAuth DPAPI 层格式恒如此，非 hex 明文的密文即使可解也无法完成导入，提前在此拒绝）；
// ③ 仅主窗口可调用。残余风险：主窗口 webview 内的恶意脚本仍可解「明文恰为 hex ASCII」的
// 用户态 DPAPI blob——这是 WinAuth 第三方格式导入所需的固有能力。
#[cfg(windows)] // 仅 Windows 版 decrypt_dpapi 消费；Linux runner 的 clippy 门禁编译不到消费方
const WINAUTH_IMPORT_PURPOSE: &str = "winauth-import";

#[cfg(windows)]
fn ensure_winauth_purpose(purpose: &str) -> Result<(), String> {
    if purpose == WINAUTH_IMPORT_PURPOSE {
        Ok(())
    } else {
        Err("不支持的解密用途".into())
    }
}

#[cfg(windows)]
fn is_hex_ascii(text: &str) -> bool {
    !text.is_empty() && text.bytes().all(|b| b.is_ascii_hexdigit())
}

// 最小 base64 解码：仅接受标准字母表（前端 bytesToBase64 输出带 padding），避免为此引第三方依赖。
#[cfg(windows)]
fn base64_decode(input: &str) -> Option<Vec<u8>> {
    fn val(c: u8) -> Option<u32> {
        match c {
            b'A'..=b'Z' => Some((c - b'A') as u32),
            b'a'..=b'z' => Some((c - b'a' + 26) as u32),
            b'0'..=b'9' => Some((c - b'0' + 52) as u32),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }
    let cleaned: Vec<u8> = input.bytes().filter(|b| !b.is_ascii_whitespace()).collect();
    let pad = cleaned.iter().rev().take_while(|&&b| b == b'=').count();
    if pad > 2 {
        return None;
    }
    let data = &cleaned[..cleaned.len() - pad];
    let mut out = Vec::with_capacity(data.len() * 3 / 4 + 3);
    let mut acc: u32 = 0;
    let mut bits = 0u32;
    for &b in data {
        acc = (acc << 6) | val(b)?;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((acc >> bits) & 0xff) as u8);
        }
    }
    Some(out)
}

// 命令体提取为 inner（window label 以 &str 传入，不依赖 Tauri 运行时），供单测直接覆盖门控/形状逻辑
#[cfg(windows)]
fn decrypt_dpapi_inner(window_label: &str, purpose: &str, b64: &str) -> Result<String, String> {
    ensure_main_window_label(window_label)?;
    ensure_winauth_purpose(purpose)?;
    let cipher = base64_decode(b64).ok_or("invalid base64")?;
    if cipher.is_empty() {
        return Err("empty data".into());
    }
    // WinAuth 第三方 blob 恒无附加熵，不得引入（否则存量 WinAuth 文件全部失效）
    let plain = dpapi_unprotect_bytes(&cipher, None)?;
    let text = String::from_utf8(plain).map_err(|_| "DPAPI 明文不是合法 UTF-8".to_string())?;
    if !is_hex_ascii(&text) {
        return Err("DPAPI 明文不符合 WinAuth hex-ASCII 形状".into());
    }
    Ok(text)
}

#[cfg(windows)]
#[tauri::command]
fn decrypt_dpapi(
    window: tauri::WebviewWindow,
    b64: String,
    purpose: String,
) -> Result<String, String> {
    decrypt_dpapi_inner(window.label(), &purpose, &b64)
}

#[cfg(not(windows))]
#[tauri::command]
fn decrypt_dpapi(
    _window: tauri::WebviewWindow,
    _b64: String,
    _purpose: String,
) -> Result<String, String> {
    Err("仅 Windows 支持 DPAPI 解密".into())
}

// 桌面 DPAPI 自动解锁（计划 11 T3）：CryptProtectData/CryptUnprotectData 包裹/解出 vault DEK 本体
// （T1 裁定 wrappedDekD=base64(DPAPI(DEK))），CRYPTPROTECT_UI_FORBIDDEN 禁 UI，base64 进出。
// 与 decrypt_dpapi（WinAuth 导入，明文须 hex ASCII）分开：DEK 是任意字节，走独立命令避免语义混淆。
// 最小 base64 编码：与上方 base64_decode 同理念，标准字母表 + padding，不引第三方依赖。
#[cfg(windows)]
fn base64_encode(data: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            TABLE[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

// DPAPI 字节级核心（F3 重构）：提取 pOptionalEntropy 参数。DEK 通道（下方 dek_*）绑定
// 应用专属附加熵，使包裹/解出对任意第三方与无熵 DPAPI 密文失效；WinAuth 导入路径传 None
// （第三方 blob 恒无熵，不得引入）。CRYPTPROTECT_UI_FORBIDDEN 禁 UI。
#[cfg(windows)]
fn dpapi_protect_bytes(plain: &[u8], entropy: Option<&[u8]>) -> Result<Vec<u8>, String> {
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::{
        CryptProtectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    if plain.is_empty() {
        return Err("empty data".into());
    }
    unsafe {
        let in_blob = CRYPT_INTEGER_BLOB {
            cbData: plain.len() as u32,
            pbData: plain.as_ptr() as *mut u8,
        };
        let entropy_param = entropy.map(|e| CRYPT_INTEGER_BLOB {
            cbData: e.len() as u32,
            pbData: e.as_ptr() as *mut u8,
        });
        let entropy_ptr = entropy_param
            .as_ref()
            .map(|b| b as *const CRYPT_INTEGER_BLOB);
        let mut out_blob = CRYPT_INTEGER_BLOB::default();
        CryptProtectData(
            &in_blob,
            None,
            entropy_ptr,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut out_blob,
        )
        .map_err(|e| format!("DPAPI 加密失败: {e}"))?;
        let cipher = std::slice::from_raw_parts(out_blob.pbData, out_blob.cbData as usize).to_vec();
        let _ = LocalFree(Some(HLOCAL(out_blob.pbData.cast())));
        Ok(cipher)
    }
}

#[cfg(windows)]
fn dpapi_unprotect_bytes(cipher: &[u8], entropy: Option<&[u8]>) -> Result<Vec<u8>, String> {
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::{
        CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    if cipher.is_empty() {
        return Err("empty data".into());
    }
    unsafe {
        let in_blob = CRYPT_INTEGER_BLOB {
            cbData: cipher.len() as u32,
            pbData: cipher.as_ptr() as *mut u8,
        };
        let entropy_param = entropy.map(|e| CRYPT_INTEGER_BLOB {
            cbData: e.len() as u32,
            pbData: e.as_ptr() as *mut u8,
        });
        let entropy_ptr = entropy_param
            .as_ref()
            .map(|b| b as *const CRYPT_INTEGER_BLOB);
        let mut out_blob = CRYPT_INTEGER_BLOB::default();
        CryptUnprotectData(
            &in_blob,
            None,
            entropy_ptr,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut out_blob,
        )
        .map_err(|e| format!("DPAPI 解密失败: {e}"))?;
        let plain = std::slice::from_raw_parts(out_blob.pbData, out_blob.cbData as usize).to_vec();
        let _ = LocalFree(Some(HLOCAL(out_blob.pbData.cast())));
        Ok(plain)
    }
}

// ---------- DEK 包裹通道（F3 收窄：dpapi_* 与 os_auto_* 同语义，仅接受本应用 DEK） ----------
// v2 包裹格式：base64( TOTPDEK1 ‖ DPAPI(DEK, 应用专属附加熵) )。附加熵使解出对任意
// 第三方/无熵 DPAPI 密文失效（DPAPI 层直接失败），版本前缀供旧格式识别与前端迁移判定。
// 旧格式兼容（不 brick 存量用户）：历史 wrappedDekD = base64(DPAPI(DEK))（无前缀无熵）仍可解，
// 但解密结果必须恰为 32 字节 DEK（本通道唯一合法载荷），WinAuth hex 层、第三方口令/密钥等
// 其余用户态 DPAPI 密文一律拒绝；前端在下一次成功解锁后重包为 v2
// （App.vue migrateDekWrapToEntropyBound），逐步淘汰旧格式。
// 残余风险（诚实边界）：① 锁定态下主窗口 webview 仍可解出本应用 wrappedDekD 得到 DEK——这是
// 「静默自动解锁」特性本身（LockScreen 依赖），无法在不砍特性的前提下关闭；② 迁移期内明文恰为
// 32 字节的第三方 blob 仍可经旧格式兜底解出（存量 wrappedDekD 无法与任意 32B 密文区分）。
#[cfg(windows)]
const DEK_WRAP_MARKER: &[u8] = b"TOTPDEK1";
#[cfg(windows)]
const DEK_WRAP_ENTROPY: &[u8] = b"com.totp.desktop/os-auto-unlock/dek";

#[cfg(windows)]
fn dek_protect_inner(window_label: &str, data_b64: &str) -> Result<String, String> {
    ensure_main_window_label(window_label)?;
    let dek = base64_decode(data_b64).ok_or("invalid base64")?;
    if dek.len() != 32 {
        return Err("DEK must be 32 bytes".into());
    }
    let cipher = dpapi_protect_bytes(&dek, Some(DEK_WRAP_ENTROPY))?;
    let mut framed = Vec::with_capacity(DEK_WRAP_MARKER.len() + cipher.len());
    framed.extend_from_slice(DEK_WRAP_MARKER);
    framed.extend_from_slice(&cipher);
    Ok(base64_encode(&framed))
}

#[cfg(windows)]
fn dek_unprotect_inner(window_label: &str, wrapped_b64: &str) -> Result<String, String> {
    ensure_main_window_label(window_label)?;
    let raw = base64_decode(wrapped_b64).ok_or("invalid base64")?;
    let plain = if raw.len() > DEK_WRAP_MARKER.len() && raw.starts_with(DEK_WRAP_MARKER) {
        // v2：应用熵绑定——非本应用 protect 产出的任何密文（含被伪造的前缀）恒解密失败
        dpapi_unprotect_bytes(&raw[DEK_WRAP_MARKER.len()..], Some(DEK_WRAP_ENTROPY))?
    } else {
        // 旧格式兜底（仅迁移期，见上注释）：无熵解密且结果必须为 32B DEK
        dpapi_unprotect_bytes(&raw, None)?
    };
    if plain.len() != 32 {
        return Err("不是本应用的 DEK 包裹（DEK 恒为 32 字节）".into());
    }
    Ok(base64_encode(&plain))
}

// （原 dpapi_protect/dpapi_unprotect 命令已删除：前端唯一调用方 tauriSecurity.ts 的
// dpapiProtectOs/dpapiUnprotectOs 零引用，os_auto_* 与其同一实现且为 SecurityCard/LockScreen
// 实际通道。dek_* inner 与 base64/dpapi_*_bytes 工具仍被 os_auto_* 与 decrypt_dpapi 使用，保留）

// osAutoUnlock 三平台统一通道（计划 15 T14）：Windows 委托 DPAPI；macOS Keychain / Linux
// Secret Service 经 keyring。语义与 DPAPI 对齐：OS 保护 DEK 本体（base64 进出），解锁时静默取回。
// F3：Windows 分支走 v2 DEK 通道（应用附加熵 + 版本前缀 + 32B 旧格式兜底，见 dek_* 注释）；
// 仅主窗口可调用。
// D（诚实边界）：macOS/Linux keyring 分支在 Windows 构建上仅编译门控（cfg 不编译不下载依赖），
// keyring 运行时行为登记 backlog 待真机验证；Windows 委托路径经 roundtrip 单测实跑。
#[cfg(windows)]
#[tauri::command]
fn os_auto_protect(window: tauri::WebviewWindow, data_b64: String) -> Result<String, String> {
    dek_protect_inner(window.label(), &data_b64)
}

#[cfg(windows)]
#[tauri::command]
fn os_auto_unprotect(window: tauri::WebviewWindow, wrapped_b64: String) -> Result<String, String> {
    dek_unprotect_inner(window.label(), &wrapped_b64)
}

// keyring 条目存 base64(DEK)：Keychain/Secret Service 条目本身由 OS 加密，与 DPAPI 语义对齐。
// 返回固定占位串而非 base64(DEK)（审查 2026-09-18 C1）：返回值会经 addDpapiSourceOp 作为
// wrappedDekD 明文落盘 security.json——磁盘上不得出现未包裹的 DEK；os_auto_unprotect
// 恒读同一 service/account 条目并忽略入参，占位串不影响解锁链路。
#[cfg(any(target_os = "macos", target_os = "linux"))]
#[tauri::command]
fn os_auto_protect(window: tauri::WebviewWindow, data_b64: String) -> Result<String, String> {
    ensure_main_window_label(window.label())?;
    let entry = keyring::Entry::new("totp-desktop", "dek").map_err(|e| e.to_string())?;
    entry.set_password(&data_b64).map_err(|e| e.to_string())?;
    Ok("os-keyring".into())
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[tauri::command]
fn os_auto_unprotect(window: tauri::WebviewWindow, _wrapped_b64: String) -> Result<String, String> {
    ensure_main_window_label(window.label())?;
    let entry = keyring::Entry::new("totp-desktop", "dek").map_err(|e| e.to_string())?;
    entry.get_password().map_err(|e| e.to_string())
}

// 审查 M1（C1 遗留）：移除原生自动解锁来源时同步删除 keyring 中的 DEK 条目——
// removeDpapiSourceOp 仅改 security JSON，keyring 条目（service "totp-desktop"/
// account "dek"）解除绑定后会永久残留。条目不存在（NoEntry）不算失败（幂等移除）；
// 其他错误如实上抛由前端 best-effort 处理。Windows/其余平台无独立可删除条目
// （DPAPI 密文随 security.json 删除即消失），报错桩同 dpapi 桩风格
#[cfg(any(target_os = "macos", target_os = "linux"))]
#[tauri::command]
fn os_auto_forget() -> Result<(), String> {
    let entry = keyring::Entry::new("totp-desktop", "dek").map_err(|e| e.to_string())?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
#[tauri::command]
fn os_auto_forget() -> Result<(), String> {
    Err("当前平台无 keyring DEK 条目可删除".into())
}

// 其余平台报错桩（同 dpapi 桩风格）
#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
#[tauri::command]
fn os_auto_protect(_window: tauri::WebviewWindow, _data_b64: String) -> Result<String, String> {
    Err("当前平台不支持 OS 自动解锁".into())
}

#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
#[tauri::command]
fn os_auto_unprotect(
    _window: tauri::WebviewWindow,
    _wrapped_b64: String,
) -> Result<String, String> {
    Err("当前平台不支持 OS 自动解锁".into())
}

pub fn run() {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    // 审查 I-1：接管父控制台必须先于 parse_args——否则参数错误的 eprintln 写在未连接的
    // 句柄上（windows_subsystem=windows 下 stderr 缺省无效），终端启动只见静默 exit(2)。
    // 仅带参启动时附加：双击启动（无参）不触碰控制台，正常 GUI 路径行为不变；附加失败
    // （无宿主控制台等）AttachConsole 返回值被忽略，静默无害（见 attach_parent_console 注释）
    #[cfg(windows)]
    if !args.is_empty() {
        attach_parent_console();
    }
    // 验收条目13：CLI 参数最先解析，失败 stderr + exit(2)（GUI 子系统下仅终端启动可见错误）
    let cli = match cli::parse_args(&args) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("参数错误: {e}");
            std::process::exit(2);
        }
    };
    // 验收条目4：devtools 远程调试端口环境注入必须先于任何 WebView 创建（run 最早期）
    apply_devtools_env();
    // CLI 覆盖仅本次运行生效：内存传递给 setup，绝不落盘 settings.json；
    // headless 无人值守下无条件强制启用 MCP（唯一交互入口，终审修复）
    let mcp_override = mcp_server::McpOverride {
        port: cli.mcp_port,
        token: cli.mcp_token,
        force_enabled: cli.headless_mcp,
    };
    let headless = cli.headless_mcp;
    let mut builder = tauri::Builder::default();
    // B22（E2E 2026-09-26）：单实例判定必须是第一个注册的 plugin——主实例运行时启动第二实例
    // （含 headless 探针）曾因全局快捷键 ALT+SHIFT+T 已注册在 global_shortcut 初始化 panic
    // （exit 101）。插件层检测到已有实例即干净退出（exit 0），回调聚焦既有主窗；headless 主
    // 实例不弹窗（无人值守语义：连接信息只经 stdout/托盘，窗口隐藏存活）。注：「GUI 主实例 +
    // 独立 headless MCP 探针」并行在本修复前即不可用（同快捷键 panic），非回退
    builder = builder.plugin(tauri_plugin_single_instance::init(
        move |app, _argv, _cwd| {
            if headless {
                return;
            }
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        },
    ));
    // 真机 E2E 基建：debug 构建装配 mcp-bridge（仅绑 127.0.0.1）供 tauri-mcp 驱动 UI；release 不编译
    #[cfg(debug_assertions)]
    {
        builder = builder.plugin(
            tauri_plugin_mcp_bridge::Builder::new()
                .bind_address("127.0.0.1")
                .build(),
        );
    }
    builder
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        // F4：对话框授权登记（会话 LRU；setup 内再装载跨会话持久化授权）
        .manage(DialogGrants::default())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_shortcuts(["alt+shift+t"])
                .unwrap()
                .with_handler(|app, _shortcut, event| {
                    if event.state == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        toggle_mini(app);
                    }
                })
                .build(),
        )
        .setup(move |app| {
            // 批⑧ 真机修复：窗口改由 builder 创建（conf 不再声明）以启用页面剪贴板读取
            // （enable_clipboard_access 仅 builder 可配，见 ensure_window 注释）。
            // headless 同样创建：审批弹层/托盘依赖隐藏窗口存活
            ensure_window(app.handle(), "main");
            ensure_window(app.handle(), "mini");
            // plan17：MCP 服务器装配（manage McpState）+ 按配置自动拉起；返回含 CLI 覆盖的
            // 生效 cfg 与真实启动结果，供无头连接信息输出（stdout/托盘复制与实际监听同源）
            let (mcp_cfg, mcp_start) = mcp_server::init_state_and_autostart(app, &mcp_override)?;
            // 验收条目13：无头模式不显示任何窗口。连接信息仅在服务真实监听成功时输出
            // （终审修复：不再与启动结果脱钩——此前 autostart 失败仍打印成功样连接行，
            // 裸 --headless-mcp 且设置关闭时打印空 token 行）。headless 无人值守，失败
            // stderr 明示 + exit(2) 让脚本消费方可感知；非 headless 失败已在装配层
            // eprintln+运行态记录，不拦启动
            if headless {
                match mcp_start {
                    Ok(()) => {
                        // gate 用 serde 线格式（token/wildcard/exact/alwaysAsk，serde camelCase）
                        // 而非 {:?} 调试形式（Wildcard）：脚本消费方按线格式解析；手写 match
                        // 不带通配分支，GateMode 新增变体时编译期强制同步本映射，不会漂移
                        let gate = match mcp_cfg.mode {
                            mcp_server::GateMode::Token => "token",
                            mcp_server::GateMode::Wildcard => "wildcard",
                            mcp_server::GateMode::Exact => "exact",
                            mcp_server::GateMode::AlwaysAsk => "alwaysAsk",
                        };
                        println!(
                            "MCP: http://127.0.0.1:{}  token: {}  gate: {}",
                            mcp_cfg.port, mcp_cfg.token, gate
                        );
                    }
                    Err(e) => {
                        eprintln!("[mcp] headless 启动失败: {e}");
                        std::process::exit(2);
                    }
                }
            } else {
                let _ = mcp_start;
                // 窗口 visible:false 起步（防启动闪现），非 headless 在首帧前同步显示
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                }
            }
            // F4：装载跨会话对话框授权（备份源目录）进会话登记
            load_grants(app.handle());
            // 系统锁屏事件监听（plan16 T15）：Windows 下订阅 WTS_SESSION_LOCK → 前端广播
            // system-lock；非 Windows no-op（mac/Linux 挂账）。前端 App.vue 按设置执行锁定
            lock_events::start(app.handle().clone());
            // C7：按 settings 覆写默认快捷键——unregister_all + on_shortcut 重新注册一次。
            // Builder.with_shortcuts 在 setup 之前执行已注册默认 alt+shift+t，故仅在配置差异时重注册
            let configured = read_shortcut_from_settings(app.handle());
            if configured != "alt+shift+t" {
                let gs = app.global_shortcut();
                if gs.unregister_all().is_ok() {
                    let _ = gs.on_shortcut(configured.as_str(), |a, _s, e| {
                        if e.state == ShortcutState::Pressed {
                            toggle_mini(a);
                        }
                    });
                }
            }
            let show_main_item =
                MenuItem::with_id(app, "show-main", "显示主窗口", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            // 验收条目13：无头模式无窗口可看，托盘补「复制 MCP 连接信息」兜底
            // （文本含 token，写入登记 F16 暂存——托盘退出兜底清除）
            let mcp_info = if headless {
                Some(format!(
                    "MCP: http://127.0.0.1:{}  token: {}",
                    mcp_cfg.port, mcp_cfg.token
                ))
            } else {
                None
            };
            let mcp_info_item = match &mcp_info {
                Some(_) => Some(MenuItem::with_id(
                    app,
                    "copy-mcp-info",
                    "复制 MCP 连接信息",
                    true,
                    None::<&str>,
                )?),
                None => None,
            };
            let mut items: Vec<&dyn tauri::menu::IsMenuItem<_>> = vec![&show_main_item];
            if let Some(item) = &mcp_info_item {
                items.push(item);
            }
            items.push(&quit_item);
            let menu = Menu::with_items(app, &items)?;

            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("TOTP 验证码工具")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_tray_icon_event(|_tray, event| {
                    if let TrayIconEvent::Click {
                        button,
                        button_state: tauri::tray::MouseButtonState::Up,
                        ..
                    } = event
                    {
                        match button {
                            tauri::tray::MouseButton::Left => toggle_mini(_tray.app_handle()),
                            // 中键直达主窗口，省去右键菜单一步（等价「显示主窗口」）
                            tauri::tray::MouseButton::Middle => show_main(_tray.app_handle()),
                            _ => {}
                        }
                    }
                })
                .build(app)?;

            app.on_menu_event(move |app, event| {
                match event.id().as_ref() {
                    "show-main" => show_main(app),
                    // 验收条目13：无头连接信息兜底复制（登记 F16 暂存，托盘退出兜底清除 token）
                    "copy-mcp-info" => {
                        if let Some(text) = &mcp_info {
                            if app.clipboard().write_text(text.clone()).is_ok() {
                                if let Ok(mut s) = CLIPBOARD_STAGE.lock() {
                                    *s = Some(text.clone());
                                }
                            }
                        }
                    }
                    "quit" => {
                        // F16：托盘退出兜底——剪贴板仍持有本应用复制内容时清空（读回比对在 Rust 侧，
                        // 不会误清用户后续复制的外部内容；无暂存/内容已换则不动）
                        clear_clipboard_if_staged(app);
                        // 退出清 DEK 暂存槽（Task 14）：进程内存槽随退出失效，显式清空防语义歧义
                        dek_slot_clear(&STASHED_DEK);
                        app.exit(0)
                    }
                    _ => {}
                }
            });
            // 释放策略 tick：30s 轮询窗口可见性驱动三段释放（spec 批⑧ §7.3——轮询覆盖所有隐藏路径：
            // 关窗拦截/mini 失焦/前端「隐藏到托盘」，无事件盲区；配置每 tick 现读，改设置即时生效）
            let release_handle = app.handle().clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(Duration::from_secs(30));
                release_tick(&release_handle);
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            match event {
                WindowEvent::Focused(false) => {
                    if window.label() == "mini" {
                        if let Ok(mut last) = LAST_FOCUS_HIDE.lock() {
                            *last = Some(Instant::now());
                        }
                        let _ = window.hide();
                    }
                }
                WindowEvent::CloseRequested { api, .. } => {
                    // main 与 mini 点 X 均拦截为隐藏：保证托盘常驻；
                    // mini 被原生标题栏销毁后 get_webview_window("mini") 恒 None，
                    // 托盘左键与 Alt+Shift+T 将永久失效，故必须 prevent_close
                    api.prevent_close();
                    let _ = window.hide();
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            write_text_file_os,
            write_bytes_file_os,
            read_text_file_os,
            read_import_file_os,
            read_import_file_bytes_os,
            remove_backup_file,
            remove_backup_file_os,
            list_backup_files_os,
            pick_dir_os,
            pick_open_file_os,
            pick_save_file_os,
            dir_token_os,
            decrypt_dpapi,
            os_auto_protect,
            os_auto_unprotect,
            os_auto_forget,
            devtools_get_config,
            devtools_set_config,
            release_policy_get,
            release_policy_set,
            stash_dek,
            take_stashed_dek,
            clear_stashed_dek,
            stage_clipboard_write,
            clipboard_clear_if_staged,
            mcp_server::mcp_get_config,
            mcp_server::mcp_set_config,
            mcp_server::mcp_regenerate_token,
            mcp_server::mcp_approval_response,
            mcp_server::mcp_respond,
            mcp_server::mcp_revoke_approvals
        ])
        // build+run（回调形态）：RunEvent::Exit 时注销系统锁屏监听（plan16 T15）；
        // 正常运行路径行为与直接 .run(context) 完全一致
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|_app, event| {
            match event {
                // 批⑧ 真机修复：释放策略销毁档 destroy main+mini 后，Tauri 对「最后窗口
                // 关闭」默认退出——与 spec「仅保留托盘进程」相悖（真机实证进程整体退出）。
                // code=None 即窗口全关触发的退出请求，阻止之；托盘「退出」走 app.exit(0)
                // （code=Some）不受影响。销毁窗口不触发 CloseRequested，prevent_close 拦不到
                tauri::RunEvent::ExitRequested { code, api, .. } => {
                    if code.is_none() {
                        api.prevent_exit();
                    }
                }
                tauri::RunEvent::Exit => {
                    lock_events::shutdown();
                }
                _ => {}
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    // osAutoUnlock 统一通道（Windows 分支委托 DPAPI）：真实 CryptProtectData roundtrip，
    // 断言 base64 进出一致（DEK 是任意字节，32B XChaCha20 key 形态）。仅 Windows 编译；
    // macOS/Linux keyring 分支 cfg 不参与本机构建，运行时行为登记 backlog 真机验证。
    // F3 起命令收窄为 DEK 通道并要求主窗口，测试直接覆盖 dek_* inner（免 Tauri 运行时）。
    #[cfg(windows)]
    #[test]
    fn os_auto_roundtrip_via_dpapi() {
        let data = base64_encode(&[42u8; 32]);
        let wrapped = dek_protect_inner("main", &data).expect("dek_protect_inner");
        assert_ne!(wrapped, data, "DPAPI 密文必须不同于明文 base64");
        let unwrapped = dek_unprotect_inner("main", &wrapped).expect("dek_unprotect_inner");
        assert_eq!(data, unwrapped);
    }

    // F3 v2 包裹格式：base64( TOTPDEK1 ‖ DPAPI(DEK, 应用附加熵) )——包裹输出带版本前缀
    #[cfg(windows)]
    #[test]
    fn dek_wrap_v2_has_marker_prefix() {
        let wrapped = dek_protect_inner("main", &base64_encode(&[1u8; 32])).expect("protect");
        let raw = base64_decode(&wrapped).expect("base64");
        assert!(
            raw.starts_with(DEK_WRAP_MARKER),
            "v2 包裹必须带 TOTPDEK1 前缀"
        );
    }

    // F3：包裹侧强校验 32B——非 DEK 载荷不得进入本通道（窄接口）
    #[cfg(windows)]
    #[test]
    fn dek_protect_rejects_non_32b_payload() {
        assert!(dek_protect_inner("main", &base64_encode(&[1u8; 16])).is_err());
        assert!(dek_protect_inner("main", &base64_encode(&[1u8; 64])).is_err());
    }

    // F3：无熵第三方密文（非 32B 形状，如 WinAuth hex 层/口令文本）经旧格式兜底必须拒绝
    #[cfg(windows)]
    #[test]
    fn dek_unprotect_rejects_foreign_no_entropy_blob() {
        let foreign = dpapi_protect_bytes(
            b"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            None,
        )
        .expect("protect");
        assert!(dek_unprotect_inner("main", &base64_encode(&foreign)).is_err());
    }

    // F3：异熵密文（32B 明文但非本应用熵包裹）必须拒绝——附加熵使通道无法被外部密文复用
    #[cfg(windows)]
    #[test]
    fn dek_unprotect_rejects_wrong_entropy_blob() {
        let foreign =
            dpapi_protect_bytes(&[7u8; 32], Some(b"some-other-app-entropy")).expect("protect");
        assert!(dek_unprotect_inner("main", &base64_encode(&foreign)).is_err());
    }

    // F3 旧格式兜底：历史 wrappedDekD = base64(DPAPI(DEK))（无前缀无熵）仍可解出（不 brick 存量用户）
    #[cfg(windows)]
    #[test]
    fn dek_unprotect_legacy_blob_fallback() {
        let dek = [9u8; 32];
        let legacy = dpapi_protect_bytes(&dek, None).expect("protect legacy");
        let unwrapped =
            dek_unprotect_inner("main", &base64_encode(&legacy)).expect("legacy unwrap");
        assert_eq!(base64_encode(&dek), unwrapped);
    }

    // F3 旧格式兜底形状校验：无熵密文解出非 32B（如 WinAuth hex ASCII 明文）一律拒绝
    #[cfg(windows)]
    #[test]
    fn dek_unprotect_legacy_rejects_non_32b_plaintext() {
        let winauth_shape = dpapi_protect_bytes(
            b"0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF",
            None,
        )
        .expect("protect");
        assert!(dek_unprotect_inner("main", &base64_encode(&winauth_shape)).is_err());
    }

    // F3 重包迁移路径：旧格式解出 DEK → v2 重包（带前缀、密文变化）→ v2 可解出同一 DEK
    // （镜像前端 App.vue migrateDekWrapToEntropyBound：成功解锁后 protect+落盘）
    #[cfg(windows)]
    #[test]
    fn dek_rewrap_migration_path() {
        let dek = [3u8; 32];
        let legacy = dpapi_protect_bytes(&dek, None).expect("protect legacy");
        let legacy_b64 = base64_encode(&legacy);
        // 旧格式最后一次解出（锁定态静默解锁即此路径）
        let unwrapped = dek_unprotect_inner("main", &legacy_b64).expect("legacy unwrap");
        // 解锁后前端以当前 DEK 重包并替换落盘
        let migrated = dek_protect_inner("main", &unwrapped).expect("rewrap");
        assert_ne!(migrated, legacy_b64, "v2 重包密文必须不同于旧格式");
        assert!(base64_decode(&migrated)
            .expect("base64")
            .starts_with(DEK_WRAP_MARKER));
        assert_eq!(
            unwrapped,
            dek_unprotect_inner("main", &migrated).expect("v2 unwrap")
        );
    }

    // F3：DEK 通道仅主窗口可调用（mini 恒不执行解锁）
    #[cfg(windows)]
    #[test]
    fn dek_channel_gated_to_main_window() {
        let data = base64_encode(&[1u8; 32]);
        assert!(dek_protect_inner("mini", &data).is_err());
        assert!(dek_unprotect_inner("mini", "AAAA").is_err());
    }

    // F3：WinAuth 导入命令——用途声明 + 明文 hex-ASCII 形状 + 主窗口门控
    #[cfg(windows)]
    #[test]
    fn decrypt_dpapi_inner_gating_and_shape() {
        assert!(ensure_winauth_purpose("winauth-import").is_ok());
        assert!(ensure_winauth_purpose("anything-else").is_err());
        assert!(is_hex_ascii("0123456789ABCDEF"));
        assert!(!is_hex_ascii(""));
        assert!(!is_hex_ascii("zz"));
        // WinAuth 形状 blob（hex ASCII 明文）+ 正确用途 → 解出原文
        let plain_hex = b"0123456789ABCDEF";
        let blob = dpapi_protect_bytes(plain_hex, None).expect("protect");
        assert_eq!(
            decrypt_dpapi_inner("main", "winauth-import", &base64_encode(&blob)).expect("decrypt"),
            String::from_utf8(plain_hex.to_vec()).unwrap()
        );
        // 用途不符 / 非 hex 明文 / 非主窗口 → 拒绝
        assert!(decrypt_dpapi_inner("main", "wrong-purpose", &base64_encode(&blob)).is_err());
        let non_hex =
            dpapi_protect_bytes("普通文本明文不是 hex".as_bytes(), None).expect("protect");
        assert!(decrypt_dpapi_inner("main", "winauth-import", &base64_encode(&non_hex)).is_err());
        assert!(decrypt_dpapi_inner("mini", "winauth-import", &base64_encode(&blob)).is_err());
    }

    // 验收条目4：devtools 配置解析——缺省关、开启+自定义端口、非法端口回落默认
    #[test]
    fn devtools_config_parse() {
        // 缺省：关
        assert_eq!(read_devtools_from_settings_text("{}"), (false, 9222));
        // 开启 + 自定义端口
        assert_eq!(
            read_devtools_from_settings_text(r#"{"devtools":{"enabled":true,"port":9333}}"#),
            (true, 9333),
        );
        // 非法端口回落默认
        assert_eq!(
            read_devtools_from_settings_text(r#"{"devtools":{"enabled":true,"port":80}}"#),
            (true, 9222),
        );
        // 终审修复补测：高端口越界（u16 上溢形态）回落默认
        assert_eq!(
            read_devtools_from_settings_text(r#"{"devtools":{"enabled":true,"port":70000}}"#),
            (true, 9222),
        );
        // 终审修复补测：devtools 非对象形态（字符串等）整体回落默认（关）
        assert_eq!(
            read_devtools_from_settings_text(r#"{"devtools":"on"}"#),
            (false, 9222)
        );
    }

    // 审查 M3：settings.json 根为合法 JSON 但非对象（[] / "x" / 标量）时 set 不得 panic，
    // devtools 键落到新对象（as_object 回落重建口径；旧实现 IndexMut 直写非对象根会 panic）
    #[test]
    fn devtools_merge_non_object_root_does_not_panic() {
        for root in [r#"["legacy"]"#, r#""x""#, "42", "true", "null"] {
            let text = merge_devtools_config_text(Some(root), true, 9333)
                .unwrap_or_else(|e| panic!("根 {root} 合并不应失败: {e}"));
            let v: serde_json::Value = serde_json::from_str(&text).unwrap();
            assert_eq!(v["devtools"]["enabled"], serde_json::json!(true));
            assert_eq!(v["devtools"]["port"], serde_json::json!(9333));
        }
        // 无既有文件（None）：同口径落到新对象
        let text = merge_devtools_config_text(None, false, 9222).unwrap();
        let v: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(v["devtools"]["port"], serde_json::json!(9222));
    }

    // 合并不丢外来键（settings.json 各写侧共同承诺）：shortcutToggleMini / mcp 原样保留
    #[test]
    fn devtools_merge_preserves_foreign_keys() {
        let existing = r#"{"shortcutToggleMini":"alt+shift+t","mcp":{"enabled":true}}"#;
        let text = merge_devtools_config_text(Some(existing), true, 9333).unwrap();
        let v: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(v["shortcutToggleMini"], "alt+shift+t");
        assert_eq!(v["mcp"]["enabled"], serde_json::json!(true));
        assert_eq!(v["devtools"]["port"], serde_json::json!(9333));
    }

    // 审查 M6：devtools 端口与已启用 MCP 端口相同被拒（同绑 127.0.0.1 后启动者静默失败）；
    // 端口不同、或 MCP 未启用（未监听不冲突）时允许
    #[test]
    fn devtools_port_conflict_with_enabled_mcp() {
        let mcp_on = mcp_server::McpConfig {
            enabled: true,
            port: 9222,
            ..Default::default()
        };
        assert!(ensure_devtools_port_free(&mcp_on, 9222).is_err());
        assert!(ensure_devtools_port_free(&mcp_on, 9223).is_ok());
        let mcp_off = mcp_server::McpConfig {
            enabled: false,
            port: 9222,
            ..Default::default()
        };
        assert!(ensure_devtools_port_free(&mcp_off, 9222).is_ok());
    }

    // ---- devtools 环境注入（盘点 B30：apply_devtools_env 静默边界与「未设才注入」）----

    /// 搭建带（或无）settings.json 的假 APPDATA 根（按用例名隔离，cargo test 并行安全），
    /// 返回其路径。仅 Windows 用例消费（Linux 下 cfg 掉防 dead_code）
    #[cfg(windows)]
    fn devtools_appdata(case: &str, settings_json: Option<&str>) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("totp_devtools_env_{case}"));
        let dir = root.join("com.totp.desktop");
        std::fs::create_dir_all(&dir).unwrap();
        match settings_json {
            Some(text) => std::fs::write(dir.join("settings.json"), text).unwrap(),
            None => {
                std::fs::remove_file(dir.join("settings.json")).ok();
            }
        }
        root
    }

    #[cfg(windows)]
    fn devtools_conf() -> serde_json::Value {
        serde_json::json!({ "identifier": "com.totp.desktop" })
    }

    #[cfg(windows)]
    #[test]
    fn devtools_env_inner_silent_boundaries_and_injection() {
        let conf = devtools_conf();
        // settings.json 读不到（APPDATA 下无此文件）：静默
        let root = devtools_appdata("missing", None);
        assert_eq!(apply_devtools_env_inner(&root, &conf, false), None);
        // conf 缺 identifier：静默
        let root = devtools_appdata(
            "no-ident",
            Some(r#"{"devtools":{"enabled":true,"port":9333}}"#),
        );
        assert_eq!(
            apply_devtools_env_inner(&root, &serde_json::json!({}), false),
            None
        );
        // 未启用（默认关）：静默
        let root = devtools_appdata("disabled", Some("{}"));
        assert_eq!(apply_devtools_env_inner(&root, &conf, false), None);
        // 启用且外部未预设：注入 CDP 端口参数
        let root = devtools_appdata(
            "inject",
            Some(r#"{"devtools":{"enabled":true,"port":9333}}"#),
        );
        assert_eq!(
            apply_devtools_env_inner(&root, &conf, false),
            Some("--remote-debugging-port=9333".into())
        );
        // 启用但外部已预设：不挤掉外部参数（终审修复语义）
        assert_eq!(apply_devtools_env_inner(&root, &conf, true), None);
        std::fs::remove_dir_all(&root).ok();
    }

    // 端到端接线（薄壳 env 读写）：单一用例内完成 env 改写/断言/恢复，进程内其他测试
    // 不触碰 APPDATA 与 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS，无并行竞态。
    // EnvGuard（Drop 恢复现场）：断言失败 panic 时改写的 env 也随栈展开还原，
    // 不向同进程其他测试泄漏 APPDATA 重定向与外部哨兵值
    #[cfg(windows)]
    struct EnvGuard {
        saved_appdata: Option<String>,
        saved_arg: Option<std::ffi::OsString>,
    }

    #[cfg(windows)]
    impl EnvGuard {
        fn save() -> Self {
            Self {
                saved_appdata: std::env::var("APPDATA").ok(),
                saved_arg: std::env::var_os("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"),
            }
        }
    }

    #[cfg(windows)]
    impl Drop for EnvGuard {
        fn drop(&mut self) {
            match self.saved_appdata.take() {
                Some(v) => std::env::set_var("APPDATA", v),
                None => std::env::remove_var("APPDATA"),
            }
            match self.saved_arg.take() {
                Some(v) => std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", v),
                None => std::env::remove_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"),
            }
        }
    }

    #[cfg(windows)]
    #[test]
    fn apply_devtools_env_end_to_end_injects_and_preserves_external_preset() {
        let _guard = EnvGuard::save();
        let root = devtools_appdata("e2e", Some(r#"{"devtools":{"enabled":true,"port":9333}}"#));
        std::env::set_var("APPDATA", &root);
        std::env::remove_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS");
        // 未设：注入
        apply_devtools_env();
        assert_eq!(
            std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").unwrap(),
            "--remote-debugging-port=9333"
        );
        // 已设（外部哨兵）：不被挤掉
        std::env::set_var(
            "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
            "--external-sentinel",
        );
        apply_devtools_env();
        assert_eq!(
            std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").unwrap(),
            "--external-sentinel"
        );
        std::fs::remove_dir_all(&root).ok();
    }
}
