use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{
    AppHandle, Manager, Runtime, WindowEvent,
    menu::{Menu, MenuItem},
    tray::{TrayIconBuilder, TrayIconEvent},
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

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

#[cfg(windows)]
#[tauri::command]
fn dpapi_protect(data_b64: String) -> Result<String, String> {
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

#[cfg(not(windows))]
#[tauri::command]
fn dpapi_protect(_data_b64: String) -> Result<String, String> {
    Err("仅 Windows 支持 DPAPI".into())
}

#[cfg(windows)]
#[tauri::command]
fn dpapi_unprotect(wrapped_b64: String) -> Result<String, String> {
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

#[cfg(not(windows))]
#[tauri::command]
fn dpapi_unprotect(_wrapped_b64: String) -> Result<String, String> {
    Err("仅 Windows 支持 DPAPI".into())
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
                    if let TrayIconEvent::Click { button: tauri::tray::MouseButton::Left, button_state: tauri::tray::MouseButtonState::Up, .. } = event {
                        toggle_mini(_tray.app_handle());
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
            decrypt_dpapi,
            dpapi_protect,
            dpapi_unprotect,
            set_global_shortcut
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
