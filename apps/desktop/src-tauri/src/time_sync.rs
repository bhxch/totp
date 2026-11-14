//! 网络时间校准（时间源特性 spec §5）：SNTPv4 池 racing（UDP 123，主路径——不经 TLS，
//! 设备时钟严重错误时仍可校准）+ 毫秒 API HTTPS 降级（reqwest 已有；serde_json 免 RFC7231
//! 日期解析）。源池/源序为 2026-11-10 国内直连实测序（spec 事实基础），preferred 置顶仍全池兜底。
//!
//! 两条源链（2026-11-13 全球链补齐）：profile 由**界面语言**决定（前端 ui timeSourceProfileFor
//! 判定后随命令入参带下）——'cn' 大陆链（原 7 池 + 淘宝/苏宁毫秒 API，原样保留）、
//! 'global' 国际链（Cloudflare/NIST/Apple/NICT/全球池 + timeapi/trace/Date 头降级）。
//! 非本链的 preferred id 忽略走内置序（pool_order 只认本链 id）。

use serde::{Deserialize, Serialize};
use std::net::{SocketAddr, ToSocketAddrs, UdpSocket};
use std::sync::mpsc;
use std::time::Duration;

/// NTP 1900 基准 → Unix 1970 基准（毫秒）
const NTP_EPOCH_DELTA_MS: i64 = 2_208_988_800_000;
/// 单 SNTP 查询超时（socket read timeout；线程自然退出防泄漏）
const SNTP_READ_TIMEOUT: Duration = Duration::from_secs(4);
/// 池 racing 总控超时
const POOL_DEADLINE: Duration = Duration::from_secs(5);
/// HTTPS 降级单请求超时
const HTTPS_TIMEOUT: Duration = Duration::from_secs(5);
/// 服务器时刻合理下界（2023-11-14）：schema 级垃圾值防线（终审 G5 同源）——合法偏移不受影响，
/// 只挡解析错误/未同步服务器产出的明显不可能时间戳
const SERVER_MS_FLOOR: i64 = 1_700_000_000_000;
/// HTTPS 源「可采信 RTT 上限」（毫秒；与 core HTTPS_TRUSTED_RTT_MS 一致）：
/// HTTP JSON/Date 头的时间戳在**响应构建时**生成，而中点公式假设服务端时刻落在请求/响应
/// 中点——origin 排队数秒再出响应时该假设失效（2026-11-13 实测：timeapi.io 与 cf-204 在
/// RTT≈8.1s 时偏置 +3.9~4.1s，RTT≈0.2s 时偏置仅 +3~11ms）。残差偏置 ≤ RTT/2，故 RTT
/// 超过上限的应答不采信（源兜底下一源），把误差压回秒级截断的地板（±500ms）。
/// SNTP 不受此限（协议自带精确时戳与 RTT 补偿），本文件主路径不受影响
const HTTPS_TRUSTED_RTT_MS: i64 = 800;

/// 时间源链剖面（与 core TimeSourceProfile 对齐；入参非法值一律回大陆链）
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Profile {
    Cn,
    Global,
}

fn profile_from(raw: Option<&str>) -> Profile {
    match raw {
        Some("global") => Profile::Global,
        _ => Profile::Cn,
    }
}

/// SNTP 池·大陆链（id 与 core NTP_TIME_SOURCE_IDS_CN 对齐；ui 源 label 按 id 取 i18n）
const NTP_POOL_CN: &[(&str, &str)] = &[
    ("aliyun", "ntp.aliyun.com"),
    ("tencent", "ntp.tencent.com"),
    ("tencent-time1", "time1.cloud.tencent.com"),
    ("neu", "ntp.neu.edu.cn"),
    ("cn-pool", "cn.pool.ntp.org"),
    ("tuna", "ntp.tuna.tsinghua.edu.cn"),
    ("windows", "time.windows.com"),
];

/// SNTP 池·国际链（id 与 core NTP_TIME_SOURCE_IDS_GLOBAL 对齐；2026-11-13 实测可达且互相
/// 一致 ±15ms：pool.ntp.org/time.cloudflare.com/time.nist.gov/time.apple.com/ntp.nict.jp/
/// europe.pool/asia.pool/ntp.ubuntu.com）
const NTP_POOL_GLOBAL: &[(&str, &str)] = &[
    ("time-cloudflare", "time.cloudflare.com"),
    ("pool", "pool.ntp.org"),
    ("time-nist", "time.nist.gov"),
    ("time-apple", "time.apple.com"),
    ("nict", "ntp.nict.jp"),
    ("europe-pool", "europe.pool.ntp.org"),
    ("asia-pool", "asia.pool.ntp.org"),
    ("ubuntu", "ntp.ubuntu.com"),
];

fn pool_for(profile: Profile) -> &'static [(&'static str, &'static str)] {
    match profile {
        Profile::Cn => NTP_POOL_CN,
        Profile::Global => NTP_POOL_GLOBAL,
    }
}

/// HTTPS 降级源解析形态（各源时间戳格式不同，按源定制）
#[derive(Clone, Copy)]
enum ParseKind {
    /// 毫秒 API（淘宝 data.t 字符串 / 苏宁 currentTime 数字）
    JsonMillis,
    /// timeapi.io 组件（year/month/day/hour/minute/seconds/milliSeconds，UTC）
    JsonCivil,
    /// Cloudflare trace 文本（ts= 秒浮点）
    TraceTs,
    /// RFC7231 Date 头（秒级）
    DateHeader,
}

/// HTTPS 降级源（id 与扩展端同链 id 对齐）
struct HttpsSource {
    id: &'static str,
    url: &'static str,
    /// GET 取体 / HEAD 取 Date 头（Date 头源不取体，省带宽）
    head_only: bool,
    parse: ParseKind,
}

/// HTTPS 降级·大陆链（毫秒 API 动态生成，免疫 CDN 缓存）
const HTTPS_FALLBACK_CN: &[HttpsSource] = &[
    HttpsSource {
        id: "taobao-api",
        url: "https://acs.m.taobao.com/gw/mtop.common.getTimestamp/",
        head_only: false,
        parse: ParseKind::JsonMillis,
    },
    HttpsSource {
        id: "suning-api",
        url: "https://f.m.suning.com/api/ct.do",
        head_only: false,
        parse: ParseKind::JsonMillis,
    },
];

/// HTTPS 降级·国际链（动态源在前；Date 头源末位——Date 头可能被 CDN 缓存致滞后，
/// 2026-11-13 实测 apple.com 滞后 542s，故不作首选）
const HTTPS_FALLBACK_GLOBAL: &[HttpsSource] = &[
    HttpsSource {
        id: "timeapi",
        url: "https://timeapi.io/api/time/current/zone?timeZone=UTC",
        head_only: false,
        parse: ParseKind::JsonCivil,
    },
    HttpsSource {
        id: "cloudflare-trace",
        url: "https://www.cloudflare.com/cdn-cgi/trace",
        head_only: false,
        parse: ParseKind::TraceTs,
    },
    HttpsSource {
        id: "cloudflare-204",
        url: "https://cp.cloudflare.com/generate_204",
        head_only: true,
        parse: ParseKind::DateHeader,
    },
    HttpsSource {
        id: "microsoft",
        url: "https://www.microsoft.com",
        head_only: true,
        parse: ParseKind::DateHeader,
    },
];

fn https_fallback_for(profile: Profile) -> &'static [HttpsSource] {
    match profile {
        Profile::Cn => HTTPS_FALLBACK_CN,
        Profile::Global => HTTPS_FALLBACK_GLOBAL,
    }
}

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

/// 解析 transmit timestamp（包尾 8 字节）→ Unix epoch ms。拒绝：
/// - 短包 / sec=0（KoD 零戳）；
/// - stratum=0（RFC 4330 KoD 应答的正解判别——KoD 应答 transmit 可能非零，sec==0 抓不住，
///   终审 Task4-M1）；
/// - leap indicator=3（RI-4 unsynchronized：服务器自报未同步，alarm 态）；
/// - server 时刻早于 SERVER_MS_FLOOR（schema 级垃圾值，终审 G5 同源）
fn parse_transmit_ms(buf: &[u8]) -> Option<i64> {
    if buf.len() < 48 {
        return None;
    }
    if buf[1] == 0 {
        return None; // stratum=0：KoD/ kiss-of-death 应答
    }
    if buf[0] >> 6 == 3 {
        return None; // leap indicator 3：服务器自报未同步
    }
    let sec = u32::from_be_bytes([buf[40], buf[41], buf[42], buf[43]]) as i64;
    if sec == 0 {
        return None;
    }
    let frac = u32::from_be_bytes([buf[44], buf[45], buf[46], buf[47]]) as i64;
    let server_ms = sec * 1000 + frac * 1000 / (1u64 << 32) as i64 - NTP_EPOCH_DELTA_MS;
    if server_ms < SERVER_MS_FLOOR {
        return None;
    }
    Some(server_ms)
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
/// 返回 (server_ms, t0, t1)——send/recv 前后本地毫秒随结果回传，主循环精确中点补偿 RTT。
/// 修 2（终审 Task4-M2）：解析全部地址逐 IP 尝试——connect 单地址只试首解析 IP，且
/// AAAA-only 域名此前直接失败；DNS 解析同样在本线程阻塞（无超时），慢 DNS 使该源线程
/// 晚于池总控 deadline 返回（主控不等、自行终止）→ 自然落 HTTPS 降级，行为合理（修 3 说明）
fn sntp_query_once(host: &str) -> Option<(i64, i64, i64)> {
    let addrs: Vec<SocketAddr> = (host, 123u16).to_socket_addrs().ok()?.collect();
    for addr in addrs {
        if let Some(r) = sntp_query_addr(addr) {
            return Some(r);
        }
    }
    None
}

/// 对单个已解析地址做一次 SNTP 查询（bind 本地随机端口 + connect 固定对端）
fn sntp_query_addr(addr: SocketAddr) -> Option<(i64, i64, i64)> {
    let bind_addr: SocketAddr = if addr.is_ipv4() {
        "0.0.0.0:0".parse().ok()?
    } else {
        "[::]:0".parse().ok()?
    };
    let sock = UdpSocket::bind(bind_addr).ok()?;
    sock.connect(addr).ok()?;
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
fn pool_order(pool: &[(&'static str, &'static str)], preferred: Option<&str>) -> Vec<&'static str> {
    let mut order: Vec<&'static str> = Vec::new();
    if let Some(p) = preferred {
        if let Some((id, _)) = pool.iter().find(|(id, _)| *id == p) {
            order.push(id);
        }
    }
    for (id, _) in pool {
        if !order.contains(id) {
            order.push(id);
        }
    }
    order
}

/// 池 racing：全池并发线程 + mpsc 收首个成功；总控超时后转 HTTPS 降级（同步实现，
/// 由命令侧经 tokio spawn_blocking 调度——修 4：SNTP 阻塞收参不得占用 tokio worker）
fn sntp_pool_offset(
    pool: &[(&'static str, &'static str)],
    preferred: Option<&str>,
) -> Option<TimeCalibrateResult> {
    let (tx, rx) = mpsc::channel::<(&'static str, i64, i64, i64)>();
    let mut spawned = 0usize;
    for id in pool_order(pool, preferred) {
        let host = pool
            .iter()
            .find(|(i, _)| *i == id)
            .map(|(_, h)| *h)
            .unwrap_or_default();
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
    // 单次 recv_timeout 即可：成功/超时/断开三分支均直接返回（首个成功响应即采纳，
    // 总控超时 POOL_DEADLINE 兜底全部慢源）
    match rx.recv_timeout(POOL_DEADLINE) {
        Ok((source_id, server_ms, t0, t1)) => Some(TimeCalibrateResult {
            offset_ms: offset_from(server_ms, t0, t1),
            source_id: source_id.to_string(),
        }),
        Err(mpsc::RecvTimeoutError::Timeout) => None,
        Err(mpsc::RecvTimeoutError::Disconnected) => None,
    }
}

/// 公历 → 天数（Hinnant days_from_civil，floor 语义用 div_euclid；1970-01-01 = 0）
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400; // [0, 399]
    let mp = (m + 9).rem_euclid(12); // [0, 11]
    let doy = (153 * mp + 2) / 5 + d - 1; // [0, 365]
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

/// 该年该月的天数（公历；闰年规则：能被 4 整除且（非 100 整除或能被 400 整除））
fn days_in_month(y: i64, mo: i64) -> i64 {
    match mo {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            if (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 {
                29
            } else {
                28
            }
        }
        _ => 0,
    }
}

/// 公历时刻（UTC）→ epoch 毫秒；分量越界返回 None（防畸形应答）。
/// 日按「该年该月实际天数」校验（拒绝 2 月 31 日这类静默滚月）；年份限 1..=9999（防溢出）
fn civil_to_epoch_ms(y: i64, mo: i64, d: i64, h: i64, mi: i64, s: i64, ms: i64) -> Option<i64> {
    if !(1..=9999).contains(&y) || !(1..=12).contains(&mo) {
        return None;
    }
    if d < 1 || d > days_in_month(y, mo) {
        return None;
    }
    if !(0..=23).contains(&h)
        || !(0..=59).contains(&mi)
        || !(0..=60).contains(&s)
        || !(0..=999).contains(&ms)
    {
        return None;
    }
    let days = days_from_civil(y, mo, d);
    let secs = days * 86_400 + h * 3600 + mi * 60 + s.min(59);
    Some(secs * 1000 + ms)
}

/// 毫秒 API 解析（淘宝 data.t 字符串 / 苏宁 currentTime 数字）
fn parse_json_millis(body: &serde_json::Value) -> Option<i64> {
    body.pointer("/data/t")
        .and_then(|v| v.as_str())
        .and_then(|s| s.parse::<i64>().ok())
        .or_else(|| body.get("currentTime").and_then(|v| v.as_i64()))
}

/// timeapi.io 组件解析（请求 UTC，组件即 UTC 时刻）
fn parse_json_civil(body: &serde_json::Value) -> Option<i64> {
    let g = |k: &str| body.get(k).and_then(|v| v.as_i64());
    let (y, mo, d) = (g("year")?, g("month")?, g("day")?);
    let (h, mi, s) = (g("hour")?, g("minute")?, g("seconds")?);
    let ms = g("milliSeconds").unwrap_or(0);
    civil_to_epoch_ms(y, mo, d, h, mi, s, ms)
}

/// Cloudflare trace 文本解析（ts= 秒浮点）
fn parse_trace_ts(text: &str) -> Option<i64> {
    let ts = text
        .lines()
        .find_map(|l| l.strip_prefix("ts="))
        .map(str::trim)
        .and_then(|v| v.parse::<f64>().ok())?;
    if !ts.is_finite() {
        return None;
    }
    Some((ts * 1000.0).round() as i64)
}

/// 月份缩写 → 月份序号（RFC7231 Date 头用；大小写不敏感）
fn month_from_name(name: &str) -> Option<i64> {
    const MONTHS: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    MONTHS
        .iter()
        .position(|m| m.eq_ignore_ascii_case(name))
        .map(|i| i as i64 + 1)
}

/// RFC7231 Date 头 → epoch 毫秒（IMF-fixdate：`Sun, 06 Nov 1994 08:49:37 GMT`）。
/// 免第三方依赖手写解析（本 crate 无 chrono/httpdate，spec §5 曾据此回避 Date 头源；
/// 国际链需要 Date 头兜底，故就地实现并以单测锁定格式）
fn parse_http_date(raw: &str) -> Option<i64> {
    let s = raw.trim();
    // 去掉星期前缀（`Sun, `）
    let rest = s.split_once(", ")?.1;
    let mut it = rest.split(' ');
    let d: i64 = it.next()?.parse().ok()?;
    let mon = it.next()?;
    let y: i64 = it.next()?.parse().ok()?;
    let time = it.next()?;
    let zone = it.next()?;
    if !zone.eq_ignore_ascii_case("GMT") {
        return None;
    }
    // IMF-fixdate 恰 5 段（day/month/year/time/zone）：多余段 → 畸形，拒绝
    if it.next().is_some() {
        return None;
    }
    let m = month_from_name(mon)?;
    let mut tp = time.split(':');
    let h: i64 = tp.next()?.parse().ok()?;
    let mi: i64 = tp.next()?.parse().ok()?;
    let sec: i64 = tp.next()?.parse().ok()?;
    if tp.next().is_some() {
        return None;
    }
    if !(0..=23).contains(&h) || !(0..=59).contains(&mi) || !(0..=60).contains(&sec) {
        return None;
    }
    // 日按「该年该月实际天数」校验（拒绝 31 Feb 这类静默滚月）；年份限 1..=9999（防溢出）
    if !(1..=9999).contains(&y) || d < 1 || d > days_in_month(y, m) {
        return None;
    }
    let days = days_from_civil(y, m, d);
    let secs = days * 86_400 + h * 3600 + mi * 60 + sec.min(59);
    Some(secs * 1000)
}

/// Cache-Control 是否带**正 TTL**（max-age>0 / s-maxage>0）：带则应答可来自 CDN 缓存，
/// 其内含时间戳（Date 头 / JSON 时刻）可能滞后数秒~数分钟——2026-11-13 实测 gitee
/// `s-maxage=60, stale-while-revalidate=120` 与 jd `max-age=120`（Age:1）即属此类，
/// 滞后量级足以让偏移错上百秒（偏移被采纳后 6h 内出码错）。故缓存过的应答不采信。
/// `max-age=0` / `no-store` / `no-cache` / 无 Cache-Control 皆视为未缓存 ✓
fn cc_has_positive_ttl(cc: &str) -> bool {
    for part in cc.split(',') {
        let p = part.trim().to_ascii_lowercase();
        // 指令名为 s-maxage（无 max-age 连字符）；strip_prefix 天然区分二者
        for key in ["s-maxage=", "max-age="] {
            if let Some(rest) = p.strip_prefix(key) {
                let v = rest.split(';').next().unwrap_or("").trim();
                if let Ok(n) = v.parse::<i64>() {
                    if n > 0 {
                        return true;
                    }
                }
            }
        }
    }
    false
}

/// 应答是否「未缓存」（可作时间源）：Age>0 或 Cache-Control 带正 TTL → 拒绝
fn response_fresh(resp: &reqwest::Response) -> bool {
    let age_ok = resp
        .headers()
        .get(reqwest::header::AGE)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.trim().parse::<i64>().ok())
        .map(|a| a <= 0)
        .unwrap_or(true);
    if !age_ok {
        return false;
    }
    let cc = resp
        .headers()
        .get(reqwest::header::CACHE_CONTROL)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    !cc_has_positive_ttl(cc)
}

/// 源解析分派（纯函数，便于单测覆盖四种形态）：body=响应体（Date 头源为空串），
/// date_header=Date 头原文（仅 DateHeader 形态用）。任一形态解析失败 → None（该源兜底下一源）
fn parse_source_time(kind: ParseKind, body: &str, date_header: Option<&str>) -> Option<i64> {
    match kind {
        ParseKind::JsonMillis => serde_json::from_str::<serde_json::Value>(body)
            .ok()
            .and_then(|b| parse_json_millis(&b)),
        ParseKind::JsonCivil => serde_json::from_str::<serde_json::Value>(body)
            .ok()
            .and_then(|b| parse_json_civil(&b)),
        ParseKind::TraceTs => parse_trace_ts(body),
        ParseKind::DateHeader => date_header.and_then(parse_http_date),
    }
}

/// SNTP 全败后的毫秒 API 降级（serde_json 解析，免日期字符串处理）；任一成功即返回
async fn https_fallback(sources: &[HttpsSource]) -> Option<TimeCalibrateResult> {
    let client = reqwest::Client::builder()
        .timeout(HTTPS_TIMEOUT)
        .build()
        .ok()?;
    for src in sources {
        let t0 = now_unix_ms();
        let resp = match if src.head_only {
            client.head(src.url).send().await
        } else {
            client.get(src.url).send().await
        } {
            Ok(r) if r.status().is_success() => r,
            _ => continue,
        };
        // 缓存护栏：被 CDN 缓存过的应答，其时间戳可能滞后数十秒起（实测 gitee s-maxage=60 /
        // jd max-age=120）→ 不采信（兜底下一源）。须在消费 body 之前判定（resp.text() 会移走 resp）
        if !response_fresh(&resp) {
            continue;
        }
        // Date 头源只取头不取体（省带宽）；其余形态取体后文本解析（reqwest 未启 json feature，
        // 零新增依赖约束——text() 后 serde_json 手动解析）
        let date_header = resp
            .headers()
            .get(reqwest::header::DATE)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string);
        let body = if src.head_only {
            String::new()
        } else {
            match resp.text().await {
                Ok(t) => t,
                Err(_) => continue,
            }
        };
        let server_ms = match parse_source_time(src.parse, &body, date_header.as_deref()) {
            Some(ms) => ms,
            None => continue,
        };
        if server_ms < SERVER_MS_FLOOR {
            continue;
        }
        let t1 = now_unix_ms();
        // RTT 护栏（2026-11-13 实测）：HTTP 源时间戳在响应构建时生成，origin 排队数秒时中点
        // 公式残差偏置可达秒级（RTT 8.1s → +4.0s；RTT 0.2s → +10ms）。慢应答不采信
        if !rtt_trusted(t1 - t0) {
            continue;
        }
        return Some(TimeCalibrateResult {
            offset_ms: offset_from(server_ms, t0, t1),
            source_id: src.id.to_string(),
        });
    }
    None
}

/// RTT 是否在可采信范围内（纯函数，与 core isTrustedHttpRtt 同口径）
fn rtt_trusted(rtt_ms: i64) -> bool {
    (0..=HTTPS_TRUSTED_RTT_MS).contains(&rtt_ms)
}

/// Tauri 命令：SNTP 池 racing → 全败转 HTTPS 降级 → 全败报错（调用方回退设备时间）。
/// 修 4（终审 Task4-M4）：SNTP 的阻塞收参（spawn 线程 join 语义 + recv_timeout 最长 5s）
/// 经 spawn_blocking 移出 tokio worker；HTTPS 降级保持异步。
/// profile：源链剖面（'cn' 大陆链 / 'global' 国际链，2026-11-13 全球链补齐），由前端按
/// 界面语言判定后带下；非法值回大陆链
#[tauri::command]
pub async fn time_calibrate(
    preferred: Option<String>,
    profile: Option<String>,
) -> Result<TimeCalibrateResult, String> {
    let profile = profile_from(profile.as_deref());
    let pool = pool_for(profile);
    let sntp = tokio::task::spawn_blocking(move || sntp_pool_offset(pool, preferred.as_deref()))
        .await
        .map_err(|e| format!("time calibrate: blocking task join error: {e}"))?;
    if let Some(r) = sntp {
        return Ok(r);
    }
    https_fallback(https_fallback_for(profile))
        .await
        .ok_or_else(|| "time calibrate: all sources failed".to_string())
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
        buf[0] = 0x24; // LI=0 VN=4 Mode=4(server)，leap 正常
        buf[1] = 2; // stratum=2（合法，非 KoD）
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

    /// 修 1（终审 Task4-M1）：KoD 应答的 transmit 可能非零——stratum=0 才是正解判别
    #[test]
    fn parse_rejects_stratum_zero_kod_with_valid_transmit() {
        let sec: u32 = 1_791_753_600 + 2_208_988_800;
        let mut buf = [0u8; 48];
        buf[0] = 0x24; // LI=0 VN=4 Mode=4(server)，leap 正常
        buf[1] = 0; // stratum=0（KoD）
        buf[40..44].copy_from_slice(&sec.to_be_bytes());
        assert!(parse_transmit_ms(&buf).is_none());
        // 对照：同戳 stratum≥1 → 有效
        buf[1] = 2;
        assert!(parse_transmit_ms(&buf).is_some());
    }

    /// 修 1（RI-4）：leap indicator=3 = 服务器自报未同步（alarm 态）
    #[test]
    fn parse_rejects_unsynchronized_leap_three() {
        let sec: u32 = 1_791_753_600 + 2_208_988_800;
        let mut buf = [0u8; 48];
        buf[1] = 2;
        buf[40..44].copy_from_slice(&sec.to_be_bytes());
        assert!(parse_transmit_ms(&buf).is_some());
        buf[0] = (buf[0] & 0x3f) | 0xc0; // LI=3
        assert!(parse_transmit_ms(&buf).is_none());
    }

    /// 修 1（G5 同源）：server 时刻早于合理下界 → schema 级垃圾值拒绝
    #[test]
    fn parse_rejects_server_time_below_floor() {
        let sec: u32 = 1_600_000_000 + 2_208_988_800; // 2020-09-13，早于 SERVER_MS_FLOOR
        let mut buf = [0u8; 48];
        buf[1] = 2;
        buf[40..44].copy_from_slice(&sec.to_be_bytes());
        assert!(parse_transmit_ms(&buf).is_none());
    }

    #[test]
    fn offset_midpoint_formula_matches_core() {
        // 与 core computeOffsetMs 同式（Review Focus 2）：server - (t0+t1)/2
        assert_eq!(offset_from(100_000, 1000, 2000), 98_500);
        // R7 修正：server 1_791_753_600_500，(t0+t1)/2 = 2_000 → 1_791_753_598_500
        assert_eq!(
            offset_from(1_791_753_600_500, 1_000, 3_000),
            1_791_753_598_500
        );
    }

    #[test]
    fn pool_order_prefers_known_source() {
        // R7 裁定：按实现签名传 Option<&str>，不包 String
        let order = pool_order(NTP_POOL_CN, Some("neu"));
        assert_eq!(order[0], "neu");
        assert_eq!(order.len(), NTP_POOL_CN.len());
        // 非池内 preferred 被忽略（不产生未知名次的洞）：恒等价于纯内置序
        let order2 = pool_order(NTP_POOL_CN, Some("evil.example"));
        let builtin: Vec<&'static str> = NTP_POOL_CN.iter().map(|(id, _)| *id).collect();
        assert_eq!(order2, builtin);
    }

    /// 2026-11-13 全球链：剖面决定池，非本链 preferred（跨链 id）被忽略
    #[test]
    fn pool_selection_follows_profile() {
        assert_eq!(pool_for(Profile::Cn).len(), NTP_POOL_CN.len());
        assert_eq!(pool_for(Profile::Global).len(), NTP_POOL_GLOBAL.len());
        // 国际链 preferred 置顶生效
        let order = pool_order(NTP_POOL_GLOBAL, Some("time-nist"));
        assert_eq!(order[0], "time-nist");
        // 大陆链 id 在国际链里不存在 → 忽略，走内置序（不产生洞）
        let order2 = pool_order(NTP_POOL_GLOBAL, Some("aliyun"));
        let builtin: Vec<&'static str> = NTP_POOL_GLOBAL.iter().map(|(id, _)| *id).collect();
        assert_eq!(order2, builtin);
    }

    /// 入参归一：仅 'global' 归国际链，其余（含非法值）回大陆链
    #[test]
    fn profile_from_accepts_only_global() {
        assert_eq!(profile_from(Some("global")), Profile::Global);
        assert_eq!(profile_from(Some("cn")), Profile::Cn);
        assert_eq!(profile_from(Some("GLOBAL")), Profile::Cn);
        assert_eq!(profile_from(None), Profile::Cn);
    }

    /// 桌面侧两链 id 不重叠（本 crate 的池与降级表各自成链）。
    /// 注：core 的两条 **HTTPS** 链共用 `cloudflare-trace`（同 id 同 URL 同解析形态，语义无冲突），
    /// 故 core 侧的约束是「同 id 跨链须语义一致」而非「不相交」
    #[test]
    fn chains_have_disjoint_ids() {
        let cn: Vec<&str> = NTP_POOL_CN
            .iter()
            .map(|(id, _)| *id)
            .chain(HTTPS_FALLBACK_CN.iter().map(|s| s.id))
            .collect();
        for (id, _) in NTP_POOL_GLOBAL {
            assert!(!cn.contains(id), "国际链 id 与大陆链重复: {id}");
        }
        for s in HTTPS_FALLBACK_GLOBAL {
            assert!(!cn.contains(&s.id), "国际链 id 与大陆链重复: {}", s.id);
        }
    }

    /// 公历 → 天数：1970-01-01 = 0；闰年/世纪闰年锚点
    #[test]
    fn days_from_civil_anchors() {
        assert_eq!(days_from_civil(1970, 1, 1), 0);
        assert_eq!(days_from_civil(1970, 1, 2), 1);
        assert_eq!(days_from_civil(1969, 12, 31), -1);
        // 2000-02-29（闰日）= 11016 天；2026-11-13 = 20770 天
        assert_eq!(days_from_civil(2000, 2, 29), 11016);
        assert_eq!(days_from_civil(2026, 11, 13), 20770);
    }

    /// 组件 → epoch 毫秒：2026-11-13T14:11:06.701Z
    #[test]
    fn civil_to_epoch_ms_converts_components() {
        let ms = civil_to_epoch_ms(2026, 11, 13, 14, 11, 6, 701).expect("valid");
        assert_eq!(ms, 1_794_579_066_701);
        // 分量越界 → None
        assert!(civil_to_epoch_ms(2026, 13, 13, 0, 0, 0, 0).is_none());
        assert!(civil_to_epoch_ms(2026, 11, 13, 24, 0, 0, 0).is_none());
        assert!(civil_to_epoch_ms(2026, 11, 13, 0, 0, 0, 1000).is_none());
    }

    /// timeapi.io 组件解析（真实响应形状）
    #[test]
    fn parse_json_civil_reads_timeapi_shape() {
        let body = serde_json::json!({
            "year": 2026, "month": 11, "day": 13, "hour": 14, "minute": 11,
            "seconds": 6, "milliSeconds": 701, "dateTime": "2026-11-13T14:11:06.7013004",
            "timeZone": "UTC"
        });
        assert_eq!(parse_json_civil(&body), Some(1_794_579_066_701));
        // 缺字段 → None
        let bad = serde_json::json!({ "year": 2026 });
        assert_eq!(parse_json_civil(&bad), None);
    }

    /// 毫秒 API 解析（淘宝 data.t 字符串 / 苏宁 currentTime 数字）
    #[test]
    fn parse_json_millis_reads_cn_shapes() {
        let tb = serde_json::json!({ "data": { "t": "1794579066701" } });
        assert_eq!(parse_json_millis(&tb), Some(1_794_579_066_701));
        let sn = serde_json::json!({ "currentTime": 1_794_579_066_701i64 });
        assert_eq!(parse_json_millis(&sn), Some(1_794_579_066_701));
    }

    /// Cloudflare trace 文本解析（ts= 秒浮点）
    #[test]
    fn parse_trace_ts_reads_seconds_float() {
        let text = "fl=abc\nh=www.cloudflare.com\nts=1794579066.701\ncolo=SJC\n";
        assert_eq!(parse_trace_ts(text), Some(1_794_579_066_701));
        assert_eq!(parse_trace_ts("no ts here"), None);
    }

    /// RFC7231 Date 头解析（IMF-fixdate）
    #[test]
    fn parse_http_date_reads_imf_fixdate() {
        // 2026-11-13T14:11:06Z
        assert_eq!(
            parse_http_date("Fri, 13 Nov 2026 14:11:06 GMT"),
            Some(1_794_579_066_000)
        );
        // RFC7231 规范样例
        assert_eq!(
            parse_http_date("Sun, 06 Nov 1994 08:49:37 GMT"),
            Some(784_111_777_000)
        );
        // 非 GMT 时区 → 拒绝
        assert_eq!(parse_http_date("Fri, 13 Nov 2026 14:11:06 CST"), None);
        // 畸形 → 拒绝
        assert_eq!(parse_http_date("not a date"), None);
        assert_eq!(parse_http_date("Fri, 13 Nov 2026 14:11:06 GMT extra"), None);
    }

    /// 源解析分派：四种形态各一臂 + 失败臂（纯函数，不触网）
    #[test]
    fn parse_source_time_dispatches_all_kinds() {
        // 毫秒 API（淘宝 data.t / 苏宁 currentTime）
        assert_eq!(
            parse_source_time(
                ParseKind::JsonMillis,
                r#"{"data":{"t":"1794579066701"}}"#,
                None
            ),
            Some(1_794_579_066_701)
        );
        // timeapi 组件
        assert_eq!(
            parse_source_time(
                ParseKind::JsonCivil,
                r#"{"year":2026,"month":11,"day":13,"hour":14,"minute":11,"seconds":6,"milliSeconds":701}"#,
                None
            ),
            Some(1_794_579_066_701)
        );
        // trace 文本
        assert_eq!(
            parse_source_time(ParseKind::TraceTs, "ts=1794579066.701\n", None),
            Some(1_794_579_066_701)
        );
        // Date 头
        assert_eq!(
            parse_source_time(
                ParseKind::DateHeader,
                "",
                Some("Fri, 13 Nov 2026 14:11:06 GMT")
            ),
            Some(1_794_579_066_000)
        );
    }

    /// 缓存护栏：Cache-Control 带正 TTL（max-age/s-maxage>0）→ 应答可能来自 CDN 缓存，
    /// 其时间戳可滞后数十秒起（实测 gitee s-maxage=60、jd max-age=120）→ 不采信
    #[test]
    fn cc_has_positive_ttl_detects_cacheable_responses() {
        assert!(cc_has_positive_ttl("max-age=120"));
        assert!(cc_has_positive_ttl(
            "public, s-maxage=60, stale-while-revalidate=120"
        ));
        assert!(cc_has_positive_ttl("max-age=60, must-revalidate"));
        // 未缓存形态（实测 baidu/microsoft/cf-204/timeapi/taobao 属此类）
        assert!(!cc_has_positive_ttl(
            "private, no-cache, no-store, proxy-revalidate"
        ));
        assert!(!cc_has_positive_ttl("max-age=0, no-cache, no-store"));
        assert!(!cc_has_positive_ttl(""));
        assert!(!cc_has_positive_ttl("public"));
        assert!(!cc_has_positive_ttl("no-cache"));
    }

    /// 日历校验：拒绝不存在的日期（31 Feb / 2 月 30 日）、接受闰日；年份越界拒绝
    #[test]
    fn civil_and_date_reject_impossible_dates() {
        assert!(civil_to_epoch_ms(2026, 2, 31, 0, 0, 0, 0).is_none());
        assert!(civil_to_epoch_ms(2026, 2, 30, 0, 0, 0, 0).is_none());
        assert!(civil_to_epoch_ms(2025, 2, 29, 0, 0, 0, 0).is_none());
        // 2024 是闰年 → 2 月 29 日合法
        assert!(civil_to_epoch_ms(2024, 2, 29, 0, 0, 0, 0).is_some());
        // 年份越界
        assert!(civil_to_epoch_ms(10_000, 1, 1, 0, 0, 0, 0).is_none());
        // Date 头同样拒绝 31 Feb
        assert_eq!(parse_http_date("Tue, 31 Feb 2026 08:49:37 GMT"), None);
        assert!(parse_http_date("Tue, 29 Feb 2024 08:49:37 GMT").is_some());
    }

    /// RTT 护栏（2026-11-13 实测）：慢应答不采信（origin 排队数秒 → 中点公式残差偏置可达秒级）
    #[test]
    fn rtt_trusted_rejects_slow_responses() {
        assert!(rtt_trusted(0));
        assert!(rtt_trusted(197));
        assert!(rtt_trusted(HTTPS_TRUSTED_RTT_MS));
        assert!(!rtt_trusted(HTTPS_TRUSTED_RTT_MS + 1));
        assert!(!rtt_trusted(8_100)); // 实测 timeapi.io 慢应答
        assert!(!rtt_trusted(-1));
    }

    /// 分派失败臂：畸形 JSON / 缺字段 / 缺 Date 头 / 缺 ts= → None（该源兜底下一源）
    #[test]
    fn parse_source_time_rejects_garbage() {
        assert_eq!(
            parse_source_time(ParseKind::JsonMillis, "not json", None),
            None
        );
        assert_eq!(parse_source_time(ParseKind::JsonCivil, "{}", None), None);
        assert_eq!(parse_source_time(ParseKind::TraceTs, "no ts", None), None);
        assert_eq!(parse_source_time(ParseKind::DateHeader, "", None), None);
        // Date 头形态给了体也不取体（体非空仍走 Date 头）
        assert_eq!(
            parse_source_time(
                ParseKind::DateHeader,
                r#"{"data":{"t":"1794579066701"}}"#,
                Some("Fri, 13 Nov 2026 14:11:06 GMT")
            ),
            Some(1_794_579_066_000)
        );
    }
}
