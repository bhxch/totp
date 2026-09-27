# 批次 E:遗留清理·人工/真机验证会话 计划(plan22)

> **For agentic workers:** 本计划是**人工执行 runbook**(非代码任务),无 subagent 执行形态;由用户与操作者在本机按步骤执行,或由操作者借助 tauri-mcp driver-session 自动化可自动化段。Steps use checkbox (`- [ ]`) syntax for tracking。

**Goal:** 在一次集中会话内完成全部挂起的人工验证:重构后行为复验(R1/R2)、剪贴板 D2 重跑、OAuth 全流程、双 desktop 同步、锁屏/扩展手测、历史遗留两处复测,并按项目惯例回写 `docs/e2e/`。

**Architecture:** 全部验证在 **debug 构建 + driver-session 9223** 环境进行;环境构建与驱动方法、平台坑以 `docs/e2e-test.md` §2 为唯一权威,本计划只列场景、顺序与通过判据,不复制其内容。发现缺陷按「先归因再修复」:与批次 A-D 改动相关 → 回对应批次补修;无关 → 登记 backlog。

**Tech Stack:** pnpm / tauri debug build / tauri-mcp driver-session / curl JSON-RPC。

**Spec:** `docs/plans/2026-09-27-leftover-cleanup-design.md`(§6 批次 E)。执行者需同时读 spec 与 `docs/e2e-test.md`。

## Global Constraints

- **执行期间勿锁屏**(LogonUI 下 WebView2 渲染挂起,eval/IPC/截图全超时——`docs/e2e-test.md` §2.4)。
- 会话产出的执行记录写 `docs/e2e/2026-09-XX-refactor-leftover-e2e-record.md`(按日期),`docs/e2e-test.md` §4 索引表登记一行、§7 变更记录补一行;截图/日志放 `.temp/` 不入库。
- 每个场景独立判定通过/失败/人工跳过;失败必须带证据(命令输出/观测值)。
- commit 纪律:执行记录单独一个 docs commit;验证中发现并修复的缺陷按常规 Angular 规范单独 commit(不与记录混提)。

---

### 场景 0: 环境准备

**Files:**
- Create: `docs/e2e/2026-09-XX-refactor-leftover-e2e-record.md`(XX=当日)

- [ ] **Step 1: 构建并启动**

```bash
cd apps/desktop && pnpm tauri build --debug
```

产物 `apps/desktop/src-tauri/target/debug/totp-desktop.exe`。若报 EBUSY/文件占用,先结束残留 `totp-desktop.exe` 进程。GUI 启动;金库经 DPAPI 自动解锁,若停在锁定页用主口令 `Test-Pw!234`。

- [ ] **Step 2: 接管驱动**

```bash
tauri-mcp driver-session start --port 9223
tauri-mcp driver-session status --json   # 必须 connected:true
```

- [ ] **Step 3: 建立记录文件**

按 `docs/e2e/` 既有日期文档格式(参照 `docs/e2e/2026-09-26-refactor-e2e-record.md`)建骨架:执行环境(基线 commit 号 + debug 构建)、场景清单、逐场景结果占位。

---

### 场景 1: D2 剪贴板重跑(上次受阻=宿主机剪贴板被提权进程独占)

- [ ] **Step 1: 确认剪贴板可用**

```powershell
Set-Clipboard -Value "probe"; Get-Clipboard
```

Expected: 读回 `probe`。若写入被拒(上次故障形态),改期执行本场景并在记录注明。

- [ ] **Step 2: 按用例执行**

按 `docs/e2e-test.md` §3 D2 全步骤:复制验证码 → `Get-Clipboard` 读回码本体 → 等 30s+ → 剪贴板为空。

- [ ] **Step 3: 判定**

通过判据=stage 写入成功且 30s 自动清空。记录关键观测值。

---

### 场景 2: 云同步双端复验(R1/R2 行为,需真实云账号)

R1(手动通道 readPath 修复)与 R2(legacy 迁移单点)是 2026-09-26 重构唯二的行为分叉修复,单测已锁,**本场景是最终真机确认**。

- [ ] **Step 1: gdrive/onedrive keep 源——手动同步读到远端最新份**

双端(或端+网页端)构造:远端 keep 源目录先有 A 端上传的新时间戳份 → B 端点「立即同步」→ 状态应显示「已下载/已合并」而非仅上传;确认 B 端内容与远端最新份一致(R1 修复前:手动通道永远收不到远端最新份)。

- [ ] **Step 2: 确认流回归**

B 端远端有新份 → 手动同步触发「采用云端?」确认框 → **取消** → 基线不变、内容不变 → 再次手动同步 → 确认框重新出现(R1 红线:确认流语义不得被重构改变)。

- [ ] **Step 3: legacy 迁移前后数据 diff(可选,有旧盘数据时)**

若手头有 R2 前的旧数据(两端 cloudCreds 旧键形态),迁移前导出/截图 `storage.local`(ext)或 settings/存储键(desktop),升级后比对:targets 解析一致、孤儿键已清、同 backend 去重生效(三项差异修复)。

- [ ] **Step 4: 判定与记录**

三项各记 通过/失败/无数据跳过;失败先跑归因(读 `cloudSyncShared.ts`/`legacyCloudMigrate.ts` 与 e2e 记录),确属重构引入则回批次 A-D 补修。

---

### 场景 3: OAuth 全流程 + S9(MS refresh_token 轮转撤销实测)

- [ ] **Step 1: GDrive/OneDrive OAuth 接入全流程**(自建 client):添加源 → 授权 → 首推 → 401 自愈(手动使 access token 过期/等待)→ 轮转回存是否落盘。

- [ ] **Step 2: S9 专项**(OneDrive,需真实租户):记录回存的 refresh_token;≥1h 后(或强制旧 token 失效)验证自动通道仍能刷新——若 MS 撤销旧 token 且自动通道未消费回存,凭据会失效,此为 S9 挂账项的实测结论。

- [ ] **Step 3: 判定与记录**

S9 结论回写 `docs/plans/2026-09-22-review-backlog.md` S9 行(实测结果)。

---

### 场景 4: 双 desktop 同步与冲突裁决

- [ ] **Step 1: auto 轮跟随**:A 端编辑条目 → B 端闲置等待 15min auto 轮 → B 端拉到变更(I-2 修复后 downloaded 路径真机确认)。

- [ ] **Step 2: 冲突裁决全链**:两设备同条目分歧 → badge/横幅出现 → 裁决 → 两端收敛、冲突副本生成与恢复通道可用。

- [ ] **Step 3: 判定与记录**

---

### 场景 5: D3 锁屏 + E1-E6 扩展手测

- [ ] **D3**:开启 `lockOnSystemLock` → 人工 Win+L(勿用 rundll32 自动化,锁整个会话)→ 解锁回观:库已锁;关开关重复 → 不锁。**注意**:锁屏前保存一切工作;解锁前无法驱动应用。
- [ ] **E1**(Chrome/Firefox):SW 休眠唤醒后右键菜单仍在不叠加。
- [ ] **E2**(Chrome):右键图片 QR → popup 预填 → 保存;坏图提示。
- [ ] **E3**(Chrome):复制后关 popup、干扰复制,30s 后清空;SW 手动 Stop 唤醒仍能清空。
- [ ] **E4**(Firefox 140+):`ext+otpauth://` 唤起 → popup 预填 → 保存。
- [ ] **E5**(Firefox):复制后 30s 不清(可预期);console 无 unhandled rejection 刷屏——**特别关注**:若批次 C Task 3(C3 ack catch)已实施,console 应更干净;若仍有刷屏,核对 C3 是否已合入。
- [ ] **E6**(Chrome):构造接近 QUOTA_BYTES 负载 → 用量 >90% 状态切 `quota`;越界写失败走 error 分支可恢复。

---

### 场景 6: 2026-09-24 遗留两处真机复测

- [ ] **主题设置跨重启**:设置页改主题 → 重启应用 → 确认主题与 Rust 四组配置(shortcutToggleMini/devtools/releasePolicy/mcp)均保留。**经批次后 R9 settings 分节读写单点化,此复测必要性升级**——顺带在 settings.json 手工加一个外来键(`{"__probe__":1}`)再从应用内改设置保存,确认外来键仍在(R9 write_section 合并语义真机验证)。
- [ ] **销毁档重建**:触发 destroy 档 → webview 全销毁 → 托盘点击重建 → 解锁态正常(DEK 暂存回注路径)。

---

### 收尾: 记录回写与提交

- [ ] **Step 1**: 完成 `docs/e2e/2026-09-XX-refactor-leftover-e2e-record.md`:逐场景结果/证据/人工项/发现缺陷与处置。
- [ ] **Step 2**: `docs/e2e-test.md` §4 执行记录索引追加一行;§7 变更记录补一行。
- [ ] **Step 3**: 发现的缺陷逐条登记(`docs/plans/2026-09-22-review-backlog.md` 或新批 backlog),已修的附 commit 号。
- [ ] **Step 4**: Commit:

```bash
git add docs/e2e/2026-09-XX-refactor-leftover-e2e-record.md docs/e2e-test.md docs/plans/2026-09-22-review-backlog.md
git commit -m "docs(e2e): 遗留清理批次真机验证记录

why: 批次 A-D 改动与历史遗留人工项的真机收敛(spec §6 批次 E)。
what: 新增按日期执行记录;e2e-test 索引/变更记录同步;缺陷登记与划线。"
```

---

## 通过标准

- 场景 1-6 全部「通过」或「人工跳过+理由」;无未归因的失败。
- 记录文档落库,`docs/e2e-test.md` 索引同步。
- 本批次完成后,spec `§6 批次 E` 项全部闭环,遗留清理工程整体收官(除挂账清单 §7)。
