//! 云备份出网 command（2026-09-30 CORS/代理设计）：reqwest 天然无 CORS，替代页面层 fetch。
//! PROPFIND/自定义 header 全开放；S3 SigV4 签名仍在页面层，本层只转发。
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudProxyCfg {
    pub mode: String,
    pub url: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudHttpReq {
    pub url: String,
    pub method: String,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    pub body_b64: Option<String>,
    pub proxy: Option<CloudProxyCfg>,
    pub timeout_ms: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudHttpResp {
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub body_b64: Option<String>,
}

/// Client 按 (mode, url) 键缓存（连接池复用；进程内存）
static CLIENTS: Mutex<Option<HashMap<String, reqwest::Client>>> = Mutex::new(None);

const DEFAULT_TIMEOUT_MS: u64 = 60_000;

/// 错误消息脱敏（云-M1）：把文本中 `scheme://user:pass@host` 形态 URL 的 userinfo 段替换为
/// `***@`——reqwest 错误 Display 可能原样回显带凭据的代理/目标 URL（如 `user:pass@` 的
/// WebDAV serverUrl、socks5 代理），插入错误消息前剥掉凭据；保留 scheme/host/端口等结构
/// 信息便于排障。userinfo 取 authority 内最后一个 `@` 之前整段（WHATWG 语义）；
/// 非 URL 形态（"://" 前无合法 scheme 字符）的片段原样保留。
fn redact_userinfo(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(idx) = rest.find("://") {
        let prefix = &rest[..idx];
        // scheme：向前取连续 [A-Za-z0-9+.-]（均 ASCII，字符数=字节数），且以字母开头
        let scheme_len = prefix
            .chars()
            .rev()
            .take_while(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
            .count();
        let starts_alpha = scheme_len > 0
            && prefix
                .get(prefix.len() - scheme_len..)
                .and_then(|s| s.chars().next())
                .is_some_and(|c| c.is_ascii_alphabetic());
        if !starts_alpha {
            // 非 URL 语义：保留至 "://" 后继续扫描（每轮至少推进 3 字节，无死循环）
            out.push_str(&rest[..idx + 3]);
            rest = &rest[idx + 3..];
            continue;
        }
        out.push_str(&rest[..idx + 3]);
        let after = &rest[idx + 3..];
        let authority_end = after.find(['/', '?', '#']).unwrap_or(after.len());
        let authority = &after[..authority_end];
        if let Some(at) = authority.rfind('@') {
            out.push_str("***");
            out.push_str(&authority[at..]);
        } else {
            out.push_str(authority);
        }
        // authority 止于分界符：其后段交给下轮/收尾扫描（不在此重复入 out）
        rest = &after[authority_end..];
    }
    out.push_str(rest);
    out
}

/// rustls-no-provider 要求进程级安装 CryptoProvider（幂等；已安装则忽略）。
/// 选 ring（预生成汇编，无 cmake/NASM 构建负担）而非 rustls 默认的 aws-lc-rs
fn ensure_tls_provider() {
    let _ = rustls::crypto::ring::default_provider().install_default();
}

fn client_for(proxy: Option<&CloudProxyCfg>) -> Result<reqwest::Client, String> {
    ensure_tls_provider();
    let (key, builder) = match proxy {
        Some(p) if p.mode == "custom" => {
            let url = p
                .url
                .as_deref()
                .ok_or_else(|| "cloud_http_fetch: custom 代理缺 url".to_string())?;
            let pg = reqwest::Proxy::all(url)
                .map_err(|e| format!("代理地址无效：{}", redact_userinfo(&e.to_string())))?;
            (
                format!("custom:{url}"),
                reqwest::Client::builder().proxy(pg),
            )
        }
        // system=宿主环境默认（reqwest 读 HTTP_PROXY/HTTPS_PROXY/ALL_PROXY）；none=显式直连
        Some(p) if p.mode == "system" => ("system".to_string(), reqwest::Client::builder()),
        _ => ("none".to_string(), reqwest::Client::builder().no_proxy()),
    };
    let mut guard = CLIENTS
        .lock()
        .map_err(|_| "client cache poisoned".to_string())?;
    if let Some(c) = guard.get_or_insert_with(HashMap::new).get(&key) {
        return Ok(c.clone());
    }
    let c = builder
        .build()
        .map_err(|e| format!("HTTP client 构建失败：{e}"))?;
    guard
        .get_or_insert_with(HashMap::new)
        .insert(key, c.clone());
    Ok(c)
}

/// 云备份 HTTP 出网（桌面注入 cloudFetch 的实现载体）：入参/出参均 base64，二进制安全
#[tauri::command]
pub async fn cloud_http_fetch(req: CloudHttpReq) -> Result<CloudHttpResp, String> {
    let client = client_for(req.proxy.as_ref())?;
    let method = reqwest::Method::from_bytes(req.method.as_bytes())
        .map_err(|e| format!("非法 HTTP 方法：{e}"))?;
    let mut rb = client
        .request(method, &req.url)
        .timeout(Duration::from_millis(
            req.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS),
        ));
    for (k, v) in &req.headers {
        rb = rb.header(k, v);
    }
    if let Some(b) = &req.body_b64 {
        let bytes = B64
            .decode(b)
            .map_err(|e| format!("请求体 base64 解码失败：{e}"))?;
        rb = rb.body(bytes);
    }
    // send/bytes 错误 Display 可能含目标 URL（reqwest "for url (...)" 形态）：serverUrl 带
    // userinfo 时同样回显凭据，插入消息前统一脱敏（云-M1 同源防御，不止代理 URL）
    let resp = rb
        .send()
        .await
        .map_err(|e| format!("网络请求失败：{}", redact_userinfo(&e.to_string())))?;
    let status = resp.status().as_u16();
    let mut headers = HashMap::new();
    for (k, v) in resp.headers() {
        if let Ok(vv) = v.to_str() {
            headers.insert(k.as_str().to_string(), vv.to_string());
        }
    }
    let body = resp
        .bytes()
        .await
        .map_err(|e| format!("读取响应失败：{}", redact_userinfo(&e.to_string())))?;
    Ok(CloudHttpResp {
        status,
        headers,
        body_b64: if body.is_empty() {
            None
        } else {
            Some(B64.encode(&body))
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    #[test]
    fn redact_userinfo_strips_credentials_keeps_structure() {
        // 代理/目标 URL 带凭据：userinfo 整段替换为 ***@，scheme/host/端口保留
        assert_eq!(
            redact_userinfo("代理地址无效：socks5://user:pass@127.0.0.1:1080"),
            "代理地址无效：socks5://***@127.0.0.1:1080"
        );
        assert_eq!(
            redact_userinfo("http://alice:secret@dav.example.com/dav/x"),
            "http://***@dav.example.com/dav/x"
        );
        assert_eq!(redact_userinfo("socks5h://u:p@host"), "socks5h://***@host");
        // 无 userinfo 原样保留（含 authority 止于 path/query/fragment 的分界）
        assert_eq!(
            redact_userinfo("http://dav.example.com:5005"),
            "http://dav.example.com:5005"
        );
        assert_eq!(
            redact_userinfo("https://h.example/p?a=b#frag:x@y"),
            "https://h.example/p?a=b#frag:x@y"
        );
        // authority 内多个 @：最后一个 @ 之前全为 userinfo（WHATWG 语义）
        assert_eq!(redact_userinfo("http://a@b:secret@host"), "http://***@host");
        // 非 URL 文本与空串不误伤
        assert_eq!(
            redact_userinfo("plain text ::// not-a-url"),
            "plain text ::// not-a-url"
        );
        assert_eq!(redact_userinfo(""), "");
    }

    #[test]
    fn client_for_caches_by_proxy_key_and_rejects_custom_without_url() {
        let a = client_for(None).unwrap();
        // 同键再次取用命中缓存（reqwest 0.13 Client 非 Arc 别名，指针比较不可用——
        // brief 预案：以缓存表内容断言替代 ptr eq，仅保留缓存写入与错误分支断言）
        let b = client_for(Some(&CloudProxyCfg {
            mode: "none".into(),
            url: None,
        }))
        .unwrap();
        let _ = (a, b);
        assert!(CLIENTS
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .contains_key("none"));
        assert!(client_for(Some(&CloudProxyCfg {
            mode: "custom".into(),
            url: None
        }))
        .is_err());
        assert!(client_for(Some(&CloudProxyCfg {
            mode: "custom".into(),
            url: Some(":::".into())
        }))
        .is_err());
    }

    #[tokio::test]
    async fn fetch_roundtrip_local_loopback() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            let mut buf = [0u8; 4096];
            let _ = s.read(&mut buf);
            s.write_all(
                b"HTTP/1.1 201 Made\r\nContent-Type: text/plain\r\nContent-Length: 5\r\n\r\nhello",
            )
            .unwrap();
        });
        let resp = cloud_http_fetch(CloudHttpReq {
            url: format!("http://{addr}/x"),
            method: "PUT".into(),
            headers: [("x-a".to_string(), "b".to_string())].into_iter().collect(),
            body_b64: Some(B64.encode([1u8, 2])),
            proxy: Some(CloudProxyCfg {
                mode: "none".into(),
                url: None,
            }),
            timeout_ms: Some(5000),
        })
        .await
        .unwrap();
        server.join().unwrap();
        assert_eq!(resp.status, 201);
        assert_eq!(
            resp.headers.get("content-type").map(String::as_str),
            Some("text/plain")
        );
        assert_eq!(
            B64.decode(resp.body_b64.unwrap()).unwrap(),
            vec![104u8, 101, 108, 108, 111]
        );
    }
}
