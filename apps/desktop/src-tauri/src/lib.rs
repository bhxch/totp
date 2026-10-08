use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Listener, Manager, Runtime, WindowEvent,
};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

/// 验收条目13：无头 MCP 启动参数解析（--headless-mcp / --mcp-port / --mcp-token）
mod cli;
// 云备份出网 command（2026-09-30 CORS/代理设计）：reqwest 无 CORS，每源 proxy 在 command 内生效
mod cloud_http;
// ABE 提权服务帧协议（plan p6 §0.1）：管道名/marker/消息类型/错误码与帧编解码单点定义。
// 纯逻辑无 IO，但属提权链路（Global Constraints：服务/提权代码全部 cfg(windows) 门控，
// Linux clippy CI 门禁），消费方（elevation_service/client）均为 Windows 专属
#[cfg(windows)]
mod elevation_proto;
// ABE 提权服务主体（plan p6 §0.1/§0.2）：LocalSystem 服务循环（命名管道+调用者验证+
// DEK 包裹代理）。全部提权代码 cfg(windows) 门控（Global Constraints，Linux clippy CI 门禁）
#[cfg(windows)]
mod elevation_service;
// ABE 提权安装/卸载（plan p6 §0.2）：UAC 单命令装服务+ProgramData 副本+HKLM 绑定
#[cfg(windows)]
mod elevation_install;
// ABE 安装/服务诊断日志（Task 10）：elog = stderr + %ProgramData%\TotpTools\service
// 落盘薄层——GUI 子系统与 SCM 上下文 stderr 不可见，落盘是提权链路唯一可诊断面。
// 仅提权链路（全 cfg(windows)）消费，非 Windows 无消费方，模块整体门控防 dead_code
#[cfg(windows)]
mod elevation_log;
// ABE 提权服务应用侧客户端（plan p6 §T4）：管道打开/帧收发/Status/Unwrap/Remove。
// 纯 Windows 提权链路，cfg(windows) 门控（Global Constraints）
#[cfg(windows)]
mod elevation_client;
// ABE 提权 Tauri 命令层（plan p6 §T4）：abe_status/abe_bind/abe_remove。全平台编译
// （generate_handler! 宏不支持条目级 cfg，注册无条件；Windows 真实现内部走
// elevation_client/install，非 Windows supported:false 桩——见模块头注释）
mod elevation_commands;
// 对话框授权登记（F4）与备份/导入文件命令（dirToken 遏制 + 扩展名白名单）
mod dialog_grants;
mod lock_events;
// plan17：内嵌 MCP 服务器（配置/门控/事件桥/Streamable HTTP，接线见 setup 与 invoke_handler）
mod mcp_server;
// 批⑧ §7：窗口资源释放策略（配置读写 + 状态机纯函数；接线层副作用在 lib.rs/Task 13）
mod release_policy;
// 平台安全通道：DPAPI 门控（F3）、DEK 包裹通道、osAutoUnlock 三平台统一通道
mod platform_security;
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
use platform_security::{decrypt_dpapi, os_auto_forget, os_auto_protect, os_auto_unprotect};
use session_vaults::{
    clear_clipboard_if_staged, clear_mini_dek, clear_stashed_dek, clipboard_clear_if_staged,
    dek_slot_clear, dek_slots_clear_on_lock, peek_mini_dek, set_mini_dek, stage_clipboard_write,
    stash_dek, take_stashed_dek, CLIPBOARD_STAGE, STASHED_DEK,
};
use settings_io::{
    read_section, read_section_text, read_settings_text, read_shortcut_from_settings,
    settings_path, write_section,
};

// mini 最近一次因失焦而隐藏的时刻，用于缓解「托盘点击收起」与「失焦自动隐藏」的竞态
static LAST_FOCUS_HIDE: Mutex<Option<Instant>> = Mutex::new(None);

// ---------- mini 托盘定位（spec §1.3）：点击处弹出 + 上次位置恢复 ----------
static LAST_MINI_POS: Mutex<Option<(i32, i32)>> = Mutex::new(None);

// ---------- mini 窗口尺寸记忆（2026-10-09 可调尺寸起）：物理像素 (w, h)，恢复时机同位置 ----------
static LAST_MINI_SIZE: Mutex<Option<(u32, u32)>> = Mutex::new(None);

// ---------- mini pin（spec §1.5）：settings.json miniPinned 键 + 内存缓存；失焦/复制后自动隐藏均让位 ----------
static MINI_PINNED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

// ---------- mini ready 门控（spec §2.4）：重建后等前端首屏就绪再 show（2s 超时兜底） ----------
static MINI_READY_TX: Mutex<Option<std::sync::mpsc::Sender<()>>> = Mutex::new(None);

/// R1-I1：重建在途标志——重建路径（入口缺窗）置位，waiter 回主线程 show（或 2s 超时兜底）
/// 完成后清零。2s ready 窗口内二次 toggle_mini（快捷键连按）看到窗口已建（is_none=false）
/// 且不可见，若无此标志会误走非重建 show 分支绕过 ready 门控（首屏就绪前 show = 冷启动空白一闪）
static MINI_REBUILD_INFLIGHT: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

/// toggle_mini 动作判定（纯函数，R1-M6 状态机层单测）：输入窗口可见性、重建在途、失焦隐藏
/// 距今，输出动作。优先级：可见→收起；刚失焦隐藏（<300ms 防抖）→保持隐藏；重建在途→仅定位
/// 不 show（show 统一收敛到 ready waiter 回主线程处，封堵二次触发旁路）；其余→定位后立即 show
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MiniToggleAction {
    /// 窗口可见：记忆位置并收起
    Hide,
    /// 刚失焦隐藏（<300ms）：本次点击视为「点托盘收起」，保持隐藏
    KeepHidden,
    /// 重建在途（本次发起或 ready 窗口内二次触发）：仅更新位置，show 由 waiter 统一执行
    RepositionOnly,
    /// 常规弹出：定位后立即 show+focus
    Show,
}

fn mini_toggle_action(
    visible: bool,
    rebuild_inflight: bool,
    since_focus_hide: Option<Duration>,
) -> MiniToggleAction {
    if visible {
        return MiniToggleAction::Hide;
    }
    if since_focus_hide.is_some_and(|t| t < Duration::from_millis(300)) {
        return MiniToggleAction::KeepHidden;
    }
    if rebuild_inflight {
        return MiniToggleAction::RepositionOnly;
    }
    MiniToggleAction::Show
}

/// 释放策略状态轨迹（spec 批⑧ §7.2；tick 线程独占读写；任一窗口可见由 advance 内 reset，
/// 窗口重建成功由 ensure_window reset）
static RELEASE_TRACK: Mutex<release_policy::ReleaseTrack> =
    Mutex::new(release_policy::ReleaseTrack::new());

/// 验收条目4：WebView 远程调试配置（settings.json `devtools` 键；明文区——须在无解锁态可读）。
/// 返回 (enabled, port)；缺省 (false, 9222)，enabled=true 而 port<1024 时端口回落 9222。
/// 文本→分节外壳经 settings_io::read_section_text 单点（R9），字段级回默认为本命令手写语义
fn read_devtools_from_settings_text(text: &str) -> (bool, u16) {
    devtools_from_section(read_section_text(text, "devtools").as_ref())
}

/// devtools 分节字段提取（read_devtools_from_settings_text 的可测核心；None=缺键/解析失败回默认）
fn devtools_from_section(section: Option<&serde_json::Value>) -> (bool, u16) {
    let Some(d) = section else {
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

/// devtools 设置读/写（明文 settings.json；读外壳经 read_settings_text 单点，写经
/// write_section 单点合并既有键——settings.json 为 Rust 四组配置 + 前端 AppSettings 共写文件，
/// 任何写侧均不得整文件覆盖丢外来键；落盘复用 write_text_atomic（审查 I-5 原子写））
/// F8(B4)：get_config 返回形状单点（enabled/port/envPreset）——AppHandle 无关的可测核心
/// （同 devtools_from_section 手法）。envPreset=外部已设 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS：
/// 此时 apply_devtools_env 的注入被跳过（external_preset 分支），应用内开关虽开 CDP 也不生效，
/// 随配置返回供前端提示「CDP 无响应的可能原因」
fn devtools_config_json(enabled: bool, port: u16) -> serde_json::Value {
    let env_preset = std::env::var_os("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").is_some();
    serde_json::json!({ "enabled": enabled, "port": port, "envPreset": env_preset })
}

#[tauri::command]
fn devtools_get_config<R: Runtime>(app: AppHandle<R>) -> Result<serde_json::Value, String> {
    let (enabled, port) = read_devtools_from_settings_text(&read_settings_text(&app));
    Ok(devtools_config_json(enabled, port))
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
    // 合并既有键：只改 devtools 键，不丢外来键（shortcutToggleMini/mcp 等；R9 收口 settings_io）
    write_section(
        &app,
        "devtools",
        &serde_json::json!({ "enabled": enabled, "port": port }),
    )
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

/// 释放策略读/写（spec 批⑧ §7.5；settings.json `releasePolicy` 键，合并写保留外来键）。
/// R9：struct 带 serde rename_all="camelCase"+Serialize——get 直接序列化 struct 返回，
/// set 由 4 个 invoke 参数构造 struct 后经 write_section Serialize 写节（合并写/原子写
/// 单点在 settings_io）；读取侧 from_settings_text 仍为手写逐字段回退（红线裁定）。
/// 参数名 Rust 侧 snake_case + rename_all="camelCase"：前端 invoke 键仍为 pauseMinutes 等（与
/// brief 契约一致），同时满足非 snake_case lint
#[tauri::command(rename_all = "camelCase")]
fn release_policy_get<R: Runtime>(app: AppHandle<R>) -> Result<serde_json::Value, String> {
    let cfg = release_policy::from_settings_text(&read_settings_text(&app));
    serde_json::to_value(&cfg).map_err(|e| e.to_string())
}

#[tauri::command(rename_all = "camelCase")]
fn release_policy_set<R: Runtime>(
    app: AppHandle<R>,
    pause_minutes: u32,
    destroy_minutes: u32,
    lock_on_pause: bool,
    lock_on_destroy: bool,
) -> Result<(), String> {
    let cfg = release_policy::ReleasePolicyConfig {
        pause_minutes,
        destroy_minutes,
        lock_on_pause,
        lock_on_destroy,
    };
    write_section(&app, "releasePolicy", &cfg)
}

/// mini pin 读取（spec §1.5）：前端按钮初值与 Rust 失焦守卫共用同一缓存真源
#[tauri::command]
fn mini_pin_get() -> bool {
    MINI_PINNED.load(std::sync::atomic::Ordering::Relaxed)
}

/// mini pin 设置：settings.json 合并写 + 缓存 + 对存活窗口即时生效（重建恢复走 builder）。
/// R1-M3：写盘成功后才更新内存缓存——写失败返回 Err 时缓存保持旧值，不出现
/// 「盘上旧值、内存新值」的失配（失焦守卫/前端初值读的都是这份缓存）
#[tauri::command]
fn mini_pin_set<R: Runtime>(app: AppHandle<R>, pinned: bool) -> Result<(), String> {
    write_section(&app, "miniPinned", &pinned)?;
    MINI_PINNED.store(pinned, std::sync::atomic::Ordering::Relaxed);
    if let Some(mini) = app.get_webview_window("mini") {
        let _ = mini.set_always_on_top(pinned);
    }
    Ok(())
}

/// 纯几何（单测覆盖）：窗口右下角贴近托盘图标——右缘对齐图标右缘、底缘贴图标顶缘；
/// clamp 进显示器工作区（任务栏任意边/多显示器不溢出）。win 大于工作区时 clamp 区间
/// 退化（max 取 min 兜底防 i32::clamp panic）。输入输出全物理像素。
// 10 参签名为 brief 接口契约（扁平整型入参便于纯函数单测），不加结构体包装
#[allow(clippy::too_many_arguments)]
fn mini_position_for_tray(
    tray_x: f64,
    tray_y: f64,
    tray_w: f64,
    tray_h: f64,
    win_w: i32,
    win_h: i32,
    work_x: i32,
    work_y: i32,
    work_w: u32,
    work_h: u32,
) -> (i32, i32) {
    // tray_h 暂不参与（底缘贴图标顶缘只用 tray_y），参数保留接口对称性
    let _ = tray_h;
    let max_x = (work_x + work_w as i32 - win_w).max(work_x);
    let max_y = (work_y + work_h as i32 - win_h).max(work_y);
    let x = ((tray_x + tray_w) as i32 - win_w).clamp(work_x, max_x);
    let y = (tray_y as i32 - win_h).clamp(work_y, max_y);
    (x, y)
}

/// 隐藏前记忆 mini 位置与尺寸（Focused(false)/CloseRequested/托盘 toggle 三路径共用），
/// 供销毁重建后快捷键打开恢复。参数取 Window：on_window_event 回调只给 Window，
/// WebviewWindow 侧经 as_ref().window() 廉价克隆进入
fn remember_mini_pos(window: &tauri::Window) {
    if let Ok(p) = window.outer_position() {
        if let Ok(mut g) = LAST_MINI_POS.lock() {
            *g = Some((p.x, p.y));
        }
    }
    // 尺寸与位置同源记忆（无边框窗 outer==inner）：可调尺寸后销毁重建路径才能保住用户拖出的形态
    if let Ok(s) = window.outer_size() {
        if let Ok(mut g) = LAST_MINI_SIZE.lock() {
            *g = Some((s.width, s.height));
        }
    }
}

/// 按托盘 anchor 定位 mini（物理像素）；monitor/尺寸不可得仅留痕不阻塞弹出
fn position_mini_at_tray(mini: &tauri::WebviewWindow, anchor: (f64, f64, f64, f64)) {
    let (tray_x, tray_y, tray_w, tray_h) = anchor;
    let Ok(size) = mini.outer_size() else { return };
    let mon = mini
        .app_handle()
        .monitor_from_point(tray_x + tray_w / 2.0, tray_y + tray_h / 2.0)
        .ok()
        .flatten();
    let (x, y) = match &mon {
        Some(m) => {
            let wa = m.work_area();
            mini_position_for_tray(
                tray_x,
                tray_y,
                tray_w,
                tray_h,
                size.width as i32,
                size.height as i32,
                wa.position.x,
                wa.position.y,
                wa.size.width,
                wa.size.height,
            )
        }
        None => (
            (tray_x + tray_w) as i32 - size.width as i32,
            tray_y as i32 - size.height as i32,
        ),
    };
    if let Err(e) = mini.set_position(tauri::PhysicalPosition::new(x, y)) {
        eprintln!("[tray] mini set_position failed: {e}");
    }
}

fn toggle_mini(app: &AppHandle, anchor: Option<(f64, f64, f64, f64)>) {
    // 释放策略销毁档可能已销毁 webview（仅留托盘进程）：入口先按需重建（brief Task 13）
    // 重建路径（spec §2.4）：入口判定缺窗即挂 ready 通道——通道挂载先于建窗，
    // 前端首屏 emit 不会落在建窗与等待之间丢失；非重建路径 ready_rx 为 None 零等待
    let mut ready_rx: Option<std::sync::mpsc::Receiver<()>> = None;
    let mut rebuild_inflight = MINI_REBUILD_INFLIGHT.load(std::sync::atomic::Ordering::Relaxed);
    if app.get_webview_window("mini").is_none() {
        let (tx, rx) = std::sync::mpsc::channel();
        // 先挂通道再建窗：前端首屏 emit 不会落在建窗与等待之间丢失
        if let Ok(mut g) = MINI_READY_TX.lock() {
            *g = Some(tx);
        }
        ready_rx = Some(rx);
        // R1-I1：重建在途显式化（waiter 完成后清零）——2s ready 窗口内二次触发凭此标志
        // 走 RepositionOnly，不再误判为常规弹出绕过 ready 门控
        MINI_REBUILD_INFLIGHT.store(true, std::sync::atomic::Ordering::Relaxed);
        rebuild_inflight = true;
    }
    ensure_window(app, "mini");
    let Some(mini) = app.get_webview_window("mini") else {
        return;
    };
    // is_visible 是阻塞 getter，先取值再进纯函数判定；失焦隐藏时刻转 elapsed（None=未记录）
    let visible = mini.is_visible().unwrap_or(false);
    let since_focus_hide = LAST_FOCUS_HIDE
        .lock()
        .ok()
        .and_then(|g| g.map(|t| t.elapsed()));
    let action = mini_toggle_action(visible, rebuild_inflight, since_focus_hide);
    match action {
        MiniToggleAction::Hide => {
            remember_mini_pos(&mini.as_ref().window());
            let _ = mini.hide();
        }
        MiniToggleAction::KeepHidden => {
            // mini 刚因失焦被隐藏（<300ms）时，本次点击视为「点托盘收起」，保持隐藏
        }
        MiniToggleAction::RepositionOnly | MiniToggleAction::Show => {
            // 定位先于 show（不可见期移动无闪烁）：托盘点击=每次锚定托盘；
            // 快捷键=恢复上次位置（销毁重建后亦然），无记忆则 OS 默认。
            // 尺寸恢复先于两条定位分支（position_mini_at_tray 按当前 outer_size 算托盘锚点几何，
            // 先恢复尺寸锚点才贴合拖大后的窗体）
            if let Ok(g) = LAST_MINI_SIZE.lock() {
                if let Some((w, h)) = *g {
                    let _ = mini.set_size(tauri::PhysicalSize::new(w, h));
                }
            }
            if let Some(a) = anchor {
                position_mini_at_tray(&mini, a);
            } else if let Ok(g) = LAST_MINI_POS.lock() {
                if let Some((x, y)) = *g {
                    let _ = mini.set_position(tauri::PhysicalPosition::new(x, y));
                }
            }
            match ready_rx {
                // 重建路径：等待必须在独立线程（主线程同步 recv_timeout 会锁死消息泵，
                // 终审 Important-1，2026-10-06），就绪/超时后由 waiter 回主线程统一 show
                Some(rx) => spawn_mini_ready_waiter(app, rx),
                None => {
                    // RepositionOnly 且无 ready_rx = 重建在途的二次触发（R1-I1）：
                    // 定位已更新，show 收敛到 waiter，不在此立即 show 绕过 ready 门控
                    if action == MiniToggleAction::Show {
                        let shown = mini.show();
                        // show 返回 Err 仅在窗口句柄失效等异常态，留痕；「show 成功但随即被
                        // 失焦自动隐藏收回」是 mini 的产品行为（Focused(false) 在未 pin 时
                        // hide），后台进程 SetForegroundWindow 被前台锁拒绝时即出现，非缺陷
                        if let Err(e) = shown {
                            eprintln!("[shortcut] toggle_mini: mini.show() failed: {e}");
                        }
                        let _ = mini.set_focus();
                    }
                }
            }
        }
    }
}

/// ready waiter（spec §2.4）：等待必须在独立线程——本回调运行于主线程事件循环，前端 emit 的
/// WebMessageReceived 派发同样依赖主线程消息泵，同步 recv_timeout 会自我锁死到超时并冻结
/// 主线程（终审 Important-1，2026-10-06）。就绪/超时后回主线程 show+focus；is_visible 复查
/// 防陈旧等待者复活用户已手动收起的窗口。show 失败留痕对齐非重建分支（R1-M4）；回主线程
/// 即清重建在途标志（R1-I1，主线程串行执行与 toggle_mini 不交叠），此后二次触发恢复正常弹出
fn spawn_mini_ready_waiter(app: &AppHandle, rx: std::sync::mpsc::Receiver<()>) {
    let app2 = app.clone();
    std::thread::spawn(move || {
        let _ = rx.recv_timeout(Duration::from_secs(2));
        // 内层再克隆：app2 作为 run_on_main_thread 接收者被借用期间不能
        // 同时被 move 进闭包（E0505），闭包持独立句柄
        let app3 = app2.clone();
        let _ = app2.run_on_main_thread(move || {
            MINI_REBUILD_INFLIGHT.store(false, std::sync::atomic::Ordering::Relaxed);
            if let Some(m) = app3.get_webview_window("mini") {
                if !m.is_visible().unwrap_or(false) {
                    if let Err(e) = m.show() {
                        eprintln!("[shortcut] toggle_mini: mini.show() failed: {e}");
                    }
                    let _ = m.set_focus();
                }
            }
        });
    });
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
    let cfg = release_policy::from_settings_text(&read_settings_text(app));
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
            // 锁库即清全部 DEK 槽（Task 14 + C1 审查修复 2026-10-01）：锁库路径绝不留跨重建的
            // 免解锁通道——MINI_DEK 若只靠 force-lock 事件→主窗 JS→clear_mini_dek 两跳异步链清除，
            // 本档 emit 后随即 TrySuspend，事件大概率来不及落地，下次 mini 聚焦重建会 peek 到残留
            // DEK 自动解锁而主窗保持锁定（击穿「主窗已锁、mini 仍明文」不变量），故 Rust 侧同步清
            dek_slots_clear_on_lock();
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
        // 锁库即清全部 DEK 槽（Task 14 + C1 审查修复 2026-10-01）：同 release_tick 锁库档——
        // 销毁档 emit 后立即销毁窗口，clear_mini_dek 两跳链必然来不及落地，MINI_DEK 必须
        // 与 STASHED_DEK 一并在 Rust 侧同步清，否则重建 mini peek 到残留 DEK 自动解锁而主窗锁定
        dek_slots_clear_on_lock();
    } else {
        // 不锁库：给前端 1s 窗口执行 stash_dek（Task 14 的监听器），再销毁。
        // 注意（C1 裁定）：本分支不锁库**不得清槽**——重建后主窗回注 stash DEK 并经 onUnlocked
        // 重新 publish mini 槽覆盖，清了反而制造主窗解锁、mini 锁定的反向不一致
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
        // Task 12 诊断：wry/tauri 默认 drag-drop handler 在 Windows 吞掉 WebView2 的 HTML5 DnD
        // 事件（dragstart 后 dragover/drop 零触发，SendInput 变体独立复现），管理页拖拽排序真机
        // 无效。禁用该 handler 是前端 HTML5 拖放 API 在 Windows 可用的必要条件（tauri 2.11.5
        // webview_window.rs 官方注释明示 "required to use HTML5 drag and drop APIs on the
        // frontend on Windows"）。后续实证（9540a7b）修订此注释：禁用后 WebView2 对页面自发起
        // 的 HTML5 DnD 仍立即 abort，拖拽排序已改 pointer 长按方案（唯一拖拽路径）；保留禁用
        // 的理由 = 管理页粘贴区的外部文件投放（HTML5 drop 事件）在 Windows 可用，且避免 wry
        // 默认 IDropTarget 回归。禁用的副作用——外部文件落入未 preventDefault 区域会触发
        // WebView2 默认导航（跳 file:// 替换 SPA、丢解锁会话）——由前端两窗口入口全局
        // dragover/drop preventDefault 兜底（apps/desktop/src/dragDropGuard.ts，R2-I1）。mini
        // 无排序交互面未加禁用（默认 handler 在位），前端兜底双窗一致挂载。
        .disable_drag_drop_handler()
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
        // 2026-10-09 用户裁定放开 spec §1.4/§1.5 的固定尺寸：无边框 + 系统阴影 + 可调
        // （下限 240×320 保 titlebar+搜索行+数行条目可用）。无边框窗 tauri 不给原生
        // resize 边缘，实际拖拽由前端 8 向热区 startResizeDragging 承担（MiniApp.vue），
        // resizable(true) 是系统层放行；pin 存续时重建窗口保持置顶
        .decorations(false)
        .shadow(true)
        .resizable(true)
        .min_inner_size(240.0, 320.0)
        .always_on_top(MINI_PINNED.load(std::sync::atomic::Ordering::Relaxed))
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

/// run() 装配段提函数（R16⑨）：无头模式连接信息 stdout 输出（验收条目13）。行为契约：
/// 连接信息仅在服务真实监听成功时输出（终审修复：不再与启动结果脱钩——此前 autostart
/// 失败仍打印成功样连接行，裸 --headless-mcp 且设置关闭时打印空 token 行）。headless
/// 无人值守，失败 stderr 明示 + exit(2) 让脚本消费方可感知。gate 用 serde 线格式
/// （token/wildcard/exact/alwaysAsk，serde camelCase）而非 {:?} 调试形式（Wildcard）：
/// 脚本消费方按线格式解析；手写 match 不带通配分支，GateMode 新增变体时编译期强制
/// 同步本映射，不会漂移
fn print_headless_connection(cfg: &mcp_server::McpConfig, start: &Result<(), String>) {
    match start {
        Ok(()) => {
            let gate = match cfg.mode {
                mcp_server::GateMode::Token => "token",
                mcp_server::GateMode::Wildcard => "wildcard",
                mcp_server::GateMode::Exact => "exact",
                mcp_server::GateMode::AlwaysAsk => "alwaysAsk",
            };
            println!(
                "MCP: http://127.0.0.1:{}  token: {}  gate: {}",
                cfg.port, cfg.token, gate
            );
        }
        Err(e) => {
            eprintln!("[mcp] headless 启动失败: {e}");
            std::process::exit(2);
        }
    }
}

/// run() 装配段提函数（R16⑨）：C7 按 settings 覆写默认快捷键——unregister_all +
/// on_shortcut 重新注册一次。Builder.with_shortcuts 在 setup 之前执行已注册默认
/// alt+shift+t，故仅在配置差异时重注册
fn apply_shortcut_override(app: &AppHandle) {
    let configured = read_shortcut_from_settings(app);
    if configured != "alt+shift+t" {
        let gs = app.global_shortcut();
        // 错误留痕（真机排查实证：静默吞错时注册失败无从诊断）——失败仍不阻断启动
        if let Err(e) = gs.unregister_all() {
            eprintln!("[shortcut] unregister_all failed: {e}");
        }
        if let Err(e) = gs.on_shortcut(configured.as_str(), |a, _s, e| {
            if e.state == ShortcutState::Pressed {
                toggle_mini(a, None);
            }
        }) {
            eprintln!("[shortcut] register '{configured}' failed: {e}");
        }
    }
}

// ---------- 托盘 i18n（Phase 2 Task 7）：菜单/tooltip 文案跟随界面语言 ----------
/// 托盘图标固定 id：tray-locale-changed 重建路径按 id 拆旧建新。tauri 经 manager 与
/// resources_table 持 TrayIcon 克隆保活（本文件局部句柄 drop 不拆图标），remove_tray_by_id
/// 取出并 drop 末引用即拆除系统托盘图标
const TRAY_ICON_ID: &str = "main";
/// 「复制 MCP 连接信息」项显隐旗标（headless 启动参数决定，运行期不变）：重建路径经此单点
/// 读取；连接信息全文 mcp_info 仍由 setup_tray 一次性注册的菜单事件闭包持有（沿用不重建）
static TRAY_HAS_MCP_ITEM: std::sync::OnceLock<bool> = std::sync::OnceLock::new();

/// 托盘文案映射（纯函数，四键 × zh/en）：locale 仅 "en" 走 en 表，其余（含未知值）回退 zh；
/// 未知 key 回退 zh 首键文案（防御分支，调用侧仅四键）
fn tray_label(key: &str, locale: &str) -> &'static str {
    let (show_main, quit, copy_mcp, tooltip) = if locale == "en" {
        (
            "Show Main Window",
            "Quit",
            "Copy MCP Connection Info",
            "TOTP Code Tool",
        )
    } else {
        ("显示主窗口", "退出", "复制 MCP 连接信息", "TOTP 验证码工具")
    };
    match key {
        "show-main" => show_main,
        "quit" => quit,
        "copy-mcp" => copy_mcp,
        "tooltip" => tooltip,
        _ => "显示主窗口",
    }
}

/// settings.locale → 托盘 locale（"zh"/"en"）：直填值照用；'auto'/缺省/未知值沿前端 i18n
/// resolve 同语义（navigator.language 系统语言判定，zh 兜底，见 ui/i18n/index.ts）——Rust
/// 侧以系统 UI 语言主语言位判定
fn resolve_tray_locale(raw: Option<&str>) -> &'static str {
    match raw {
        Some("en") => "en",
        Some("zh") => "zh",
        _ => {
            if system_ui_prefers_english() {
                "en"
            } else {
                "zh"
            }
        }
    }
}

/// 系统 UI 语言是否英语（LANGID 低 10 位主语言 == LANG_ENGLISH，en-* 与前端 /^en/i 同口径）
#[cfg(windows)]
fn system_ui_prefers_english() -> bool {
    const LANG_ENGLISH: u16 = 0x0009;
    (unsafe { windows::Win32::Globalization::GetUserDefaultUILanguage() } & 0x03FF) == LANG_ENGLISH
}

/// 非 Windows：无系统语言探测（不为此引依赖），auto/未知值恒 zh（与 i18n 硬编码旧状一致）
#[cfg(not(windows))]
fn system_ui_prefers_english() -> bool {
    false
}

/// settings.json → 托盘 locale（读失败 None → resolve 兜底 zh）
fn read_tray_locale(app: &AppHandle<tauri::Wry>) -> &'static str {
    // Value 所有权留本帧，取出 str 拷贝后再归一（避免借用临时 Value 出界）
    let raw = read_section(app, "locale").and_then(|v| v.as_str().map(str::to_string));
    resolve_tray_locale(raw.as_deref())
}

/// 托盘装配单点（初建与 tray-locale-changed 重建共用）：菜单（locale 文案）、图标、tooltip
/// 与点击接线。菜单事件处理器（show-main/copy-mcp-info/quit）不在此列——App::on_menu_event
/// 为累积注册（tauri manager.menu.global_event_listeners 为 push 语义），仅 setup_tray 注册
/// 一次，重建路径绝不重入（否则一次菜单点击多次执行）
fn build_tray(app: &AppHandle<tauri::Wry>, locale: &str) -> tauri::Result<()> {
    let show_main_item = MenuItem::with_id(
        app,
        "show-main",
        tray_label("show-main", locale),
        true,
        None::<&str>,
    )?;
    let quit_item = MenuItem::with_id(app, "quit", tray_label("quit", locale), true, None::<&str>)?;
    let mcp_info_item = if TRAY_HAS_MCP_ITEM.get().copied().unwrap_or(false) {
        Some(MenuItem::with_id(
            app,
            "copy-mcp-info",
            tray_label("copy-mcp", locale),
            true,
            None::<&str>,
        )?)
    } else {
        None
    };
    let mut items: Vec<&dyn tauri::menu::IsMenuItem<_>> = vec![&show_main_item];
    if let Some(item) = &mcp_info_item {
        items.push(item);
    }
    items.push(&quit_item);
    let menu = Menu::with_items(app, &items)?;

    TrayIconBuilder::with_id(TRAY_ICON_ID)
        .icon(app.default_window_icon().unwrap().clone())
        .tooltip(tray_label("tooltip", locale))
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|_tray, event| {
            if let TrayIconEvent::Click {
                button,
                button_state: tauri::tray::MouseButtonState::Up,
                rect,
                ..
            } = event
            {
                // 托盘点击=每次重新锚定：窗口右下角弹出在图标处。tauri 2.11 的 rect
                // 为枚举型（dpi::Position/Size），tray_icon 的物理像素值经 Into 落在
                // Physical 分支；Logical 分支兜底 None（退化为快捷键的恢复语义）
                let anchor = match (rect.position, rect.size) {
                    (tauri::Position::Physical(p), tauri::Size::Physical(s)) => {
                        Some((p.x as f64, p.y as f64, s.width as f64, s.height as f64))
                    }
                    _ => None,
                };
                match button {
                    tauri::tray::MouseButton::Left => toggle_mini(_tray.app_handle(), anchor),
                    // 中键直达主窗口，省去右键菜单一步（等价「显示主窗口」）
                    tauri::tray::MouseButton::Middle => show_main(_tray.app_handle()),
                    _ => {}
                }
            }
        })
        .build(app)?;
    Ok(())
}

/// tray-locale-changed 重建：拆旧托盘（remove_tray_by_id 取出 manager/resources 持引用，
/// drop 末引用即拆系统图标）再按盘上新 locale 建新。菜单事件闭包状态沿用（见 build_tray
/// 注释）；失败仅告警不中断——本函数为 remove-then-build，至此旧托盘已拆、新托盘未建，
/// 系统托盘暂缺图标（非保持旧文案）；下次 locale 切换重建自愈
fn rebuild_tray(app: &AppHandle<tauri::Wry>) {
    if let Some(old) = app.remove_tray_by_id(TRAY_ICON_ID) {
        drop(old);
    }
    let locale = read_tray_locale(app);
    if let Err(e) = build_tray(app, locale) {
        eprintln!("[tray] locale 重建失败: {e}");
    }
}

/// run() 装配段提函数（R16⑨）：托盘装配 + 菜单事件接线（装配段属拆分豁免
/// 清单，仅提函数不挪文件）。mcp_info 仅托盘作用域消费：验收条目13 无头模式无窗口可看，
/// 托盘补「复制 MCP 连接信息」兜底（文本含 token，写入登记 F16 暂存——托盘退出兜底清除）
fn setup_tray(
    app: &tauri::App,
    headless: bool,
    mcp_cfg: &mcp_server::McpConfig,
) -> tauri::Result<()> {
    let _ = TRAY_HAS_MCP_ITEM.set(headless);
    build_tray(app.handle(), read_tray_locale(app.handle()))?;
    let mcp_info = if headless {
        Some(format!(
            "MCP: http://127.0.0.1:{}  token: {}",
            mcp_cfg.port, mcp_cfg.token
        ))
    } else {
        None
    };
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
    Ok(())
}

pub fn run() {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    // 审查 I-1：接管父控制台必须先于 parse_args——否则参数错误的 eprintln 写在未连接的
    // 句柄上（windows_subsystem=windows 下 stderr 缺省无效），终端启动只见静默 exit(2)。
    // Task 3 审查裁定提前到全部带参分支之前：提权/服务分支的 eprintln 同样依赖已附加的
    // 控制台才在终端启动时可见。仅带参启动时附加：双击启动（无参）不触碰控制台，正常
    // GUI 路径行为不变；附加失败（无宿主控制台等）AttachConsole 返回值被忽略，静默无害
    // （SCM 拉起的服务进程父为 services.exe 无控制台，同样失败即静默，见 attach_parent_console 注释）
    #[cfg(windows)]
    if !args.is_empty() {
        attach_parent_console();
    }
    // ABE 提权服务分支（plan p6 §0.1）：run() 最早处分派，服务进程绝不初始化 tauri/webview。
    // 必须先于 cli::parse_args（后者对未知参数 exit(2)）；SCM 以唯一参数启动服务进程。
    // 非 SCM 上下文（终端直跑调试）由 run_service 内回落直接运行服务循环
    #[cfg(windows)]
    if args.iter().any(|a| a == "--elevation-service") {
        if let Err(e) = elevation_service::run_service() {
            crate::elevation_log::elog("service", &e.to_string());
            std::process::exit(1);
        }
        return;
    }
    // ABE 提权安装/卸载分支（plan p6 §0.2）：由 runas 提权拉起，执行完即退出、无 UI，
    // 绝不初始化 tauri/webview；同样先于 parse_args（未知参数会 exit(2)）
    #[cfg(windows)]
    if args
        .iter()
        .any(|a| a == "--elevation-install" || a == "--elevation-uninstall")
    {
        let result = if args.iter().any(|a| a == "--elevation-install") {
            elevation_install::run_install()
        } else {
            elevation_install::run_uninstall()
        };
        if let Err(e) = result {
            crate::elevation_log::elog("install", &e.to_string());
            std::process::exit(1);
        }
        return;
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
                        toggle_mini(app, None);
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
            // mini pin 初值：settings.json → 内存缓存（builder always_on_top 与失焦守卫共用）
            let mini_pinned = read_section(app.handle(), "miniPinned")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            MINI_PINNED.store(mini_pinned, std::sync::atomic::Ordering::Relaxed);
            // mini-ready 全局事件：前端首屏 load 完成即发；重建路径经 MINI_READY_TX 消费
            let _ = app.listen("mini-ready", |_| {
                if let Ok(g) = MINI_READY_TX.lock() {
                    if let Some(tx) = g.as_ref() {
                        let _ = tx.send(());
                    }
                }
            });
            // plan17：MCP 服务器装配（manage McpState）+ 按配置自动拉起；返回含 CLI 覆盖的
            // 生效 cfg 与真实启动结果，供无头连接信息输出（stdout/托盘复制与实际监听同源）
            let (mcp_cfg, mcp_start) = mcp_server::init_state_and_autostart(app, &mcp_override)?;
            // 验收条目13：无头模式不显示任何窗口，连接信息输出/失败 exit(2) 见
            // print_headless_connection（R16⑨ 提函数，行为契约随函数注释）
            if headless {
                print_headless_connection(&mcp_cfg, &mcp_start);
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
            // C7：按 settings 覆写默认快捷键（R16⑨ 提函数）
            apply_shortcut_override(app.handle());
            // 托盘菜单 + 图标 + 菜单事件接线（R16⑨ 提函数；mcp_info 仅托盘作用域消费）
            setup_tray(app, headless, &mcp_cfg)?;
            // Phase 2 Task 7 托盘 i18n：前端 locale 持久化成功后 emit（desktopShell
            // onCommitted 差分上报），此处拆旧托盘按新 locale 重建菜单/tooltip。
            // run_on_main_thread 兜底线程亲和：muda 菜单（HMENU）与托盘图标创建有主线程
            // 约束，不假设事件回调所在线程
            let tray_handle = app.handle().clone();
            let _ = app.listen("tray-locale-changed", move |_| {
                let dispatch = tray_handle.clone();
                let rebuild = tray_handle.clone();
                let _ = dispatch.run_on_main_thread(move || rebuild_tray(&rebuild));
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
                    // spec §1.5：pin 后失焦不再自动隐藏、不记录 300ms 防竞态时刻
                    if window.label() == "mini"
                        && !MINI_PINNED.load(std::sync::atomic::Ordering::Relaxed)
                    {
                        if let Ok(mut last) = LAST_FOCUS_HIDE.lock() {
                            *last = Some(Instant::now());
                        }
                        // 失焦隐藏前记忆位置（spec §1.3 位置恢复三路径之一）
                        remember_mini_pos(window);
                        let _ = window.hide();
                    }
                }
                WindowEvent::CloseRequested { api, .. } => {
                    // main 与 mini 点 X 均拦截为隐藏：保证托盘常驻；
                    // mini 被原生标题栏销毁后 get_webview_window("mini") 恒 None，
                    // 托盘左键与 Alt+Shift+T 将永久失效，故必须 prevent_close
                    if window.label() == "mini" {
                        remember_mini_pos(window);
                    }
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
            mini_pin_get,
            mini_pin_set,
            stash_dek,
            take_stashed_dek,
            clear_stashed_dek,
            set_mini_dek,
            peek_mini_dek,
            clear_mini_dek,
            stage_clipboard_write,
            clipboard_clear_if_staged,
            mcp_server::mcp_get_config,
            mcp_server::mcp_set_config,
            mcp_server::mcp_regenerate_token,
            mcp_server::mcp_approval_response,
            mcp_server::mcp_respond,
            mcp_server::mcp_revoke_approvals,
            cloud_http::cloud_http_fetch,
            elevation_commands::abe_status,
            elevation_commands::abe_bind,
            elevation_commands::abe_wrap,
            elevation_commands::abe_remove,
            elevation_commands::abe_unwrap
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

    // 触碰进程级 env 的测试须串行：std::env::set_var/remove_var 非线程安全，且两测试
    // （apply_devtools_env_end_to_end… 与 devtools_config_json_reports_env_preset）并行交错时，
    // 一方的 remove/set 会落在另一方的「注入」与「断言」之间，看到中间态——CI 曾实锤 flaky
    // （apply_devtools_env_end_to_end 864 行 unwrap NotPresent）。poison 后 into_inner 续行防死锁。
    #[cfg(windows)]
    static ENV_TESTS_SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());

    // 端到端接线（薄壳 env 读写）：单一用例内完成 env 改写/断言/恢复，经 ENV_TESTS_SERIAL
    // 与 devtools_config_json_reports_env_preset 串行（并行交错会互相踩 env，见上）。
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
        let _env_serial = ENV_TESTS_SERIAL.lock().unwrap_or_else(|p| p.into_inner());
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

    // F8(B4)：get_config 返回形状——envPreset 随外部 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
    // 预设两态（env 判定为薄壳，EnvGuard 恢复现场防泄漏）；形状单点经 devtools_config_json
    // （AppHandle 无关，同 devtools_from_section 的可测核心手法）
    #[cfg(windows)]
    #[test]
    fn devtools_config_json_reports_env_preset() {
        let _env_serial = ENV_TESTS_SERIAL.lock().unwrap_or_else(|p| p.into_inner());
        let _guard = EnvGuard::save();
        std::env::remove_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS");
        assert_eq!(
            devtools_config_json(false, 9222),
            serde_json::json!({ "enabled": false, "port": 9222, "envPreset": false })
        );
        std::env::set_var(
            "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
            "--external-sentinel",
        );
        assert_eq!(
            devtools_config_json(true, 9333),
            serde_json::json!({ "enabled": true, "port": 9333, "envPreset": true })
        );
    }

    // mini 托盘锚定几何（spec §1.3）：右下角贴图标 + 工作区 clamp
    #[test]
    fn mini_position_for_tray_aligns_bottom_right_above_icon() {
        // 图标 (1800,1040,32,32)、窗 320x420、工作区 (0,0,1920,1040)：右缘对齐 1832-320、底贴 1040-420
        assert_eq!(
            mini_position_for_tray(1800.0, 1040.0, 32.0, 32.0, 320, 420, 0, 0, 1920, 1040),
            (1512, 620)
        );
    }

    // R1-I1/R1-M6：mini toggle 动作状态机（纯函数）——可见收起、失焦防抖、重建在途仅定位
    // （show 收敛 waiter，封堵 ready 窗口内二次触发旁路）、常规弹出
    #[test]
    fn mini_toggle_action_state_machine() {
        use MiniToggleAction::{Hide, KeepHidden, RepositionOnly, Show};
        let ms = |n: u64| Duration::from_millis(n);
        // 可见优先（即便重建在途/刚失焦，也一律记忆位置并收起）
        assert_eq!(mini_toggle_action(true, false, None), Hide);
        assert_eq!(mini_toggle_action(true, true, Some(ms(10))), Hide);
        // 刚失焦隐藏 <300ms：防抖窗口内保持隐藏（托盘点击 vs 失焦自动隐藏竞态）
        assert_eq!(mini_toggle_action(false, false, Some(ms(299))), KeepHidden);
        assert_eq!(mini_toggle_action(false, true, Some(ms(299))), KeepHidden);
        // 重建在途（本次发起或 ready 窗口内二次触发）：仅定位，show 统一收敛到 waiter
        assert_eq!(mini_toggle_action(false, true, None), RepositionOnly);
        assert_eq!(
            mini_toggle_action(false, true, Some(ms(10_000))),
            RepositionOnly
        );
        // 常规弹出：非防抖窗口内的失焦隐藏态同样立即 show
        assert_eq!(mini_toggle_action(false, false, None), Show);
        assert_eq!(mini_toggle_action(false, false, Some(ms(300))), Show);
        assert_eq!(mini_toggle_action(false, false, Some(ms(1_000))), Show);
    }

    #[test]
    fn mini_position_for_tray_clamps_into_work_area() {
        // 右溢 clamp 到工作区右缘；左溢 clamp 到 work_x；底贴不越界
        assert_eq!(
            mini_position_for_tray(1900.0, 1040.0, 32.0, 32.0, 320, 420, 0, 0, 1920, 1040),
            (1600, 620)
        );
        assert_eq!(
            mini_position_for_tray(10.0, 1000.0, 32.0, 32.0, 320, 420, 0, 0, 1920, 1040),
            (0, 580)
        );
    }

    #[test]
    fn mini_position_for_tray_window_larger_than_work_area_no_panic() {
        // 窗大于工作区：clamp 区间退化不 panic（max 取 min 兜底）
        let _ = mini_position_for_tray(100.0, 100.0, 32.0, 32.0, 4000, 3000, 0, 0, 1920, 1040);
    }

    // ---------- 托盘 i18n（Phase 2 Task 7）：tray_label 映射与回退 ----------
    #[test]
    fn tray_label_maps_four_keys_for_both_locales() {
        assert_eq!(tray_label("show-main", "zh"), "显示主窗口");
        assert_eq!(tray_label("quit", "zh"), "退出");
        assert_eq!(tray_label("copy-mcp", "zh"), "复制 MCP 连接信息");
        assert_eq!(tray_label("tooltip", "zh"), "TOTP 验证码工具");
        assert_eq!(tray_label("show-main", "en"), "Show Main Window");
        assert_eq!(tray_label("quit", "en"), "Quit");
        assert_eq!(tray_label("copy-mcp", "en"), "Copy MCP Connection Info");
        assert_eq!(tray_label("tooltip", "en"), "TOTP Code Tool");
    }

    #[test]
    fn tray_label_falls_back_to_zh_for_unknown_key_and_locale() {
        // 未知 key 回退 zh（防御分支）；未知 locale 不走 en 表（仅 "en" 命中）
        assert_eq!(tray_label("no-such-key", "zh"), "显示主窗口");
        assert_eq!(tray_label("no-such-key", "en"), "显示主窗口");
        assert_eq!(tray_label("quit", "fr"), "退出");
        assert_eq!(tray_label("tooltip", "auto"), "TOTP 验证码工具");
    }

    #[test]
    fn resolve_tray_locale_direct_values_and_fallback() {
        assert_eq!(resolve_tray_locale(Some("zh")), "zh");
        assert_eq!(resolve_tray_locale(Some("en")), "en");
        // 'auto'/缺省/未知值走系统 UI 语言判定（本测试环境结果不定），断言产出必为合法二值
        assert!(matches!(resolve_tray_locale(Some("auto")), "zh" | "en"));
        assert!(matches!(resolve_tray_locale(Some("fr")), "zh" | "en"));
        assert!(matches!(resolve_tray_locale(None), "zh" | "en"));
    }
}
