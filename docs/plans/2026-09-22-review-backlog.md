# 六 spec 审查遗留 backlog(2026-09-22)

来源:2026-09-22 对 9 月 21 日六 spec 全量代码审查(范围 `410238c..91f3f9d`)与 e2e/真机验证。
已修复项见 `docs/review/2026-09-22-six-specs-review-and-verification.md`,本文只归档**未修**项。

## 产品决策类(需用户裁定)

| # | 项 | 说明 | 来源 |
|---|---|---|---|
| B1 | ~~firefox gecko id 占位符~~ | **已解决（2026-09-23 批⑧）**：定稿 `totp@bhxch.github.io` + `strict_min_version: 140.0`，CI「Assert MV3 artifacts」步断言（[裁定与勘误记录](../review/2026-09-24-full-audit-fixes.md)） | CI 审查 I2 |
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

# 外部终审批次 triage(2026-09-23,范围 2fbff55..ec7cfc5,修复 431d7f1..a106d39)

来源:对同步体验优化+MCP 触发器两批次(44 commit)的独立外部审查(1 Critical/4 Important/10 Minor)。
**全部发现已当批处置完毕,无新增遗留**;修复与裁定留档如下。

## 已修复(7 commit)

| 发现 | 修复 | commit |
|---|---|---|
| C1 合并确认无超时,trigger_sync 页面外触发可静默卡死桌面云同步链 | requestMergeConfirm 60s 超时 fail-closed(与 action 工具确认同口径);槽位改 shallowRef(深度代理使清槽比较恒 false) | 431d7f1 |
| I2 keep 源推送读侧恒落空新路径,合并不可达,last-writer-wins | core 编排增 readPath(读最新份/写新份分离),双设备 keep 并发集成测试钉死(场景4);listBackups 失败按 null 首推走逐源隔离 | 4fc59c4 |
| I3 ours=null 点「取本地方」复活 base 而非确认删除 | 去 ??base fallback,pick 侧 null=确认删除,两侧对称 | 8e2d385 |
| I5 primaryRev 只写不读死字段(spec §2 与实现偏离) | 字段删除,spec 勘误回写真实机制(replica 自身 state 承担) | 4fc59c4 |
| M10 mergeVaults JSON.stringify 键序敏感误判双方改 | 改 canonicalJson(键序无关) | a29b095 |
| M11 OAuth 刷新非 200 一律 401 语义,5xx 误判凭据失效 | 4xx 保持 401,5xx 抛普通错误(不暂停自动跟随) | a43dec6 |
| M12 备份 single-flight 只覆盖 runBackupNow,调度轮可并发 | 提升为通道级链(调度轮+trigger 轮共用) | 6ab1025 |
| M13 冲突 badge 依赖下轮对账清除滞后 | store opts onConflictCountChanged 桥,裁决成功直清 | 8e2d385 |
| S2 runTargets 抛错 spinner 滞留 | 轮末进度改 finally 发 | 4fc59c4 |
| S3 CloudCard 缺 mergedDegraded 文案 | 复用 cloudRunner.action.mergedDegraded 同键 | a106d39 |
| S6 cloudRunner.noChange 死键 | zh/en 删除 | a106d39 |

## 裁定/spec 回写(docs commit,本文档同批)

- **I4 信封 v3 对旧客户端硬不兼容**:裁定不做混合机群过渡——开发阶段无存量用户,桌面与扩展
  同版本发布、两端同步升级;spec §1.4 勘误回写(含「v2 同内容信封零写不升级 v3」精化:
  该分支存在意义即消除冗余云写,内容分叉轮才升级,安全自限)。
- spec 勘误 7 处:§1.2(SourceSyncState 实形态+内容门宿主级单键)、§1.3(keep 源 readPath
  读写分离语义)、§1.4(见上)、§2(primaryRev 删除+replica 两方合并)、§3(pick 侧 null=确认
  删除)、§6.2(5s/60s 双通道并存+挂起征询超时约束推广)、验收口径 3(动作文案映射)。

# 覆盖率全面提升批次 backlog(2026-09-26,范围 5d6b83d..HEAD)

来源:2026-09-25 覆盖率方案(P0-P6,docs/plans/2026-09-25-coverage-design.md)实施期间的补测
锚定与审查发现。补测把若干**现状缺陷**按现状写进了断言(锚定),这些行为修复需连同锚定断言
一起改,故单独归档。B10/B11 建议下批优先(影响用户可感知行为);B12-B17 为一致性/卫生类;
B18/B19 为测试基建与稳健性。

## 行为缺陷类(修复需同步改锚定断言)

| # | 项 | 说明 | 建议 | 出处 |
|---|---|---|---|---|
| B10 | 远端 sync:settings 坏 JSON 原样写入本端 | mergeRemoteSettingsKeepingLocalSyncEnabled 的 catch 把解析失败的 remoteRaw 原串返回,上游整体采用写盘——本端 settings 被坏串替换。正确语义应放弃 merge、保留本端。现状已被测试按现状锚定(syncEngine.test.ts:542,断言 :556) | 修 catch 分支返回本端原串(读失败时才退化采用远端),改锚定断言;行为变更属用户可感知,建议下批优先 | apps/extension/src/syncEngine.ts:94-106 |
| B11 | popup onSave type 变更路径表单 period 被静默重置 | `period: carried?.period ?? 30` 在 carried 失效(type 变更)时恒落 30,覆盖表单提交值(编辑同路径同样受害);digits 已改用 `?? toOtpDigits(...)` 收口,period 漏改 | 一行修复 `?? data.period ?? 30` + 同步改两处锚定断言(popupApp.test.ts:837 同 type 恒 30 处、:856 type 变更现状锚定处) | apps/extension/entrypoints/popup/App.vue:298 |

## 一致性/卫生类

| # | 项 | 说明 | 建议 | 出处 |
|---|---|---|---|---|
| B12 | core export droppedTagCount 恒 0 | AegisExportReport.droppedTagCount 仅初始化为 0,无任何递增点(Aegis 导出 tag 全保真,本就无丢弃),BackupCard「已导出,N 个多余标签未导出」提示分支不可达(死分支) | 二选一:删死字段+UI 分支;或确需统计时补递增点 | packages/core/src/export/aegisVault.ts:19,75,100;packages/ui/src/components/BackupCard.vue:190-194 |
| B13 | MdSwitch 失败回滚视觉脱钩 | onChange 先改内部 checked 再 emit,父层拒绝/回滚(modelValue 未变)时开关视觉停留在新态,与真实状态脱钩;watch 只兜 modelValue 外部变更 | 受控化小改:视觉纯由 props.modelValue 派生(:checked 直接绑定),change 只 emit 不落内部态 | packages/ui/src/components/md/MdSwitch.vue |
| B14 | offscreen ack 同步 try/catch 包异步 sendMessage | `try { sendMessage({type:'clear-clipboard-ack'}) } catch {}` 捕获不到 promise rejection,MV3 SW 未就绪时 unhandled rejection | 改 `void ext!.runtime.sendMessage(...).catch(() => {})` | apps/extension/entrypoints/offscreen/offscreen.ts:26-28 |
| B15 | clearClipboardWithRetry 外层 catch 死防御 | ensureOffscreenDocument 内层已吞一切(含 ext.offscreen 缺失的同步 TypeError),外层 `try/catch { return }` 永不可达 | 删外层 try/catch,或令内层真抛(把「已存在」判定收敛到调用方) | apps/extension/entrypoints/background.ts:21-31,41-45 |
| B16 | ReleasePolicyConfig derive(Deserialize) 死代码 | 解析全手工 camelCase(from_settings_text 逐字段 get),derive 的 serde 通道(snake_case)与文件格式双轨且无调用方;serde default 属性同属死通道 | 删 derive 与 serde 属性(口径唯一),或改 rename_all+from_str 真用 derive(二选一,倾向删) | apps/desktop/src-tauri/src/release_policy.rs:5-19 |
| B17 | 释放策略默认值双轨维护 | serde default fns(5/30)与 Default impl(5/30)两处同值手工维护,改默认值要改两处 | Default impl 改调 default_pause_minutes()/default_destroy_minutes() | apps/desktop/src-tauri/src/release_policy.rs:23-30,33-42 |

## 测试基建/稳健性类

| # | 项 | 说明 | 建议 | 出处 |
|---|---|---|---|---|
| B18 | ui 测试 platform fake 重复 9 份 | `function makePlatform(over)` 在 BackupCard/backupCard.sources/backupCard.profile/CloudCard/cloudCard.sources/cloudCard.plaintextHttp/SecurityCard/securityCard.plan16/SecurityPage 九个测试文件各自手写 | 提取 test/helpers/fakes.ts 统一工厂(desktop 侧 apps/desktop/test/mocks/tauri.ts 已有先例) | packages/ui/test/*(makePlatform 定义 9 处) |
| B19 | ~~Rust 测试稳健性三处~~ | **已修复（2026-09-26 杂项清理，commit 25fc89b）**：① bridge_call 前端 drop 测试 emit 等待 loop 无上界 → 包 2s timeout（回归时失败而非挂起）；② devtools env 哨兵测试 panic 泄 env → EnvGuard(Drop) 恢复现场；③ start_server_with 冗余 cfg.clone() / start_server_inner 双克隆 → 收敛为一（闭包按值持有属任务存活期所需） | 原出处：apps/desktop/src-tauri/src/mcp_server.rs:1637-1642,1205,1239-1240;apps/desktop/src-tauri/src/lib.rs:2330-2360 |
| B20 | ~~autoBackup「store 未就绪→isLocked 兜底」负载型 flaky~~ | **已修复（2026-09-26，commit 6f50fa0）**：runBackup 链上的 crypto.subtle.digest 走 libuv 线程池、真实耗时不定，旧 advanceUntil 固定 20 步（≈10ms）轮询在 CI 负载下于链收敛前放弃（CI run 36224456089 实证 recordAutoStatus 0 调用）；改 fireDebounceAndWait——advanceTimersByTimeAsync(10_000) 精确跨防抖窗 + vi.waitFor（安全真实 timer 轮询、每步推进 fake 时钟，断言即等待条件），同悬崖 3 处一并收口；desktop 全量 5 连绿（与 Rust 覆盖率编译并发负载下） | 原出处：apps/desktop/src/autoBackup.test.ts（createDesktopAutoChannels describe 三处 advanceUntil） |
| B21 | core 与 ui 并发时 core 2 例偶败 | 最终审查实测一次：多包并发负载下 core 2 用例各偶败一次（单包复跑全绿，负载型，未捕获用例名）；与既有观察「desktop mcpBridge.test.ts 全仓并发偶发」同类 | 独立排查确定性化（fake timer 收口/隔离共享时间源）；复现手法：根 pnpm test 多包并发或 CI 口径（coverage+4 核 runner），参照 B20 手法收口 | 复现条件：根 pnpm run test / test:coverage 并发负载 |
