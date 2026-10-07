//! ABE 提权服务主体（plan p6 §0.1/§0.2）：LocalSystem 服务循环——命名管道监听、调用者验证
//! （路径+SHA256，签名档预留）、DEK 包裹/解出代理（密文只存 HKLM）。帧协议复用
//! [`crate::elevation_proto`]（单点定义，Global Constraints）；DPAPI 复用
//! platform_security 的字节级通道（无熵，服务以 SYSTEM 身份运行，包裹绑 SYSTEM 用户库）。
//!
//! 结构：纯逻辑（validate_caller / handle_payload，FakeStore 可测）与 IO 薄壳
//! （SCM 接线 / 管道循环 / HKLM 读写）分层——单测不碰真管道与注册表（brief 裁定）。

use std::ffi::OsString;
use std::fmt;
use std::time::{Duration, Instant};

use base64::Engine as _;
use sha2::Digest;
use windows::core::PCWSTR;
use windows::Win32::Foundation::{CloseHandle, ERROR_FILE_NOT_FOUND, ERROR_SUCCESS, HANDLE};
use windows::Win32::System::Registry::{
    RegCloseKey, RegCreateKeyExW, RegDeleteTreeW, RegDeleteValueW, RegOpenKeyExW, RegQueryValueExW,
    RegSetValueExW, HKEY, HKEY_LOCAL_MACHINE, KEY_READ, KEY_SET_VALUE, REG_OPTION_NON_VOLATILE,
    REG_SAM_FLAGS, REG_SZ,
};
use windows_service::service::ServiceState;
use zeroize::Zeroize;

use crate::elevation_proto::{
    decode_frame, encode_frame, ErrCode, MsgType, DEK_MARKER, MAX_FRAME_LEN, PIPE_NAME,
};

/// 服务名（§0.1，windows-service 注册；Task 3 安装/卸载与 NSIS 钩子共用同一字面量）
pub const SERVICE_NAME: &str = "TotpToolsElevationService";

/// HKLM 绑定键（§0.2）；Task 3 安装侧写绑定值、卸载侧删键，本模块统一收口注册表
/// 读写（windows 原生 API 单点，Task 3 审查裁定不引 windows-registry）
pub(crate) const REG_SUBKEY: &str = r"SOFTWARE\TotpTools\Elevation";
pub(crate) const REG_BOUND_PATH: &str = "BoundPath";
pub(crate) const REG_BOUND_SHA: &str = "BoundSha256";
/// 安装侧写入的服务版本标记（§0.2 绑定三值之一）
pub(crate) const REG_SERVICE_VERSION: &str = "ServiceVersion";
/// 安装侧写入的发起用户 SID（R6-M2：管道 DACL 收窄到发起用户，服务启动时读取构造 SDDL）
pub(crate) const REG_CALLER_SID: &str = "CallerSid";
const REG_WRAPPED_DEK: &str = "WrappedDek";

/// 管道 DACL 兜底形态（§0.1 SDDL）：拒绝继承（P）；SYSTEM/Administrators 完全；
/// Authenticated Users 读写。R6-M2 兼容式收紧：CallerSid 可得且形态合法时经
/// [`pipe_sddl_for`] 收窄到发起用户，本形态仅作缺失/非法回退（保底可用）
const PIPE_SDDL_FALLBACK: &str = "D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GRGW;;;AU)";

/// 管道收发缓冲（§0.1 64KiB，与 MAX_FRAME_LEN 对齐）
const PIPE_BUFFER_SIZE: u32 = 64 * 1024;

/// 单连接帧收发超时（R6-M1）：镜像客户端 [`crate::elevation_client::IO_TIMEOUT`]。
/// 服务单实例串行，读帧无 deadline 时半帧停住的连接即卡死服务循环（后续客户端全部
/// ERROR_PIPE_BUSY 耗尽重试——慢连接可用性 DoS）；读帧（头+体）与写响应各享一个全量 deadline
const FRAME_DEADLINE: Duration = crate::elevation_client::IO_TIMEOUT;

/// 服务端 PeekNamedPipe 读轮询间隔（与客户端同款粒度）
const READ_POLL_INTERVAL: Duration = crate::elevation_client::PEEK_POLL_INTERVAL;

/// Resp 帧 wire 头长度：u32 len ‖ u8 msg_type ‖ u16 errcode（DEK 附加数据自第 8 字节起）
const RESP_WIRE_HEADER_LEN: usize = 4 + 1 + 2;

/// HKLM 绑定记录（§0.2：BoundPath REG_SZ + BoundSha256 REG_SZ 十六进制 64 字符）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Bound {
    /// 绑定的调用方 exe 绝对路径（归一化语义见 [`normalize_path`]）
    pub path: String,
    /// SHA256 hex（64 字符；比对大小写不敏感）
    pub sha256: String,
}

/// 服务错误（CLI 分派层 stderr 输出；不携带 DEK 等敏感内容）
#[derive(Debug)]
pub struct ServiceError(String);

impl fmt::Display for ServiceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for ServiceError {}

/// HKLM 绑定/包裹存储抽象：handle_payload 纯逻辑与真实注册表分离（单测经 FakeStore 注入）。
/// Option None =「键/值不存在」（未绑定/无包裹语义）；bool false = 写失败（Internal 语义）
pub(crate) trait ElevationStore {
    /// 绑定记录（BoundPath/BoundSha256）；键或任一值缺失 → None（未绑定状态）
    fn read_bound(&self) -> Option<Bound>;
    /// WrappedDek（REG_SZ，marker+base64 形态）；None = 无包裹
    fn read_wrapped(&self) -> Option<String>;
    /// 覆写 WrappedDek（恒单份替换语义）
    fn write_wrapped(&mut self, value: &str) -> bool;
    /// 删除 WrappedDek（幂等：值不存在等同成功）
    fn delete_wrapped(&mut self);
}

// ---------- 调用者验证（纯逻辑，brief 六例单测覆盖） ----------

/// 调用者验证纯函数（§0.1：路径归一化比对 + SHA256 比对；签名档预留——HKLM 可选
/// `SignerSubject` 键落地后在此扩展，当前不写入该键不做校验）。
/// 判定顺序：绑定残缺(VerifyError) → 网络路径拒(PathMismatch) → 路径比对 → 哈希比对。
/// SHA256 由调用方（pipe_server_once）计算传入，本函数不落 IO
pub fn validate_caller(client_exe: &str, client_sha256: &str, bound: &Bound) -> ErrCode {
    // 绑定记录残缺（未绑定/半写状态）：整体不可验证
    if bound.path.is_empty() || bound.sha256.is_empty() {
        return ErrCode::VerifyError;
    }
    let exe = normalize_path(client_exe);
    // 网络路径拒收（§0.1 调用者必须为本机应用）：UNC 直形（剥前缀后仍以 `\\` 开头）与
    // `\\?\UNC\...` 剥前缀形（`unc\` 开头）两种形态
    if exe.starts_with(r"\\") || exe.starts_with(r"unc\") {
        return ErrCode::PathMismatch;
    }
    if exe != normalize_path(&bound.path) {
        return ErrCode::PathMismatch;
    }
    if client_sha256.to_lowercase() != bound.sha256.to_lowercase() {
        return ErrCode::HashMismatch;
    }
    ErrCode::Ok
}

/// 路径归一化（§0.1，对齐 Chrome MaybeTrimProcessPath 的防混淆目的）：to_lowercase +
/// 剥 `\\?\` 设备前缀。不 trim 版本目录——我们用哈希绑定，升级必须重绑，trim 反而错误。
/// `\\?\UNC\server\share` 剥前缀后成 `unc\server\share`，UNC 形态由调用方识别拒收
fn normalize_path(path: &str) -> String {
    let lower = path.to_lowercase();
    match lower.strip_prefix(r"\\?\") {
        Some(rest) => rest.to_string(),
        None => lower,
    }
}

/// 管道 DACL 构造（R6-M2 兼容式收紧）：发起用户 SID 可得且形态合法时把读写 ACE 从
/// Authenticated Users（AU，多用户机器任意本地用户可连）收窄到该用户；缺失/非法回退
/// [`PIPE_SDDL_FALLBACK`]（保底可用）。SYSTEM/Administrators ACE 与拒绝继承标记恒保留
fn pipe_sddl_for(caller_sid: Option<&str>) -> String {
    match caller_sid {
        Some(sid) if is_plausible_sid_string(sid) => {
            format!("D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GRGW;;;{sid})")
        }
        _ => PIPE_SDDL_FALLBACK.to_string(),
    }
}

/// CallerSid 形态校验（服务端消费前验证）：仅接受 `S-1-` 前缀 + 纯数字段、总长 ≤184
/// （Windows SID 字符串上界）——HKLM 值被篡改/写坏时不得污染 SDDL 语义（回退兜底形态）
fn is_plausible_sid_string(s: &str) -> bool {
    if s.len() > 184 {
        return false;
    }
    let Some(rest) = s.strip_prefix("S-1-") else {
        return false;
    };
    !rest.is_empty()
        && rest
            .split('-')
            .all(|seg| !seg.is_empty() && seg.bytes().all(|b| b.is_ascii_digit()))
}

// ---------- 请求分派（纯逻辑，FakeStore 单测） ----------

/// 单请求分派：msg/payload 来自已 decode 的帧，store 为绑定+包裹存储。
/// 返回 (errcode, 附加数据)；Resp 帧由调用方经 [`resp_frame`] 统一加 u16 LE errcode 前缀。
/// 契约：进入本函数的连接已通过调用者验证（验证失败在 pipe_server_once 连接级短路），
/// 失配者收到的是连接级错误码 Resp——「是否匹配调用者」由 Resp 层 errcode 语义承担，
/// Status JSON 不再冗余携带 matches_caller 字段
pub(crate) fn handle_payload(
    msg: MsgType,
    payload: &[u8],
    store: &mut dyn ElevationStore,
) -> (ErrCode, Vec<u8>) {
    match msg {
        MsgType::Wrap => wrap_dek(payload, store),
        MsgType::Unwrap => unwrap_dek(store),
        MsgType::Status => status_json(store),
        // Remove 幂等（值不存在等同成功）；绑定键 BoundPath/BoundSha256 保留，
        // 由卸载/重绑通道清理（§0.1）
        MsgType::Remove => {
            store.delete_wrapped();
            (ErrCode::Ok, Vec::new())
        }
        // 服务端不受理 Resp（客户端→服务端单向请求协议）
        MsgType::Resp => (ErrCode::BadRequest, Vec::new()),
    }
}

/// Wrap：payload 必须恰为 32B DEK；SYSTEM 上下文 CryptProtectData（无附加熵，§0.1——
/// 与用户态 dek 通道的应用熵绑定刻意不同：包裹绑 SYSTEM 用户库，用户区不可解）→
/// base64 前拼 [`DEK_MARKER`] 存 WrappedDek（REG_SZ，与 security.json 包裹形态同构便于排查）。
/// DEK 明文与密文缓冲处理完立即 zeroize
fn wrap_dek(payload: &[u8], store: &mut dyn ElevationStore) -> (ErrCode, Vec<u8>) {
    if payload.len() != 32 {
        return (ErrCode::BadRequest, Vec::new());
    }
    let mut dek = [0u8; 32];
    dek.copy_from_slice(payload);
    let cipher = match crate::platform_security::dpapi_protect_bytes(&dek, None) {
        Ok(c) => c,
        Err(e) => {
            dek.zeroize();
            eprintln!("[elevation-service] DPAPI protect 失败: {e}");
            return (ErrCode::Internal, Vec::new());
        }
    };
    dek.zeroize();
    let mut value = String::from(DEK_MARKER);
    value.push_str(&base64::engine::general_purpose::STANDARD.encode(&cipher));
    let mut cipher = cipher;
    cipher.zeroize();
    if store.write_wrapped(&value) {
        (ErrCode::Ok, Vec::new())
    } else {
        (ErrCode::Internal, Vec::new())
    }
}

/// Unwrap：读 WrappedDek → 剥 marker → base64 → CryptUnprotectData → 强校验明文 32B →
/// 附加数据返回明文 DEK（调用方写出响应后 zeroize；本函数不留副本）。
/// 存储值形态损坏（无 marker/非 base64/明文非 32B）→ Internal（值在但不可解）
fn unwrap_dek(store: &mut dyn ElevationStore) -> (ErrCode, Vec<u8>) {
    let Some(wrapped) = store.read_wrapped() else {
        return (ErrCode::NoWrappedDek, Vec::new());
    };
    let Some(b64) = wrapped.strip_prefix(DEK_MARKER) else {
        return (ErrCode::Internal, Vec::new());
    };
    let cipher = match base64::engine::general_purpose::STANDARD.decode(b64) {
        Ok(c) => c,
        Err(_) => return (ErrCode::Internal, Vec::new()),
    };
    let mut plain = match crate::platform_security::dpapi_unprotect_bytes(&cipher, None) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("[elevation-service] DPAPI unprotect 失败: {e}");
            return (ErrCode::Internal, Vec::new());
        }
    };
    if plain.len() != 32 {
        plain.zeroize();
        return (ErrCode::Internal, Vec::new());
    }
    (ErrCode::Ok, plain)
}

/// Status：JSON `{bound_path, sha256_prefix(8), version}`（§0.1）。
/// 未绑定 → VerifyError（brief：Bound 缺失全部请求回 VerifyError）
fn status_json(store: &mut dyn ElevationStore) -> (ErrCode, Vec<u8>) {
    let Some(bound) = store.read_bound() else {
        return (ErrCode::VerifyError, Vec::new());
    };
    let json = serde_json::json!({
        "bound_path": bound.path,
        "sha256_prefix": bound.sha256.chars().take(8).collect::<String>(),
        "version": env!("CARGO_PKG_VERSION"),
    });
    (ErrCode::Ok, json.to_string().into_bytes())
}

/// 构造 Resp 帧：契约（Task 1 审查裁定）——全部 Resp 帧恒以 u16 LE errcode 前缀开头
/// （ok=0），JSON/DEK 为附加数据；客户端按此解析
fn resp_frame(code: ErrCode, extra: &[u8]) -> Vec<u8> {
    let mut payload = Vec::with_capacity(2 + extra.len());
    payload.extend_from_slice(&code.to_u16().to_le_bytes());
    payload.extend_from_slice(extra);
    encode_frame(MsgType::Resp, &payload)
}

// ---------- 单连接处理（IO 薄壳，单测不覆盖） ----------

/// 处理单连接（§0.1）：连接级验证 → 按契约读一帧 → 分派 → 写 Resp →（调用方）断开。
/// 任何失败写一条错误响应后返回；服务主循环随后 DisconnectNamedPipe 并检查停止标志。
/// 全程帧收发带 deadline（R6-M1）：慢连接/半帧停住的连接超时断开，服务循环不被卡死
fn pipe_server_once(pipe: HANDLE) {
    let mut store = HklmStore;
    let deadline = Instant::now() + FRAME_DEADLINE;
    // ① 连接级验证：未绑定 → VerifyError（brief：Bound 缺失全部请求回 VerifyError——
    //    连接级短路下每个连接恰得一条 VerifyError 响应，语义一致且实现最简）
    let Some(bound) = store.read_bound() else {
        respond(pipe, ErrCode::VerifyError, deadline);
        return;
    };
    let verdict = match verify_client_process(pipe) {
        Some((client_exe, client_sha256)) => validate_caller(&client_exe, &client_sha256, &bound),
        // PID/进程句柄/镜像路径/文件哈希任一不可得：无法证明身份，一律拒绝
        None => ErrCode::VerifyError,
    };
    if verdict != ErrCode::Ok {
        respond(pipe, verdict, deadline);
        return;
    }
    // ② 读帧——契约（Task 1 审查裁定）：先验 declared ≤ MAX_FRAME_LEN 再分配/读取；
    //    decode_frame 只在字节读入后判定，若先按声明 len（可达 4GB）读体即是无界分配洞。
    //    超限回 BadRequest 且不读体，随后断开。读头/读体共享同一 deadline（R6-M1）：
    //    超时静默断开——不回包（对端停住收不到）、不 eprintln（防低权者灌满服务日志）
    let mut frame = match read_request_frame(pipe, deadline) {
        FrameRead::Frame(f) => f,
        FrameRead::TooLarge => {
            respond(pipe, ErrCode::BadRequest, deadline);
            return;
        }
        // 头/体未读满即断开（含停机自唤醒空连接与读超时）：无可响应对象
        FrameRead::Eof => return,
    };
    // ③ 形状终审 + 分派 + 响应
    let (msg, payload) = match decode_frame(&frame) {
        Ok(x) => x,
        Err(_) => {
            respond(pipe, ErrCode::BadRequest, deadline);
            frame.zeroize();
            return;
        }
    };
    let (code, mut extra) = handle_payload(msg, payload, &mut store);
    let mut resp = resp_frame(code, &extra);
    // 写响应同样过 deadline（R6-M1）：客户端连接后不读时 CancelIo 收尾断开，
    // SYSTEM 服务线程不悬挂
    write_all_with_deadline(pipe, &resp, deadline);
    // DEK 清理（Global Constraints）：请求 Wrap 载荷与响应 Unwrap 附加数据均为明文 DEK，
    // 处理完立即 zeroize（Task 3 审查裁定：写失败路径同样清零——对端断开不代表进程内
    // 缓冲可留明文；服务端 Unwrap 契约是「不落明文副本」而非「成功送达才清」）
    if msg == MsgType::Unwrap {
        resp[RESP_WIRE_HEADER_LEN..].zeroize();
    }
    extra.zeroize();
    frame.zeroize();
}

/// 读一帧请求。契约（Task 1 审查裁定）读序：先读 4B 头 → u32 LE 解 declared →
/// `declared > MAX_FRAME_LEN` 即 TooLarge（调用方回 BadRequest 且不读体）→
/// 否则按 declared 精确读体 → 交 decode_frame 终审。头与体共享 deadline（R6-M1）
fn read_request_frame(pipe: HANDLE, deadline: Instant) -> FrameRead {
    let mut header = [0u8; 4];
    if !read_exact_with_deadline(pipe, &mut header, deadline) {
        return FrameRead::Eof;
    }
    let declared = u32::from_le_bytes(header) as usize;
    if declared > MAX_FRAME_LEN {
        // 只做比较判定，不按声明值分配/读取（无界分配拒绝点在 decode 之前）
        return FrameRead::TooLarge;
    }
    let mut buf = Vec::with_capacity(4 + declared);
    buf.extend_from_slice(&header);
    let body_start = buf.len();
    buf.resize(body_start + declared, 0);
    if !read_exact_with_deadline(pipe, &mut buf[body_start..], deadline) {
        return FrameRead::Eof;
    }
    FrameRead::Frame(buf)
}

enum FrameRead {
    /// 完整帧字节（u32 LE len ‖ body），交 decode_frame 终审
    Frame(Vec<u8>),
    /// 声明长度超上限（不读体）
    TooLarge,
    /// 头/体未读满即 EOF、IO 失败或超时（超时与断开同等处理：静默断开本次连接）
    Eof,
}

/// 字节模式管道带超时精确读（PIPE_TYPE_BYTE 流语义；镜像 elevation_client 的
/// PeekNamedPipe 轮询 + deadline 方案，R6-M1）：到 deadline 仍无新字节 → false
/// （调用方断开本次连接，服务循环继续）。Peek 确认有数据再 ReadFile——available>0
/// 保证 ReadFile 不阻塞，等待期以 READ_POLL_INTERVAL 粒度让出线程
fn read_exact_with_deadline(pipe: HANDLE, buf: &mut [u8], deadline: Instant) -> bool {
    use windows::Win32::Storage::FileSystem::ReadFile;
    use windows::Win32::System::Pipes::PeekNamedPipe;

    let mut filled = 0usize;
    while filled < buf.len() {
        let mut available = 0u32;
        if unsafe { PeekNamedPipe(pipe, None, 0, None, Some(&mut available), None) }.is_err() {
            return false;
        }
        if available == 0 {
            if Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(READ_POLL_INTERVAL);
            continue;
        }
        let mut n = 0u32;
        if unsafe { ReadFile(pipe, Some(&mut buf[filled..]), Some(&mut n), None) }.is_err() {
            return false;
        }
        if n == 0 {
            return false; // 客户端断开（EOF）
        }
        filled += n as usize;
    }
    true
}

/// 字节模式管道带超时精确写（R6-M1）：重叠 WriteFile + 事件等待，超时 CancelIoEx
/// 取消未决写并等其终结后才失效 OVERLAPPED/事件。响应帧 ≤64KiB 与管道出缓冲同量级、
/// 正常路径单次写入即入缓冲不阻塞；此处防客户端连接后不读响应卡死 SYSTEM 服务线程
fn write_all_with_deadline(pipe: HANDLE, buf: &[u8], deadline: Instant) -> bool {
    use windows::core::{HRESULT, PCWSTR};
    use windows::Win32::Foundation::{ERROR_IO_PENDING, WAIT_OBJECT_0};
    use windows::Win32::Storage::FileSystem::WriteFile;
    use windows::Win32::System::Threading::{CreateEventW, WaitForSingleObject};
    use windows::Win32::System::IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED};

    let Ok(event) = (unsafe { CreateEventW(None, true, false, PCWSTR::null()) }) else {
        return false;
    };
    let mut written = 0usize;
    while written < buf.len() {
        let mut n = 0u32;
        let mut overlapped = OVERLAPPED {
            hEvent: event,
            ..Default::default()
        };
        match unsafe {
            WriteFile(
                pipe,
                Some(&buf[written..]),
                Some(&mut n),
                Some(&mut overlapped),
            )
        } {
            // 同步完成（数据入管道缓冲即返回）
            Ok(()) if n > 0 => written += n as usize,
            Ok(()) => break, // 零写入（不应发生，防御性视同失败）
            Err(e) if e.code() == HRESULT::from_win32(ERROR_IO_PENDING.0) => {
                let remaining = deadline.saturating_duration_since(Instant::now());
                let waited = unsafe { WaitForSingleObject(event, remaining.as_millis() as u32) };
                if waited == WAIT_OBJECT_0 {
                    let mut got = 0u32;
                    if unsafe { GetOverlappedResult(pipe, &overlapped, &mut got, false) }.is_err()
                        || got == 0
                    {
                        break;
                    }
                    written += got as usize;
                } else {
                    // 超时/等待异常：取消未决写并等其终结（OVERLAPPED 与事件在其后
                    // 才出作用域），断开本次连接
                    unsafe {
                        let _ = CancelIoEx(pipe, Some(&overlapped));
                        let mut got = 0u32;
                        let _ = GetOverlappedResult(pipe, &overlapped, &mut got, true);
                    }
                    break;
                }
            }
            Err(_) => break,
        }
    }
    unsafe {
        let _ = CloseHandle(event);
    }
    written == buf.len()
}

/// 写一条错误响应（验证失败/坏请求路径；写失败静默——对端可能已断开）
fn respond(pipe: HANDLE, code: ErrCode, deadline: Instant) {
    let _ = write_all_with_deadline(pipe, &resp_frame(code, &[]), deadline);
}

// ---------- 调用者身份取证（IO 薄壳） ----------

/// 连接级身份取证（§0.1）：连接建立后立即取客户端 PID → 开快照句柄（防 PID 复用 TOCTOU）
/// → 查镜像路径 → SHA256(exe 文件) hex。任一步失败 → None（调用方回 VerifyError）
fn verify_client_process(pipe: HANDLE) -> Option<(String, String)> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Pipes::GetNamedPipeClientProcessId;
    use windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};

    let mut pid = 0u32;
    unsafe { GetNamedPipeClientProcessId(pipe, &mut pid) }.ok()?;
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }.ok()?;
    let image = query_process_image(process);
    unsafe {
        let _ = CloseHandle(process);
    }
    let image = image?;
    // R6-I2：双读比较 + 无写共享打开，缓解便携版形态的文件替换 TOCTOU
    // （sha256_file_double_read 注释；README 威胁模型「不防」清单已同步登记残余面）
    let sha256 = sha256_file_double_read(&image)?;
    Some((image, sha256))
}

/// QueryFullProcessImageNameW（PROCESS_NAME_WIN32 形态）：常规 1K UTF-16 足够，
/// 极端长路径升 8K 重试一次
fn query_process_image(process: HANDLE) -> Option<String> {
    use windows::core::PWSTR;
    use windows::Win32::System::Threading::{QueryFullProcessImageNameW, PROCESS_NAME_WIN32};

    for capacity in [1024u32, 8192] {
        let mut buf = vec![0u16; capacity as usize];
        let mut size = capacity;
        if unsafe {
            QueryFullProcessImageNameW(
                process,
                PROCESS_NAME_WIN32,
                PWSTR(buf.as_mut_ptr()),
                &mut size,
            )
        }
        .is_ok()
        {
            buf.truncate(size as usize);
            return Some(String::from_utf16_lossy(&buf));
        }
    }
    None
}

/// SHA256(exe 文件字节) 小写 hex（流式读，不整文件进内存）；Task 3 安装侧复用
pub(crate) fn sha256_file_hex(path: &str) -> Option<String> {
    let file = std::fs::File::open(path).ok()?;
    let mut hasher = sha2::Sha256::new();
    std::io::copy(&mut std::io::BufReader::new(file), &mut hasher).ok()?;
    Some(
        hasher
            .finalize()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect(),
    )
}

/// 双读比较哈希（R6-I2）：以无 FILE_SHARE_WRITE 共享模式打开读两次，两次一致才返回。
/// 威胁：std File::open 以 READ|WRITE|DELETE 宽共享打开，对「进程运行中 rename 自身并在
/// 原路径写入合法字节」的文件替换 TOCTOU 无防御（便携版冒充调用者取 DEK）。缓解手法：
/// ① 受限共享打开（READ|DELETE，留 DELETE 免杀软/更新器误伤）——存在并发写句柄即
///    ERROR_SHARING_VIOLATION，判定为可疑拒绝；句柄存续至哈希读取完成；
/// ② 双读比较——「读窗口外替换、下次读前还原」的两窗重合攻击面被压缩。
/// 任一读失败/两次不一致 → None（不可验证，调用方回 VerifyError）。
/// 根本方案为 Authenticode 签名校验（SignerSubject 预留位），登记 backlog 另立 round
pub(crate) fn sha256_file_double_read(path: &str) -> Option<String> {
    let first = sha256_file_hex_shared(path)?;
    let second = sha256_file_hex_shared(path)?;
    double_read_verdict(Some(first), Some(second))
}

/// 双读比较裁决（纯逻辑，R6-I2 可测核心）：两次哈希均可得且一致才通过
fn double_read_verdict(first: Option<String>, second: Option<String>) -> Option<String> {
    match (first, second) {
        (Some(a), Some(b)) if a == b => Some(a),
        _ => None,
    }
}

/// 共享受限打开（无 FILE_SHARE_WRITE）+ 流式 SHA256 小写 hex。
/// FILE_SHARE_READ|DELETE：允许并发读者（杀软扫描/同进程二次打开），仅拒并发写——
/// 打开瞬间若已有写句柄即共享冲突失败，本句柄存续期间新的写打开同样被拒
fn sha256_file_hex_shared(path: &str) -> Option<String> {
    use std::os::windows::io::FromRawHandle;
    use windows::Win32::Storage::FileSystem::{
        CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_DELETE, FILE_SHARE_READ, OPEN_EXISTING,
    };

    let wide = to_wide(path);
    let opened = unsafe {
        CreateFileW(
            PCWSTR(wide.as_ptr()),
            windows::Win32::Foundation::GENERIC_READ.0,
            FILE_SHARE_READ | FILE_SHARE_DELETE,
            None,
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL,
            None,
        )
    };
    // 裸句柄交 std::fs::File 托管（Drop 即 CloseHandle），流式读复用 sha256_file_hex 同款形态
    let file = unsafe { std::fs::File::from_raw_handle(opened.ok()?.0) };
    let mut hasher = sha2::Sha256::new();
    std::io::copy(&mut std::io::BufReader::new(file), &mut hasher).ok()?;
    Some(
        hasher
            .finalize()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect(),
    )
}

// ---------- HKLM 存储（windows crate 原生最小实现；Task 3 引 windows-registry 后统一） ----------

/// 真实 HKLM 存储体（§0.2 键值；SYSTEM/Administrators 可写、Users 读的默认 HKLM ACL 已满足）
pub(crate) struct HklmStore;

impl ElevationStore for HklmStore {
    fn read_bound(&self) -> Option<Bound> {
        let key = open_key(KEY_READ)?;
        let path = reg_read_sz(key, REG_BOUND_PATH);
        let sha256 = reg_read_sz(key, REG_BOUND_SHA);
        unsafe {
            let _ = RegCloseKey(key);
        }
        Some(Bound {
            path: path?,
            sha256: sha256?,
        })
    }

    fn read_wrapped(&self) -> Option<String> {
        let key = open_key(KEY_READ)?;
        let value = reg_read_sz(key, REG_WRAPPED_DEK);
        unsafe {
            let _ = RegCloseKey(key);
        }
        value
    }

    fn write_wrapped(&mut self, value: &str) -> bool {
        reg_write_sz(REG_WRAPPED_DEK, value)
    }

    fn delete_wrapped(&mut self) {
        let Some(key) = open_key(KEY_SET_VALUE) else {
            return;
        };
        unsafe {
            // 值不存在（ERROR_FILE_NOT_FOUND）= 幂等成功；其余失败同样吞掉：
            // SYSTEM 对自有键删除不应失败，且 Remove 语义本就要求幂等
            let _ = RegDeleteValueW(key, PCWSTR(to_wide(REG_WRAPPED_DEK).as_ptr()));
            let _ = RegCloseKey(key);
        }
    }
}

/// 读 HKLM CallerSid（R6-M2：安装侧写入的发起用户 SID 字符串）；键/值缺失 → None
fn read_caller_sid() -> Option<String> {
    let key = open_key(KEY_READ)?;
    let value = reg_read_sz(key, REG_CALLER_SID);
    unsafe {
        let _ = RegCloseKey(key);
    }
    value
}

fn open_key(access: REG_SAM_FLAGS) -> Option<HKEY> {
    let mut key = HKEY::default();
    let status = unsafe {
        RegOpenKeyExW(
            HKEY_LOCAL_MACHINE,
            PCWSTR(to_wide(REG_SUBKEY).as_ptr()),
            None,
            access,
            &mut key,
        )
    };
    if status != ERROR_SUCCESS {
        return None;
    }
    Some(key)
}

/// 读 REG_SZ（UTF-16，双探长度后读值；尾部 NUL 容错剥离）
fn reg_read_sz(key: HKEY, name: &str) -> Option<String> {
    let wname = to_wide(name);
    let name_ptr = PCWSTR(wname.as_ptr());
    let mut size = 0u32;
    if unsafe { RegQueryValueExW(key, name_ptr, None, None, None, Some(&mut size)) }
        != ERROR_SUCCESS
    {
        return None;
    }
    let mut buf = vec![0u8; size as usize + 2]; // +2B：兜底缺失的 UTF-16 结尾 NUL
    if unsafe {
        RegQueryValueExW(
            key,
            name_ptr,
            None,
            None,
            Some(buf.as_mut_ptr()),
            Some(&mut size),
        )
    } != ERROR_SUCCESS
    {
        return None;
    }
    buf.truncate(size as usize);
    let units: Vec<u16> = buf
        .as_chunks::<2>()
        .0
        .iter()
        .map(|c| u16::from_le_bytes(*c))
        .collect();
    Some(
        String::from_utf16_lossy(&units)
            .trim_end_matches('\0')
            .to_string(),
    )
}

/// 建/打开 HKLM 绑定键（Task 3 安装侧；键不存在则创建）。安装进程已提权，默认 HKLM
/// 子键 ACL（SYSTEM/Administrators 可写、Users 读）即 §0.2 要求，无需自定义
pub(crate) fn reg_ensure_key() -> bool {
    let mut key = HKEY::default();
    let status = unsafe {
        RegCreateKeyExW(
            HKEY_LOCAL_MACHINE,
            PCWSTR(to_wide(REG_SUBKEY).as_ptr()),
            None, // reserved
            PCWSTR::null(),
            REG_OPTION_NON_VOLATILE,
            KEY_SET_VALUE,
            None,
            &mut key,
            None,
        )
    };
    if status != ERROR_SUCCESS {
        return false;
    }
    unsafe {
        let _ = RegCloseKey(key);
    }
    true
}

/// 删除 HKLM 绑定键整棵子树（Task 3 卸载侧）。键不存在（未安装/已删）视同幂等成功
pub(crate) fn reg_delete_key() -> bool {
    let status =
        unsafe { RegDeleteTreeW(HKEY_LOCAL_MACHINE, PCWSTR(to_wide(REG_SUBKEY).as_ptr())) };
    status == ERROR_SUCCESS || status == ERROR_FILE_NOT_FOUND
}

/// 写 REG_SZ（数据须含 UTF-16 结尾 NUL，to_wide 已带）
pub(crate) fn reg_write_sz(name: &str, value: &str) -> bool {
    let Some(key) = open_key(KEY_SET_VALUE) else {
        return false;
    };
    let data = to_wide(value);
    let bytes = unsafe { std::slice::from_raw_parts(data.as_ptr().cast::<u8>(), data.len() * 2) };
    let status = unsafe {
        RegSetValueExW(
            key,
            PCWSTR(to_wide(name).as_ptr()),
            None,
            REG_SZ,
            Some(bytes),
        )
    };
    unsafe {
        let _ = RegCloseKey(key);
    }
    status == ERROR_SUCCESS
}

/// UTF-16 宽串（带结尾 NUL）；Task 3 安装侧（SDDL/目录路径）复用
pub(crate) fn to_wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

// ---------- 管道实例与服务循环 ----------

/// 创建管道实例（§0.1）。偏差说明：dwOpenMode 用 PIPE_ACCESS_DUPLEX——计划文本写的
/// PIPE_ACCESS_INBOUND 只给服务端读权限，与 §0.1 自身「服务端写 Resp 帧」语义互斥，
/// 帧协议（请求+响应）必须双向。首实例带 FILE_FLAG_FIRST_PIPE_INSTANCE（防管道名被抢占）。
/// dwPipeMode 含 PIPE_REJECT_REMOTE_CLIENTS（拒远程连接）。实例数上界
/// PIPE_UNLIMITED_INSTANCES，实际仅建单实例串行服务（单用户 UI 场景足够；并发客户端
/// 收 ERROR_PIPE_BUSY 由客户端 WaitNamedPipeW 短重试消化——elevation_client::open_pipe，
/// I3 终审）。DACL 形态由调用方经 sddl 传入（R6-M2：按 CallerSid 收窄或 AU 兜底）
fn create_pipe_instance(sddl_str: &str, first: bool) -> Result<HANDLE, ServiceError> {
    use windows::core::Error as WinError;
    use windows::Win32::Foundation::{LocalFree, HLOCAL, INVALID_HANDLE_VALUE};
    use windows::Win32::Security::Authorization::{
        ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
    };
    use windows::Win32::Security::{PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES};
    use windows::Win32::Storage::FileSystem::{FILE_FLAG_FIRST_PIPE_INSTANCE, PIPE_ACCESS_DUPLEX};
    use windows::Win32::System::Pipes::{
        CreateNamedPipeW, NAMED_PIPE_MODE, PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS,
        PIPE_TYPE_BYTE, PIPE_UNLIMITED_INSTANCES, PIPE_WAIT,
    };

    let name = to_wide(PIPE_NAME);
    let sddl = to_wide(sddl_str);
    let mut psd = PSECURITY_DESCRIPTOR(std::ptr::null_mut());
    unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            PCWSTR(sddl.as_ptr()),
            SDDL_REVISION_1,
            &mut psd,
            None,
        )
    }
    .map_err(|e| ServiceError(format!("SDDL→安全描述符转换失败: {e}")))?;
    let sa = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: psd.0,
        bInheritHandle: false.into(),
    };
    let mut open_mode = PIPE_ACCESS_DUPLEX;
    if first {
        open_mode |= FILE_FLAG_FIRST_PIPE_INSTANCE;
    }
    let pipe_mode: NAMED_PIPE_MODE =
        PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS;
    let handle = unsafe {
        CreateNamedPipeW(
            PCWSTR(name.as_ptr()),
            open_mode,
            pipe_mode,
            PIPE_UNLIMITED_INSTANCES,
            PIPE_BUFFER_SIZE,
            PIPE_BUFFER_SIZE,
            0,
            Some(&sa),
        )
    };
    // 描述符已拷贝进内核对象，立即释放
    unsafe {
        let _ = LocalFree(Some(HLOCAL(psd.0)));
    }
    if handle == INVALID_HANDLE_VALUE {
        return Err(ServiceError(format!(
            "CreateNamedPipeW 失败: {}",
            WinError::from_win32()
        )));
    }
    Ok(handle)
}

/// 服务主体：control handler（Stop/Shutdown 置停止事件）→ StartPending → 建管道实例 →
/// Running → 连接循环 → StopPending → Stopped。scm=false 时状态上报为 no-op
/// （非 SCM 直跑调试路径，见 run_service）
fn service_run(scm: bool) -> Result<(), ServiceError> {
    use windows::core::PCWSTR;
    use windows::Win32::System::Threading::{CreateEventW, SetEvent};
    use windows_service::service::{ServiceControl, ServiceControlAccept, ServiceExitCode};
    use windows_service::service_control_handler::{self, ServiceControlHandlerResult};

    let stop_event = unsafe { CreateEventW(None, true, false, PCWSTR::null()) }
        .map_err(|e| ServiceError(format!("CreateEventW(stop) 失败: {e}")))?;
    let status = if scm {
        // HANDLE 非 Send（裸指针），'static 闭包捕获以 isize 中转
        let raw = stop_event.0 as isize;
        let handler = move |control: ServiceControl| -> ServiceControlHandlerResult {
            match control {
                ServiceControl::Stop | ServiceControl::Shutdown => {
                    let event = HANDLE(raw as *mut core::ffi::c_void);
                    unsafe {
                        let _ = SetEvent(event);
                    }
                    ServiceControlHandlerResult::NoError
                }
                ServiceControl::Interrogate => ServiceControlHandlerResult::NoError,
                _ => ServiceControlHandlerResult::NotImplemented,
            }
        };
        Some(
            service_control_handler::register(SERVICE_NAME, handler)
                .map_err(|e| ServiceError(format!("register control handler 失败: {e}")))?,
        )
    } else {
        None
    };
    report_status(
        &status,
        ServiceState::StartPending,
        ServiceControlAccept::empty(),
        ServiceExitCode::NO_ERROR,
    )?;
    // 管道 DACL 收窄（R6-M2）：读 HKLM CallerSid 构造发起用户 SDDL；缺失/非法回退
    // AU 兜底（保底可用）并 console 留痕（不 abort——装好即用优于拒绝服务）
    let caller_sid = read_caller_sid().filter(|s| is_plausible_sid_string(s));
    if caller_sid.is_none() {
        eprintln!(
            "[elevation-service] HKLM CallerSid 缺失或非法，管道 DACL 回退 Authenticated Users 兜底"
        );
    }
    let pipe = match create_pipe_instance(&pipe_sddl_for(caller_sid.as_deref()), true) {
        Ok(p) => p,
        Err(e) => {
            let _ = report_status(
                &status,
                ServiceState::Stopped,
                ServiceControlAccept::empty(),
                ServiceExitCode::Win32(1),
            );
            return Err(e);
        }
    };
    report_status(
        &status,
        ServiceState::Running,
        ServiceControlAccept::STOP,
        ServiceExitCode::NO_ERROR,
    )?;
    serve_loop(pipe, stop_event);
    unsafe {
        let _ = CloseHandle(pipe);
        let _ = CloseHandle(stop_event);
    }
    let _ = report_status(
        &status,
        ServiceState::StopPending,
        ServiceControlAccept::empty(),
        ServiceExitCode::NO_ERROR,
    );
    let _ = report_status(
        &status,
        ServiceState::Stopped,
        ServiceControlAccept::empty(),
        ServiceExitCode::NO_ERROR,
    );
    Ok(())
}

/// SCM 状态上报薄壳（scm=false 时恒 Ok）；wait_hint 5s 仅对 pending 态有意义
fn report_status(
    status: &Option<windows_service::service_control_handler::ServiceStatusHandle>,
    state: windows_service::service::ServiceState,
    controls_accepted: windows_service::service::ServiceControlAccept,
    exit_code: windows_service::service::ServiceExitCode,
) -> Result<(), ServiceError> {
    use windows_service::service::{ServiceStatus, ServiceType};

    let Some(handle) = status else {
        return Ok(());
    };
    handle
        .set_service_status(ServiceStatus {
            service_type: ServiceType::OWN_PROCESS,
            current_state: state,
            controls_accepted,
            exit_code,
            checkpoint: 0,
            wait_hint: Duration::from_secs(5),
            process_id: None,
        })
        .map_err(|e| ServiceError(format!("set_service_status({state:?}) 失败: {e}")))
}

/// 连接循环（§0.1）：ConnectNamedPipe（重叠等待 [连接完成, 停止]）→ pipe_server_once →
/// DisconnectNamedPipe → 每连接前检查停止标志。Stop 即时生效：重叠等待被停止事件唤醒即退出，
/// 不等下一个客户端
fn serve_loop(pipe: HANDLE, stop_event: HANDLE) {
    use windows::core::{HRESULT, PCWSTR};
    use windows::Win32::Foundation::{ERROR_IO_PENDING, ERROR_PIPE_CONNECTED, WAIT_OBJECT_0};
    use windows::Win32::System::Pipes::{ConnectNamedPipe, DisconnectNamedPipe};
    use windows::Win32::System::Threading::{
        CreateEventW, ResetEvent, WaitForMultipleObjects, WaitForSingleObject, INFINITE,
    };
    use windows::Win32::System::IO::{GetOverlappedResult, OVERLAPPED};

    let pipe_event = match unsafe { CreateEventW(None, true, false, PCWSTR::null()) } {
        Ok(h) => h,
        Err(e) => {
            eprintln!("[elevation-service] CreateEventW(pipe) 失败: {e}");
            return;
        }
    };
    loop {
        // 非阻塞检查停止标志（每连接前）
        if unsafe { WaitForSingleObject(stop_event, 0) } == WAIT_OBJECT_0 {
            break;
        }
        unsafe {
            let _ = ResetEvent(pipe_event);
        }
        let mut overlapped = OVERLAPPED {
            hEvent: pipe_event,
            ..Default::default()
        };
        let mut connected = false;
        let mut stopping = false;
        match unsafe { ConnectNamedPipe(pipe, Some(&mut overlapped)) } {
            Ok(()) => connected = true,
            Err(e) if e.code() == HRESULT::from_win32(ERROR_IO_PENDING.0) => {
                let handles = [pipe_event, stop_event];
                let waited = unsafe { WaitForMultipleObjects(&handles, false, INFINITE) };
                if waited == WAIT_OBJECT_0 {
                    let mut transferred = 0u32;
                    connected =
                        unsafe { GetOverlappedResult(pipe, &overlapped, &mut transferred, false) }
                            .is_ok();
                } else {
                    // 停止事件先行：待决连接随进程退出收尾（句柄由 OS 关闭）
                    if waited.0 != (WAIT_OBJECT_0.0 + 1) {
                        eprintln!("[elevation-service] WaitForMultipleObjects 异常: {waited:?}");
                    }
                    stopping = true;
                }
            }
            // Create 与 Connect 间隙已有客户端连入
            Err(e) if e.code() == HRESULT::from_win32(ERROR_PIPE_CONNECTED.0) => connected = true,
            Err(e) => {
                eprintln!("[elevation-service] ConnectNamedPipe 失败: {e}");
                break;
            }
        }
        if stopping {
            break;
        }
        if connected {
            pipe_server_once(pipe);
        }
        let _ = unsafe { DisconnectNamedPipe(pipe) };
    }
    unsafe {
        let _ = CloseHandle(pipe_event);
    }
}

// ---------- CLI 分派入口 ----------

windows_service::define_windows_service!(ffi_service_main, service_main);

/// `--elevation-service` 入口（run() 最早期分派，服务分支绝不启动 tauri/webview）。
/// 正常路径：SCM 调度器接管（service_dispatcher::start 阻塞至服务停止）。
/// 非 SCM 上下文回落（ERROR_FAILED_SERVICE_CONTROLLER_CONNECT=1063，终端直跑调试）：
/// 直接运行服务循环，无 SCM 状态上报
pub fn run_service() -> Result<(), ServiceError> {
    match windows_service::service_dispatcher::start(SERVICE_NAME, ffi_service_main) {
        Ok(()) => Ok(()),
        Err(windows_service::Error::Winapi(e)) if e.raw_os_error() == Some(1063) => {
            service_run(false).map_err(|e| ServiceError(format!("服务循环失败: {e}")))
        }
        Err(e) => Err(ServiceError(format!("服务调度器启动失败: {e}"))),
    }
}

/// SCM 服务主函数（define_windows_service! 接线目标）
fn service_main(_args: Vec<OsString>) {
    if let Err(e) = service_run(true) {
        eprintln!("[elevation-service] {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::elevation_proto::decode_frame;

    fn bound(path: &str, sha256: &str) -> Bound {
        Bound {
            path: path.into(),
            sha256: sha256.into(),
        }
    }

    fn sha(c: char) -> String {
        std::iter::repeat_n(c, 64).collect()
    }

    const EXE: &str = r"C:\Program Files\TotpTools\TotpTools.exe";

    // ---- validate_caller 六例（brief 清单）----

    #[test]
    fn validate_ok_when_path_and_hash_match() {
        let b = bound(EXE, &sha('a'));
        assert_eq!(validate_caller(EXE, &sha('a'), &b), ErrCode::Ok);
    }

    #[test]
    fn validate_path_mismatch() {
        let b = bound(r"C:\Other\Place\TotpTools.exe", &sha('a'));
        assert_eq!(validate_caller(EXE, &sha('a'), &b), ErrCode::PathMismatch);
    }

    #[test]
    fn validate_hash_mismatch() {
        let b = bound(EXE, &sha('a'));
        assert_eq!(validate_caller(EXE, &sha('b'), &b), ErrCode::HashMismatch);
    }

    #[test]
    fn validate_normalizes_case_device_prefix_and_hash_case() {
        // 调用方小写无前缀 + 哈希大写 vs 绑定 \\?\ 前缀小写哈希：归一化后命中
        let b = bound(r"\\?\C:\Program Files\TotpTools\TotpTools.exe", &sha('a'));
        assert_eq!(
            validate_caller(
                r"c:\program files\totptools\totptools.exe",
                &sha('A').to_uppercase(),
                &b
            ),
            ErrCode::Ok
        );
    }

    #[test]
    fn validate_empty_bound_is_verify_error() {
        assert_eq!(
            validate_caller(EXE, &sha('a'), &bound("", &sha('a'))),
            ErrCode::VerifyError
        );
        assert_eq!(
            validate_caller(EXE, &sha('a'), &bound(EXE, "")),
            ErrCode::VerifyError
        );
    }

    #[test]
    fn validate_unc_paths_rejected_as_path_mismatch() {
        let b = bound(EXE, &sha('a'));
        // UNC 直形
        assert_eq!(
            validate_caller(r"\\server\share\TotpTools.exe", &sha('a'), &b),
            ErrCode::PathMismatch
        );
        // \\?\UNC 剥前缀形
        assert_eq!(
            validate_caller(r"\\?\UNC\server\share\TotpTools.exe", &sha('a'), &b),
            ErrCode::PathMismatch
        );
    }

    // ---- handle_payload 分派（内存 FakeStore，不碰 HKLM/真管道）----

    struct FakeStore {
        bound: Option<Bound>,
        wrapped: Option<String>,
        write_fails: bool,
    }

    impl FakeStore {
        fn new() -> Self {
            Self {
                bound: Some(bound(EXE, &sha('a'))),
                wrapped: None,
                write_fails: false,
            }
        }

        fn unbound() -> Self {
            Self {
                bound: None,
                ..Self::new()
            }
        }
    }

    impl ElevationStore for FakeStore {
        fn read_bound(&self) -> Option<Bound> {
            self.bound.clone()
        }
        fn read_wrapped(&self) -> Option<String> {
            self.wrapped.clone()
        }
        fn write_wrapped(&mut self, value: &str) -> bool {
            if self.write_fails {
                return false;
            }
            self.wrapped = Some(value.to_string());
            true
        }
        fn delete_wrapped(&mut self) {
            self.wrapped = None;
        }
    }

    #[test]
    fn wrap_rejects_non_32b_payload() {
        let mut s = FakeStore::new();
        for bad in [&[][..], &[0u8; 31][..], &[0u8; 33][..], &[0u8; 64][..]] {
            let (code, extra) = handle_payload(MsgType::Wrap, bad, &mut s);
            assert_eq!(code, ErrCode::BadRequest);
            assert!(extra.is_empty());
        }
        assert!(s.wrapped.is_none(), "拒绝路径不得写存储");
    }

    #[test]
    fn unwrap_without_wrapped_is_no_wrapped_dek() {
        let mut s = FakeStore::new();
        let (code, extra) = handle_payload(MsgType::Unwrap, &[], &mut s);
        assert_eq!(code, ErrCode::NoWrappedDek);
        assert!(extra.is_empty());
    }

    #[test]
    fn unwrap_corrupted_store_value_is_internal() {
        let mut s = FakeStore::new();
        // 无 marker 前缀
        s.wrapped = Some("plain-value-without-marker".into());
        assert_eq!(
            handle_payload(MsgType::Unwrap, &[], &mut s).0,
            ErrCode::Internal
        );
        // marker 后非合法 base64
        s.wrapped = Some(format!("{DEK_MARKER}!!!not-base64!!!"));
        assert_eq!(
            handle_payload(MsgType::Unwrap, &[], &mut s).0,
            ErrCode::Internal
        );
    }

    #[test]
    fn remove_is_idempotent_and_unwrap_then_misses() {
        let mut s = FakeStore::new();
        s.wrapped = Some("x".into());
        let (code, extra) = handle_payload(MsgType::Remove, &[], &mut s);
        assert_eq!(code, ErrCode::Ok);
        assert!(extra.is_empty());
        assert!(s.wrapped.is_none());
        // 幂等：已无值再删仍 ok；此后 Unwrap 回 NoWrappedDek
        assert_eq!(handle_payload(MsgType::Remove, &[], &mut s).0, ErrCode::Ok);
        assert_eq!(
            handle_payload(MsgType::Unwrap, &[], &mut s).0,
            ErrCode::NoWrappedDek
        );
    }

    #[test]
    fn resp_msg_type_is_bad_request() {
        let mut s = FakeStore::new();
        assert_eq!(
            handle_payload(MsgType::Resp, &[], &mut s).0,
            ErrCode::BadRequest
        );
    }

    #[test]
    fn status_reports_bound_shape_json() {
        let mut s = FakeStore::new();
        let (code, extra) = handle_payload(MsgType::Status, &[], &mut s);
        assert_eq!(code, ErrCode::Ok);
        let v: serde_json::Value = serde_json::from_slice(&extra).unwrap();
        assert_eq!(v["bound_path"], EXE);
        assert_eq!(v["sha256_prefix"], "aaaaaaaa");
        assert_eq!(v["version"], env!("CARGO_PKG_VERSION"));
        // matches_caller 已删（YAGNI）：「是否匹配调用者」由 Resp 层 errcode 语义承担，
        // 客户端 StatusInfo 从未解析该字段
        assert!(v.get("matches_caller").is_none());
    }

    #[test]
    fn status_without_bound_is_verify_error() {
        let mut s = FakeStore::unbound();
        assert_eq!(
            handle_payload(MsgType::Status, &[], &mut s).0,
            ErrCode::VerifyError
        );
    }

    #[test]
    fn wrap_write_failure_is_internal() {
        let mut s = FakeStore::new();
        s.write_fails = true;
        assert_eq!(
            handle_payload(MsgType::Wrap, &[1u8; 32], &mut s).0,
            ErrCode::Internal
        );
    }

    // Resp 帧契约（Task 1 审查裁定）：恒以 u16 LE errcode 前缀开头，JSON/DEK 为附加数据
    #[test]
    fn resp_frames_always_lead_with_u16_errcode() {
        let frame = resp_frame(ErrCode::NoWrappedDek, b"extra-data");
        let (msg, payload) = decode_frame(&frame).unwrap();
        assert_eq!(msg, MsgType::Resp);
        assert_eq!(
            ErrCode::from_u16(u16::from_le_bytes(payload[..2].try_into().unwrap())),
            Some(ErrCode::NoWrappedDek)
        );
        assert_eq!(&payload[2..], b"extra-data");
        // Status JSON 同样带前缀
        let status = resp_frame(ErrCode::Ok, b"{}");
        let (_, payload) = decode_frame(&status).unwrap();
        assert_eq!(&payload[..2], &0_u16.to_le_bytes());
    }

    // Wrap→Unwrap 真实 DPAPI 往返（模块本身仅 Windows 编译；标注表明依赖真机
    // CryptProtectData/UnprotectData——单测环境可用，brief 裁定）。服务包裹无熵，
    // 与 platform_security 用户态 DEK 通道的应用熵绑定刻意不同（SYSTEM 用户库）
    #[test]
    fn wrap_unwrap_roundtrip_via_real_dpapi() {
        let mut s = FakeStore::new();
        let dek1 = [0x42u8; 32];
        assert_eq!(handle_payload(MsgType::Wrap, &dek1, &mut s).0, ErrCode::Ok);
        let stored = s.wrapped.clone().unwrap();
        assert!(
            stored.starts_with(DEK_MARKER),
            "HKLM 形态恒为 marker+base64"
        );
        let (code, extra) = handle_payload(MsgType::Unwrap, &[], &mut s);
        assert_eq!(code, ErrCode::Ok);
        assert_eq!(extra, dek1);
        // 恒单份替换：再 Wrap 新 DEK 后 Unwrap 只得新 DEK
        let dek2 = [0x7Au8; 32];
        assert_eq!(handle_payload(MsgType::Wrap, &dek2, &mut s).0, ErrCode::Ok);
        assert_ne!(s.wrapped.as_deref(), Some(stored.as_str()));
        assert_eq!(handle_payload(MsgType::Unwrap, &[], &mut s).1, dek2);
    }

    // ---- 管道 DACL 构造（R6-M2：CallerSid 收窄 + 兜底回退）----

    const TEST_SID: &str = "S-1-5-21-1004336348-1177238915-682003330-1001";

    #[test]
    fn pipe_sddl_narrows_to_caller_sid_when_valid() {
        let sddl = pipe_sddl_for(Some(TEST_SID));
        assert!(sddl.starts_with("D:P("), "拒绝继承标记不可丢");
        assert!(sddl.contains("(A;;GA;;;SY)"), "SYSTEM 完全控制不可丢");
        assert!(
            sddl.contains("(A;;GA;;;BA)"),
            "Administrators 完全控制不可丢"
        );
        assert!(
            sddl.contains(&format!("(A;;GRGW;;;{TEST_SID})")),
            "读写 ACE 收窄到发起用户: {sddl}"
        );
        assert!(!sddl.contains("AU"), "收窄形态不得再放 Authenticated Users");
    }

    #[test]
    fn pipe_sddl_falls_back_to_au_when_sid_missing_or_invalid() {
        // 缺失与全部非法形态均回退兜底（保底可用；不因 HKLM 值损坏拒绝服务）
        let sddl_injection = format!("{TEST_SID};D:(A;;FA;;;WD)"); // SDDL 注入形态
        let too_long = format!("S-1-{}", "1-".repeat(100)); // 超长（>184 上界）
        assert_eq!(pipe_sddl_for(None), PIPE_SDDL_FALLBACK);
        for bad in [
            "",
            "AU",
            "garbage",
            "S-2-5-21-1",  // 前缀非法
            "S-1-",        // 空段
            "S-1-5--1004", // 空数字段
            "S-1-5-2x",    // 非数字
            sddl_injection.as_str(),
            too_long.as_str(),
        ] {
            assert_eq!(pipe_sddl_for(Some(bad)), PIPE_SDDL_FALLBACK, "{bad}");
        }
    }

    #[test]
    fn sid_string_validation_accepts_account_shapes() {
        assert!(is_plausible_sid_string(TEST_SID));
        assert!(is_plausible_sid_string("S-1-5-18")); // LocalSystem
        assert!(is_plausible_sid_string("S-1-5-32-544")); // 内置组
        assert!(!is_plausible_sid_string("S-1-"));
        assert!(!is_plausible_sid_string(""));
        assert!(
            !is_plausible_sid_string("s-1-5-18"),
            "大小写敏感（SDDL SID 串恒大写）"
        );
    }

    // ---- 双读哈希（R6-I2：文件替换 TOCTOU 缓解）----

    #[test]
    fn frame_deadline_mirrors_client_io_timeout() {
        // R6-M1：服务端帧收发超时与客户端 IO_TIMEOUT 同源同值（单实例串行服务被慢连接
        // 卡死的 DoS 防线两侧对齐；常量改引用后断言防其一侧漂移回无界等待）
        assert_eq!(FRAME_DEADLINE, crate::elevation_client::IO_TIMEOUT);
        assert_eq!(
            READ_POLL_INTERVAL,
            crate::elevation_client::PEEK_POLL_INTERVAL
        );
        assert_eq!(FRAME_DEADLINE, Duration::from_secs(3));
    }

    #[test]
    fn double_read_verdict_requires_two_consistent_hashes() {
        let a = Some("a".repeat(64));
        let b = Some("b".repeat(64));
        // 两次一致才通过
        assert_eq!(double_read_verdict(a.clone(), a.clone()), a);
        // 任一不一致/不可得即不可验证
        assert_eq!(double_read_verdict(a.clone(), b.clone()), None);
        assert_eq!(double_read_verdict(a.clone(), None), None);
        assert_eq!(double_read_verdict(None, a), None);
    }

    #[test]
    fn double_read_hash_matches_plain_hash_for_stable_file() {
        // 稳定文件：受限共享双读与普通单读哈希一致（受限共享不改变读到的字节）
        let dir = std::env::temp_dir().join(format!(
            "totp-elev-hash-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("victim.exe");
        std::fs::write(&path, b"stable-bytes-0123456789").unwrap();
        let plain = sha256_file_hex(&path.to_string_lossy()).unwrap();
        assert_eq!(
            sha256_file_double_read(&path.to_string_lossy()).as_ref(),
            Some(&plain)
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn shared_hash_rejects_concurrent_write_handle() {
        use windows::Win32::Storage::FileSystem::{FILE_SHARE_NONE, FILE_SHARE_READ};
        // 场景 a：写句柄不共享读（FILE_SHARE_NONE）——受限共享打开即共享冲突失败
        // （可疑判定拒），双读随之 None；释放后恢复可用
        let (path_str, lock) = open_locked(b"locked-bytes", FILE_SHARE_NONE);
        assert!(
            sha256_file_hex_shared(&path_str).is_none(),
            "无读共享的写句柄须被受限打开拒绝"
        );
        assert_eq!(sha256_file_double_read(&path_str), None);
        unsafe {
            let _ = CloseHandle(lock);
        }
        assert!(sha256_file_hex_shared(&path_str).is_some());

        // 场景 b：写句柄共享读（FILE_SHARE_READ）——宽共享的 std::fs::File::open
        // 自带 WRITE 共享位、对既有写句柄照开照读（并发写下读到什么不可控）；
        // 受限共享不授予 WRITE 共享位，与既有写访问冲突即拒（可疑判定）
        let (path_str, lock) = open_locked(b"read-shared-writer", FILE_SHARE_READ);
        assert!(
            sha256_file_hex(&path_str).is_some(),
            "宽共享对并发写句柄无防御（照开照读）"
        );
        assert!(
            sha256_file_hex_shared(&path_str).is_none(),
            "受限共享须对并发写句柄打开即拒"
        );
        unsafe {
            let _ = CloseHandle(lock);
        }
        std::fs::remove_dir_all(temp_lock_dir()).ok();
    }

    /// 测试夹具：写内容文件后以 GENERIC_WRITE + 指定共享模式持住句柄（R6-I2 场景模拟）
    fn open_locked(
        bytes: &[u8],
        share_mode: windows::Win32::Storage::FileSystem::FILE_SHARE_MODE,
    ) -> (String, HANDLE) {
        use windows::Win32::Foundation::GENERIC_WRITE;
        use windows::Win32::Storage::FileSystem::{
            CreateFileW, FILE_ATTRIBUTE_NORMAL, OPEN_EXISTING,
        };

        let dir = temp_lock_dir();
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("locked.exe");
        std::fs::write(&path, bytes).unwrap();
        let path_str = path.to_string_lossy().into_owned();
        let wide = to_wide(&path_str);
        let lock = unsafe {
            CreateFileW(
                PCWSTR(wide.as_ptr()),
                GENERIC_WRITE.0,
                share_mode,
                None,
                OPEN_EXISTING,
                FILE_ATTRIBUTE_NORMAL,
                None,
            )
        }
        .expect("测试写句柄应可打开");
        (path_str, lock)
    }

    fn temp_lock_dir() -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "totp-elev-lock-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }
}
