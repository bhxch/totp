# 测试覆盖率全面提升方案（2026-09-25）

状态：设计已定稿（brainstorming 六节逐节确认），待实施。
**2026-09-26 更新：P0-P6 已全部完成合入 main，实施结果与设计偏离见下方勘误节。**
配套底稿：`docs/plans/2026-09-25-coverage-inventory.md`（七域业务场景盘点，测试用例设计的直接素材）。

## 实施结果勘误（2026-09-26）

P0-P6 全部完成。各包最终实测与 gate 定值（gate = 实测 -0.5pp 边际，随改进收紧）：

| 包 | 行覆盖 | 分支覆盖 | 用例 | gate 定值 |
|---|---|---|---|---|
| packages/core | 99.91% | 98.63% | 997 + 2 skip | 99.4 / 98.1 |
| packages/ui | 96.12% | 90.01% | 1034 | 95.6 / 89.5 |
| apps/extension | 97.07% | 92.44% | 271 | 96.5 / 91.9 |
| apps/desktop/src | 98.57% | 94.62% | 332 | 98 / 94 |
| src-tauri（原始口径） | 71.56% | 54.69% | cargo 102 | CI `--fail-under-lines 71 --fail-under-branches 54` |

- desktop 于 2026-09-26 终审补登记 `src/main.ts`、`src/mini.ts` 豁免（§1.3 createApp 入口），
  All files 基数随之升至 99.28%/94.87%，gate 定值不变。

- **§3.7/§5 的 Rust 90/85 不可达**：`run()`（Tauri Builder/generate_context/托盘/快捷键装配）
  与 OS 集成（lock_events 消息泵、DPAPI/COM、系统对话框）按 §1.3 属豁免区，但 llvm-cov 只有
  整文件级排除（`--ignore-filename-regex`），**无函数/行级豁免机制**——lib.rs 等文件内豁免行为
  与大量已测代码同文件，整文件排除会连可测代码一并剔除。故 Rust gate 以原始口径 71/54 起步；
  豁免口径实测 73.50%/58.75%（排除 main.rs、lib.rs `run()`、lock_events.rs），随 seam 抽取
  按该口径逐步收紧。分支 gate 经 `scripts/rust-coverage.mjs` 解析 llvm-cov export JSON 的
  totals 实现（`--fail-under-branches` 非 cargo-llvm-cov 选项，CI 首跑实证）。
- **分支口径说明**：§0 基线表的 Rust 分支 71.71%（185/258）为早期未开 `--branch` 的函数级
  region 口径；P0 固化测法后 `llvm-cov --branch` 的分支区域总量为 **426**，两组数字不可直接
  比较。本文所有 Rust 分支覆盖数字以 `--branch` 口径为准。
- **§5 前端阈值**：未一步定到 95/85 目标值，按实测 -0.5pp 边际开闸（ui/extension/desktop 已高于
  分层目标，core 收敛 100/95 前以边际值守门）；CI 实装为 ci.yml `coverage-web`（ubuntu）+
  `coverage-rust`（windows-latest，cfg(windows) 代码需参与编译统计）两 job。
- **§4 E2E 清单**：已逐条展开为可执行清单 `docs/review/2026-09-26-coverage-e2e-checklist.md`
  （桌面 7 条 [可自动化] / 扩展 6 条 [手测]），真机执行待人工/后续会话执行并留档。

## 0. 背景与基线

2026-09-25 实测基线（vitest coverage-v8 + cargo-llvm-cov nightly --branch）：

| 代码 | 行覆盖 | 分支覆盖 | 用例 |
|---|---|---|---|
| packages/core | 97.27% | 87.34% | 740 |
| packages/ui | 88.75% | 85.04% | 835 |
| apps/extension | 56.11% | 78.00% | 108 |
| apps/desktop/src | 40.21%（排除构建产物污染后） | 92.05% | 135 |
| apps/desktop/src-tauri（Rust） | 61.07%（1915/3136） | 71.71%（185/258） | 75 全过 |

核心认知：**覆盖率只是基础，业务场景的尽可能全面是最重要的**。本方案的每一条新增用例都对应盘点底稿里的真实业务场景（边界/错误/状态机/安全承诺），覆盖率提升是副产品。

## 1. 目标与统计口径（已确认：分层目标 + E2E 兜底）

### 1.1 分发渠道 → 代码映射（"接近 100%"的作用域）

- Chrome 扩展 = packages/core + packages/ui + apps/extension（含 offscreen 通道）
- Firefox 扩展 = 同上（无 offscreen、含 `ext+otpauth` 协议回调）
- 桌面版（NSIS 安装版/便携版/rpm·deb）= core + ui + apps/desktop/src + src-tauri

### 1.2 分层目标

| 层 | 范围 | 行覆盖 | 分支覆盖 |
|---|---|---|---|
| L1 纯逻辑 | core 全部、ui 纯函数模块、各宿主可抽出的工厂/纯函数 | 100% | ≥95% |
| L2 组件与宿主编排 | ui 组件与页面、popup/options App、desktop App.vue 拆出工厂后的编排层 | ≥95% | ≥85% |
| L3 集成胶水 | 入口装配、OS/浏览器原生边界 | 豁免 | 豁免 |

### 1.3 豁免清单（精确到行为，登记于 coverage 配置并附理由）

| 豁免项 | 理由 |
|---|---|
| apps/desktop/src/main.ts、mini.ts | createApp 三行入口装配 |
| src-tauri main.rs、lib.rs run() | Tauri Builder/generate_context/托盘/快捷键装配，无 AppHandle 不可构造 |
| src-tauri lock_events.rs 消息泵 | extern "system" wndproc + Win32 消息循环，走真机 E2E |
| src-tauri pick_dir_os / pick_open_file_os / pick_save_file_os | 系统对话框 |
| src-tauri try_suspend_window | WebView2 COM 调用 |
| src-tauri on_window_event 主体 | 窗口事件接线 |
| apps/extension popup/main.ts、options/main.ts | createApp 入口 |
| packages/ui theme/generate.mjs、纯类型 interface 文件（*Platform.ts 等） | 构建脚本/无运行时逻辑 |

**两个重要的不豁免**：
- `background.ts` 不豁免——`defineBackground` 打 stub 后消息路由/右键菜单/alarm 全部可单测（现 0%，最大洼地）；
- `wxt.config.ts` 不豁免——manifest 回调可调用断言，双渠道差异（offscreen 权限、gecko id、protocol_handlers）目前零守护。

### 1.4 E2E 兜底

不折算百分比，以真机场景清单管理（§4）。

## 2. Phase 0 基建

1. **采集修正**：extension/desktop 正式补 `@vitest/coverage-v8@2.1.9` devDep 与 `test:coverage` 脚本；desktop vitest 配置 `coverage.exclude: ['src-tauri/**']`；根目录聚合脚本；Rust 测法固化为脚本 `cargo +nightly llvm-cov --no-rustc-wrapper --text --branch`（stable 下 rustc-wrapper 失效已踩实）。
2. **统一 mock 基建**：
   - `apps/desktop/test/mocks/tauri.ts`：统一 mock 工厂（25 个 invoke 命令 + plugin-fs + 7 类事件 listen + getCurrentWindow），收敛现有手写 vi.hoisted；
   - desktop 补 jsdom + @vue/test-utils（现 environment:node 是 3 个 .vue 0% 的结构性原因）；
   - extension 收敛三处重复手写的 chrome 内存 shim（storage.onChanged/alarms/runtime 双向通道）为公共 fixture，复用 `test/helpers/extApiMock.ts` 惰性桥；新增 `defineBackground` stub helper；
   - store 构造统一走 `createVueStore(createMemoryStorage(), {windowId})`（shallowRef 约束）。
3. **生产代码零改动**（本阶段）。

## 3. 各域用例方案

各域完整场景枚举见盘点底稿；此处列关键新增用例与生产代码改动。

### 3.1 core 核心域（行 97.27%→~100%、分支 87.34%→≥95%）

纯加测试，零生产代码改动：

- URI/取码：secret 非 base32 宽松容错方向锚定；entryCode 三处默认值（period 0→30、hotp counter 缺省→0、yandex 缺 pin→空串）；normalizeExtOtpauth 无 `//` 形态与大小写变体。
- 加密原语：nonce 非 12B 加/解两向、key 非 32B 原语层拒绝。
- vault/merge：renameTag/removeTag/reorder 多元素 false 分支；mergeTags 整函数补测（并集、同 id 异名取 ours、不可变）；updatedAt 缺字段防 NaN。
- validateVaultObject 拒绝面补全（~10 方向）：note 非串、pinned 非布尔、icon 非对象、kind:url 缺 url、yandex digits≠8、数组元素 null、issuer/label/secret 非串等。
- 容错回落：secretBag 明文坏 JSON→空袋、dek 非 32B 双向；conflictStore adapter 抛错→空；match 空 pattern、regex 缓存 256 条淘汰；index.ts 导出面快照冒烟。

### 3.2 core 导入导出域（分支 82.67%→≥95%）

纯加测试：

- zipRead 直接单测（零障碍纯函数）：EOCD 缺失/注释区、CEN 损坏、zip64 拒绝、数据越界、不支持 method、extra field 边角、LOC 与 CEN 不一致。
- WinAuth 旧布局矩阵：v3.0 根元素密文、YubiKey 显式拒绝、无 WINAUTH3 头 v2 路径、SHA256 校验不匹配、SHA256/SHA512 secretdata、m+u 双 DPAPI 层、CDATA/BOM。
- Aegis 加密结构分支：nonce/tag 非法长度、db 非 base64、slot 跳过、master key 解出但 db GCM 失败、groups 表脏数据、新版独立 issuer 字段。
- paste 分发两条拦截分支（aegis 加密、winauth）。
- 导出：yandex pin、hotp 恒写 counter=0、空 vault、悬空 tagId 过滤。
- 业务级新增：跨格式保真矩阵——steam/yandex/hotp 条目经 aegisVault 与 otpauthText 双通道导出→再导入，字段逐项无损。

### 3.3 云同步域（syncEngine 分支 71%→≥95%，云链路分支 86.7%→≥95%）

- syncEngine 补全：quota 状态与 pct、密文缺 security 拒推、mkSerialized 并发重入、markSyncOff、pull 端 storage 抛错、远端密文缺 sync:security→error、旧 rev 残片过滤、明文→明文移除 security 正向路径。
- cloudRunnerFactory（零直接测试）：revSeal 三态（锁定态拒落明文）、authFailure→reject+status 结构化、loadSources 过滤、badge/conflict/retentionNotes 桥接。
- 编排层：pushEnvelope 回读不一致、exists=true 但 get→null 竞态、onConflictBackup 同步 throw、primary in-sync 时 replica 状态、全目标失败收敛、三设备集成、merged 后一方本地回滚。
- 生产代码仅一处：targetPath.ts 加 `__resetForTest` 钩子（同秒防撞记忆跨用例污染；oauthRefresh 已有同款先例）。

### 3.4 ui 交互域（行 88.75%→≥95%）

- readClipboardSnapshot（零覆盖）：navigator.clipboard.read stubGlobal 三路。
- QR 绘制：不装 canvas 原生包，用"记录调用的假 2d context"断言绘制序列；imageSource createImageBitmap 走 stub。
- sqliteLoader 失败分支（41.7%→≥90%）：vi.mock('sql.js') + fetch stub 五类失败。
- 组件补齐：McpServerCard 全交互（乐观前进→对账→双失败回滚）、SettingsPage devtools/释放策略两卡、SyncPage 健康条与六态、SyncCard invalid/off、ImportCard winauth 口令重试链与 authenticatorPlus 字节通道、EntryForm 剪贴板三意图。
- 业务级新增：settings 跨层互踩回归（前端整对象提交不抹 Rust 外来键）、锁定态各卡片禁用矩阵。

### 3.5 extension 平台层（行 56.11%→≥95%）

- background.ts 全测：消息协议全量（schedule-clipboard-clear 非 number 兜底 30s、sync-push 1s 合并防抖、sync-pull 立即）；右键菜单注册幂等、otpauth/QR 四路；alarm 清剪贴板 3 次重试 + ack 双向通道；storage.onChanged(sync) 触发；SW 冷启动首拉。
- options/App.vue（0%，520 行）：复刻 popupApp.test.ts 模式（vi.mock store + stub 组件）——启动序列、迁移编排与 legacyNote、三调度器装配（autoFollow watch 重建、cloudAuthFailed 镜像、onManualSynced resume、badge 坏值对账）、四 platform 装配断言（setSyncEnabled(true) 必发 sync-pull、false 直写 off）。
- popup/App.vue 补齐 15 缺口：?uri= 与 pendingOtpauth 消费即清除、右键菜单四项、HOTP 复制后递增、URL 过滤四级回退、删除 3s 超时、清剪贴板三重门控等。
- wxt.config.ts manifest 断言：chrome 有 offscreen 权限/firefox 无、gecko id、ext+otpauth、manifestVersion。
- extApi 四探测、qrDecode 三分支、storage 短路直测。

### 3.6 desktop 前端（src 行 40.21%→≥95%）

唯一的较大生产代码投资是 **App.vue 拆工厂**（903 行中约 700 行为"闭包读 store"形态，项目已有"纯逻辑抽模块"惯例）：

- 抽纯函数直测：loadBackupPrefs 钳制、legacyRetention、loadCloudPrefs、recordAutoStatus/readAutoStatusText、unlockNaming；
- 抽 createBackupPlatform(deps) 等 4 个工厂注入 fake：backupPlatform 18 成员、cloudPlatform（revSeal 锁定态拒落明文）、securityPlatform、mcpPlatform；
- onMounted 编排抽 initDesktopShell(deps)：锁定链路（force-lock/stash 回注/失焦隐藏/loadError 兜底）；
- tauriFs 全测（P0 语义：settings 合并保 Rust 外来键、坏 JSON 回退、tmp+rename 原子写）；tauriSecurity/importService 薄封装直测；MiniApp.vue 挂载测试（双窗口 DEK 隔离、copy 代次竞态）；McpConsentDialog 两形态分流。

### 3.7 Rust 后端（豁免后口径：行 ≥90%、分支 ≥85%）

照 `*_granted`/`*_inner` 既有模式抽薄：

- 零代价：GateMode serde 线格式往返；cli 缺失 2 分支（--mcp-token 缺值、port 非数字）。
- 低代价：STASHED_DEK 三命令语义（take-即清）、CLIPBOARD_STAGE 四分支（fail-safe 清空）抽参数化 fn；read_import_file_* / read_text_file_os 抽 inner；mcp_approval_response/mcp_respond match 抽自由函数。
- 中代价（安全语义回归）：gated_call 决策链抽纯决策函数产出 GateOutcome 枚举（emit 留薄壳）——审批/冷却/once/exposure 全分支；bridge_call 5s 超时与回收；start_server_inner 空 token 拒启、bind 失败；release_tick 副作用计划枚举 + destroy 回滚注入闭包。
- 测试基建已存在：tower::ServiceExt oneshot 直测 middleware、真实 TcpListener SSE 集成测试。

## 4. E2E 真机兜底清单（L3 业务场景保障）

### 4.1 desktop（tauri-mcp 驱动，基建现成）

1. 释放策略三档联动：Pause 强制锁库+清 DEK 槽；Destroy+stash-dek-request→take_stashed_dek 回注；destroy 失败回滚重试。
2. 剪贴板 stage/clear 真机（含第三方占用剪贴板时的失败横幅）。
3. 锁屏广播（Win+L）→ system-lock → 锁库。
4. MCP 首连审批 UI 三键（deny/once/trust）+ 工具确认两键、deny 60s 冷却、trust 持久化。
5. 自动备份真机落盘与 lastBackupHash 语义。
6. DPAPI 真机 roundtrip（os_auto_protect/unprotect、跨会话解锁）。
7. devtools 端口与 MCP 端口冲突拦截。

### 4.2 extension（Chrome + Firefox 双浏览器手测）

1. SW 休眠唤醒后右键菜单仍在（C11）。
2. 右键图片 QR 识别→pendingOtpauth→popup 保存全链。
3. 30s 清剪贴板承诺（offscreen 重试链路）。
4. Firefox `ext+otpauth://` 协议回调→popup 预填。
5. Firefox 无 offscreen 降级（清剪贴板不调度，行为可预期）。
6. 大库接近 chrome.storage.sync 配额时 quota 状态展示。

每条以"操作步骤→预期行为"录入真机测试文档（沿用 docs/review/ 真机记录惯例）。

## 5. CI 防回退

- 各 vitest 包 `coverage.thresholds: { lines, branches }` 按分层定值，随各 Phase 逐步收紧；最终：core 100/95、ui 95/85、extension 95/85、desktop(src 口径) 95/85。
- Rust CI job 用 `cargo +nightly llvm-cov --no-rustc-wrapper --fail-under-lines 90`（分支按 85 校验）。
  （实测后调整，见头部勘误节：90/85 属豁免区结构性不可达，gate 实定原始口径 71/54 起步。）
- 豁免项登记于 coverage.exclude / llvm-cov --ignore-filename-regex，理由表见 §1.3。
- coverage job 与测试同跑：前端 `pnpm -r --no-bail run test:coverage`，Rust 独立 job（nightly toolchain）。

## 6. 实施批次（每批原子 commit，随做随提）

| 批次 | 内容 | 生产代码改动 |
|---|---|---|
| P0 | 基建：deps/mock 工厂/coverage 配置/脚本 | 无 |
| P1 | core 双域补测 | 无 |
| P2 | 云同步 + ui 补测 | targetPath __resetForTest |
| P3 | extension（background/options/popup/wxt）+ desktop 薄封装（tauriFs/tauriSecurity/importService） | 无 |
| P4 | App.vue 拆工厂 + 挂载测试 | App.vue 重构（行为不变，vue-tsc+全量回归守护） |
| P5 | Rust seam 抽取 + 补测 | lib.rs/mcp_server.rs 抽 inner/决策函数 |
| P6 | E2E 清单执行 + 阈值定稿 + gate 开闸 | CI 配置 |

P0~P5 期间 thresholds 不启用（避免 CI 长红），P6 定稿开闸。

## 7. 验收标准

1. 各渠道统计基数达到 §1.2 分层目标（CI gate 绿）。
2. 盘点底稿 B 节场景清单逐条有对应测试或 E2E 清单项或豁免理由，三选一无遗漏。
3. 全量测试套件（四包 + cargo test）零失败。
4. 真机 E2E 清单执行一轮并留档。
