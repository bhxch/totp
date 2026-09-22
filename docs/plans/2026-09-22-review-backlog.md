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

# 同步体验优化批次 backlog(2026-09-22,SDD 终审 triage,范围 a6867e2..fcc6ce9)

来源:同步体验优化+MCP 工具面 spec(docs/superpowers/specs/2026-09-22-sync-ux-mcp-tools-design.md)实施终审。30 commit 全部合入 main,以下为终审 triage 放行的留档项。

## 功能增强/清理类

| # | 项 | 说明 | 来源 |
|---|---|---|---|
| S1 | merged 轮零冲突副本契约 | 双设备真实并发窗口的 merged 轮即使零条目冲突也产「冲突副本」(T7 安全序契约:先存副本再覆盖);终审裁定维持(修 contentHashVault 后噪声已收敛);若产品期望零冲突不产副本需改 core syncOrchestrator 契约 | 终审+T13 |
| S2 | 进度失败滞留 | runTargets 抛错(如 no primary target)跳过 onProgress(total,total),spinner 滞留至下一成功轮;try/finally 可修 | 终审 Minor |
| S3 | CloudCard 缺 mergedDegraded 专用文案 | 降级合并时卡内显示「已合并」与 runner 摘要「降级合并」不一致;状态行 ACTION_LABEL_KEY 补分支即可 | 终审 Minor |
| S4 | pullAll 全源失败仍 recordStatus(true) | 「部分失败=ok true」惯例边角,cosmetic | 终审 Minor |
| S5 | 测试 fixture 旧口径 hash | cloudSync/multiTarget/twoDevice/cloudRunner 测试 fixture 仍用旧 contentHash 构造信封 baseContentHash(fixture vault 无 rev 故同值全绿);统一为 contentHashVault 防未来 fixture 引入 rev 静默失配 | 终审修复波复审 |
| S6 | cloudRunner.noChange 死键 | auto 门命中改降级 pull 轮后「内容无变化」跳过态不再产生,zh/en 键无引用可删 | 终审修复波 |
| S7 | extension popup 冲突横幅 | spec §4 声明 popup/options 顶部横幅,options 已落地,popup 无冲突感知面 | T11 缺失项 |
| S8 | desktop 托盘 tooltip 冲突计数 | spec §4 声明,应用内横幅已落地,托盘计数未做 | T11 裁定 backlog |
| S9 | MS refresh_token 轮转撤销策略真机实测 | onedrive 轮转回存通道已实现(手动通道消费),MS /common 端点是否撤销旧 token 需真实租户实测;若撤销且自动通道未消费回存则 ≤1h 后凭据失效 | T12 |
| S10 | 禁用源角色分段静默 no-op | MdSegmentedButton 无 disabled 能力,禁用源行 role 切换可点但无效,需视觉禁用 | T11 Minor |
| S11 | vault.rev 与信封 sync.rev 同名异语义 | vault 顶层 rev(F8 存储水位)随上传进云端明文,与信封 sync.rev(逻辑时钟)并存有混淆风险(既有,非本轮引入) | 终审修复波观察 |

## 真机验证类(发布前)

- 双 desktop 真机:一端编辑→另一端闲置 auto 轮(15min)拉到变更(I-2 修复后 downloaded 可达,需真机确认)
- GDrive/OneDrive OAuth 模式真机:用户自建 client 全流程(401 自愈/轮转回存)
- 冲突裁决真机:两设备同条目分歧→badge/横幅→裁决→收敛

## 观察记录类(知悉)

- 旧口径 stored 值自愈:存量 cloudContentHash/baseSnapshot 升级后首轮多一次同步(保守路径),无迁移
- desktop mcpBridge.test.ts 全仓并发偶发(基线可复现,负载型),建议独立排查 vi.waitFor 确定化

# MCP 触发器工具批次 backlog(2026-09-22,SDD 终审 triage,范围 258bd15..8a33191)

来源:MCP 触发器工具与工具暴露面 spec §6 实施(9 commit)终审 READY TO MERGE,以下为留档项。

| # | 项 | 说明 | 来源 |
|---|---|---|---|
| M1 | needs_restart 显式断言 | 补「exposedTools 变更不触发重启」测试(实现上结构不可能触发,一行钉死不变量) | MCP 终审 |
| M2 | DEFAULT_EXPOSED_TOOLS 类型卫生 | `string[]` → `readonly string[]`(消费方无突变行为,纯类型卫生) | MCP 终审 |
| M3 | 两弹叠加 UX | once 批准的客户端在非 token 档调 action 工具连两弹(首连审批+工具确认)——终审裁定为既定行为(两独立维度,跳过任一削弱门控);真机验收时向用户演示确认 | MCP-B 审查 |

## 真机验证类(发布前)

- 非 token 档(wildcard)勾选 trigger_sync → MCP 调用 → 桌面弹「允许执行 trigger_sync?」→ Allow 返回 {triggered:true}/Deny 返回 denial 错误;token 档免确认直达
- 未勾选时 trigger_sync 返回 `tool disabled`;原两只读工具行为与升级前一致(存量 settings.json 兼容)
- 无头模式(--headless-mcp)非 token 档 action 调用 60s 后 fail-closed 拒绝
