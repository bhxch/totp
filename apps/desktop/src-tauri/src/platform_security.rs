//! 平台安全通道（R8 自 lib.rs 分节纯移动）：DPAPI 解密命令门控（F3）、DEK 包裹通道
//! （v2 应用附加熵绑定）与 osAutoUnlock 三平台统一通道。接线（invoke_handler 注册）
//! 留在 lib.rs；门控/形状/包裹格式为纯逻辑，经 *_inner 直接单测。

// ---------- DPAPI 解密命令的通用门控（F3） ----------
// 命令注册给 main/mini 两个窗口，Tauri capabilities 无法约束应用自有命令（仅约束插件权限），
// 故在命令体内按窗口 label 收窄：mini 恒不执行导入/解锁/安全卡操作（锁定态迷你窗不可用），
// 暴露面从两个 webview 收窄到主窗口。主窗口 webview 内的脚本仍可调用（该残余边界见各命令注释）。
// pub(crate)：abe_unwrap（T7 fix 1/5）等跨模块 DEK 出口命令复用同一门控，不复制实现
pub(crate) fn ensure_main_window_label(label: &str) -> Result<(), String> {
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
pub fn decrypt_dpapi(
    window: tauri::WebviewWindow,
    b64: String,
    purpose: String,
) -> Result<String, String> {
    decrypt_dpapi_inner(window.label(), &purpose, &b64)
}

#[cfg(not(windows))]
#[tauri::command]
pub fn decrypt_dpapi(
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
// pub(crate)：elevation_service（plan p6 服务侧 DEK 包裹，恒无熵，SYSTEM 用户库）复用；
// 除上述两处外勿再扩散
#[cfg(windows)]
pub(crate) fn dpapi_protect_bytes(plain: &[u8], entropy: Option<&[u8]>) -> Result<Vec<u8>, String> {
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
pub(crate) fn dpapi_unprotect_bytes(
    cipher: &[u8],
    entropy: Option<&[u8]>,
) -> Result<Vec<u8>, String> {
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
pub fn os_auto_protect(window: tauri::WebviewWindow, data_b64: String) -> Result<String, String> {
    dek_protect_inner(window.label(), &data_b64)
}

#[cfg(windows)]
#[tauri::command]
pub fn os_auto_unprotect(
    window: tauri::WebviewWindow,
    wrapped_b64: String,
) -> Result<String, String> {
    dek_unprotect_inner(window.label(), &wrapped_b64)
}

// keyring 条目存 base64(DEK)：Keychain/Secret Service 条目本身由 OS 加密，与 DPAPI 语义对齐。
// 返回固定占位串而非 base64(DEK)（审查 2026-09-18 C1）：返回值会经 addDpapiSourceOp 作为
// wrappedDekD 明文落盘 security.json——磁盘上不得出现未包裹的 DEK；os_auto_unprotect
// 恒读同一 service/account 条目并忽略入参，占位串不影响解锁链路。
#[cfg(any(target_os = "macos", target_os = "linux"))]
#[tauri::command]
pub fn os_auto_protect(window: tauri::WebviewWindow, data_b64: String) -> Result<String, String> {
    ensure_main_window_label(window.label())?;
    let entry = keyring::Entry::new("totp-desktop", "dek").map_err(|e| e.to_string())?;
    entry.set_password(&data_b64).map_err(|e| e.to_string())?;
    Ok("os-keyring".into())
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
#[tauri::command]
pub fn os_auto_unprotect(
    window: tauri::WebviewWindow,
    _wrapped_b64: String,
) -> Result<String, String> {
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
pub fn os_auto_forget() -> Result<(), String> {
    let entry = keyring::Entry::new("totp-desktop", "dek").map_err(|e| e.to_string())?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
#[tauri::command]
pub fn os_auto_forget() -> Result<(), String> {
    Err("当前平台无 keyring DEK 条目可删除".into())
}

// 其余平台报错桩（同 dpapi 桩风格）
#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
#[tauri::command]
pub fn os_auto_protect(_window: tauri::WebviewWindow, _data_b64: String) -> Result<String, String> {
    Err("当前平台不支持 OS 自动解锁".into())
}

#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
#[tauri::command]
pub fn os_auto_unprotect(
    _window: tauri::WebviewWindow,
    _wrapped_b64: String,
) -> Result<String, String> {
    Err("当前平台不支持 OS 自动解锁".into())
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
}
