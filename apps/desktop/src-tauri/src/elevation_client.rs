//! ABE 提权服务应用侧客户端（plan p6 §T4）：打开命名管道 → 写请求帧 → 读 Resp 帧。
//! 帧协议复用 [`crate::elevation_proto`]（单点定义，Global Constraints）。
//!
//! 结构：`transact` 可测核心（读写经闭包注入——内存流单测覆盖半帧/分片/超长声明拒绝）、
//! 真管道薄壳（CreateFileW 打开（ERROR_PIPE_BUSY 经 WaitNamedPipeW 短重试，I3 终审）/
//! PeekNamedPipe 轮询读）与四个高层操作
//! （`status` / `wrap_dek` / `unwrap_dek` / `remove_binding`）。上游契约（Task 1/2 审查裁定）：
//! ① 读循环先验 declared ≤ MAX_FRAME_LEN 再分配/读取（防按恶意声明无界分配，服务端
//!    read_request_frame 同款形态）；② 全部 Resp 帧恒以 u16 LE errcode 前缀开头
//!    （ok=0，JSON/DEK 为附加数据）。

use std::fmt;
use std::time::{Duration, Instant};

use windows::core::PCWSTR;
use windows::Win32::Foundation::{
    CloseHandle, ERROR_BROKEN_PIPE, ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND, ERROR_PIPE_BUSY,
    GENERIC_READ, GENERIC_WRITE, HANDLE,
};
use windows::Win32::Storage::FileSystem::{
    CreateFileW, ReadFile, WriteFile, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_NONE, OPEN_EXISTING,
};
use windows::Win32::System::Pipes::{PeekNamedPipe, WaitNamedPipeW};
use zeroize::Zeroize;

use crate::elevation_proto::{
    decode_frame, encode_frame, ErrCode, MsgType, MAX_FRAME_LEN, PIPE_NAME,
};

/// 单次 call_service 的响应读超时：字节模式同步管道读无内建超时，采用 PeekNamedPipe 轮询
/// 加墙钟 deadline 的硬上界。「阻塞读+信任服务端 3s 内响应」方案在服务端僵死（被调试器
/// 挂起/单线程循环卡在别处）时调用线程永久悬挂（Tauri command 线程泄漏且 UI 无从得知）；
/// 10ms 轮询粒度对 UI 感知无差，3s 与服务端缓冲内响应的正常耗时余量充足。
/// 服务端读帧/写响应同量级复用（R6-M1：慢连接 DoS 防线两侧对齐，避免一侧 3s 一侧无界）
pub(crate) const IO_TIMEOUT: Duration = Duration::from_secs(3);

/// PeekNamedPipe 轮询间隔（IO_TIMEOUT 选型注释；服务端 read_with_deadline 镜像同款）
pub(crate) const PEEK_POLL_INTERVAL: Duration = Duration::from_millis(10);

/// ERROR_PIPE_BUSY 短重试上界（I3 终审修复）：服务单实例串行（elevation_service
/// create_pipe_instance 注释），前一连接未断开时新客户端 CreateFileW 收 ERROR_PIPE_BUSY。
/// WaitNamedPipeW 等待服务端下一实例可用（3×100ms 上界）消并发打开失败面——锁屏 unwrap
/// 与 SecurityCard status/bind 同帧并发是真实场景，直接拒绝会 UP 端折叠为随机失败
const PIPE_BUSY_RETRIES: u32 = 3;
/// WaitNamedPipeW 单次等待毫秒数（nTimeOut；到期返回 false，下轮 CreateFileW 重探管道态）
const PIPE_BUSY_WAIT_MS: u32 = 100;

/// 客户端错误（abe_status 映射 installed/matchesCaller 的分型依据，§T4 审查裁定；
/// 不携带 DEK 等敏感内容）
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClientError {
    /// 管道不存在：服务未安装或未运行（CreateFileW ERROR_FILE_NOT_FOUND/PATH_NOT_FOUND）。
    /// abe_status 据此映射 installed:false
    Unavailable(String),
    /// 管道在但打开被拒（ERROR_PIPE_BUSY 实例全忙/DACL 拒绝等）——服务已安装语义
    OpenFailed(String),
    /// 传输失败（写失败/响应超时/连接中断半途 EOF）
    Io(String),
    /// 响应协议违规（超长声明/非 Resp 类型/errcode 未知/JSON 解析失败）
    Protocol(String),
}

impl fmt::Display for ClientError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unavailable(m) => write!(f, "服务不可达（未安装或未运行）：{m}"),
            Self::OpenFailed(m) => write!(f, "服务管道打开失败：{m}"),
            Self::Io(m) => write!(f, "服务通信失败：{m}"),
            Self::Protocol(m) => write!(f, "服务响应协议违规：{m}"),
        }
    }
}

impl std::error::Error for ClientError {}

/// Status ok 响应的附加数据（JSON 字段 §0.1；失配者拿不到 Status JSON——
/// 版本/绑定路径信息仅匹配者可见，Task 2 审查裁定）
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StatusInfo {
    /// 绑定的调用方 exe 绝对路径（HKLM BoundPath）
    pub bound_path: String,
    /// 绑定 SHA256 前 8 hex
    pub sha256_prefix: String,
    /// 服务版本（安装侧写入 HKLM 的 CARGO_PKG_VERSION）
    pub version: String,
}

/// status() 裁决：ok 带附加数据；非 ok 直传错误码（管道可达但被拒——
/// 失配 PathMismatch/HashMismatch、未绑定 VerifyError、其他）
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StatusReply {
    Ok(StatusInfo),
    Rejected(ErrCode),
}

/// unwrap_dek() 错误分型（Task 7 锁屏静默解锁链消费：Unavailable/CallerRejected
/// 均为「无声回退 dpapi」信号；NoWrappedDek=已安装未启用）
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UnwrapError {
    Unavailable,
    CallerRejected,
    NoWrappedDek,
    Other(String),
}

impl fmt::Display for UnwrapError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            // Unavailable/CallerRejected 是锁屏回退主路径（预期），文案仅 warn 留痕用
            Self::Unavailable => write!(f, "ABE 服务不可达（未安装或未运行）"),
            Self::CallerRejected => write!(f, "ABE 服务拒绝当前调用者"),
            Self::NoWrappedDek => write!(f, "ABE 服务无已绑定密文"),
            Self::Other(m) => write!(f, "{m}"),
        }
    }
}

impl std::error::Error for UnwrapError {}

/// 请求→响应往返可测核心：writer 全量发出请求帧；reader 按流语义读响应（填 buf 返回
/// 实际字节数，0=EOF）。契约：① 头 4B 解 declared，超 MAX_FRAME_LEN 即拒（不分配/不读体）；
/// ② Resp 帧体恒以 u16 LE errcode 开头，附加数据随后
pub(crate) fn transact<W, R>(
    mut write: W,
    mut read: R,
    msg: MsgType,
    payload: &[u8],
) -> Result<(ErrCode, Vec<u8>), ClientError>
where
    W: FnMut(&[u8]) -> std::io::Result<()>,
    R: FnMut(&mut [u8]) -> std::io::Result<usize>,
{
    let mut frame = encode_frame(msg, payload);
    let write_result = write(&frame).map_err(|e| ClientError::Io(format!("请求帧写入失败: {e}")));
    // 请求帧可能携带明文 DEK（Wrap 载荷）：写完即清，成功失败路径同清（Global Constraints，
    // 与响应侧 Unwrap 附加数据 zeroize 纪律对称）
    frame.zeroize();
    write_result?;

    // ① 头 4B：u32 LE 声明长度（= 除长度前缀外的帧体字节数）
    let mut header = [0u8; 4];
    read_exact_via(&mut read, &mut header)
        .map_err(|e| ClientError::Io(format!("响应头读取失败: {e}")))?;
    let declared = u32::from_le_bytes(header) as usize;
    // 上游契约①：只做比较判定，超限即拒——不按声明值分配/读取（无界分配/读洞）
    if declared > MAX_FRAME_LEN {
        return Err(ClientError::Protocol(format!(
            "响应声明长度 {declared} 超上限 {MAX_FRAME_LEN}"
        )));
    }
    if declared == 0 {
        return Err(ClientError::Protocol("响应空帧（无 msg_type 字节）".into()));
    }
    let mut body = vec![0u8; declared];
    if let Err(e) = read_exact_via(&mut read, &mut body) {
        // 半途断流的响应体可能已含 DEK 明文片段：错误路径同样清零（Global Constraints）
        body.zeroize();
        return Err(ClientError::Io(format!("响应体读取失败: {e}")));
    }

    // 复原整帧交 decode_frame 终审（形状/未知 msg_type）；body 副本即清
    let mut frame_buf = Vec::with_capacity(4 + declared);
    frame_buf.extend_from_slice(&header);
    frame_buf.extend_from_slice(&body);
    body.zeroize();
    let (resp_msg, resp_payload) = match decode_frame(&frame_buf) {
        Ok(x) => x,
        Err(e) => {
            frame_buf.zeroize();
            return Err(ClientError::Protocol(format!("响应帧解码失败: {e:?}")));
        }
    };
    if resp_msg != MsgType::Resp {
        frame_buf.zeroize();
        return Err(ClientError::Protocol(format!(
            "响应 msg_type 非 Resp: {:?}",
            resp_msg
        )));
    }
    // 上游契约②：Resp 帧体恒以 u16 LE errcode 开头
    if resp_payload.len() < 2 {
        frame_buf.zeroize();
        return Err(ClientError::Protocol("Resp 帧缺 u16 errcode 前缀".into()));
    }
    let raw = u16::from_le_bytes([resp_payload[0], resp_payload[1]]);
    let Some(code) = ErrCode::from_u16(raw) else {
        frame_buf.zeroize();
        return Err(ClientError::Protocol(format!("未知错误码 {raw}")));
    };
    // Unwrap 附加数据（明文 DEK）复制给调用方后，整帧中间缓冲即清（Global Constraints：
    // 「以 Vec<u8> 返回 invoke 层后立即 zeroize 中间缓冲」——frame_buf 即该缓冲）
    let extra = resp_payload[2..].to_vec();
    frame_buf.zeroize();
    Ok((code, extra))
}

/// 闭包流精确读：循环读满 buf；0 字节 = EOF（UnexpectedEof）
fn read_exact_via<R>(read: &mut R, buf: &mut [u8]) -> std::io::Result<()>
where
    R: FnMut(&mut [u8]) -> std::io::Result<usize>,
{
    let mut filled = 0usize;
    while filled < buf.len() {
        let n = read(&mut buf[filled..])?;
        if n == 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "管道在对端响应中途关闭",
            ));
        }
        filled += n;
    }
    Ok(())
}

/// status() 的可测核心：errcode+附加数据 → StatusReply（ok 解析 JSON，字段缺失回空串——
/// 前端仅展示用途，不据空值做逻辑分支）
fn status_reply_from(code: ErrCode, extra: Vec<u8>) -> Result<StatusReply, ClientError> {
    if code != ErrCode::Ok {
        return Ok(StatusReply::Rejected(code));
    }
    let text = String::from_utf8(extra)
        .map_err(|_| ClientError::Protocol("Status 响应非 UTF-8".into()))?;
    let v: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e| ClientError::Protocol(format!("Status JSON 解析失败: {e}")))?;
    let field = |name: &str| {
        v.get(name)
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string()
    };
    Ok(StatusReply::Ok(StatusInfo {
        bound_path: field("bound_path"),
        sha256_prefix: field("sha256_prefix"),
        version: field("version"),
    }))
}

/// unwrap_dek() 的可测核心：errcode+附加数据 → 32B DEK 或分型错误；
/// extra 可能携带明文 DEK，取值或失败路径均 zeroize（Global Constraints）
fn unwrap_dek_from(code: ErrCode, mut extra: Vec<u8>) -> Result<[u8; 32], UnwrapError> {
    let dek = if code == ErrCode::Ok && extra.len() == 32 {
        let mut d = [0u8; 32];
        d.copy_from_slice(&extra);
        Some(d)
    } else {
        None
    };
    extra.zeroize();
    match (code, dek) {
        (ErrCode::Ok, Some(d)) => Ok(d),
        (ErrCode::NoWrappedDek, _) => Err(UnwrapError::NoWrappedDek),
        (ErrCode::PathMismatch | ErrCode::HashMismatch | ErrCode::VerifyError, _) => {
            Err(UnwrapError::CallerRejected)
        }
        (ErrCode::Ok, None) => Err(UnwrapError::Other(
            "Unwrap ok 响应附加数据非 32B DEK".into(),
        )),
        (other, _) => Err(UnwrapError::Other(format!("服务侧拒绝 Unwrap: {other:?}"))),
    }
}

/// remove_binding() 的服务侧裁决（可测核心）：非 ok 分型为可读错误信息
fn remove_verdict(code: ErrCode) -> Result<(), String> {
    match code {
        ErrCode::Ok => Ok(()),
        ErrCode::PathMismatch | ErrCode::HashMismatch | ErrCode::VerifyError => {
            Err("本进程未通过服务验证（应用已更新或未绑定），删除被拒".into())
        }
        other => Err(format!("服务侧 Remove 失败: {other:?}")),
    }
}

// ---------- 真管道薄壳（单测不覆盖：内存流 mock 已覆盖帧逻辑） ----------

/// 打开服务管道并完成一次 请求→Resp 往返（call_service 唯一入口，高层操作共用）。
/// 读超时选型见 IO_TIMEOUT 注释；DEK 附加数据的 zeroize 责任在 unwrap_dek（本层
/// 不识别消息类型，Ok 之外的失败路径服务端本就不回 DEK）
pub fn call_service(msg: MsgType, payload: &[u8]) -> Result<(ErrCode, Vec<u8>), ClientError> {
    let pipe = open_pipe()?;
    let deadline = Instant::now() + IO_TIMEOUT;
    transact(
        |buf| write_all_via_pipe(pipe.0, buf),
        |buf| read_with_deadline(pipe.0, buf, deadline),
        msg,
        payload,
    )
}

/// 管道句柄 RAII（CloseHandle 于 Drop；关闭失败静默——无可补救动作）
struct PipeHandle(HANDLE);

impl Drop for PipeHandle {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

/// CreateFileW 同步模式打开服务管道（服务端 DACL 允许 Authenticated Users 读写）。
/// 错误分类：FILE_NOT_FOUND/PATH_NOT_FOUND → Unavailable（未安装/未运行）；
/// ERROR_PIPE_BUSY → WaitNamedPipeW 短重试（I3 终审，见 PIPE_BUSY_RETRIES 注释），
/// 重试耗尽仍忙 → OpenFailed；其余 → OpenFailed（管道在即证明已安装）
fn open_pipe() -> Result<PipeHandle, ClientError> {
    let wide = to_wide(PIPE_NAME);
    let mut busy_waits = 0u32;
    loop {
        let opened = unsafe {
            CreateFileW(
                PCWSTR(wide.as_ptr()),
                (GENERIC_READ | GENERIC_WRITE).0,
                FILE_SHARE_NONE,
                None,
                OPEN_EXISTING,
                FILE_ATTRIBUTE_NORMAL,
                None,
            )
        };
        match opened {
            Ok(handle) => return Ok(PipeHandle(handle)),
            Err(e) if e.code() == ERROR_PIPE_BUSY.into() => {
                if busy_waits >= PIPE_BUSY_RETRIES {
                    return Err(ClientError::OpenFailed(format!(
                        "CreateFileW: {e}（实例全忙，重试 {busy_waits} 次后放弃）"
                    )));
                }
                busy_waits += 1;
                // 等待服务端下一管道实例可用；失败（超时/句柄态变化）不细化——
                // 下轮 CreateFileW 重探即为权威判定
                unsafe {
                    let _ = WaitNamedPipeW(PCWSTR(wide.as_ptr()), PIPE_BUSY_WAIT_MS);
                }
            }
            Err(e) => {
                let code = e.code();
                if code == ERROR_FILE_NOT_FOUND.into() || code == ERROR_PATH_NOT_FOUND.into() {
                    return Err(ClientError::Unavailable(format!("服务管道不存在: {e}")));
                }
                return Err(ClientError::OpenFailed(format!("CreateFileW: {e}")));
            }
        }
    }
}

/// 轮询读：PeekNamedPipe 查可用字节 → 有则 ReadFile 一次；到 deadline 仍无 → 超时。
/// 对端断连（ERROR_BROKEN_PIPE）映射 EOF（0 字节）交上层精确读判 UnexpectedEof
fn read_with_deadline(pipe: HANDLE, buf: &mut [u8], deadline: Instant) -> std::io::Result<usize> {
    loop {
        let mut available = 0u32;
        if let Err(e) = unsafe { PeekNamedPipe(pipe, None, 0, None, Some(&mut available), None) } {
            return Err(std::io::Error::other(format!("PeekNamedPipe: {e}")));
        }
        if available > 0 {
            let mut n = 0u32;
            match unsafe { ReadFile(pipe, Some(buf), Some(&mut n), None) } {
                Ok(()) => return Ok(n as usize),
                Err(e) if e.code() == ERROR_BROKEN_PIPE.into() => return Ok(0),
                Err(e) => return Err(std::io::Error::other(format!("ReadFile: {e}"))),
            }
        }
        if Instant::now() >= deadline {
            return Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                format!("服务响应超时（{:?}）", IO_TIMEOUT),
            ));
        }
        std::thread::sleep(PEEK_POLL_INTERVAL);
    }
}

/// 字节模式管道精确写
fn write_all_via_pipe(pipe: HANDLE, buf: &[u8]) -> std::io::Result<()> {
    let mut written = 0usize;
    while written < buf.len() {
        let mut n = 0u32;
        if unsafe { WriteFile(pipe, Some(&buf[written..]), Some(&mut n), None) }.is_err() || n == 0
        {
            return Err(std::io::Error::other("WriteFile 失败或零写入"));
        }
        written += n as usize;
    }
    Ok(())
}

/// UTF-16 NUL 结尾（PCWSTR 入参；elevation_service 同款形态）
fn to_wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

// ---------- 高层操作（abe_status/abe_bind/abe_remove 与 Task 7 锁屏通道消费） ----------

/// Status 查询（abe_status 的数据源）
pub fn status() -> Result<StatusReply, ClientError> {
    let (code, extra) = call_service(MsgType::Status, &[])?;
    status_reply_from(code, extra)
}

/// 服务端 Unwrap 代理：明文 DEK 32B。中间缓冲用后即清（Global Constraints）。
/// 消费方：elevation_commands::abe_unwrap（T7 锁屏静默解锁）
pub fn unwrap_dek() -> Result<[u8; 32], UnwrapError> {
    let (code, extra) = call_service(MsgType::Unwrap, &[]).map_err(|e| match e {
        ClientError::Unavailable(_) => UnwrapError::Unavailable,
        other => UnwrapError::Other(other.to_string()),
    })?;
    unwrap_dek_from(code, extra)
}

/// 服务端 Wrap 代理：32B DEK → SYSTEM 上下文 DPAPI → HKLM WrappedDek（C1 终审修复：
/// 绑定编排 bind→wrap→addSource 的 wrap 步——无此步 HKLM 永无密文，锁屏 abe.unwrap
/// 恒 NoWrappedDek 无声回退，ABE 通道端到端断裂）。管道契约同 unwrap：declared 先验
/// MAX_FRAME_LEN、Resp u16 errcode 前缀（transact 单点实现）；DEK 缓冲 zeroize 纪律同现有
/// （请求帧于 transact 写后即清，调用方缓冲所有权不变）。服务侧裁决分两层外传
/// （remove_binding 同形）：管道层错误外层，服务裁决内层（Err(msg)=被拒/内部错误）
pub fn wrap_dek(dek: &[u8; 32]) -> Result<Result<(), String>, ClientError> {
    let (code, _) = call_service(MsgType::Wrap, dek)?;
    Ok(wrap_verdict(code))
}

/// wrap_dek() 的服务侧裁决（可测核心，同 remove_verdict 手法）：ok=HKLM 已写入；
/// 失配/未绑定=调用者未过验证（绑定流程前置已保证匹配，出现即环境异常）；
/// BadRequest=服务判载荷非 32B（客户端已保证，服务侧违约）；Internal=DPAPI/存储失败
fn wrap_verdict(code: ErrCode) -> Result<(), String> {
    match code {
        ErrCode::Ok => Ok(()),
        ErrCode::PathMismatch | ErrCode::HashMismatch | ErrCode::VerifyError => {
            Err("本进程未通过服务验证（应用已更新或未绑定），包裹被拒".into())
        }
        ErrCode::BadRequest => Err("服务侧判定 Wrap 载荷非 32B DEK".into()),
        other => Err(format!("服务侧 Wrap 失败: {other:?}")),
    }
}

/// Remove：管道层错误外传；服务侧裁决内层（Err(msg)=被拒/内部错误，折叠进
/// abe_remove 的 {ok:false,message}，不抛 invoke 错）
pub fn remove_binding() -> Result<Result<(), String>, ClientError> {
    let (code, _) = call_service(MsgType::Remove, &[])?;
    Ok(remove_verdict(code))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    /// 内存流 mock（brief Step 1：半帧/分片/超长 len 拒绝的帧读写单测）：chunks 逐次吐出
    /// （每次 read 从队首片取 min(片长, buf) 字节，余量截断续留）；read_calls 记录读调用
    /// 次数（超长声明拒绝须验证「未尝试读体」）；written 收集写出字节；fail_write 模拟写失败
    struct MockIo {
        chunks: Vec<Vec<u8>>,
        read_calls: usize,
        written: Vec<u8>,
        fail_write: bool,
    }

    impl MockIo {
        fn chunks(chunks: Vec<Vec<u8>>) -> RefCell<Self> {
            RefCell::new(Self {
                chunks,
                read_calls: 0,
                written: Vec::new(),
                fail_write: false,
            })
        }

        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            self.read_calls += 1;
            let n = {
                let Some(first) = self.chunks.first_mut() else {
                    return Ok(0); // 流尽 = EOF
                };
                let n = first.len().min(buf.len());
                buf[..n].copy_from_slice(&first[..n]);
                first.drain(..n);
                n
            };
            if self.chunks.first().is_some_and(Vec::is_empty) {
                self.chunks.remove(0);
            }
            Ok(n)
        }

        fn write(&mut self, buf: &[u8]) -> std::io::Result<()> {
            if self.fail_write {
                return Err(std::io::Error::other("mock write failure"));
            }
            self.written.extend_from_slice(buf);
            Ok(())
        }
    }

    /// 经内存流跑一次 transact
    fn transact_mock(
        io: &RefCell<MockIo>,
        msg: MsgType,
        payload: &[u8],
    ) -> Result<(ErrCode, Vec<u8>), ClientError> {
        transact(
            |buf| io.borrow_mut().write(buf),
            |buf| io.borrow_mut().read(buf),
            msg,
            payload,
        )
    }

    /// 构造 Resp 帧字节（u16 LE errcode 前缀 + 附加数据，与服务端 resp_frame 形态一致）
    fn resp_frame_bytes(code: ErrCode, extra: &[u8]) -> Vec<u8> {
        let mut p = code.to_u16().to_le_bytes().to_vec();
        p.extend_from_slice(extra);
        encode_frame(MsgType::Resp, &p)
    }

    // ---- happy path：单分片完整 Resp（ok + 32B DEK 附加数据）----

    #[test]
    fn resp_ok_with_dek_extra_single_chunk() {
        let io = MockIo::chunks(vec![resp_frame_bytes(ErrCode::Ok, &[7u8; 32])]);
        let out = transact_mock(&io, MsgType::Unwrap, &[]).unwrap();
        assert_eq!(out.0, ErrCode::Ok);
        assert_eq!(out.1, vec![7u8; 32]);
        // 请求帧按 proto 单点编码：Unwrap 无载荷 = 4B 前缀 + 1B msg_type
        assert_eq!(io.borrow().written, encode_frame(MsgType::Unwrap, &[]));
    }

    // ---- 半帧/分片到达（字节模式流语义）----

    #[test]
    fn resp_fragmented_byte_by_byte_still_ok() {
        let frame = resp_frame_bytes(ErrCode::Ok, &[9u8; 32]);
        let io = MockIo::chunks(frame.iter().map(|b| vec![*b]).collect());
        let out = transact_mock(&io, MsgType::Unwrap, &[]).unwrap();
        assert_eq!(out, (ErrCode::Ok, vec![9u8; 32]));
    }

    #[test]
    fn resp_half_frame_arrival_header_then_body() {
        let frame = resp_frame_bytes(ErrCode::Ok, b"{}");
        let io = MockIo::chunks(vec![frame[..4].to_vec(), frame[4..].to_vec()]);
        let out = transact_mock(&io, MsgType::Status, &[]).unwrap();
        assert_eq!(out, (ErrCode::Ok, b"{}".to_vec()));
    }

    #[test]
    fn resp_truncated_mid_body_maps_io() {
        let mut frame = resp_frame_bytes(ErrCode::Ok, &[1u8; 16]);
        frame.truncate(frame.len() - 3); // 响应中途断流
        let io = MockIo::chunks(vec![frame]);
        assert!(matches!(
            transact_mock(&io, MsgType::Unwrap, &[]),
            Err(ClientError::Io(_))
        ));
    }

    // ---- 上游契约①：先验 declared ≤ MAX_FRAME_LEN 再分配/读取 ----

    #[test]
    fn oversized_declared_len_rejected_without_body_read() {
        let mut head = Vec::new();
        head.extend_from_slice(&((MAX_FRAME_LEN + 1) as u32).to_le_bytes());
        head.push(MsgType::Resp as u8); // 若按声明读体这就是越界读
        let io = MockIo::chunks(vec![head]);
        let err = transact_mock(&io, MsgType::Status, &[]).unwrap_err();
        assert!(
            matches!(err, ClientError::Protocol(ref m) if m.contains("超上限")),
            "实际: {err:?}"
        );
        // 关键断言：仅读过 4B 头一次，未按声明值发起体读取（无界读洞）
        assert_eq!(io.borrow().read_calls, 1);
    }

    #[test]
    fn zero_declared_len_rejected() {
        let io = MockIo::chunks(vec![0u32.to_le_bytes().to_vec()]);
        assert!(matches!(
            transact_mock(&io, MsgType::Status, &[]),
            Err(ClientError::Protocol(_))
        ));
    }

    // ---- 上游契约②：Resp 帧 u16 LE errcode 前缀 ----

    #[test]
    fn non_resp_msg_type_rejected() {
        let io = MockIo::chunks(vec![encode_frame(MsgType::Wrap, &[0u8; 2])]);
        assert!(matches!(
            transact_mock(&io, MsgType::Status, &[]),
            Err(ClientError::Protocol(_))
        ));
    }

    #[test]
    fn unknown_errcode_rejected() {
        // 合法帧打补丁：帧体首 u16 LE（偏移 5/6）改为越界错误码 99
        let mut frame = resp_frame_bytes(ErrCode::Internal, &[]);
        frame[5] = 99;
        let io = MockIo::chunks(vec![frame]);
        assert!(matches!(
            transact_mock(&io, MsgType::Status, &[]),
            Err(ClientError::Protocol(_))
        ));
    }

    #[test]
    fn errcode_prefix_missing_rejected() {
        // Resp 帧体仅 1B（连 u16 errcode 都不完整）
        let io = MockIo::chunks(vec![encode_frame(MsgType::Resp, &[0x00])]);
        assert!(matches!(
            transact_mock(&io, MsgType::Status, &[]),
            Err(ClientError::Protocol(_))
        ));
    }

    #[test]
    fn ok_errcode_with_empty_extra_is_valid() {
        let io = MockIo::chunks(vec![resp_frame_bytes(ErrCode::Ok, &[])]);
        let out = transact_mock(&io, MsgType::Remove, &[]).unwrap();
        assert_eq!(out, (ErrCode::Ok, Vec::new()));
    }

    // ---- 写失败 ----

    #[test]
    fn write_failure_maps_io() {
        let io = MockIo::chunks(vec![resp_frame_bytes(ErrCode::Ok, &[])]);
        io.borrow_mut().fail_write = true;
        assert!(matches!(
            transact_mock(&io, MsgType::Wrap, &[0u8; 32]),
            Err(ClientError::Io(_))
        ));
        assert!(io.borrow().written.is_empty());
    }

    // ---- status_reply_from：ok 解析 JSON / 非 ok 直传 / 坏 JSON 拒绝 ----

    #[test]
    fn status_reply_parses_json_fields() {
        // 夹具与服务端 status_json 实际输出对齐（matches_caller 已删，YAGNI）
        let json = serde_json::json!({
            "bound_path": r"C:\App\TotpTools.exe",
            "sha256_prefix": "abcd1234",
            "version": "1.2.3",
        });
        let reply = status_reply_from(ErrCode::Ok, json.to_string().into_bytes()).unwrap();
        assert_eq!(
            reply,
            StatusReply::Ok(StatusInfo {
                bound_path: r"C:\App\TotpTools.exe".into(),
                sha256_prefix: "abcd1234".into(),
                version: "1.2.3".into(),
            })
        );
    }

    #[test]
    fn status_reply_rejected_passthrough_without_json_parse() {
        // 非 ok：附加数据为空亦成立（失配者拿不到 Status JSON，Task 2 审查裁定）
        let reply = status_reply_from(ErrCode::PathMismatch, Vec::new()).unwrap();
        assert_eq!(reply, StatusReply::Rejected(ErrCode::PathMismatch));
        // 非 ok 时即便附加数据是垃圾字节也不解析
        let reply = status_reply_from(ErrCode::HashMismatch, vec![0xFF, 0xEE]).unwrap();
        assert_eq!(reply, StatusReply::Rejected(ErrCode::HashMismatch));
    }

    #[test]
    fn status_reply_bad_json_maps_protocol() {
        assert!(matches!(
            status_reply_from(ErrCode::Ok, b"not json".to_vec()),
            Err(ClientError::Protocol(_))
        ));
        // ok 但缺字段：回空串兜底（仅展示用途）
        let reply = status_reply_from(ErrCode::Ok, b"{}".to_vec()).unwrap();
        assert_eq!(
            reply,
            StatusReply::Ok(StatusInfo {
                bound_path: String::new(),
                sha256_prefix: String::new(),
                version: String::new(),
            })
        );
    }

    // ---- unwrap_dek_from：32B 校验与错误分型 ----

    #[test]
    fn unwrap_dek_ok_32b() {
        let dek = unwrap_dek_from(ErrCode::Ok, vec![3u8; 32]).unwrap();
        assert_eq!(dek, [3u8; 32]);
    }

    #[test]
    fn unwrap_dek_rejections_mapped() {
        assert_eq!(
            unwrap_dek_from(ErrCode::NoWrappedDek, Vec::new()),
            Err(UnwrapError::NoWrappedDek)
        );
        for code in [
            ErrCode::PathMismatch,
            ErrCode::HashMismatch,
            ErrCode::VerifyError,
        ] {
            assert_eq!(
                unwrap_dek_from(code, Vec::new()),
                Err(UnwrapError::CallerRejected),
                "{code:?}"
            );
        }
        // ok 但明文非 32B：Other（不静默截断）
        assert!(matches!(
            unwrap_dek_from(ErrCode::Ok, vec![1u8; 31]),
            Err(UnwrapError::Other(_))
        ));
        // 服务侧内部错误：Other
        assert!(matches!(
            unwrap_dek_from(ErrCode::Internal, Vec::new()),
            Err(UnwrapError::Other(_))
        ));
    }

    // ---- remove_verdict：幂等 ok 与拒绝分型 ----

    #[test]
    fn remove_verdict_mapping() {
        assert_eq!(remove_verdict(ErrCode::Ok), Ok(()));
        // 失配/未绑定：可读错误（调用方折入 {ok:false,message}）
        let err = remove_verdict(ErrCode::PathMismatch).unwrap_err();
        assert!(err.contains("验证"));
        assert!(remove_verdict(ErrCode::Internal).is_err());
    }

    // ---- wrap_verdict：ok 与拒绝/违约/内部错误分型（C1 终审）----

    #[test]
    fn wrap_verdict_mapping() {
        assert_eq!(wrap_verdict(ErrCode::Ok), Ok(()));
        // 调用者未过验证：可读错误
        for code in [
            ErrCode::PathMismatch,
            ErrCode::HashMismatch,
            ErrCode::VerifyError,
        ] {
            let err = wrap_verdict(code).unwrap_err();
            assert!(err.contains("验证"), "{code:?}");
        }
        // 服务判载荷非 32B（客户端已保证，违约路径单列）
        let err = wrap_verdict(ErrCode::BadRequest).unwrap_err();
        assert!(err.contains("32B"));
        // DPAPI/存储内部错误
        assert!(wrap_verdict(ErrCode::Internal).is_err());
        // NoWrappedDek 等 Wrap 语义外错误码：兜底服务侧失败
        assert!(wrap_verdict(ErrCode::NoWrappedDek).is_err());
    }

    // ---- transact 请求帧 zeroize（Wrap 载荷纪律；MockIo.written 为 write 期拷贝，
    //      断言帧字节不受写后清零影响）----

    #[test]
    fn request_frame_zeroized_after_write() {
        let io = MockIo::chunks(vec![resp_frame_bytes(ErrCode::Ok, &[])]);
        let out = transact_mock(&io, MsgType::Wrap, &[0x5Au8; 32]).unwrap();
        assert_eq!(out.0, ErrCode::Ok);
        // 写出字节完整（DEK 明文已送达对端），且请求帧确为 Wrap+32B 载荷形态
        assert_eq!(
            io.borrow().written,
            encode_frame(MsgType::Wrap, &[0x5Au8; 32])
        );
    }
}
