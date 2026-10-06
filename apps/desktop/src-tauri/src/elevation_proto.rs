//! ABE 提权服务帧协议（plan p6 §0.1）：管道名/DEK marker/消息类型/错误码与帧编解码纯函数，
//! 单点定义供服务端（elevation_service）与客户端（elevation_client）共用——服务/客户端/前端
//! 可见字符串不得在他处重复定义（Global Constraints）。
//!
//! 帧格式：`u32 LE len ‖ u8 msg_type ‖ payload`，其中 len = 1 + payload.len()（即除长度前缀
//! 外的帧体字节数）。字节型管道（PIPE_TYPE_BYTE）按流读取：调用方先读满 4B 前缀、再按声明
//! 长度读满帧体后交 [`decode_frame`]；本模块不做 IO，仅纯编解码（可测核心手法，同 release_policy）。

/// 命名管道路径：服务端 `CreateNamedPipeW` 与客户端 `CreateFileW` 共用
pub const PIPE_NAME: &str = r"\\.\pipe\totp-elevation-v1";

/// DEK 包裹 marker：base64 包裹形态前缀（包裹形态同现有 TOTPDEK1 模式，plan p6 §0.1）
pub const DEK_MARKER: &str = "TOTPABEK1";

/// 帧长度上限：与 §0.1 管道缓冲 64KiB 对齐。当前最大载荷为 Wrap 的 32B DEK 与小体积 JSON
/// 响应，上限仅用于在解码层拒绝恶意超长声明（防按声明值无界分配/读取）。
pub const MAX_FRAME_LEN: usize = 64 * 1024;

/// 请求/响应消息类型（帧体首字节）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MsgType {
    /// 包裹 DEK（payload = 32B DEK 明文）
    Wrap = 1,
    /// 解出 DEK（payload 空）
    Unwrap = 2,
    /// 查询绑定状态（payload 空）
    Status = 3,
    /// 删除 HKLM WrappedDek（payload 空）
    Remove = 4,
    /// 响应（payload = u16 LE 错误码 ‖ 附加数据）
    Resp = 5,
}

impl MsgType {
    /// 线格式 → 枚举；未知值返回 None（解码层拒绝，防前向不兼容静默错读）
    pub fn from_u8(v: u8) -> Option<Self> {
        match v {
            1 => Some(Self::Wrap),
            2 => Some(Self::Unwrap),
            3 => Some(Self::Status),
            4 => Some(Self::Remove),
            5 => Some(Self::Resp),
            _ => None,
        }
    }
}

/// 协议层错误码（plan p6 §0.1，u16 线格式，经 Resp payload 承载）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrCode {
    Ok = 0,
    PathMismatch = 1,
    HashMismatch = 2,
    VerifyError = 3,
    NoWrappedDek = 4,
    BadRequest = 5,
    Internal = 6,
}

impl ErrCode {
    /// 线格式 → 枚举；未知值返回 None（客户端拒绝静默错读，展示 Internal 兜底由调用方决定）
    pub fn from_u16(v: u16) -> Option<Self> {
        match v {
            0 => Some(Self::Ok),
            1 => Some(Self::PathMismatch),
            2 => Some(Self::HashMismatch),
            3 => Some(Self::VerifyError),
            4 => Some(Self::NoWrappedDek),
            5 => Some(Self::BadRequest),
            6 => Some(Self::Internal),
            _ => None,
        }
    }

    /// 枚举 → 线格式
    pub fn to_u16(self) -> u16 {
        self as u16
    }
}

/// 帧解码错误（纯结构校验，不含 IO 语义）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProtoError {
    /// 不足 4B，连长度前缀都不完整
    HeaderTruncated,
    /// 声明长度超上限（拒绝恶意超长声明）
    TooLarge {
        /// 声明的帧体长度
        declared: usize,
    },
    /// 声明长度超出实际缓冲（流截断）
    Truncated {
        /// 声明的帧体长度
        declared: usize,
        /// 实际可用的帧体字节数
        actual: usize,
    },
    /// 声明长度为 0（帧体连 msg_type 字节都没有）
    EmptyFrame,
    /// 未知 msg_type（防前向不兼容静默错读）
    UnknownMsgType(u8),
}

/// 编码一帧：`u32 LE len ‖ u8 msg_type ‖ payload`（len = 1 + payload.len()）。
/// 载荷超 [`MAX_FRAME_LEN`] 时 panic——载荷均为本应用自产的固定形态（32B DEK/小 JSON），
/// 超限属编程错误，fail-fast 优于静默截断。
pub fn encode_frame(msg: MsgType, payload: &[u8]) -> Vec<u8> {
    let len = 1 + payload.len();
    assert!(
        len <= MAX_FRAME_LEN,
        "frame too large: {len} > {MAX_FRAME_LEN}"
    );
    let mut out = Vec::with_capacity(4 + len);
    out.extend_from_slice(&(len as u32).to_le_bytes());
    out.push(msg as u8);
    out.extend_from_slice(payload);
    out
}

/// 解码一帧：返回 `(msg_type, payload)`，payload 为输入缓冲内切片（零拷贝）。
/// 缓冲可含后续帧字节（粘包）：仅解析首帧，调用方按 `4 + payload.len()` 推进。
pub fn decode_frame(buf: &[u8]) -> Result<(MsgType, &[u8]), ProtoError> {
    if buf.len() < 4 {
        return Err(ProtoError::HeaderTruncated);
    }
    // 恶意声明值只用于比较判定，不据此分配/读取
    let declared = u32::from_le_bytes([buf[0], buf[1], buf[2], buf[3]]) as usize;
    if declared > MAX_FRAME_LEN {
        return Err(ProtoError::TooLarge { declared });
    }
    if declared == 0 {
        return Err(ProtoError::EmptyFrame);
    }
    let Some(body) = buf.get(4..4 + declared) else {
        return Err(ProtoError::Truncated {
            declared,
            actual: buf.len() - 4,
        });
    };
    let Some(msg) = MsgType::from_u8(body[0]) else {
        return Err(ProtoError::UnknownMsgType(body[0]));
    };
    Ok((msg, &body[1..]))
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- 常量（协议单点定义；Task 2/4 消费方与前端可见字符串以此为准）----

    #[test]
    fn protocol_constants_single_source() {
        assert_eq!(PIPE_NAME, r"\\.\pipe\totp-elevation-v1");
        assert_eq!(DEK_MARKER, "TOTPABEK1");
    }

    // ---- 编解码往返 ----

    #[test]
    fn roundtrip_all_msg_types_with_payloads() {
        let payloads: [&[u8]; 3] = [&[], b"abc", &[0x42; 32]];
        for msg in [
            MsgType::Wrap,
            MsgType::Unwrap,
            MsgType::Status,
            MsgType::Remove,
            MsgType::Resp,
        ] {
            for payload in payloads {
                let frame = encode_frame(msg, payload);
                let (decoded, decoded_payload) = decode_frame(&frame).unwrap();
                assert_eq!(decoded, msg);
                assert_eq!(decoded_payload, payload);
            }
        }
    }

    #[test]
    fn resp_payload_u16_err_code_roundtrip() {
        for code in [
            ErrCode::Ok,
            ErrCode::PathMismatch,
            ErrCode::HashMismatch,
            ErrCode::VerifyError,
            ErrCode::NoWrappedDek,
            ErrCode::BadRequest,
            ErrCode::Internal,
        ] {
            let payload = code.to_u16().to_le_bytes();
            let frame = encode_frame(MsgType::Resp, &payload);
            let (decoded, decoded_payload) = decode_frame(&frame).unwrap();
            assert_eq!(decoded, MsgType::Resp);
            assert_eq!(decoded_payload, payload);
            assert_eq!(
                ErrCode::from_u16(u16::from_le_bytes(decoded_payload.try_into().unwrap())),
                Some(code)
            );
        }
    }

    // ---- len 前缀正确性 ----

    #[test]
    fn length_prefix_counts_body_not_itself() {
        let payload = [0xAA_u8; 32];
        let frame = encode_frame(MsgType::Wrap, &payload);
        // len = 1(msg) + 32(payload) = 33，u32 LE
        assert_eq!(&frame[0..4], &33_u32.to_le_bytes());
        assert_eq!(frame[4], MsgType::Wrap as u8);
        assert_eq!(&frame[5..], &payload[..]);
        assert_eq!(frame.len(), 4 + 33);
    }

    #[test]
    fn empty_payload_frame_is_5_bytes() {
        let frame = encode_frame(MsgType::Status, &[]);
        assert_eq!(frame.len(), 5);
        assert_eq!(&frame[0..4], &1_u32.to_le_bytes());
    }

    // ---- 截断 ----

    #[test]
    fn truncated_header_rejected() {
        assert_eq!(decode_frame(&[]), Err(ProtoError::HeaderTruncated));
        assert_eq!(decode_frame(&[1, 2, 3]), Err(ProtoError::HeaderTruncated));
    }

    #[test]
    fn truncated_body_rejected() {
        let mut frame = encode_frame(MsgType::Wrap, &[0x11_u8; 8]);
        frame.truncate(frame.len() - 3); // 掐掉 payload 末尾 3B
        assert_eq!(
            decode_frame(&frame),
            Err(ProtoError::Truncated {
                declared: 9,
                actual: 6
            })
        );
    }

    // ---- 超长 ----

    #[test]
    fn oversized_declared_len_rejected() {
        // u32::MAX 声明：解码层拒绝，不按声明值分配/读取
        let mut buf = Vec::new();
        buf.extend_from_slice(&u32::MAX.to_le_bytes());
        buf.push(MsgType::Wrap as u8);
        assert_eq!(
            decode_frame(&buf),
            Err(ProtoError::TooLarge {
                declared: u32::MAX as usize
            })
        );
        // 恰超上限 1B 同拒
        let mut buf = Vec::new();
        buf.extend_from_slice(&((MAX_FRAME_LEN + 1) as u32).to_le_bytes());
        assert_eq!(
            decode_frame(&buf),
            Err(ProtoError::TooLarge {
                declared: MAX_FRAME_LEN + 1
            })
        );
    }

    #[test]
    fn empty_frame_rejected() {
        let buf = 0_u32.to_le_bytes();
        assert_eq!(decode_frame(&buf), Err(ProtoError::EmptyFrame));
    }

    // ---- 未知 msg_type ----

    #[test]
    fn unknown_msg_type_rejected() {
        for bad in [0_u8, 6, 0xA7] {
            let mut frame = encode_frame(MsgType::Resp, &[]);
            frame[4] = bad; // 打补丁为未知/越界类型
            assert_eq!(decode_frame(&frame), Err(ProtoError::UnknownMsgType(bad)));
        }
    }

    // ---- 粘包（流式缓冲可含后续帧）：仅解析首帧，调用方按 4 + payload.len() 推进 ----

    #[test]
    fn glued_frames_decode_first_and_advance() {
        let f1 = encode_frame(MsgType::Status, &[]);
        let f2 = encode_frame(MsgType::Wrap, &[0x5A; 4]);
        let mut buf = f1.clone();
        buf.extend_from_slice(&f2);
        let (msg, payload) = decode_frame(&buf).unwrap();
        assert_eq!(msg, MsgType::Status);
        assert!(payload.is_empty());
        // 推进后可解第二帧
        let (msg, payload) = decode_frame(&buf[5..]).unwrap();
        assert_eq!(msg, MsgType::Wrap);
        assert_eq!(payload, &[0x5A; 4]);
    }

    // ---- 枚举线格式映射 ----

    #[test]
    fn msg_type_wire_roundtrip_and_reject_out_of_range() {
        for (v, msg) in [
            (1_u8, MsgType::Wrap),
            (2, MsgType::Unwrap),
            (3, MsgType::Status),
            (4, MsgType::Remove),
            (5, MsgType::Resp),
        ] {
            assert_eq!(MsgType::from_u8(v), Some(msg));
            assert_eq!(msg as u8, v);
        }
        for bad in [0_u8, 6, 255] {
            assert_eq!(MsgType::from_u8(bad), None);
        }
    }

    #[test]
    fn err_code_wire_roundtrip_and_reject_out_of_range() {
        for v in 0_u16..=6 {
            let code = ErrCode::from_u16(v).unwrap();
            assert_eq!(code.to_u16(), v);
        }
        assert_eq!(ErrCode::from_u16(7), None);
        assert_eq!(ErrCode::from_u16(u16::MAX), None);
    }
}
