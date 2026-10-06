# P6 ABE 服务（App-Bound Encryption）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 复刻 Chrome App-Bound Encryption 模式——LocalSystem 高权限服务验证调用者（路径+SHA256 哈希，签名档预留）后代理解包 DEK，密钥密文只存 HKLM（SYSTEM DPAPI），用户区 security.json 不落密文；SecurityCard"启用自动解锁"区加"安装服务"按钮（UAC 一次完成安装+绑定）。

**Architecture:** 同一 tauri exe 的三个 CLI 分支（`--elevation-service` 服务主循环 / `--elevation-install`、`--elevation-uninstall` 提权命令，runas 触发 UAC）+ named pipe 帧协议（`\\.\pipe\totp-elevation-v1`）。服务组件（exe 副本）装在 ACL 锁定的 `%ProgramData%\TotpTools\service\`（SYSTEM 服务不得运行用户可写路径的二进制——防本地提权）；绑定记录（BoundPath/BoundSha256）存 HKLM（仅 SYSTEM/Administrators 可写），升级/便携目录迁移后经"重新绑定"（再次 UAC）更新。便携版与安装版同流程（用户裁定）。前端 `KekSource` 新增 `{ kind: 'abe' }` 标记源（密文在服务侧 HKLM，security.json 只存标记——与 dpapi 源存 blob 的差异是刻意收窄泄露面）；LockScreen 静默解锁 abe 优先、失败回退 dpapi。

**Tech Stack:** Rust：`windows-service 0.8`、`windows 0.62`（新 features：Win32_System_Services/Win32_System_Pipes/Win32_System_Threading）、`runas 1.2`、`windows-registry 0.100`、`sha2`、`zeroize`；前端复用现有 core/ui/platform 注入模式。**设计依据**：Chrome ABE 源码级调研（elevation_service caller_validation/elevator.cc、windows_services/service_program、installer work_item/uninstall）——Chrome 验证仅"路径归一化+隔离标志"无签名，本方案三重验证（路径+哈希+签名预留）强于 Chrome 开源部分；Chrome 明文 key 返回浏览器进程，本方案同深度（用户裁定"服务代理 DEK 解密"即 DEK unwrap 代理，非全部加解密代理）。

**Spec:** `docs/superpowers/specs/2026-10-06-seven-features-design.md` §6（原四问题已被 spike 推翻，见 `docs/superpowers/research/2026-10-07-p6-security-spike.md` 报批结论）；本计划自带 ABE 设计正本（下方 §0）。

## §0 ABE 设计正本（本计划的绑定规范）

### 0.1 服务

- 名称 `TotpToolsElevationService`，显示名 `TOTP Tools Elevation Service`；LocalSystem、`SERVICE_WIN32_OWN_PROCESS`、`SERVICE_DEMAND_START`。
- 入口：`run()`（lib.rs）最早期（tauri builder 之前）按 CLI 参数分派：`--elevation-service` → `elevation_service::run_service()`（windows-service `service_dispatcher::start` + `service_control_handler` 处理 Stop）；`--elevation-install` / `--elevation-uninstall` → `elevation_install::run()`（由 runas 提权拉起，执行完即退出，无 UI）。
- 服务循环：单线程，服务句柄 `\\.\pipe\totp-elevation-v1`，`CreateNamedPipeW` 参数：`PIPE_ACCESS_INBOUND|FILE_FLAG_FIRST_PIPE_INSTANCE`、`PIPE_TYPE_BYTE|PIPE_READMODE_BYTE|PIPE_WAIT`、`PIPE_UNLIMITED_INSTANCES`、in/out 缓冲 64KiB、安全描述符 DACL = SYSTEM 与 Administrators 完全、当前用户读写（SDDL: `D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GRGW;;;AU)`）；`PIPE_REJECT_REMOTE_CLIENTS`（dwPipeMode 含 `PIPE_REJECT_REMOTE_CLIENTS`）。
- 每连接：连接建立后**立即** `GetNamedPipeClientProcessId` → `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION)`（快照句柄防 PID 复用 TOCTOU）→ `QueryFullProcessImageNameW` → SHA256(exe 文件) → 与 HKLM 绑定记录比对（§0.2）→ 通过才读帧处理请求；失败写一条错误响应后断开。路径归一化：`to_lowercase` + `\\?\` 前缀剥离（对齐 Chrome MaybeTrimProcessPath 的防混淆目的，但不 trim 版本目录——我们用哈希绑定，升级必须重绑，trim 版本目录反而错误）。
- 请求处理：
  - `Wrap{dek:32B}`：SYSTEM 上下文 `CryptProtectData`（无附加熵，marker `TOTPABEK1` 前缀 base64 包裹形态同现有 TOTPDEK1 模式）→ 存 HKLM `WrappedDek`（REG_BINARY）→ 回 `{ok}`。
  - `Unwrap{}`：读 HKLM `WrappedDek` → `CryptUnprotectData` → 强校验明文 32B → 回 `{ok, dek}`；明文 DEK 用后即清（服务端不留副本）。
  - `Status{}`：回 `{bound_path, bound_sha256_prefix8, service_version, matches_caller}`（matches_caller=当前调用者是否通过验证——失配时前端据此显示"重新绑定"）。
  - `Remove{}`：验证通过后删 HKLM `WrappedDek` 值（绑定键 BoundPath/BoundSha256 保留，由卸载/重绑通道清理）。
- 错误码（协议层 u16）：0=ok、1=path_mismatch、2=hash_mismatch、3=verify_error、4=no_wrapped_dek、5=bad_request、6=internal。

### 0.2 HKLM 配置与 ProgramData 副本

- 键 `HKLM\SOFTWARE\TotpTools\Elevation`：`BoundPath`(REG_SZ)、`BoundSha256`(REG_SZ 十六进制 64 字符)、`WrappedDek`(REG_BINARY)、`ServiceVersion`(REG_SZ)。ACL：SYSTEM/Administrators 完全、Users 读（`windows-registry` 写入时设置；默认 HKLM 键 ACL 已满足，无需自定义）。
- 副本目录 `%ProgramData%\TotpTools\service\`：`--elevation-install`（已提权）创建目录并收紧 ACL（SDDL `D:P(A;;FA;;;SY)(A;;FA;;;BA)`，移除 Users 写）→ 复制自身 exe → 服务 ImagePath 指向副本（`"<dir>\TotpTools.exe" --elevation-service`）。
- `--elevation-install` 流程（一次 UAC 完成全部）：算自身路径+SHA256 → 建/收紧副本目录+复制自身 → 服务存在则 `ChangeServiceConfig` 更新 ImagePath 并重启，不存在则 `CreateService` → 写 HKLM 绑定三值 → 启动服务。`--elevation-uninstall`：`sc stop`+`DeleteService`+删副本目录+删 HKLM 键，容忍 `ERROR_SERVICE_MARKED_FOR_DELETE`（对齐 Chrome uninstall.cc 容忍语义）。

### 0.3 前端数据面

- core `KekSource` 联合新增 `{ kind: 'abe' }`（无载荷字段——密文在服务 HKLM）；`isKekSource`/`removeKekSource`/去重兼容；新助手 `withAbeSource`（恒单份替换，同 `withDpapiSource` 语义）。
- securityPlatform 接口（packages/ui/src/components/securityPlatform.ts）新增 `AbeOps`：`{ supported: boolean; status(): Promise<AbeStatus | null>; bind(): Promise<boolean>; remove(): Promise<AbeResult> }`，`AbeStatus = { installed: boolean; matchesCaller: boolean; boundPath?: string; version?: string }`。desktop 宿主实现：`bind()` = `runas::Command::new(current_exe).arg("--elevation-install")`（UAC）成功后经管道 `Status` 复核；`remove()` = 管道 `Remove` + 安全页不再显示。
- LockScreen：静默解锁链改为顺序尝试 `abe → dpapi`（abe 源存在才试 abe；失败/不支持回退 dpapi 现有路径，两者都失败维持现有"重试"UI）。
- SecurityCard（仅 Windows 宿主，`supported=false` 的宿主不渲染区块）：解锁方式区 dpapi 区块之后加"应用绑定解锁（服务）"区块——未安装：`安装服务` 按钮（busy 态，点击=bind() 一次 UAC）；已安装且 matchesCaller：状态行（版本+绑定路径尾段）+`移除`；已安装且失配：状态行+"应用已更新或路径已变，需要重新绑定"提示+`重新绑定`（=bind()）。

### 0.4 威胁模型声明（文档化于 README 安全节）

防：同用户运行的第三方进程读取 security.json 后无法自行解密（无密文可读）、无法冒充调用者从服务取 DEK（路径+哈希验证）、SYSTEM 服务二进制被用户区篡改（副本在 ACL 锁定目录）。不防：入侵已验证应用进程本身（进程注入——Chrome 同样不防，研究案例 xaitax/ChromElevator 均为此类）、管理员/LSYSTEM 直接读 HKLM+服务内存、目标 exe 被替换且攻击者能通过 UAC 重绑。签名档落地后可再封堵重打包伪造（WinVerifyTrust+publisher，Chrome 未做）。

## Global Constraints

- 服务/提权代码全部 `#[cfg(windows)]` 门控（Linux clippy CI 门禁，历史坑）；CLI 分派点在 `run()` 最早处且 headless 模式不受影响。
- DEK 与明文密钥内存一律 `zeroize` 清理；错误信息不得包含 DEK 内容。
- 管道帧协议常量（pipe 名、消息类型、错误码、marker `TOTPABEK1`）单点定义于 `elevation_proto.rs`，服务/客户端/前端可见字符串不重复定义。
- security.json 的 abe 源恒单份（`withAbeSource` 替换语义）；`removeKekSource` 对 abe 源生效。
- 测试命令：`pnpm -F @totp/core test`、`pnpm -F @totp/ui test`、`cargo test`（src-tauri 目录）；typecheck/clippy/fmt 全绿。
- 本计划不含签名实现（WinVerifyTrust 仅预留接口：HKLM 可选键 `SignerSubject` 存在时才执行校验，当前不写入该键）。

---

### Task 1: 帧协议模块 elevation_proto + core abe 源类型

**Files:**
- Create: `apps/desktop/src-tauri/src/elevation_proto.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`（mod 声明）
- Modify: `packages/core/src/security/securityStore.ts`（KekSource 联合 + 去重兼容）
- Modify: `packages/core/src/security/multiKek.ts`（isKekSource + withAbeSource）
- Test: `apps/desktop/src-tauri/src/elevation_proto.rs`（内嵌 #[cfg(test)]）、`packages/core/test/securityMultiKek.test.ts`（追加用例）

**Interfaces:**
- Produces（Task 3/4/5/6 依赖）：
  - `pub const PIPE_NAME: &str = r"\\.\pipe\totp-elevation-v1"`；`pub const DEK_MARKER: &str = "TOTPABEK1"`
  - `pub enum MsgType { Wrap=1, Unwrap=2, Status=3, Remove=4, Resp=5 }`
  - `pub enum ErrCode { Ok=0, PathMismatch=1, HashMismatch=2, VerifyError=3, NoWrappedDek=4, BadRequest=5, Internal=6 }`
  - `pub fn encode_frame(msg: MsgType, payload: &[u8]) -> Vec<u8>`（`u32 LE len | u8 msg | payload`）
  - `pub fn decode_frame(buf: &[u8]) -> Result<(MsgType, &[u8]), ProtoError>`
  - core：`KekSource` 联合含 `{ kind: 'abe' }`；`isKekSource` 认之；`withAbeSource(sources)` 恒单份；`removeKekSource` 可删之
- core 测试断言（照用）：`isKekSource({kind:'abe'})===true`、`withAbeSource([dpapi源, abe源])` 结果长度 1 且仅 abe、`withAbeSource` 对无 abe 源数组追加、`removeKekSource('abe')` 移除、去重 `removeDuplicateKekSources` 对双 abe 源收敛为 1。

- [ ] Step 1: 写 core 失败测试（isKekSource 不认 abe → 红）
- [ ] Step 2: 实现 core abe 源（三文件）→ 绿
- [ ] Step 3: 写 proto 失败测试（编解码往返、len 前缀正确、截断/超长/未知 msg_type 拒绝）→ 红
- [ ] Step 4: 实现 elevation_proto.rs → 绿；`cargo test` 全绿
- [ ] Step 5: `pnpm -F @totp/core test` 全绿 + `cargo fmt` + `cargo clippy`
- [ ] Step 6: Commit `feat(security): ABE 帧协议模块与 core abe KEK 源类型`

### Task 2: elevation_service 服务主体

**Files:**
- Create: `apps/desktop/src-tauri/src/elevation_service.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`（cfg(windows) mod + `--elevation-service` 分派，`#[cfg(windows)]`）
- Modify: `apps/desktop/src-tauri/Cargo.toml`（windows-service 0.8、windows features Win32_System_Services/Win32_System_Pipes/Win32_System_Threading、sha2、zeroize）
- Test: `elevation_service.rs` 内嵌单测

**Interfaces:**
- Consumes: Task 1 的 proto 全部项。
- Produces: `pub fn run_service() -> Result<(), ServiceError>`（`--elevation-service` 入口）；`pub fn validate_caller(client_exe: &str, client_sha256: &str, bound: &Bound) -> ErrCode`（**纯函数**，归一化+比对逻辑全在此，可单测）；`struct Bound { path: String, sha256: String }`；内部循环 `pipe_server_once(handle)` 处理单连接（验证→读帧→分派 Wrap/Unwrap/Status/Remove→写响应帧）。
- 关键实现要点（照做）：
  - HKLM 读：`windows-registry` `RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey("SOFTWARE\\TotpTools\\Elevation")`；`Bound` 缺失/键不存在 → 全部请求回 `ErrCode::VerifyError`（未绑定状态）。
  - Wrap：`CryptProtectData`（`Win32_Security_Cryptography`，CRYPTPROTECT_UI_FORBIDDEN，无熵）→ 结果 base64 前拼 `TOTPABEK1` → 存 `WrappedDek`（REG_BINARY 存原始包裹字节，marker 存于 base64 串内再解码回字节存——实现取简：HKLM 直接存 base64 字符串 REG_SZ，与 security.json 同形态便于排查）→ 回 ok。请求 payload 非 32B 回 BadRequest，DEK 处理完立即 zeroize。
  - Unwrap：读 `WrappedDek`（REG_SZ）→ 剥 marker → `CryptUnprotectData` → 明文必须 32B → 回 `{ok, dek}`；响应写出后 DEK 缓冲 zeroize。
  - Status：回 payload=JSON `{bound_path, sha256_prefix, version, matches_caller}`（version = env!("CARGO_PKG_VERSION")）。
  - Remove：删除 `WrappedDek` 值 → 回 ok。
  - 服务主循环：注册 control handler（Stop 置停止标志）→ 循环 `ConnectNamedPipe`→验证→处理→`DisconnectNamedPipe`→检查停止标志；Stop 时优雅退出。
- 单测（不碰真管道/HKLM）：`validate_caller` 六例（路径命中+哈希命中=Ok；路径失配=PathMismatch；哈希失配=HashMismatch；大小写/`\\?\` 前缀归一化命中；Bound 空串=VerifyError；网络路径 UNC 拒=PathMismatch）；帧分派纯函数 `handle_payload(msg, payload, &mut fake_store) -> (ErrCode, Vec<u8>)` 用内存 fake store 测 Wrap→Unwrap 往返（CryptProtectData 依赖系统——单测环境 Windows CI 可用真 DPAPI：Wrap 真加密、Unwrap 真解密断言往返；非 Windows cfg 该测试跳过）。

- [ ] Step 1: 失败测试（validate_caller 六例+handle_payload 往返）→ 红
- [ ] Step 2: 实现模块与 CLI 分派（服务分支不启动 tauri/webview）→ 绿
- [ ] Step 3: `cargo test` + `cargo fmt` + `cargo clippy`（含 `--cfg` 非 windows 编译检查由 CI 承担，本地尽力跑 `cargo check`）
- [ ] Step 4: Commit `feat(security): ABE LocalSystem 服务主体（管道服务+调用者验证+DEK 包裹）`

### Task 3: elevation_install 提权安装/卸载 + CLI 分派

**Files:**
- Create: `apps/desktop/src-tauri/src/elevation_install.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs`（`--elevation-install`/`--elevation-uninstall` 分派）
- Modify: `apps/desktop/src-tauri/Cargo.toml`（runas 1.2、windows-registry 0.100）
- Test: `elevation_install.rs` 内嵌单测

**Interfaces:**
- Consumes: Task 1 proto 常量；Task 2 的服务名常量（`SERVICE_NAME` 定义在 elevation_service 并 pub）。
- Produces: `pub fn run_install() -> Result<(), InstallError>`（提权进程内执行，§0.2 流程）；`pub fn run_uninstall() -> Result<(), InstallError>`；`pub fn trigger_install() -> Result<(), InstallError>`（**非提权**应用侧入口：`runas::Command::new(current_exe).arg("--elevation-install")`）；`pub fn decide_service_action(exists: bool, image_path: &str, want_image_path: &str) -> ServiceAction`（**纯函数**：ChangeService vs Create vs 无操作）；`pub fn copy_self_to(dir: &Path) -> Result<PathBuf>`。
- 关键实现要点：ProgramData 路径=环境变量 `PROGRAMDATA` + `TotpTools\\service`；目录 ACL 收紧用 `SetNamedSecurityInfoW`（SDDL 见 §0.2）；服务安装用 windows-service `ServiceManager` + `ServiceInfo::new`（LocalSystem、DemandStart、WIN32_OWN_PROCESS）；HKLM 写绑定三值（windows-registry）；`--elevation-uninstall` 容忍 `ERROR_SERVICE_MARKED_FOR_DELETE`（匹配 os error 1072 不报错）。
- 单测：`decide_service_action` 四例（不存在=Create；Image 相同=None；Image 不同=Change；路径含副本目录即视为 want）；`copy_self_to` 在 tempdir 真复制断言字节一致（fs 读自身 `current_exe`）。

- [ ] Step 1: 失败测试 → 红
- [ ] Step 2: 实现 → 绿；`cargo test`/fmt/clippy
- [ ] Step 3: Commit `feat(security): ABE 服务提权安装与卸载（UAC 单命令+ProgramData 副本+HKLM 绑定）`

### Task 4: elevation_client 应用侧客户端 + desktop 宿主 AbeOps

**Files:**
- Create: `apps/desktop/src-tauri/src/elevation_client.rs`
- Create: `apps/desktop/src-tauri/src/elevation_commands.rs`（Tauri command 层）
- Modify: `apps/desktop/src-tauri/src/lib.rs`（invoke_handler 注册）
- Modify: `apps/desktop/src/securityPlatform.ts`（AbeOps 宿主实现 + 装配）
- Test: `elevation_client.rs` 内嵌单测、`apps/desktop/test/`（若现有 securityPlatform 测试文件存在则追加，无则新增 abeOps.test.ts）

**Interfaces:**
- Consumes: Task 1 proto、Task 3 trigger_install。
- Produces（前端契约，Task 5/6/7 依赖）：
  - Tauri commands（均 cfg(windows)，非 windows 返回 supported:false）：`abe_status() -> { supported, installed, matches_caller, bound_path?, version? }`、`abe_bind() -> { ok }`（内部：trigger_install UAC → 成功后 1.5s 内轮询 Status 至服务可达，最多 10s）、`abe_remove() -> { ok }`（管道 Remove）
  - TS 侧 `AbeOps` 实现 `abeOps: AbeOps`（invoke 包装）并在 `securityPlatform.ts` 导出装配
- 客户端实现要点：`CreateFileW(PIPE_NAME, GENERIC_READ|WRITE)` 打开（服务未运行 ERROR_FILE_NOT_FOUND → `{installed:false}` 语义上抛）；写帧后读响应帧（`ReadFile` 循环至完整帧，超时 3s——管道字节模式需按 len 精确读）；Unwrap 响应 DEK 以 `Vec<u8>` 返回 invoke 层后**立即** zeroize 中间缓冲。

- [ ] Step 1: 帧读写的失败测试（用内存 dup 模拟流：半帧到达/分片到达/超长 len 拒绝）→ 红
- [ ] Step 2: 实现 client 与 commands → 绿
- [ ] Step 3: TS 侧 AbeOps 包装 + 单测（mock invoke：status/bind/remove 三路径，bind 的 UAC 失败传播）
- [ ] Step 4: `cargo test` + `pnpm -F @totp/desktop test` + fmt/clippy/typecheck
- [ ] Step 5: Commit `feat(security): ABE 应用侧管道客户端与 Tauri 命令`

### Task 5: core/ui 数据面接线（encryptionSession + securityPlatform 接口）

**Files:**
- Modify: `packages/ui/src/store/encryptionSession.ts`（abeSource computed + addAbeSourceOp/removeAbeSourceOp）
- Modify: `packages/ui/src/components/securityPlatform.ts`（`AbeOps` 接口定义 + SecurityPlatform 挂载点）
- Modify: `packages/ui/src/components/SecurityCard.vue` 的 props 注入链（仅接口层，不写 UI——UI 在 Task 6）
- Test: `packages/ui/test/encryptionSession.abe.test.ts`（新文件）

**Interfaces:**
- Consumes: Task 1 core abe 源；Task 4 AbeOps 宿主实现。
- Produces: `encryptionSession` 新增 `abeSource: ComputedRef<KekSource | undefined>`（kind==='abe' 单份）、`addAbeSourceOp()`（withAbeSource 写回 security store）、`removeAbeSourceOp()`；`SecurityCard` 接收 `:abe="abeOps"`（supported=false 时 UI 不渲染——Task 6 消费）。
- 语义：abe 源存在与否即"已启用 ABE"；启用动作由 Task 6 的 UI 编排（bind 成功后调 addAbeSourceOp），本任务只提供 ops。

- [ ] Step 1: 失败测试（abeSource 读取/添加/移除/与 dpapi 源并存）→ 红
- [ ] Step 2: 实现 → 绿；`pnpm -F @totp/ui test` + typecheck（desktop/extension 两宿主 typecheck 必须过——接口是新增可选 prop，不破坏现装配）
- [ ] Step 3: Commit `feat(ui): encryptionSession abe KEK 源 ops 与 AbeOps 平台接口`

### Task 6: SecurityCard ABE 区块 UI（三态）+ i18n

**Files:**
- Modify: `packages/ui/src/components/SecurityCard.vue`（unlock-methods 区 dpapi 区块后加 abe 区块）
- Modify: `packages/ui/src/i18n/locales/zh/common.json`、`en/common.json`（`securityCard.abe*` 键）
- Test: `packages/ui/test/SecurityCard.abe.test.ts`（新文件）

**Interfaces:**
- Consumes: Task 5 的 `:abe` prop 与 ops。
- Produces: 三态 UI（§0.3）：未安装→`安装服务` 按钮（busy 态防重复点击：点击→`abe.bind()` UAC→成功后 `addAbeSourceOp()`→刷新 status）；已绑定且 matchesCaller→状态行（`版本 {version} · 绑定 {boundPath 尾段}`）+`移除`（`removeAbeSourceOp()`+`abe.remove()`，双击确认沿用 remove 两击模式）；已绑定失配→提示行`应用已更新或路径已变，需要重新绑定`+`重新绑定`（=bind 流程）。`supported=false` 不渲染。所有文案 zh/en 双语（键名 `securityCard.abeTitle/abeInstall/abeInstalling/abeRemove/abeMismatch/abeBoundLine/abeRemoveConfirm`）。

- [ ] Step 1: 失败测试三态（mount mock abe prop：supported false 不渲染 / installed+match 渲染状态行+移除 / installed+失配 渲染重绑；点击绑定调用序列 abe.bind→addAbeSourceOp）→ 红
- [ ] Step 2: 实现+双语键 → 绿；`pnpm -F @totp/ui exec vitest run test/SecurityCard.abe.test.ts` + 全量 + typecheck
- [ ] Step 3: Commit `feat(ui): SecurityCard 应用绑定解锁区块（安装/绑定/失配重绑三态）`

### Task 7: LockScreen 静默解锁 abe→dpapi 回退

**Files:**
- Modify: `packages/ui/src/components/LockScreen.vue`（onMounted 静默链）
- Test: `packages/ui/test/lockScreen.abe.test.ts`（新文件）

**Interfaces:**
- Consumes: Task 5 abeSource；现有 dpapi ops；新增 prop `:abe`（`{ status(): Promise<…>; unwrap(): Promise<Uint8Array | null> }` 形态，宿主 desktop 实现=管道 Status+Unwrap 包装，extension 宿主不传→跳过 abe）。
- 语义：abeSource 存在且 abe 可用 → 先试 abe Unwrap → 成功 unlockWithDek；失败（异常/返回 null/服务不可达）→ 无声回退现有 dpapi 静默路径 → 两者皆败维持现有 1s 后"重试"UI。**回退必须静默**（不打断、不重复报错，abe 失败信息 console.warn 留痕）。

- [ ] Step 1: 失败测试（abe 成功不试 dpapi / abe 失败回退 dpapi 成功 / 两者失败显示重试）→ 红
- [ ] Step 2: 实现 → 绿；`pnpm -F @totp/ui exec vitest run test/lockScreen` + 全量
- [ ] Step 3: Commit `feat(ui): 锁屏静默解锁 abe 优先 dpapi 回退`

### Task 8: NSIS 卸载钩子 + README + 真机清单

**Files:**
- Modify: `apps/desktop/src-tauri/tauri.conf.json`（`bundle.windows.nsis.installerHooks` 指向新文件）
- Create: `apps/desktop/src-tauri/windows/hooks.nsh`（NSIS_HOOK_PREUNINSTALL：`sc stop TotpToolsElevationService`、`sc delete TotpToolsElevationService`、`RMDir /r "$COMMONPROGRAMDATA\TotpTools\service"`、注册表键删除；容忍服务不存在）
- Modify: `README.md`（安全节：ABE 威胁模型 §0.4 摘要）
- Create: `docs/e2e/2026-10-07-abe-service-checklist.md`（真机清单：安装→启用→锁屏自动解→哈希失配重绑→便携目录迁移失配→移除→卸载清理）

- [ ] Step 1: hooks.nsh + tauri.conf.json 接线（NSIS 构建本地验证 `pnpm -F @totp/desktop tauri build` 产 setup 不报错）
- [ ] Step 2: README 安全节 + e2e 清单文档
- [ ] Step 3: Commit `feat(desktop): ABE 服务 NSIS 卸载钩子与真机清单`

### Task 9: 全量回归

- [ ] `pnpm -r run test && pnpm -r run typecheck && cd apps/desktop/src-tauri && cargo test && cargo clippy && cargo fmt --check`
- [ ] 三端手动冒烟（桌面 dev：SecurityCard 区块三态走查；安装服务真机验证列入 e2e 清单，不阻塞本计划完成）
