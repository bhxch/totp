# 遗留项清理批次设计(2026-09-27)

> 来源:2026-09-26 重构方案(16 项,`docs/review/2026-09-26-refactor-plan.md`)实施完成后的遗留项
> 全面 triage——README 已知限制、重构 deviations 小尾巴、`docs/plans/2026-09-22-review-backlog.md`
> 未修项。逐项分析经当前代码核实(部分 backlog 项已随重构顺带完成,已标注);其中 4 项属产品
> 决策,经用户裁定(§2),其余按建议直接立项。
> 本文档是执行计划;backlog 文档仍是历史归档权威,实施完成时在其行内划线。

---

## 1. 用户裁定记录(2026-09-27)

| # | 项 | 裁定 | 实施要点 |
|---|---|---|---|
| D1 | B2 foxauth 口令 UX | **免输入,对齐官方体验**:取消口令比对,直接采用文件内口令 | 见 §5 F1 |
| D2 | 桌面「重启后保持锁定」开关 | **置灰+角标说明**(保留入口预示未来) | 见 §5 F2。注意:现状已是「隐藏」(两端均声明不支持,SecurityCard.vue:321 v-if),本裁定是把隐藏改为置灰+说明,并更正 README |
| D3 | B7 冲突采纳 TOCTOU / B8 跨上下文互斥 | **继续挂账**(概率低、有冲突副本兜底,修复牵动 sync 主链) | 维持 backlog;待 sync 域下个功能批顺带评估,不单独立项 |
| D4 | GDrive「保留最近 N 份」等价覆盖 | **对 gdrive 源隐藏 keep 配置**,消除歧义源头 | 见 §5 F3 |

---

## 2. README「已知限制」处置(README.md:355)

| # | 限制 | 核实结论 | 处置 |
|---|---|---|---|
| L1 | ③桌面自动备份部分失败仍推进基线 | **已过时**:审查 I8 后 autoBackup.ts:98-102、backupPlatform.ts:101-103 均为「仅全部源成功才写 lastBackupHash,部分失败不推进、下轮重试」 | 立即批:更正为如实描述;顺带全文复核限制与近期修复的一致性 |
| L2 | ④「重启后保持锁定」开关无效果 | **前半已过时**:两端均经 lockPrefsUnsupported 降级(extension optionsPlatforms.ts:173;desktop lockPrefs.ts,Windows 亦含 lockOnRestart),SecurityCard.vue:321 已隐藏;后半(mac/Linux 锁屏触发器)仍成立(同机制隐藏) | 立即批:更正 README;开关展示形态按 D2 裁定改为置灰+说明(§5 F2) |
| L3 | ①手动云同步不设内容门 | 现状属实,有意设计 | F4:手动同步按钮 tooltip/状态行补说明;内容门开关挂账不动 |
| L4 | ⑤Firefox 剪贴板不清空/Passkey 有限 | 平台硬限制,降级合理 | F5:Firefox 构建设置文案注明「不自动清空,请手动清理」;Passkey 现状不动 |
| L5 | ⑥云端列表无分页(S3 超 1000 条滚动删除漏删) | 现状属实 | F6 两步:先做「list 达单页上限时状态行告警」(S);CloudBackend 分页 listPaged 挂账按需(L) |
| L6 | ②GDrive keep=覆盖 | 现状属实 | 按 D4 裁定实施(§5 F3),README 同步改为「GDrive 源仅保留 1 份(配置已按端隐藏)」 |

---

## 3. 批次划分与执行顺序

```
批次 A  立即批(S 级,半天量级):文档更正 + 重构尾巴收敛(§4)
批次 B  行为缺陷批(用户可感知,优先于卫生批):B10/B11(§4)
批次 C  卫生批:B12-B18/B21 + i18n 死键与校验脚本(§4)
批次 D  功能批(含 4 项裁定的实施):§5
批次 E  人工/真机会话(合并一次):§6
挂账    §7
```

依赖:批次 D 的 F2/F3 依赖批次 A 的 README 更正同文件,先 A 后 D;其余互相独立。
验收纪律:每项原子 commit(why+一句话 what,Angular 规范);改锚定断言必须连测试一起改;
每批合入前跑全量门禁(typecheck+四包 vitest;涉 Rust 加 fmt/clippy/test)。

---

## 4. 批次 A/B/C 明细

### 批次 A:立即批

| # | 项 | 处置 | 出处 |
|---|---|---|---|
| A1 | README 限制③/④更正 | L1/L2 按核实结论改写 | README.md:355-365 |
| A2 | backlog 划线回写 | S3 已随 R1 落地(cloudSyncShared.ts:24 MERGED_DEGRADED_KEY)、S6 noChange 死键已清(rg 无引用)、S5 core fixture 已随 R15 全量迁 contentHashVault(cloudSync.test.ts:69/87/…)——三项复核划线 | docs/plans/2026-09-22-review-backlog.md |
| A3 | desktop importFileFilters 补 `.jsonl` | 补一项 + 更正 :90 失真注释(「与 Rust 白名单一致」在 R11 补 .jsonl 后已不成立)+ 与 Rust 白名单镜像断言(照 R11 Rust/extension 模式,三端对齐闭环) | apps/desktop/src/backupPlatform.ts:90-94 |
| A4 | i18n 死键清理 | 删 zh/en common.json:329-332 的 cloudCard.action* 4 键(R1 文案表合并后无引用);顺带清理 S6 残余同类 | packages/ui/src/i18n/locales/{zh,en}/common.json |
| A5 | 主窗 App.vue 接入共享 i18n/boot | 改导入 useDesktopI18n/bootDesktopStore(desktopShell.ts),删内联三件套;现有 desktopShell/App 测试兜底 | apps/desktop/src/App.vue |
| A6 | ui 偏好类型合一 | 提 AutoPrefs<T> 泛型形状,BackupAutoPrefs/CloudAutoPrefs extends;纯类型改动 | packages/ui/src/components/{backupPlatform,cloudPlatform}.ts |
| A7 | extension 15min 钳制副本收敛 | 改调 ui 导出 normalizeAutoPrefs(R14 已挂出口);先 diff 语义(布尔严格判定/钳制)确认一致再切换 | apps/extension/src/optionsPlatforms.ts:82-90 |

### 批次 B:行为缺陷批(下批优先)

| # | 项 | 处置 | 出处 |
|---|---|---|---|
| B10 | 远端 sync:settings 坏 JSON 原样写本端 | catch 分支改返回本端原串(仅「读取失败」才退化采用远端);同步改锚定断言 syncEngine.test.ts:542/:556;补两回归用例(坏 JSON→本端不变;读失败→维持既有降级)。单独 commit | apps/extension/src/syncEngine.ts:94-106 |
| B11 | popup onSave period 被静默重置 | `period: carried?.period ?? 30` → `?? data.period ?? 30`;改锚定断言 popupApp.test.ts:837/:856;与 B10 同批各一 commit | apps/extension/entrypoints/popup/App.vue:298 |

### 批次 C:一致性/卫生批

| # | 项 | 处置 | 出处 |
|---|---|---|---|
| C1=B12 | droppedTagCount 恒 0 | 删死字段+BackupCard 死分支(aegis 导出 tag 全保真是设计事实);未来需要统计时带递增点再加 | packages/core/src/export/aegisVault.ts:19,75,100;packages/ui/src/components/BackupCard.vue:190-194 |
| C2=B13 | MdSwitch 回滚视觉脱钩 | 受控化(视觉纯由 modelValue 派生,change 只 emit);改前排查消费方乐观更新依赖,改后全量 ui 测试+真机过设置页开关 | packages/ui/src/components/md/MdSwitch.vue |
| C3=B14 | offscreen ack 吞异步 rejection | `void sendMessage(...).catch(() => {})` 一行 | apps/extension/entrypoints/offscreen/offscreen.ts:26-28 |
| C4=B15 | clearClipboardWithRetry 外层死防御 | 删外层 try/catch(内层已吞一切,永不可达);与 C3 同批 | apps/extension/entrypoints/background.ts:21-31,41-45 |
| C5=B16 | ReleasePolicyConfig 死 Deserialize 通道 | 复核 R9 后调用方:from_settings_text 仍手写逐字段回退(有意保留),若 Deserialize 无任何调用方则删 derive 通道使口径唯一 | apps/desktop/src-tauri/src/release_policy.rs |
| C6=B17 | 释放策略默认值双轨 | Default impl 改调 default_pause_minutes()/default_destroy_minutes();与 C5 同文件同批 | apps/desktop/src-tauri/src/release_policy.rs:23-30,33-42 |
| C7=B18 | makePlatform 测试 fake 9 份 | 提取 packages/ui/test/helpers/fakes.ts(desktop test/mocks/tauri.ts 先例);不单开批,随下个 UI 功能批分批收编(一次一个文件验证工厂形态) | packages/ui/test/* |
| C8=B21 | core 2 例负载型偶败 | 先 `--reporter=verbose`+根 pnpm test 并发复现钉用例名,再参照 B20 手法(fireDebounceAndWait/vi.waitFor)确定性化;与已知 mcpBridge flaky 同案排查 | 复现:根 pnpm run test / test:coverage 并发 |
| C9 | i18n 无引用键反向校验 | 小脚本或测试:收集 t('...') 键路径引用 vs locales 键集,报无引用键;防死键再积累,长期价值 | 新增 scripts/ 或 packages/ui 测试 |

---

## 5. 批次 D:功能批(含 4 项裁定实施)

| # | 项 | 处置 | 出处/备注 |
|---|---|---|---|
| F1=D1 | foxauth 口令免输入 | 取消比对:导入加密 foxauth 备份不再要求用户输口令,直接采用文件内 encryptPassword(jsonApps.ts:337 明示该值即解密口令)。UI:口令输入框对该格式免输入,文案改为「口令含于备份文件,无需输入」。测试:补「encryptPassword 缺失/非法 Base64/GCM 解密失败」错误路径用例(原 B2 备注的「错误口令用例」在免输入语义下转化为文件口令错误路径);同步更正相关审查记录表述 | packages/core/src/import/jsonApps.ts:302-337;registry.ts foxauth 条目 needsPassword 谓词随之移除 |
| F2=D2 | lockOnRestart 置灰+角标 | 把现状「隐藏」(SecurityCard.vue:321 v-if)改为「置灰+角标说明」:开关可见不可用,角标注明「当前版本桌面/扩展端重启后均会锁定(桌面无会话级 DEK;扩展 DEK 存 session,浏览器退出必清)」;lockOnSystemLock 的平台隐藏维持不变(v-if)。实施形态:lockPrefsUnsupported 机制扩展一个 disabled 通道(或按键配模式),host overrides 两端传值;README 限制④随 L2 一并更正 | packages/ui/src/host/securityOps.ts:19-35;SecurityCard.vue:317-345;两端 overrides |
| F3=D4 | gdrive 隐藏 keep 配置 | CloudCard keep 份数配置区(onKeepN/RETENTION_OPTIONS)对 backend.id==='gdrive' 条件隐藏,配置处不加说明(隐藏即消歧义);README 限制②改为「GDrive 源仅保留 1 份远端对象(keep 配置对该后端隐藏)」 | packages/ui/src/components/CloudCard.vue(R7 后常量在 cardShared) |
| F4 | 手动同步说明 | 手动同步按钮 tooltip 或状态行补「手动同步始终完整推拉,即使内容无变化」;不改默认行为 | packages/ui/src/components/CloudCard.vue |
| F5 | Firefox 文案 | Firefox 构建(编译期或运行时探测)的剪贴板自动清空设置项注明「Firefox 下不可用,复制后请手动清理」 | packages/ui 设置页剪贴板项 |
| F6 | 云端超单页上限告警 | retention 清理时 list 返回数达后端单页上限 → 状态行告警「对象数超出单页上限,滚动删除可能不完整,请手动清理」;listPaged 分页挂账 | packages/core/src/cloud/{backend,multiTarget}.ts |
| F7=B3 | 键盘揭示验证码 | OtpListItem 加 Shift+Enter 揭示(与复制键并列)+aria-live;无障碍真实收益 | packages/ui/src/components/OtpListItem.vue |
| F8=B4 | devtools envPreset 提示 | devtools_get_config 附 envPreset 字段;设置页 devtools 卡显示「因外部环境变量未注入」 | Rust devtools 段 + packages/ui devtools 卡 |
| F9=B6 | mini aria 死声明 | 删 aria-haspopup 或接真实 contextmenu | packages/ui/src/MiniApp.vue |
| F10=B9 | cloudAutoStatus ok 语义 | 存在目标级失败(含 401)时 ok 记 false 或 partial 态,消除「上次同步成功」与失败摘要并置的误导 | apps/extension/src/cloudCredStore.ts、desktop 同构 |
| F11=M1/M2 | MCP 一行级 | needs_restart 显式断言(钉「exposedTools 变更不触发重启」不变量);DEFAULT_EXPOSED_TOOLS 改 readonly string[] | 随下一个 Rust 触碰批顺带 |

---

## 6. 批次 E:人工/真机会话(合并为一次集中执行,记录回写 docs/e2e/)

1. **D2 剪贴板用例重跑**(剪贴板空闲时):上次受阻纯因宿主机剪贴板被提权第三方进程独占(refactorCaused=false 已归因),环境正常重跑一次主链路销项;
2. **云同步双端真机复验**(R1/R2 行为,需真实云账号):gdrive/onedrive keep 源手动同步读到远端最新份;取消确认→基线不变→下轮重新提示;legacy 迁移旧→新数据前后 diff;
3. **OAuth 全流程**(自建 client):401 自愈/轮转回存;含 S9 MS refresh_token 轮转撤销实测(需真实租户,同会话顺带);
4. **双 desktop**:一端编辑→另一端 15min auto 轮拉到变更;冲突裁决全链(badge/横幅→裁决→收敛);
5. **D3 锁屏**(Win+L 人工)与 **E1-E6**(Chrome/Firefox 手测);
6. **2026-09-24 遗留两处复测**:设置页改主题后重启确认 Rust 四组配置保留(经 R9 settings 分节单点化后更有必要);销毁档重建后解锁态正常。

---

## 7. 挂账(维持 backlog,不立项)

- B5 HOTP 双击双 copy(已裁定接受;根治=300ms 同 uuid 去重,记档);
- B7/B8(D3 裁定,见 §1);
- S1 merged 轮零冲突副本契约(终审裁定维持)、S8 托盘冲突计数(随托盘功能批)、S10 MdSegmentedButton 禁用态、S11 vault.rev 与 sync.rev 同名异语义(观察)、M3 两弹叠加(既定行为);
- GDrive 多对象保留(真 keep N 份,需 files.list 分页,成本高)、CloudBackend listPaged 分页(F6 后按需)、手动同步内容门开关、桌面会话级 DEK(D2 裁定不立项)。
