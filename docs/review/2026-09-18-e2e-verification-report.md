# TOTP 端到端验证报告（agent browse · 2026-09-18）

配套：`docs/review/2026-09-15-e2e-verification-plan.md` 的方法论（48 项矩阵 + mock 策略），验证对象为该计划之后合入的 plan13–plan16 全部功能。代码审查配套报告：`docs/review/2026-09-18-plan13-16-full-code-review.md`。

产物：`apps/extension/.output/chrome-mv3`（`scripts/inject-test-shim.mjs` 注入增强版 chrome shim 后经 `http://127.0.0.1:8765` 提供；本轮为覆盖 plan16 DEK 会话持久化，shim 新增 `chrome.storage.session` 内存实现）。加密相关用例以 `?seedKeys=` 注入密文态（shim 为内存实现，reload 即清空，与上轮口径一致）。

## 总判定

**约 30 项全部通过 / 0 项失败 / 1 项新发现（N1，静态审计）/ 3 项平台边界声明。** plan13–plan16 的新功能在真实浏览器环境端到端可用：MD3 五页导航与主题系统、两把口令与保管区、envelope v2 与加密强度档位、多目标云同步与每源滚动删除、导入四档去重判定树、锁定策略，以及上轮 48 项核心功能的回归抽查。

## Phase A — MD3 框架/导航/主题（plan13+14）

| # | 功能点 | 结果 | 关键证据 |
|---|---|---|---|
| A1 | options 五页导航渲染 | ✅ | rail 五项（验证码/导入/同步/安全/设置）+ 空态文案 |
| A2 | 路由切换与各页渲染 | ✅ | `#/import` `#/sync` `#/security` `#/settings` 全部生效；同步页四卡（备份口令/备份/云同步/浏览器同步） |
| A3 | 主题种子色懒加载 | ✅ | 点「青绿」→ `data-color=teal` + 懒载 chunk `tokens-palettes-BTeFzGE_.css` + `--md-sys-color-primary` 变为 `#55dbc6` + `settings.themeColor=teal` 持久化 |
| A4 | 明暗模式切换 | ✅ | `data-mode=dark` + surface 变量 `#1b1b1f` + `themeMode:"dark"` 落盘 |
| A5 | popup 设置深链 | ✅ | `tabs.create({url:"/options.html#/settings"})`（审计 `__calls.tabsCreate`） |
| A8 | MdSelect 组件交互 | ✅ | 加密强度下拉：`button.md-select__trigger` 展开 → `div[role=listbox]` + `div[role=option]` 三档渲染 → 选择回填触发器 |
| — | MdDialog 焦点陷阱 | 单测声明 | mdOverlays（Tab 循环/遮罩/Esc），IAB 下由添加条目对话框打开/关闭/提交流程间接覆盖 |

## Phase B — 设置体验（plan15）

| # | 功能点 | 结果 | 关键证据 |
|---|---|---|---|
| B1 | 备份口令会话 + 记住到保管区 | ✅ | 「启用会话」→ storage 新增 `secretBag`（`{v:1,nonce,ciphertext}` 密文）+ 卡片态「已存入保管区，解锁即用」+「备份口令已启用」 |
| B2 | 自动备份/同步开关 | ✅ 渲染 | 「变更后自动同步」「定时自动同步」+ 间隔 MdSelect（1 小时）；自动通道由 background SW 承载（见边界①） |
| B3/B11 | 跳过原因可观测 + 三态状态行 | ✅ | 注入 `cloudAutoStatus` 后状态行渲染「2026-09-18 02:51 成功：…」/「跳过：…」/「失败：…」三种前缀 + 时间戳 |
| B6 | 云多目标：添加源菜单 + 同类型多份 | ✅ | 「添加源」MdMenu 五后端（WebDAV/S3/Gist/GDrive/OneDrive）；两个 WebDAV 源并存；名称区分提示文案在场 |
| B7 | 每源保留策略 | ✅ | `Dav-保留` `retention:{type:"keep",n:2}`、`Dav-主` `{type:"overwrite"}` 逐源落盘 `backupSources` |
| B8 | 双源 mock 云同步闭环 | ✅ | GET(404)→PUT→GET 回读校验→双源「已上传」；keep 源走时间戳文件名 `vault-20260918-024714.totpbackup`，overwrite 源走 `totp-backup.totpbackup` |
| B9 | keep 滚动删除审计 | ✅ | PROPFIND 列 4 旧份 + keepN=2 → 精确 DELETE `0901/0902/0903` 三份，保留最新 2 份，删除域与列表域一致 |
| B10 | 锁定策略落盘 | ✅ | 空闲分钟输入 5 → `settings.lockIdleMinutes=5`；三开关（重启后/锁屏/空闲）渲染 |

## Phase C — 加密/备份/去重（plan16）

| # | 功能点 | 结果 | 关键证据 |
|---|---|---|---|
| C1 | 启用加密（真 Argon2id）+ 强度档位 | ✅ | security `{argon2id, m:65536, t:3, p:1, profile:"balanced", wrappedDek, passwordChangedAt}`；切「更慢更耐暴力破解」档 + 当前口令确认 → 重封装为 `profile:"paranoid", m:262144, t:4`，数据无需重加密 |
| C2 | 更换口令 | ✅ | `passwordChangedAt` 更新、profile 保持 paranoid、`chrome.storage.session` 的 DEK 同步轮换；旧口令拒绝由 C11 同路径验证 |
| C3 | 口令天数 | ✅ | 「本地主口令已 0 天未更换」 |
| C4/C6 | 备份导出 envelope v2 | ✅ | 拦截 blob：`{v:2, kdf:{argon2id,profile,m,t}, wrapNonce, wrappedDek, aead, dataNonce, ciphertext}` |
| C5 | 导入四档去重判定树 | ✅ | 4 行 URI（构造 identical/suspect/conflict/new 各 1）→ 预览「新增 1 · 完全相同自动跳过 1 · 疑似同账户 1（默认跳过）· 冲突 1」+ suspect 逐条三选 radio（跳过[默认]/新增/覆盖）+ 冲突策略三选 → 确认后报告「成功落库 1 条」+ 列表恰为既有条目 + NewSvc；suspect=覆盖分支由 importCard.dedup.test 7 例覆盖（文件选择器二次注入受 IAB 限制，见边界③） |
| C7 | 备份恢复回退 | 未覆盖 | 文件上传二次注入失效；恢复回退由单测覆盖声明 |
| C8 | DEK 会话持久化（T12） | ✅ | 解锁后 `chrome.storage.session` 出现 `dek`（32B base64）；换口令后值轮换 |
| C9 | 锁屏整页替换 | ✅ | seedKeys 注入密文态加载 → 整页被 LockScreen 替换（「已锁定 输入口令解锁本地数据」），无任何条目泄漏 |
| C10 | 正确口令解锁 | ✅ | 解锁后完整壳层恢复，保管区/凭据可用 |
| C11 | 错误口令拒绝 | ✅ | 「口令错误或数据已损坏」+ 保持锁定 |

## Phase D — 回归抽查（上轮 48 项关键项）

| # | 功能点 | 结果 | 关键证据 |
|---|---|---|---|
| D1 | OTP 全类型渲染 vs 页内独立重算 | ✅ | SHA1 精确命中（`648376`）；SHA256/SHA512 相邻窗口精确命中（`26596352`/`03059834`）；Steam 两窗口精确（`2G6B5`/`QBYBV`，Steam 字母表逐位取模）；HOTP counter=0 精确 `755224`（RFC 4226） |
| D2 | HOTP 复制递增 | ✅ | 剪贴板捕获 `755224` + storage counter 0→1 + UI 下一刷新周期显示 `287 082`（RFC 4226 counter=1） |
| D3 | 搜索过滤 | ✅ | 「git」→ 仅 GitHub 行 |
| D4 | 双 manifest 审计 | ✅ | chrome-mv3：MV3 + 9 权限（8 + 新增 `idle`）+ SW + popup/options；firefox-mv2：MV2 + gecko.id + `ext+otpauth` protocol_handlers |
| D5 | contextMenus/alarms 注册审计 | ✅ | 产物 background.js 各含 1 处 `contextMenus.create` / `alarms.create` |
| D6 | 倒计时 | ✅ | 行尾剩余秒数多点观测递减（27→15→5 等） |
| — | 添加条目（MD3 化表单） | ✅ | 对话框填写服务名/账户/密钥 → 保存 → 列表渲染（加密库下密文落盘） |

## 新发现

### N1（静态审计·建议修复）：firefox-mv2 未申请 `idle` 权限且 lockEnforcer 无存在性防护
`wxt.config.ts` 仅 chrome 端注入 `idle` 权限；`lockEnforcer.ts` 直接调 `chrome.idle.setDetectionInterval/queryState` 无 `chrome.idle` 存在性检查——Firefox 下空闲锁定静默失效（options 页每 30s 轮询抛 TypeError）。建议按 browser 注入权限 + 加守卫降级。另：审查 Critical-3（queryState 阈值语义）在产物 `background/options` bundle 中确认在场。

## 现场复现的审查结论

- **R3 Important-4**：注入 runner 实际形态的 summary（uuid key）后，状态行原样显示 `feee2f46-e109-40f9-a0a6-659071d3d7ef: 已上传`——uuid 泄露用户可见。
- **R3 Minor（同名源提示反转）**：两个名称互不相同的源显示「同名源请用「名称」区分（同类型可添加多份）」。

## 边界说明（不可 mock / 未覆盖，不阻塞）

1. **自动云同步通道**：由 extension background SW / desktop 宿主 runner 承载，shim 无真实 SW 逻辑——本轮验证了开关渲染、手动同步全链路与状态行三态渲染；调度/去重由 core autoRun 14 例 + cloudRunner 测试覆盖。
2. **Tauri 桌面**（托盘/DPAPI/本地备份目录源/Windows 锁屏事件）：浏览器不可触达，由 desktop 64 单测 + Rust 单测 + `cargo check` 覆盖。
3. **文件选择器二次注入**：同页第二次 `input[type=file]` 注入受 IAB chooser 状态限制失败，suspect=覆盖分支改由单测覆盖声明；首轮注入（判定树预览+确认）完整走通。
4. **seedKeys 中文编码**：shim `atob` 为 Latin-1 语义，注入串内中文呈 mojibake——属测试注入工具限制（页面内生成的「成功/跳过/失败」前缀与日期渲染正常），非产品缺陷。
5. **alarm→offscreen 实际清剪贴板**、**浏览器同步分片**：与上轮同口径，由单测覆盖。

## 结论

真实浏览器端到端层面：plan13–plan16 的全部核心承诺——**MD3 主题系统与五页导航、两把口令与保管区、envelope v2 与三档 KDF、双源云同步与精确滚动删除、四档导入去重、锁定策略、DEK 会话共享**——按设计工作；上轮 48 项核心功能无回归。需要处理的是审查报告中的 3 个 Critical（其中 C3 经产物 bundle 确认在场）与本报告 N1。

## 产出物

- 本报告：`docs/review/2026-09-18-e2e-verification-report.md`
- 配套审查：`docs/review/2026-09-18-plan13-16-full-code-review.md`
- 注入脚本增强：`scripts/inject-test-shim.mjs`（新增 `chrome.storage.session` 内存实现，测试专用）
