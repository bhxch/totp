# miniapp 搜索/pin、销毁档白屏、管理页排序、云备份 404 四问题批 真机验证清单

| | |
|---|---|
| 状态 | **清单建立（2026-10-06），真机执行待安排**——除 D-4 单测断言已随本批 commit 全绿外，其余条目均待执行 |
| 对应 spec | `docs/superpowers/specs/2026-10-06-miniapp-sorting-cloud-fixes-design.md` §1.6（A）/ §2.6（B）/ §3.5（C）/ §4.6（D） |
| 相关 commit | D：e44efe1→a2adf33→197955a→1c24f87；A：62f7f57→5c42665→7b29f33→33ee06f；B：d7a249c/c7dad1c；C：c801b6c/60fbb2c/ad5b9be |
| 诊断归档 | 附录一 = Task 9（白屏不可复现 + is_visible 待排查）；附录二 = Task 12（drag-drop handler 根因 + rev 82→86 数据处置） |
| 登记惯例 | 执行后按 `docs/e2e-test.md` §6 指南回填本文件结果列，并在其 §4 索引登记 |

---

## A miniapp：搜索框 + 托盘定位 + 无边框 + pin（spec §1.6，五条）

前置：release 构建或 debug 构建 + vite dev 同起（debug exe 解析 devUrl）；金库解锁；mini 可弹出。

- [ ] **A1 搜索框过滤**【可自动化：tauri-mcp 驱动输入/DOM 断言；双击揭示=人工】：mini 显示搜索框，按 issuer/label/note 过滤生效，无命中显示空态文案；复制与双击揭示行为不受影响（复制读回剪贴板可脚本，双击揭示人工确认）。
- [ ] **A2 托盘左键锚定弹出**【人工】：托盘左键 → mini 弹出在托盘图标正上方且不出屏；多显示器布局至少验证一种非默认任务栏位（顶部或左侧）。
- [ ] **A3 无边框窗口**【人工】：标题区可拖拽移动窗口；pin/收起按钮工作；窗口带系统阴影。
- [ ] **A4 pin 三行为 + 重建保留**【可自动化（tauri-mcp/SendInput）；销毁档重建子项人工】：pin 后窗口置顶；点击窗口外失焦不隐藏；复制后不自动隐藏；双击揭示仍不被截断；销毁档（B 节参数）触发重建后置顶态保留。
- [ ] **A5 取消 pin 恢复**【人工】：取消 pin 后恢复全部原有行为（失焦隐藏、复制后隐藏、不再置顶）。

## B 销毁档后重开白屏（spec §2.6，三条）

**环境注意（Task 9 勘误）**：销毁档触发参数为 `releasePolicy {pauseMinutes:0, destroyMinutes:1, lockOnPause:false, lockOnDestroy:false}`——**勿用 0/0**（`destroyMinutes=0` 是禁用销毁档，`advance` 要求 destroy_minutes>0）；双窗隐藏后实测约 T0+70s 销毁（60s 计时 + 30s tick 粒度）。CDP 注入沿用 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333`（9222/9223 与应用内部服务冲突）；取证脚本可复用 `.temp/diag-task9/cdp.mjs`。

- [ ] **B1 重建重开 ≤2s 内容**【可自动化（CDP 计时断言）】：真机触发销毁档 → 托盘/热键重开：窗口出现即为主题底色（非刺眼白屏），2 秒内内容可见或显式错误横幅，不再是无任何内容的永久白屏。
- [ ] **B2 错误横幅可见**【可自动化（临时改错适配器路径 + mcp 断言）】：人为制造 load 失败 → 错误横幅出现且 console 输出含错误对象全栈（`[mini] load failed`）；恢复路径（下次聚焦自动重载成功后横幅消失）不受影响。
- [ ] **B3 非重建路径零等待**【人工】：非销毁的常规显隐路径（隐藏中再唤起）行为与现状一致，无额外等待感（ready 门控仅作用于重建路径）。

## C 管理页排序真机回归（spec §3.5，三条）

**环境注意**：排序真机回归需 vite dev 环境——纯 `cargo build` 的 debug exe 将 devUrl（`http://localhost:1420`）编入，无监听即白屏；需同起 `pnpm --filter @totp/desktop dev` 再操作。真实输入用 SendInput/mouse_event（`.temp/diag-task12/scripts/input.ps1` 可复用，DPI-aware）；store 直读通道 `document.querySelector('#app').__vue_app__._instance.setupState.store`。干净前置 = 非选择模式 + 搜索框空 + 无标签筛选。

- [ ] **C1 拖拽换位 + 序号定位移动**【可自动化（SendInput/CDP）】：干净前置下，拖拽把手换位 dragenter/dragover/drop 全链触发、列表顺序变化且重启后保持（reorderOp 落盘，rev 前进）；点击序号（修复后把手与序号并存，鼠标可达）→ 输入目标序号 → Enter → 条目移动；置顶区/普通区各自内部移动、跨区回弹行为不变。
- [ ] **C2 过滤态禁用提示**【可自动化（DOM 断言）+ 人工目检】：过滤/多选态下把手不渲染；序号 `cursor: not-allowed` + title 禁用提示（`codesPage.sortDisabledHint`）；该态下无可误触的死交互。
- [ ] **C3 popup 同序**【人工（DOM 读序辅助）】：popup 列表排序与 CodesPage/mini 同序（`sortEntries` 单点收敛后三面一致）。

## D 云备份 404 修复与完整错误日志（spec §4.6，五条）

前置：真实 WebDAV（坚果云/Nextcloud/Alist）；准备一个**服务器上不存在**的多级目标目录用于 D1。

- [ ] **D1 WebDAV 逐级建目录 + 幂等**【人工（真实服务器）】：overwrite 与 keep 两模式下，目标路径填不存在的多级目录 push 均成功且目录被逐级创建；对已存在目录二次 push 幂等成功（MKCOL 405 静默容忍）。
- [ ] **D2 完整错误日志**【可自动化（错密码 401 / 错服务器 URL 404·超时均可脚本）】：人为制造失败 → console 出现含方法/URL（host+pathname，不含 query）/状态码/响应体摘要的结构化错误行；UI 错误消息含状态码。
- [ ] **D3 自动备份失败摘要**【可自动化】：自动备份失败后，设置页状态摘要可见错误信息（错误消息 + 状态码）而非仅「失败」；`latestKeepPath` 首推吞错改为 console.warn 带状态码与 URL。
- [ ] **D4 路径校验拒绝 #/?**【可自动化：单测已全绿（targetPath.test.ts 拒绝用例）+ 预览 DOM 断言】：`resolveObjectPath` 对 `a#b`、`a?b` 抛错；CloudCredFields 预览显示非法警示。
- [ ] **D5 目录语义与实际目标显示**【人工（预览+落点+存量回归对照）】：`/totpbackup/` keep 模式预览显示完整 URL（`https://…/dav/totpbackup/vault-…`）且 push 落在该目录；`/totpbackup/` overwrite 模式预览为 `totpbackup/totp-backup.totpbackup`；keep 模式填 `a/b.totpbackup` 显示「文件名不生效」警示行；输入框 label 随保留模式切换（keep=「目标目录（文件名自动生成）」）；不以分隔符结尾的存量凭据（如 `a/b.totpbackup` overwrite）预览与上传行为与现状逐字节一致；gist/gdrive 维持平铺提示。

---

## 附录一：Task 9 诊断结论归档（2026-10-06）

来源：`.superpowers/sdd/2026-10-06-miniapp-sorting-cloud-fixes/task-9-report.md`（只读诊断，未改码；产物 `.temp/diag-task9/`，git-ignored）。

**1. 白屏不可复现（h1/h2/h3 均不成立）**：6 轮销毁→重开实验（debug ×4 含 2 轮带 CDP、release ×2 含 pin=false + 销毁后长驻留 3 分钟）全部正常渲染。CDP 取证：`mini.html` 导航 200、资产全 200、`Network.loadingFailed`/console error/`Runtime.exceptionThrown` 零事件、`#app` 挂载完整（appHtmlLen≈82.5KB 与基线一致）、IPC 持续活跃；销毁后 WebView2 browser process 确认死亡并重启，重开走「全新 browser process + 全新 page」最严苛路径仍正常，反向排除 wry 复用脏环境类 h3 变体。第 1 轮起销毁触发统一采用真实语义（0/1 参数，T0+70s）。若用户白屏再现，先核对窗口是否连 titlebar 都没有（区分渲染层/业务层），并用 cdp.mjs 抓「重开瞬间」console/网络/DOM 三件套；重点补测睡眠唤醒、多显示器/DPI 变化场景。

**2. h3 降级预案不执行**：销毁档对 mini 改 `try_suspend_window`（仅 suspend 不 destroy）的降级方案无证据支持，**不执行**；真 destroy 是销毁档设计语义（长离场释放内存）。spec §2.2/§2.3/§2.4 的防御性加固（错误暴露/主题底色/ready 门控）照常落地（d7a249c/c7dad1c）。

**3. is_visible 疑似缺陷——登记待排查**：`release_tick` 的 `is_visible().unwrap_or(false)`（`src-tauri/src/lib.rs` 约 360-364 行）疑似可把可见窗误判为不可见 → 销毁档提前触发（Task 9 第 1 轮 main 窗在无 hide 操作、截图正常渲染的状态下「变为不可见」并进入销毁计时）。属独立潜在缺陷，非本批主诉；排查手段：留痕 eprintln 即可定位。**待排查，按 `docs/e2e-test.md` §6 惯例应登记 `docs/plans/2026-09-22-review-backlog.md`（本清单先登记存档）。**

**4. 参数勘误**：spec/brief 曾写「pauseMinutes=0, destroyMinutes=0 = 隐藏即销毁」有误——0/0 是**禁用销毁档**；真机触发用 0/1（本清单 B 节已按勘误执行）。

## 附录二：Task 12 诊断结论归档（2026-10-06）

来源：`.superpowers/sdd/2026-10-06-miniapp-sorting-cloud-fixes/task-12-report.md`（只读诊断，未改码；产物 `.temp/diag-task12/`，git-ignored）。诊断环境：debug exe（HEAD c7dad1c）+ vite dev + CDP 9333 + SendInput 真实输入。

**1. 拖拽失效根因（h2 成立）**：tauri/wry 默认启用的 drag-drop handler（Windows 文件拖入 OLE 处理）使 WebView2 内 HTML5 拖拽会话即刻终止——真实 OS 输入下 handle `dragstart` 原生触发，但 dragenter/dragover/drop 全程零触发、dragend 紧随（SetCursorPos 插值与 SendInput 相对移动两种手法独立复现）。tauri 2.11.5 源码自述（`webview/mod.rs:971`）：`disable_drag_drop_handler` 是 Windows 上使用前端 HTML5 DnD 的必要条件；应用 `ensure_window` 此前未调用。h1（过滤态误用）、h3（落库链失败）均不成立（合成 DnD 全链在真实 DOM 内工作正常且即时落盘）。

**2. 序号遮挡根因（独立 UI 缺陷）**：`CodesPage.vue` 的 `.row:hover .handle { display:inline }` + `.row.drag-enabled:hover .index-num { display:none }`——干净态下鼠标悬停行即把序号换位为把手，点击序号的鼠标路径物理不可达（elementFromPoint 实测命中 handle；touch tap 同理被挡）。jsdom 单测直接对 span dispatch click、无命中测试，故单测全绿而真机鼠标无效；序号编辑器仅剩键盘入口（键盘链端到端可用，含落盘）。

**3. 修复 commit 引用**：

| 缺陷 | 修复 | 内容 |
|---|---|---|
| 拖拽换位失效（h2） | c801b6c | main builder 加 `.disable_drag_drop_handler()`（mini 不加，无排序交互面；前端无 OS 文件拖入依赖经核实零命中） |
| 序号鼠标路径被遮挡 | 60fbb2c | 撤销 hover 隐藏序号，改把手并列出现；过滤态序号 title 禁用提示（sortDisabledHint zh/en）；reorderOp 失败两处 console.error 留痕（h3 防御）；popup 收敛 `sortEntries` 单点 |
| 过滤态视觉反馈缺失 | ad5b9be | 过滤态序号 `cursor: not-allowed`（评审 Important 补遗） |

**4. 诊断造成 vault rev 82→86 的数据处置记录**：实验前整目录备份 `%APPDATA%/com.totp.desktop` → `.temp/diag-task12/appdata-backup/`（9 项）。写入账目共 4 次，全部加密落盘：rev83 实验①合成换位 Microsoft↔Google；rev84 实验①拖回还原（顺序回基线已断言）；rev85 实验②键盘链意外写入（Aliyun 7→27，输入被解析为 '27' 所致，应用按 `Number.parseInt` 正确执行钳位与移动，非应用缺陷）；rev86 `store.reorderOp` 精确还原 Aliyun 27→7。终态核验：前 10 顺序与基线逐项一致、条目数恒 66 无增删（单元素移动为 Exact involution，rev 账目闭合）。不可逆项：vault rev / `vault_rev_watermark.json` 水位前进 4（设计为单调，不可也不应回退），密文与 mtime 相应更新；内容语义与实验前一致。未触碰：settings.json、release_policy（0/1 原值）、security.json。

---

## 真机执行记录（2026-10-06 会话，controller 直跑）

环境：HEAD 06370c5+796aed4 的 debug exe + vite dev（同起）+ WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS CDP 9333 + tauri-mcp driver 9223；真实输入 SendInput（input.ps1）；本地 WebDAV 替身（MKCOL 201/405 幂等 + 401 故障模式，.temp/e2e-2026-10-06/webdav-standin.mjs）。

| 条目 | 结果 | 证据/注记 |
| --- | --- | --- |
| A1 搜索过滤 | ✅ | 66→3(git)→「无匹配条目」→66；过滤后序号=过滤后序位；复制/双击揭示不受影响 |
| A2 托盘锚定 | ⏳ 人工 | 托盘图标点击不可自动化；快捷键路径弹出+LAST_MINI_POS 恢复已实证 |
| A3 无边框 | 部分 ✅ | pin/收起按钮真机点击工作（hide→visible=false）；标题区拖拽移动与系统阴影=人工目检 |
| A4 pin 三行为+重建保留 | ✅ | topmost=True；失焦（Alt+Tab/切主窗）不隐藏；复制后不自动隐藏；销毁档重建后 topmost=True + miniPinned=true 持久 |
| A5 取消 pin 恢复 | ✅ | topmost=False；复制后 500ms 自动隐藏恢复（窗口消失实证） |
| B1 重建重开 | ✅（带注记） | 销毁档（0/1）触发后重开：窗口随内容就位（ready 门控生效，无空白期），重建后置顶保留；dev+vite 冷启动全程 ≈6.1s，严格 ≤2s 口径需 release 构建复测 |
| B2 错误横幅 | 部分 ✅ | 单测覆盖（boot 失败→横幅+console.error，796aed4 批次内）；真机横幅组件渲染已验证；首载失败注入受工具限制未完成（CDP addScriptToEvaluateOnNewDocument 时序 + 桥接 eval 主世界隔离），挂账 release 模式补测 |
| B3 非重建零等待 | ✅ | hide→热键重开：OS 轮询 visible-after=10ms，内容即时（隐藏态保留） |
| C1 序号定位移动 | ✅ | 真实鼠标点击序号→编辑器打开**并聚焦（本会话新缺陷修复 796aed4）**→真实键入 1+Enter→条目移动→rev 87→88 落库；分区钳位行为与单测一致 |
| C1 拖拽换位 | ❌（根因升级） | disable_drag_drop_handler 与 +SetAllowExternalDrop(false) 两种状态下，自发起 HTML5 DnD 均于原生 dragstart 后立即 abort（SendInput 绝对/相对位移两变体独立复现；合成 DnD 全链正常=jsdom 盲区）。**spec §3.3-h2「不可修」分支达成：需报批 pointer 长按拖拽方案**（或升级 WebView2 runtime 复测） |
| C2 过滤态禁用提示 | ✅ | 把手不渲染；序号 cursor:not-allowed + title 禁用提示；点击无死交互；清空恢复 |
| C3 popup 同序 | ⏳ 人工 | popup 需浏览器加载扩展 |
| D1 逐级建目录+幂等 | ✅ | keep 模式目标 /e2e/a/（不存在多级目录）：MKCOL /e2e→201、MKCOL /e2e/a→201、PUT→201，文件真实落位；目录意向语义端到端生效（用户坚果云问题的闭环）；二次同步 rev 收敛无错误 |
| D2 完整错误日志 | ✅ | console 结构化行（label/method/状态码/响应体）：替身 401「Unauthorized: bad credentials」+ 坚果云真实 404 ObjectNotFound / 409 AncestorsNotFound 全 XML 响应体；UI 状态行含「（HTTP 401/409）」 |
| D3 自动备份失败摘要 | ✅ | 失败摘要=「失败：WebDAV 请求失败（HTTP nnn）：GET …错误消息」而非仅「失败」；latestKeepPath 吞错 console.warn 带 status/method/bodySnippet |
| D4 路径拒绝 #/? | ✅ | a#b → 「路径无效」警示 + 实际目标预览消失（单测+DOM 双证） |
| D5 目录语义与完整显示 | ✅ | overwrite：/e2e/a/ → 完整 URL+默认文件名；keep：完整 URL+vault 占位+label「目标目录」；文件名输入→「不生效」警示行；keep push 实际落位 e2e/a/ |

### 本会话新发现

1. **真机缺陷（已修）**：序号编辑器打开后无聚焦——真实点击后键入与 Enter 全部落空，jsdom setValue 直写掩盖。修复 commit `796aed4`（startIndexEdit nextTick 聚焦+全选 + attachTo 断言用例）。
2. **拖拽根因升级**：c801b6c 的 disable_drag_drop_handler 在 WebView2 154 (Edg/154.0.4258.53) + wry 0.55.1 下不足以恢复 HTML5 DnD；叠加 SetAllowExternalDrop(false) 亦无效。升级为「WebView2 层自发起 DnD abort」，处置按 spec h2 不可修分支报批 pointer 方案。
3. **e2e 环境坑（后续会话注意）**：debug exe 需同起 vite dev（devUrl 编入）；`cargo test` 不重链 bin——验证 Rust 行为前必须 `cargo build`；CDP 9333 端点经多轮重启易僵死（桥接 9223 通道兜底，首次调用需 --timeout ≥10s 热身）；被 kill 的后台任务可能遗留卡住的修饰键（先 clear-modifiers 再发快捷键）；跨进程重启后 hwnd 全部失效需按 pid 重新枚举（EnumWindows 回调内 Write-Output 会丢失，须累积后输出）；桥接 eval 主世界隔离——页面内 monkey-patch 注入对应用代码无效。
4. **数据处置**：条目顺序实验写入后顺序还原尝试因 issuer 重叠产生错乱，已执行**整目录备份还原**（vault.json 与会话前备份字节一致已断言）；e2e 测试云源与凭据随还原移除；同步触发过一次坚果云真实只读（PROPFIND/GET，404/409 因其目录不存在——即本批修复的应用场景）；用户驻留 release 进程曾被结束，已重启（pid 57524）；releasePolicy 用户原值即 0/1（隐藏后 1 分钟销毁——测试期间窗口消失多为该配置所致，非缺陷）。

### 补充执行（2026-10-06 第二会话：坚果云 409 修复 + pointer 拖拽报批落地）

用户裁决：坚果云 404/409 确认为真 bug（exists 只容忍 404）；批准 pointer 长按方案。修复 commit 86401f8（exists 容忍 409 + 桌面通道回显请求 url）与 9540a7b（pointer 长按拖拽替代 HTML5 DnD）。

| 条目 | 结果 | 证据/注记 |
| --- | --- | --- |
| 坚果云 404/409 根因 | ✅ 确认并修复 | keep 源首推对写入路径 exists() GET，坚果云对父目录缺失回 409 AncestorsNotFound（非 404）→ exists 抛错致同步在 MKCOL 自愈前失败。修复后真机同步：状态「已上传」，MKCOL/PUT 在真实坚果云完成（目录 /totpbackup 创建） |
| D2 附带修复 | ✅ | 桌面 reqwest 通道 Response 回显请求 url（实例属性遮蔽），错误行不再恒「<url 解析失败>」 |
| C1 拖拽换位（pointer 方案） | ✅ | 真实 SendInput 拖拽把手（hover 确认把手在光标下）→ 换位落库 rev 87→88 → 反向拖回还原；双向成功。注意：自动化需先 hover 预热（handle 渲染滞后于首次 hover 一拍），人手无此问题 |
| B2 首载失败注入 | ⏳ 保持人工 | CDP addScriptToEvaluateOnNewDocument + dev 冷挂载时序 + 桥接 eval 主世界隔离三重工具限制；单测已覆盖横幅+console 路径 |

### e2e 环境坑增补

- 桥接 eval 偶发整批超时（两 webview 同时），等待或重启应用恢复；渲染（截图/倒计时）与真实输入（SendInput hover/选区）不受影响——怀疑 mcp-bridge/CDP 与应用主线程的相互作用，与本项目代码无关，记录备查。
- 真 SendInput 拖拽验证前必须以 elementFromPoint 确认把手在光标下（handle 渲染有一拍滞后）。

### B1 release 构建严格复测（2026-10-06 第三会话追加）

环境：release 构建（vite build 3.48s + cargo release 2m45s，HEAD 含全部修复）+ WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS CDP 9333；销毁档用用户原策略 0/1（隐藏 ~60-90s 后销毁，本轮实测销毁时点偏晚且与 B24 的 is_visible 误判方向一致——见下）；计时口径=SendInput 热键发送时刻 → CDP 轮询 mini webview target 出现 / `.otp-item`=66。

| 轮次 | target 出现 | 内容就绪（66 条） | 判定 |
| --- | --- | --- | --- |
| 第 1 轮 | 1085ms | **1321ms** | ✅ ≤2s |
| 第 2 轮 | 1007ms | **1309ms** | ✅ ≤2s |

结论：**B1 release 口径达标（≈1.3s，余量 0.7s）**；dev+vite 的 6.1s 系开发服务器冷编译所致，与产品无关。ready 门控（窗口随内容就位）在 release 下同样成立。

附带观察：本轮 0/1 策略下销毁时点明显晚于预期（隐藏后 155s+ 仍未销毁，最终 ~4min 内完成）——与 backlog B24（release_tick is_visible 误判）的方向吻合：误判「可见」会重置轨迹使销毁延迟。B24 排查优先级建议提高。
