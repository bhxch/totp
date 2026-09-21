//! 无头 MCP 启动参数解析（验收条目13）。仅三个参数，解析失败返回 Err（run 里 stderr+exit(2)）。

#[derive(Debug, Default, PartialEq, Eq)]
pub struct CliOpts {
    pub headless_mcp: bool,
    pub mcp_port: Option<u16>,
    pub mcp_token: Option<String>,
}

pub fn parse_args(args: &[String]) -> Result<CliOpts, String> {
    let mut opts = CliOpts::default();
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--headless-mcp" => opts.headless_mcp = true,
            "--mcp-port" => {
                i += 1;
                let v = args.get(i).ok_or("--mcp-port 缺少值")?;
                let p: u16 = v.parse().map_err(|_| format!("--mcp-port 非法: {v}"))?;
                if p < 1024 {
                    return Err(format!("--mcp-port {p} 不在允许范围 1024-65535"));
                }
                opts.mcp_port = Some(p);
            }
            "--mcp-token" => {
                i += 1;
                let v = args.get(i).ok_or("--mcp-token 缺少值")?;
                if v.len() < 16 {
                    return Err("--mcp-token 过短（至少 16 字符）".into());
                }
                opts.mcp_token = Some(v.clone());
            }
            other => return Err(format!("未知参数: {other}")),
        }
        i += 1;
    }
    if !opts.headless_mcp && (opts.mcp_port.is_some() || opts.mcp_token.is_some()) {
        return Err("--mcp-port/--mcp-token 仅在 --headless-mcp 下有效".into());
    }
    Ok(opts)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn default_empty() {
        assert_eq!(parse_args(&[]).unwrap(), CliOpts::default());
    }

    #[test]
    fn headless_only() {
        assert!(parse_args(&s(&["--headless-mcp"])).unwrap().headless_mcp);
    }

    #[test]
    fn port_and_token() {
        let o = parse_args(&s(&[
            "--headless-mcp",
            "--mcp-port",
            "47216",
            "--mcp-token",
            "0123456789abcdef",
        ]))
        .unwrap();
        assert_eq!(o.mcp_port, Some(47216));
        assert_eq!(o.mcp_token.as_deref(), Some("0123456789abcdef"));
    }

    #[test]
    fn rejects_low_port_and_short_token_and_unknown() {
        assert!(parse_args(&s(&["--headless-mcp", "--mcp-port", "80"])).is_err());
        assert!(parse_args(&s(&["--headless-mcp", "--mcp-token", "short"])).is_err());
        assert!(parse_args(&s(&["--verbose"])).is_err());
        assert!(parse_args(&s(&["--mcp-port", "47216"])).is_err()); // 缺 headless
        assert!(parse_args(&s(&["--mcp-port"])).is_err()); // 缺值
    }
}
