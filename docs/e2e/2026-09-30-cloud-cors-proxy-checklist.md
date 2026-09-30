# 2026-09-30 云备份 CORS 规避 / 每源代理 / 保留天数 真机验证清单

设计：`docs/plans/2026-09-30-cloud-http-cors-proxy-retention-design.md`；实现：core 注入（bd5fa61）→ provider 透传（dfc5575）→ Retention days（e3dc72d）→ 透传（8e54cd5）→ UI（7d792b2）→ 扩展代理（c1940fd）→ 桌面 command（982f332）。
执行记录按 `docs/e2e-test.md` §6 指南登记；并入批次 E 人工验证会话。

| # | 场景 | 预期 | 结果/证据 |
|---|---|---|---|
| 1 | 坚果云 WebDAV：扩展端配置并手动同步（原 CORS 报错场景） | 上传/下载/列目录成功（background 代理出网） | 待人工 |
| 2 | 坚果云 WebDAV：桌面端同源再验 | 同上（Rust reqwest 出网） | 待人工 |
| 3 | **自建 WebDAV/MinIO + 自签 CA 装入 Windows 证书库**：桌面端 HTTPS 上传/列/删 | TLS 信任成功（rustls platform-verifier 读系统证书库；本条为③T7 评审 Important——TLS 栈换 platform-verifier 后自托管场景的承重机制） | 待人工 |
| 4 | socks5h 代理：桌面端某源配 `socks5h://127.0.0.1:<本地代理端口>`（GDrive/OneDrive 源） | 上传/列/删经代理成功（本地代理日志佐证） | 待人工 |
| 5 | 「系统代理」档 vs「直连」档行为差异 | 可观测（Windows 下 system 档额外读系统代理设置，为 env 语义超集） | 待人工 |
| 6 | GDrive OAuth：access token 过期后自动刷新 | 刷新仍工作（token 端点已改走注入层） | 待人工 |
| 7 | 保留天数：云端 keep 源 n=1 days=7，存在超龄/未超龄旧份 | 仅「超 n 份且超 n 天」者被滚删；天数内旧份保留 | 待人工 |
| 8 | 保留天数：本地备份源同场景 | 同上（backupService 通道） | 待人工 |
| 9 | UI：扩展端云源卡代理区显示提示不渲染控件；桌面端三段可选+custom 出地址框 | 与裁定一致 | 待人工 |
| 10 | Firefox 构建全流程冒烟（MV3 event page 生命周期下的 background 代理） | 手动同步成功 | 待人工 |
