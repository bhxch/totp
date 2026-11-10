//! 网络时间校准（时间源特性 spec §5）：SNTPv4 池 racing（UDP 123，主路径——不经 TLS，
//! 设备时钟严重错误时仍可校准）+ 毫秒 API HTTPS 降级（reqwest 已有；serde_json 免 RFC7231
//! 日期解析）。源池/源序为 2026-11-10 国内直连实测序（spec 事实基础），preferred 置顶仍全池兜底。

use serde::{Deserialize, Serialize};
use std::net::UdpSocket;
use std::sync::mpsc;
use std::time::{Duration, Instant};

/// NTP 1900 基准 → Unix 1970 基准（毫秒）
const NTP_EPOCH_DELTA_MS: i64 = 2_208_988_800_000;
/// 单 SNTP 查询超时（socket read timeout；线程自然退出防泄漏）
const SNTP_READ_TIMEOUT: Duration = Duration::from_secs(4);
/// 池 racing 总控超时
const POOL_DEADLINE: Duration = Duration::from_secs(5);
/// HTTPS 降级单请求超时
const HTTPS_TIMEOUT: Duration = Duration::from_secs(5);

/// SNTP 池（id 与 core NTP_TIME_SOURCE_IDS 对齐；ui 源 label 按 id 取 i18n）
const NTP_POOL: &[(&str, &str)] = &[
    ("aliyun", "ntp.aliyun.com"),
    ("tencent", "ntp.tencent.com"),
    ("tencent-time1", "time1.cloud.tencent.com"),
    ("neu", "ntp.neu.edu.cn"),
    ("cn-pool", "cn.pool.ntp.org"),
    ("tuna", "ntp.tuna.tsinghua.edu.cn"),
    ("windows", "time.windows.com"),
];

/// HTTPS 降级毫秒 API（id 与扩展端对齐；测试锚点用真实响应形状）
const HTTPS_FALLBACK: &[(&str, &str)] = &[
    ("taobao-api", "https://acs.m.taobao.com/gw/mtop.common.getTimestamp/"),
    ("suning-api", "https://f.m.suning.com/api/ct.do"),
];

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimeCalibrateResult {
    pub offset_ms: i64,
    pub source_id: String,
}

/// SNTPv4 客户端请求包：LI=0 VN=4 Mode=3(client)，其余全零
fn build_request() -> [u8; 48] {
    let mut p = [0u8; 48];
    p[0] = 0x23;
    p
}

/// 解析 transmit timestamp（包尾 8 字节）→ Unix epoch ms；sec=0（KoD/零戳）与短包拒绝
fn parse_transmit_ms(buf: &[u8]) -> Option<i64> {
    if buf.len() < 48 {
        return None;
    }
    let sec = u32::from_be_bytes([buf[40], buf[41], buf[42], buf[43]]) as i64;
    if sec == 0 {
        return None;
    }
    let frac = u32::from_be_bytes([buf[44], buf[45], buf[46], buf[47]]) as i64;
    Some(sec * 1000 + frac * 1000 / (1u64 << 32) as i64 - NTP_EPOCH_DELTA_MS)
}

/// 与 core computeOffsetMs 同式（中点假设）
fn offset_from(server_ms: i64, t0_ms: i64, t1_ms: i64) -> i64 {
    server_ms - (t0_ms + t1_ms) / 2
}

fn now_unix_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 单域名阻塞查询（std::thread 内执行；read timeout 防线程泄漏）。
/// 返回 (server_ms, t0, t1)——send/recv 前后本地毫秒随结果回传，主循环精确中点补偿 RTT
fn sntp_query_once(host: &str) -> Option<(i64, i64, i64)> {
    // UDP：先 bind 本地随机端口，再 connect 固定对端（UdpSocket::connect 是实例方法，
    // 与 TcpStream::connect 关联函数形态不同）
    let sock = UdpSocket::bind(("0.0.0.0", 0)).ok()?;
    sock.connect((host, 123)).ok()?;
    sock.set_read_timeout(Some(SNTP_READ_TIMEOUT)).ok()?;
    let req = build_request();
    let t0 = now_unix_ms();
    sock.send(&req).ok()?;
    let mut buf = [0u8; 48];
    let n = sock.recv(&mut buf).ok()?;
    let t1 = now_unix_ms();
    parse_transmit_ms(&buf[..n]).map(|server_ms| (server_ms, t0, t1))
}

/// preferred 置顶（仅收池内已知 id；未知 id 忽略），其余按内置序
fn pool_order(preferred: Option<&str>) -> Vec<&'static str> {
    let mut order: Vec<&'static str> = Vec::new();
    if let Some(p) = preferred {
        if let Some((id, _)) = NTP_POOL.iter().find(|(id, _)| *id == p) {
            order.push(id);
        }
    }
    for (id, _) in NTP_POOL {
        if !order.contains(id) {
            order.push(id);
        }
    }
    order
}

/// 池 racing：全池并发线程 + mpsc 收首个成功；总控超时后转 HTTPS 降级
async fn sntp_pool_offset(preferred: Option<&str>) -> Option<TimeCalibrateResult> {
    let (tx, rx) = mpsc::channel::<(&'static str, i64, i64, i64)>();
    let mut spawned = 0usize;
    for id in pool_order(preferred) {
        let host = NTP_POOL.iter().find(|(i, _)| *i == id).map(|(_, h)| *h).unwrap_or_default();
        let tx = tx.clone();
        std::thread::spawn(move || {
            if let Some((server_ms, t0, t1)) = sntp_query_once(host) {
                let _ = tx.send((id, server_ms, t0, t1));
            }
        });
        spawned += 1;
    }
    drop(tx);
    if spawned == 0 {
        return None;
    }
    let deadline = Instant::now() + POOL_DEADLINE;
    loop {
        let remain = deadline.saturating_duration_since(Instant::now());
        if remain.is_zero() {
            return None;
        }
        match rx.recv_timeout(remain) {
            Ok((source_id, server_ms, t0, t1)) => {
                return Some(TimeCalibrateResult {
                    offset_ms: offset_from(server_ms, t0, t1),
                    source_id: source_id.to_string(),
                });
            }
            Err(mpsc::RecvTimeoutError::Timeout) => return None,
            Err(mpsc::RecvTimeoutError::Disconnected) => return None,
        }
    }
}

/// SNTP 全败后的毫秒 API 降级（serde_json 解析，免日期字符串处理）；任一成功即返回
async fn https_fallback() -> Option<TimeCalibrateResult> {
    let client = reqwest::Client::builder().timeout(HTTPS_TIMEOUT).build().ok()?;
    for (id, url) in HTTPS_FALLBACK {
        let t0 = now_unix_ms();
        let resp = match client.get(*url).send().await {
            Ok(r) if r.status().is_success() => r,
            _ => continue,
        };
        // 本 crate reqwest 未启 json feature（零新增依赖约束）——text() 后 serde_json 手动解析
        let text = match resp.text().await {
            Ok(t) => t,
            Err(_) => continue,
        };
        let body: serde_json::Value = match serde_json::from_str(&text) {
            Ok(b) => b,
            Err(_) => continue,
        };
        let server_ms = body
            .pointer("/data/t")
            .and_then(|v| v.as_str())
            .and_then(|s| s.parse::<i64>().ok())
            .or_else(|| body.get("currentTime").and_then(|v| v.as_i64()));
        let Some(server_ms) = server_ms else { continue };
        let t1 = now_unix_ms();
        return Some(TimeCalibrateResult {
            offset_ms: offset_from(server_ms, t0, t1),
            source_id: (*id).to_string(),
        });
    }
    None
}

/// Tauri 命令：SNTP 池 racing → 全败转 HTTPS 降级 → 全败报错（调用方回退设备时间）
#[tauri::command]
pub async fn time_calibrate(preferred: Option<String>) -> Result<TimeCalibrateResult, String> {
    if let Some(r) = sntp_pool_offset(preferred.as_deref()).await {
        return Ok(r);
    }
    https_fallback().await.ok_or_else(|| "time calibrate: all sources failed".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_packet_is_sntp_v4_client() {
        let p = build_request();
        assert_eq!(p.len(), 48);
        assert_eq!(p[0], 0x23); // LI=0 VN=4 Mode=3(client)
        assert!(p[1..].iter().all(|&b| b == 0));
    }

    #[test]
    fn parse_transmit_timestamp_epoch_conversion() {
        // 已知戳：sec=0xEFAF_3C00（2026-11-10T00:00:00Z 附近锚点），frac=2^32/2 → +500ms
        // 用真实锚点：2026-11-10T00:00:00Z = 1791753600 s since epoch = 4000742400 since NTP 1900
        let sec: u32 = 1_791_753_600 + 2_208_988_800;
        let frac: u32 = 2_147_483_648; // 0.5s
        let mut buf = [0u8; 48];
        buf[40..44].copy_from_slice(&sec.to_be_bytes());
        buf[44..48].copy_from_slice(&frac.to_be_bytes());
        let ms = parse_transmit_ms(&buf).expect("valid packet");
        assert_eq!(ms, 1_791_753_600_500i64); // 1970 基准毫秒 + 500
    }

    #[test]
    fn parse_rejects_kod_and_short_packets() {
        let buf = [0u8; 48];
        assert!(parse_transmit_ms(&buf).is_none()); // sec=0（KoD/零戳）
        assert!(parse_transmit_ms(&buf[..40]).is_none()); // 短包
    }

    #[test]
    fn offset_midpoint_formula_matches_core() {
        // 与 core computeOffsetMs 同式（Review Focus 2）：server - (t0+t1)/2
        assert_eq!(offset_from(100_000, 1000, 2000), 98_500);
        // R7 修正：server 1_791_753_600_500，(t0+t1)/2 = 2_000 → 1_791_753_598_500
        assert_eq!(offset_from(1_791_753_600_500, 1_000, 3_000), 1_791_753_598_500);
    }

    #[test]
    fn pool_order_prefers_known_source() {
        // R7 裁定：按实现签名传 Option<&str>，不包 String
        let order = pool_order(Some("neu"));
        assert_eq!(order[0], "neu");
        assert_eq!(order.len(), NTP_POOL.len());
        // 非池内 preferred 被忽略（不产生未知名次的洞）：恒等价于纯内置序
        let order2 = pool_order(Some("evil.example"));
        let builtin: Vec<&'static str> = NTP_POOL.iter().map(|(id, _)| *id).collect();
        assert_eq!(order2, builtin);
    }
}
