# P6 Windows 安全架构 spike 调研报告（2026-10-07）

> **报批结论（2026-10-07，用户已确认）：采纳本报告建议——P6 缩减为仅实施 CryptProtectMemory 内存加密（§Q4，约 1–2 人日，方案见报告正文）；DPAPI NG 迁移、MSIX 打包、便携版 AppContainer 三项均放弃，报告存档备查（MSIX 若未来决定上 Microsoft Store 再依 §Q2 立项）。**

对应 spec：docs/superpowers/specs/2026-10-06-seven-features-design.md §6.1 四问题。
方法：Microsoft Learn 权威文档 + tauri/WebView2Feedback issue + 本地 Rust 探针（`E:\tmp\cc\totp-spike`，windows crate 0.61，与仓库同版本）。
探针结果汇总：

```
[SID]   当前用户 SID = S-1-5-21-3306336030-1916358487-3994386813-1001（本地账户，工作组）
[DPAPI-NG] "SID=<当前用户>"            → 加密失败 0x80090034 (NTE_ENCRYPTION_FAILURE)【两次独立复现】
[DPAPI-NG] "LOCAL=user"               → 32B 往返 OK，密文 503B（CMS/ASN.1，magic 30 82）
[DPAPI-NG] "SID=<他人SID>"（反例）     → 加密同样失败（失败发生在保护侧，非解密侧）
[CryptProtectMemory] SAME_PROCESS 32B 往返 OK；10000 次往返 39.4ms ≈ 3.9µs/次
[makeappx]  Windows SDK 10.0.26100（本机已装）：AppxManifest(FullTrust)+dummy.exe → pack 成功
```

## 0. 结论速览

| # | 问题 | 结论 | 建议 |
|---|------|------|------|
| 1 | DPAPI NG 形态覆盖 | **spec 前提不成立**：`SID=` 描述符非域/非 MSA 环境加密直接失败（探针复现）；官方描述符语法**不存在 MSIX 包身份描述符**；`LOCAL=user` 与现有 DPAPI+附加熵同级（DPAPI NG 无附加熵等价物，甚至更弱） | **不实施迁移**，保留 TOTPDEK1 |
| 2 | MSIX 打包链路 | 链路可行（社区先例 + 本机 makeappx 探针通过），Tauri 官方 NOT_PLANNED；签名是硬门槛；MSIX(FullTrust) 本身**不提供**运行时保护 | 与安全目标解耦，按分发需求（Store）另行立项 |
| 3 | AppContainer 兼容性 | **风险最高**：WebView2 官方承认受限 token 下不可用；MSIX appContainer 档位 WebView2 不渲染（#5320 Blocking 未修）；LPAC 无支持 | **不投入**；诉求若是缩小 DEK 暴露面，走 Q4 |
| 4 | CryptProtectMemory | **可落地**：往返验证 OK，3.9µs/次，官方文档确认防页面换出落盘 | **推荐实施**（P6 唯一值得现在做的项） |

---

## 1. DPAPI NG 形态覆盖（Q1）

### 结论
1. **描述符语法全集只有五类**（官方 [Protection Descriptors](https://learn.microsoft.com/en-us/windows/win32/seccng/protection-descriptors)）：`SID=`、`SDDL=`（AD 域）、`LOCAL=user|machine`、`WEBCREDENTIALS=名[,域]`、`CERTIFICATE=HashID:/CertBlob:`。等号左侧仅限这五种，**没有 MSIX 包身份/AppContainer 派生描述符**。spec 设想的"MSIX 包身份派生描述符"无官方 API 支撑；理论上可用包 family SID（`S-1-15-2-...`）构造 `SID=` 描述符，但 `SID=` 保护器依赖密钥分发服务（AD 域 KDS / MSA），本地工作组环境根本走不通（下条）。
2. **`SID=` 描述符在本地账户（非域、非 MSA 登录）下加密即失败**：探针 0x80090034 稳定复现，与 [Stack Overflow 先例](https://stackoverflow.com/questions/40192062/dpapi-ng-ncryptprotectsecret-returns-nte-encryption-failure)（Windows Server 2012R2/2016 同错误）一致。即"更细粒度的 DEK 绑定"在相当大比例的个人用户机器上不可用。
3. **`LOCAL=user` 可用但无增量**：其安全语义 = 绑定当前用户可解，与传统 `CryptProtectData` 相同；且 `NCryptProtectSecret` **没有附加熵参数**（现 TOTPDEK1 的 `com.totp.desktop/os-auto-unlock/dek` 熵无等价物），纯 `LOCAL=user` blob 反而比现状弱一档。DPAPI NG 的增量价值（CMS 标准格式、多保护器 OR 组合、域场景 SID/SDDL）对本应用当前用户群基本不适用。
4. Windows 版本：NCryptProtectSecret DPAPI NG 为 Win8+；`uap10:TrustLevel="appContainer"` manifest 语法要求 Win10 2004+（[MSIX AppContainer apps](https://learn.microsoft.com/en-us/windows/msix/msix-container)）。
5. Rust 绑定（windows 0.61 实测）：`NCryptCreateProtectionDescriptor` / `NCryptProtectSecret` / `NCryptUnprotectSecret` 全在 `Win32::Security::Cryptography`，**仓库现有 feature 集（含 `Win32_Security_Cryptography`）已覆盖，无需新增**。注意：这些函数在 windows crate 返回 `windows_core::Result<()>` 而非裸 `SECURITY_STATUS`；句柄释放用 `NCryptFreeObject(NCRYPT_HANDLE)`（0.61 未绑定 `NCryptFreeDescriptor`）。证据：[windows crate 文档](https://microsoft.github.io/windows-docs-rs/doc/windows/Win32/Security/Cryptography/fn.NCryptProtectSecret.html) + 探针源码。

### 向后兼容路径（若未来仍要迁移）
沿用现有"版本前缀 + 读取兼容、成功解锁后重包"机制：新增 `TOTPDEK2` 前缀承载 DPAPI NG blob，解密按 `TOTPDEK2 → TOTPDEK1（含熵）→ 裸 DPAPI` 逐级回落；前端 migrate 逻辑已有先例（App.vue migrateDekWrapToEntropyBound）。但因第 3 条结论，**当前不建议执行**。

## 2. MSIX 打包链路（Q2）

### 结论
1. **Tauri 官方不会支持 MSIX**：[tauri#8548](https://github.com/tauri-apps/tauri/issues/8548)（"Add the ability to generate .msix or .appx"）2024-01 以 **NOT_PLANNED** 关闭；遗留 open 的 [#4818](https://github.com/tauri-apps/tauri/issues/4818)（package extension 场景）。MSIX 必须后处理。
2. **社区链路成立**（先例：[iblai/os MSIX-BUILD-GUIDE](https://github.com/iblai/os/blob/main/src-tauri/MSIX-BUILD-GUIDE.md)，同为 Tauri 应用）：打包对象是 `tauri build` 的主 exe + WebView2Loader 等载荷（**不是** NSIS 安装器），stage → `AppxManifest.xml`（`EntryPoint="Windows.FullTrustApplication"` + `rescap:runFullTrust`）→ `makeappx pack` → `signtool sign`。本机探针已验证 makeappx pack 环节（Windows SDK 10.0.26100）。
3. **签名是硬门槛**：含 exe 的 MSIX 即使本地测试也必须签名（`Add-AppxPackage -AllowUnsigned` 拒绝含可执行文件的包）。自签证书需同时装入 **Trusted People + LocalMachine Trusted Root**；Publisher 必须与证书 Subject 完全一致。Store 分发可上传未签名包由微软重签（最省证书成本）；Store 外分发需 CA 代码签名证书。
4. CI 可行性：GitHub Actions windows runner 预装 Windows SDK（makeappx/signtool 同本机版本系），自签证书可用 secrets 注入。**runner 实际 SDK 版本与签名步骤未在本 spike 验证**（无证书）。
5. 已知风险（issue 证据）：
   - [tauri#9936](https://github.com/tauri-apps/tauri/issues/9936)：MSIX 包身份使 `app_local_data_dir` 路径改变 → **security.json/vault 数据迁移风险**，存量用户可能被视为全新安装（须真机验证迁移逻辑）。
   - [tauri#14935](https://github.com/tauri-apps/tauri/issues/14935)：WACK 对 blocked executables 报错（S 模式兼容性）。
   - manifest 元素顺序严格、`uap10:TrustLevel` 等新属性兼容性参差（iblai 指南）。
6. **架构提醒**：FullTrust MSIX 的进程仍是中完整性用户进程，MSIX 打包对 Q1/Q3 的安全目标**没有直接贡献**（包身份不改变 DPAPI/内存暴露面）；其价值在分发渠道（Store）与未来可选的 appContainer 档位——而后者被 Q3 判定为高风险。

### 未验证项（如实标注）
signtool 签名、安装（Add-AppxPackage）、包内 WebView2 实际运行、存量数据目录迁移——均未验证（无签名证书、不做系统级安装实验）。真机验证清单见 §6。

## 3. AppContainer 兼容性（Q3）

### 结论
1. **WebView2 团队官方口径**（[WebView2Feedback#4850](https://github.com/MicrosoftEdge/WebView2Feedback/issues/4850) 成员回复原文）：*"Chromium code will try to setup sandbox for renderer process and to setup the sandbox, it requires a lot of privilege and would not work if the process is with a restricted token. WebView2 works in AppContainer for supporting of UWP apps."* —— 即受限 token 进程内 WebView2 初始化失败；官方支持的仅 UWP 专用通道。
2. **MSIX appContainer 档位实测是坏的**：[WebView2Feedback#5320](https://github.com/MicrosoftEdge/WebView2Feedback/issues/5320)（Win11 26100，WinUI3 + `TrustLevel="appContainer"`，WebView2 控件完全不渲染，Blocking，2025-07 至今 open 无修复）；[#5693](https://github.com/MicrosoftEdge/WebView2Feedback/issues/5693) 显示即便系统组件（SearchHost）在 AppContainer 内跑 WebView2 也有 GPU/shader 缓存毛刺。
3. **LPAC（低特权 AppContainer）无任何官方支持迹象**；检索 WebView2Feedback 无 LPAC 支持公告，#4850 结论已覆盖更宽松的普通 AC 场景，LPAC 只会更糟（网络/剪贴板等能力默认全关，需逐项授权）。
4. **便携版自建 AppContainer**：官方文档（[AppContainer for legacy apps](https://learn.microsoft.com/en-us/windows/win32/secauthz/appcontainer-for-legacy-applications-)）明确 unpackaged 应用可进 AppContainer，但需自行 `CreateAppContainerProfile`（userenv）/ capability SID 授权（icacls ACL 数据目录）/ `DeleteAppContainerProfile` 清理，官方原话 *"it can be complicated"*；子进程继承容器 token，IL 恒为 low，文件系统/注册表虚拟化重定向 `%APPDATA%` 写入（会改变现有数据目录行为）。技术上"启动器进程在容器内拉起主 exe"成立，但叠加第 1–3 条 WebView2 风险后，**成功率低、排障面大**。
5. 工作量量级：launcher + profile 管理 + ACL + 虚拟化适配 + WebView2 踩坑，约 **2–4 人周**且成败取决于不可控的 WebView2 修复进度。**不建议立项**。

## 4. CryptProtectMemory 适用性（Q4）

### 结论
1. **语义**（[官方文档](https://learn.microsoft.com/en-us/windows/win32/api/dpapi/nf-dpapi-cryptprotectmemory)）：同 flag 加解密；`SAME_PROCESS` 其他进程不可解；`SAME_LOGON` 同 logon session 同用户的其他进程可解；`CROSS_PROCESS` 同机器任意进程可解（不用）。数据长度必须是 `CRYPTPROTECTMEMORY_BLOCK_SIZE`(16) 的倍数；**原地加解密**（pDataIn in/out，加密后原缓冲变密文）；重启后不可解（密钥在 logon 会话内派生）。
2. **防什么**：官方原文确认防"进程被换出到交换文件时密文可见"（pagefile；休眠文件同理——换出页面落 hiberfil 即密文）。**不防**：运行期内存读取（官方 Remarks 承认加密前/解密后明文就在内存里，同用户 admin/调试器仍可读）、代码逆向拿到解密逻辑。对 STASHED_DEK/MINI_DEK 这类"长期驻留、偶尔取用"的槽，收益=把 7×24 明文驻留压缩为"取用瞬间明文"，正对 spec §6.1 问题 4 的威胁模型。
3. **锁库清槽交互**：加密驻留不改变 `dek_slots_clear_on_lock` 的"锁库即清"不变量（session_vaults.rs 成对约定）；清槽时应 overwrite+drop（配合 zeroize）而非仅 drop `String`。实现形态建议：槽类型 `Mutex<Option<String>>` → `Mutex<Option<ProtectedBytes>>`（内部 `Vec<u8>` 16 对齐 + CryptProtectMemory 包裹 + Drop 时 zeroize），stash/take/peek 命令签名不变。
4. **性能**：探针实测 32B protect+unprotect 往返 **3.9µs/次**（10⁴ 次采样），stash/peek 频率下成本可忽略。
5. **Rust 绑定**：`CryptProtectMemory`/`CryptUnprotectMemory` 在 `Win32::Security::Cryptography`，仓库现有 feature 集已覆盖（探针实测）。注意 `String` 槽需改为字节缓冲（原地加密语义 + 16B 对齐）。
6. 残余风险：`SAME_LOGON` 下同用户其他进程（如注入的恶意 DLL 所在进程）可解——若需防护该档，`SAME_PROCESS` 是更严选择（本应用无跨进程解密需求，**建议 `SAME_PROCESS`**）；解密瞬间窗口依旧存在（无法消除）。

## 5. 推荐方案（含优先级）

1. **P6-1（做）：Q4 落地**。session_vaults.rs 两槽上 `ProtectedBytes`（CryptProtectMemory SAME_PROCESS + zeroize + 16B 对齐），锁库清槽语义不变。1–2 人日，风险低，收益直接。
2. **P6-2（观望）：Q2 仅在"要上 Microsoft Store"时立项**。链路按 §2.2 模式写脚本（makeappx+FullTrust manifest+signtool），先用自签证书在真机验证安装与存量数据迁移（tauri#9936 是最大坑）。脚本 2–3 人日 + 证书/审核外部依赖。不要为安全目标做 MSIX。
3. **不做：Q1 迁移与 Q3 AppContainer**。Q1 前提被探针证伪（本地账户 `SID=` 失败、无包身份描述符、`LOCAL=user` 无增量）；Q3 被 WebView2 官方口径与 #5320 判死缓。若未来域/MSA 环境或 Store+appContainer 形态成熟，按 §1 兼容路径重启评估。

旧 DPAPI 数据向后兼容：现状 TOTPDEK1 已有旧格式回落链（v1 裸 DPAPI → v2 含熵），P6-1 不触碰落盘格式，**零迁移成本**；Q1 若做才需要 TOTPDEK2 链。

## 6. 实施前必须真机验证的点

1. 【Q4】`SAME_PROCESS` 在 WebView2 TrySuspend/窗口销毁重建（进程存活）场景下解密始终可用（探针仅单进程验证；理论上成立，需集成测试）。
2. 【Q4】hibernation→恢复后槽密文可继续解（logon session 未变时应可解；极端情况快速失败路径要不 brick 解锁流程）。
3. 【Q2】自签证书链（Trusted People + Root）真机 `Add-AppxPackage` 安装含 exe 的 MSIX。
4. 【Q2】MSIX 包身份下 `app_local_data_dir`/security.json 实际路径，及存量用户数据迁移方案（tauri#9936）。
5. 【Q2】GitHub Actions windows runner 的 SDK 版本与 makeappx/signtool 路径。
6. 【Q1，仅当重启】AppContainer/MSIX-appContainer 进程内 DPAPI masterkey（%APPDATA%\Microsoft\Protect ACL）可达性——传统 DPAPI 与 NG 都可能被容器 ACL 挡住，本 spike 未验证。
7. 【Q3，仅当重启】最新 Evergreen runtime 下 `TrustLevel="appContainer"` + WebView2 渲染（盯 WebView2Feedback#5320 状态）。

## 来源

- https://learn.microsoft.com/en-us/windows/win32/seccng/protection-descriptors （描述符语法全集）
- https://microsoft.github.io/windows-docs-rs/doc/windows/Win32/Security/Cryptography/fn.NCryptProtectSecret.html （Rust 绑定/feature）
- https://stackoverflow.com/questions/40192062/dpapi-ng-ncryptprotectsecret-returns-nte-encryption-failure （SID= 非域失败先例）
- https://learn.microsoft.com/en-us/windows/msix/msix-container （MSIX AppContainer 配置，Win10 2004+）
- https://learn.microsoft.com/en-us/windows/win32/secauthz/appcontainer-for-legacy-applications- （自建 profile 路径）
- https://github.com/tauri-apps/tauri/issues/8548 （MSIX 生成 NOT_PLANNED）/ issues/4818 / issues/9936 （数据目录变化）/ issues/14935 （WACK）
- https://github.com/iblai/os/blob/main/src-tauri/MSIX-BUILD-GUIDE.md （Tauri→MSIX 社区链路先例）
- https://github.com/MicrosoftEdge/WebView2Feedback/issues/4850 （官方：受限 token 限制）/ issues/5320 （appContainer 不渲染）/ issues/5693
- https://learn.microsoft.com/en-us/windows/win32/api/dpapi/nf-dpapi-cryptprotectmemory （CryptProtectMemory 语义）
- 探针源码：E:\tmp\cc\totp-spike（不入仓）
