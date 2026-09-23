use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, Runtime, WindowEvent,
};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

/// 验收条目13：无头 MCP 启动参数解析（--headless-mcp / --mcp-port / --mcp-token）
mod cli;
mod lock_events;
// plan17：内嵌 MCP 服务器（配置/门控/事件桥/Streamable HTTP，接线见 setup 与 invoke_handler）
mod mcp_server;
// 批⑧ §7：窗口资源释放策略（配置读写 + 状态机纯函数；接线层副作用在 lib.rs/Task 13）
mod release_policy;

// mini 最近一次因失焦而隐藏的时刻，用于缓解「托盘点击收起」与「失焦自动隐藏」的竞态
static LAST_FOCUS_HIDE: Mutex<Option<Instant>> = Mutex::new(None);

/// 释放策略状态轨迹（spec 批⑧ §7.2；tick 线程独占读写；任一窗口可见由 advance 内 reset，
/// 窗口重建成功由 ensure_window reset）
static RELEASE_TRACK: Mutex<release_policy::ReleaseTrack> =
    Mutex::new(release_policy::ReleaseTrack::new());

// F16 剪贴板暂存（托盘退出兜底清除的唯一事实源）：JS 复制路径经 stage_clipboard_write 写入并登记，
// clipboard_clear_if_staged / 托盘退出时读回比对——内容仍为本应用最近一次复制的值才清空（不误清外部内容）。
// 剪贴板读取只在 Rust 侧进行：不向 webview JS 授予剪贴板读取能力（CSP null 下 read 权限=持续监听原语）。
static CLIPBOARD_STAGE: Mutex<Option<String>> = Mutex::new(None);

/// 托盘退出兜底与 clipboard_clear_if_staged 命令共用：仅当剪贴板内容仍为本应用最近一次复制的值时清空。
/// 读取失败按 fail-safe 处理（宁误清不残留种子）；无暂存/内容已换则不动剪贴板。返回是否实际清空。
fn clear_clipboard_if_staged<R: Runtime>(app: &AppHandle<R>) -> bool {
    let staged = CLIPBOARD_STAGE.lock().ok().and_then(|mut s| s.take());
    let Some(value) = staged else { return false };
    let clipboard = app.clipboard();
    match clipboard.read_text() {
        Ok(current) if current == value => {
            let _ = clipboard.write_text(String::new());
            true
        }
        Ok(_) => false, // 用户已复制外部内容：保留，不误清
        Err(_) => {
            let _ = clipboard.write_text(String::new()); // 读回失败：fail-safe 清空
            true
        }
    }
}

#[tauri::command]
fn stage_clipboard_write(value: String, app: AppHandle) -> Result<(), String> {
    app.clipboard()
        .write_text(value.clone())
        .map_err(|e| e.to_string())?;
    if let Ok(mut s) = CLIPBOARD_STAGE.lock() {
        *s = Some(value);
    }
    Ok(())
}

#[tauri::command]
fn clipboard_clear_if_staged(app: AppHandle) -> bool {
    clear_clipboard_if_staged(&app)
}

// 桌面应用 settings.json：存于 app_data_dir（与前端 createTauriFs 的 baseDir 对齐）。
// 当前唯一可配项为 shortcutToggleMini（toggle mini 的全局快捷键），默认 alt+shift+t；
// 解析失败/字段缺失一律回落到默认值，保证老版本 settings.json 不破坏启动。
fn settings_path<R: Runtime>(app: &AppHandle<R>) -> Option<std::path::PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("settings.json"))
}

fn read_shortcut_from_settings<R: Runtime>(app: &AppHandle<R>) -> String {
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
pub(crate) fn write_text_atomic(path: &std::path::Path, contents: &str) -> Result<(), String> {
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

fn write_shortcut_to_settings<R: Runtime>(
    app: &AppHandle<R>,
    shortcut: &str,
) -> Result<(), String> {
    let p = settings_path(app).ok_or_else(|| "settings path unavailable".to_string())?;
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    // 合并既有键：避免读到 settings.json 后只写快捷键覆盖其他字段
    let mut obj: serde_json::Map<String, serde_json::Value> = std::fs::read_to_string(&p)
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default();
    obj.insert(
        "shortcutToggleMini".into(),
        serde_json::Value::String(shortcut.into()),
    );
    write_text_atomic(
        &p,
        &serde_json::to_string_pretty(&obj).map_err(|e| e.to_string())?,
    )
}

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
        let Some(id) = conf["identifier"].as_str() else {
            return;
        };
        let Ok(text) = std::fs::read_to_string(
            std::path::Path::new(&appdata)
                .join(id)
                .join("settings.json"),
        ) else {
            return;
        };
        let (enabled, port) = read_devtools_from_settings_text(&text);
        // 终审修复：仅在环境变量未设置时写入——外部（调试器/CI/用户 shell）预设的
        // WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS 可能携带其他浏览器参数，无条件覆写会挤掉它们
        if enabled && std::env::var_os("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").is_none() {
            std::env::set_var(
                "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
                format!("--remote-debugging-port={port}"),
            );
        }
    }
}

/// devtools 设置读/写（明文 settings.json；读经 settings_path + 文本解析，写走
/// read-modify-write 合并既有键——同 write_shortcut_to_settings(lib.rs:99) 的合并口径，
/// 落盘复用其内部的 write_text_atomic（审查 I-5 原子写），不得整文件覆盖丢外来键）
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
    // 合并既有键：同 write_shortcut_to_settings——读全文解析后只改 devtools 键，不丢外来键
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
/// 与 write_shortcut_to_settings 同口径 as_object().cloned() 回落空对象重建，不丢外来键
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
    let text = release_policy::merge_into_settings_text(std::fs::read_to_string(&path).ok().as_deref(), &cfg)?;
    write_text_atomic(&path, &text)
}

/** 取消注册当前所有快捷键，按新 spec 重新注册并持久化到 settings.json */
#[tauri::command]
fn set_global_shortcut(app: AppHandle, shortcut: String) -> Result<(), String> {
    if shortcut.trim().is_empty() {
        return Err("empty shortcut".into());
    }
    let gs = app.global_shortcut();
    gs.unregister_all().map_err(|e| e.to_string())?;
    gs.on_shortcut(shortcut.as_str(), |app, _shortcut, event| {
        if event.state == ShortcutState::Pressed {
            toggle_mini(app);
        }
    })
    .map_err(|e| e.to_string())?;
    write_shortcut_to_settings(&app, &shortcut)
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
    match action {
        release_policy::ReleaseAction::Pause => {
            if cfg.lock_on_pause {
                let _ = app.emit("force-lock", ());
            }
            for label in ["main", "mini"] {
                try_suspend_window(app, label);
            }
        }
        release_policy::ReleaseAction::Destroy => {
            if !destroy_releasable_windows(app, &cfg) {
                // 任一 destroy 失败：回滚销毁标记（advance 内已提前置位），下一 tick 重试，
                // 防止「轨迹已销毁而窗口仍在」的状态与事实脱节（审查 Task 12 交接项）
                if let Ok(mut track) = RELEASE_TRACK.lock() {
                    track.destroyed = false;
                }
            }
        }
        release_policy::ReleaseAction::None => {}
    }
}

/// 暂停档：WebView2 TrySuspend（要求窗口不可见）；失败/非 Windows 静默降级为维持隐藏
#[cfg(windows)]
fn try_suspend_window(app: &AppHandle, label: &str) {
    let Some(w) = app.get_webview_window(label) else { return };
    let _ = w.with_webview(move |webview| {
        use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_3;
        use windows::core::Interface;
        unsafe {
            let Ok(core) = webview.controller().CoreWebView2() else { return };
            // brief 原拟 cast ICoreWebView2_6：webview2-com 0.38 绑定中 TrySuspend 实际声明在
            // ICoreWebView2_3（_6 仅有 OpenTaskManagerWindow），以真实绑定为准
            let Ok(wv3) = core.cast::<ICoreWebView2_3>() else { return };
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

/// 按需重建窗口（tauri.conf.json 同参）；返回是否发生了重建（重建后前端冷启动，自动走 DEK 回注）。
/// 重建成功即 reset 释放轨迹：销毁档置位的 destroyed 由重建解除，隐藏计时从头起算
fn ensure_window(app: &AppHandle, label: &str) -> bool {
    if app.get_webview_window(label).is_some() {
        return false;
    }
    let built = match label {
        "main" => tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::App("index.html".into()))
            .title("TOTP 验证码工具")
            .inner_size(760.0, 560.0)
            .visible(false)
            .build(),
        "mini" => tauri::WebviewWindowBuilder::new(app, "mini", tauri::WebviewUrl::App("mini.html".into()))
            .title("TOTP")
            .inner_size(320.0, 420.0)
            .visible(false)
            .skip_taskbar(true)
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

// ---------- 备份/导入文件命令 ----------
// 信任边界（F4 根修）：read/write_text_file_os 等命令的遏制基准不再接受前端 IPC 自证的
// allowed_dir（前端以 parentDirOf(同一路径) 自证派生，遏制比较按构造恒真）。现在对话框由
// Rust 侧打开（pick_dir_os / pick_open_file_os / pick_save_file_os），选中目录 canonicalize
// 后登记进 DialogGrants 并返回不透明 token，文件命令以 dirToken 反查登记目录做遏制；
// 扩展名白名单（备份 .totpbackup / 导入扩展名组）保持不变，防被前端脚本当任意读写原语。
// remove_backup_file 仅允许 AppData/backups 下的合法备份名（白名单防路径穿越）。

/// 会话授权登记容量上限（简易 LRU：超出逐出最旧；持久化文件同受此约束）
const GRANT_CAP: usize = 16;
/// 跨会话授权文件（AppData 下：目录对话框登记时后端写入，启动时装载）
const GRANTS_FILE: &str = "dialog_grants.json";

/** 对话框授权登记：token（OS CSPRNG 随机，不可预测）→ canonical 目录。
 *  跨会话说明：备份源目录的自动/手动备份在重启后仍需静默写盘，无法要求每次重弹对话框，
 *  故 pick_dir_os 登记时把目录持久化到 GRANTS_FILE、启动时装载。诚实边界：该文件位于
 *  webview 可写的 AppData（fs:allow-appdata-write-recursive），被持久化 XSS 污染的下一个
 *  会话可借篡改该文件登记任意目录——跨会话授权弱于本会话对话框登记；本设计消除的是
 *  运行中会话「自证参数直通任意路径」的读/写/删原语。文件对话框（导出/恢复/导入）只在
 *  会话内登记，不落盘。 */
#[derive(Default)]
struct DialogGrants {
    // 简易 LRU：front=最旧（登记/命中序），容量 GRANT_CAP
    entries: Mutex<Vec<(String, std::path::PathBuf)>>,
}

fn random_token() -> String {
    let mut buf = [0u8; 16];
    getrandom::fill(&mut buf).expect("OS CSPRNG 不可用");
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

impl DialogGrants {
    /** 登记目录（须已 canonicalize）：同目录复用既有 token（刷新为最近使用），超限逐出最旧 */
    fn register(&self, canonical: std::path::PathBuf) -> String {
        let mut g = self.entries.lock().unwrap();
        if let Some(i) = g.iter().position(|(_, d)| *d == canonical) {
            let (token, dir) = g.remove(i);
            g.push((token.clone(), dir));
            return token;
        }
        if g.len() >= GRANT_CAP {
            g.remove(0);
        }
        let token = random_token();
        g.push((token.clone(), canonical));
        token
    }

    /** token 反查登记目录（命中刷新为最近使用）；未知 token 拒绝 */
    fn resolve(&self, token: &str) -> Result<std::path::PathBuf, String> {
        let mut g = self.entries.lock().unwrap();
        let Some(i) = g.iter().position(|(t, _)| t == token) else {
            return Err("unknown dir token".into());
        };
        let (t, d) = g.remove(i);
        g.push((t, d.clone()));
        Ok(d)
    }

    /** 按已 canonicalize 的目录反查 token：备份源仅持久化路径字符串，重启后经此重取句柄 */
    fn token_for(&self, canonical: &std::path::Path) -> Option<String> {
        self.entries
            .lock()
            .unwrap()
            .iter()
            .find(|(_, d)| d == canonical)
            .map(|(t, _)| t.clone())
    }

    fn canonical_dirs(&self) -> Vec<std::path::PathBuf> {
        self.entries
            .lock()
            .unwrap()
            .iter()
            .map(|(_, d)| d.clone())
            .collect()
    }
}

fn grants_store_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join(GRANTS_FILE))
}

/// 启动装载：持久化授权 → 会话登记（目录已不存在则丢弃）
fn load_grants(app: &tauri::AppHandle) {
    let Some(p) = grants_store_path(app) else {
        return;
    };
    let Ok(text) = std::fs::read_to_string(p) else {
        return;
    };
    let Ok(dirs) = serde_json::from_str::<Vec<String>>(&text) else {
        return;
    };
    let state = app.state::<DialogGrants>();
    for d in dirs {
        if let Ok(c) = std::fs::canonicalize(&d) {
            state.register(c);
        }
    }
}

/// 目录登记后的持久化（best-effort：写失败不影响本会话授权，仅影响重启后的自动备份）
fn persist_grants(app: &tauri::AppHandle) {
    let Some(p) = grants_store_path(app) else {
        return;
    };
    if let Ok(json) = serde_json::to_string_pretty(&app.state::<DialogGrants>().canonical_dirs()) {
        let _ = std::fs::write(p, json);
    }
}

fn valid_backup_name(name: &str) -> bool {
    // 白名单：vault- 前缀、.totpbackup 后缀、不含路径分隔符与 ..，防路径穿越
    name.starts_with("vault-")
        && name.ends_with(".totpbackup")
        && !name.contains('/')
        && !name.contains('\\')
        && !name.contains("..")
}

/** C9/F4：校验 path.parent() 必须落在后端登记目录内，canonicalize 双侧防 symlink/相对路径逃逸 */
fn ensure_within(path: &std::path::Path, allowed_dir: &std::path::Path) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "invalid path: no parent".to_string())?;
    let abs_parent = std::fs::canonicalize(parent).map_err(|e| e.to_string())?;
    let abs_allowed = std::fs::canonicalize(allowed_dir).map_err(|e| e.to_string())?;
    if !abs_parent.starts_with(&abs_allowed) {
        return Err("path outside allowed dir".into());
    }
    Ok(())
}

// ---------- 对话框命令（F4：授权源头收归后端）----------
// 对话框只在用户交互时出现：前端即便被 XSS 调 pick_* 也只能弹出用户可见的系统对话框，
// 无法静默取得授权；文件命令全部要 dirToken，前端自证 allowed_dir 参数已删除。

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PickedPath {
    dir_token: String,
    path: String,
}

#[derive(serde::Deserialize)]
struct DialogFilter {
    name: String,
    extensions: Vec<String>,
}

/// 登记选中「目录」本身（备份源目录），并持久化跨会话授权
fn grant_dir(app: &tauri::AppHandle, dir: std::path::PathBuf) -> Result<PickedPath, String> {
    let canonical = std::fs::canonicalize(&dir).map_err(|e| e.to_string())?;
    let token = app.state::<DialogGrants>().register(canonical);
    persist_grants(app);
    Ok(PickedPath {
        dir_token: token,
        path: dir.to_string_lossy().to_string(),
    })
}

/// 登记选中「文件所在父目录」（导出保存/打开读取为单次会话流，不落盘）。
/// save 选中的新文件尚不存在，须对父目录 canonicalize（对话框保证父目录已存在）
fn grant_file_parent(
    app: &tauri::AppHandle,
    file: std::path::PathBuf,
) -> Result<PickedPath, String> {
    let dir = file
        .parent()
        .ok_or_else(|| "invalid path: no parent".to_string())?
        .to_path_buf();
    let canonical = std::fs::canonicalize(&dir).map_err(|e| e.to_string())?;
    let token = app.state::<DialogGrants>().register(canonical);
    Ok(PickedPath {
        dir_token: token,
        path: file.to_string_lossy().to_string(),
    })
}

/// 目录选择（备份源目录）：Rust 打开系统对话框 → canonical 登记 + 持久化 → {token, path}
#[tauri::command]
async fn pick_dir_os(app: tauri::AppHandle) -> Result<Option<PickedPath>, String> {
    let Some(fp) = app.dialog().file().blocking_pick_folder() else {
        return Ok(None);
    };
    grant_dir(&app, fp.into_path().map_err(|e| e.to_string())?).map(Some)
}

/// 文件打开（备份恢复/导入）：同上，登记父目录，过滤器与旧前端对话框一致
#[tauri::command]
async fn pick_open_file_os(
    app: tauri::AppHandle,
    filters: Vec<DialogFilter>,
) -> Result<Option<PickedPath>, String> {
    let mut b = app.dialog().file();
    for f in &filters {
        let exts: Vec<&str> = f.extensions.iter().map(|s| s.as_str()).collect();
        b = b.add_filter(f.name.clone(), &exts);
    }
    let Some(fp) = b.blocking_pick_file() else {
        return Ok(None);
    };
    grant_file_parent(&app, fp.into_path().map_err(|e| e.to_string())?).map(Some)
}

/// 文件保存（备份导出）：default_name 为缺省文件名，登记保存位置父目录
#[tauri::command]
async fn pick_save_file_os(
    app: tauri::AppHandle,
    default_name: String,
    filters: Vec<DialogFilter>,
) -> Result<Option<PickedPath>, String> {
    let mut b = app.dialog().file().set_file_name(default_name);
    for f in &filters {
        let exts: Vec<&str> = f.extensions.iter().map(|s| s.as_str()).collect();
        b = b.add_filter(f.name.clone(), &exts);
    }
    let Some(fp) = b.blocking_save_file() else {
        return Ok(None);
    };
    grant_file_parent(&app, fp.into_path().map_err(|e| e.to_string())?).map(Some)
}

/// 备份源目录重取会话 token：仅对已登记（对话框授权过/启动装载）的 canonical 目录发放
#[tauri::command]
fn dir_token_os(app: tauri::AppHandle, dir: String) -> Result<String, String> {
    let canonical = std::fs::canonicalize(&dir).map_err(|e| e.to_string())?;
    app.state::<DialogGrants>()
        .token_for(&canonical)
        .ok_or_else(|| "dir not granted via dialog".into())
}

#[tauri::command]
fn remove_backup_file(app: tauri::AppHandle, name: String) -> Result<(), String> {
    if !valid_backup_name(&name) {
        return Err("invalid backup name".into());
    }
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("backups");
    std::fs::remove_file(dir.join(name)).map_err(|e| e.to_string())
}

/// 命令本体抽为 *_granted inner（tauri::State 单测无法构造，测试直打 inner，单一代码路径）
fn remove_backup_file_granted(
    grants: &DialogGrants,
    path: &str,
    dir_token: &str,
) -> Result<(), String> {
    let p = std::path::Path::new(path);
    let name = p
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    if !valid_backup_name(&name) {
        return Err("invalid backup name".into());
    }
    ensure_within(p, &grants.resolve(dir_token)?)?;
    std::fs::remove_file(p).map_err(|e| e.to_string())
}

/// 用户自选备份目录的删除命令（D4/F4）：与 remove_backup_file 同守护（白名单名 + ensure_within），
/// 只是授权目录从「AppData/backups 固定值」改为「dirToken 反查的后端登记目录（对话框授权）」
#[tauri::command]
fn remove_backup_file_os(
    grants: tauri::State<DialogGrants>,
    path: String,
    dir_token: String,
) -> Result<(), String> {
    remove_backup_file_granted(&grants, &path, &dir_token)
}

fn list_backup_files_granted(
    grants: &DialogGrants,
    dir_token: &str,
) -> Result<Vec<String>, String> {
    let dir = grants.resolve(dir_token)?;
    let rd = std::fs::read_dir(&dir).map_err(|e| e.to_string())?;
    let mut names: Vec<String> = rd
        .flatten()
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|n| {
            valid_backup_name(n) || (n.starts_with("conflict-") && n.ends_with(".totpbackup"))
        })
        .collect();
    names.sort();
    Ok(names)
}

/// 用户自选备份目录的列举命令（D4/F4）：不做 ensure_within——dir 本身即对话框授权目标
/// （dirToken 反查登记目录），列举仅返回白名单名
/// （vault-*.totpbackup 与 conflict-*.totpbackup），不泄露目录内其他文件
#[tauri::command]
fn list_backup_files_os(
    grants: tauri::State<DialogGrants>,
    dir_token: String,
) -> Result<Vec<String>, String> {
    list_backup_files_granted(&grants, &dir_token)
}

#[tauri::command]
fn read_text_file_os(
    grants: tauri::State<DialogGrants>,
    path: String,
    dir_token: String,
) -> Result<String, String> {
    // 扩展名白名单：与写侧对齐；本命令唯一用途是读取备份文件，
    // 限定 .totpbackup 防止被前端 XSS 当作任意文件读取原语
    if !path.ends_with(".totpbackup") {
        return Err("invalid backup file extension".into());
    }
    let p = std::path::Path::new(&path);
    if !p.is_file() {
        return Err("not a file".into());
    }
    ensure_within(p, &grants.resolve(&dir_token)?)?;
    std::fs::read_to_string(p).map_err(|e| e.to_string())
}

fn write_text_file_granted(
    grants: &DialogGrants,
    path: String,
    contents: String,
    dir_token: &str,
) -> Result<(), String> {
    if path.is_empty() {
        return Err("empty path".into());
    }
    // 扩展名白名单：本命令用途是备份导出（.totpbackup）与文本导出（批① §2.3：otpauth 文本
    // .txt / Aegis JSON .json，均经 pick_save_file_os 对话框授权）；CSP 为 null 的现状下，
    // 任意路径+任意内容写入等于 XSS 任意文件覆写原语，故仍限定扩展名集合
    const EXPORT_EXTENSIONS: [&str; 3] = [".totpbackup", ".json", ".txt"];
    let lower = path.to_lowercase();
    if !EXPORT_EXTENSIONS.iter().any(|ext| lower.ends_with(ext)) {
        return Err("invalid export file extension".into());
    }
    let p = std::path::Path::new(&path);
    if p.is_dir() {
        return Err("path is a directory".into());
    }
    ensure_within(p, &grants.resolve(dir_token)?)?;
    std::fs::write(path, contents).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_text_file_os(
    grants: tauri::State<DialogGrants>,
    path: String,
    contents: String,
    dir_token: String,
) -> Result<(), String> {
    write_text_file_granted(&grants, path, contents, &dir_token)
}

/// 二进制写盘（批① §2.5 多选二维码拼版 PNG 保存）：与 write_text_file_granted 同守护
/// （固定扩展名白名单 + dirToken 登记目录遏制），但 contents 为原始字节（Vec<u8>，
/// invoke JSON 数组通道），PNG 等二进制不经 UTF-8 文本管道防编码损坏。
/// 扩展名集合按本命令用途固定为 .png（不复用文本侧 .totpbackup/.json/.txt，也不把 .png
/// 加进文本命令——文本写 PNG 必然损坏，各命令用途与白名单一一对应）
fn write_bytes_file_granted(
    grants: &DialogGrants,
    path: String,
    contents: Vec<u8>,
    dir_token: &str,
) -> Result<(), String> {
    if path.is_empty() {
        return Err("empty path".into());
    }
    const IMAGE_EXTENSIONS: [&str; 1] = [".png"];
    let lower = path.to_lowercase();
    if !IMAGE_EXTENSIONS.iter().any(|ext| lower.ends_with(ext)) {
        return Err("invalid image file extension".into());
    }
    let p = std::path::Path::new(&path);
    if p.is_dir() {
        return Err("path is a directory".into());
    }
    ensure_within(p, &grants.resolve(dir_token)?)?;
    std::fs::write(path, contents).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_bytes_file_os(
    grants: tauri::State<DialogGrants>,
    path: String,
    contents: Vec<u8>,
    dir_token: String,
) -> Result<(), String> {
    write_bytes_file_granted(&grants, path, contents, &dir_token)
}

// ---------- 导入文件命令 ----------
// 与 read_text_file_os 同构：信任边界一致（路径经 pick_open_file_os 的登记授权，dirToken 反查登记目录遏制），
// 扩展名白名单限定导入用途，防止被前端 XSS 当作任意文件读取原语。

#[tauri::command]
fn read_import_file_os(
    grants: tauri::State<DialogGrants>,
    path: String,
    dir_token: String,
) -> Result<String, String> {
    // WinAuth(.wauth/.xml)、Aegis(.json/.aegis)、纯文本 URI 批量(.txt)
    const IMPORT_EXTENSIONS: [&str; 5] = [".json", ".wauth", ".xml", ".txt", ".aegis"];
    let lower = path.to_lowercase();
    if !IMPORT_EXTENSIONS.iter().any(|ext| lower.ends_with(ext)) {
        return Err("invalid import file extension".into());
    }
    let p = std::path::Path::new(&path);
    if !p.is_file() {
        return Err("not a file".into());
    }
    ensure_within(p, &grants.resolve(&dir_token)?)?;
    std::fs::read_to_string(p).map_err(|e| e.to_string())
}

// 导入文件字节读取（SQLite 等二进制格式，ImportCard 字节入口）：与 read_import_file_os 同构，
// 白名单在其基础上加 .db/.sqlitedb/.sqlite 与 AP 加密 zip 的 .zip；返回原始字节（invoke JSON 数组），不经 UTF-8 文本管道
#[tauri::command]
fn read_import_file_bytes_os(
    grants: tauri::State<DialogGrants>,
    path: String,
    dir_token: String,
) -> Result<Vec<u8>, String> {
    const IMPORT_BYTE_EXTENSIONS: [&str; 9] = [
        ".json",
        ".wauth",
        ".xml",
        ".txt",
        ".aegis",
        ".db",
        ".sqlitedb",
        ".sqlite",
        ".zip",
    ];
    let lower = path.to_lowercase();
    if !IMPORT_BYTE_EXTENSIONS
        .iter()
        .any(|ext| lower.ends_with(ext))
    {
        return Err("invalid import file extension".into());
    }
    let p = std::path::Path::new(&path);
    if !p.is_file() {
        return Err("not a file".into());
    }
    ensure_within(p, &grants.resolve(&dir_token)?)?;
    std::fs::read(p).map_err(|e| e.to_string())
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
const WINAUTH_IMPORT_PURPOSE: &str = "winauth-import";

fn ensure_winauth_purpose(purpose: &str) -> Result<(), String> {
    if purpose == WINAUTH_IMPORT_PURPOSE {
        Ok(())
    } else {
        Err("不支持的解密用途".into())
    }
}

fn is_hex_ascii(text: &str) -> bool {
    !text.is_empty() && text.bytes().all(|b| b.is_ascii_hexdigit())
}

// 最小 base64 解码：仅接受标准字母表（前端 bytesToBase64 输出带 padding），避免为此引第三方依赖。
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

#[cfg(windows)]
#[tauri::command]
fn dpapi_protect(window: tauri::WebviewWindow, data_b64: String) -> Result<String, String> {
    dek_protect_inner(window.label(), &data_b64)
}

#[cfg(windows)]
#[tauri::command]
fn dpapi_unprotect(window: tauri::WebviewWindow, wrapped_b64: String) -> Result<String, String> {
    dek_unprotect_inner(window.label(), &wrapped_b64)
}

#[cfg(not(windows))]
#[tauri::command]
fn dpapi_protect(_window: tauri::WebviewWindow, _data_b64: String) -> Result<String, String> {
    Err("仅 Windows 支持 DPAPI".into())
}

#[cfg(not(windows))]
#[tauri::command]
fn dpapi_unprotect(_window: tauri::WebviewWindow, _wrapped_b64: String) -> Result<String, String> {
    Err("仅 Windows 支持 DPAPI".into())
}

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
                    Ok(()) => println!(
                        "MCP: http://127.0.0.1:{}  token: {}  gate: {:?}",
                        mcp_cfg.port, mcp_cfg.token, mcp_cfg.mode
                    ),
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
            dpapi_protect,
            dpapi_unprotect,
            os_auto_protect,
            os_auto_unprotect,
            os_auto_forget,
            set_global_shortcut,
            devtools_get_config,
            devtools_set_config,
            release_policy_get,
            release_policy_set,
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
            if let tauri::RunEvent::Exit = event {
                lock_events::shutdown();
            }
        });
}

// repo 首批 Rust 单测：覆盖备份 os 命令的纯守护逻辑（白名单/登记目录遏制）与
// F4 对话框授权登记（token 发放反查/未知拒绝/LRU 上限），
// 文件系统用 std::env::temp_dir 隔离，不依赖 Tauri runtime
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn valid_backup_name_accepts_vault_prefixed() {
        assert!(valid_backup_name("vault-20260916-120000.totpbackup"));
    }

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

    #[test]
    fn valid_backup_name_rejects_traversal_and_conflict() {
        // 白名单仅 vault- 前缀：路径穿越与 conflict- 副本均不可经删除命令触达
        assert!(!valid_backup_name("../x.totpbackup"));
        assert!(!valid_backup_name("conflict-1.totpbackup"));
    }

    #[test]
    fn ensure_within_rejects_path_outside_allowed_dir() {
        let base = std::env::temp_dir().join("totp_ensure_within_test");
        let allowed = base.join("allowed");
        let other = base.join("other");
        std::fs::create_dir_all(&allowed).unwrap();
        std::fs::create_dir_all(&other).unwrap();
        let outside = other.join("vault-20260916-120000.totpbackup");
        std::fs::write(&outside, "x").unwrap();
        assert!(ensure_within(&outside, &allowed).is_err());
        let inside = allowed.join("vault-20260916-120000.totpbackup");
        std::fs::write(&inside, "x").unwrap();
        assert!(ensure_within(&inside, &allowed).is_ok());
        std::fs::remove_dir_all(&base).ok();
    }

    // ---------- F4 对话框授权登记（DialogGrants）单测 ----------

    #[test]
    fn grants_register_resolve_roundtrip_and_token_for() {
        let g = DialogGrants::default();
        let dir = std::env::temp_dir().join("totp_grants_roundtrip");
        std::fs::create_dir_all(&dir).unwrap();
        let canonical = std::fs::canonicalize(&dir).unwrap();
        let token = g.register(canonical.clone());
        assert_eq!(g.resolve(&token).unwrap(), canonical);
        assert_eq!(g.token_for(&canonical).as_deref(), Some(token.as_str()));
        // 未登记目录无 token 可反查
        assert_eq!(g.token_for(canonical.parent().unwrap()), None);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn grants_unknown_token_rejected() {
        let g = DialogGrants::default();
        let dir = std::env::temp_dir().join("totp_grants_unknown");
        std::fs::create_dir_all(&dir).unwrap();
        g.register(std::fs::canonicalize(&dir).unwrap());
        assert!(g.resolve("forged-token").is_err());
        assert!(g.resolve("").is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn grants_same_dir_reuses_token_and_stays_single_entry() {
        let g = DialogGrants::default();
        let dir = std::env::temp_dir().join("totp_grants_dedupe");
        std::fs::create_dir_all(&dir).unwrap();
        let canonical = std::fs::canonicalize(&dir).unwrap();
        let t1 = g.register(canonical.clone());
        let t2 = g.register(canonical.clone());
        assert_eq!(t1, t2);
        assert_eq!(g.canonical_dirs().len(), 1);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn grants_lru_cap_evicts_oldest() {
        let g = DialogGrants::default();
        let base = std::env::temp_dir().join("totp_grants_lru");
        std::fs::create_dir_all(&base).unwrap();
        let mut tokens = Vec::new();
        // 登记 GRANT_CAP+1 个目录：首个被逐出，登记总量稳定在 GRANT_CAP
        for i in 0..=GRANT_CAP {
            let d = base.join(format!("d{i}"));
            std::fs::create_dir_all(&d).unwrap();
            tokens.push(g.register(std::fs::canonicalize(&d).unwrap()));
        }
        assert!(g.resolve(&tokens[0]).is_err(), "最旧授权必须被 LRU 逐出");
        assert!(
            g.resolve(&tokens[GRANT_CAP]).is_ok(),
            "最新授权必须仍在登记"
        );
        assert_eq!(g.canonical_dirs().len(), GRANT_CAP);
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn remove_backup_file_os_deletes_within_granted_dir_only() {
        let base = std::env::temp_dir().join("totp_rm_os_test");
        let allowed = base.join("allowed");
        std::fs::create_dir_all(&allowed).unwrap();
        let grants = DialogGrants::default();
        let token = grants.register(std::fs::canonicalize(&allowed).unwrap());
        let name = "vault-20260916-120000.totpbackup";
        let target = allowed.join(name);
        std::fs::write(&target, "x").unwrap();
        remove_backup_file_granted(&grants, target.to_str().unwrap(), &token).unwrap();
        assert!(!target.exists());
        // 登记目录之外的同名文件：白名单名也必须拒绝删除（遏制基准=后端登记目录，非前端自证）
        let outside = base.join(name);
        std::fs::write(&outside, "x").unwrap();
        assert!(remove_backup_file_granted(&grants, outside.to_str().unwrap(), &token).is_err());
        assert!(outside.exists());
        // 未知 token（未授权句柄）拒绝删除
        std::fs::write(&target, "x").unwrap();
        assert!(
            remove_backup_file_granted(&grants, target.to_str().unwrap(), "forged-token").is_err()
        );
        assert!(target.exists());
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn write_text_file_granted_enforces_extension_and_containment() {
        let base = std::env::temp_dir().join("totp_write_os_test");
        let allowed = base.join("allowed");
        std::fs::create_dir_all(&allowed).unwrap();
        let grants = DialogGrants::default();
        let token = grants.register(std::fs::canonicalize(&allowed).unwrap());
        // 登记目录内合法备份名：写入成功
        let target = allowed.join("vault-20260916-120000.totpbackup");
        write_text_file_granted(
            &grants,
            target.to_str().unwrap().into(),
            "{}".into(),
            &token,
        )
        .unwrap();
        assert!(target.exists());
        // 文本导出（批① §2.3）：白名单内 .txt/.json（大小写不敏感）写入成功
        let txt = allowed.join("totp-export.txt");
        write_text_file_granted(
            &grants,
            txt.to_str().unwrap().into(),
            "otpauth://".into(),
            &token,
        )
        .unwrap();
        assert!(txt.exists());
        let json = allowed.join("aegis-export.JSON");
        write_text_file_granted(&grants, json.to_str().unwrap().into(), "{}".into(), &token)
            .unwrap();
        assert!(json.exists());
        // 非白名单扩展名拒绝
        let exe = allowed.join("evil.exe");
        assert!(write_text_file_granted(
            &grants,
            exe.to_str().unwrap().into(),
            "{}".into(),
            &token
        )
        .is_err());
        assert!(!exe.exists());
        // 登记目录之外（.totpbackup 合法名）遏制拒绝且不落盘
        let outside = base.join("vault-20260916-120000.totpbackup");
        assert!(write_text_file_granted(
            &grants,
            outside.to_str().unwrap().into(),
            "{}".into(),
            &token
        )
        .is_err());
        assert!(!outside.exists());
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn write_bytes_file_granted_enforces_extension_and_containment() {
        let base = std::env::temp_dir().join("totp_write_bytes_os_test");
        let allowed = base.join("allowed");
        std::fs::create_dir_all(&allowed).unwrap();
        let grants = DialogGrants::default();
        let token = grants.register(std::fs::canonicalize(&allowed).unwrap());
        // 登记目录内 .png（大小写不敏感）：字节写入成功且内容保真
        let png = allowed.join("totp-qr-sheet.PNG");
        let bytes: Vec<u8> = vec![0x89, 0x50, 0x4E, 0x47, 0x00, 0xFF];
        write_bytes_file_granted(&grants, png.to_str().unwrap().into(), bytes.clone(), &token)
            .unwrap();
        assert_eq!(std::fs::read(&png).unwrap(), bytes);
        // 非白名单扩展名拒绝（含文本侧合法的 .txt/.totpbackup——各命令白名单独立，不互通）
        for name in ["evil.exe", "note.txt", "vault-20260916-120000.totpbackup"] {
            let p = allowed.join(name);
            assert!(write_bytes_file_granted(
                &grants,
                p.to_str().unwrap().into(),
                bytes.clone(),
                &token
            )
            .is_err());
            assert!(!p.exists());
        }
        // 登记目录之外（.png 合法扩展名）遏制拒绝且不落盘
        let outside = base.join("totp-qr-sheet.png");
        assert!(
            write_bytes_file_granted(&grants, outside.to_str().unwrap().into(), bytes, &token)
                .is_err()
        );
        assert!(!outside.exists());
        std::fs::remove_dir_all(&base).ok();
    }

    // 审查 I12（F4 重写）：授权基准不再有 allowed_dir IPC 入参；等价保障为「非规范形态的
    // 目录路径（大小写差异/\\?\ verbatim 前缀，对话框或持久化值可能携带）canonicalize 后
    // 与登记目录归一，文件路径同样归一命中」。仅 Windows 可跑（依赖 NTFS 大小写不敏感与 \\?\ 语义）
    #[cfg(windows)]
    #[test]
    fn dir_grants_normalize_case_variant_and_verbatim_forms() {
        let base = std::env::temp_dir().join("totp_grants_case_test");
        let allowed = base.join("Allowed");
        std::fs::create_dir_all(&allowed).unwrap();
        let grants = DialogGrants::default();
        let canonical = std::fs::canonicalize(&allowed).unwrap();
        assert!(canonical.to_str().unwrap().starts_with(r"\\?\"));
        // 形态一：小写形态登记（canonicalize 归一为磁盘实际大小写）与真实形态为同一登记
        let lower = std::fs::canonicalize(allowed.to_str().unwrap().to_lowercase()).unwrap();
        let t_lower = grants.register(lower);
        let t_canonical = grants.register(canonical.clone());
        assert_eq!(t_lower, t_canonical, "同目录不同大小写形态归一为同一登记");
        // 形态二：verbatim 形态文件路径删除命中同一登记（ensure_within canonicalize(父) 归一）；
        // canonical 本身即 \\?\ 前缀形态，直接拼子路径构造 verbatim 文件路径
        let name = "vault-20260916-120000.totpbackup";
        let target = canonical.join(name);
        std::fs::write(&target, "x").unwrap();
        let verbatim_path = format!("{}{}{name}", canonical.display(), std::path::MAIN_SEPARATOR);
        remove_backup_file_granted(&grants, &verbatim_path, &t_canonical).unwrap();
        assert!(!target.exists());
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn list_backup_files_os_returns_sorted_vault_and_conflict_only() {
        let base = std::env::temp_dir().join("totp_list_os_test");
        std::fs::create_dir_all(&base).unwrap();
        for n in [
            "vault-20260916-120001.totpbackup",
            "vault-20260916-120000.totpbackup",
            "conflict-20260916-120000.totpbackup",
            "conflict-foo.txt",
            "secret.txt",
        ] {
            std::fs::write(base.join(n), "x").unwrap();
        }
        let grants = DialogGrants::default();
        let token = grants.register(std::fs::canonicalize(&base).unwrap());
        let names = list_backup_files_granted(&grants, &token).unwrap();
        assert_eq!(
            names,
            vec![
                "conflict-20260916-120000.totpbackup".to_string(),
                "vault-20260916-120000.totpbackup".to_string(),
                "vault-20260916-120001.totpbackup".to_string(),
            ]
        );
        std::fs::remove_dir_all(&base).ok();
    }

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

    // 合并不丢外来键（write_shortcut_to_settings 同承诺）：shortcutToggleMini / mcp 原样保留
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
}
