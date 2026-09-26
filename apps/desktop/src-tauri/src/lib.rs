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
    clear_clipboard_if_staged, clear_stashed_dek, clipboard_clear_if_staged, dek_slot_clear,
    stage_clipboard_write, stash_dek, take_stashed_dek, CLIPBOARD_STAGE, STASHED_DEK,
};
use settings_io::{
    read_section_text, read_settings_text, read_shortcut_from_settings, settings_path,
    write_section,
};

// mini 最近一次因失焦而隐藏的时刻，用于缓解「托盘点击收起」与「失焦自动隐藏」的竞态
static LAST_FOCUS_HIDE: Mutex<Option<Instant>> = Mutex::new(None);

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
#[tauri::command]
fn devtools_get_config<R: Runtime>(app: AppHandle<R>) -> Result<serde_json::Value, String> {
    let (enabled, port) = read_devtools_from_settings_text(&read_settings_text(&app));
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
