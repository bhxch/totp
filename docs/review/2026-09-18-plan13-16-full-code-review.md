# plan13–plan16 全代码审查报告（2026-09-18）

## 状态：全部修复 ✅（3 Critical 当日修 + 14 Important / 31 Minor 子代理驱动批次修毕，终审 READY）

2026-09-18 审查当日完成全部修复：

**第一批：3 Critical + N1**（`6384672`/`6315b2e`/`c219286`，回归 core 474/ext 47/desktop 64 绿 + cargo check）。

**第二批：子代理驱动修复批次**（`f5ca131..c480cb8`，64 提交，8 任务串行执行，每任务实现者+规格审查+质量审查三段、审查不过即返工，最终整批终审 READY）：

| 任务 | 范围 | 关键修复 | 终态回归 |
|---|---|---|---|
| T1 core 云同步语义 | I1 注释+M1 决胜规则(改设计对齐代码,用户裁决)+M2 分页+M5/M6+in-sync 测试重写 | 7 提交（含 gdrive fields 语法 Critical 勘误 79ce7fa） | core 481 绿 |
| T2 core gdrive/路径 | I2 keep 上传新建分流+I3 删除域圈定+M3 取整秒防撞名+M4 objectPath 删除 | 6 提交（含毫秒逃逸/404 孤儿两处审查勘误） | core 490 绿 |
| T3 ui runner/卡片 | I4 sourceName 显示名+I1 宿主 hash 门(最小闭环)+8 Minor | 12 提交（含部分失败自愈 dfee8b3） | ui 528 绿 |
| T4 ui 移除源 | I5 先持久化+孤儿对账 | 2 提交+文案顺手修正 | ui 533 绿 |
| T5 extension | I6 迁移提示+I7 secretBag 跨上下文+4 Minor | 11 提交（含 legacyNote 永驻勘误 d81a7f5） | ext 60 绿 |
| T6 desktop | I8 失败结构化+I9 冲突副本传播+I10 锁定降级+I11 saveSources 合并+I12 测试+4 Minor | 10 提交 | desktop 76 绿+cargo 7 绿 |
| T7 重设计遗留 | I14 复制 URI 上抛+6 Minor | 10 提交（含 typecheck 门红勘误 cdfe2c9） | ui 548 绿 |
| T8 vue-tsc 门 | I13 三包接入+37 处浮出错全修（含真实 bug：MiniApp onVisibleChanged 运行时 TypeError 从未生效）+3 打磨 | 9 提交 | 四包 vue-tsc 绿+1174 绿 |

**不修项（均有记录理由）**：R1-M7（SettingsPage #fff，M3 审查已裁决调色板圆点例外）、R5-M5（GDrive fileId 不回存，报告自述仅记录已知开销）、M1 决胜规则按用户裁决改设计文档对齐代码（`d35f787`）。

**整批终审结论（f5ca131..c480cb8）**：报告 3C+14I+31M 无一遗漏（2 项有意不修已记录）；跨批一致性 4 项接缝核查通过；全量回归 core 491 + ui 548 + ext 60 + desktop 76 = **1175 全绿** + 四包 vue-tsc typecheck 绿 + cargo check/test 绿；两处高风险抽样深查（hash 门 allSettled、gdrive put 分流）无隐藏回归。

## 范围与方法

对 `docs/review/2026-09-15-e2e-verification-plan.md`（提交 `ed7a634`）之后合入 main 的**全部 138 个提交**（约 +21,400/-1,700 行，205 文件）做分域 fresh review。审查方式与 2026-09-15 全代码审查一致：5 个并行子代理各负责一个领域，对照计划文档逐文件过代码与单测，问题按 Critical / Important / Minor 三级分类，全部结论要求先在最终代码（`c82ee39`）中核实。

| 分域 | 提交范围 | 量级 | 基线验证 |
|---|---|---|---|
| R1 前端重设计（plan13+14，MD3/主题/五页导航/a11y） | `1eee13f..fe5bc89`（45 提交） | +6,883/-774 | ui 339 用例全绿 |
| R2 core（plan15 D2/D6 + plan16 T1–T6/T11.5/T16） | `fe5bc89..HEAD` × packages/core（24 提交） | +2,522 | core 474/474 绿 + typecheck |
| R3 ui store 与功能卡（plan15 D1–D6 + plan16 T7–T11.5） | `fe5bc89..HEAD` × packages/ui（47 提交） | +5,820/-809 | ui 515 用例全绿 + typecheck |
| R4 extension（plan16 T12/T13 + D2/D6 ext 侧） | `fe5bc89..HEAD` × apps/extension（10 提交） | +1,110 | ext 45/45 绿 + typecheck |
| R5 desktop（plan15 D1/D2/D4 + plan16 T14/T15，含 Rust） | `fe5bc89..HEAD` × apps/desktop（21 提交） | +2,195/-125 | desktop 64/64 绿 + typecheck + `cargo check` exit 0 |

合计基线：**902 用例全绿**（core 474 + ui 515 + ext 45 + desktop 64 中已含交叉统计口径）。

## 总判定

**3 Critical / 14 Important / 约 30 Minor；无阻塞合并的架构缺陷，但 3 个 Critical（1 个密钥明文落盘、1 个恢复链路断裂、1 个锁定功能失效）必须修复。** 密码学主线（保管区状态机、envelope v2、口令轮换、迁移纪律）实现正确且测试闭环；问题集中在自动通道失败语义、gdrive keep 路径、跨端降级体验与类型门禁盲区。

---

## Critical（必修，3 项）

### C1 · desktop：mac/Linux 下「OS 自动解锁」把未包裹的 DEK 明文落盘 security.json
- 位置：`apps/desktop/src-tauri/src/lib.rs:425-429` + `packages/ui/src/components/SecurityCard.vue:221` + `packages/ui/src/store.ts:450-461`
- 问题：keyring 分支 `os_auto_protect` 把 base64(DEK) 存入 keyring 后 **`Ok(data_b64)` 原样返回**；`addDpapiSourceOp` 将返回值当作 `wrappedDekD` 以明文 JSON 写入 `security.json`。mac/Linux 上启用“钥匙串/密钥环自动解锁”后，磁盘上存在一份仅 base64 编码的库主密钥，击穿“磁盘上除 vault 密文与保管区密文外无任何秘密”不变量。Windows 分支（DPAPI 密文）不受影响；挂账仅覆盖“keyring 运行时待真机验证”，未裁定接受此行为。
- 修复方向：mac/linux 分支返回不透明占位（`os_auto_unprotect` 现已忽略入参直接读 keyring，改返回值即闭环）；彻底做法是对齐 DPAPI 语义——keyring 存随机 KEK、用 KEK 包裹 DEK。

### C2 · desktop/core：uuid 源的冲突副本「可见但永远无法恢复」
- 位置：`apps/desktop/src/backupService.ts:103-133` + `packages/core/src/backup/policy.ts:23`（`READABLE_BACKUP_RE`）
- 问题：plan16 后新增源 id 为 `crypto.randomUUID()`（含连字符），desktop 冲突副本名 `conflict-{sourceId}-{ts}.totpbackup`；而 `READABLE_BACKUP_RE` 的 conflict 中间段仅容忍 `(?:[a-z0-9]+-)?`（不容忍连字符）。实证：`conflict-webdav-…` 匹配（旧迁移源可用），`conflict-2dc4bf8a-5ca7-…` **不匹配**——恢复列表会列出这些文件，点击恢复必抛 `invalid backup name`，UI 恢复路径 100% 断（文件在盘上、可手工改名救回，故非不可逆丢失）。`backupService.test.ts:201-206` 把“双段名拒绝”固化成了预期。
- 修复方向：RE 中间段放宽为受控形式（如 `conflict-(.+-)?\d{8}-\d{6}` 并保留防穿越锚定），同修 desktop 测试预期并补 uuid 用例。

### C3 · extension：「空闲 N 分钟锁定」实际约 15 秒即锁，配置阈值完全不生效
- 位置：`apps/extension/src/lockEnforcer.ts:17,51-54`
- 问题：`chrome.idle.queryState(QUERY_S=15)` 后按 `'idle' && idleMinutes >= 1` 锁定。plan16 T12 裁定“queryState 的 idle 态即宿主按 setDetectionInterval 判定超时达成”——**与 Chromium 实际行为不符**：`setDetectionInterval` 的阈值只作用于 `onStateChanged` 事件路径；`queryState` 只用本次调用参数（Chromium `idle_api.cc`/`idle_manager.cc` 经 jsdelivr 镜像核实；MDN 同）。用户设 5/30/1440 分钟，实际约 15–45s 即锁（默认 0=禁用不受影响，故默认路径未爆发）。`lockEnforcer.test.ts:177,219` 断言 `queryState` 收到 `[15]`，把缺陷固化成了规格。
- 修复方向：把钳制后的用户阈值直接传 `queryState`（API 区间 [15s, 4h]，`MAX_DETECTION_S=86_400` 超 Chrome 4h 上限需一并对齐），并更新测试断言。

---

## Important（应修，14 项）

### R2 core
1. **云同步「内容未变→跳过」生产不可达；多设备互踢冲突副本无界累积** — `syncOrchestrator.ts:92-100`/`multiTarget.ts:6-8`：in-sync 判据拿**远端 envelope 密文摘要**与**本地明文摘要**比较，永不相等 → 每次自动 tick 全量重传；两台设备同开自动同步时每轮各落一个 `conflict-*` 副本且不参与滚动删除。plan15/16 测试全用“远端存明文”的不现实 mock 掩盖了失效。修复：增加“上次同步时明文 hash”基线门或 `localContentHash` 入参；同步修正 `autoBackup.ts:121` 等处的错误前提注释。
2. **GDrive keep 语义静默退化为 overwrite** — `gdrive.ts:84-86`：已有 `fileId` 时 `put` 直接 PATCH 主文件，时间戳路径被无视；keep 源永远只有一份，`listBackups` 列不到文件。修复：path basename ≠ 主对象名时走 `createFile`，并补“已有 fileId + 时间戳 path”测试。
3. **GDrive 滚动删除目标域与列表域不一致** — `gdrive.ts:46-62` vs `:108-129`：delete 按全 Drive 全局名字查 `files[0]`，list 按父目录圈定；双 gdrive 源同名时间戳文件可互删（当前被 Important-2 掩盖，修 2 必须同修 3）。修复：delete 查询 `q` 增加 parent 约束 + 双源同名回归用例。

### R3 ui
4. **自动同步状态行向用户暴露源 uuid** — `cloudRunner.ts:118`：summary 拼 `${x.key}`（生产为 uuid），两端宿主原样上屏（E2E 已现场复现）。修复：`CloudRunnerDeps` 增 `sourceName(id)` 通道，summary 与 `onRetentionDeleted` 提示统一用显示名。
5. **移除源持久化失败后内存/磁盘失配 + 锁定态移除遗留孤儿凭据** — `CloudCard.vue:171-187`：先 `removeTarget` 再 `saveSources`，失败不回滚；锁定态 `creds[id]` 为空 → 永不清理已存凭据。修复：失败回滚或先持久化后改内存；解锁装载后对 bag.creds 做孤儿对账。

### R4 extension
6. **未启用加密的存量云同步用户升级后云目标静默消失** — `options/App.vue:54-63`：迁移要求“已启用加密”，不满足时仅 `console.warn`，UI 无提示，旧凭据滞留旧键、云同步静默失效。修复：检测到旧键且迁移被跳过时给 UI 提示。
7. **secretBag 无跨上下文变更感知** — `store.ts:40` + ui store：两个 options 页并发写保管区可丢失先写者数据（vault 有 onChanged 重读兜底，bag 没有）。修复：`registerSync` 映射加入 `secretBag` 键并提供 `reloadBagFromDisk()`。

### R5 desktop
8. **备份部分/全部失败仍推进 lastBackupHash 且记 ok=true** — `autoBackup.ts:104-110` + `backupService.ts:87-97`：每源异常被吞、恒 resolve → 自动通道自此 `unchanged` 跳过，**不再改库就静默停摆**，状态行自相矛盾（“成功：备份失败”）。修复：失败向上传播/结构化返回，失败不写基线、`recordStatus(false)`。
9. **自动云同步冲突副本写盘失败被静默吞掉** — `App.vue:366-368`：`saveConflictBackup` 吞 rejection → 磁盘写失败时云端旧版本在无本地副本情况下被覆盖。修复：传播 rejection 让该目标同步失败，或至少上报。
10. **平台不可用的锁定触发器未显式降级** — `App.vue:459-465` + `lock_events.rs:24-30`：desktop `lockOnRestart=false` 无实现支撑、mac/Linux `lockOnSystemLock` 恒不触发且 UI 默认 true 无标注。修复：按端过滤 lockPrefs 字段或增能力标志隐藏/标注。
11. **`cloudPlatform.saveSources` 整键覆写可吃掉并发写入的本地源** — `App.vue:316-319`：云源快照盲写 `backupSources` 单键，与 BackupCard 读-改-写交错时丢本地源元数据。修复：按 id 合并（保留 local 项）。
12. **测试缺口**：Important-8/11 两条已缺陷路径均无测试；`remove_backup_file_os` 缺 allowed_dir 大小写/`\\?\` 前缀形态用例。

### R1 重设计（横切）
13. **typecheck 对 .vue 全盲，且盲区里已有 5 处真实类型错误** — `packages/ui/package.json:12` 裸 `tsc --noEmit` + env.d.ts 把所有 .vue 声明为空 props：新增约 4000 行 SFC 完全不被检查。实测（审查 worktree 装 vue-tsc）检出 CodesPage:82/90、SyncCard:74-75、EntryForm.test:77 等 digits/类型失配。修复：换 vue-tsc 入门（ui 及 apps），先修 5 处存量错。
14. **options/desktop「复制 URI」绕过剪贴板自动清除链路（URI 含完整 secret 明文）** — `CodesPage.vue:146` 直写 clipboard，不经 `emit('copy')`；popup 同名函数反而会调度清除，双端不一致。修复：CodesPage 增 `copy-uri` 事件上抛宿主统一走清除链路。

---

## Minor（约 30 项，择要）

- **core**：多目标采纳决胜规则与设计文本相反（multiTarget.ts:78-83，最后采纳者胜 vs 设计“第一个”）；三个 listBackups 无分页续传（>1000 对象截断静默漏删）；`resolveTimestampPath` 同秒碰撞；`BackupSource.objectPath` 死元数据；迁移中断用例仅单一中断点；`onCredChange?: never` 哨兵无注释。
- **ui**：`hasCustomNames` 判定与提示文案相反（E2E 现场复现：名称互不相同的双源反显示“同名源请用名称区分”）；keep 份数输入逐键落盘；`changePassphrase` opts 合并陷阱（显式 `rotateDek: undefined` 静默关轮换）；平台 set 类回调未处理拒绝（失败时 UI 已显示新值未落盘）；BackupSecretCard 记住开关生效时机含糊；`ImportSchemesApi` 未从包入口导出（宿主 .vue 引用，vue-tsc 接入即 TS2305）；`CLOUD_ACTION_LABEL` 重复定义；`onConfirmReset` 未防空白凭据草稿。
- **ext**：`lockOnRestart` 在 ext 是无效果开关（session 语义两种取值一致）；自动状态摘要 `deleted=0` 文案；`cloudCredStore.ts:119` 去重只对 existing；Firefox 未标 `strict_min_version`（storage.session 需 115+）。
- **desktop**：`removeDpapiSourceOp` 后 keyring 条目永久残留（秘密生命周期不完整，随 C1 一并处理）；`lock_events.rs:127-129` 注释与 -1 处理实际行为不符（忙等风险）；`currentHash` 先算后备份的窗口（无害多写）；默认目录列表无前缀过滤（靠 RE 兜底）；GDrive 自动通道 fileId 不回存（已知开销，注释已声明）。
- **R1 重设计**：无 catch-all 路由（错误 hash 深链主区空白）；`isNarrow` 初值闪烁一帧；MdChip 缺 `aria-pressed`；删除分组按钮无确认且非 danger 视觉；RevealDialog headline 契约兜底；options scoped `body` 选择器永不匹配。

---

## E2E 交叉发现

- **N1（本轮静态审计新发现）**：`firefox-mv2` 未申请 `idle` 权限，而 `lockEnforcer` 直接调 `chrome.idle` 且无存在性防护——Firefox 下空闲锁定静默失效（选项页每 30s 轮询抛 TypeError）。建议：wxt.config 按 browser 注入 idle 权限 + lockEnforcer 加守卫降级。
- E2E 现场复现了 R3 Important-4（uuid 入状态行）与 Minor（同名源提示反转）。

## 计划覆盖核查（汇总）

五个分域逐任务核查表（plan13 T1–T13、plan14 T1–T7、plan15 D1–D6/T1–T17、plan16 T1–T16）全部**已落地或在设计附录明示偏离/挂账**，无静默未实现项。要点：

- plan16 T4（keep-n+五后端滚动删除）：webdav/s3/onedrive/gist 闭环且删除域一致；**gdrive 上传侧破坏 keep 语义（Important-2/3）**。
- plan16 T12：DEK 会话与锁定接线完整，但 **idle 阈值语义错误（Critical-3）**。
- plan16 T16（三路迁移）：以“纯 core 同构”方式模拟宿主而非直跑三宿主；中断点单一（Minor）。
- plan15 D2 失败语义：desktop 侧失败仍推进基线（Important-8）。
- 96ea270 根修覆盖完整（store ref 仅 2 处 + 14 处 invoke 直调，storeWrap.test 9 例存证）。
- 覆盖率 ≥95% 达标（新增 core 模块行覆盖 95.34%–100%）。

## 建议（按优先级）

1. **立即修复 3 个 Critical**（C1 密钥明文落盘 / C2 恢复链路 / C3 idle 阈值），各自原子提交并补测试。
2. 第二批：Important-1（in-sync 明文/密文口径）+ Important-8/9（自动通道失败语义）+ Important-4（uuid 状态行），同属“自动通道可信度”主题。
3. 第三批：gdrive keep 双修（Important-2/3）、跨端降级（Important-6/10）、bag 并发（Important-7）。
4. 引入 vue-tsc 类型门（Important-13），先修 5 处存量错再启门。
5. 全部 in-sync 类测试改用“远端存 envelope”的真实形态重写，防止回归。

## 与 2026-09-15 审查的关系

上轮 92 项（19C/47I/26M）已全部修复或显式裁决，本轮未发现其中任何一项回退。C8（DPAPI 长度校验）、S 系列防幽灵密文等关键修复在本轮范围代码中确认保持。
