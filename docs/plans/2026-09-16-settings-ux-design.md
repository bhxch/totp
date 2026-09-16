# 设置体验与 M3 合规设计（口令/触发器/路径/导入说明/视觉）

日期：2026-09-16
状态：已定稿（用户逐项确认）
上游 spec：`docs/plans/2026-09-13-totp-tool-design.md` §6 备份与同步、§7 密钥与解锁体系

## 1. 背景与目标

用户评审现有设置体验提出六项调整：

1. 口令输入过多（本地备份口令+确认、云同步口令、安全加密口令+确认，共 4 组互不相通）
2. 本地备份与云同步均需支持路径设置
3. 各口令缺用途说明
4. 导入卡首屏无支持格式说明
5. 配色/字号疑偏离 Material Design 3（复选框视觉偏重；字号无字阶体系）
6. 备份/云同步缺触发器（变更后自动、定时自动），且写入前应做变更检测避免重复写盘/上传

调研结论（2026-09-16 代码核查）：

- 4 组口令是计划 4（备份 envelope 自带口令）→ 计划 6（vault 加密自带口令）→ 计划 10（裁定 CloudCard 独立口令输入）逐计划叠加的实现产物；spec §7 只规定 vault 口令模式，§6 只规定云备份文件「固定用口令加密、可更换」，从未要求三把口令互相独立。
- spec §6 桌面本地备份本就承诺「可选目录」，实现固定写 AppData/backups 未做目录选择（`apps/desktop/src/backupService.ts:5,9-14`），属 spec 偏差。
- 云端对象路径硬编码 `totp-backup.totpbackup`（`packages/ui/src/components/cloudPlatform.ts:7`）。
- 导入支持 17+ 格式（`packages/core/src/import/sniff.ts:8-30`），但 ImportCard idle 首屏只有按钮无说明（`ImportCard.vue:524-528`）。
- 色板由官方 `@material/material-color-utilities` 生成（`packages/ui/src/theme/generate.mjs`），色彩 token 合规；但全仓库无 M3 字阶 token，字号为组件硬编码 12/13/14/16px。未选中复选框为透明底 + `on-surface-variant` 深灰描边（`MdCheckbox.vue:25-27`），属规范值但视觉偏重；输入框填充 `surface-container-highest` 同为规范值。
- 本地备份纯手动且无变更检测（每次必写盘）；云同步纯手动但已有 sha256 去重与 cloudRev 基线（`packages/core/src/cloud/syncOrchestrator.ts:52-114`）；浏览器同步已是变更即推。

## 2. 已确认决策

| # | 决策 | 选择 |
|---|------|------|
| D1 | 口令方案 | **两把口令**：库口令（安全页，加密本机 vault + 解锁）与备份口令（加密本地备份文件与云端对象，两者共用）；**备份口令支持「记住到本库」，解锁库即备份同步** |
| D2 | 触发方式 | 变更后自动 + 定时自动（两者都要），写入前变更检测；扩展端本地备份不参与自动触发 |
| D3 | 视觉方向 | **全面对齐 M3 规范**：字阶 token 化 + 逐组件对照官方规范修正，色彩角色值不自行发挥 |
| D4 | 路径设置 | 桌面备份目录可选（补 spec 承诺）+ 云同步各后端目标路径可选 |
| D5 | 说明文案 | 口令三处 + 导入卡首屏格式说明 |
| D6 | 云同步多端 | **多目标同时同步**：凭据数组 + 各目标独立基线 + 收敛规则，共用备份口令 |

## 3. 口令架构（D1）

### 3.1 两把钥匙

- **库口令**（现状保留）：安全页设置，Argon2id 派生 KEK 解包 DEK 加密本机 vault；兼做锁屏解锁；解锁方式多绑（口令 / Passkey PRF / Windows DPAPI，`packages/core/src/security/multiKek.ts`）。仅补文案：「此口令用于加密本机存储的验证库数据，与备份口令相互独立」。
- **备份口令**（新聚合）：同步页新增「备份口令」MdCard（置于本地备份/云同步两卡之上），含：
  - 说明文案：「用于加密本地备份文件与云端同步对象，两者共用」+ 保管状态说明
  - 口令 + 确认输入（会话内首次输入）
  - 「记住到本库」开关（见 3.2）
  - 会话状态行（已输入 / 已从库中装载 / 未设置）与「清除」按钮
- BackupCard、CloudCard **删除各自口令输入框**，操作时从 store 会话缓存读取；未就绪时对应按钮禁用并提示「先在上方设置备份口令」。

### 3.2 备份口令入库存放（记住到本库）

- 开启后备份口令作为加密字段写入 vault（受 DEK 加密保护，随库落盘/同步）。效果：**解锁本地库即备份/云同步全自动可用**（含自动触发器），刷 Windows Hello（PRF）或 DPAPI 静默解锁后同样生效。
- 密码学裁定：库内不再对备份口令单独套 PRF/DPAPI 包裹——能读库明文者本可得之，单独包裹是冗余；原生解锁经库的多绑解锁方式（计划 11）间接达成，零新增加密机制。
- 守护规则：
  - 「记住到本库」要求 vault 加密已启用；未启用时开关禁用 + 引导文案（否则口令明文落盘）
  - 关闭加密（disableEncryption）时自动清除所存备份口令，回退会话输入，UI 明确提示
  - 锁定（`store.lock()`）清除会话缓存；关闭开关即从库中删除该字段
- 跨设备/灾备链路：
  - 新设备首次：手动输入备份口令打开云端 envelope → 恢复库 → 口令已在库内 → 此后免输
  - 旧口令备份恢复：当前口令解不开时回退弹一次性口令输入（信封格式 v1 不变，旧备份始终可开）
  - 云同步换口令：提供「用新口令重置云端」显式操作（重加密上传覆盖远端，两步确认；符合 spec §6「更换后重加密重传」）
- 原生托管覆盖（按端补齐，能力探测驱动）：
  - 桌面端统一 `osAutoUnlock` 通道（语义一致：OS 安全存储包裹随机 KEK → 解锁时取回静默解锁）：Windows = DPAPI（已实现，`apps/desktop/src/tauriSecurity.ts`）；**macOS = Keychain、Linux = Secret Service（GNOME Keyring/KWallet）——本次新增实施项**，Rust 侧经 keyring/原生 API，与 DPAPI 同构对接 `DpapiUnlockOps`（泛化为 `OsAutoUnlockOps`）
  - Linux 无 keyring 服务的环境 / macOS WKWebView 的 PRF 受限场景：能力探测失败 → 对应选项不渲染（与现有 `prfCap` 探测同模式），不出现「显示了却不可用」
  - 扩展端仅 PRF；文案按认证器探测结果渲染，不写死 Windows
  - UI 选项与全部相关文案按 OS + 能力探测动态生成（见 7.3），macOS/Linux 不再缺位

### 3.3 数据与会话

- store 新增 `backupSecret` 会话态（明文口令，仅内存，与现状 CloudCard 会话保留同级）与 `setBackupSecret/clearBackupSecret`；`lock()` 一并清除。
- vault settings 新增可选字段（经 DEK 加密随库存储/同步）：`rememberedBackupSecret?: string`。
- 涉及文件：`packages/ui/src/store.ts`、`packages/ui/src/components/BackupCard.vue`、`CloudCard.vue`、新增 `BackupSecretCard.vue`；扩展 options 页同构接线。

## 4. 备份/云同步触发器（D2）

### 4.1 触发配置

本地备份卡与云同步卡各自独立配置，偏好持久化于平台本地（与 `backupMode` 同层，不随库同步）：

- 「变更后自动执行」开关：挂接 store 写提交钩子，防抖 10s 合并连续操作
- 「定时自动执行」开关 + 间隔选择（15 分钟 / 1 小时 / 6 小时 / 每天）；桌面 `setInterval`，扩展 `chrome.alarms`（`apps/extension/entrypoints/background.ts` 已有 alarms 使用先例）
- 自动执行结果不打扰，卡片状态行显示「上次自动备份/同步：时间 + 成功/失败原因」

### 4.2 变更检测（防重复写入）

- 执行前计算 vault JSON sha256 与基线比对：本地备份新增 `lastBackupHash` 基线（平台本地）；云同步基线按目标独立（`cloudRev.{backend}`，见 §6；原单目标机制 `syncOrchestrator.ts:52-92`）
- 相同 → 跳过写入，仅更新「上次检查时间」
- **手动操作不跳过**（本地备份手动 = 明确快照意图，始终写入）；云同步手动保持现有 in-sync 跳过语义
- 前置条件：会话内有备份口令（或已从库装载）且未锁定；锁定期间自动触发静默暂停

### 4.3 平台裁定

- 桌面端：本地备份与云同步均支持两种自动触发
- 扩展端：本地备份 = 浏览器 Blob 下载，自动下载不可接受 → **自动触发仅适用云同步**；扩展本地备份仅手动
- 浏览器同步（SyncCard）已是变更即推（`background.ts:11-12,114-120`），不动

## 5. 路径设置（D4）

### 5.1 桌面备份目录

- BackupCard 新增「备份目录」行：当前路径展示 + 「更改…」（Tauri dialog 选目录）+ 「恢复默认」；偏好存桌面本地（与 `backupMode`/`backupKeepN` 同层）
- `backupService.ts` 改为写入所选目录（默认仍是 AppData/backups）；冲突副本目录跟随；沿用 Rust 端 allowed_dir 白名单校验机制（`backupService.ts:16-26` 先例）
- 补齐 spec §6「备份到本地文件（可选目录）」的既有承诺

### 5.2 云同步目标路径

CloudCard 各后端动态字段新增「目标文件路径」，默认均为现硬编码值，随 `cloudCred` 持久化（`packages/core/src/cloud/cloudPlatform.ts` 的 `CLOUD_BACKUP_PATH` 改为按凭据字段解析）：

| 后端 | 字段语义 | 默认值 |
|------|---------|--------|
| WebDAV | 远端路径 | `/totp-backup.totpbackup` |
| S3 | 对象键（叠加 prefix） | `totp-backup.totpbackup` |
| OneDrive | 远端路径 | `totp-backup.totpbackup` |
| GitHub Gist | gist 内文件名 | `totp-backup.totpbackup` |
| Google Drive | 文件名（创建后由 fileId 定位，改名=新建文件，附提示） | `totp-backup.totpbackup` |

扩展端本地备份说明文案注明「由浏览器下载目录决定」。

## 6. 云同步多目标（D6）

背景：现状云端凭据单选（`cloudCred` 单对象，CloudCard 后端下拉，`CloudCard.vue:233-239`），`cloudRev` 单基线，切后端即换目标。已确认支持多目标同时同步（如 WebDAV + OneDrive 同时启用）。

### 6.1 凭据模型

- `cloudCred` 单对象 → `cloudCreds` 数组（每项 `{backend, enabled, ...字段}`）；旧数据读取迁移为首项（enabled=true），向后兼容
- CloudCard「后端下拉单选」→「目标列表」：每后端一行（启用开关 + 展开凭据表单 + 目标路径字段 + 状态行），可多行同时启用；凭据按目标独立保存
- 目标路径字段（§5.2）随多目标结构落地

### 6.2 同步编排（core syncOrchestrator 多目标化）

- 顺序遍历启用目标（避免并发限流），每目标独立执行现有三分支逻辑（内容相同跳过 / 本地新推送 / 云端新拉取+冲突副本，`syncOrchestrator.ts:52-114`）
- 基线按目标独立：`cloudRev` → `cloudRev.{backend}`；冲突副本文件名带后缀（`conflict-{backend}-{ts}.totpbackup`）
- **收敛规则**：本轮第一个产生「新 vault」的目标结果作为基准，其余目标与基准对齐推送——多目标最终收敛到同一份最新数据，防目标间互相打架（如两台设备各写了一个后端）
- 上传后回读 sha256 校验照旧（逐目标）
- 口令：**所有目标共用备份口令**（不支持每目标不同口令——复杂度陡增且破坏备份口令入库语义）

### 6.3 状态与触发器衔接

- 状态行按目标显示：「WebDAV：已上传 · OneDrive：已是最新」
- 触发器（§4）遍历所有启用目标；全部内容未变则整体跳过
- 代价如实：上传流量/请求数随目标数线性增长

## 7. 说明文案（D5）

### 7.1 导入卡首屏（ImportCard idle 态）

- 一句话简介：「选择文件后自动识别格式；不确定格式可直接尝试」
- 「支持的导入格式」折叠面板，分组列出：
  - 加密备份类：Aegis（加密/明文）、WinAuth（明文/口令）、Authy
  - 应用导出类：2FAS、Bitwarden、Proton Authenticator、Stratum、FreeOTP+、旧版 FreeOTP、andOTP、TOTP Authenticator、Battle.net、Duo、Microsoft Authenticator
  - 文本与通用类：otpauth URI 批量文本、通用 JSON/JSONL/SQLite（自定义字段映射）
- 注明「通用格式可用字段映射自定义，映射方案可保存复用」（现状能力：`ImportCard.vue:554-572`）

### 7.2 口令文案

- 安全页：「此口令用于加密本机存储的验证库数据，与备份口令相互独立」
- 备份口令卡：「用于加密本地备份文件与云端同步对象，两者共用；开启记住后随库存放，解锁库即可用」
- 换口令/重置云端等两步确认处补影响说明

### 7.3 解锁方式入口的发现性与按端适配（用户评审发现）

现状核实：解锁方式选项**已实现且双端已接线**——「安全」页安全卡内「解锁方式」区（`SecurityCard.vue:182`，添加 Passkey 解锁 / Windows 自动解锁的启用与移除）；桌面宿主注入 prf+dpapi（`apps/desktop/src/App.vue:200,216`），扩展仅 prf（dpapi 桌面限定）。但该区仅在「已启用加密且当前解锁」时渲染，未启用加密时提示文案（`SecurityCard.vue:176-177`）完全未提及存在 Passkey/DPAPI，用户找不到入口。

修正（选项与文案一律由「端 + 能力探测」驱动，不写死 Windows）：

- 未启用加密态提示按端生成：「启用后可绑定{平台解锁名}或{原生自动解锁名}，免输口令」，其中平台解锁名/原生自动解锁名按下表；宿主未提供对应能力（如 Linux 无 keyring 服务）时该名词不出现
- 解锁方式区标签、LockScreen 按钮、引导文案同源取名，统一由 platform 注入的通道描述（`osAutoUnlock.label`、PRF 认证器描述）渲染
- 锁定态 LockScreen 对已绑定来源展示对应按钮（现状已有），对未绑定来源不引流

| 端 | 平台解锁（PRF 认证器名） | 原生自动解锁名 |
|----|------------------------|----------------|
| Windows 桌面 | Windows Hello | Windows 自动解锁（DPAPI） |
| macOS 桌面 | Touch ID（受 WKWebView 能力探测约束） | 钥匙串自动解锁（Keychain） |
| Linux 桌面 | Passkey（安全密钥，按探测） | 密钥环自动解锁（Secret Service） |
| 浏览器扩展 | Passkey（浏览器认证器，按探测） | ——（无原生通道） |

## 8. M3 视觉审查与修正（D3）

### 8.1 审查报告先行（不阻塞其他部分）

- 产出 `docs/review/2026-09-16-m3-audit.md`：浅色/深色 × 组件截图，逐条对照 M3 官方组件规范（色彩角色、状态层透明度 hover 8%/pressed 12%/focus 12%、形状、字阶）
- 定位用户所指「复选框底色偏深」具体来源（候选：输入框 `surface-container-highest` 填充、复选框 `on-surface-variant` 描边），以规范条目裁定

### 8.2 字阶 token 化（已确认的真实缺口）

- 新增 `--md-sys-typescale-*` CSS 变量（`packages/ui/src/theme/`，与现有 generate.mjs 体系同源），替换组件内硬编码 12/13/14/16px，统一到 M3 字阶（body-large 16 / body-medium 14 / label-large 14 / body-small 12 / title-medium 16 等按映射表落地）
- 修正以规范为准：色彩角色值不自行发挥；卡片双描边（MdCard outlined + 各卡自身 border）等实现层偏差逐项对照修正
- 回归：浅色/深色截图对比 + 既有 E2E 全过

## 9. 兼容性与安全不变量

- 信封格式 v1 不变；旧备份/旧云端对象始终可开（口令回退输入）
- 口令不落盘不变量不破坏：备份口令入库 = vault DEK 加密保护，等于现有 secret 的保护级别
- 关闭加密必须清保管口令；锁定必须清会话口令；口令不出现在日志/遥测（无遥测）
- 云端/浏览器 sync 通道只见密文不变量不变
- 云凭据结构迁移向后兼容：旧 `cloudCred` 单对象读取为首目标；`cloudRev` 键迁移至 `cloudRev.{backend}`

## 10. 实施顺序与测试

1. M3 审查报告（独立产出，不阻塞 2-5）
2. 口令聚合 + 备份口令入库（store/卡片/守护规则）+ 桌面 `osAutoUnlock` 通道补齐（macOS Keychain / Linux Secret Service，Rust 侧）与通道文案按端注入
3. 触发器（变更检测 core 模块 + 两端接线）
4. 云同步多目标（凭据模型迁移、编排收敛规则、CloudCard 目标列表）+ 路径设置（桌面目录 + 各后端目标路径字段，随多目标凭据结构落地）
5. 导入/口令文案
6. 字阶 token 化与视觉修正（依审查报告）
- 每步 TDD、独立 commit；core 变更（变更检测、多目标编排、路径解析、settings 字段）配单测；UI 配既有组件测试模式；终局跑既有 E2E 与构建

## 实施勘误（2026-09-16，plan15 落地后回写）

以下为实现与本文档设计的偏差/澄清，均已核对代码后记录：

1. **§4.1 扩展端定时触发**：原定「扩展 `chrome.alarms`」不可行——Service Worker 后台不持有解锁 DEK 与会话备份口令，alarm 触发的同步无法读取口令完成加密。改为 options 页存活期运行 core `createAutoRunScheduler`（`setInterval` 30s tick 判断定时到点）+ store 写提交钩子（`onCommittedExtra`）接入防抖 10s 的 change 通道，页面卸载即停；`chrome.alarms` 零新增。代价如实：扩展自动云同步依赖 options 页存活。
2. **§3.3/§6.1 CloudCard 接口收口**：CloudPlatform 旧单目标四成员（loadCred/saveCred/loadHash/saveHash）与 getPassword（旧口令输入的取值通道）随口令框一并删除（无消费方），接口定型为 loadCreds/saveCreds/loadTargetHash/saveTargetHash + autoPrefs/loadAutoStatus。
3. **§5.2/§6 目标路径落地口径**：ui `CLOUD_BACKUP_PATH` 常量保留导出但零消费（deprecated，仅为兼容引用），路径统一走 core `resolveObjectPath(cred.objectPath)`——trim 后空值回落默认 `totp-backup.totpbackup`，拒绝 `\0` 与 `.`/`..` 相对段，多段统一 `/` 分隔。
4. **§4.2 手动语义确认**：本地备份手动始终写入已实现（`decideAutoRun` 仅约束自动路径，手动不经此函数）；云同步手动经多目标编排对 in-sync 目标跳过（与原设计一致），且下载/冲突采纳目标的基线延后至「采用云端」两步确认成功才落盘，取消则保持旧基线下轮重比。
5. **§8.2 字阶落地细节**：label-medium(12) 已定义零引用（预留档）；MdDialog headline 保留 20px 硬编码（M3 headline-small 24 不适用弹窗，审查裁定例外）；MiniApp 验证码/密文统一走 code-large(18)（项目自定义档，`OtpListItem`/`RevealDialog`）。
6. **§8.1 M3 审查落点与结论**：报告为 `docs/review/2026-09-16-m3-audit.md`；「复选框底色偏深」根因裁定为 popup 原生 checkbox + `color-scheme: dark` 的 UA 深色填充（已换 MdCheckbox 修正）。挂账不在本轮：BackupCard 原生 radio（候选 MdSegmentedButton/MdRadio）、interval 原生 select、MdSwitch 未选中拇指 16dp、Rail/Tabs label 档位（title-small 14 档 tokens 层裁定）、after 证据图未入库（仅存 `.temp/m3-audit/after/`）。
7. **§3.2 osAutoUnlock 三平台边界**：统一通道落地（Windows 委托 DPAPI / macOS Keychain / Linux Secret Service 经 keyring crate）；mac/Linux 分支在 Windows 构建上仅编译门控（cfg 不编译不下载依赖），运行时行为登记 backlog 待真机验证——Windows 委托路径已由真实 CryptProtectData roundtrip 单测实跑。
