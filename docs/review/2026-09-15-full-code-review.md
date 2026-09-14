# TOTP 全代码审查报告（2026-09-15）

## 范围

按 spec (`docs/plans/2026-09-13-totp-tool-design.md`) 和 12 份实施计划，对仓库全部代码做分块审查：

- `packages/core` — 纯 TS 核心（OTP 引擎、URI、匹配、加密、envelope、19 importer、SQLite、云同步、安全）
- `packages/ui` — Vue 3 共享组件（store、卡片、图标系统、剪贴板清除、PRF、otpauthFlow）
- `apps/extension` — WXT 浏览器插件（background、offscreen、popup、options、syncEngine、pendingOtpauth）
- `apps/desktop` — Tauri 2 桌面壳（App、MiniApp、backupService、tauriFs、tauriSecurity）
- `apps/desktop/src-tauri` — Rust 端（lib.rs、main.rs、capabilities）

合计约 14.8k LOC。审查方式：6 个并行子代理各负责一个领域，对照 spec/计划逐文件过代码、单测、配置文件。

## 测试基线

- 297 个单测全部通过：RFC 4226 (HOTP)、RFC 6238 (TOTP SHA1/256/512 全部 6 个时间点)、Steam 三向量、Aegis 19 格式、WinAuth、WebDAV/S3/Gist 协议
- 5 个云后端 fetch mock 端到端请求形状断言通过
- S3 SigV4 用 aws-sig-v4-test-suite 官方向量（5fa00fa3 / c9d5ea9f）锚定通过

## Critical — 必修（真实 bug / 安全漏洞 / 规格红线）

### 跨领域 Critical

| # | 文件 | 问题 | 修复方向 |
|---|---|---|---|
| **S1** | `apps/extension/src/syncEngine.ts:118-119` `pushOnce` | 密文 vault + 本地 `SECURITY_KEY` 缺失时无降级 → 密文 vault 以"明文"形式落入 sync 区 | push 起始处加 `isEncryptedVault(parsed) && !SECURITY_KEY` → `setSyncStatus('error')` 并 return |
| **S2** | `packages/ui/src/store.ts:174-196` `registerStorageSync` 远端覆盖分支 | 注释承诺"丢弃本端 DEK、转锁定"，实现却保留 `dek` → 下一次落盘把远端明文 + 本端 DEK 加密成幽灵密文 | 远端覆盖后强制 `lock()` 并重读 `security` |
| **S3** | `packages/ui/src/components/parseVaultJson.ts:5-11` | 仅校验 schema 形状，**不校验条目字段语义**（secret 非 base32 / digits 非 6·7·8 / period 非正数均通过），覆盖 vault 后条目永远显示 `------` | 加每条目语义校验，失败立即抛错禁止半替换 |
| **S4** | `packages/ui/src/store.ts` 锁状态、`packages/ui/src/components/LockScreen.vue:38-41` | `locked/dek/security` 是单进程共享 ref，违反 spec §7 末尾"窗口独立解锁"承诺 — 一个窗口 unlock 让所有窗口同时解锁 | 把 locked/dek 提升为窗口级 closure；storage.onChanged 只更新本端状态 |
| **S5** | `apps/extension/entrypoints/background.ts:88-93` `chrome.alarms.onAlarm` | 调 `sendMessage({type:'clear-clipboard'})` 给 offscreen 文档，但**无 ack/重试**：offscreen 文档未就绪（SW 冷启动）时消息丢失，剪贴板 30s 清空承诺静默失效 | 在 SW 内先 `await ensureOffscreenDocument()`，加 ack 超时重试 |

### 密码学/算法 Critical

| # | 文件 | 问题 |
|---|---|---|
| **C1** | `packages/core/src/security/multiKek.ts:77-78` | `unlockWithPrf` 仅 `length===32` 校验；wrapping 解密异常被吞，且 wrappedDekP 可被构造产生可控 32B 明文绕过 |
| **C2** | `packages/core/src/otp/uri.ts:28` + `packages/core/src/otp/steam.ts` | `parseOtpUri` 返回的 secret 是 base32 字符串，由调用方走 RFC4648 `base32Decode`；但 `otpauth://steam/...` URI 应按 **Steam 自定义字母表**解码。两表字符索引不同 → HMAC 算出错误码（测试向量恰好是子集掩盖了 bug） |

### 同步/导入 Critical

| # | 文件 | 问题 |
|---|---|---|
| **C3** | `packages/core/src/cloud/syncOrchestrator.ts:79` | `in-sync` 分支返回 `envelopeJson: new TextDecoder().decode(remote)` — 但 `vaultHash` 是**明文** vault JSON 的 sha256，`remote` 字节是 envelope **密文**；字段命名/语义自相矛盾，调用方按注释会把明文当作 envelope 处理 |
| **C4** | `packages/core/src/import/sniff.ts:141-151` | `sniffFreeOtp` 仅认 `issuerExt`，但 Aegis `FreeOtpPlusImporter` 同时认 `issuerExt` 和旧版 `issuer` — 老版本导出会被误判为 generic |
| **C5** | `packages/core/src/import/conflict.ts:47-62` `applyImport` replace | 用 `updateEntry(e, { counter: undefined, ... })` 覆盖，vault 端 `...patch` 把 `counter/note` 静默写成 undefined → 替换策略丢失原条目 counter/note |
| **C6** | `packages/core/src/import/jsonApps.ts:231-257` `importEnte` 加密 JSON 检测 | 仅在 JSON 解析成功且结构匹配时抛"加密不支持"，解析失败时静默落到 URI 行解析 — 加密导出用户得到一串"URI 语法"误导错误 |

### 应用壳 Critical

| # | 文件 | 问题 |
|---|---|---|
| **C7** | `apps/desktop/src-tauri/src/lib.rs:293` | 全局快捷键 `Alt+Shift+T` **硬编码**，无配置入口（spec §11 "默认 Alt+Shift+T，可改"未实现，README L37 也未提） |
| **C8** | `apps/desktop/src/tauriSecurity.ts:9-11` | `dpapiProtectOs` 未校验 `dek.length===32`，错误长度落盘后整 vault 永久无法解开（只能换机器 + 口令 fallback） |
| **C9** | `apps/desktop/src-tauri/src/lib.rs:80-94, 100-113` | `write_text_file_os` / `read_import_file_os` 仅靠扩展名白名单，无目录约束 — CSP null 现状下，XSS 注码可覆盖用户任意 `.totpbackup` 或读取任意 `.json` |
| **C10** | `apps/extension/src/syncEngine.ts:135-139` | quota 检测在 `set(batch)` 之后做 — 超配额时用户看到的 status 是 `error` 而非 `quota`，spec §6.2 明确"写入前 getBytesInUse 估算"未实现 |
| **C11** | `apps/extension/entrypoints/background.ts:31-36` | 右键菜单仅在 `onInstalled` 注册；Firefox MV3 SW 冷启动后菜单丢失 |
| **C12** | `apps/extension/wxt.config.ts:31` | Firefox `protocol_handlers` uriTemplate `/popup.html?uri=%s` 路径未经构建产物实测，WXT firefox-mv2/mv3 实际产出路径可能不同（`popup/index.html`），错则 404 |
| **C13** | `apps/extension/entrypoints/popup/App.vue:30` | `consumePendingOtpauth` 仅 onMounted 调一次；popup 已开时右键写入 pending 不会被消费 |
| **C14** | `apps/desktop/src/MiniApp.vue:42-48` | mini 复制后**不递增 HOTP counter**，与 popup 不一致（spec §11 要求 mini 与 popup 交互一致） |

### UI/EntryForm Critical

| # | 文件 | 问题 |
|---|---|---|
| **C15** | `packages/ui/src/components/EntryForm.vue:162-167` + `entryForm.ts:3-13` | 表单**不可编辑** `algorithm/digits/period/counter`，违反 spec §4 模型字段；HOTP 切换后 `period:30` 字段残留，`counter` 完全无 UI |
| **C16** | `packages/ui/src/components/OtpListItem.vue` + `VaultManager.vue:136-147` | 列表不显示 masked secret；无右键菜单（spec §10/§12 明文要求"右键/长按菜单：编辑/复制 URI/置顶"） |
| **C17** | `packages/ui/src/components/LockScreen.vue:27` | Passkey 解锁按钮显隐只看 `prfSources.length`，**不管浏览器能力** — Firefox 同步过来 PRF 凭据后按钮仍渲染，点击直接抛错 |
| **C18** | `packages/ui/src/components/SecurityCard.vue:168` | 缺"口令不可移除"明示文案，与"移除 Passkey/Windows"按钮并排误导 |
| **C19** | `packages/ui/src/composables/useOtpCodes.ts:36-39` | secret 非法永久显示 `------`，无错误提示 — 用户无法区分"未到时间窗"与"密钥非法" |

## Important — 应修（规格偏离 / 缺测试 / UX bug）

### 安全 / 密码学

- **I1** `packages/core/src/crypto/aesgcm.ts:3-7` `randomBytes` 静默用全局 `crypto`，Tauri / Node 早期无 WebCrypto 导入即崩；测试仅断言"两次不同"，未断言真随机（`getRandomValues` 调用验证）
- **I2** `packages/core/src/backup/envelope.ts:50-54` + `securityStore.ts:30-36` KDF 仅钳上界 `m < 2**21`，**未钳下界**（`m=0/负数/t<1/p<1` 让 hash-wasm 进入未定义行为）
- **I3** `packages/core/src/crypto/aesgcm.ts` AES-GCM 标签未做长度校验（`data.length < 16` 时 WebCrypto 切错位仍可能通过）
- **I4** `packages/core/src/security/securityStore.ts:138-146` `changeVaultPassphrase` 用 `...(security.kekSources ? {...} : {})`，条件展开导致 `kekSources` 字段缺失时被归一为 password
- **I5** `packages/core/src/security/securityStore.ts:65-91` `setupVaultEncryption` 接受任意 `params` 注入；外部调用方可绕过 KDF 钳制
- **I6** `apps/extension/src/syncEngine.ts:173-181` `pullOnce` 密文失败分支不清理半态（残留 `vault`/`security` 但 `appliedRev` 未更新，进入 push↔pull 死循环）
- **I7** `apps/extension/src/store.ts` `addPrfSourceOp/removePrfSourceOp/addDpapiSourceOp/removeDpapiSourceOp/changePassphrase` 均未触发 `scheduleSyncPush()` — 其他设备无法感知 KEK 来源变化
- **I8** `apps/extension/wxt.config.ts:20` Firefox `offscreen` 权限被申请但不被支持，UI 未告知"Firefox 下剪贴板自动清空无效"
- **I9** `packages/core/src/sync/chunks.ts:67-71` 单片 base64 7400B 测试通过但未断言**最终 `JSON.stringify(chunk).length ≤ 8192-50`**，含包装后临界

### 云同步

- **I10** 所有 `*Backend.ts` 的 `cloudFetch` catch 不区分 `TypeError: Failed to fetch` — 自建 WebDAV/S3/MinIO 用户遇 CORS 拦截时拿不到 README §95 明确承诺的"CORS 配置提示"
- **I11** `packages/core/src/cloud/s3.ts:114-127` 缺 STS `x-amz-security-token` 签名支持（AssumeRole 临时凭据不可用）
- **I12** `packages/core/src/cloud/s3.ts:104` `pathStyle = !!cred.endpoint` 不给 AWS 老 bucket 暴露强制 path-style 选项（us-east-1 历史 bucket 拒 virtual-host）
- **I13** `packages/core/src/cloud/gdrive.ts:37-46` `queryIdByName` 仅按名字查，未限定 `mimeType`/`appProperties` — 误覆盖同名文件；**跨设备 fileId 不回写**（设备 B put 时 `fileId=undefined` 触发 `createFile` POST，与 A 完全脱钩 → 数据丢失）
- **I14** `packages/core/src/cloud/s3.ts:120` `canonicalQueryString` 硬编码空串；未实现 SigV4 `uri-encode-then-sort`
- **I15** `packages/core/src/cloud/gdrive.ts:38` GDrive `q = name='...'` 单引号未转义（`encodeURIComponent` 不转 `'`），目前 `path` 固定无注入面，但代码层不防呆
- **I16** `packages/core/src/cloud/gist.ts` + README `Gist` 建议 secret 但 UI/API 层无任何 `public` 字段检测提示
- **I17** `packages/core/src/cloud/syncOrchestrator.ts` 失败重试 — plan §4-2 提到"指数退避"但实现无重试（plan10 明确说不含自动定时同步，但 README 未注明"无重试"）

### 导入

- **I18** `packages/core/src/import/generic.ts:6-15` `findFirstArray` BFS 深度优先**先选短数组**（含 0 元素辅助数组如 `metadata.tags`），违反 spec"探测候选行数组"
- **I19** `packages/core/src/import/generic.ts:23-48` 单对象导出（`{secret, issuer, ...}` 一条）无法被探测 — README L132 措辞误导
- **I20** `packages/core/src/otp/uri.ts:23` + `packages/core/src/import/uriBatch.ts:8-22` `parseOtpuri` 拒 `ext+otpauth:` 前缀，UI `normalizeExtOtpauth` 未在 `importUriBatch` 调用
- **I21** `packages/core/src/otp/uri.ts:19` 用 `URL` 构造器**拒非 ASCII 未编码 URI**（如 `issuer=微信`），中文条目导入 4 个入口都受影响
- **I22** `packages/core/src/import/schemes.ts:9` + `ImportCard.vue:421-433` `rowsPath` 字段定义但 UI 从未暴露
- **I23** `packages/core/src/import/aegis.ts:175-185` hash-wasm 4.x scrypt 参数命名依赖特定版本，无版本检查/降级
- **I24** `packages/core/src/import/jsonApps.ts:204-217` Bitwarden 接受裸 base32 `totp` 是 Aegis 之外的工具扩展，README 未文档化
- **I25** `packages/core/src/import/conflict.ts:65` `newEntryFromParsed(p, crypto.randomUUID(), 0, now)` — 第三个参数 `0` 是死代码
- **I26** `packages/ui/src/components/ImportCard.vue:492-495` "成功导入 N 条" 应改为"成功落库 N 条"
- **I27** `sniff.ts:107` 空 `services` TwoFas 静默落到 generic 报错
- **I28** `sniff.ts:46` `Authenticators` 键名仅 Stratum 用，但 sniff 仅做大小写检查

### OTP/URI

- **I30** `packages/core/src/otp/totp.ts:9` TOTP 不支持自定义 T0（RFC 6238 §4.1）
- **I31** `packages/core/src/otp/totp.ts:21-24` `verifyTotp` 漂移容忍固定 ±window 对称，无累积漂移记忆
- **I32** `packages/core/src/otp/uri.ts:48` `issuer.toLowerCase()==='steam'` 强转 hotp URI 为 steam 类型
- **I33** `packages/core/src/otp/uri.ts:57-59` URI 不校验 `digits/period/counter` 范围
- **I34** `packages/core/src/otp/uri.ts:48-60` Steam 类型强制 `digits:5` 但 `algorithm` 仍取 query 值（Steam 规范仅 SHA-1）
- **I35** `packages/core/src/otp/uri.ts:72` `buildOtpUri` hotp 且 `counter===undefined` 时**不输出 counter** — 跨工具导入时对方默认处理不一致
- **I36** `packages/core/src/model.ts:14` `digits: number` 应改为 `6|7|8`（spec §4 写明）
- **I37** `packages/core/src/otp/totp.ts:20-24` counter 上界未限，超 `2^32-1` 时 `setUint32(4, counter)` 静默截断
- **I38** `packages/core/src/match/engine.ts:19-28` IPv6 (`[::1]:8080`) `baseUrlOf` 拆分错乱
- **I39** `packages/core/test/hotp.test.ts:8-14` 仅测 0-9 RFC 4226 计数器，缺大 counter 边界
- **I40** `packages/core/src/encoding/base32.ts:21-39` `base32Decode` 1 字符输入返回空数组
- **I41** `packages/core/src/import/uriBatch.ts` + `EntryForm` otpauth 粘贴入口 — Steam URI 导入时未把 digits 强制改 5

### 应用壳

- **I42** README L245 声称"Chrome 127+ 支持自动打开扩展弹窗"，但 `chrome.action.openPopup` **始终需要用户手势**
- **I43** `lib.rs` 全局快捷键注册构建期固定，无法运行时换快捷键（与 C7 配套）
- **I44** `tauriSecurity.ts:14-16` DPAPI 失败在 `getCurrentDek()` 中静默返回 null — LockScreen 缺重试路径
- **I45** `popup/App.vue:114` `consumePendingOtpauth` 失败静默；`applyOtpauthPrefill` 失败才显示错误
- **I46** `apps/extension/src/syncEngine.ts:80-89` `mergeRemoteSettingsKeepingLocalSyncEnabled` 在 settings 损坏时整体采用远端
- **I47** `capabilities/default.json` 实际命令声明与 spec §11 插件清单核对一致
- **I48** `backupService.ts:7-14` + `tauriFs.ts:14-19` 临时文件 + rename 原子写 — OK

### UI / 图标

- **I49** `packages/ui/src/components/VaultManager.vue:63-67` `SearchBar` 不搜 secret
- **I50** `packages/ui/src/components/EntryForm.vue:163` type 选择器切到 HOTP 后**永久禁用**
- **I51** `packages/ui/src/components/EntryForm.vue:209-223` matchRules regex 策略**无客户端校验**
- **I52** `packages/ui/src/components/OtpListItem.vue:34` countdown ring `stroke-dasharray` 硬编码 100.53
- **I53** `packages/ui/src/components/SecurityCard.vue:91` 换口令成功消息未告知"Passkey/DPAPI 保持不变"
- **I54** `packages/ui/src/components/SecurityCard.vue` Backlog：缺"双端独立加密禁用提示"
- **I55** `packages/ui/src/components/SyncCard.vue:82-87` 缺"per-device 开关位"提示文案
- **I56** `packages/ui/src/components/syncPlatform.ts:13` `hasEncryption` 是 boolean 而非 `ComputedRef`
- **I57** `packages/ui/src/components/SyncCard.vue:46-51` quota 文案不显示百分比
- **I58** `packages/ui/src/iconStore.ts:69-71` URL 缓存键 `url:X` 与 `remove(X)` 共享 namespace
- **I59** `packages/ui/src/iconStore.ts:80-92` URL 拉取失败 CORS/404/超限统返回 null，文案笼统
- **I60** `packages/ui/src/iconImport.ts:47` aegis-icons zip "后者覆盖前者" 按 fflate `unzipSync` 顺序定义
- **I61** `packages/ui/src/composables/useOtpCodes.ts:45` countdown 跳变无平滑过渡
- **I62** `packages/ui/src/components/EntryForm.vue:69` iconId 在组件复用时污染 url 缓存键
- **I63** `packages/ui/src/iconImport.ts:39-56` `imported >= max` 时 break 剩余覆盖条目**不计入 skipped**
- **I64** `packages/ui/src/components/VaultManager.vue:120` 删除分组时条目 groupIds 引用未级联清理
- **I65** `packages/ui/src/components/SecurityCard.vue:208-217` 锁定态下剪贴板/弹窗延迟控件仍可点
- **I66** `packages/ui/src/otpauthFlow.ts:23` Steam URI 导入未强制 digits=5
- **I67** `packages/ui/src/components/EntryForm.vue:50-53` `recommendTimer` 无 `onScopeDispose` 清理
- **I68** `packages/ui/src/components/EntryForm.vue:147-157` base32 校验仅 submit 时触发
- **I69** `packages/ui/src/iconStore.ts:102-110` `iconView` 不区分 url 缓存丢失与未设置图标
- **I70** `packages/ui/src/components/BackupCard.vue:140-159` keep→overwrite→keep 切换丢 N
- **I71** `packages/ui/src/components/SecurityCard.vue:97-101` `confirmDisable` 状态机复位依赖 `run()` 副作用

## Minor — 清理（按需）

### 密码学 / 安全
- **M1** `packages/ui/src/prf.ts:75` `CreatedPrfCredential` 易与 `PublicKeyCredential` 混淆 → 改 `BoundPrfCredential`
- **M2** `packages/core/src/security/multiKek.ts:65,77` `prfOutput.subarray(0,32)` 冗余（`prfOutput` 已是 32B）
- **M3** `packages/core/src/crypto/aesgcm.ts:9-19` 空 bytes 提前返回
- **M4** `packages/core/src/storage/vaultStore.ts:25-31` `DEFAULT_SETTINGS` 与 `loadSettings` 字段兜底缺 `...DEFAULT_SETTINGS` 合并
- **M5** `packages/ui/src/store.ts:344-348` `lock()` 不清 `security.value`；`dpapiSource.computed` 命名误导
- **M6** `packages/core/src/security/securityStore.ts:125-147` `changeVaultPassphrase` 不去重 `kekSources`
- **M7** `packages/core/test/envelope.test.ts:30-34` KDF 超限测上界，未测下界
- **M8** `packages/core/src/sync/chunks.ts:106-114` `staleChunkKeys` 旧 rev 残留识别 OK

### 导入
- **M9** `hexToBytes` 三份近似实现，错误语义不一致 → 整合到 `encoding/hex.ts`
- **M10** `normalizeSecret/normalizeAlgorithm/toPositiveNumber/asObject/collectEntries/steamEntry` 跨 4 文件重复 → `import/normalize.ts`
- **M11** `sniff.ts:42` Aegis 加密/明文嗅探不区分
- **M12** `ImportCard.vue` "成功导入" 应改为"成功落库"
- **M13** `iconImport.ts` zip 计数在大量同名覆盖时失真
- **M14** `winauth.ts:602-605` 旧布局根元素含子节点 + 文本时合成 dataEl 处理顺序 OK

### 云同步
- **M15** `awsUriEncode` 缺中文/Emoji 测试
- **M16** `gdrive.ts:30` HTTP 错误与业务字段缺失错误文案应区分
- **M17** `gist.ts:53-55` `delete` 行为实现但 UI 未暴露
- **M18** `cloudFetch` reject 信息不带 URL
- **M19** `applyCred` 切换 backend 时不清空旧字段（非阻塞）
- **M20** `syncOrchestrator` 失败时不重置 pending（实际 OK）

### UI / 应用壳
- **M21** `wxt.config.ts:28` Firefox gecko.id 用 `example.local`，发布前改
- **M22** `background.ts:62` `(chrome.action as unknown as ...).openPopup?.()` 类型断言丑
- **M23** `popup/App.vue:182` `popupCloseDelayMs ?? 2000` 冗余
- **M24** `lockPlatform` / `VaultManager.vue:119-120` emoji 跨平台外观不一致
- **M25** `EntryForm.vue:42` `iconTouched` 清除后不重置（缺注释）
- **M26** `otpauthFlow.ts:23` Steam 导入未强制 digits=5

## 修复批次建议

**第一批（必修，影响真实数据/安全）**：S1、S2、S3、S4、S5、C1、C2、C3、C4、C5、C6、C9、C11、C13、C16、C17、C19、C7、C8

**第二批（应修，规格红线或常见 UX 障碍）**：C10、C12、C14、C15、C18、I5、I6、I7、I10、I13、I18、I20、I22、I30、I31、I42、I50、I51、I53、I55、I57、I58、I59、I63、I70

**第三批（清理 / backlog）**：其余 Important 与 Minor