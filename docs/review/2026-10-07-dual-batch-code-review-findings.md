# 双批次代码审查问题清单（七路子代理审查）

- 日期：2026-10-07
- 类型：代码审查发现清单 + 修复跟踪（当批修复已完成，本文档转为存档；遗留项见 §11 与 backlog B25）
- **修复结论（2026-10-07 当日）**：1 Critical + 13 Important + 全部 Minor + Recommendations 已当批修复完毕（41 commits，`d809a76..bed3739`），详见 §11 修复波次记录。唯一遗留：R6-I2 根本方案（Authenticode 签名校验）登记 backlog B25 另立 round。
- 审查范围：
  - 批 1 `docs/superpowers/specs/2026-10-06-miniapp-sorting-cloud-fixes-design.md` → 代码 `0f7d731..9540a7b`（miniapp / 排序 / 云备份）
  - 批 2 `docs/superpowers/specs/2026-10-06-seven-features-design.md`（P1–P6）→ 代码 `276d3b0..7d378b2`
- 审查方式：7 个审查子代理（R1–R7）分主题审查，只读；各审查者实测相关测试（core/ui/desktop vitest、`cargo test elevation` 67 例等，全绿）后出具报告。
- 编号规则：`R<审查面>-<级别><序号>`；级别 C=Critical / I=Important / M=Minor / REC=Recommendation。状态：`待修` / `已修 <commit>` / `裁定不动`（含理由）。

## 0. 总评与结论

整体工程质量高于平均：测试多为行为级、终审修复闭环、偏差均有文档留痕。合计 **1 Critical + 13 Important + 约 40 Minor + 12 条建议**。P2 的 Critical 直接威胁桌面端升级路径（未真机验证的含冒号文件名）；P6 两个 Important 击穿 ABE 威胁模型核心声明（副本注入 LPE 面、便携版调用者冒充）。

| 审查面 | 覆盖 | 结论 | C | I |
|---|---|---|---|---|
| R1 | 批1 §1+§2 miniapp | Yes（R1-I1 后续跟进） | 0 | 1 |
| R2 | 批1 §3+§4 排序+云备份 | With fixes | 0 | 1 |
| R3 | 批2 P1+P3 | With fixes | 0 | 2 |
| R4 | 批2 P2 导入增强 | With fixes | 1 | 3 |
| R5 | 批2 P4+P5 | With fixes | 0 | 3 |
| R6 | 批2 P6 ABE 服务端 | With fixes（真机发布前必修 R6-I1） | 0 | 2 |
| R7 | 批2 P6 ABE 应用侧 | With fixes | 0 | 1 |

## 1. 修复跟踪总表

| 编号 | 级别 | 域 | 一句话 | 状态 |
|---|---|---|---|---|
| R4-C1 | Critical | P2 存储 | per-icon 键含冒号 → 桌面端 NTFS ADS 流/升级白屏风险（未真机验证） | 已修 d809a76 |
| R6-I1 | Important | P6 服务端 | 副本 exe 复制后无完整性复核，预开共享句柄可注入 SYSTEM 服务（LPE 面） | 已修 433eb12 |
| R6-I2 | Important | P6 服务端 | 调用者哈希校验文件替换 TOCTOU，便携版可冒充调用者取 DEK | 已修 e8b9b3d（窗口压缩档；根本方案签名校验 → backlog B25） |
| R7-I2 | Important | P6 应用侧 | 换口令后 rewrap 联动死代码，ABE UI 假"已启用" | 已修 cccdb23 |
| R4-I1 | Important | P2 解析 | WinAuth 导出 txt 的 Steam 条目被静默导入为普通 TOTP，验证码必错 | 已修 22b2d30 |
| R2-I1 | Important | 批1 桌面 | 禁用 drag-drop handler 后 WebView2 默认投放导航可替换 SPA（丢解锁会话） | 已修 c72b0c3 |
| R5-I1 | Important | P4 popup | URL 过滤滤空时空态显示"暂无条目"误导（旧行为是 noMatch） | 已修 3b13d07 |
| R3-I1 | Important | P3 反馈 | desktop 复制失败出现"已复制"toast + 失败横幅矛盾双反馈 | 已修 02e8a0d |
| R3-I2 | Important | P1 气泡 | 说明气泡缺"切换标签"关闭条件，禁用态可挂泡 | 已修 eb13d9e |
| R5-I2 | Important | P5 分流 | 多条分流通知不可点击、引导不闭环 | 已修 b28cdbd |
| R5-I3 | Important | P5 信封 | pending 信封无过期/清理，明文 secret 无限期留存 | 已修 eb31c13 |
| R4-I2 | Important | P2 存储 | 批量写实为串行逐键 await（spec"单事务"静默降级） | 已修 5d16899 |
| R4-I3 | Important | P2 存储 | putMany 中途失败内存-盘面不一致 | 已修 5d16899 |
| R1-I1 | Important | 批1 桌面 | mini-ready 门控可被二次触发绕过（重建在途判定洞） | 已修 c24bea6 |
| （M 级明细见各审查面小节与 §11，共约 40 条，全部当批修复或裁定留档） | | | | |

## 2. R4 —— P2 导入增强（iconStore / 上限放宽 / WinAuth 文本）

### Critical

**R4-C1 桌面端 per-icon 键未做 Windows 文件名适配，失败模式是启动白屏，且未做真机验证**
- 位置：`apps/desktop/src/tauriFs.ts:4`（`file(key) = key + '.json'`）× `packages/ui/src/iconStore.ts:49`（`ICON_DATA_PREFIX='icon:'`）× `apps/desktop/src/desktopShell.ts:387-388`（init 抛错 → loadError 整屏）。
- Windows 实测：`icon:xxx.json` 写入落入 0 字节基文件 `icon` 的 NTFS ADS 流；.NET 层直接拒绝该路径；Node 层 `rename('icon:xxx.json.tmp' → 'icon:xxx.json')` 报 EINVAL——`tauriFs.set`（tauriFs.ts:55-57）恰是"写 .tmp 再 rename"原子写。老用户升级路径是 `init()` 迁移逐键 `adapter.set('icon:<id>')`，若 Rust rename 同样失败 → 桌面端升级后直接白屏。附带：id 取自不可信 zip 文件名，`normalizeIssuer`（iconImport.ts:162-163）不滤 `\`、`"`、`*`，Windows Explorer 历史 zip 用 `\`，会写到不存在的子目录（旧单键布局对此免疫，P2 新引入回归）。docs/e2e 无 P2 真机清单。
- 修法：tauriFs 层对键名做安全映射（encodeURIComponent，可逆、同时覆盖 `icon:` 与既有 `urlcache:` 键）；normalizeIssuer 输出白名单化；init 迁移循环 per-key 容错（迁移失败不炸整屏）；补 P2 桌面真机冒烟清单。

### Important

**R4-I1 WinAuth 导出 txt 中的 Steam 条目被静默导入为普通 TOTP**
- 位置：`packages/core/src/import/uriBatch.ts:40-41`。官方 `ToUrl`（WinAuthAuthenticator.cs L745-760）对 Steam 条目输出 `otpauth://totp/Steam:...?secret=...&digits=5&deviceid=...&data=<UrlEncode(SteamGuard JSON)>`——scheme 是 totp，不命中 steam 分支；Steam 码需 STEAM_ALPHABET 取模算法，导入后验证码必错。`data=` 参数里就是完整 SteamGuard JSON，本可重建 steam 条目。
- 修法：行 query 含 `deviceid`+`data`（WinAuth Steam 特征）时解码 `data` 复用 `importSteamGuard` 重建 steam 条目，至少归入 suspect（符合 spec §2.2"不确定时归入 suspect"约定）。

**R4-I2 "批量一次写"实现为串行逐键 await**
- 位置：`packages/ui/src/iconStore.ts:76-82`（persistKeys for-await）、`iconImport.ts:197`（putMany 传 2000+ 键）。2000 图标 = 2000 次串行 IPC，扩展端每次独立消息往返可感知数秒；spec §2.1"单事务批量写"因 StorageAdapter 无批量接口实际未实现，降级未记录。
- 修法：persistKeys / removeMany / removePack / 迁移循环改 `Promise.all` 并行（init 读路径终审已这么做）；中期 adapter 加 `setMany`。

**R4-I3 putMany/removeMany 中途失败的内存-盘面不一致**
- 位置：`packages/ui/src/iconStore.ts:140-145`。`Object.assign` 先更新内存，persistKeys 第 k 键抛错时索引未写——已写数据键成孤儿，重启后本次全部新图标丢失。
- 修法：putMany 入口保存 known 快照，失败回滚内存新增；或失败路径补偿删除已写数据键。

### Minor

- **R4-M1 数字型字段口径窄于 WinAuth 官方宽松解析**：`registry.ts:136-140` sniffSteamGuard 要求 serial_number/device_id 为 string，官方对数字也接受（AddSteamAuthenticator.cs L497-511/L541-563）。修：`typeof === 'string' || typeof === 'number'` 兼收。
- **R4-M2 含限侧边界与"混合状态"用例缺失**：单图恰好 200KB / 解压恰好 64MiB 成功用例无；spec §2.1 明确的迁移"混合状态"（旧 `icons` 键与 `iconindex` 并存）无用例。
- **R4-M3 WinAuth 调研文档未落库**：计划与 commit 声称依据 `docs/superpowers/research/` 同日调研，该目录只有 P6 spike；格式依据不可审计。修：补精简调研文档记录已核实格式事实与源码行号（WinAuthHelper.cs 579/585-589、WinAuthAuthenticator.cs 745-760 等）。
- **R4-M4 README 表述轻微失真**（f3680cd）：官方导出器只写 ToUrl 行不产生 `#` 注释行，`#` 容错是导入侧行为；措辞收窄。
- **R4-M5 大预算下的内存峰值**：`iconImport.ts:32-36` 逐字节 `String.fromCharCode` 拼接 + 全量 dataUrl 驻留，64MiB 产出理论峰值数百 MB。修：分块编码。

## 3. R6 —— P6 ABE 服务端（Rust / Windows 安全）

### Important

**R6-I1 副本 exe 复制后、启动服务前无完整性复核——预开共享句柄可向 SYSTEM 服务注入副本字节（LPE 面）**
- 位置：`elevation_install.rs:414-424`（PrepareDir/CopySelf）、`:451`（StartService），对照 `DIR_SDDL`（:54）。NT ACL 对攻击者**已打开的句柄无追溯效力**：低权进程预建 `%ProgramData%\TotpTools\service` 并以全共享模式持有诱饵 `TotpTools.exe` 句柄 → UAC 安装 `fs::copy` 与全共享句柄兼容照常成功 → copy 后继续写入恶意 PE → StartService 加载污染映像 → SYSTEM 代码执行。OWNER_RIGHTS（5fe1099）封的是"所有者重开 DACL"，封不住已开句柄通路。e2e 清单 §8 自认"未程序化复核"。
- 修法：`install_plan` 的 CopySelf 与 StartService 之间加 `VerifyCopy` 步骤（重读副本哈希与安装时自哈希比对，不一致即中止删目录）；比对后立即以 `FILE_SHARE_READ` 独占写句柄再开一次压缩残余窗口（毫秒级）。

**R6-I2 调用者哈希校验存在文件替换 TOCTOU——便携版形态可冒充调用者取 DEK**
- 位置：`elevation_service.rs:403-414`（`sha256_file_hex` 以路径重开文件）+ `:359-374`（verify_client_process）。恶意 exe 运行在 BoundPath 路径上（便携版/用户可写目录成立），连接管道后 rename 自身并在原路径写入合法 `TotpTools.exe` 字节，服务流式哈希读到新文件 → 路径+哈希双过 → Unwrap 取 DEK。**安装版不受影响**。不需要 UAC 交互（相比已声明的不防项是增量）。
- 修法：短期 README 威胁模型"不防"清单显式补一条；中期读哈希以无 `FILE_SHARE_WRITE` 打开并保持至验证+响应完成 + 双读比较；根本启用预留 `SignerSubject` 签名校验（另立 round）。

### Minor

- **R6-M1 服务端读帧无超时 + 单实例串行 → 慢连接可用性 DoS**：`elevation_service.rs:317-332`（read_exact 无 deadline）、`:752-818`（serve_loop 单实例）。低权进程发半帧停住 → 服务停止接受新连接。修：镜像客户端 PeekNamedPipe+deadline 方案（elevation_client.rs:345）。
- **R6-M2 管道 DACL 用 Authenticated Users 而非当前用户**：`elevation_service.rs:42` `D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GRGW;;;AU)`，多用户机器任意本地用户可连管道（计划 §0.1 文本与 SDDL 模板自相矛盾）。修：安装时把发起用户 SID 写 HKLM，服务构造 `(A;;GRGW;;;<SID>)`，无 SID 回退 AU。
- **R6-M3 客户端不验证服务端身份，管道名可被先占**：`elevation_client.rs:304-343` + `elevation_proto.rs:14`（固定管道名）。假服务可返回假 ok（HKLM 残留）或收走 DEK 明文（同用户无增量）。修：客户端用 `GetNamedPipeServerProcessId` 校验对端 PID 的映像路径在 BoundPath 且哈希匹配。
- **R6-M4 hooks.nsh 清理残留**：`windows/hooks.nsh:29-33` 只删 service 子目录，`TotpTools` 父目录残留；NSIS `RMDir /r` 对 junction 的跟随行为与 Rust `remove_dir_all` 不一致，e2e §7 只挂账安装侧。修：补 `RMDir` 父目录 + e2e 卸载侧 junction 观察项。
- **R6-M5 `encode_frame` 超限 panic 的服务端暴露面**：`elevation_proto.rs:84-87`（assert）+ `elevation_service.rs:222-227`。assert 位于 SYSTEM 进程内。修：服务侧 resp_frame 用返回 Result 的变体。

## 4. R7 —— P6 ABE 应用侧（命令层 / 前端编排）

### Important

**R7-I2 轮换 rewrap 联动在真实数据流下是死代码，换口令后 ABE UI 呈现假"已启用"**
- 位置：`apps/desktop/src/securityPlatform.ts:217` 在 `await baseSecurity.changePassphrase()` 之后读 abeSource，但 core `changeVaultPassphrase`（`packages/core/src/security/securityStore.ts:234`）rotateDek=true 时把 kekSources 重置为 `[{kind:'password'}]` → abeSource 恒 null → `rewrapAbeCiphertext`（:183）永不执行；HKLM 残留旧密文无清理。SecurityCard"已启用"判定只看 `abeStatus.matchesCaller`（`packages/ui/src/components/SecurityCard.vue:415`，服务验证 exe 哈希恒真）→ 用户看到"已启用"实际已静默失效。联动测试（securityPlatform.test.ts:327）mock 口径与真实 store 语义背离。
- 修法（裁定：采用方案 a，理由见 §9 决策记录）：换口令成功后若服务在线（matchesCaller）则 rewrap 新 DEK + `addAbeSourceOp()` 恢复标记源；服务离线/失败则清 HKLM 密文降级退出 ABE。SecurityCard"已启用"判定改为 `matchesCaller && abeSource 非空`；统一 disableEncryption/changePassphrase 两分支手法（先记 hadAbe）。

### Minor

- **R7-M2 onAbeRemove 丢弃 `remove()` 结果**：`SecurityCard.vue:141`，ok:false 时仍 toast"已移除"。修：消费 `r.ok`。
- **R7-M3 abe_wrap_impl 门控失败路径 DEK 不清零**：`elevation_commands.rs:129` 提前 return 跳过 ：135 zeroize。修：zeroize 提到门控前或用清零 guard。
- **R7-M4 mock 命令清单漏 `abe_unwrap`**：`apps/desktop/test/mocks/tauri.ts:78-83`，清单头注释"一一对应"已失真。
- **R7-M5 wrap 失败不刷新服务状态**：`SecurityCard.vue:106-108`，bind 成功后 wrap 失败 return 前无 `refreshAbeStatus()`，与 8345125 裁定精神不一致。
- **R7-M6 测试缺口**：lockScreen.abe.test.ts 未覆盖"abe unwrap 成功但 unlockWithDek 失败 → catch 回退 dpapi"。

## 5. R5 —— P4+P5 扩展端（QuickCodesPanel / popup 精简 / 快捷新增）

### Important

**R5-I1 URL 过滤滤空时空态语义回归**
- 位置：`packages/ui/src/components/QuickCodesPanel.vue:60-64` + `apps/extension/entrypoints/popup/App.vue:318-326`。面板"全空"判定只看 query 与 selectedTagIds，不感知 URL 过滤；站点无匹配时显示"暂无条目，点击右上角打开主界面录入"（按钮已不存在），旧版显示 `popup.noMatch`。
- 修法：popup 侧动态覆盖 `:empty-text="filterOn && tabUrl ? t('popup.noMatch') : t('popup.empty')"`（最小修法，不改三端面板契约）。

**R5-I2 多条分流引导不闭环**
- 位置：`apps/extension/entrypoints/background.ts:149-152`。多条时 `notify()` 无 id，`onClicked` 只认 `totp-pending-add`，点击无动作；文案"导入页"指路含糊。修：`notifications.create('totp-batch-import', ...)` + onClicked 分支 `tabs.create(options.html#/codes)`。

**R5-I3 pending 信封无过期/清理机制**
- 位置：写入 `background.ts:115,154`，唯一清除点 `popup/App.vue:184-186`。明文 JSON（P5 扩大到任意选中文本）留存 storage.local 无 TTL，vault 本体加密而 pending 是绕过加密层的旁路。修：信封加 `ts` 字段（v:2 或容忍缺省），消费端超时（10 分钟）即删除并提示过期重新右键；或 background 写入时 `alarms.create` 一次性清理。

### Minor

- **R5-M1 popup 消费端新增硬编码中文**：`popup/App.vue:203,209-211` 绕过 i18n。修：补 `popup.*` zh/en 键。
- **R5-M2 Firefox 回退未带 `?pending=1`**：`background.ts:184` 与设计 §5.4 字面偏差（功能等价）。修：补参数保持设计一致，并可用于标记标签页形态。
- **R5-M3 canOpenPopup 为 true 但 openPopup reject 时零反馈**：`background.ts:160-162` catch 吞掉。修：reject 分支兜底发 `PENDING_NOTIFY_ID` 通知。
- **R5-M4 popup 已开时再次右键信封滞留**：popup 仅 onMounted 消费。修：补 `storage.onChanged` 监听 `PENDING_OTPAUTH_KEY` 消费。
- **R5-M5 面板 props 契约与设计 §4.1 分叉**：实现无 urlFilter/showOps prop（分层更优）。裁定：实现契约为准，勘误记录见 §8。
- **R5-M6 sticky 冻结两侧缝隙**：`.frozen` 不含宿主 padding，列表内容从两侧 6-8px 穿过（CodesPage 同款，非本批新问题）。修：frozen 负 margin+padding 自补偿。

## 6. R3 —— P1+P3（TagFilterRow / OtpListItem / toast / 右键菜单）

### Important

**R3-I1 desktop 复制失败反馈未按设计迁 error toast，且与成功 toast 矛盾双反馈**
- 位置：`packages/ui/src/pages/CodesPage.vue:154-168`（onCopy emit 后同步弹"已复制"）+ `apps/desktop/src/App.vue:111`（copyFailed 横幅）。设计 §3.2 明确"复制失败 → error toast（替代现有横幅）"；popup 侧已做到。
- 修法：复制成功反馈上移宿主（OtpListItem 不再自弹成功 toast，由宿主成功弹"已复制"/失败弹"复制失败"），或 emit 回执；至少失败时撤回成功 toast（同 key 替换）。

**R3-I2 说明气泡缺"切换标签选择"关闭条件，且禁用态可挂泡**
- 位置：`TagFilterRow.vue:28-30`（toggle 未关气泡）、`:34`（modeDisabled）。选中 2 标签开气泡 → 点掉一个 → 按钮转 disabled 气泡仍悬挂。设计 §1.1 三关闭条件缺一，必现。
- 修法：watch selectedIds 长度 <2 或 toggle 时收起气泡。

### Minor

- **R3-M3 contextCopyCode/onCopy 可复制 'INVALID' 并报已复制**：`CodesPage.vue:182-186` 守卫只有 `!code`。修：INVALID 不动作或提示失败。
- **R3-M4 "再次点击按钮关闭气泡"与设计字面不符（有意偏差未记录）**：实现为翻转模式+气泡刷新，信息量更优。裁定：保留实现，勘误记录见 §8。
- **R3-M5 管理标签按钮用原生 `:title` 而非设计的 MdTooltip**：`TagFilterRow.vue:78`，触屏不可用。修：改 MdTooltip 对齐设计。
- **R3-M6 气泡 role="tooltip" 无 aria-describedby/id 关联**：修：补 id 关联。
- **R3-M7 跑马灯缺字体加载重测路径**：ResizeObserver 不触发 scrollWidth 变化。修：`document.fonts.ready` 后重测（system-ui 栈下低风险，防御性）。
- **R3-M8 pin ★ 随跑马灯滚出视野**：★ 在 `.title-text` 内部。修：移到裁切容器外。
- **R3-M9 error 类 toast 仍走单一 polite 容器**：修：ToastHost 按 kind 支持 assertive。

## 7. R1+R2 —— 批 1（miniapp / 排序 / 云备份）

### Important

**R1-I1 mini-ready 门控二次触发旁路**
- 位置：`apps/desktop/src-tauri/src/lib.rs:336`、`:374-385`。"重建在途"判定仅看入口处 `get_webview_window("mini").is_none()`：重建路径 spawn 等待线程后主线程立即返回，2s 窗口内二次 `toggle_mini`（快捷键连按）看到窗口已存在且不可见、ready_rx 为 None → 立即走非重建 show 分支绕过门控 → 首屏就绪前 show。修：把"重建在途"显式化（MINI_READY_TX 持有未消费 Sender 即在途，或重建代次 AtomicU64），二次调用复用延迟 show 路径或只更新定位不 show。

**R2-I1 主窗禁用 drag-drop handler 后失去文件投放导航防护**
- 位置：`apps/desktop/src-tauri/src/lib.rs:548`。wry 0.55.1 下 `drop_handler=None` 既不注册自定义 IDropTarget 也不调 `SetAllowExternalDrop(false)`，WebView2 保留默认行为——文件拖入主窗未被 preventDefault 的区域导航到 `file://` 替换 SPA，解锁会话丢失。9540a7b 后 HTML5 DnD 对排序已非必需，本改动正面价值只剩 paste-zone 投放。
- 修法：desktop 入口（desktopShell.ts 或 index.html 内联）加 `window.addEventListener('dragover'/'drop', e => e.preventDefault())` 全局兜底（不影响 paste-zone 自身 drop 处理）；e2e 补"主窗任意区域拖入文件不导航"。

### Minor（R1）

- **R1-M2 pinned 收起按钮不记忆位置**：`MiniApp.vue:183` hideMini 直调 hide() 不触发 CloseRequested 记录路径。修：hideMini 改调 `getCurrentWindow().close()` 复用既有链。
- **R1-M3 `mini_pin_set` 先改缓存后写盘 + 前端乐观翻转不回滚**：`lib.rs:250-256`、`MiniApp.vue:179-182`。修：写盘成功后再 store 缓存；前端失败回滚 ref。
- **R1-M4 重建路径 show 错误留痕丢失**：`lib.rs:379` `let _ = m.show()`。修：补 eprintln 对齐非重建分支（:391-393）。
- **R1-M5 §2.2 监听覆盖面与 spec 表述偏差**：属计划措辞过强，实现无缺陷，裁定不动（e4c6e5c 注释已改准确）。
- **R1-M6 Rust ready 门控时序逻辑零自动化**：配合 R1-I1 把"在途判定"抽成纯状态函数即可低成本测试。
- **R1-REC1 capabilities `allow-start-dragging` 挂 main+mini**：main 用不到。修：收紧到 mini。

### Minor（R2）

- **R2-M2 put 的建目录来源是 cred 而非 path 参数**：`webdav.ts:57` 当前等价但潜在耦合。修：由 path 派生（`path.slice(0, path.lastIndexOf('/'))`）。
- **R2-M3 手动通道未做换行归一**：`CloudCard.vue:373` trunc 60 字符窗口可能带入 `\n` 与响应体 XML 碎片（e4c6e5c 只修了 runner 侧）。修："归一空白+截断"下沉 cloudSyncShared 两处共用。
- **R2-M4 keepIgnoreWarn 与非法路径警示并存**：`CloudCredFields.vue` 输入 `a/../b` 时两行警示并存且 warn 引用无效路径。修：`state !== 'ok'` 时不渲染 warn 行。
- **R2-M5 pointer 拖拽宿主适配边界**：无边缘自动滚动 + 把手未设 `touch-action: none`。修：补 touch-action:none；长列表边缘自动滚动实现（近边缘 scrollBy）。
- **R2-M6 lib.rs 注释与事实脱节**：`lib.rs:542-547` 注释仍称"禁用无副作用"，9540a7b 已实证弃用该路径。修：注释更新为现状（保留理由 = paste-zone HTML5 投放）。

## 8. 勘误与裁定记录（计划/文档层，按惯例集中当日文档）

1. **R5-M5**：设计 §4.1 的 props 清单（urlFilter/showOps）与实现契约（entries/codes/icons/loading/tagRow/contextMenu/showIndex）分叉；实现分层（业务差异留宿主、面板纯展示）更优，以实现契约为准。
2. **R3-M4**：气泡"再次点击按钮"实现为翻转模式+气泡刷新文案（优于设计字面"关闭"），保留实现。
3. **R5-M5/R2 注释矛盾**：spec §4.3"message 保持单行"与"追加换行 body"自相矛盾，实现选多行（含 bodySnippet），成立。
4. **R6-M2**：计划 §0.1 文本"当前用户读写"与 SDDL 模板（AU）自相矛盾；实现从 SDDL 可理解，修复后以 SID 版为准。
5. **R7-REC**：`docs/superpowers/research/2026-10-07-p6-security-spike.md` 头部"报批结论：P6 缩减为仅 CryptProtectMemory"与实际立项（ABE 服务全量）方向相反，补后续改批注记。
6. **R4-M3**：WinAuth 格式对照调研落库（补精简调研文档）。
7. **R1-M5**：spec §2.2"捕获模块求值期异常"表述过强（静态 import 后注册天然捕不到求值期），实现无缺陷。

## 9. 需用户决策点（修复时已采用方案，最终汇报确认）

1. **R7-I2 换口令后的 ABE 语义**：采用方案 a（服务在线则 rewrap 恢复 ABE；离线则清密文退出），理由：ABE 是安全加固，换口令不应静默失去；与 prf/dpapi"重绑引导"的差异是 ABE 可程序化自动完成。
2. **R6-M2 管道 DACL 收紧到用户 SID**：采用"安装时写发起用户 SID 到 HKLM，服务优先 SID、缺省回退 AU"的兼容式收紧。
3. **R6-M3 客户端校验服务端身份**：采用 `GetNamedPipeServerProcessId` + 映像路径/哈希校验（复用服务端已有验证原语），不做管道名随机化（改动链长收益相同）。
4. **R6-I2 中期方案**：独占句柄（无 FILE_SHARE_WRITE）+ 双读比较落地；Authenticode 签名校验涉及签名体系现状（自签），登记 backlog 另立 round。

## 10. 真机清单补充项汇总（各审查建议，待并入 docs/e2e）

- P2：导入 zip、旧数据升级、重启持久化、ADS 场景验证（R4-C1 配套）。
- 批1：主窗任意区域拖入文件不导航（R2-I1）。
- P6：副本启动前哈希复核断言（R6-I1 修复验证）；卸载侧 RMDir junction 观察（R6-M4）；换口令后 ABE 区块显示与锁屏行为（R7-I2 配套）；便携版形态下运行中文件替换场景说明（R6-I2 文档化）。
- P4/P5：真机走查以 3d48282 新菜单标题为准（旧清单标题已过时）；data: URL 可行性结论回填清单。

## 11. 修复波次记录（2026-10-07 当批完成）

五个修复波次（W1–W5）串行执行（同仓库 git 串行约束），合计 41 commits（`d809a76..bed3739`）。每波完成后跑根 `pnpm test` + `pnpm typecheck`；涉及 Rust 的波次另跑 `cargo test` + `cargo clippy --all-targets` + `cargo fmt --check`。

### 波次与修复项 → commit 映射

**W1 P2 存储层+解析（6 commits，修复后 core 1106+2skip / ui 1258 / extension 309 / desktop 381 全绿）**

| 项 | commit | 实际做法 |
|---|---|---|
| R4-C1 | d809a76 | tauriFs 键名→`encodeURIComponent(key).json` 映射（纯字母数字键名不变，settings 等存量文件零影响）；get 两级查找命中旧原名文件即读并迁移，delete 双清理防复活；legacy 查找容错不放大启动失败；normalizeIssuer 剔除 Windows 危险字符与控制字符；init 迁移 allSettled per-key 容错（全成才写索引、与既有 iconindex 取并集）；真机清单 docs/e2e/2026-10-07-p2-import-checklist.md 建档并登记 §4 |
| R4-I1 | 22b2d30 | uriBatch 按 query 同时含 deviceid+data 识别 WinAuth Steam 行，data 走 importSteamGuard 重建 steam 条目；data 损坏归 failures 行级错误（uriBatch 层无 suspect 通道，不产出错误 TOTP 即达标） |
| R4-I2+I3 | 5d16899 | persistKeys 改 Promise.all 单轮并行（覆盖全部写路径）；putMany/removeMany/removePack 入口快照、失败回滚内存（新增删除/覆盖还原）+ 抛出；3 个失败注入用例 |
| R4-M1 | fb31400 | sniffSteamGuard 与 steamGuard 字段归一兼容 number（asText 转 string） |
| R4-M2 | 42503a2 | 单图恰 200KB、解压产出恰 64MiB 含限侧成功用例（预算判定为严格大于） |
| R4-M4+M5 | d89f519 | bytesToDataUrl 按 0x8000 分块拼接；README 措辞收窄"官方导出器只写 URI 行，# 注释行为导入侧容错" |
| R4-M3 | 5b3b95d | WinAuth 格式对照调研落库 docs/superpowers/research/2026-10-07-winauth-text-format-research.md（补录性质） |

**W2 P6 服务端（8 commits，cargo test 218 全绿、clippy 0、fmt 过）**

| 项 | commit | 实际做法 |
|---|---|---|
| R6-I1 | 433eb12 | install_plan 插 VerifyCopy 步（CopySelf 后、ApplyService 前——最早检测点）：重读副本 SHA256 比对 + 无写共享独占打开一次；三条中止路径单测 |
| R6-I2 | e8b9b3d | verify_client_process 改无写共享打开 + 两次独立读哈希比较（窗口压缩档）；README 不防清单补便携版残余面；根本方案（Authenticode）→ backlog B25 |
| R6-M1 | 20924ab | 服务端读帧共享客户端 3s deadline（PeekNamedPipe 轮询），写响应重叠 WriteFile+事件+CancelIoEx；超时断开继续服务循环 |
| R6-M2 | 9e77d32 | 安装时进程令牌取发起用户 SID 写 HKLM CallerSid（合法性校验防注入），服务优先 `(A;;GRGW;;;SID)`、缺省回退 AU；OTS 提权绑定提权账户的已知限制登记 README |
| R6-M3 | 302a826 | 客户端 GetNamedPipeServerProcessId → 取证链（自服务端提取共享，含双读哈希）→ validate_server_image 纯函数比对规范副本路径+绑定哈希；HKLM 无绑定=Unavailable、失配=Protocol |
| R6-M4 | 1047093 | hooks.nsh 补 `RMDir $COMMONPROGRAMDATA\TotpTools`（非 /r 仅删空目录）；清单补卸载侧观察项 |
| R6-M5 | 5a8d5ff | proto 层 try_encode_frame→Result，服务端 resp_frame 失败清零附加数据回 Internal 兜底帧；客户端保留 fail-fast（should_panic 锁形） |
| 跟进 | e58cbde | clippy 字面量布尔警告消解 |

**W3 P6 应用侧（5 commits，ui 1261 / desktop 383 全绿、cargo 219）**

| 项 | commit | 实际做法 |
|---|---|---|
| R7-I2 | cccdb23 | changePassphrase 轮换前记 hadAbe；restoreAbeAfterRotation——服务在线（matchesCaller）→ 新 DEK 重 Wrap + addAbeSourceOp 恢复标记源，离线/任一步失败 → removeAbeCiphertext 清 HKLM 降级退出（保持"标记源与 HKLM 密文成对"不变量）；AbeOps 增必填 source ComputedRef；SecurityCard 已启用判定改 `matchesCaller && abeSource`（源缺失落重绑引导，新键 abeSourceMissing）；联动测试改 simulateRealRotation 按真实 core 语义（清非口令源）；真机清单补 §12 走查项 |
| R7-M2+M5 | 12640b5 | onAbeRemove 消费 remove() 结果（失败走错误通道+刷新状态）；onAbeBind wrap 失败 return 前补 refreshAbeStatus |
| R7-M3 | 3a8e121 | abe_wrap_impl 改 &mut 入参 + 表达式求值消除门控/长度两处 `?` 早退，出口统一 zeroize；拒绝路径清零断言测试 |
| R7-M4 | 07b3954 | mock 清单补 abe_unwrap，核对时发现 cloud_http_fetch 同类漂移一并补齐（40→42） |
| R7-M6 | 2fe0402 | 补"unwrap 成功但 unlockWithDek 失败 → catch 回退 dpapi"行为级用例 |

**W4 UX 回归+快捷新增（8 commits，extension 320 / desktop 386 全绿、Chrome 构建过、i18n 797=797）**

| 项 | commit | 实际做法 |
|---|---|---|
| R2-I1+M6 | c72b0c3 | 新增 dragDropGuard.ts 全局 dragover/drop preventDefault，main.ts 与 mini.ts 入口最早期挂载（paste 事件与元素级 drop 幂等无冲突）；lib.rs 注释更新为 9540a7b 后事实；3 单测 |
| R5-I1 | 3b13d07 | popup 宿主按 URL 过滤激活态动态传 empty-text（滤空→noMatch，关闭→empty 引导）；面板契约不动 |
| R5-I2+M3 | b28cdbd | 多条分流 notifications.create('totp-batch-import') + onClicked 直达 options.html#/codes；openPopup reject 兜底发通知；notifyClickable 单点收敛 |
| R5-I3+M1 | eb31c13 | encodePending 自动盖章 ts，isPendingExpired（TTL 10 分钟），过期提示 popup.pendingExpired 并删除；无 ts 旧信封容忍（升级兼容）；popup.importNone/batchImportHint/pendingExpired 入键表，硬编码中文改 t() |
| R5-M2 | 724f35c | Firefox 回退补 ?pending=1；popup 以该参数判别标签页形态跳过自动关窗武装 |
| R5-M4 | b47848c | 消费链拆 dispatchPendingRaw + consumeStoragePending（读盘即清天然防重入）；popup 运行中经 storage.onChanged 消费新信封；3 用例（含自写回声短路） |
| R5-M6 | 53c0f02 | .frozen 加 --frozen-bleed 负 margin+等量 padding 自补偿；popup 8px / mini 6px / CodesPage 16px 宿主分别设置 |
| 配套 | f725c6f | chromeShim ChangeDict 补 oldValue 类型 |

**W5 UI 细节+批1（12 commits，ui 1276 / desktop 388 全绿、cargo 220、clippy 0、fmt 过、i18n 800=800）**

| 项 | commit | 实际做法 |
|---|---|---|
| R3-I1 | 02e8a0d | copyToClipboard 改返回 Promise<boolean>；desktop App.vue 按结果 toast 成功/失败（新增 desktop.copied 键），删除 copyFailed 横幅；mini 失败横幅迁 error toast；options 宿主同口径；右键复制同口径；MCP 卡复制失败补 error toast 兜底 |
| R3-I2+M5+M6 | eb13d9e | watch 选中数 <2 收起气泡；管理钮提示迁自绘 tooltip 气泡（组件库无 MdTooltip，采用组件内已有气泡形态，hover/focus/触屏三路）；气泡 useId + aria-describedby 关联 |
| R3-M3 | c06e21f | 两复制入口补 code==='INVALID' 守卫（不 emit、HOTP 不递增、error toast 新键 copyInvalid） |
| R3-M7+M8 | d64a377 | document.fonts?.ready 防御性重测；★ 提升为 .title-line flex 直接子节点 |
| R3-M9 | 985ce93 | ToastHost 分双常驻 live region：success role=status/polite、error role=alert/assertive |
| R1-I1+M4+M6 | c24bea6 | MINI_REBUILD_INFLIGHT AtomicBool + mini_toggle_action 纯函数状态机（Hide/KeepHidden/RepositionOnly/Show）；二次触发只 Reposition 不 show；状态机单测；waiter show 失败补 eprintln |
| R1-M2+M3 | e2d6f57 | hideMini 改 close() 复用 CloseRequested 记忆链；mini_pin_set 写盘成功才 store 缓存；前端 invoke 成功才提交 ref（非乐观翻转，语义等效无闪烁） |
| R1-REC1 | adf87fa | 拆 mini-drag.json capability（windows:[mini]）单独持有 start-dragging |
| R2-M2 | cfc915d | put 建目录改由 path 参数派生（lastIndexOf('/')，无 '/' 跳过）；补非 cred 派生用例 |
| R2-M3+M4 | c56919a | 归一+截断下沉 cloudSyncShared.errorDigest 双通道单点；keepIgnoreWarn 在 state!=='ok' 时不渲染 |
| R2-M5 | bed3739 | 把手 touch-action:none；新增 edgeAutoScroll.ts（rAF 匀速滚动状态机：24px 边缘带、6 模块单测） |
| 附带 | dd1f7ef | elevation_commands 既有 rustfmt 漂移折行 |

### 裁定不动/转档项

| 项 | 处置 |
|---|---|
| R6-I2 根本方案（Authenticode 签名校验） | backlog B25（需签名分发方案决策，另立安全 round） |
| R1-M5（spec §2.2 监听覆盖面表述偏差） | 计划措辞问题，实现无缺陷，不动（§8 勘误 7） |
| R3-M4（气泡"再点"语义偏差） | 实现更优，保留，勘误 §8.2 |
| R5-M5（面板 props 契约分叉） | 实现契约为准，勘误 §8.1 |
| R3-M4/R2 注释等文档勘误 | 已集中本文档 §8 与当日文档（5b3b95d） |

### 最终验证（W5 完成后末态）

- `pnpm test`：根 vitest 15 通过；core 1107 通过 / 2 skipped；ui 1276 通过；extension 320 通过；desktop 388 通过——全绿
- `pnpm typecheck`：四包全过
- `cargo test`：220 通过 / 0 失败；`cargo clippy --all-targets` 0 警告；`cargo fmt --check` 通过
- `check:i18n`：zh=800 en=800
- extension Chrome 构建（W4 波内）成功

### 遗留真机验证项（自动化不可达，清单已建档待执行）

P2 导入（含 ADS/特殊字符 id 场景）、批1 主窗拖入文件不导航、P6 哈希复核断言/换口令 ABE 走查/卸载 junction 观察、P4/P5 双浏览器快捷新增全链路——分别见 docs/e2e/ 四份当日清单（P2 为新建，其余为既有清单增补条目）。
