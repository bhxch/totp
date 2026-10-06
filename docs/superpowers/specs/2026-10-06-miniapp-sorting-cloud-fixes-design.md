# miniapp 体验增强与排序/云备份修复批量设计

- 日期：2026-10-06
- 状态：待评审
- 类型：批量设计（1 项 bounded 特性集 + 3 项诊断型修复）
- 决策记录：所有"已定"选项均经用户确认（2026-10-06 对话）——① pin 语义 = 置顶 + 不自动隐藏（含复制后自动隐藏一并禁用）；② 排序症状 = 管理页拖拽把手与序号输入**双双无效**（真机修复）；③ 云后端 = 多种混用，以 WebDAV 自动建目录为主修复、全后端补全错误日志；④ 白屏表现 = **永久白屏**（非加载期闪烁），说明前端初始化失败被静默吞掉。

## 0. 背景与范围

用户报告四个问题，调查后归入本批：

| 编号 | 主题 | 性质 |
| --- | --- | --- |
| A | miniapp 搜索框缺失 + 托盘点击定位 + 无边框 + pin 固定 | bounded 特性集 |
| B | 释放策略销毁档后重开 miniapp 永久白屏 | 诊断型修复 |
| C | 管理页拖拽排序与序号定位移动真机无效 | 诊断型修复 |
| D | 云备份目标路径 404 + 错误信息缺失 | bug 修复（根因已定位） |

实施顺序：D → A → B → C。D 根因已定位可直接修；A 纯增量；B、C 依赖真机诊断（tauri-mcp-cli，debug 构建已装配 mcp-bridge），排在后避免诊断环境被在途改动干扰。

### 0.1 调查结论（权威源码事实）

- **miniapp 窗口**：`apps/desktop/src-tauri/src/lib.rs:367` `ensure_window` 代码建窗（`tauri.conf.json` windows 为 `[]`），builder 无 `.position()`（OS 级联 → 位置随机）、未设 `decorations(false)`（现有原生标题栏）、无 `.always_on_top()`。托盘左键 `toggle_mini`（lib.rs:213）→ 重建/显隐。失焦隐藏是 `WindowEvent::Focused(false)` 无条件 hide（lib.rs:650），pin 无处可挂。复制后 500ms 自动隐藏在前端 `miniAutoHide.ts`（hide 回调闭包，可加条件）。
- **白屏链**：暂停档 = WebView2 `TrySuspend`；销毁档 `destroy_releasable_windows`（lib.rs:331）真销毁 main+mini webview（仅留托盘进程）；重开 = `ensure_window` 冷建 + **立即 show**（lib.rs:228），前端 mini.html → `MiniApp.vue` 整页冷启动（`load()` 串行 await 读盘/建 store），完成前窗口无内容。`load()` 的 catch **静默吞错**（MiniApp.vue:70-72，注释"重载失败保留旧数据"），失败时 store 恒 null。`mini.html` 与 `MiniApp.vue` 样式**均未设 body/html 背景色**——冷启动期与 JS 失败期在浅色系统下呈纯白。`onFocusChanged(focused)` 重显重载已存在（MiniApp.vue:103）。
- **搜索框**：popup 用共享组件 `packages/ui/src/components/SearchBar.vue`（v-model + 可选 `search-secret` checkbox）+ 谓词 `searchEntries`（`packages/ui/src/popupFilter.ts:38`，issuer/label/note 大小写不敏感包含）。mini（`MiniApp.vue`）未接入。
- **排序**：实现仅存在于管理页 `packages/ui/src/pages/CodesPage.vue`（④C，2026-09-30 commit `8f678dc`；**docs 无 spec 文档，行为口径只在 commit message**）。手写 HTML5 DnD：把手 `draggable` + `onDragStart` 已 `setData('text/plain')`（:239-245）、`onDragOver` 上下缘判定（:246-251）、`onDrop` → `moveWithinPartition` → `reorderOp`（:253-264）；序号点击变 `<input type=number>` → `moveToIndex` 钳位 → `reorderOp`（:269-284）。纯函数与单测齐（`listOrder.test.ts` 12 例、`CodesPage.reorder.test.ts` 8 例）。**门控** `dragEnabled = !selecting && query 为空 && 无标签筛选`（:233）：搜索/标签过滤态与多选模式下把手不渲染、序号不可点，**且无任何视觉提示**。popup 与 mini 只展示序号无操作入口。popup 列表排序仍是内联 comparator（popup `App.vue:91-96`），未收敛到 `entriesSort.sortEntries`（R14 遗留）。
- **云备份 404**：五后端（webdav/s3/gist/gdrive/onedrive）纯 fetch；**WebDAV 全链路无任何建目录（MKCOL）逻辑**（全仓库 grep 零命中），目标路径父目录在服务器不存在时 PUT 直接被拒（404/409，RFC 4918 应答 409 但部分实现答 404）。此前修复（`521da81` 路径解析、`7ac15a9` 实时预览）全为客户端语法层。错误链：`ensureHttpOk`（`packages/core/src/cloud/backend.ts:174`）**只保留状态码，丢弃响应体与方法/URL**；`CloudHttpError` 消息仅"xx 请求失败（HTTP nnn）"；自动备份通道失败目标只记"源名： 失败"（`packages/ui/src/cloudRunner.ts:348`），错误消息与状态码不上屏不落日志——这是排查困难的直接原因。另一 404 源：`resolveObjectPath`（`targetPath.ts:7-15`）不拒绝 `#`/`?`，二者把 URL 截断成 fragment/query → 实际 PUT 到错误位置。斜杠拼接与中文/空格编码已排除（`joinDavUrl` 归一正确，URL parser 自动百分号编码）。

## 1. A：miniapp 搜索框 + 托盘定位 + 无边框 + pin

### 1.1 目标与非目标

目标：miniapp 具备与 popup 同口径的搜索；左键点击托盘图标时 miniapp 弹出在托盘正上方；miniapp 无边框（自绘标题区）并支持 pin（置顶 + 不自动隐藏）。

非目标：不给 mini 增加右键菜单/二维码/编辑入口（维持只读快取定位）；不改窗口尺寸（320×420）；不改 popup 行为；不引入窗口位置设置 UI（位置仅由托盘点击决定 + 快捷键沿用上次位置）。

### 1.2 搜索框（`MiniApp.vue`）

- 引入共享 `SearchBar`（不带 `search-secret`，与 popup `App.vue:379` 同款用法）+ `query` ref；列表可见集 = `searchEntries(sorted.value, query.value.trim())`（`popupFilter.ts` 谓词单点复用，不引 `resolvePopupVisible`——mini 无 tag/URL 语境）。
- 序号显示过滤后序位（`i + 1`，与 popup 同口径）；`OtpListItem` 的 copy/dblclick 行为不变。
- 搜索无命中显示新文案键 `mini.searchEmpty`（zh/en，`packages/ui/src/i18n/locales/{zh,en}/common.json`）；其余空态逻辑不变。

### 1.3 托盘点击定位（`lib.rs`）

- Tauri 2.11.5 `TrayIconEvent::Click` 携带 `position` 与 `rect`（托盘图标物理矩形）。`on_tray_icon_event` 左键分支把 `rect` 传入 `toggle_mini`，show 前调用新函数 `position_mini_at_tray(app, rect)`：
  - 取 `mini.outer_size()`（物理像素），目标位置 = 右缘对齐图标右缘（`rect.x + rect.w - win_w`）、底缘贴图标顶缘（`rect.y - win_h`，即任务栏上方）。
  - `app.monitor_from_point(图标矩形中心)` 取所在显示器，位置 clamp 进 `monitor.work_area()`（防多显示器/任务栏在顶部或左侧的溢出）；monitor 不可得时跳过 clamp。
  - `set_position(Position::Physical(..))`。**每次托盘左键弹出都重新定位**（含已存在未销毁的窗口——用户挪动过窗口后点托盘仍回托盘旁，语义即"点托盘 = 唤出到手边"）。
- 快捷键路径不重新定位。为销毁重建后快捷键打开仍有合理位置：新增 Rust 静态 `LAST_MINI_POS`，在 mini 每次隐藏（Focused(false) hide、CloseRequested hide、托盘 toggle hide）时记录 `outer_position()`；`ensure_window` 冷建后若由快捷键路径打开且存在 `LAST_MINI_POS` 则恢复之，无记录则不设（OS 默认）。

### 1.4 无边框（`lib.rs` + `mini.html`/`MiniApp.vue` + capabilities）

- mini builder 追加 `.decorations(false)`、`.shadow(true)`（保留系统阴影）、`.resizable(false)`（无边框后无握缘，显式固定语义）。
- `MiniApp.vue` 模板顶部新增标题区（高约 36px）：`data-tauri-drag-region` 拖拽 + 右侧两个按钮——pin 切换（aria-pressed 反映状态）、收起（`getCurrentWindow().hide()`；`WindowEvent::CloseRequested → hide` 拦截保留作兜底）。按钮不得位于 drag-region 属性元素上（属性只对直接目标生效，子元素点击天然不触发拖拽）。
- `apps/desktop/src-tauri/capabilities/default.json` 追加 `core:window:allow-start-dragging`（drag-region 所需；现有 allow-hide/show/set-focus 已覆盖按钮所需）。

### 1.5 pin（置顶 + 不自动隐藏）

- **存储**：settings.json 新键 `miniPinned`（bool，缺省 false），经 `settings_io::write_section("miniPinned", ..)` 合并写；Rust 侧 `static MINI_PINNED: AtomicBool` 内存缓存，setup 时从 settings 读初值。
- **命令**：`mini_pin_get() -> bool`；`mini_pin_set(pinned: bool)`——更新缓存 + `write_section` + 对已存在的 mini 窗口 `set_always_on_top(pinned)`。注册进 `invoke_handler`。
- **失焦隐藏**：`Focused(false)` 分支改为 `label == "mini" && !MINI_PINNED` 才 hide 且记录 `LAST_FOCUS_HIDE`；pin 时不 hide、不记录（300ms 防竞态逻辑天然不触发）。
- **复制后自动隐藏**：`MiniApp.vue` 的 hide 闭包检查本地 pinned ref（mount 时 `mini_pin_get` 初始化，按钮切换时同步），pinned 则跳过 `getCurrentWindow().hide()`；双击揭示守卫逻辑不动。
- **重建恢复**：`ensure_window` mini builder 加 `.always_on_top(MINI_PINNED)`（销毁重建后置顶态不丢）。
- 释放策略无需改动：pin 窗口可见 → `advance` 恒 reset，不进暂停/销毁；pin 后手动隐藏 → 照常进入释放计时（重建后置顶态由 builder 恢复）。

### 1.6 验收

1. mini 显示搜索框，按 issuer/label/note 过滤、无命中文案正确；复制/双击揭示行为不受影响。
2. 托盘左键：mini 弹出在托盘图标正上方且不出屏（含任务栏在顶部/左侧的多显示器布局至少验证一种非默认位）。
3. 无边框：标题区可拖拽移动窗口；pin/收起按钮工作；系统阴影存在。
4. pin：窗口置顶；点击窗口外（失焦）不隐藏；复制后不自动隐藏；双击揭示仍不被截断；销毁档重建后置顶态保留。
5. 取消 pin 后恢复全部原有行为。

## 2. B：销毁档后重开白屏

### 2.1 目标与非目标

目标：① 销毁档销毁后重开 miniapp 不再出现无内容的永久白屏；② 前端任何初始化失败必须可见（横幅 + console 全栈），不允许静默；③ 加载期窗口以主题底色出现而非刺眼白屏。

非目标：不改释放策略三段式语义（隐藏→暂停→销毁）本身；不给主窗加等价机制（主窗销毁重开由既有首帧 show 逻辑覆盖，白屏主诉在 mini）；不做 loading 骨架屏动画（底色 + ready 门控已消除观感问题，YAGNI）。

### 2.2 错误暴露（`MiniApp.vue` / `mini.ts`）

- `load()` catch 改为：`console.error('[mini] load failed', e)`（保留错误对象非只消息）+ 置 `loadFailed` ref → 模板显示错误横幅（复用 `.copy-error` 样式类，文案键 `mini.loadFailed`，zh/en）。恢复路径维持现状：下次聚焦 `onFocusChanged` 自动重载，成功后横幅随 store 就位消失（横幅条件为 `loadFailed && !store`）。
- `mini.ts` 顶层注册 `window.addEventListener('error')` 与 `'unhandledrejection'` → `console.error`（捕获模块求值期/mount 期异常——永久白屏的主要嫌疑区，此前完全不可见）。

### 2.3 主题底色（`mini.html`）

- `mini.html` 内联 `<style>`：`html { background: #fff }` + `html[data-mode='dark'] { background: #1c1b1f }`（与既有内联主题脚本设置的 `data-mode` 联动；色值注释标明与 M3 暗色 surface 对齐，Vue 挂载后由 `MiniApp.vue` 的 `body { background: var(--md-sys-color-background) }` 接管精确主题色）。

### 2.4 ready 门控 show（`lib.rs` + `mini.ts`）

- 前端：`MiniApp.vue` `onMounted` 的首次 `load()` 完成后（无论成败）`emit('mini-ready')`（`@tauri-apps/api/event` 全局 emit，`core:default` 权限已含）。
- Rust：`ensure_window` 返回"发生了重建"已有（bool）；`toggle_mini` 在重建路径 show 前等待 `mini-ready`——setup 时 `app.listen("mini-ready")` 一次，回调向每轮重建对应的 `mpsc` 通道发信号（重建时换新通道，静态 `Mutex<Option<Sender>>` 管理）；`recv_timeout(2s)` 超时兜底直接 show（防前端死锁卡住弹出）。
- 非重建路径（仅隐藏中）show 不等待，行为不变。

### 2.5 真机诊断（实施首步）

- debug 构建 + tauri-mcp-cli：`release_policy_set` pause/destroy 调最小 → 等待销毁档触发 → 托盘/快捷键重开 → 抓取 webview console（devtools 远程端口或 mcp-bridge evaluate）与截图。
- 假设表与判定：

| 假设 | 判定特征 | 处置 |
| --- | --- | --- |
| h1 资源加载失败（mini.html/资产 404） | console 网络错误；GET mini.html 失败 | 修资产/URL；若为销毁重建特有查 wry 路由 |
| h2 模块求值/挂载期 JS 异常 | 2.2 的监听捕到 stack | 按 stack 修；通常即被 2.2 永久消除盲区 |
| h3 WebView2/wry 销毁重建缺陷（新建 webview 白屏无网络无 JS） | console 干净、网络零请求、`ensure_window` 返回 true 但页面无生命周期迹象 | 应用层无法修则**降级方案**：销毁档对 mini 仅 suspend 不 destroy（主窗维持 destroy），本 spec 补勘误记录 |

- 2.2/2.3/2.4 与诊断并行落地（三者无论根因为何都需要）；h3 分支若触发则追加一笔 commit。

### 2.6 验收

1. 真机触发销毁档后重开：窗口出现即为主题底色，2 秒内内容可见（或显式错误横幅，不再是无任何内容的白屏）。
2. 人为制造 load 失败（如临时改错适配器路径）可见横幅 + console 全栈。
3. 非销毁的常规显隐路径行为与现状一致（无额外等待感）。

## 3. C：管理页排序真机修复

### 3.1 目标与非目标

目标：真机上管理页拖拽把手拖拽换位、序号输入定位移动两条路径恢复正常并落库持久化；补齐该功能缺失的设计文档口径与真机回归项。

非目标：不把拖拽/序号入口加进 popup 与 mini（维持 ④C 全序语义的作用域为管理页）；不引入拖拽库（零依赖手写优先，除非诊断证明 WebView2 环境下 HTML5 DnD 不可修）；不改数据模型（`order`/`pinned` 字段与 `reorderEntries` 落库不变）。

### 3.2 真机诊断（实施首步）

- tauri-mcp 驱动桌面主窗 `/codes`：前置确保**非选择模式、搜索框空、无标签筛选**（`dragEnabled` 三条件，`CodesPage.vue:233`）→ ① 拖拽把手换位 → 断言列表顺序变化且重启后保持（`reorderOp` 落盘）；② 点击序号 → 输入目标序号 → Enter → 断言移动。
- 两步均在干净前置下失败 → 按 console 与 store 状态（经 mcp evaluate 读 `order` 字段、rev 水位）定位；任一步在干净前置下成功 → 用户症状与过滤态禁用相关，转 3.3-h1。

### 3.3 假设与处置

| 假设 | 判定 | 处置 |
| --- | --- | --- |
| h1 操作发生在过滤/多选态（功能被禁用但**无视觉提示**，用户感知"无效"） | 干净前置下两路径均正常 | 保留禁用设计，补提示：过滤态序号 `cursor: not-allowed` + title 文案（键 `codesPage.sortDisabledHint`，zh/en）；把手维持不渲染。docs 勘误记入口条件 |
| h2 WebView2 下 HTML5 DnD 环境差异（事件序列/命中差异） | 干净前置下拖拽失败而序号输入正常 | 修 DnD 细节（dragend/drop 时序、hit-target），原则零依赖手写；确实不可修才评估 pointer 长按方案，另行报批 |
| h3 落库链失败（reorderOp/持久层静默失败） | store 内 order 未变或落盘报错（onPersistError 横幅会亮） | 按根因修持久链；`confirmIndexMove`/`onDrop` 的 `await props.store.reorderOp(next)` 增加 catch → `console.error`（对齐 2.2 不静默原则） |

### 3.4 收尾项

- popup 列表内联 comparator（popup `App.vue:91-96`）收敛到 `sortEntries`（`entriesSort.ts` 单点，R14 遗留一致性收尾）。
- **口径补录**：④C 原始设计只存在于 commit `8f678dc` message——本 spec §3.1/§3.3-h1 即口径正本（按用户惯例：历史文档不回改，勘误/口径集中当日文档）。
- 回归：`CodesPage.reorder.test.ts`/`listOrder.test.ts` 保持全绿；若修了组件代码路径补对应用例；真机清单（docs/e2e）追加排序两路径 + 过滤态禁用提示条目。

### 3.5 验收

1. 真机干净前置下：拖拽换位与序号定位移动均生效且重启持久；置顶区/普通区各自内部移动、跨区回弹行为不变。
2. 过滤/多选态下有明确的不可用提示（h1 路径），或修复后该态下不再有可误触的死交互（h2/h3 路径）。
3. popup 排序与 CodesPage/mini 同序（`sortEntries` 单点）。

## 4. D：云备份 404 修复与完整错误日志

### 4.1 目标与非目标

目标：① WebDAV push 自动逐级创建缺失父目录（404 根修）；② 云端请求失败时完整错误（方法、URL、状态码、响应体摘要）进 console；③ 自动备份失败摘要携带错误信息；④ 路径校验拒绝 `#`/`?`（URL 截断型 404 根修）。

非目标：不加保存凭据时的服务器连通性探测；不做失败重试队列；S3/Gist/GDrive/OneDrive 不加建目录逻辑（语义不适用）；不改变 `objectPath` 存储位置（仍属凭据秘密区）。

### 4.2 WebDAV 逐级建目录（`packages/core/src/cloud/webdav.ts`）

- `put(path, data)` 前置：`dir = resolveDirPath(cred)` 非空时执行 `ensureDavDir(dir)`——按段累积（`a`、`a/b`、…）逐级 `MKCOL {base}/{seg}`（带 Authorization），状态 2xx 或 **405（已存在）** 视为成功继续下一级；其余状态走 `ensureHttpOk` 抛错（401/403 凭据问题原地暴露，不做目录重试）。目录齐备后才 PUT。
- 每次 put 都执行（无模块级缓存）：备份 push 低频，多出的 1~n 个 MKCOL 开销可忽略，换取无状态幂等。
- get/exists/listBackups 不建目录（读路径语义不变；listBackups 对不存在目录的 404 由 4.3 日志可见）。

### 4.3 完整错误日志（`packages/core/src/cloud/backend.ts` 及消费方）

- `ensureHttpOk` 改 async 并接受可选 `method`：签名 `ensureHttpOk(label, res, method?)`；非 2xx 时读取响应体文本（截断 ≤500 字符）构造 `CloudHttpError`，错误对象新增只读字段：`url`（复用 `describeUrl` 只含 host+pathname，不含 query 防 token 泄漏）、`method`、`bodySnippet`；`message` 保持单行中文摘要形态（`「xx 请求失败（HTTP nnn）」` 前缀不变，追加 `method hostpath` 与响应体摘要——既有字符串匹配兜底只依赖前缀形态，兼容）。全部调用点（webdav/s3/gist/gdrive/onedrive 约 15 处）补 `await` 与 method 实参。
- 抛错处同步 `console.error('[cloud]', label, method, url, status, bodySnippet)` 一行结构化输出——控制台可见完整现场（用户显式要求）。
- 自动备份通道（`packages/ui/src/cloudRunner.ts:348`）：失败目标摘要从「源名： 失败」改为「源名： 失败（错误摘要）」；`recordStatus` summary 携带首个失败的错误消息与状态码（`cloudAutoStatus` 落盘键结构不变，summary 字符串内含）。`cloudSyncShared.latestKeepPath` 的吞错改为 `console.warn` 带状态码与 URL（保持返回 null 的首推语义）。
- 手动通道 `CloudCard.vue` 的 60 字符截断展示维持（完整信息在 console）。

### 4.4 路径校验收紧（`packages/core/src/cloud/targetPath.ts`）

- `resolveObjectPath` 新增拒绝 `#` 与 `?`（抛「云端路径不允许包含 # 或 ?」）；`previewObjectPath` 的 invalid 态自动覆盖，`CloudCredFields.vue` 预览警示文案不变（复用既有 `cloudCard.pathPreviewInvalid`）。
- 中文/空格维持现状（URL parser 自动编码，实测可达）；`%` 不拦截（非法序列由 URL parse 报错，经 4.3 日志可见）。

### 4.5 验收

1. 真机 WebDAV（Nextcloud/Alist 或坚果云）：目标路径填**服务器上不存在的多级目录**，overwrite 与 keep 两模式 push 均成功，目录被逐级创建；对已存在目录二次 push 幂等成功（MKCOL 405 静默容忍）。
2. 人为制造失败（错密码 401、错服务器 404/超时）：console 出现含方法/URL/状态码/响应体摘要的完整错误行；UI 错误消息含状态码。
3. 自动备份失败后，设置页状态摘要可见错误信息而非仅"失败"。
4. `resolveObjectPath` 对 `a#b`、`a?b` 抛错且预览显示非法；既有 `targetPath.test.ts` 全绿并新增拒绝用例。

## 5. 测试与提交拆分

- **单测**：core——`ensureDavDir` 路径序列与 405 容忍（mock `fetchImpl`）、`CloudHttpError` 新字段与消息形态、`resolveObjectPath` 拒绝 `#`/`?`；ui——`CodesPage` 排序既有用例回归 + h1/h2/h3 修复对应增量；desktop——`miniAutoHide` pinned 跳过用例。Rust——`position_mini_at_tray` 几何计算（给定 rect/work_area/窗口尺寸的纯函数部分）单测。
- **真机清单**：docs/e2e 追加 A/B/C 三项验收条目（按仓库真机清单惯例）。
- **提交拆分**（Angular 规范，原子化）：
  1. `fix(core): 云备份 WebDAV 逐级建目录与完整错误日志`（§4，core+ui 同一语义）
  2. `feat(desktop): miniapp 搜索框、托盘定位、无边框与 pin`（§1）
  3. `fix(desktop): 销毁档重开白屏——错误暴露/主题底色/ready 门控`（§2）
  4. `fix(ui): 管理页排序真机修复与口径补录`（§3，commit 数随诊断结果定）
- **质量门**：`pnpm test`（根 vitest）全绿；`cargo test`（src-tauri）全绿；`pnpm exec wxt prepare` 后双端构建通过；CI 覆盖率 gate（71/54）不回退。
