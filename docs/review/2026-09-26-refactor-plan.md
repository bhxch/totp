# TOTP 验证器 monorepo 结构重构方案(统合版 · 修订二)

> 统合人:方案统合人(资深架构师)。输入:8 名模块分析员 + 1 名跨模块查重员的 9 份结构分析报告;经独立评审员两轮评审,13 条意见全部处理(12 条采纳修订,核实通过记录确认,详见 §7 评审意见回应)。
> 本方案关键论断均经实读源码验证(方法见「0. 验证记录」);低风险 S 级条目未逐行复核,以分析员报告与评审员交叉核实为据并已标注。

---

## 0. 验证记录(两轮实际执行的核查)

**第一轮(统合前抽查,8 组)**:各 God file 行数(`rg -c '^'`:store.ts 989、CloudCard.vue 948、options App.vue 531、lib.rs 2400、mcp_server.rs 2719、winauth.ts 649 等,全部吻合);CloudCard 无 readPath 而 cloudRunner.ts:300 有(`rg -n readPath` + sed);迁移漂移(desktop `return 0` 不清孤儿键 vs extension 审查修复);revSeal/authFetch 逐字重复;contentHash 死 API;BACKEND_LABEL 4 份;uri.ts 分支散布;测试与 CI 基建(package.json scripts、四条 workflow)。

**第二轮(评审证据复核,13 条意见涉及的新声明逐条实读)**:

| 评审点 | 核查方法 | 结论 |
|---|---|---|
| R1 确认流语义差异 | `sed -n '330,342p' cloudRunner.ts`(apply 通道 `if (r.adopted) await deps.persistAdopted(...)`,注释「采纳先于基线回写」)+ `sed -n '462,467p'`/`'565,600p'` CloudCard.vue(注释「基线在『采用云端』确认成功后才写」、pendingStates 延后、pendingAdopt、onConfirmAdopt) | **属实**,采纳:R1 首选改为共享底座修复,整体复用降为远期可选 |
| R5 口令判定是内容函数 | `sed -n '30,40p' paste.ts`(aegis `sniffAegis(text)?.encrypted === true`、foxauth `sniffFoxauthEncrypted(text)`)+ `sed -n '510,552p' ImportCard.vue`(aegis 加密二态、totpAuthenticator 非 '[' 前缀、foxauth) | **属实**,采纳:needsPassword 定义为 `(text) => boolean` 谓词 |
| R16⑧ kekSources 语义差异 | `sed -n '30,42p' multiKek.ts`(withPrfSource 纯追加)vs `sed -n '265,295p' securityStore.ts`(addPrfSource others 过滤替换,注释「同 credentialId 已存在时替换」) | **属实**,采纳:R16⑧ 改两步走(先统一替换语义再收敛) |
| R15③ sha256Hex 第 4 处 | `rg -n "sha256Hex" winauth.ts s3.ts syncOrchestrator.ts` → winauth.ts:65 确认存在 | **属实**,采纳:计数改 4 处,R12 协调吸收 |
| R2 第 3 项差异(双缺失清 revs) | `sed -n '95,118p' cloudCredStore.ts`(104-110 删 CLOUD_REVS_KEY/CLOUD_REV_KEY,注释「审查修复」)vs `sed -n '108,120p' legacyMigrate.ts`(114-117 直接 return 0) | **属实**,采纳:三项差异全列,测试三项全补 |
| R16⑪ 无 IMPORT_ACCEPT 常量 | `rg -n "IMPORT_ACCEPT" apps/extension` 无输出;`sed -n '315,328p'` 两处内联字面量(顺序不同) | **属实**,采纳:表述改「两处内联字面量提常量」,与 R11 三端对齐 |
| R16③ 路由表路径 | `sed -n '1,14p' packages/ui/src/pages/routes.ts`(themeRoutes,:5-15) | **属实**,采纳:路径修正、files 补列 |
| R16① 截断形态不同 | `sed -n '3,24p' steam.ts`(u31+字符表取模)vs `sed -n '8,24p' hotp.ts`(padStart 十进制串) | **属实**,采纳:措辞修正,truncateU31 需新拆 |
| R11 写盘通道不同 | `sed -n '900,946p' lib.rs | rg write_text_atomic\|std::fs::write` → :906 write_text_atomic、:944 std::fs::write | **属实**,采纳:rationale 收敛为「守护骨架同构、写盘通道有意不同」 |
| R6 lock() 清理账目 | `sed -n '900,914p' store.ts`:4 条途径清 5 Map(dekByWin.set/lockedByWin.set/currentLockedRef().value/setSessionBackupSecret)+ 另清 bag/bagStoredRef 单例 | **属实**,采纳:表述修正 |
| R9 set 参数形态 | `sed -n '329,344p' lib.rs`:release_policy_set 为 4 个独立 invoke 参数(pause_minutes 等) | **属实**,采纳:改为「参数构造 struct → Serialize 写节」 |
| R3 popup 表单层决策 | `sed -n '273,290p' popup/App.vue`:`data.type !== editing.value.type ? (data.type === 'steam' ? 5 : 6) : ...` | **属实**,采纳:R3 交代表单层决策归属 |
| R4 overrides 差异点 | 评审列出 extension 独有 authError/badge 通道、desktop 独有 dpapi/unlockNaming/目录冲突副本 | **采纳(非阻塞建议)**:R4 增加差异点清单驱动的 overrides 最小化纪律 |

docs/ 历史审查记录(docs/review/、docs/e2e-test.md)仅作背景参考,结论以本次两轮分析为准。

---

## 1. 总体评价

这是一个**分层纪律明显高于平均水准**的 monorepo:core 为纯领域层,ui 承载共享 Vue3 组件与唯一 `createVueStore`,两端只剩宿主胶水;平台差异统一走 Platform 接口注入,依赖方向总体单向;文件普遍带「为什么」注释与审查编号回写,测试覆盖密(desktop 测试约 4038 行,几乎每模块同名 .test.ts)。

真实债务集中在四类:

1. **两处已发生的行为分叉(最优先)**:①CloudCard 手动同步通道缺 readPath,keep 源永远读不到远端最新份,且绕过 single-flight;②legacy 迁移逻辑两端各一份且 extension 版带三项审查修复、desktop 版一项都没有——同一旧盘数据在两端迁移产出不同结果。这两项是缺陷,不是纯重构。
2. **装配胶水在两端成片复制**:revSeal、云 runner 装配、SecurityPlatform/CloudPlatform 字面量、调度器装配、偏好归一化等 5 组以上平行实现,根因是 options App.vue 把组合根内联进了组件。
3. **五个 God file**:ui/store.ts(989)、ui/CloudCard.vue(948)、extension options App.vue(531)、Rust lib.rs(2400)、(次级)Rust mcp_server.rs(2719)。
4. **扩展轴上的散弹式修改**:OTP 类型知识散落 4 文件 14 处;导入格式清单散落 5+ 处;新增云后端要改 6 处。

同时须牢记两通道/两端之间**有意的语义差异**,它们是设计而非债务,重构不得抹平:云同步自动轮「立即采纳落盘」vs 手动通道「两步确认后采纳」(R1);winauth 口令通道的「格式静态属性」实际是「文本内容函数」(R5);Rust 文件命令 text/bytes 的写盘通道差异(原子写 vs 直写,R11);from_settings_text 的逐字段回退语义 serde 无法等价替代(R9)。

查重员核实的**非重复项**(请勿误伤):extension/qrDecode.ts 是 ui 的薄封装;desktop backupService/autoBackup 对 core backup 复用充分;extension 版 store.ts 只是装配胶水;md/ 对话框全部复用 MdDialog;desktop idleLock 与 extension lockEnforcer 判定源不同(核心判定已在 core),不算重复。

**优先级总原则**:先修行为分叉(R1/R2)→ 再做低风险高杠杆的 core 单点化(R3/R12/R15)→ 装配下沉与大文件拆分(R4-R8)→ 收尾清理(R9-R16)。全程警惕过度设计:凡「注册表化后模板联合类型不窄化反而更复杂」「分支有真实差异」「overrides 宽于字面量本身」「内聚性尚可仅浏览性收益」的条目,一律剔除、收窄或降为可选(见 §6)。

---

## 2. 各模块结构简评

- **packages/core(领域层)**:encoding→otp→model/vault 分层清晰,文件 ≤200 行,注释质量高。压力点:OTP 类型扩展轴(uri/normalize/entryCode/model 四文件十余分支)、vault.ts:2 反向依赖 import/、HMAC 原语 hotp/steam 两处各写一遍(截断产出形态本就不同,只统一 hmac 与 u31 底层)。
- **packages/core backup+cloud**:CloudBackend 接口统一五后端,rev 逻辑时钟编排清晰。张力:backup↔cloud 目录级互依赖环(retention.ts:3 vs cloud 五文件)、遗留口径 API(contentHash、loadSourceRevs)无降级标注、authFetch/sha256Hex(全仓 4 处定义)/basenameOf 三组逐字重复。
- **packages/core import+security+storage+merge**:「每格式一文件」纪律好,错误契约统一。债务:格式知识分裂为 5+ 份并行表(core 与 ui 各持);口令通道判定是内容函数却在两端各写一份;normalize 的 M10 收敛未约束后加入者(sqlite/jsonApps/winauth 残留逐字副本);winauth.ts 649 行混装密码原语与格式逻辑;kekSources 编辑分散两文件且追加/替换语义不一。
- **packages/ui components**:md/ 原语与 Platform 端口依赖倒置清晰,卡片经 platform prop 注入。两张大卡是热点:CloudCard.vue 948 行 God file 且与 cloudRunner 双实现分叉(但两通道的采纳确认语义差异须保留);六张卡各自复制 busy/msg/autoPrefs/retention 基建。
- **packages/ui pages+state**:页面普遍薄,纯函数下沉良好。唯一热点 store.ts 989 行单工厂聚合 ≥6 职责;5 个按窗口平行 Map(lock() 需 4 条途径清理)、4 个 KEK op 重复安全写协议。
- **apps/extension**:入口→src→包分层清晰,cloudRunnerFactory 是装配外移的成功先例。债务:options App.vue 505 行内联全部装配(组合根+页面编排双职责);popup/options 装配复制;BACKEND_LABEL 冗余;导入 accept 字面量两处内联。
- **apps/desktop TS 侧**:23 文件约 2700 行、测试约 4038 行,desktopShell(360 行)属装配根尚可。债务:backupService 双目录通道 5 处手写分支且过滤口径已漂移;装配样板(就绪断言 9 处、偏好读写、MiniApp 引导)逐字复制。
- **apps/desktop Rust 侧**:cli/lock_events/release_policy 已成功抽出且职责单一。lib.rs 2400 行是最大失衡点(6 个子系统同居);settings.json 四组共写文件的读写外壳重复 3+4 份、ReleasePolicy 契约 5 份手工映射;文件命令守护链 5 处同骨架(写盘通道有意不同)。
- **跨模块**:两端宿主胶水与留在端上的纯逻辑(迁移、命名、偏好归一)形成 ≥5 组平行实现,迁移与 keep 读取路径已实际漂移——是本方案最高优先级的来源。

---

## 3. 重构项详单(按优先级升序,P1 最高)

### R1(P1)修复云同步手动通道行为分叉:共享 inputs 组装(补 readPath)与结果归纳

- **问题**:CloudCard.vue:493 的 onSync 组装 inputs 仅设 path(keep 源为 resolveTimestampPath),**无 readPath**;runner 通道 cloudRunner.ts:300 为 keep 源设 `readPath = latestKeepPath(backend)`。core 语义(multiTarget.ts:55-61)明确 keep 滚动保留源须「读最新份(readPath)、写新时间戳份(path)」分离。后果:手动通道**永远收不到 keep 源远端最新份**;且直调不经 single-flight 链(cloudRunner.ts:457-466),可与 auto 轮并发。文案表与 merged 降级分支已双份漂移。**同时注意两通道有一处有意语义差异**:runner apply 通道立即 `persistAdopted` 落盘、采纳先于基线回写(cloudRunner.ts:336-339);CloudCard 手动通道是「两步确认后才整体替换+落基线」(CloudCard.vue:462-466、:567-569、:587-589、:598-599)——人工确认流,不是债务。
- **方案**:**首选(本项范围)**——把真正同构的部分提为共享:①inputs 组装(backend 工厂+path+**readPath**+state,CloudCard.vue:478-496 对照 cloudRunner.ts:292-309)使手动通道补上 readPath;②结果归纳(状态文案/keep 清理/基线回写/宿主通知),文案表合并一份;③手动直调接入 single-flight 链。**远期可选(不在本项内)**——整体复用 runner:须先论证确认流等价性(给 runner 增加「采纳确认挂起」能力属复杂化,改变「下载需确认」语义属行为变更),未经论证不做。模式:同构路径合并,不动确认流语义。
- **涉及文件**:packages/ui/src/components/CloudCard.vue、cloudRunner.ts、cloudSyncShared.ts(新)、cloudSyncBridge.ts;apps/desktop/src/App.vue;apps/extension/src/cloudRunnerFactory.ts。
- **风险**:medium(同步主链路,须双端真机验证;但行为变更面比整体复用小) | **工作量**:M

### R2(P2)legacy 云多目标迁移下沉 core,消除两端迁移漂移(三项差异全并)

- **问题**:legacyMigrate.ts:104-167(desktop)与 cloudCredStore.ts:90-189(extension)互指「同构」,解析函数逐字一致,但 extension 版含**三项**审查修复而 desktop 没有:①cloudCreds/cloudCred 双缺失出口,extension 清 revs 孤儿键(cloudCredStore.ts:104-110),desktop 直接 return 0(legacyMigrate.ts:114-117);②合法空配置 '[]' 出口,extension 删孤儿键收敛(cloudCredStore.ts:118-126),desktop 同样直接 return 0(:122);③targets 按 backend 去重(cloudCredStore.ts:130-137),desktop 仅与 existing 去重(legacyMigrate.ts:134)——**同一旧盘数据两端迁移产出不同结果**。
- **方案**:整体下沉 packages/core(两实现仅依赖 StorageAdapter + 注入 saveCred,无平台 API),以 extension 版语义为准(三项修复全保留),两端各留一行调用;migration.e2e.test.ts 为锚点,**三项差异各补一用例**(漏①则同一种中断形态在两端仍不收敛)。
- **涉及文件**:packages/core/src/backup/legacyCloudMigrate.ts(新)、index.ts、test/migration.e2e.test.ts;apps/desktop/src/legacyMigrate.ts;apps/extension/src/cloudCredStore.ts。
- **风险**:medium(迁移正确性) | **工作量**:M

### R3(P3)core 建 OTP 类型注册表,收口类型知识并消除 vault→import 反向依赖

- **问题**:OTP 类型特化知识散落 4 文件十余处平行分支(uri.ts:5/:36/:60/:63-68/:71/:82/:111-114、entryCode.ts:27-38、import/normalize.ts:21-27/42-46),新增类型需同步 ≥4 文件约 14 处。vault.ts:2 反向依赖 import/normalize 取 toOtpDigits(vault.ts:72),digits 收口外推给 UI 调用点:其中 4 处为幂等收口(CodesPage.vue:140,149、clipboardImport.ts:93、otpauthFlow.ts:23)可安全移除;popup App.vue:276-284 混有**表单层默认值决策**(type 变更时重算 steam→5/其余 6),须区别处置。
- **方案**:新建 otp/typeProfiles.ts:`Record<EntryType, TypeProfile>` 描述符 `{ hostAliases, defaultAlgorithm, forcedDigits, supportsPin, compute, buildUriDefaults }`(注册表+策略模式)。uri/entryCode/normalize 查表;toOtpDigits 上移为 descriptor.forcedDigits,消除 vault→import 边;addEntry/newEntryFromUri 边界统一收口强制值,4 个幂等调用点前置调用移除。**popup 表单层决策归属**:「编辑态切换 type 时重算表单默认 digits」保留在表单层,但默认值来源改查 typeProfile(导出 defaultDigitsFor(type)),表单层不再自写类型分支。新增类型=加一个 descriptor,core 测试全覆盖。
- **涉及文件**:packages/core/src/otp/typeProfiles.ts(新)、uri.ts、model.ts、entryCode.ts;import/normalize.ts;vault.ts;packages/ui/src/pages/CodesPage.vue、clipboardImport.ts、otpauthFlow.ts;apps/extension/entrypoints/popup/App.vue。
- **风险**:low | **工作量**:M

### R4(P4)两端宿主装配胶水下沉 packages/ui(overrides 面以差异点清单驱动)

- **问题**:五组平行装配:①revSeal 三份逐字;②云 runner 装配骨架约 40 行平行;③CloudPlatform 字面量两端各一份(9 个绑 store 成员同型);④SecurityPlatform 装配(passkey.add 逐字);⑤popup/options 调度器 7 依赖 6 同 + scheduleClipboardClear 逐字节。根因:options App.vue 组合根+页面编排双职责,script 505 行内联,测试只能 mount 整组件+40+ 字段 store mock。两端同时存在**真实差异点**:extension 独有 authError 包装→run reject(cloudRunnerFactory.ts:57-61/133-145)与 badge/横幅通道(114-120);desktop 独有 dpapi/unlockNaming(securityPlatform.ts:126-127)与目录冲突副本通道(cloudPlatforms.ts:102)。
- **方案**:packages/ui 新增宿主工厂层(src/host/):createRevSeal(store)、createSecurityOpsFromStore(store, overrides)、createStoreBackedCloudPlatform(store, adapter, overrides)、createCloudSyncRunnerForStore(store, adapter, overrides)、createFollowScheduler(store, { intervalMs, onAuthFailed })、downloadBlob(name, blob, revokeDelayMs?)。**overrides 最小化纪律**:每个工厂动手前先列「同型成员数 vs 注入差异数」——仅已核实差异(authError 包装、badge/横幅、dpapi/unlockNaming、冲突副本通道、存储通道)允许进 overrides;若 overrides 键数接近字面量成员数,该工厂不抽。options 装配抽 src/optionsPlatforms.ts(循 cloudRunnerFactory 先例),App.vue 留生命周期接线,装配可脱离组件单测。**依赖 R1 完成后启动**。
- **涉及文件**:packages/ui/src/host/(新);apps/desktop/src/cloudPlatforms.ts、securityPlatform.ts;apps/extension/src/cloudRunnerFactory.ts、optionsPlatforms.ts(新);entrypoints/options/App.vue、popup/App.vue;test/optionsApp.test.ts。
- **风险**:medium | **工作量**:L

### R5(P5)core 建导入格式单一注册表(口令通道为内容谓词)

- **问题**:新增一种导入格式需改 ≥5 处(types.ts:27-40 全集、sniff.ts:86-152 谓词+优先级 if 链、paste.ts:15-27 DISPATCH、ImportCard.vue:36+416-430+489-552)。「哪些输入走口令页」**不是格式静态属性而是文本内容函数**:aegis 明文解析/加密走口令两态(paste.ts:33-34 `sniffAegis(text)?.encrypted === true`;ImportCard.vue:511-515)、foxauth 走 sniffFoxauthEncrypted 内容判定(paste.ts:35-36;ImportCard.vue:546-551)、totpAuthenticator 非 '[' 开头走口令页(ImportCard.vue:539-544)。两端各写一份同构判定。
- **方案**:core 单一注册表:ImportFormat 全集 → 描述符 `{ sniff?, parse(async 统一签名), paste?, needsPassword?: (text) => boolean }`——**needsPassword 必须是内容谓词**(覆盖上述三种既有两态行为),静态布尔无法派生路由,禁用;或采用「入口默认 + 内容覆写」两级结构。paste.DISPATCH、UI TEXT_PARSERS、两端口令判定由注册表派生。嗅探优先级顺序是行为契约:现有覆盖散在 import.test/importApps/importMisc/importPaste 四文件、无专项顺序快照,**先补顺序快照测试再迁移**。**明确不做**:口令页交互本身表格化(分支差异真实存在)。
- **涉及文件**:packages/core/src/import/types.ts、registry.ts(新)、sniff.ts、paste.ts;packages/ui/src/components/ImportCard.vue。
- **风险**:medium | **工作量**:L

### R6(P6)ui store.ts 内部收敛后拆分子工厂

- **问题**:store.ts 989 行单工厂聚合 ≥6 职责(git 32 次提交,全包最高频变更点):①4 个 KEK op 逐行近同(765-812)重复安全写协议('vault locked' 守卫 13 次:store.ts:178,190,392,402,555,579,615,767,780,792,805,849,860;`!security.value` 16 次),commitSettings(471-483)另起第二套入队;②5 个按 windowId 平行 Map(53-61)承载同一「窗口会话」概念——lock()(store.ts:901-913)经 **4 条途径**清这 5 个 Map(dekByWin.set/lockedByWin.set/currentLockedRef().value/setSessionBackupSecret),并另清 bag/bagStoredRef 两个非 Map 单例,成对更新不变量完全靠纪律;③返回对象约 40 成员横跨全部职责。
- **方案**:三步可独立合入:①`mutateSecurityOp(transform)` 统一安全写协议,commitSettings 改走 enqueue;②5 Map 合并为 `Map<string, WindowSession>`,会话对象由工厂统一创建(ref 懒建内聚),lock() 清理账目从「4 条途径」收敛为「清一个会话对象」(bag/bagStoredRef 单例保持独立清理);③拆子工厂 createEncryptionSession/createSecretBagStore/createConflictLedger,createVueStore 只做组合,返回对象形状不变(宿主零改动)。先去重再组合,避免大爆炸。
- **涉及文件**:packages/ui/src/store.ts(可拆同包子模块)。
- **风险**:medium | **工作量**:L

### R7(P7)CloudCard.vue 瘦身:凭据字段子组件 + 确认模式 + 卡片基建 composable

- **问题**:948 行 God file:onSync 129 行六职责(468-596);挂起态三套同型 ask/cancel/confirm(157-167、627-684,模板 887-903);5 个同构守卫(230-244);gdrive/onedrive 模板逐字 14 行×2(808-835)。基建四件套在六张卡重复:fail()+三态消息 6 份、newSourceId 逐字 2 份、autoPrefs 三件套同构 2 份、onKeepN/RETENTION_OPTIONS 逐字 2 份。
- **方案**:依赖 R1、R4。①拆 CloudCredFields 子组件,gdrive/onedrive 模板合并为 isOAuthCapableDraft 一段(253-255 已有,token label 三元);②抽 confirmPattern 组合式函数;③抽 useAsyncMessage(范式 SecurityCard.vue:120-134)与 useAutoPrefs,常量收共享模块,六卡接入;顺带统一 CloudPlatform.autoPrefs{get,set} 与 BackupPlatform.getAutoPrefs/setAutoPrefs 接口形态。**明确不做**:凭据字段全注册表化(模板内联合类型不窄化是真实痛点,CloudCard.vue:226-229 注释自证)。
- **涉及文件**:packages/ui/src/components/CloudCard.vue、CloudCredFields.vue(新)、cardShared.ts(新)、composables/(新)、BackupCard.vue、ImportCard.vue、SecurityCard.vue、SyncCard.vue、McpServerCard.vue。
- **风险**:medium | **工作量**:M

### R8(P8)Rust lib.rs 按既有分节边界机械拆分

- **问题**:lib.rs 2400 行(业务约 1670+测试约 730)混杂 ≥6 子系统,分节注释自证(:79/:121/:170/:314/:539/:675/:956/:1024/:1243):剪贴板/DEK 暂存(20-119)、settings 读写(121-168,含 write_text_atomic :152)、devtools(170-312)、release 接线+窗口(314-537)、对话框授权+文件命令(539-1022)、DPAPI/DEK/keyring(1024-1368)、run() 装配(1370-1662)。cli.rs/lock_events.rs/release_policy.rs 均已成功抽出。mcp_server.rs:121-122 经 crate 根 write_text_atomic 形成唯一反向依赖。
- **方案**:按注释边界**纯移动**:session_vaults.rs、dialog_grants.rs、platform_security.rs、settings_io.rs(含 write_text_atomic,mcp_server 改从该模块导入),测试随迁。复制 release_policy.rs「纯逻辑+薄接线」先例,不引入新抽象。风险低,可全程并行。
- **涉及文件**:apps/desktop/src-tauri/src/lib.rs、session_vaults.rs(新)、dialog_grants.rs(新)、platform_security.rs(新)、settings_io.rs(新)、mcp_server.rs。
- **风险**:low | **工作量**:L

### R9(P9)settings.json 分节读写单点化 + ReleasePolicy serde 化

- **问题**:settings.json 为四组配置+前端共写:「合并写不丢外来键」外壳 3 份、「读失败回默认」外壳 4 份;历史上直覆丢键返工过(lib.rs:148「审查 I-5」)。ReleasePolicy 四字段手工映射 5 份(struct 7-21、解析 45-73、merge json! 84-92、get json! lib.rs:323-328、set lib.rs:331-354——后者为 4 个独立 invoke 参数),serde 派生因缺 rename_all 闲置(测试注释 395-398 自证)。
- **方案**:依赖 R8。settings_io.rs 提供 read_section/write_section(内置「根非对象回落空对象」+write_text_atomic,不变式单点化)。ReleasePolicyConfig 加 `#[serde(rename_all="camelCase")]`+Serialize:merge 与 get 直接序列化 struct;**set 的改造是「4 个 invoke 参数构造 struct → serde Serialize 写节」**(其输入不是 JSON 文本,无反序列化路径)。**from_settings_text 的「类型不符逐字段回默认」语义保留为唯一手写处**——serde 字段类型不匹配是整体报错而非逐字段回退,派生无法等价替代;此为有意裁定,有测试锁定(release_policy.rs:45-73、366-398)。
- **涉及文件**:settings_io.rs、release_policy.rs、lib.rs、mcp_server.rs。
- **风险**:low | **工作量**:M

### R10(P10)backupService 抽 BackupDirSink 策略接口

- **问题**:「os 授权目录 vs AppData 默认目录」双通道分支散布 5 函数 4 类操作(listDirNames 86-93、writeSourceBackup 97-118 keep 分支内再分两路、saveConflictBackupToDir 172-173、readBackupByName 197-201);81-85 注释自认两分支过滤口径不一致(os 白名单 vs READABLE_BACKUP_RE),漂移已发生。
- **方案**:策略接口 `BackupDirSink { write; listNames; readText; remove }`,两实现 osDirSink(dir)/appDataSink(),5 函数面向接口。「目录访问方式」是稳定变化点,收敛后口径单点对齐、新增操作只写一次,不改行为。
- **涉及文件**:apps/desktop/src/backupService.ts。
- **风险**:medium(备份写路径) | **工作量**:M

### R11(P11)Rust 文件命令守护链收敛 + 导入白名单跨端对齐

- **问题**:5 个文件命令守护链的**守护骨架**(空路径→白名单→is_dir→ensure_within)同构:write_text_file_granted(lib.rs:883-904)与 write_bytes_file_granted(924-942),读侧三函数各自声明白名单(862-872、962-974、988-1013)。注意两写函数**写盘通道有意不同**:text 走 write_text_atomic(lib.rs:905-906),bytes 走 std::fs::write(lib.rs:944)。IMPORT_BYTE_EXTENSIONS(993-1003,9 项)是 IMPORT_EXTENSIONS(967,5 项)手工超集。同一「可导入扩展名」知识在 extension 端还有两份内联 accept 字面量(options App.vue:318/326)——三端版本。
- **方案**:依赖 R8(落 dialog_grants.rs 后):抽 `ensure_extension(path, exts, msg)` 供 5 处共用(**仅守护骨架,写盘通道保持各自**);字节组白名单改「文本组+二进制组」拼接派生;与 R16⑪ 联动:TS 侧 accept 字面量提为派生常量,Rust/TS 两组常量以镜像断言(测试互验扩展名集合一致)防三端漂移。
- **涉及文件**:apps/desktop/src-tauri/src/dialog_grants.rs(由 lib.rs 拆出)、lib.rs;apps/extension/entrypoints/options/App.vue(accept 常量,与 R16⑪ 同点)。
- **风险**:medium | **工作量**:S

### R12(P12)winauth.ts 分层拆解 + import 工具收敛补课(含吸收第四份 sha256Hex)

- **问题**:winauth.ts 649 行四职责混装(Blowfish 76-251、解密序列 253-416、mini XML 418-490、格式映射 492-649);authenticatorPlus.ts+zipAes/zipRead 已示范正确分层。工具收敛未约束后加入者:sqlite.ts:18-22/34-43 逐字副本;isBase32 双份;decodeXmlEntities = xmlUnescape(miscApps.ts:108-127);JSON.parse 样板 5 份变体;377-389 残留双 JSDoc。另有 winauth.ts:65 私有 sha256Hex(全仓第 4 处定义)。
- **方案**:复制 zipAes 先例:拆 crypto/blowfish.ts(测试锚点 blowfishEcbEncrypt/Decrypt)与 import/miniXml.ts;parseJson/isBase32 收敛进 normalize.ts,sqlite 删副本改导入,winauth 用 xmlUnescape,删残留注释;**winauth.ts:65 的 sha256Hex 随拆分改导入 canonical.ts 单点实现(与 R15 协调,先合入者落位)**;「禁本地重定义 asObject/collectEntries/sha256Hex」作新增 importer 准入检查。
- **涉及文件**:packages/core/src/import/winauth.ts、crypto/blowfish.ts(新)、import/miniXml.ts(新)、sqlite.ts、jsonApps.ts、miscApps.ts、normalize.ts、cloud/canonical.ts(单点,与 R15 共用)。
- **风险**:low | **工作量**:M

### R13(P13)desktop 装配样板收敛

- **问题**:①就绪断言 5 模块 9 处、守护闭包三件套逐字两份、kdfProfile 兜底三处(backupPlatform.ts:53、cloudPlatforms.ts:64、autoBackup.ts:217);②desktopPrefs 偏好读写逐字两套(22-43=80-101)、偏好类型三份同构;③MiniApp 未复用 desktopCopy(横幅不复位 111-118 vs desktopCopy.ts:44-45 的 3s 复位,行为已漂移)、i18n 胶水、boot 序列双份;④desktopShell.ts:225-233 七个可空 unlisten 手工管理。
- **方案**:纯样板合并不建新层:storeAccess.ts(requireStore/requireAdapter/storeGuards)、loadChannelPrefs/persistChannelPrefs 参数化+两键绑定(偏好类型合一)、useDesktopI18n+bootDesktopStore 共享、mini 剪贴板改走 createDesktopCopy(保留扩展点)、DisposableBag+safeListen。
- **涉及文件**:apps/desktop/src/storeAccess.ts(新)、desktopPrefs.ts、cloudPlatforms.ts、backupPlatform.ts、autoBackup.ts、securityPlatform.ts、desktopShell.ts、MiniApp.vue、desktopCopy.ts。
- **风险**:low | **工作量**:M

### R14(P14)跨端共享常量与纯函数下沉单一来源

- **问题**:六组「注释性同步」:BACKEND_LABEL 4 份(CloudCard.vue:49 权威未导出、cloudCredStore.ts:23、legacyMigrate.ts:51、migration.e2e.test.ts:50);autoPrefs 归一化三份 15min 钳制同款;formatAutoStatusText 两份逐字;排序口径两份靠注释同步(miniSort.ts:6-11 = CodesPage.vue:97-103);冲突副本命名两端各一(根因 core conflictBackupFileName 无 sourceId 参数);SourceKind(sources.ts:5)与 CloudBackend['id'](backend.ts:7)平行联合,漏改运行时静默丢源(sources.ts:39)。
- **方案**:单一事实源:ui 导出 BACKEND_LABEL(或下沉 core);normalizeAutoPrefs/formatAutoStatusText(标签注入)/sortEntries 下沉 ui;core conflictBackupFileName 增 sourceId 参数,两端删拼接;`SourceKind = 'local' | CloudBackend['id']` 派生 + KINDS satisfies。让编译器承担同步检查。
- **涉及文件**:packages/ui/src/components/CloudCard.vue、backupPlatform.ts、cloudPlatform.ts;apps/desktop/src/legacyMigrate.ts、desktopPrefs.ts、miniSort.ts、backupService.ts;apps/extension/src/cloudCredStore.ts;packages/core/src/backup/sources.ts、cloud/backend.ts。
- **风险**:low | **工作量**:M

### R15(P15)core 云/备份域小收敛

- **问题**:①authFetch 逐字复制(gdrive.ts:31-36 = onedrive.ts:31-36);②contentHash(canonical.ts:13-17)生产零消费仅测试用,与 contentHashVault 双口径并存,测试仍用它构造 baseContentHash(cloudSync.test.ts:87)而生产写侧是 contentHashVault(syncOrchestrator.ts:160-162);③sha256Hex 全仓 **4 处定义 6 处出现**:s3.ts:10(超集签名)、syncOrchestrator.ts:48、import/winauth.ts:65、canonical.ts 内联×2;oauthRefresh.ts:3 因此反向依赖编排模块;④loadSourceRevs/saveSourceRev(sources.ts:87-111)遗留 API 无 @deprecated;⑤backup/retention.ts:3 与 cloud 五文件构成目录环;⑥multiTarget.ts:123-134/170-181/189-200 三处 opts 构造 9 字段 7 恒同。
- **方案**:createAuthFetch 泛型工厂(refreshAccessToken:71-74 已泛型统一凭据);contentHash 删除或标「仅测试」并摘出公共出口,测试迁 contentHashVault;sha256Hex 归位 canonical.ts(超集签名,一处吸收四处),oauthRefresh 改导入切边,winauth 那份由 R12 协调吸收;legacy API 加 @deprecated;retention.ts 挪 cloud/;multiTarget 提局部 runSync(t, vaultJson, state)。
- **涉及文件**:packages/core/src/cloud/{gdrive,onedrive,oauthRefresh,canonical,s3,syncOrchestrator,multiTarget,retention(迁入)}.ts、backup/sources.ts、index.ts、import/winauth.ts(仅 sha256Hex 改导入,与 R12 协调)。
- **风险**:low | **工作量**:M

### R16(P16)低风险清理包(S 级顺手项批量收敛)

- **内容与方案**(均经评审证据修正):
  - ①**HMAC/截断**:从 hotp.ts **新拆** `hmac(secret, message, algorithm)`(steam.ts:3-6 是其 SHA-1 特化,等价属实)与 `truncateU31(mac): number`(**现无此函数需新写**;hotp dynamicTruncate 输出 padStart 十进制串、steam 是 u31+字符表取模,产出形态各自不变,仅统一「取 4 字节+清符号位」底层);yandex BigInt 保留。
  - ②正则安全器拆 match/regexSafety.ts(engine.ts:34-108 约 75 行,与匹配分发无耦合)。
  - ③**页面注册表单点化**:路由表在 packages/ui/src/pages/routes.ts:5-13(themeRoutes)——由它派生 NavigationShell.vue:63-69 navItems 与 :93-104 pageProps switch(pageProps 用映射类型恢复类型检查)。
  - ④searchEntries(entries, q, {includeSecret}) 下沉 popupFilter.ts(两份谓词:popupFilter.ts:30-34 = CodesPage.vue:113-118)。
  - ⑤commit 持久化失败增加 onPersistError 回调或 reject(store.ts:406-411 现吞成 console.error)。
  - ⑥SettingsPage devtools/release 两卡照 McpServerCard 先例抽组件(101-153/157-208 协议两遍;MCP 卡 :334-336 先例)。
  - ⑦loadSettings 改 per-field 校验器描述表(themeContrast 兜底 :201 绕开 DEFAULT :166 一并修)。
  - ⑧**kekSources 收敛分两步**:先在 multiKek.ts 为 withPrfSource 增加替换语义参数(或新增 upsertKekSource:先过滤同 kind+credentialId 再追加,与 addPrfSource securityStore.ts:269-292 的 others 过滤对齐)——**withPrfSource 现为纯追加(:34-41),直接当替换版用会产生重复 id 源**;统一后再让 addPrfSource 委托之。
  - ⑨Rust run() 抽 setup_tray/apply_shortcut_override/print_headless_connection(lib.rs:1370-1662,setup 闭包 145 行)。
  - ⑩TtlBook{grant,valid} 两实例化(mcp_server.rs:446-498 once/cooldown 同构)。
  - ⑪extension:notify() 三连(background.ts:90,99,117);readSyncStatus 导出(options App.vue:285-294 vs syncEngine.ts:40-60);导入 accept **两处内联字面量**(App.vue:318/:326,同集合不同排序,无 IMPORT_ACCEPT 常量)提为单一常量并与 R11 Rust 白名单镜像断言;FORMAT_LABEL/MANUAL_OPTIONS 合一(ImportCard.vue:59-102);buildMapping 用既有 FIELDS 循环化(555-567)。
- **明确剔除不做**:凭据表单全注册表化、mcp_server.rs 四文件拆分(降可选)、ImportCard 分支表格化、yandex 截断归一。
- **涉及文件**:packages/core/src/otp/{hotp,steam}.ts、match/regexSafety.ts(新);packages/ui/src/pages/{routes.ts,NavigationShell.vue,CodesPage.vue,SettingsPage.vue}、popupFilter.ts、store.ts、components/ImportCard.vue;packages/core/src/storage/vaultStore.ts、security/{multiKek,securityStore}.ts;Rust lib.rs/mcp_server.rs;extension background.ts/options App.vue/syncEngine.ts。
- **风险**:low | **工作量**:M

---

## 4. 分阶段实施路线

依赖关系:R4 依赖 R1(手动通道底座统一后再抽 runner 装配);R7 依赖 R1+R4;R9/R11 依赖 R8;R12 与 R15 在 sha256Hex 落位上协调(先合入者落位 canonical.ts,后者改导入);其余互相独立。

```
阶段 0  行为分叉修复(可并行:R1 ∥ R2)          —— 数据正确性,最优先,真机复验后合入
阶段 1  core 单点化(可并行:R3 ∥ R12 ∥ R15)    —— 低风险,core 测试保护,先行降低后续项耦合
阶段 2  装配与 God file(R4 → R7;R6 ∥ R5 独立) —— R4 等 R1 合入后启动;R5/R6 全程可并行
阶段 3  Rust(可并行:R8 与阶段 0-2 并行;R8 → R9/R11;R10 独立)
阶段 4  收尾(可并行:R13 ∥ R14 ∥ R16)          —— 常量下沉与顺手清理
```

- **建议节奏**:每阶段 1-2 周;每项独立分支、原子提交(why + 一句话 what,Angular 规范),合入一项验一项。
- **可提前的并行线**:R8(lib.rs 纯移动,风险最低体量最大)可从第一天与阶段 0 并行,由不同人负责,避免与 TS 侧冲突。
- **顺序红线**:不要在 R1 之前动 cloudRunner/CloudCard 的编排结构(尤其不得顺手把手动通道并进 apply 通道——确认流语义不同);不要在 R8 之前做 R9/R11;R5 动手前必须先补嗅探顺序快照测试;R16⑧ 未统一替换语义前不得合并两文件实现。

---

## 5. 风险与回归保障

**现有基建(已核实)**:
- 测试:`pnpm -r --no-bail run test`(vitest 全仓);typecheck:`pnpm -r run typecheck`。
- CI:`.github/workflows/` 下 ci.yml、build.yml、nightly.yml、release.yml 四条流水线。
- core 侧锚点:migration.e2e.test.ts(R2/R14)、cloudSync.test.ts(R15)、canonical*.test.ts;desktop 侧几乎每模块同名 .test.ts(约 4038 行);Rust 侧 lib.rs 与 mcp_server.rs 各有数百行测试随 R8/R12 迁移;sniff 现有覆盖散在 import.test/importApps/importMisc/importPaste 四文件(R5 前置补顺序快照)。
- 真机:E2E 活文档 docs/e2e-test.md + docs/e2e/ 按日期归档,项目已有「真机复验后回写」惯例。

**分级保障策略**:
1. **行为分叉项(R1/R2)**:先补失败用例(keep 源手动同步应读到远端最新份;迁移三项差异:双缺失清 revs、空配置清孤儿键、backend 去重),修复后 gdrive/onedrive keep 源按 docs/e2e-test.md 双端真机复验,并做旧→新迁移前后数据 diff。R1 明确不改「下载需人工确认」语义,验收含确认流回归(取消确认→基线不变→下轮重新提示)。
2. **行为契约项(R5 嗅探顺序与口令内容谓词、R11 白名单与写盘通道、R10 备份路径)**:迁移前先为现状写快照/守卫测试(嗅探顺序、口令路由两态用例:加密 aegis/foxauth/密文 totpAuthenticator 走口令页而明文直解析;5 个文件命令对各扩展名允许/拒绝矩阵 + text=原子写/bytes=直写;os/默认目录读写),再动手。
3. **装配下沉(R4)与 store 拆分(R6)**:返回对象/接口形状不变是硬约束;每个工厂附「同型成员 vs 注入差异」清单作为评审材料;optionsApp.test.ts 在 R4 后改写为直接单测装配(不再 mount 整组件),本身即验收标准。
4. **语义敏感小项**:R16⑧ 先统一替换语义并用「同 credentialId 二次绑定不产生重复源」用例锁定;R9 保留 from_settings_text 逐字段回退测试作为唯一手写口径守护;R11 镜像断言锁定 Rust/TS 扩展名集合一致。
5. **提交纪律**:每项原子化、单一化;R16 打包项也按模块拆多个 commit;任何一项合入前 CI 全绿。

---

## 6. 剔除与降级说明(防过度设计)

| 条目 | 处置 | 理由 |
|---|---|---|
| gdrive/onedrive 凭据表单全注册表化 | 剔除,仅保留两段模板合并(并入 R7) | 模板内 TS 联合类型不窄化是真实痛点(CloudCard.vue:226-229 注释自证),全表化反而更复杂 |
| mcp_server.rs 拆 gate/bridge/transport/commands 四文件 | 降为可选,不列入路线 | 内聚性远好于 lib.rs,测试占 49%,拆分仅浏览性收益 |
| ImportCard 口令页/字节通道 if 分支表格化 | 剔除 | 各分支有真实差异(口令必选/字节通道/DPAPI) |
| yandex.ts 截断归一进统一 truncate | 剔除 | uint64/BigInt 形态本质不同,强归一属伪统一 |
| CloudCard 手动同步整体复用 runner(一步到位) | 从首选降为远期可选,须先论证确认流等价性 | runner apply 通道立即 persistAdopted,手动通道两步确认后采纳——语义不同,整体复用属行为变更或复杂化 runner(R1) |
| 注册表口令通道用静态布尔 capabilities | 剔除 | 是否走口令页是文本内容函数(加密 aegis/foxauth、密文 totpAuthenticator),静态布尔会丢两态路由(R5) |
| withPrfSource 直接收编 addPrfSource | 剔除该做法,改两步走 | 前者纯追加、后者同 credentialId 替换,直接合并会产出重复 id 源(R16⑧) |
| desktop idleLock vs extension lockEnforcer 合并 | 不动 | 判定源不同(document 活动时间戳 vs chrome.idle),核心判定已在 core |
| overrides 面宽于字面量的宿主工厂 | 不抽(R4 内置纪律) | overrides 键数接近字面量成员数时收益为负 |

低风险 S 级条目以分析员报告与评审员交叉核实为据,全部标注为「删副本/提局部助手」级别,不允许在执行中升格为新抽象层。

---

## 7. 评审意见回应(第二轮,13 条逐条处置)

| # | 评审意见 | 处置 |
|---|---|---|
| 1 | R1 低估采纳确认流语义冲突,应把共享底座修复升为首选 | **采纳**。已实读核实:runner apply 通道 `if (r.adopted) await deps.persistAdopted(...)`(cloudRunner.ts:336-339,注释「采纳先于基线回写」)vs CloudCard 两步确认后整体替换+落基线(CloudCard.vue:462-466、:567-569、:587-589、:598-599)。R1 标题与 proposal 已重写:首选=共享 inputs 组装(补 readPath)+结果归纳+接入 single-flight;「整体复用 runner」降为远期可选,前置条件=论证确认流等价性。§1、§4 红线、§6 剔除表同步更新 |
| 2 | R5 capabilities 静态布尔无法派生两端口令路由,须为内容谓词 | **采纳**。已实读核实三处内容判定(paste.ts:33-36、ImportCard.vue:511-515/539-544/546-551)。描述符改为 `needsPassword?: (text) => boolean`(或「入口默认+内容覆写」两级),并明令禁用静态布尔;验证记录与 §6 新增该剔除项 |
| 3 | R16⑧ kekSources 追加/替换语义不同,直接收敛有回归风险 | **采纳**。已实读核实:multiKek.withPrfSource 纯追加(:34-41)vs securityStore.addPrfSource 同 credentialId 过滤替换(:269-292)。R16⑧ 改两步走:先统一替换语义(upsert,含「同 credentialId 二次绑定不产生重复源」用例)再收敛,并列入 §4 红线 |
| 4 | R15③ sha256Hex 漏计 winauth.ts:65,应为 4 处,与 R12 需协调 | **采纳**。rg 证实 4 处定义 6 处出现(s3.ts:10、syncOrchestrator.ts:48、winauth.ts:65、canonical.ts 内联×2)。R15 rationale/proposal、R12 proposal、涉及文件均已补并注明协调规则(先合入者落位 canonical.ts) |
| 5 | R2 差异实为三项,测试应三项全补 | **采纳**。已实读核实第①项(cloudCredStore.ts:104-110 双缺失清 CLOUD_REVS_KEY/CLOUD_REV_KEY vs legacyMigrate.ts:114-117 直接 return 0)。R2 rationale 三项全列,proposal 明确「三项差异各补一用例,漏①则同形态两端仍不收敛」 |
| 6 | R16⑪ 不存在 IMPORT_ACCEPT 常量,系两处内联字面量;应与 R11 三端对齐 | **采纳**。rg 证实无该常量;表述改为「两处内联 accept 字面量提为单一常量」;R11 与 R16⑪ 互相引用并加「Rust/TS 镜像断言」防三端漂移 |
| 7 | R16③ 路径不完整且 files 漏列 routes.ts | **采纳**。实读确认 packages/ui/src/pages/routes.ts:5-13(themeRoutes);R16 rationale/proposal/files 均已修正补列 |
| 8 | R16① 「逐行等价」夸大,截断产出形态不同,truncateU31 需新拆 | **采纳**。实读确认:hotp dynamicTruncate 输出 padStart 十进制串(hotp.ts:16-23),steam 为 u31+STEAM_ALPHABET 取模(steam.ts:15-22);hotp 中无 truncateU31。措辞改为「hmac 特化等价+新拆 u31 底层函数,产出形态各自不变」 |
| 9 | R11 「逐行同构」不完全,写盘通道有意不同 | **采纳**。实读确认 text 走 write_text_atomic(:906)、bytes 走 std::fs::write(:944)。rationale 收敛为「守护骨架同构、写盘通道有意不同」,proposal 明确 ensure_extension 范围止步于守护骨架 |
| 10 | R6 「lock() 清 5 处」计数偏差 | **采纳**。实读确认 lock()(store.ts:901-913)经 4 条途径清 5 Map 并另清 bag/bagStoredRef 单例。rationale/proposal 均已改为准确账目,验收口径同步 |
| 11 | R9 「set 直接反序列化」措辞不准;from_settings_text 回退语义 serde 无法等价替代 | **采纳**。实读确认 set 输入为 4 个独立 invoke 参数(lib.rs:331-340)。proposal 改为「参数构造 struct → serde Serialize 写节」;「唯一手写处」裁定保留并升格为明示理由(serde 整体报错 vs 逐字段回退),列入 §5.4 守护测试 |
| 12 | R3 popup toOtpDigits 含表单层默认值决策,归属未交代 | **采纳**。实读确认 popup App.vue:276-284 的 `data.type !== editing.value.type ? (steam?5:6) : ...`。R3 rationale 区分 4 个幂等收口点与该表单层点;proposal 明确「切换 type 重置 digits 保留在表单层,默认值来源改查 typeProfile.defaultDigitsFor(type)」 |
| 13 | (建议,非阻塞)R4 overrides 面以差异点清单驱动最小化 | **采纳**。R4 rationale 补列已核实真实差异(extension 独有 authError 包装 cloudRunnerFactory.ts:57-61/133-145、badge/横幅通道 :114-120;desktop 独有 dpapi/unlockNaming securityPlatform.ts:126-127、目录冲突副本 cloudPlatforms.ts:102);proposal 增加纪律:每工厂先列「同型成员数 vs 注入差异数」,overrides 键数接近字面量成员数则不抽;§5.3 要求该清单作评审材料;§6 新增对应剔除项 |

评审员的「核实通过记录」(对 R1-R16 关键声明、行数、基建的抽样复核)与本方案两轮验证结果一致,无分歧点,不再单列回应。修订后方案未改变 16 项的编号、优先级与总体路线;变更集中在 R1/R5 的方案形态、R16⑧/R3/R9/R11 的实施步骤精度,以及各处证据计数的准确性。
