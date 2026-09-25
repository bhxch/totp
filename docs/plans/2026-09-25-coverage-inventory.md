# 七域业务场景盘点底稿（2026-09-25）

来源：7 个只读调查子代理对全仓库源码、测试与 docs/ 27 份 spec 的盘点；覆盖率基线为 2026-09-25 实测。本文是 `2026-09-25-coverage-design.md` 的配套素材：B 节场景枚举即测试用例设计的直接清单，C 节为现有测试对照与缺口，D 节为可测性 seam，E 节为权威 spec 出处。

---

# 1. core 核心域（packages/core：otp/crypto/vault/storage/match/merge/tags/backup/security）

## A. 职责

| 模块 | 职责 |
|---|---|
| otp/uri.ts | otpauth/ext+otpauth URI 解析与生成：4 host（totp/hotp/steam/yaotp）、默认值归一、回写省略默认参数 |
| otp/entryCode.ts | 四类型取码统一分发：条目+时刻 → 码+剩余秒+周期，hotp 附窥视 counter |
| crypto/aesgcm.ts | AES-256-GCM 原语（12B nonce、16B tag、可选 AAD）、base64、Argon2id KEK 派生 |
| crypto/kdfProfile.ts | KDF 三档位常量 + 解密侧钳制包络 KDF_DECRYPT_CLAMP |
| vault.ts | 金库纯函数 CRUD、tag 幂等/改名/级联删除、URI→条目工厂 |
| storage/ | StorageAdapter 抽象 + memory 实现；vault JSON 持久化与 F6 结构校验门；AppSettings 逐字段校验 |
| match/engine.ts | URL 匹配 5 策略 + 域名归一 + F13 正则安全护栏（嵌套量词、长度/输入上限、缓存） |
| merge/vaultMerge.ts | 条目级三方合并裁决表 + tags 并集 + 冲突记录产出 |
| merge/conflictStore.ts | 合并冲突持久化（seal 可选、损坏回落空、超 100 裁最旧） |
| tags/filter.ts | any（并集）/all（交集），悬空 id 不命中 |
| backup/secretBag.ts | DEK 保管区：备份口令+云凭据以库 DEK 密封；损坏一律回落空袋 |
| security/securityStore.ts | 加密生命周期：setup/unlock/改密/换档、AAD 绑定（F8）、rev 水位、KDF 钳制（F9）、kekSources |
| security/multiKek.ts | KEK 多绑归一与解锁：password/prf/dpapi 三源 |
| security/lockPolicy.ts | 空闲锁定纯函数判定 |

## B. 场景枚举（★=无测试）

### B1. otp/uri.ts — parseOtpUri
1. 标准 totp 全字段解析，secretBytes=RFC4648 解码
2. issuer 参数缺失→取 path 前缀；无冒号 path→issuer=label
3. 大写 host 归一判定
4. hotp+counter 产出；无 counter 缺省
5. steam host→强制 SHA1/digits=5（query 写 SHA512 也忽略）
6. yaotp host→默认 SHA256/8、读 pin；显式白名单 algorithm 覆盖，白名单外回落
7. totp URI 带 pin=→不产出（M6 防污染）
8. issuer=Steam 但 host=totp→不强转（I32）
9. ★ secret 含空白→去除后解析
10. 非 URL/非 otpauth/非法 host→`invalid otpauth uri`
11. secret 空串或参数缺失→同上
12. path 非法 percent-encoding→同上
13. digits∉{5..8}、period 非法、counter 负数→各自 out of range
14. ★ secret 非 base32→不抛错，secretBytes 缺省（宽松容错契约锚定）
15. ★ 完全无 secret 参数方向

### B2. buildOtpUri / normalizeExtOtpauth
16. 非默认参数全写出并 parse round-trip；label percent-encode
17. 默认参数省略（steam/yandex/period=30）
18. hotp 恒输出 counter（I35）
19. ★ issuer 空→无前缀不写参数
20. pin 仅 yandex 写出
21. ★ normalizeExtOtpauth：`ext+otpauth:x`（无 //）、大小写变体（core 层无直测）

### B3. entryCode 及底层
22. totp RFC 6238 向量锚定；remaining 跨周期翻转
23. ★ period 0/undefined→回落 30
24. hotp 窥视不推进；★ counter 缺省→按 0
25. steam 官方向量；yandex 黄金向量；★ 缺 pin→空串
26. 未知 type→中文错误；secret 非法→底层抛错向上传播（契约）
27. 底层已盖：hotp RFC4226、totp 三算法+t0 偏移、verifyTotp 窗口

### B4. crypto
28. base64 往返多长度；0 长度短路（M3）
29. deriveKek 确定性/异口令不同/32B/默认参数
30. aesGcm 往返；错 key/篡改→抛；同 key 同 nonce 确定性
31. 密文 <16B→`ciphertext too short`
32. ★ nonce 非 12B 加/解两向各自抛
33. ★ key 非 32B 直调原语层抛
34. AAD 不传与 undefined 同字节（F8）

### B5. kdfProfile
35. 三档位常量精确值；KDF_DECRYPT_CLAMP 与最重档同源；isKdfProfile 真假值

### B6. vault.ts
36. createVault/addEntry（order、updatedAt）/updateEntry（不可变）/removeEntry
37. addTag trim+casefold 幂等复用
38. ★ renameTag 只改名不合并（D4）、非目标 tag 不动
39. ★ removeTag 级联清理、不含该 tag 条目不触碰
40. ★ reorderEntries 列表外条目 order 保持
41. newEntryFromUri：解析失败上抛、toOtpDigits 强制、uuid v4、createdAt 注入

### B7. storage
42. memory adapter 语义；loadVault 空库/往返/损坏→`vault corrupted`
43. validateVaultObject 容忍面（F6）：空 secret、非 base32、hotp 缺 counter、小数 counter、0<period<1、未知字段、icon 三形态、rev 缺省=0
44. vault 级拒绝：version≠2、entries/tags 非数组、updatedAt 缺失、rev<0、tag 缺 id/name
45. 条目级拒绝（已测部分）+ ★ 未测方向：note 非串、pinned 非布尔、pin 非串、icon 非对象、icon.id 非串、kind=url 缺 url、yandex digits≠8、元素 null、matchRules 元素非对象、issuer/label/secret 非串
46. loadSettings 缺省/损坏回默认/M4 兜底/未知字段丢弃/逐字段类型校验
47. ★ syncPrefs 存盘 JSON 完全无 syncPrefs 键的方向
48. 键名契约 VAULT_KEY/SETTINGS_KEY

### B8. match/engine
49. baseUrlOf：多段→末两段、二级域例外表→末三段、IPv4/IPv6 原样、大小写、空段
50. baseDomain 子域命中/异基域不命中/完整 URL 先取 host/解析失败恒 false
51. host/exact/startsWith 策略
52. regex 策略：合法 test；无法编译/不安全/URL 超 2048 一律 false
53. ★ pattern 空/纯空白→false
54. entryMatchesUrl：无规则 false、some 语义、混入不安全规则不影响其他
55. F13 风险形态已测 6 组；★ 未测形态：具名组、字符类转义、`|` 分支、惰性量词、非成对 `{`
56. isSafeRegexPattern；★ 缓存 256 条淘汰方向
57. MAX_REGEX_INPUT_LENGTH 2048 边界、尾锚定不因截断翻转

### B9. merge
58. 裁决表：单方改/增、同改同值、一方删、删vs改→保留+冲突、双方改→updatedAt 新者、tie→云端胜
59. canonical 按键序无关比较
60. base=null→降级两方合并
61. ★ mergeTags 全套：并集、同 id 异名取 ours、原 tags 不变
62. ★ vault.updatedAt=max 两侧、缺字段防 NaN
63. 输出按 order 升序
64. conflictStore：明文往返、seal 密文/unseal 回读、unseal 失败→[]、坏 JSON→[]、条粒度损坏过滤、>100 裁最旧
65. ★ conflictStore adapter.get 抛错→[]

### B10. tags/filter
66. 未选中→原样引用；any=并集/all=交集；悬空不命中；空 tagIds 在 all 恒不命中

### B11. backup/secretBag
67. seal→open 往返；每次新随机 nonce
68. 错 DEK→中文错误
69. 结构损坏一律回落 emptyBag：raw=null、★raw=''、坏 JSON、v≠1、nonce/ciphertext 非 str、base64 非法
70. ★ 明文坏 JSON→emptyBag；backupPassword 非串→''；creds 缺失→{}
71. ★ dek 非 32B seal/open 双向抛

### B12. security/securityStore
72. setup→unlock→往返；两次 setup 随机性
73. setup 非法 profile 恒用 balanced；合法展开落盘+镜像+passwordChangedAt
74. unlock：错口令、结构非法（v≠1、kdf.alg）、★ salt 非串/非对象/base64 非法
75. KDF 钳制（F9）：超上/下限在 argon2id 前结构拒绝；恰等放行
76. changeVaultPassphrase：缺省仅重包裹；rotateDek=true 新 DEK+死凭证源丢弃；保留 kekSources；★ 异常入参方向
77. kekSources 去重（M6）
78. AAD（F8）：新格式往返；旧格式 legacy 回退+自动迁移；跨记录移植失败
79. rev 水位键、dekFingerprint、VaultRollbackError
80. addPrfSource：并存/替换/多 credentialId/非法长度
81. ★ isEncryptedVault/isSecuritySettings 收到 null→false

### B13. security/multiKek
82. kekSourcesOf 归一（缺失/空→[{password}]、部分非法过滤）
83. withPrfSource 追加；withDpapiSource 恒单份替换
84. removeKekSource：最后一个→抛；prf 按 credentialId；不存在不抛
85. unlockWithPrf：成功并存；各类失败→`passkey 解锁失败`；C1 伪 DEK 防护
86. ★ isKekSource 非对象→false

### B14. lockPolicy
87. 阈值 ≥ 语义；0/负/非整数恒禁用；时钟回拨不触发

### B15. 跨模块
88. ★ index.ts 导出面快照冒烟
89. migration.e2e 已跨模块盖：先写新后删旧时序+3 中断点重跑收敛+二次运行零写盘

## C. 测试对照与缺口

测试目录 `packages/core/test/`：uri/yaotpUri、entryCode、hotp/totp/steam/yandex/base32/hex、crypto、kdfClamp、vault、storage、settings、match、vaultMerge、conflictStore、tags.filter、secretBag、security、security.aad、multiKek、lockPolicy、migration.e2e、smoke。

缺口汇总（★ 项）：B1-9/14/15、B2-19/21、B3-23/24/25、B4-32/33、B6-38/39/40、B7-45/47、B8-53/55/56、B9-61/62/65、B11-69/70/71、B12-74/76/81、B13-86、B15-88。

## D. 可测性 seam

- 时钟：entryCode/totp/verifyTotp/lockPolicy/newEntryFromUri 均有 nowMs 参数；vault.ts/securityStore 用 Date.now()→vi.spyOn(Date,'now')（已有示范）。
- KDF：hash-wasm argon2id 慢→vi.mock('hash-wasm') 固定 32B（kdfClamp.test.ts 示范，可断言钳制先于 KDF）。
- 存储：StorageAdapter + createMemoryStorage()；migration.e2e 用 counting adapter。
- match regexCache：模块级 Map 无 reset，测淘汰需构造 ≥257 pattern。
- legacy 回退分支需真实双格式密文 fixture（security.aad.test.ts 模式）。
- VaultRollbackError/水位推进/SECURITY_PENDING 转正本体在 ui store，归属 ui 包测试。

## E. 权威文档

docs/plans/2026-09-13-totp-tool-design.md（总体）、2026-09-13-m1-plan2-url-filter-and-options.md、2026-09-14-plan12-otpauth-and-spec.md、2026-09-14-plan11-unlock.md、2026-09-13-m1-plan4-encrypted-backup.md、2026-09-17-backup-sources-and-crypto-design.md、2026-09-16-settings-ux-design.md、docs/superpowers/specs/2026-09-18-tag-upgrade-design.md、2026-09-21-cross-device-sync-design.md、docs/review/2026-09-24-full-audit-fixes.md（I/F/M 编号出处）。

---

# 2. core 导入导出域（import 全部 + export + icons）

## A. 职责（支持的格式逐个）

| 文件 | 职责 |
|---|---|
| import/aegis.ts | Aegis 明文+加密（scrypt PasswordSlot→AES-GCM），slot 参数钳制防资源耗尽 |
| import/jsonApps.ts | 2FAS（STEAM tokenType、加密拒绝）、Bitwarden（otpauth/steam:///裸 base32 三形态）、Proton（加密拒绝）、Stratum（大写键 Type 1/2/4）、FoxAuth（明文+HKDF/AES-GCM 加密） |
| import/miscApps.ts | FreeOTP+（有符号 byte[] secret）、旧版 FreeOTP（tokens.xml）、TOTP Authenticator（明文数组+Base64 AES-CBC 默认口令）、andOTP（明文 JSON） |
| import/sqlite.ts | Microsoft Authenticator（SQLite 行转换）、Duo、Authy（XML+PBKDF2/AES-CBC 加密态）、Battle.net（XOR 掩码 8 digits） |
| import/generic.ts | 通用 JSON 数组/JSONL/嵌套探测 + RowMapping 点路径映射（transform 契约） |
| import/paste.ts | 粘贴文本白名单分发 parsePastedText |
| import/uriBatch.ts | otpauth URI 逐行批量（ext+otpauth 还原；覆盖 Ente 明文；Ente 加密拒绝） |
| import/sniff.ts | 格式嗅探（判定顺序固定）+ sniffAegis/sniffFoxauthEncrypted |
| import/winauth.ts | WinAuth .wauth XML：明文/条目级/整包 v3.2+/v3.0 旧布局；PBKDF2×2000→256B+Blowfish-ECB/ISO10126；DPAPI 回调 seam |
| import/zipRead.ts | zip 结构解析（EOCD/CEN/LOC、AES extra 0x9901、method 99/0/8）；拒绝 zip64 |
| import/zipAes.ts | WinZip AES（AE-1/AE-2）：PBKDF2×1000、verifier、HMAC、AES-CTR、CRC32 |
| import/authenticatorPlus.ts | Authenticator Plus：AES zip→Accounts.txt→uriBatch |
| import/dedup.ts | 文件内去重 + 四态判定树 identical>suspect>conflict>new + applyImportPlan |
| import/conflict.ts | 冲突键 issuer+label；skip/replace/merge；parsedPatch 白名单 |
| import/schemes.ts | 映射方案存储/推荐 matchSchemes |
| export/aegisVault.ts | Aegis 导出（明文+加密，官方兼容口径：恒写 issuer/note、groups 多标签、hotp 恒写 counter、yandex pin） |
| export/otpauthText.ts | URI 逐行导出（steam/yaotp 特殊 host） |
| icons/registry.ts | 内置图标表（218+58 别名）、normalizeIssuer、推荐/建议 |

统一错误契约：结构级错误 throw（中文），单条损坏进 failures[] 不阻断。

## B. 场景枚举

### B1. aegis.ts
1. 明文官方结构解析（type/name 冒号拆分/algo/digits/period）；type=steam 强制 5；yandex pin
2. ★ 新版独立 issuer 字段优先于 name 前缀
3. ★ note 非空→note；counter≥0→counter
4. 分组三代格式：groups（uuid 数组多值→多 tag）> groupid 查表 > group 字符串；数组存在即使全 miss 也不回落；表项脏数据跳过
5. 损坏：非 JSON/顶层非对象/缺 db/entries 非数组→throw；单条非对象/缺 secret→failures
6. 加密：正确口令解任一 PasswordSlot→db→复用明文解析；非 PasswordSlot 跳过
7. 口令错/全 slot 解不开/GCM 失败→`口令错误或文件已损坏`
8. ★ 缺 header/params/slots/db→throw；nonce/tag 非法（非 hex、长度≠12/16）→throw；db 非 base64→throw
9. 恶意钳制：slots>8 或 n>2^21/r>8/p>8→整文件拒绝；非有限 n/r/p→该 slot 失败换下一个

### B2. jsonApps.ts
10. 2FAS：schemaVersion>4→throw；servicesEncrypted→throw；缺 services/空数组→throw（空数组显式"无条目"）；groups→tags；tokenType 缺省/TOTP/HOTP/STEAM；未知/缺 otp/缺 secret→单条失败；★ groups 表脏项
11. Bitwarden：encrypted→throw；缺 items→throw；otpauth（issuer=item.name、label=username、notes→note）/steam://（固定 Steam）/裸 base32（默认 totp/6/30/SHA1）；folders→tags；★ login.totp 纯空白串
12. Proton：salt+content→throw；缺 entries→throw；uri otpauth（label=content.name）/steam://；缺 content/URI 非法→单条失败
13. Stratum：缺 Authenticators→throw；Type 1=HOTP/2=TOTP/4=Steam，其他单条失败；Algorithm 0/1/2 越界单条失败；Username null→''
14. FoxAuth：isEncrypted 无口令→throw"需要口令"（先于 accountInfos）；缺 encryptPassword→throw"不包含口令"；encryptPassword=Base64(UTF-8(口令))、非 ASCII 口令比对；encryptIV 须 12 字节否则 throw；HKDF-SHA-256+AES-GCM 两种密文形态；GCM 失败收敛中文错误；明文缺 accountInfos/空数组→throw；'Counter based'→hotp(0)；digits/period 字符串缺省 6/30；secret 非法→单条失败；★ accountInfos 既非数组也非串

### B3. miscApps.ts
15. FreeOTP+：缺 tokens→throw；有符号字节数组→base32；issuerExt 必需；Steam+totp→steam(5/30)；type 大小写不敏感；hotp counter 必需原样保留（不 +1）；null→SHA1/6/30
16. 旧版 XML：非 `<` 开头→throw；XML 实体转义 JSON；跳过 tokenOrder；坏 JSON→单条 failures
17. TOTP Authenticator：明文 `[`→数组（base 16/32/64）；Base64→SHA-256(缺省口令)+AES-CBC(IV=0)，解出对象首键即条目 JSON 串；★ 空对象→空结果；★ 首键非 JSON→throw；★ 解密非对象→throw；非 base64/解密失败→口令错误；★ 明文非 JSON throw
18. andOTP：非 `[`→throw"加密备份暂不支持"；顶层非数组→throw；必需字段；issuer 键存在→分读否则 `" - "` 拆分；steam→5/30；tags 过滤；★ xmlUnescape 数字实体（供 sqlite 复用）

### B4. sqlite.ts
19. MS Auth：account_type 0=base32（trim+去 `-` 空格，6 digits）、1=base64（8）、其他静默跳过不记 failure；缺/非法→failures；name→issuer、username→label
20. Duo：缺 otpGenerator/非法 base32/非法 counter→单条失败；有 counter→hotp 否则 totp（issuer 恒 ''）；非数组→throw、空数组→空结果
21. Authy：无 decryptedSecret 且无 seed→加密态：无口令→throw；★ salt 缺失→throw；PBKDF2-HMAC-SHA1(1000)+AES-CBC(IV=0)；★ encryptedSecret 非 base64/失败→口令错误；sanitize 四级；label 全量替换去前缀；digits 必需
22. importAuthy XML：首个 .key 值；无 .key→空结果；★ 值非 JSON→throw、非数组→throw
23. Battle.net：缺 DEVICE_SECRET→throw"Key not found"；serial 缺→label=''；unmask：非 hex/超 60B/结果非 hex→failures；恒 Battle.net/8 digits

### B5. generic.ts
24. extractGenericRows：数组/显式 path（取不到→空 rows）/单对象（secret-like 无嵌套）/嵌套数组优先（secret-like 字段>最长数组，深递归）/非 JSON→JSONL（坏行跳过）；★ path 存在但值非数组→rows=[]
25. mapRowToEntry：缺 secret→error；transform uppercaseSecret=去空白+大写、none=保留；缺省 totp；steam 强制 5；algorithm 非法→SHA1；digits/period 非法→6/30；counter≥0 采纳否则 defaults；★ note defaults
26. importGeneric 逐行 failures（行序号）

### B6. paste.ts（分发语义）
27. sniff null/无 DISPATCH→unsupported"无法识别"；★ aegis 加密→unsupported"走导入页"；★ winauth→"选择文件导入"；foxauth 加密→unsupported；generic→"配置字段映射"；其余同步解析

### B7. uriBatch + sniff
28. 逐行解析、空行跳过、failures index=原始行号；ext+ 前缀大小写不敏感还原；Ente 加密特征（完整或截断 JSON）→throw"明文导出"；★ 空文本输入
29. sniffFormat 判定顺序与特征键（误伤防御：aegis 优先、foxauth 需布尔、twoFas 无 secret 条目仍判格式、旧 freeOtp issuer 键、单行对象不判 JSONL）

### B8. winauth.ts
30. 非法 XML→throw；非 WinAuth→空结果；★ BOM/CDATA/注释/DOCTYPE 剥离；标签不匹配/多根→throw
31. 条目：name 冒号拆分；type 属性 Steam/HOTP(+`|counter`)/默认；secretdata=`hex\tdigits\talg\tperiod`；★ SHA256/SHA512 算法字段；非正 digits/period→6/30；缺字段→failures
32. 加密层序 Machine→User→Explicit→Yubi 逆序；`encrypted` 串含 y/u/m/a/b；★ 无 WINAUTH3 头→v2 无头路径；有头：剥头+salt 8B+SHA256 校验不匹配→"需要口令或口令错误"；DPAPI 无回调→"请用桌面版"；★ YubiKey→"暂不支持"；★ v3.0 旧布局（根元素文本密文）；★ m+u 双 DPAPI 层；hex 非法归类口令错误；整包失败→单条 failure(0)
33. 口令层：PBKDF2×2000→256B 密钥（.NET 语义）+Blowfish-ECB+ISO10126（pad=0 合法；pad>len→password 错）

### B9. zipRead + zipAes + authenticatorPlus
34. EOCD 尾部扫（注释区 65535）；★ 找不到→throw；★ CEN 签名错→"central directory 损坏"；extra 扫 0x9901（★ size<7 忽略、★ 多个 extra）；★ zip64→throw；★ 数据越界→"文件损坏"；★ method 其他→"不支持"；★ LOC extraLen≠CEN
35. WinZip AES：条目过短→throw；verifier 不匹配→"口令错误"；HMAC 不匹配→"完整性校验失败"；AE-1 截 CRC32（AE-2 不截）
36. AP：无 Accounts.txt→throw；未加密 zip 可读；文本复用 uriBatch

### B10. 落库（dedup/conflict）
37. 判定键 8 字段（trim+小写，不含 note/tags）；identical>suspect（带 targetUuid）>conflict>new
38. dedupeWithinFile 全字段重复保留首条
39. applyImportPlan：identical 恒跳过；suspect 缺省 skip/add/replace（残缺退化 skip）；conflict 沿用 policy（replace 保留 uuid、tags 并集；merge 并存）；new 追加；stats 七计数
40. parsedPatch 白名单：不提供 counter/note 不覆盖；yandex pin 显式覆盖（无 pin 清除）；toOtpDigits 收口（steam 5/yandex 8/其余 6-8）
41. resolveTagNames：空白跳过、trim 等价复用 tagId

### B11. export
42. 明文：官方顶层结构；entry 恒写 issuer/note（空串亦写）；name 组合；hotp 恒写 counter；★ yandex pin；多标签 groups 数组、同名组共享 uuid；★ 空 vault；★ tagId 悬空过滤
43. 加密：scrypt(16384/8/1) 单 slot；nonce/tag hex 拆分；与 importAegisEncrypted 精确互逆；★ 加密导出 usedGroups
44. otpauthText：steam/yaotp host；hotp 恒带 counter；空 vault→空串

### B12. icons
45. normalizeIssuer：小写+去分隔符；空 key→null/[]
46. recommend：精确→别名（58 条含中文）→null；悬空别名→null
47. suggest：normalize 后 includes 前缀 slice(默认 5)；★ limit 参数与空 key

## C. 缺口汇总（测试文件：aegisImport、importApps、foxauth、importMisc、importSqlite、import、importPaste、winauthImport、zipAes、authenticatorPlus、dedup、conflict、schemes、exportAegis*、exportOtpauthText、iconRegistry、normalize）

优先补测（分支收益×风险）：① zipRead 直接单测（8 类异常全可达）；② paste 两条拦截分支+aegis 加密结构分支；③ winauth 旧布局/YubiKey/无头 v2 + export yandex pin/空 vault。

## D. seam

hash-wasm（node 可跑，scrypt 慢）；WebCrypto node≥18 全局可用（程序化构造 fixture 是既有最佳实践）；sql.js 在 ui 包（core 只收行数组）；DPAPI 走 opts.decryptDpapi 回调 stub；文件读取全在宿主层（core 收 text/bytes）；authenticatorPlus 7z 对拍 skipIf+env 门控。

## E. 权威文档

docs/review/2026-09-24-full-audit-fixes.md（D1/Ente/transform/I32/IconRef）、docs/plans/2026-09-14-plan8-import-full.md（19 格式总 spec+sql.js 裁定）、2026-09-13-m1-plan5-import.md、2026-09-14-plan7-icons.md、docs/superpowers/specs/2026-09-21-foxauth-import-design.md（加密参数附录）、2026-09-17-plan16（dedup 判定树 §4）、2026-09-14-plan12-otpauth-and-spec.md。源码内注释（对拍官方 Java 源）为格式权威。

---

# 3. 云同步域（core/cloud + core/sync + extension 同步面）

## A. 职责

| 模块 | 职责 |
|---|---|
| core cloud/backend.ts | 5 后端统一接口 CloudBackend + cloudFetch（中文错误/CORS 提示/脱敏）+ CloudHttpError/isAuthError（401/403 结构化） |
| gdrive.ts | 单文件 envelope；fileId 主指针+按名兜底；keep-n 同名分流绝不 PATCH 主文件；401 刷新重试一次 |
| s3.ts | 纯 SigV4 四步签名自实现；virtual-host/path-style；STS sessionToken；ListObjectsV2 分页 |
| onedrive.ts | Graph `root:/path:/content` PUT upsert；逐段编码；parentReference 列表；401 自愈 |
| syncOrchestrator.ts | rev 逻辑时钟状态机 syncWithCloudRev 四分支 + pushEnvelope（put→get 回读 sha256 校验） |
| syncState.ts | 本端同步状态 {lastKnownRemoteRev, baseSnapshot} 按源共键存储（可选 DEK seal）+ loadDeviceId |
| multiTarget.ts | 多云目标编排：primary 裁决 + replica 收敛复制（跳过/推平/并入） |
| oauthRefresh.ts | refresh_token 换 access_token：会话缓存+单飞行+4xx/5xx 分类+轮转回传 |
| canonical.ts / targetPath.ts | 规范化 JSON+内容 hash（contentHashVault 剔除 rev 水位）；路径解析/穿越校验+同秒防撞 |
| gist.ts / webdav.ts | 另两后端（gist delete=置空；webdav PROPFIND） |
| core sync/chunks.ts | 浏览器同步分片层：≤5500B 切片、严格合并校验、陈旧键计算 |
| ext syncEngine.ts | chrome.storage.sync 区 LWW rev 引擎：分片推拉、先拉后推、F14/F6 防护、mkSerialized 串行化 |
| ext syncScheduler.ts | 云同步跟随调度器：锁定零网络 gate、解锁边沿+轮询、in-flight 防重入、401/403 停轮询 |
| ext lockEnforcer.ts | idle 自动锁定执行器：30s tick、阈值钳制 15s~4h、降级 |
| ext cloudCredStore.ts | 源域读写+旧键迁移（幂等）+冲突副本命名/状态格式化 |
| ext conflictCopies.ts | 冲突副本 storage.local 列表：限 5 滚动删、显式导出 |
| ext cloudRunnerFactory.ts | 宿主 runner 装配：store/i18n/conflictCopies/badge 桥接 ui createCloudSyncRunner |

## B. 场景枚举

### B1. syncWithCloudRev 状态机
1. 云端无对象→uploaded，rev=known+1，v3 头 base 声明
2. preview+无对象→仅预览零写
3. 远端口令不匹配/结构坏→抛中文，零写零副本
4. 双方未动→in-sync 零写
5. 远端已变内容一致→in-sync 仅刷基线
6. 远端变本地未动→downloaded
7. 本地变云端未动→uploaded rev=remote+1（base 声明=旧远端 rev+旧内容 hash，Critical-2）
8. 双方动→三方合并；baseOk 失败→降级两方（mergeDegraded）
9. merged apply：先 onConflictBackup 存合并前本地→回调 reject/throw→整体失败绝不上传；rev=max(remote,known)+1 单调
10. merged preview 零写
11. 同 rev 碰撞→视为远端已变走 downloaded/merged（Critical-1）
12. v2 远端（readSyncHeader=null）→保守内容比对
13. 远端被删后重推→rev 从本端时钟续起不回退
14. keep 源 readPath 分离（判定/下载用 readPath，写入恒走 path）
15. pushEnvelope 回读 sha256 不一致→"云端校验失败"（★ 全库无测试）
16. exists=true 但 get→null 竞态（★）
17. onConflictBackup 同步 throw 形态（★）

### B2. syncMultipleTargets
18. 无 primary→throw 'no primary target'
19. primary 失败→outcome=null+errorStatus 透传，final 回退本地，replica 照常
20. downloaded/merged→final 采纳 appliedVaultJson
21. states 推导：uploaded/merged 记 newRev（T13）；downloaded 记 remoteRev+final；in-sync 仅时钟；remoteRev=null 不写 0；失败原样；★ primary 失败+replica 成功混合形态
22. replica in-sync 零写；★ primary in-sync 时 replica 状态
23. replica 云端落后→推平；无对象→首推 rev=1
24. replica 较新且 final 未动→先两方并入 final 防丢→再推平；并入后一致→in-sync
25. replica merged→final 采纳；二次推平失败→convergeError 不覆盖 outcome
26. preview 整轮只读、states 原样
27. 多 replica 顺序传播、单失败不阻断；disabled 不参与
28. adopted 判定与 conflicts 汇总；★ 全部目标失败收敛

### B3. syncState
29. 无键/adapter 抛（★）→empty；unseal 失败→empty 不抛
30. 条目缺失/非对象→empty；字段类型矫正（★）
31. save 读旧 bag 合并（★ 多源共存）、seal 落盘、set 失败上抛
32. loadDeviceId 首次生成持久、★ set 失败传播

### B4. oauthRefresh
33. 缓存命中（expiresAt-60s>now）；≤60s 重刷；expires_in 缺失/非法（★ 含 0/负数）→3600
34. 并发单飞行（失败也移除可重试）
35. 4xx→CloudHttpError(401)=凭据失效；5xx→普通 Error=瞬时
36. 200 无 access_token→401 语义不缓存；★ json() 解析失败→{}→401 语义
37. 网络失败独立错误（不带 host/path）；缺 oauth 配置→编程错误
38. 轮转 refresh_token≠旧值→onCredChange 合并上抛；同值不触发；★ credKey 稳定性

### B5. GDrive
39. put 主对象：无 fileId 先 POST 创建回存再 PATCH；有则直接 PATCH
40. keep 异名绝不 PATCH 主文件；主对象未建立先按首推建立
41. keep+主对象已删（parents 404）→抛中止不落 root
42. get：fileId 404→null；无 fileId 查询回写；无匹配→null 不发 media
43. delete：主对象名→删 fileId；异名→parent 圈域查询删（writeBack=false）；查不到静默；parent=null 静默
44. exists：resolveId 404→false
45. listBackups：同父列 vault-*；fileId 缺失列 'root'；★ 404→空数组；分页 ≤10 页（★）；★ nextToken 空串容错；单引号转义防注入
46. 401 OAuth 自愈：刷新重试一次恰两次 API；无 oauth 照抛；★ createFile 缺 id；★ get body 非法

### B6. S3
47. SigV4 四步官方向量；重复头按序合并
48. virtual-host 默认/path-style（endpoint 或 forcePathStyle）；★ endpoint 尾斜杠归一
49. STS sessionToken 参与签名；prefix 归一；uriEncode RFC3986
50. get 404→null；exists HEAD；非 2xx→CloudHttpError；网络失败→cloudFetch 中文
51. listBackups 服务端前缀+末段过滤+分页 ≤10 页（★）；query 参与签名
52. delete 204 幂等；★ put/delete 网络失败；opts.now 注入

### B7. OneDrive
53. put=PUT content upsert；get 404→null；逐段编码；listBackups parentReference 过滤、★ item 404/缺 parentId→空数组、@odata.nextLink 分页（★ 空串）；401 自愈+轮转

### B8. targetPath/canonical/chunks
54. resolveObjectPath：缺省名、trim、空/纯分隔符回退、`\0`/`.`/`..`→抛、反斜杠正规化
55. 同秒撞名→推进一秒（★ 模块级记忆无 reset 钩子，跨用例污染）；时钟回拨同推进
56. contentHashVault 剔除 rev；canonicalJson 键序稳定
57. chunks：空 payload 单片；多字节按字节切；≤8192 断言；mergeChunks 全量校验（rev/updatedAt/total/part 覆盖/base64/UTF-8 fatal）任一失败→null；staleChunkKeys；maxDataBytes 校验

### B9. ext syncEngine
58. push 前 remoteHasNewer→先 pullOnce 再重读（pull 后仍 newer→放弃推送宁缺勿覆盖）
59. 无 meta→直推；本端无 vault→不推；★ 密文缺 security→error 拒推
60. rev 单调；settings/security 存在才同步；stale 清理；appliedRev 先行落盘防回环
61. push 后 getBytesInUse>90%→quota（★）；异常→error；状态写失败不扩散
62. pull：syncEnabled false 不拉；无 meta/rev≤applied 无操作；分片只取同 rev+updatedAt+total 版本（★ 旧残片排除）
63. mergeChunks null/非 JSON→error
64. 远端密文缺 sync:security→error 拒应用（★）
65. F14：远端明文+本机加密→拒绝降级（不覆写不删 security 不采用 settings，仅推进 appliedRev+conflict）
66. F6：远端明文非法→拒落盘+invalid；★ 本端 settings 损坏退化整体采用；★ 明文→明文移除 security 正向路径
67. mkSerialized：in-flight 重入→pending 再跑一轮（★）；run 抛错 inFlight 复位
68. pushSync 双保险复核；markSyncOff（★）；setSyncStatus ok/quota 算 pct（★ getBytesInUse 抛错→undefined）

### B10. syncScheduler
69. gate=isUnlocked && autoFollowEnabled（锁定零网络承诺）
70. 解锁边沿触发；intervalMs=null 不轮询；stop 清理
71. in-flight 重入跳过（★）
72. runPull 成功→authFailed 复位；isAuthError（status 优先+文案定界兜底）未置位→置位+停轮询+onAuthFailed 一次；重复 401 不重复通知；非认证错误不断调度
73. start() 复位 authFailed；resume() 复位+重启轮询不重挂钩子、幂等

### B11. lockEnforcer
74. 每 30s 现读 prefs；null（未加密）不动作；idleMinutes≥1 且阈值变→setDetectionInterval（钳制 15s~14400s，成功才缓存，失败下 tick 重试）
75. queryState 传钳制后入参（C3）；locked+lockOnSystemLock→lock；idle+≥1→lock；active/禁用不锁
76. idle API 不存在→上报一次不启定时器（N1）；API 抛错→onError 不上抛；lock 只调 deps.lock()；start 幂等、stop 清理

### B12. cloudCredStore
77. 迁移：cloudCreds 数组优先→cloudCred 单对象回退；双缺失→清 revs 返 0；'[]' 合法→删自身+revs 返 0；坏 JSON→返 0 且旧键全保留
78. 源构造：id=backend、name=LABEL、retention overwrite、role replica；去重首现胜+existing 优先
79. 先写新（sources→creds→revs 平移）后删旧；任一步抛错中止上抛旧键保留重跑自愈（★ saveSources 抛错、★ loadSources 抛错）
80. cloudRevs 全表平移；无→cloudRev 仅首源；非迁移源 revs 不平移
81. 幂等：成功后重跑返 0；hasLegacyCloudKeys 只判凭据键
82. retentionDeletedNote 三态+未知 key 回退；formatAutoStatusText 坏 JSON→null；conflictBackupName 命名

### B13. conflictCopies
83. add 限 5 滚动删、无 sourceId 通用名；list 坏 JSON/抛错→空不阻断（★ get 抛错）、形态不符逐条丢弃；export 显式下载、无名→false

### B14. cloudRunnerFactory（★ 零直接测试）
84. revSeal 三态：加密→DEK 密文；未启用→明文回落；锁定在途→抛 'vault locked' 不得明文回落；unseal 失败回落原文
85. loadSources 过滤 local 源与无凭据源；sourceName 缓存每轮刷新、取不到回退 id
86. run 包装：onAuthFailure 暂存→run resolve 后转 reject+status 挂错误对象（否则调度器停轮询分类永不触发）
87. 桥接：saveConflictBackup→addConflictCopy（Promise 交回）；onMergeConflicts fire-and-forget 失败不扩散；onConflicts→badge「!」；recordStatus 不 await；onRetentionDeleted→retentionNotes（deleted=0 不追加）；kdfProfile/persistAdopted/onManualConfirm/onProgress 透传

## C. 缺口汇总（测试文件：cloudSync、multiTarget、syncState、oauthRefresh、cloudDrive、cloudS3、cloudWebdav、targetPath、canonical×2、syncChunks、twoDevice×2（core）；syncEngine、syncScheduler、lockEnforcer、cloudCredStore、conflictCopies、revSeal、popupSyncTiming（ext））

cloudRunnerFactory 零直接测试（函数 42.85% 全部来源）；syncEngine 缺口=分支 71% 主因；targetPath 模块级状态无 reset 钩子。

## D. seam

网络唯一 seam=全局 fetch（vi.stubGlobal + new Response，四后端测试均此模式；新增后端必须继续走全局 fetch）；oauthRefresh 有 `__resetOAuthCacheForTest`；targetPath 无 reset（P2 补）；时钟 S3 有 opts.now，其余 Date.now()；extension storage 用 extApiMock 惰性桥+globalThis.chrome 内存 shim（makeArea）；DOM 仅 conflictCopies export 用文件级 jsdom 注释；密文随机 IV→断言用 contentHash 口径+openBackupEnvelope 解开；编排层用 fakeBackend()（内存 Map）注入 CloudBackend。

## E. 权威文档

docs/superpowers/specs/2026-09-22-sync-ux-mcp-tools-design.md（§1 逻辑时钟内核/§2 单选/§3 三方合并/§4 冲突强提示/§5⑦ OAuth）、2026-09-21-cross-device-sync-design.md、docs/plans/2026-09-14-plan10-cloud-sync.md、2026-09-14-plan9-browser-sync.md、2026-09-17-backup-sources-and-crypto-design.md、docs/review/2026-09-24-full-audit-fixes.md（Critical-1/2、I2/I3、M2、T13 锚点）、2026-09-18-plan13-16-full-code-review.md（C3）。

---

# 4. ui 交互域（packages/ui）

## A. 职责（关键模块）

| 模块 | 职责 |
|---|---|
| store.ts | 全局响应式 vault/settings store：加密状态机（启用/禁用/换口令/解锁/锁定、双窗口 windowId 隔离、DEK 持久化、rev 水位防回滚）、串行写队列、storage 通知重读、保管区、合并冲突记录与裁决 |
| clipboardImport.ts | 手动页"从剪贴板导入"：读剪贴板快照（图+文）、文本意图分流 |
| otpauthFlow.ts | otpauth URI→EntryForm 预填 |
| sqliteLoader.ts | sql.js 懒加载：本地 wasm SHA-256 强校验→内存 SQLite 打开/查询/释放 |
| iconImport.ts / iconStore.ts | aegis-icons zip 有界解压导入（防炸弹）+ 上传图标缩放；图标存储两命名空间 |
| clipboardClearer.ts | 复制后 30s 清剪贴板定时器 |
| popupFilter.ts | popup 四级回退过滤 |
| prf.ts | WebAuthn PRF 封装 |
| qr/* | decodeQr（jsQR+otpauth 校验）、imageSource（剪贴板图片收集）、qrDraw（uQR 矩阵/canvas）、qrSheet（多选拼版） |
| theme/* | palette（10 色板）、loadPalettes、useTheme（三元+系统暗色+localStorage 镜像） |
| composables/useOtpCodes.ts | 每秒重算全部验证码 |
| pages/* | CodesPage、ImportPage、SyncPage（三区块+健康条 30s 轮询）、SecurityPage、SettingsPage（五卡）、NavigationShell（五页壳，<600px Rail→Tabs） |
| components/* | LockScreen（口令/Passkey/DPAPI 三通道）、SecurityCard、BackupCard、BackupSecretCard、CloudCard、cloudRunner.ts、cloudPlatform.ts、cloudSyncBridge.ts、SyncCard、SyncHealthBar、ImportCard（19 格式六步状态机）、BatchPastePanel、EntryForm*、OtpListItem、OtpQrDialog/QrSheetDialog、TagFilterRow/TagManagerDialog、SearchBar、MergeConflictList/MergePreviewDialog、McpServerCard+mcpCard.ts、parseVaultJson.ts、md/*（13 个 Material 基础组件） |

## B. 场景枚举（重点摘录，★=无测试）

### B1. store 状态机
1. initStore 7 分支：明文解锁/空库建库/密文无 DEK→locked/dekPersist 自动恢复（失败→lock）/同窗口已持 DEK 一次前进/明文+SECURITY_KEY 半失败恢复态（锁定不采纳，口令解锁后采纳自愈）/vault 坏 JSON→'vault corrupted'
2. lock()：代数++、清 DEK/vault/保管区/会话口令/冲突/dekPersist、onLocked 末尾回调（desktop 清 Rust 暂存槽）、security 缓存保留
3. unlock：错口令原样抛；成功→读盘解密→回滚守卫→装载保管区→前进内存→dekPersist.set；★ 宽容路径（盘上明文/缺失也接受）
4. F12 PENDING 恢复：双条件转正（能解 PENDING+GCM 证明能解盘上 vault）；陈旧/异体 PENDING、vault 明文→原样抛不删；主路径成功清孤儿 PENDING
5. passkey/DPAPI 注入 unlockWithDek：32B 校验、security 缓存缺失从盘补读
6. commit：锁定拒绝；未加密写前核对盘上 security（远端已启用→转锁定拒绝，防明文覆盖密文）；队列串行、单任务失败不传染
7. saveVaultToStorage 加密分支：写前再核对（被远端删除→丢 DEK 跟随明文；换口令→刷新缓存照常写；IO 失败保守视为存在）；rev 单调先记录后水位
8. F7 锁定代数：enable/changePassphrase/unlock/commit 各 await 后复查，期间 lock 即中止
9. changePassphrase staged 四步（PENDING→全库重加密→保管区重封→转正）；期间被锁→盘上新口令态、内存锁定；rotateDek=false 仅重包裹
10. registerStorageSync：自写抑制窗跳过；锁定不消费；密文+无 DEK→lock；异谱系→lock+刷新 security；同谱系回滚密文→拒绝采纳不上锁（自愈覆盖）；security 在场拒远端明文
11. settings 通知→重读 Object.assign（未知字段丢弃）；secretBag 通知→解锁态重读
12. enable/disableEncryption：Argon2 期间并发写排队；先写 security 后写密文（崩溃窗口可恢复）；disable 需解锁+已启用、删保管区/PENDING
13. 保管区：setBackupSecret trim 非空、remember 需加密+解锁；forget 重封写盘；save/removeSourceCredOp 守护+密封；migrateLegacySecrets 幂等+半失败自愈
14. 合并冲突：addMergeConflictsOp 同 id 替换超 100 裁最旧；resolveMergeConflictOp null 侧=确认删除；seal/unseal 未启用=null 回落、锁定=抛 'vault locked' 拒明文落盘
15. ★ commitSettings 串行/抑制窗细节、★ unlockViaPending 全拒绝分支、★ readVaultRevWatermark 非法形状

### B2. 剪贴板导入
16. readClipboardSnapshot：★ 完全未测——有图有文图优先、多 item 合并、clipboard.read 抛错→"读取失败"
17. 空文本→错误；单行 otpauth（含 yaotp/steam）→prefill；多行→批量；1 条→prefill、>1→batch、0 条+failures→首条失败、parser 抛错透传、unsupported→2FAS 单条兜底（形状不符回 unsupported）；batch 无能力→降级错误
18. importBatchEntries：批内 dedupe→planImport 剔 identical→apply→实际条数（全 identical=0）
19. 图片剪贴板→QR 识别→预填（保留已填 note/tagIds/icon）

### B3. sqliteLoader
20. 动态 import 失败/fetch 失败/HTTP 非 ok（★）→"本地资产加载失败"；SHA-256 不符→拒绝实例化（已测）；★ initSqlJs 失败；★ new Database 损坏→"已损坏或不是 SQLite"；★ query 错误包装；ImportCard：无字节能力→"当前端不支持"、自动复查失败静默、手动失败进 picked 页、非 SQLite 头→"头校验失败"、无已知表→"未知库"

### B4. QR
21. 无摄像头功能（只有图片/剪贴板路径）；粘贴图片：createImageBitmap 失败→"图片读取失败"、非码→"未识别到二维码"、非 otpauth→精确错误；多图逐张（单失败不阻塞）；同码两次→去重；拖入非图片→preventDefault；斜拍低质量→同"未识别"
22. 生成侧：单条 OtpQrDialog、多选拼版（列数 ≤4→2/≤9→3/其余 4、moduleSize 下限 2、★ 绘制循环与单元绘制）

### B5. SettingsPage
23. 主题三选/色板/AMOLED/语言直写 commitSettings；★ setThemeContrast、setAutoFollow 未测
24. blurHideEnabled/autoFollow/urlFilterEnabled/clipboardClearEnabled/rememberTagFilter 布尔直写；popupCloseDelayMs：空串/非有限/负忽略、小数取整
25. ★ devtools 卡与释放策略卡全部逻辑：onMounted 预填、端口 1024-65535 校验回显、失败错误横幅、分钟 0-1440（空串守卫防静默 0）、锁库开关即点即提交
26. 互踩语义：整对象串行提交；跨层键（Rust 持有 mcp/releasePolicy/devtools/shortcut）由宿主合并保留；远端通知回读不回滚本端未落盘编辑

### B6. 同步页
27. SyncPage：三区块按能力渲染；健康条=conflictCount+云摘要（失败→null 不渲染）+浏览器摘要（readStatus 异常→"同步出错"；六态文案）；★ 30s 轮询自愈
28. SyncCard：开关失败→err 通道；canSync=false 禁用；明文同步警示；★ invalid/off 态、★ 轮询清理
29. CloudCard 手动同步：无口令/无源→错误；缺凭据源跳过不阻塞；preview merged→MergePreviewDialog（60s 超时=取消）；逐源四动作文案；口令不匹配→"重置云端"两步救济；keep 源滚动删除；downloaded/merged→parseVaultJson 合法才两步确认采用；全目标成功才 onManualSynced
30. CloudCard 源管理：五后端添加、空白凭据直删 vs 已存两步、锁定态一律确认；明文 http 警告+勾选确认（按会话复位）；primary 互斥选举置首；孤儿凭据对账
31. cloudRunner：跳过态 recordStatus(null)；single-flight；auto 内容门（命中→pull-only、部分失败→门置 null 强制重试、manual/pull 不设门）；pull 通道；逐源进度；基线回写失败源隔离；错误截断 100 字符

### B7. 其他组件
32. MCP 卡：getConfig 失败→错误横幅空卡；exposedTools 缺字段→兜底只读档；全部"乐观前进→setConfig→对账→双失败回滚 prev"；端口逐键提交非法回显；随机端口 49152-65535；token 掩码/空置灰/重生成/吊销两步；busy 防重入（★ 组件层全未测，函数 17.4%）
33. LockScreen：空口令提示、busy 守卫、明/密切换、Passkey 显隐、逐来源失败统一文案、DPAPI 静默失败 1s 出重试
34. SecurityCard：启用两口径校验、关闭两步（I71 失败也复位）、换口令 rotateDek:true、KDF 档位确认、锁定策略三控件（unsupported 隐藏）、>180 天强调、剪贴板设置锁定态禁用
35. BackupCard：无口令禁用；恢复（picker/name）→首发失败静默展开回退→重试失败显式报错→内容非法不误导（不进回退）→确认覆盖；四格式导出（明文两步确认、aegis 加密免确认、取消=false）；本地源增删改（keep n 钳 1）；★ retryPasswordOnNeed、★ authenticatorPlus 字节通道、★ emptyGoesBack
36. CodesPage：pinned 排序、搜索（I49）、标签 any/all+持久化（悬空剔除、晚装载补偿）、复制（HOTP counter+1）、删除两击 3s、右键四项、拼版保存、批量 toast 4s
37. NavigationShell：五项导航、<600px Tabs（同步测量防闪变）、copy 监听仅挂 /codes、pageProps 精确分发；★ mql 运行时切换
38. iconImport：10MB 入口拒/500 成员拒/8MiB 产出预算拦截炸弹/EOCD 预检/字典序后者覆盖；iconStore：URL 拉取四类细分、urlcache: 隔离
39. clipboardClearer：30s、禁用不清、重复复制重置+作废旧链、dispose 补清、失败重试 2 次后固定 warn
40. popupFilter 四级回退全分支（"纯 tag 浏览零命中不放宽"）；useOtpCodes：INVALID+error 悬停、progress、HOTP 按 period；parseVaultJson 逐字段中文错误；md 组件已较全

## C. 缺口（测试目录 test/，77 文件）

主要缺口：readClipboardSnapshot 零覆盖；sqliteLoader 失败分支（41.7%）；qrSheet 41%/imageSource 41%/qrDraw 60%（绘制循环）；McpServerCard 组件（59.6%/函数 17.4%）；SettingsPage devtools/release 卡（71.8%）；SyncPage 分支 57.9%；SyncCard invalid/off；NavigationShell mql；ImportCard 重试链/字节通道（79.6%）；EntryForm 剪贴板链路；BatchPastePanel parser 抛错/全 identical。

## D. seam

vitest environment jsdom + @vue/test-utils 普遍使用；i18n 用 test/helpers/i18n.ts；navigator.clipboard.read jsdom 未实现→vi.stubGlobal；canvas 2d 缺失→记录调用假 context（或拆纯函数）；matchMedia 有 spyOn 范例；sql.js 可真实加载 wasm 端到端（失败分支 mock）；WebAuthn globalThis stub（prf.test.ts 范例）；定时器 vi.useFakeTimers（已有范例）；store 自写抑制 selfWriteSuppressMs:0 注入；宿主平台能力全走接口注入 fake。

## E. 权威文档

docs/review/2026-09-24-full-audit-fixes.md（D1-D4、P0 互踩、onLocked 桥）、docs/plans/2026-09-13-totp-tool-design.md、m1-plan8/plan5-import、plan9-browser-sync、plan10-cloud-sync、plan11-unlock、plan6-security-and-ux、2026-09-17-backup-sources-and-crypto-design.md、2026-09-21-mcp-server-design.md、2026-09-15-frontend-redesign-design.md、2026-09-16-settings-ux-design.md、docs/superpowers/specs/2026-09-22-sync-ux-mcp-tools-design.md、2026-09-23-batch8-improvements-design.md、2026-09-18-tag-upgrade-design.md、2026-09-21-ui-fixes-entry-interaction-design.md、2026-09-20-enhancement-roadmap-design.md。

---

# 5. extension 平台层（apps/extension）

## A. 职责

| 文件 | 职责 |
|---|---|
| entrypoints/background.ts（170 行，0%） | MV3 service worker：右键菜单注册/点击（otpauth 链接、图片 QR）、消息路由（schedule-clipboard-clear/sync-push/sync-pull）、alarm→offscreen 清剪贴板（3 次重试+ack）、storage.onChanged(sync) 触发拉取、SW 冷启动首拉 |
| entrypoints/offscreen/offscreen.ts（32 行，0%） | offscreen 持 CLIPBOARD 授权：收 clear-clipboard→写空串（失败回退 execCommand）→sendResponse+ack |
| entrypoints/options/App.vue（520 行，0%） | 管理页宿主：独立 store（dekPersist=session）、四 platform 装配、三调度器（自动云同步/跟随拉取/idle 锁定）、旧数据迁移、badge 对账、i18n |
| entrypoints/popup/App.vue（79.5%） | popup 主界面：列表/四级过滤、复制+30s 清剪贴板、双击揭示、HOTP 递增、新建双 Tab、编辑/删除确认、右键菜单、QR 对话框、otpauth 三入口预填、跟随拉取、锁定态 |
| src/extApi.ts | ext=browser??chrome 统一通道+四能力探测（canOffscreen/canIdle/canSetBadge/canOpenPopup） |
| src/qrDecode.ts | 图片字节→解码→otpauth 校验→uri|null（失败统一 null） |
| src/storage.ts | ext.storage.local→StorageAdapter（ext undefined 短路兜底） |
| src/store.ts | createExtensionStore：onChanged 映射、onCommitted→sync-push、冲突计数+badge、popup 单例 |
| wxt.config.ts | 双端 MV3：chrome 追加 offscreen 权限；firefox gecko id/strict_min_version 140/protocol_handlers |

注意：`src/parsingOtpauth.ts` 不存在（URI 解析在 ui 包 otpauthFlow.ts 与 core uri.ts normalizeExtOtpauth）。

## B. 场景枚举（★=无测试）

### B1. background.ts
1. SW 每次冷启动注册两个 contextMenus（幂等吞 lastError；C11：不放 onInstalled）★
2. SW 冷启动立即 pullSyncIfNewer 兜底（浏览器关闭期间他端推送不触发 onChanged）★
3. 被杀后收 sync-push→消息唤醒 SW，1s 合并窗口重新计时不丢 ★
4. otpauth-add：非 otpauth/解析失败→notification；成功→set pendingOtpauth+canOpenPopup() 探测 openPopup（Promise catch 吞/不存在吞）★
5. qr-decode-image：fetch(srcUrl)→arrayBuffer→decode；★ fetch 拒绝/CORS、解码失败→notification"图中未识别"；成功→pendingOtpauth+notification
6. 消息协议 ★：schedule-clipboard-clear（delayMs 缺省/非 number→30_000；when 绝对时间满足 Chrome 30s 下限；同名 create 覆盖=重置计时）；sync-push（1s debounce→pushSync，engine 复核 syncEnabled）；sync-pull（立即 pullSyncIfNewer）；其他忽略
7. alarm 到点→clearClipboardWithRetry ★：最多 3 轮，每轮 ensureOffscreenDocument（createDocument 失败→放弃）→挂一次性 onMessage→sendMessage，1s 超时或收 ack 结算；失败重试
8. storage.onChanged 且 area='sync'→pullSyncIfNewer（本端回环由 appliedRev 防重入）★

### B2. offscreen.ts
9. 收 clear-clipboard→writeText('')；无焦点被拒→textarea+execCommand 兜底 ★
10. 完成→sendResponse({ok:true})（channel 关闭吞）+sendMessage ack（sendResponse 不可用时 SW 也能感知）★；listener 返回 true；非本消息 return

### B3. popup/App.vue（★ 缺口 15 项）
11. locked→LockScreen（allowPasskey=false）★；启动序列：initStore→首拉 syncNow（终审修复：initStore 后，session DEK 恢复路径无解锁边沿）→useTheme→registerStorageSync→rememberTagFilter 恢复（悬空 id 过滤；有效空集不赋值）→icons.init；任一异常→error 横幅；finally loaded=true ★
12. 粘贴框导入：applyOtpauthPrefill 成功→清错误/收起/置 prefill/creating/显式切回 manual Tab/formKey++/清 textarea；失败→importError ★
13. URL 带 ?uri=（Firefox ext+otpauth 回调）优先消费 ★；否则读 pendingOtpauth（Chrome 右键写入）读取即 remove ★；均 normalizeExtOtpauth；非法→importError（常显不随 details 折叠）★
14. 排序 pinned→order；URL 过滤：tabs.query 仅 http(s) 启用、开关 commitSettings、四级回退链+hint ★；标签筛选持久化+悬空剔除 ★
15. copy：无码 return；成功→copied 横幅+scheduleClipboardClear+HOTP 复制旧 counter 后 +1+popupCloseDelayMs 后 close ★；writeText 拒绝→copyFailed 横幅不武装关窗（已测）；双击揭示→cancelAutoClose（已测）；★ scheduleClipboardClear 三重门控（开关/canOffscreen/sendMessage 吞）
16. 新建双 Tab（watch creating 复位 manual）已测；保存：type 变更重算 digits（steam→5）★；carried=prefill 透传 URI 参数（hotp 带 counter）；否则 toOtpDigits 收口（yandex 恒 8）已测 R1
17. 删除两击 3s 超时复位 ★；右键菜单四项（编辑/二维码/复制 URI（yandex→yaotp+pin）/置顶）★；openSettings：tabs.create(options.html#/settings) ★

### B4. options/App.vue
18. 挂载序列：initStore→useTheme→registerStorageSync→icons→runLegacyMigrations→refreshCloudAutoPrefs→scheduler.start→followScheduler.start→cloudAuthFailed 镜像→首拉 syncNow→lockWatcher.start→badge 对账（真值校正坏值→0）★；initStore 失败→loadError 不启调度器 ★；卸载三 stop ★
19. 迁移：仅解锁态；migrateLegacySecrets→migrateLegacySources；N>0→migrateNote；跳过/失败且 hasLegacyCloudKeys→legacyNote（I6：未启用加密 saveCred 走不通必须有提示）；先写新后删旧幂等 ★
20. securityPlatform：启用/禁用/改口令透传 opts（漏接=档位切换误触发全库轮换）、kdfProfile/passwordChangedAt、PRF、lockPrefs（unsupported:['lockOnRestart']）★
21. syncPlatform：setSyncEnabled(true)→commit+sendMessage sync-pull（缺这次新设备永不应用远端）★；false→markSyncOff 直写 off；readStatus 形状不符→null；canSync=!!ext.storage.sync ★
22. backupPlatform：createBackup（kdfProfile 档位+命名化石 backupMode='overwrite'→固定名+Blob 下载+摘要）；restoreFromPicker（取消/旧内核 30s 超时 reject"文件选择超时"）；readImportFile 多扩展+缓存 lastImportFile；readImportFileBytes 复用或补弹（字节通道防二进制损坏）★
23. cloudPlatform：loadSources/saveSources（明文键）；saveCred/removeCred 保管区 op（锁定态中文报错）；persistDownloaded=replaceAllOp；saveConflictBackup→addConflictCopy（限 5 滚动）；revSeal 共用 cloudSyncState 键（两侧同形态防互踩泄漏，审查 Critical 1）；autoPrefs normalize（缺失位 false、间隔<15 回退 60）+先更缓存再异步落盘；onManualSynced→followScheduler.resume()+authFailed 复位（I1）★
24. 调度：scheduler debounce 10s+interval 双开关过滤、不用 ext.alarms（SW 无 DEK 无法加密——options 页存活期运行）★；followScheduler intervalMs=autoFollow?180_000:null、watch 重建（M4）、start 复位 authFailed、onAuthFailed→镜像+停轮询 ★；lockWatcher 现读 settings（hasEncryption=false→null）、lock 只调 store.lock() ★

### B5. src 模块
25. storage：ext undefined→null/no-op；缺键→null（部分间接）
26. extApi：browser 优先；四探测按成员存在性 ★ 直测
27. qrDecode：非图片→null（已测）；★ 解码非 otpauth→null；★ 合法→uri
28. store：scheduleSyncPush syncEnabled!==true 短路 ★、sendMessage 异常吞 ★、commitSettings 未初始化抛 ★；popup 单例与 options 共享 session DEK

### B6. Chrome/Firefox 差异矩阵（测试必列）
29. offscreen 仅 Chrome：canOffscreen 门控，Firefox 降级不调度（验证码留存）；offscreen.html 构建期对 firefox 排除（manifest.include）★ 产物断言
30. Firefox protocol_handlers ext+otpauth→/popup.html?uri=%s；Chrome 不支持→右键+粘贴兜底
31. openPopup 仅部分 Chromium（探测+静默）；Firefox MV3 background=event page；idle/storage.session(140+) 双端可用

## C. 缺口（测试文件：store、qrDecode、syncEngine、syncScheduler、dekSession、lockEnforcer、conflictBadge、cloudCredStore、conflictCopies、revSeal、popupApp、popupSyncTiming）

零测试：background.ts、offscreen.ts、options/App.vue、options/main.ts、popup/main.ts、wxt.config.ts、extApi 直测、pendingOtpauth。

## D. seam

chrome.* API 面 ~12 域（contextMenus/alarms/storage/runtime/notifications/action/offscreen/tabs）；已有三层 mock：① test/helpers/extApiMock.ts 惰性 getter 桥（凡 import ext 的模块必须挂）；② globalThis.chrome 内存 shim（各文件重复手写→P0 收敛 fixture，需补 alarms/runtime 双向通道）；③ popupApp 整模块 store mock+组件桩+createTestI18n；WXT defineBackground 编译期全局→stub `globalThis.defineBackground=(cb)=>cb()` 后回调体（纯注册逻辑）可断言；background QR 分支 mock fetch；offscreen 用 jsdom+clipboard mock；wxt.config 可 import 调 manifest({browser}) 纯数据断言；qrDecode node 无 canvas→mock @totp/ui decodeQrToUri 三分支；环境切换用文件头 `// @vitest-environment jsdom`。

## E. 权威文档

docs/plans/2026-09-13-totp-tool-design.md（§10 插件形态）、2026-09-14-plan9-browser-sync.md、2026-09-14-plan12-otpauth-and-spec.md、2026-09-17-backup-sources-and-crypto-design.md（T11/T12/T13）、docs/superpowers/specs/2026-09-21-cross-device-sync-design.md、2026-09-22-sync-ux-mcp-tools-design.md（badge「!」/冲突副本限 5/废自动下载）、2026-09-23-batch8-improvements-design.md（extApi/clipboardRead/offscreen 降级；wxt/browser 迁移已被裁定 D2 否决）、docs/review/2026-09-24-full-audit-fixes.md（D2/D3、firefox offscreen 排除）。

---

# 6. desktop 前端（apps/desktop/src）

## A. 职责（19 文件，13 个 .test.ts）

| 文件 | 职责 |
|---|---|
| App.vue（903 行，0%） | 主窗口壳：初始化 store/i18n/主题/图标+6 个平台适配器（备份/云/安全/MCP/devtools/释放策略）+自动备份/云同步 runner 接线+空闲/系统锁/失焦隐藏+DEK 暂存回注+旧数据迁移编排+MCP 事件桥+审批对话框+剪贴板管理 |
| MiniApp.vue（147 行，0%） | Mini 窗口：只读码列表（windowId='mini' 独立 DEK 隔离、无解锁 UI）、聚焦重载、复制+HOTP 递增、500ms 自动隐藏、force-lock 联动 |
| McpConsentDialog.vue（0%） | 审批对话框两形态分流：首连三键（deny/once/trust）与工具确认两键 |
| tauriFs.ts（36%） | StorageAdapter 适配 plugin-fs：settings.json 读改写合并（保 Rust 外来键，P0）、tmp+rename 原子写、mkdir |
| tauriSecurity.ts（54%） | OS 自动解锁通道：os_auto_protect/unprotect/forget+DEK 32B 双层校验+v2 熵绑定判定 |
| importService.ts（0%） | 导入文件 OS 通道：pick+文本/字节读取（dirToken 遏制）+WinAuth DPAPI |
| backupService.ts（82%） | 备份源落盘核心：多源（keep/overwrite、滚动删除）、dirToken 授权句柄、聚合列表、按名读取（RE 白名单）、冲突副本命名、云源合并写、跨平台 joinBackupPath |
| autoBackup.ts（96%） | desktop 自动 runner：backup/cloud 双通道（10s 防抖+interval ≥15min）、decideAutoRun 守护、single-flight、runBackupNow、formatAutoStatusText |
| idleLock.ts（100%） | 空闲锁定执行器：1s 节流+30s tick+shouldLockNow |
| lockPrefs.ts / miniAutoHide.ts / miniSort.ts（100%） | UA→不支持键；复制后自动隐藏（揭示代次快照守卫）；mini 排序 |
| mcpBridge.ts（100%） | MCP 请求处理：filterAccounts、toPublic 字段白名单（防 secret 泄漏）、4 工具分发、createMcpTriggers |
| mcpApprovalQueue.ts（95%） | 审批 FIFO：同 ident 10s 去重（按通道隔离）、先弹队首再回执、close=deny、dispose 快速失败 |
| legacyMigrate.ts（93%） | 旧数据迁移：backupMode 等三键→默认本地源；cloud 四键→源模型+保管区+基线平移（先写新后删旧、幂等） |

## B. 场景枚举（完整清单见调查原始报告，此处收录主干，★=无测试）

### B1. 初始化/生命周期（App.vue）
1. 启动全链：system-lock 监听→activity→失焦隐藏→createTauriFs→createVueStore('main', onCommitted→notifyChanged, onLocked→clear_stashed_dek)→initStore→force-lock/stash-dek-request 监听→take_stashed_dek 回注→i18n→runLegacyMigrations→auto.start→useTheme→iconStore ★
2. initStore 抛错→loadError 原始消息→i18n 未装入 tr 兜底回 key→"加载失败"不渲染 Shell ★
3. store 未就绪所有 platform 方法→"数据尚未就绪" ★；schemesApi.load 坏 JSON→[] ★
4. 卸载：auto.stop、mcpStop、7 个 unlisten、idleLock.stop、approvalQueue.dispose（未决工具确认回 false）★；MCP 装配失败仅 warn 降级不拦主流程 ★

### B2. 锁定链路
5. 空闲超时判定+1s 节流重置；lockOnSystemLock 开关即时生效（回调现读）；lock 幂等；store 未就绪→isLocked 兜底 true 恒不动作
6. 锁库路径 onLocked→invoke clear_stashed_dek（best-effort）★；force-lock 事件→lock() ★
7. stash-dek-request（不锁库销毁路径）→getCurrentDek 非空→stash_dek base64；锁定/未启用 DEK=null 不上报 ★
8. 冷启动/重建：take_stashed_dek→unlockWithDek 恢复；失败 warn 保持锁定 ★

### B3. 备份块（backupPlatform 18 成员 ★ 装配层全无测试）
9. 手动备份：全成功→摘要+lastBackupHash（I8 仅全成功写）；单源失败→partial 明细；全失败→failed；无源→empty 不生成 envelope（autoBackup 层已测，宿主接线未测）
10. retention overwrite/keep+滚动删除（已测）；自选目录→dir_token_os 授权→write_text_file_os 带 dirToken（F4）；默认目录→plugin-fs 原子写
11. envelope 按 kdfProfile 一次生成多源复用（Argon2id 只跑一次）★
12. 本地源增删改→backupSources 持久化；导出 save 对话框取消→false 不做 KDF ★
13. 文本/图片导出（PNG dataUrl 去头）★；恢复（选择器/按名+RE 防穿越）★
14. 聚合列表逐源（单源失败跳过）+倒序+禁用源仍可列出（已测）；pickBackupDir 取消→null ★
15. 云源保存合并写（I11 保本地源并发改动）已测；冲突副本 conflict-{sourceId}-{ts} 恒写默认目录不参与滚动 ★
16. readImportFile 缓存 lastImportPick（path+token 成对，F4 避免二次弹窗）★；readImportFileBytes 复用或补弹 ★

### B4. 自动备份/云通道（autoBackup.ts 已全测，宿主接线 ★）
17. onCommitted→notifyChanged→10s 防抖；守护链三 skip 态；M3 基线=sha256(落盘 json)；partial/failed 基线不动自愈；empty 记状态防误吞；interval 现读偏好；cloud 通道独立不受 backup 影响；runBackupNow 绕偏好门守护照常；single-flight 串行前轮失败不毒化；formatAutoStatusText 8 例

### B5. 云同步（cloudPlatform ★）
18. loadSources 只装配"启用云源×凭据"对（锁定态 credsCache 空→全跳过）★
19. rev 基线 seal 三态：未启用→明文回落；锁定→sealWithDek 抛 'vault locked' 不吞错（绝不落明文 baseSnapshot）；unseal 失败→回落原文 ★
20. 冲突→saveConflictBackup→自动 adopt 不弹确认；写盘失败→该目标失败不采纳不覆盖云端（I9，已有 cloudSyncConflict 探针）；条目冲突 fire-and-forget；retentionNotes 拼接后清空不跨轮 ★
21. 手动合并预览挂起征询（取消/卸载=false 记跳过）★；逐源进度 setSyncProgress ★；内容门基线失败不阻塞 ★

### B6. 安全/OS 解锁（dpapiOps）
22. OS 保护：DEK≠32B 前端先拒；解包返回后 32B 兜底双层校验（★ 未测，tauriSecurity 函数 33% 主因）；isEntropyBoundDekWrap 边界（前缀本身/空串/非法 base64→按旧格式不抛）已测 3 例
23. F3 迁移：解锁态+旧格式→protect 重包；幂等（v2 跳过）；失败仅 warn（Rust 32B 兜底仍可解锁）★
24. 移除 OS 解锁来源→osAutoForgetOs（Windows 报错桩静默）★；解锁方式命名 UA 判定（Mac 排除 iPhone/iPad）★；PRF passkey 添加（随机 32B 盐/exclude/取消→false）★

### B7. 迁移编排
25. 编排顺序：DekWrap→Secrets→backupDir→LocalSource→成功删 localStorage 两键→CloudSources；locked 短路+解锁回调补跑幂等 ★（legacyMigrate.ts 本体已测）
26. 未启用加密 saveCred 抛错→catch warn"旧键保留，解锁后重试" ★

### B8. MCP（mcpBridge 已测，宿主接线 ★）
27. list_accounts：锁定→'vault locked' 直达；输出字段严格 ⊆{id,issuer,label,type,tags}；filter∩url 交集（已测）
28. get_code：缺 account_id/未知 id→错误；hotp 窥视不推进；totp/steam/yandex（已测）；trigger 双工具：guard 前置结构化拒绝→受理即返回 triggered:true（不 await 防 bridge 5s 误报 busy）★
29. 审批事件→enqueue→FIFO 队首显示（独立于锁定 v-if 链，锁定也弹）★；三键裁定→mcp_approval_response；工具确认→onDecide 恰一次（队列本体已测，宿主回执实参形状未测）
30. 对话框关闭按队首通道分流（首连→deny 进冷却；工具→false）★；去重键按通道隔离（conn:/tool:）已测；McpConsentDialog 渲染分流 ★

### B9. 剪贴板
31. 复制→stage_clipboard_write 失败（第三方独占）→copyFailed 横幅 3s（重复失败重置）；Mini 保持可见不武装、HOTP 不推进 ★
32. 成功→clearer.notifyCopied→30s 后 clipboard_clear_if_staged；重复复制重置；dispose 欠清除补清 ★

### B10. Mini 窗口（MiniApp.vue ★）
33. windowId='mini' 独立 store（DEK 隔离互不可见）；未加密可读、加密恒锁定显示提示 ★
34. 聚焦→整链重建 store 重载（initStore 幂等不刷新内存故重建）；失败保留旧数据 ★
35. force-lock→新实例动态解引用 lock()；mini 不监听 stash-dek-request（只读无回注）★
36. copy 编排：beginCopy 快照代次→无码 return→stage 失败保持可见→成功→HOTP 复制旧 counter 后递增（失败静默）→completeCopy 代次未变→500ms hide ★
37. 双击揭示 8s：代次+清 timer；竞态守卫（双击先于 IPC resolve→在途 copy 检出失配不武装）★（miniAutoHide 本体已测）

### B11. tauriFs ★（36% 主因）
38. get：不存在→null；set('settings')：先读旧文本→mergeSettingsPreservingForeign（{...旧,...新}，Rust 四组外来键 shortcutToggleMini/devtools/releasePolicy/mcp 保留；旧坏 JSON/根非对象/数组→回退纯新值）→tmp+rename 原子写（纯函数已测 4 例，adapter 本体未测）
39. set 其它键原样原子写；delete 存在才 remove 幂等；createTauriFs 启动即 mkdir

### B12. 窗口/释放
40. 失焦隐藏：blurHideEnabled+label==='main'（监听一次回调现读）★；隐藏到托盘 getCurrentWindow().hide() ★；释放策略 get/set snake→camel ★；devtools 配置 get/set ★

## C. 缺口

App.vue/MiniApp.vue/McpConsentDialog.vue/main.ts/mini.ts/importService.ts 0%；装配层（backupPlatform 18 成员/cloudPlatform/securityPlatform/dpapiOps/mcpPlatform/releasePlatform/loadBackupPrefs 钳制/unlockNaming）全无测试；tauriFs adapter 本体（36% 主因）；tauriSecurity protect/unprotect（54% 主因）。

## D. seam

invoke 面 25 个 Rust 命令+plugin-fs+7 类事件+getCurrentWindow；无共享 mock 层（仅 backupService.test.ts 完整先例）→P0 建 test/mocks/tauri.ts；vitest environment:node 未装 jsdom/test-utils（3 个 .vue 0% 结构性原因）→P0 补；App.vue 可拆性良好：~700 行为"闭包读 store"形态→纯函数抽模块（项目惯例）+createXxxPlatform(deps) 工厂注入+initDesktopShell(deps)；shallowRef 约束（storeWrap 9 例实证）→mount 测试用 createVueStore(createMemoryStorage(),{windowId})；i18n 依赖 getCurrentInstance→mount 用真实 app 实例，tr 未装入兜底回 key 可断言；Argon2id 慢→vi.mock('@totp/core', importOriginal) 局部替换（backupService 先例；注意 core 内部相对导入 mock 包入口拦不到）；"逐字复刻接线做回归探针"模式（cloudSyncConflict）可推广。

## E. 权威文档

docs/review/2026-09-24-full-audit-fixes.md（权威裁定）、docs/plans/2026-09-15-frontend-redesign-design.md（§7 双窗口隔离/5 页 IA）、2026-09-17-backup-sources-and-crypto-design.md+plan16（I8/M3/I9/I11）、2026-09-21-mcp-server-design.md+plan17（§4 不打扰/§6.1）、docs/superpowers/specs/2026-09-22-sync-ux-mcp-tools-design.md（§6.2/冲突横幅/进度）、2026-09-23-batch8-improvements-design.md（§7.4-7.5 force-lock/stash）、2026-09-21-desktop-devtools-headless-mcp-design.md、2026-09-16-settings-ux-design.md+plan15（I10）、2026-09-13-m1-plan3-tauri-desktop.md、review/2026-09-18-plan13-16-full-code-review.md、review/2026-09-22-six-specs-review-and-verification.md、review/2026-09-23-batch8-real-machine-test.md。

---

# 7. Rust 后端（apps/desktop/src-tauri）

## A. 职责

| 文件 | 职责 |
|---|---|
| main.rs（5 行） | windows_subsystem+调 run() |
| cli.rs（83 行） | 无头 MCP 参数解析（--headless-mcp/--mcp-port/--mcp-token），失败→stderr+exit(2) |
| lib.rs（2082 行） | 全部 tauri 命令+run() 装配。命令组：①剪贴板暂存 stage_clipboard_write/clipboard_clear_if_staged；②DEK 暂存 stash/take/clear；③devtools 配置；④释放策略配置 get/set；⑤对话框授权 DialogGrants（pick_*_os/dir_token_os）；⑥备份/导入文件 IO（read/write/remove/list，dirToken 遏制）；⑦DPAPI/OS 解锁（decrypt_dpapi/os_auto_*）；⑧窗口/托盘/快捷键/释放 tick 接线。金库加解密本体在前端 TS，Rust 只持 DEK 暂存/DPAPI 通道 |
| mcp_server.rs（2153 行） | 内嵌 MCP：配置层（load/save/add_whitelist/override/prepare）、门控纯函数（GateMode/decide_gate/exposure_check/wildcard_match/token_eq/validate_host_origin）、审批记账（GateSessions once-TTL 15min/deny 冷却 60s）、事件桥（BridgeShared+bridge_call 5s+tool_confirm 60s）、rmcp 4 工具、axum 鉴权 middleware（Bearer 恒时+loopback Host/Origin）、6 个 tauri 命令、生命周期（start/stop/restart/init） |
| release_policy.rs（323 行） | 窗口释放策略纯逻辑：配置解析/合并+三段状态机 advance（隐藏→暂停→销毁），副作用在 lib.rs |
| lock_events.rs（176 行，cfg(windows)） | WTS 会话通知：隐藏窗口+消息泵，WTS_SESSION_LOCK→广播 system-lock |

## B. 场景枚举（★=无测试）

### B1. CLI
1. 空参→默认；--headless-mcp；port≥1024+token≥16 全生效（已测）
2. ★ --mcp-token 缺值、★ port 非数字；低端口/短 token/未知参数/缺 headless/缺值（已测）
3. ★ run()：参数错误→attach_parent_console+stderr+exit(2)

### B2. 剪贴板暂存（lib.rs）
4. stage 成功→登记；失败→Err 不登记 ★
5. clear_if_staged：无暂存→false 不动；读回==暂存→清空+true；读回≠（用户已复制外部内容）→保留+false；★ 读取失败→fail-safe 清空+true（宁误清不残留种子）
6. 托盘 copy-mcp-info（含 token）登记；quit 清剪贴板+DEK 槽+exit(0)

### B3. DEK 暂存（lib.rs）
7. stash_dek 只进槽；take_stashed_dek 取即清（None=无暂存）；clear 清空 ★
8. 锁库三口径对齐清槽（release_tick Pause+lock_on_pause、destroy+lock_on_destroy、前端 onLocked invoke）★
9. 销毁档不锁库：emit stash-dek-request→sleep 1s→destroy main+mini
10. RunEvent::ExitRequested code=None→prevent_exit（托盘 app.exit(0) code=Some 不受影响）

### B4. 窗口/托盘/快捷键（硬依赖 AppHandle，豁免区）
11. toggle_mini 300ms 失焦竞态缓解；ensure_window 重建+RELEASE_TRACK.reset()；CloseRequested prevent+hide；全局快捷键重注册回落默认

### B5. 释放策略状态机（advance 纯函数已测 5 例+lib.rs 接线 ★）
12. 任一窗口可见→reset；已 destroyed→None；首次全隐藏播种 hidden_since
13. paused_at 置位：destroy 到时→Destroy；未暂停：pause 到时→Pause（TrySuspend 失败也置位）；pause=0 且 destroy>0→从隐藏起算；全 0 永不
14. 配置解析逐字段回默认 (5,30,false,true)；★ 字段类型错误（pauseMinutes 为字符串）方向；merge 只改 releasePolicy 键、根非对象回落重建不丢外来键
15. 接线：Pause→lock_on_pause 则 emit force-lock+清 DEK 槽+TrySuspend（失败/非 Windows 静默）；Destroy→destroy_releasable_windows，★ 任一 destroy 失败→回滚 destroyed 下 tick 重试；★ is_visible 窗口不存在视为不可见（计时继续）

### B6. DialogGrants
16. register 同目录复用+LRU 刷新；超 GRANT_CAP=16 逐出最旧；token=CSPRNG 16B hex（已测）
17. resolve 未知/空→Err；token_for 未登记→None、canonicalize 归一 verbatim（win 已测）
18. pick_dir_os 登记目录+持久化跨会话（dialog_grants.json best-effort 原子写）；pick_open/save_file_os 登记父目录仅会话内；取消→Ok(None)（对话框本体豁免）
19. load_grants：目录消失→丢弃；文件损坏→静默

### B7. 备份/导入文件命令（信任边界：dirToken 反查遏制）
20. valid_backup_name：vault- 前缀+.totpbackup+无 `/` `\` `..`；conflict-* 不可删除仅可列举（已测）
21. ensure_within：无 parent/任一侧 canonicalize 失败→Err；不在登记目录内→Err（防 symlink 逃逸）（已测）
22. remove_backup_file（固定目录版）白名单（已测）；remove_backup_file_os 三守卫序（已测）
23. list_backup_files_os 只返回白名单+排序（已测）；★ read_text_file_os 的 .totpbackup 白名单分支
24. ★ write_text_file_os 空路径/是目录分支；★ write_bytes_file_os 白名单仅 .png 独立不互通
25. ★ read_import_file_os 白名单 .json/.wauth/.xml/.txt/.aegis；★ read_import_file_bytes_os 再加 .db/.sqlitedb/.sqlite/.zip——全零测试

### B8. DPAPI/OS 解锁（Windows，已抽 inner 已测）
26. ensure_main_window_label：mini 恒不执行；decrypt_dpapi purpose 门控+base64/hex-ASCII 形状收窄（已测）
27. dek_protect/unprotect_inner：v2 前缀带熵；无前缀旧格式无熵兜底→明文必须恰 32B（第三方密文拒绝）；迁移重包（已测）
28. os_auto_forget：mac/linux keyring 删除 NoEntry 幂等；Windows 报错桩
29. base64 手写实现：空白忽略/pad>2→None/非字母表→None

### B9. devtools 配置（已测大部分）
30. 解析回默认（非 JSON/缺 devtools/port 越界）；merge 非 JSON 根不 panic；set 端口<1024→Err/路径定位失败/冲突；apply_devtools_env ★（APPDATA 缺失静默、未设才注入不挤外部预设）

### B10. MCP 配置层（已测大部分）
31. 默认配置（disabled/Wildcard/47215/空 token/exposed=[list_accounts,get_code]）；load 损坏→全默认=关闭（安全侧）；save 滤除未定义名+保外来键+原子写；add_whitelist 大小写不敏感去重；override 强制 enabled；prepare 空 token 生成且待落盘剥离覆盖；validate_port<1024→Err；needs_restart 四态；generate_token 43 字符 base64url
32. ★ GateMode serde 线格式往返（token/wildcard/exact/alwaysAsk，headless 连接行契约）

### B11. MCP 门控/审批
33. tool_kind 映射；exposure_check 未知/disabled；wildcard 大小写/仅 */pattern>256 fail-closed（已测）；★ 多星号回溯 `a*b*c` 形态
34. decide_gate：Token 恒 Allow；Wildcard/Exact 身份缺失 fail-closed NeedsApproval；Exact 大小写不敏感版本无关；AlwaysAsk 恒（已测）
35. GateSessions once 15min TTL、deny 60s 不跨 ident、clear_all 幂等（已测）
36. action_confirm_required：Action 且 mode≠Token；token 档免（已测）
37. token_eq 空/长度不等 false、恒时（已测）
38. validate_host_origin：缺 Host→Err；非 loopback（DNS rebinding）→Err；IPv6 fail-closed；Origin 非 http/非 loopback→Err；跨端口 loopback 放行；localhost 大小写（已测）
39. strip_bearer_scheme 大小写（已测）
40. ★ gated_call 全分支串联：每请求重读 cfg→!enabled→exposure→decide→once_valid 放行/denied_recently→"approval denied..."→emit `mcp://approval`+"approval pending" fail-closed→action 叠加 tool_confirm→bridge_call（emit 依赖 AppHandle 无法构造→抽决策函数）
41. tool_confirm：emit→await result true/false/Err/超时一律 fail-closed+回收（await 已测，emit 失败分支 ★）
42. ★ bridge_call：alloc→emit `mcp://req`→5s 超时"app busy"+回收；emit 失败回收；前端 drop→"frontend dropped"
43. ★ identity_of 三级回落（clientInfo→UA→<unknown>）

### B12. MCP 命令/生命周期
44. mcp_get_config：flatten+running+lastError 对账（DTO 已测）
45. mcp_set_config：validate→补 token→落盘→needs_restart 重启（★ 命令层 match）
46. mcp_regenerate_token：新 token+重启旧失效→返回（★）
47. mcp_approval_response：deny→冷却/once→grant/trust→写白名单/未知→Err（底座已测，★ 命令层 match）
48. mcp_respond：ok 无 result→"empty result"；ok=false 无 error→"unknown error"；迟到回传静默（★）
49. stop_server：cancel→watch→有界 3s 等待（防 Windows 无 SO_REUSEADDR）→mark_stopped 保留 last_error（停机集成测试已有）
50. start_server_inner：★ 空 token fail-closed 拒启、★ bind 失败 Err 无僵尸通道、set_nonblocking 失败；serve_forever 空 token 拒绝
51. init_state_and_autostart：token 落盘失败→不启不拦 GUI 错误进运行态（headless 下宁不启不让内存 token 与盘漂移）；headless autostart 失败 exit(2)
52. mcp_auth_middleware：403 恶意 Host 先于 401 错 Bearer（oneshot 直测 4 例已有）

### B13. lock_events（0%，cfg(windows)）
53. start 幂等不叠线程；WTS_SESSION_LOCK→emit system-lock；WM_DESTROY 注销+PostQuitMessage；GetMessage 三态；非 Windows no-op——消息泵不可单测，走真机

## C. 现有测试（75=lib 27+mcp_server 39+release_policy 5+cli 4）与缺口汇总

缺口：STASHED_DEK/CLIPBOARD_STAGE 零测试；read_import_*/read_text_file 白名单零测试；mcp_approval_response/mcp_respond 命令层 match；gated_call 决策链/bridge_call/start_server_inner/identity_of；GateMode serde；cli 2 分支；release_policy 字段类型错误方向；apply_devtools_env。

## D. 可测性模式与抽薄评估

已建立三个可复用模式：① `*_granted`/`*_inner` 命令体抽取（State/WebviewWindow 不可构造，测 inner 单一代码路径）；② tmp_path 文件系统隔离；③ tower::ServiceExt::oneshot 直测 middleware+真实 TcpListener/raw TCP 集成测试（HTTP 基建已存在）。

低代价抽取：STASHED_DEK/CLIPBOARD_STAGE static Mutex 操作参数化 fn（≈0）；clear_if_staged(staged, read_result) 纯函数化；read_import_*/read_text_file 照 *_granted 模式；mcp_approval_response/mcp_respond match 抽收 &GateSessions/&BridgeShared 的自由函数；GateMode serde 往返一行。

中代价：gated_call 抽"cfg 重读+exposure+decide+session 记账→GateOutcome 枚举"纯决策函数（emit 留薄壳）；bridge_call 超时+回收语义；start_server_inner 改收 (bridge, sessions, settings_file, slot)；release_tick 抽"cfg→副作用计划"枚举+destroy 回滚注入闭包。

不可单测（豁免/真机）：run() 装配、pick_* 对话框、try_suspend_window（WebView2 COM）、on_window_event、lock_events 消息泵、toggle_mini 300ms 竞态。debug 构建已装配 tauri_plugin_mcp_bridge（127.0.0.1），真机 E2E 通道现成。

## E. 权威文档

docs/review/2026-09-24-full-audit-fixes.md（F3/F4/F16/Task 14/I-x/M-x 出处）、docs/plans/2026-09-21-mcp-server-design.md+2026-09-21-plan17-mcp-server.md（门控/事件桥/超时/停机）、docs/plans/2026-09-22-review-backlog.md（批⑧ §7 释放策略）、docs/superpowers/plans/2026-09-23-batch8-improvements.md+review/2026-09-23-batch8-real-machine-test.md（F16/Task13/Task14 真机）、docs/plans/2026-09-17-plan16-backup-sources-and-crypto.md（grants/T15）、docs/plans/2026-09-16-plan15-settings-ux.md+2026-09-14-plan11-unlock.md（devtools/DPAPI 通道）、docs/review/2026-09-18-plan13-16-full-code-review.md（I-5 原子写/M6 端口冲突）。

