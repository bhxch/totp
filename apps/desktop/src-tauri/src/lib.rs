use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{
    AppHandle, Manager, Runtime, WindowEvent,
    menu::{Menu, MenuItem},
    tray::{TrayIconBuilder, TrayIconEvent},
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

mod lock_events;

// mini 最近一次因失焦而隐藏的时刻，用于缓解「托盘点击收起」与「失焦自动隐藏」的竞态
static LAST_FOCUS_HIDE: Mutex<Option<Instant>> = Mutex::new(None);

// 桌面应用 settings.json：存于 app_data_dir（与前端 createTauriFs 的 baseDir 对齐）。
// 当前唯一可配项为 shortcutToggleMini（toggle mini 的全局快捷键），默认 alt+shift+t；
// 解析失败/字段缺失一律回落到默认值，保证老版本 settings.json 不破坏启动。
fn settings_path<R: Runtime>(app: &AppHandle<R>) -> Option<std::path::PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("settings.json"))
}

fn read_shortcut_from_settings<R: Runtime>(app: &AppHandle<R>) -> String {
    const DEFAULT: &str = "alt+shift+t";
    let Some(p) = settings_path(app) else { return DEFAULT.into() };
    let Ok(text) = std::fs::read_to_string(&p) else { return DEFAULT.into() };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else { return DEFAULT.into() };
    v.get("shortcutToggleMini")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| DEFAULT.into())
}

fn write_shortcut_to_settings<R: Runtime>(app: &AppHandle<R>, shortcut: &str) -> Result<(), String> {
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
    obj.insert("shortcutToggleMini".into(), serde_json::Value::String(shortcut.into()));
    std::fs::write(&p, serde_json::to_string_pretty(&obj).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
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
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.show();
        let _ = main.unminimize();
        let _ = main.set_focus();
    }
}

// ---------- 备份文件命令 ----------
// 信任边界（C9 加固）：read/write_text_file_os 的路径由前端系统对话框产生，并须在 JS 传入
// 的 allowed_dir 内（含父目录）；扩展名 .totpbackup 白名单防被前端脚本当任意读写原语。
// remove_backup_file 仅允许 AppData/backups 下的合法备份名（白名单防路径穿越）。

fn valid_backup_name(name: &str) -> bool {
    // 白名单：vault- 前缀、.totpbackup 后缀、不含路径分隔符与 ..，防路径穿越
    name.starts_with("vault-")
        && name.ends_with(".totpbackup")
        && !name.contains('/')
        && !name.contains('\\')
        && !name.contains("..")
}

/** C9：校验 path.parent() 必须落在 allowed_dir 内，canonicalize 防止 symlink/相对路径逃逸 */
fn ensure_within(path: &std::path::Path, allowed_dir: &str) -> Result<(), String> {
    if allowed_dir.is_empty() {
        return Err("empty allowed dir".into());
    }
    let parent = path.parent().ok_or_else(|| "invalid path: no parent".to_string())?;
    let abs_parent = std::fs::canonicalize(parent).map_err(|e| e.to_string())?;
    let abs_allowed = std::fs::canonicalize(allowed_dir).map_err(|e| e.to_string())?;
    if !abs_parent.starts_with(&abs_allowed) {
        return Err("path outside allowed dir".into());
    }
    Ok(())
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

/// 用户自选备份目录的删除命令（D4）：与 remove_backup_file 同守护（白名单名 + ensure_within），
/// 只是 allowed_dir 从「AppData/backups 固定值」改为「前端对话框返回并持久化的目录」
#[tauri::command]
fn remove_backup_file_os(path: String, allowed_dir: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    let name = p
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    if !valid_backup_name(&name) {
        return Err("invalid backup name".into());
    }
    ensure_within(p, &allowed_dir)?;
    std::fs::remove_file(p).map_err(|e| e.to_string())
}

/// 用户自选备份目录的列举命令（D4）：不做 ensure_within——dir 本身即用户显式授权目标
/// （与写/读命令的 allowed_dir 同源，均来自系统对话框），列举仅返回白名单名
/// （vault-*.totpbackup 与 conflict-*.totpbackup），不泄露目录内其他文件
#[tauri::command]
fn list_backup_files_os(dir: String) -> Result<Vec<String>, String> {
    let rd = std::fs::read_dir(&dir).map_err(|e| e.to_string())?;
    let mut names: Vec<String> = rd
        .flatten()
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|n| valid_backup_name(n) || (n.starts_with("conflict-") && n.ends_with(".totpbackup")))
        .collect();
    names.sort();
    Ok(names)
}

#[tauri::command]
fn read_text_file_os(path: String, allowed_dir: String) -> Result<String, String> {
    // 扩展名白名单：与写侧对齐；本命令唯一用途是读取备份文件，
    // 限定 .totpbackup 防止被前端 XSS 当作任意文件读取原语
    if !path.ends_with(".totpbackup") {
        return Err("invalid backup file extension".into());
    }
    let p = std::path::Path::new(&path);
    if !p.is_file() {
        return Err("not a file".into());
    }
    ensure_within(p, &allowed_dir)?;
    std::fs::read_to_string(p).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_text_file_os(
    path: String,
    contents: String,
    allowed_dir: String,
) -> Result<(), String> {
    if path.is_empty() {
        return Err("empty path".into());
    }
    // 扩展名白名单：本命令唯一用途是备份导出；CSP 为 null 的现状下，
    // 任意路径+任意内容写入等于 XSS 任意文件覆写原语，故限定 .totpbackup
    if !path.ends_with(".totpbackup") {
        return Err("invalid backup file extension".into());
    }
    let p = std::path::Path::new(&path);
    if p.is_dir() {
        return Err("path is a directory".into());
    }
    ensure_within(p, &allowed_dir)?;
    std::fs::write(path, contents).map_err(|e| e.to_string())
}

// ---------- 导入文件命令 ----------
// 与 read_text_file_os 同构：信任边界一致（路径由前端系统对话框产生，且须落在传入 allowed_dir 内），
// 扩展名白名单限定导入用途，防止被前端 XSS 当作任意文件读取原语。

#[tauri::command]
fn read_import_file_os(path: String, allowed_dir: String) -> Result<String, String> {
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
    ensure_within(p, &allowed_dir)?;
    std::fs::read_to_string(p).map_err(|e| e.to_string())
}

// 导入文件字节读取（SQLite 等二进制格式，ImportCard 字节入口）：与 read_import_file_os 同构，
// 白名单在其基础上加 .db/.sqlitedb/.sqlite；返回原始字节（invoke JSON 数组），不经 UTF-8 文本管道
#[tauri::command]
fn read_import_file_bytes_os(path: String, allowed_dir: String) -> Result<Vec<u8>, String> {
    const IMPORT_BYTE_EXTENSIONS: [&str; 8] =
        [".json", ".wauth", ".xml", ".txt", ".aegis", ".db", ".sqlitedb", ".sqlite"];
    let lower = path.to_lowercase();
    if !IMPORT_BYTE_EXTENSIONS.iter().any(|ext| lower.ends_with(ext)) {
        return Err("invalid import file extension".into());
    }
    let p = std::path::Path::new(&path);
    if !p.is_file() {
        return Err("not a file".into());
    }
    ensure_within(p, &allowed_dir)?;
    std::fs::read(p).map_err(|e| e.to_string())
}

// WinAuth DPAPI 层解密（ CryptUnprotectData，无附加熵，CRYPTPROTECT_UI_FORBIDDEN）。
// 输入/输出约定与 core importWinauth 的 decryptDpapi 回调对齐：输入 base64(密文)，
// 输出 UTF-8 明文——WinAuth 的 DPAPI 明文恒为下一层 payload 的 hex ASCII
// （Authenticator.cs DecryptSequenceNoHash decode=false 路径），故 UTF-8 往返无损。
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

#[cfg(windows)]
#[tauri::command]
fn decrypt_dpapi(b64: String) -> Result<String, String> {
    use windows::Win32::Foundation::{HLOCAL, LocalFree};
    use windows::Win32::Security::Cryptography::{
        CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB, CryptUnprotectData,
    };

    let mut cipher = base64_decode(&b64).ok_or("invalid base64")?;
    if cipher.is_empty() {
        return Err("empty data".into());
    }
    unsafe {
        let in_blob = CRYPT_INTEGER_BLOB {
            cbData: cipher.len() as u32,
            pbData: cipher.as_mut_ptr(),
        };
        let mut out_blob = CRYPT_INTEGER_BLOB::default();
        CryptUnprotectData(&in_blob, None, None, None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut out_blob)
            .map_err(|e| format!("DPAPI 解密失败: {e}"))?;
        let plain = std::slice::from_raw_parts(out_blob.pbData, out_blob.cbData as usize);
        let result = String::from_utf8(plain.to_vec()).map_err(|_| "DPAPI 明文不是合法 UTF-8".to_string());
        let _ = LocalFree(Some(HLOCAL(out_blob.pbData.cast())));
        result
    }
}

#[cfg(not(windows))]
#[tauri::command]
fn decrypt_dpapi(_b64: String) -> Result<String, String> {
    Err("仅 Windows 支持 DPAPI 解密".into())
}

// 桌面 DPAPI 自动解锁（计划 11 T3）：CryptProtectData/CryptUnprotectData 包裹/解出 vault DEK 本体
// （T1 裁定 wrappedDekD=base64(DPAPI(DEK))），CRYPTPROTECT_UI_FORBIDDEN 禁 UI，base64 进出。
// 与 decrypt_dpapi（WinAuth 导入，明文须 UTF-8）分开：DEK 是任意字节，走独立命令避免语义混淆。
// 最小 base64 编码：与上方 base64_decode 同理念，标准字母表 + padding，不引第三方依赖。
fn base64_encode(data: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { TABLE[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { TABLE[n as usize & 63] as char } else { '=' });
    }
    out
}

// DPAPI 核心：从宏命令函数提取为 inner，供命令与 os_auto_*（Windows 委托分支）共用
#[cfg(windows)]
fn dpapi_protect_inner(data_b64: String) -> Result<String, String> {
    use windows::Win32::Foundation::{HLOCAL, LocalFree};
    use windows::Win32::Security::Cryptography::{
        CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB, CryptProtectData,
    };

    let mut plain = base64_decode(&data_b64).ok_or("invalid base64")?;
    if plain.is_empty() {
        return Err("empty data".into());
    }
    unsafe {
        let in_blob = CRYPT_INTEGER_BLOB {
            cbData: plain.len() as u32,
            pbData: plain.as_mut_ptr(),
        };
        let mut out_blob = CRYPT_INTEGER_BLOB::default();
        CryptProtectData(&in_blob, None, None, None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut out_blob)
            .map_err(|e| format!("DPAPI 加密失败: {e}"))?;
        let cipher = std::slice::from_raw_parts(out_blob.pbData, out_blob.cbData as usize).to_vec();
        let _ = LocalFree(Some(HLOCAL(out_blob.pbData.cast())));
        Ok(base64_encode(&cipher))
    }
}

#[cfg(windows)]
#[tauri::command]
fn dpapi_protect(data_b64: String) -> Result<String, String> {
    dpapi_protect_inner(data_b64)
}

#[cfg(not(windows))]
#[tauri::command]
fn dpapi_protect(_data_b64: String) -> Result<String, String> {
    Err("仅 Windows 支持 DPAPI".into())
}

#[cfg(windows)]
fn dpapi_unprotect_inner(wrapped_b64: String) -> Result<String, String> {
    use windows::Win32::Foundation::{HLOCAL, LocalFree};
    use windows::Win32::Security::Cryptography::{
        CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB, CryptUnprotectData,
    };

    let mut cipher = base64_decode(&wrapped_b64).ok_or("invalid base64")?;
    if cipher.is_empty() {
        return Err("empty data".into());
    }
    unsafe {
        let in_blob = CRYPT_INTEGER_BLOB {
            cbData: cipher.len() as u32,
            pbData: cipher.as_mut_ptr(),
        };
        let mut out_blob = CRYPT_INTEGER_BLOB::default();
        CryptUnprotectData(&in_blob, None, None, None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut out_blob)
            .map_err(|e| format!("DPAPI 解密失败: {e}"))?;
        // 明文为任意 DEK 字节（非文本），原样 base64 回传前端转 Uint8Array
        let plain = std::slice::from_raw_parts(out_blob.pbData, out_blob.cbData as usize).to_vec();
        let _ = LocalFree(Some(HLOCAL(out_blob.pbData.cast())));
        Ok(base64_encode(&plain))
    }
}

#[cfg(windows)]
#[tauri::command]
fn dpapi_unprotect(wrapped_b64: String) -> Result<String, String> {
    dpapi_unprotect_inner(wrapped_b64)
}

#[cfg(not(windows))]
#[tauri::command]
fn dpapi_unprotect(_wrapped_b64: String) -> Result<String, String> {
    Err("仅 Windows 支持 DPAPI".into())
}

// osAutoUnlock 三平台统一通道（计划 15 T14）：Windows 委托 DPAPI；macOS Keychain / Linux
// Secret Service 经 keyring。语义与 DPAPI 对齐：OS 保护 DEK 本体（base64 进出），解锁时静默取回。
// D（诚实边界）：macOS/Linux keyring 分支在 Windows 构建上仅编译门控（cfg 不编译不下载依赖），
// keyring 运行时行为登记 backlog 待真机验证；Windows 委托路径经 roundtrip 单测实跑。
#[cfg(windows)]
#[tauri::command]
fn os_auto_protect(data_b64: String) -> Result<String, String> {
    dpapi_protect_inner(data_b64)
}

#[cfg(windows)]
#[tauri::command]
fn os_auto_unprotect(wrapped_b64: String) -> Result<String, String> {
    dpapi_unprotect_inner(wrapped_b64)
}

// keyring 条目存 base64(DEK)：Keychain/Secret Service 条目本身由 OS 加密，与 DPAPI 语义对齐。
// 返回固定占位串而非 base64(DEK)（审查 2026-09-18 C1）：返回值会经 addDpapiSourceOp 作为
// wrappedDekD 明文落盘 security.json——磁盘上不得出现未包裹的 DEK；os_auto_unprotect
// 恒读同一 service/account 条目并忽略入参，占位串不影响解锁链路。
#[cfg(any(target_os = "macos", target_os = "linux"))]
#[tauri::command]
fn os_auto_protect(data_b64: String) -> Result<String, String> {
    let entry = keyring::Entry::new("totp-desktop", "dek").map_err(|e| e.to_string())?;
    entry.set_password(&data_b64).map_err(|e| e.to_string())?;
    Ok("os-keyring".into())
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[tauri::command]
fn os_auto_unprotect(_wrapped_b64: String) -> Result<String, String> {
    let entry = keyring::Entry::new("totp-desktop", "dek").map_err(|e| e.to_string())?;
    entry.get_password().map_err(|e| e.to_string())
}

// 其余平台报错桩（同 dpapi 桩风格）
#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
#[tauri::command]
fn os_auto_protect(_data_b64: String) -> Result<String, String> {
    Err("当前平台不支持 OS 自动解锁".into())
}

#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
#[tauri::command]
fn os_auto_unprotect(_wrapped_b64: String) -> Result<String, String> {
    Err("当前平台不支持 OS 自动解锁".into())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
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
        .setup(|app| {
            // 系统锁屏事件监听（plan16 T15）：Windows 下订阅 WTS_SESSION_LOCK → 前端广播
            // system-lock；非 Windows no-op（mac/Linux 挂账）。前端 App.vue 按设置执行锁定
            lock_events::start(app.handle().clone());
            // C7：按 settings 覆写默认快捷键——unregister_all + on_shortcut 重新注册一次。
            // Builder.with_shortcuts 在 setup 之前执行已注册默认 alt+shift+t，故仅在配置差异时重注册
            let configured = read_shortcut_from_settings(&app.handle());
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
            let menu = Menu::with_items(app, &[&show_main_item, &quit_item])?;

            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("TOTP 验证码工具")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_tray_icon_event(|_tray, event| {
                    if let TrayIconEvent::Click { button, button_state: tauri::tray::MouseButtonState::Up, .. } = event {
                        match button {
                            tauri::tray::MouseButton::Left => toggle_mini(_tray.app_handle()),
                            // 中键直达主窗口，省去右键菜单一步（等价「显示主窗口」）
                            tauri::tray::MouseButton::Middle => show_main(_tray.app_handle()),
                            _ => {}
                        }
                    }
                })
                .build(app)?;

            app.on_menu_event(|app, event| {
                match event.id().as_ref() {
                    "show-main" => show_main(app),
                    "quit" => app.exit(0),
                    _ => {}
                }
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
            read_text_file_os,
            read_import_file_os,
            read_import_file_bytes_os,
            remove_backup_file,
            remove_backup_file_os,
            list_backup_files_os,
            decrypt_dpapi,
            dpapi_protect,
            dpapi_unprotect,
            os_auto_protect,
            os_auto_unprotect,
            set_global_shortcut
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

// repo 首批 Rust 单测：覆盖备份 os 命令的纯守护逻辑（白名单/目录边界），
// 文件系统用 std::env::temp_dir 隔离，不依赖 Tauri runtime
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn valid_backup_name_accepts_vault_prefixed() {
        assert!(valid_backup_name("vault-20260916-120000.totpbackup"));
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
        assert!(ensure_within(&outside, allowed.to_str().unwrap()).is_err());
        let inside = allowed.join("vault-20260916-120000.totpbackup");
        std::fs::write(&inside, "x").unwrap();
        assert!(ensure_within(&inside, allowed.to_str().unwrap()).is_ok());
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn remove_backup_file_os_deletes_within_allowed_dir_only() {
        let base = std::env::temp_dir().join("totp_rm_os_test");
        let allowed = base.join("allowed");
        std::fs::create_dir_all(&allowed).unwrap();
        let name = "vault-20260916-120000.totpbackup";
        let target = allowed.join(name);
        std::fs::write(&target, "x").unwrap();
        remove_backup_file_os(target.to_str().unwrap().into(), allowed.to_str().unwrap().into()).unwrap();
        assert!(!target.exists());
        // allowed_dir 之外的同名文件：白名单名也必须拒绝删除
        let outside = base.join(name);
        std::fs::write(&outside, "x").unwrap();
        assert!(remove_backup_file_os(outside.to_str().unwrap().into(), allowed.to_str().unwrap().into()).is_err());
        assert!(outside.exists());
        std::fs::remove_dir_all(&base).ok();
    }

    // 审查 I12：allowed_dir 的 Windows 特有形态（前端对话框/持久化值可能带大小写差异或
    // verbatim 前缀）必须同样可授权——ensure_within 双侧 canonicalize 归一后比较，两种形态
    // 均应命中同一目录。仅 Windows 可跑（依赖 NTFS 大小写不敏感与 \\?\ 前缀语义）
    #[cfg(windows)]
    #[test]
    fn remove_backup_file_os_accepts_case_variant_and_verbatim_allowed_dir() {
        let base = std::env::temp_dir().join("totp_rm_os_case_test");
        let allowed = base.join("Allowed");
        std::fs::create_dir_all(&allowed).unwrap();
        let name = "vault-20260916-120000.totpbackup";
        // 形态一：allowed_dir 大小写与磁盘真实大小写不同（canonicalize 归一为实际大小写后命中）
        let target = allowed.join(name);
        std::fs::write(&target, "x").unwrap();
        let lowercased = allowed.to_str().unwrap().to_lowercase();
        remove_backup_file_os(target.to_str().unwrap().into(), lowercased).unwrap();
        assert!(!target.exists());
        // 形态二：\\?\ verbatim 前缀形态（canonicalize 的返回形态；对话框路径偶带此前缀）
        let target2 = allowed.join(name);
        std::fs::write(&target2, "x").unwrap();
        let verbatim = std::fs::canonicalize(&allowed).unwrap();
        assert!(verbatim.to_str().unwrap().starts_with(r"\\?\"));
        remove_backup_file_os(target2.to_str().unwrap().into(), verbatim.to_str().unwrap().into()).unwrap();
        assert!(!target2.exists());
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn list_backup_files_os_returns_sorted_vault_and_conflict_only() {
        let base = std::env::temp_dir().join("totp_list_os_test");
        std::fs::create_dir_all(&base).unwrap();
        for n in ["vault-20260916-120001.totpbackup", "vault-20260916-120000.totpbackup", "conflict-20260916-120000.totpbackup", "conflict-foo.txt", "secret.txt"] {
            std::fs::write(base.join(n), "x").unwrap();
        }
        let names = list_backup_files_os(base.to_str().unwrap().into()).unwrap();
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
    #[cfg(windows)]
    #[test]
    fn os_auto_roundtrip_via_dpapi() {
        let data = base64_encode(&[42u8; 32]);
        let wrapped = os_auto_protect(data.clone()).expect("os_auto_protect");
        assert_ne!(wrapped, data, "DPAPI 密文必须不同于明文 base64");
        let unwrapped = os_auto_unprotect(wrapped).expect("os_auto_unprotect");
        assert_eq!(data, unwrapped);
    }
}
