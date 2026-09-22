# 六 spec 审查遗留 backlog(2026-09-22)

来源:2026-09-22 对 9 月 21 日六 spec 全量代码审查(范围 `410238c..91f3f9d`)与 e2e/真机验证。
已修复项见 `docs/review/2026-09-22-six-specs-review-and-verification.md`,本文只归档**未修**项。

## 产品决策类(需用户裁定)

| # | 项 | 说明 | 来源 |
|---|---|---|---|
| B1 | firefox gecko id 占位符 | `apps/extension/wxt.config.ts` 仍为 `totp-tools@example.local`;AMO 的 ID 一经上架不可更改,**首次正式发布前必须定稿**(发布阻断项,非代码缺陷) | CI 审查 I2 |
| B2 | foxauth 口令输入 UX | 口令以 Base64 存于备份文件 `encryptPassword`(可还原),用户输入口令仅做比对、不参与解密,有"伪安全"误导;后续可评估直接采用文件内口令免输入(对齐官方体验)。取消比对需同步补 GCM 层错误口令用例 | foxauth 审查 M-1 |

## 功能增强类

| # | 项 | 说明 | 来源 |
|---|---|---|---|
| B3 | 键盘揭示路径 | 验证码揭示(看码)仅鼠标双击可达,键盘/AT 用户可复制不可见;可给 OtpListItem 加 `Shift+Enter` 等键盘等价揭示 | UI 审查 M-2 |
| B4 | devtools envPreset 提示 | 外部已设 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` 时注入跳过,设置页仍显示已开启,用户无从得知为何 CDP 无响应;可给 `devtools_get_config` 附 envPreset 字段供 UI 提示 | 桌面审查 M4 |
| B5 | HOTP 双击双 copy | 双击序列=两次 copy,HOTP counter 静默 +2(plan 已裁定接受双 copy);根治可对 300ms 内同 uuid 重复 copy 跳过 counter 递增(剪贴板写保留)。注意 B5 与 2026-09-22 复制失败修复叠加后:失败路径已不推进 counter | UI 审查 M-1 |
| B6 | mini aria 死声明 | MiniApp 宿主未接 `@context` 却有 `aria-haspopup="menu"`(既有问题,非本轮引入) | UI 审查 M-4 |
| B7 | 冲突采纳 TOCTOU | runner 取快照→网络窗口→replaceAllOp 整体替换,窗口内本地写入既不在冲突副本也不在最终态(popup 刚开时点风险最高,desktop 同构);可 persistAdopted 前重读盘上 vault 做 diff 合并 | 同步审查 I3 |
| B8 | 跨上下文互斥 | popup/options 同时开时跟随无跨上下文互斥(plan 已显式接受);与 B7 叠加时副本概率上升 | 同步审查 M1 |
| B9 | cloudAutoStatus 语义 | 存在目标级失败(含 401)时 ok 仍记 true,「上次同步成功」与失败摘要并置,轻微误导 | 同步审查 M3 |

## 观察记录类(无需行动,知悉)

- **GDrive 403 同判**:`ensureHttpOk` 不读响应体,quota 403 与凭据失效 403 同判(会误停跟随并提示重新授权);core backend.ts 注释已声明边界,消息定界兜底已收紧。
- **headless 隐藏窗口设置页**显示盘上配置,与 CLI override 后实际监听的服务不一致(设计内);CSPRNG `expect` 在熵源故障时 panic 拦启动(设计内 fail-closed)。
- **icon 高频英文词 slug**(max/line/square/x 等)扩大精确撞名面——匹配是全等非子串,"GitHub Enterprise" 不误配,风险低。
- **Rust 门禁仅 Linux runner**,Windows 特有代码不被 clippy/cargo test 覆盖,靠每日 nightly 构建兜底。
- **tauri dev 参数透传**:`pnpm tauri dev -- --headless-mcp ...` 在本机 tauri-cli 下参数误喂给 cargo run;headless 请直接运行 `target/debug/totp-desktop.exe`(vite dev server 需存活),真机已验证。
- **e2e 冲突副本双事件**:CDP/Blob 插桩下一次冲突观测到 2 次下载事件;单测已钉 `saveConflictBackup` 调用次数=1(packages/ui/test/cloudRunner.test.ts:665),判插桩副作用非产品缺陷。
- **simple-icons 已 pin 16.31.0**,未来升级重跑生成脚本时 builtin.json 会按上游变化漂移,属预期。
