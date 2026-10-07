# UI 紧凑化批次 + 安装服务诊断设计

日期：2026-10-08
状态：已报批（设计经两轮确认；MD3 数值经官网 browser-use 实测核实，方法与坑见 memory `md3-spec-lookup`）
覆盖需求：悬浮框自适应、安装服务总是失败、pin 后边框黑线消失、miniapp 搜索/tab 过大、窗口调窄布局劣化（含 sticky 失效与按钮挤压）、倒计时进度条等长、排版紧凑化与单页条目数、QuickCodesPanel contextMenu 失效

## 0. 背景与根因（探索实证）

| # | 现象 | 根因（已定位） |
|---|------|----------------|
| 1 | tab 行悬浮框太窄 | `TagFilterRow.vue` `.mode-pop` 硬上限 `max-width: 240px`，中英文案折成竖窄条 |
| 2 | pin 后卡片边框黑线消失 | CodesPage `.frozen` 负 margin 外扩 16px + 不透明 surface 背景盖掉 `MdCard--outlined` 的 `inset 0 0 0 1px outline` 描边；冻结条自身无分隔线 |
| 3 | 窗口调窄后搜索/tab 冻结失效 | `NavigationShell.vue` <600px 断点滚动交还 document，但 `.nav-shell__main` 残留 `overflow-y: auto` 且高度=内容高永不滚动，sticky 挂错滚动祖先 |
| 4 | 行内编辑/删除挤压窄窗 | `.ops` 以 `opacity: 0` 隐形但恒占 84px（40px 按钮×2+gap） |
| 5 | 行高虚胖、单页条目少 | 常显二维码按钮 40×40 把 code-line 撑到 40px（码文本仅需 ~21px）；行 padding 10px；卡片 gap 8px、padding 16px；560px 高窗口仅可见约 4 条 |
| 6 | 进度条随名称长短不一 | 组件根 `.otp-item` 无 `width:100%`，等宽全靠 CodesPage `:deep` 的 `flex:1` 兜底，非 flex 宿主下随内容伸缩 |
| 7 | mini/popup 头部区过大 | 搜索框 ~48px（filled 标准档）+ tab 行 32px + gap 8px，无紧凑档；mini 头部合计 ~136px（窗口 420px 高） |
| 8 | mini/popup 右键菜单失效 | `QuickCodesPanel` `withDefaults` 漏 `contextMenu` 默认值，透传 `undefined` 命中 OtpListItem 默认 `true`，preventDefault 后无人监听 |
| 9 | 安装服务总是失败 | **本机实证**：服务已注册（7045）、副本哈希与 HKLM 绑定一致、服务代码非 SCM 直跑 6s 稳定进循环——代码链路无 bug；SCM 启动上下文中进程在报告 RUNNING 前无声消失（三天无 7036/7000 事件）；机器装有 ESET Security，为最大嫌疑（未签名 exe 注册于 ProgramData 属其 HIPS 典型拦截场景）。另：UAC 取消（runas 退出码 !0）、提权进程失败（stderr GUI 下不可见）、服务 10s 未就绪三类原因被折叠成同一句前端文案 |

**用户已确认的决策**：

| 决策点 | 结论 |
|--------|------|
| 行内编辑/删除按钮 | 窄窗（<600px）隐藏、宽窗保留 hover 显示；右键菜单兜底 |
| 行内二维码按钮 | **彻底移除**（右键菜单"显示二维码"承担，CodesPage 已有） |
| 头像对齐 | 垂直居中（官网核实为 MD3 列表默认对齐） |
| compact 档语义 | 按官方 density 体系实现（opt-in 已由"用户主动 pin 小窗"成立）；字号缩小走"小一号标准 type 角色"槽位选择，与 density 解耦、分开标注依据 |
| 安装服务范围 | 本轮仅诊断增强+错误分类+杀软指引；安装位置（Program Files 方案）牵动安全模型，另立 round |

## 1. MD3 规范依据（官网核实，2026-10-08）

来源均为 m3.material.io 实际渲染页（browser-use 读取正文）：

| 规范项 | 官网数值 | 本设计采用 |
|--------|----------|-----------|
| 列表项高度 | 56/72/88dp，最高元素决定 | 两行布局目标 ~54px，落在 72dp 档内紧凑 |
| 列表元素对齐 | 默认垂直居中（≥88dp 或三行以上才顶对齐） | 头像/文本垂直居中 |
| 列表左右 padding | label 左 16dp；trailing 右 24dp | 水平 16px 采用；trailing 24dp 窄窗场景标注 deviation |
| 触控目标 | 48dp | CodesPage 默认档遵守；mini/popup opt-in 小窗 deviation |
| 文本框（filled） | 容器高 56dp | CodesPage 维持现状 ~48px；compact 40px |
| Chips | 容器高 32dp、圆角 8dp | CodesPage 32px 达标；compact 28px（恰为 -4dp 一档） |
| Icon 按钮 | XS/small 可达性目标 ≥48×48dp | compact 28px 视觉 + ≥32px 命中区，deviation 已标注 |
| Density 体系 | 0/-1/-2/-3 档，每档 4dp；默认不启用须 opt-in；density 不缩字号；Do=扫描对比型列表 | compact 档的实现语义；mini/popup 属用户 opt-in 小窗 + 验证码列表属"扫描对比"场景 |

**Deviation 清单**（有意偏离，均因 320×420 瞬态小窗或窄窗场景）：compact 搜索框 40px（低于 -3 档底线 44px）、compact chips/按钮 28px 视觉（低于 48dp 触控目标，保留 ≥32px 命中区）、trailing 右 padding 16px（非 24dp）、头像 36px（MD3 avatar 40dp，维持现状不放大）。

## 2. 改动设计

### 2.1 悬浮框自适应（`packages/ui/src/components/TagFilterRow.vue`）

- `.mode-pop` 改为 `width: max-content; max-width: min(360px, calc(100vw - 16px))`；中英文案单行呈现，窄视口不溢出。
- `.manage-pop` 保持 `right: 0` 右对齐防行尾溢出。
- 一处修改三宿主生效（CodesPage / MiniApp / popup）。其余样式（padding、inverse-surface 配色、body-small）不动。

### 2.2 冻结区分隔线 + 卡片描边保留（`CodesPage.vue` + `QuickCodesPanel.vue`）

- 两处 `.frozen` 加 `border-bottom: 1px solid var(--md-sys-color-outline-variant)`——滚动分界明确（MD3 top app bar divider 惯例），静态为搜索/标签区底边线。
- CodesPage `.frozen` 负 margin 由 `-16px` 收为 `-15px`：背景边缘距卡片描边 1px，露出的是卡片同色 surface 底（视觉无缝），左右 1px 描边不再被擦除。
- QuickCodesPanel 的 `--frozen-bleed` 机制不动（popup/mini 宿主无描边）。

### 2.3 窄窗 sticky 恢复（`packages/ui/src/pages/NavigationShell.vue`）

- 新增 `.nav-shell--narrow .nav-shell__main { overflow: visible; }`——窄屏本按注释意图走文档流整页滚动，残留的 `overflow-y: auto` 使 frozen 挂到永不滚动的容器。
- 修后 <600px 视口下搜索+标签行钉视口顶部，与宽窗行为一致。MdTabs（窄屏顶部导航）维持随滚，不在本批范围。

### 2.4 OtpListItem 紧凑化（`packages/ui/src/components/OtpListItem.vue` + `CodesPage.vue`）

- **移除行内二维码按钮**：删 `showQr`/`showQrButton` prop 与 template/CSS 全链路；清理 `QuickCodesPanel.vue`、`MiniApp.vue`、popup `App.vue` 的 `:show-qr="false"` 传参；`OtpQrDialog` 及右键菜单"显示二维码"保留。
- **编辑/删除**：`.ops` 按钮 40px→32px（占位 84→68px），保留 hover/focus-within 显示；`@media (max-width: 599px)` 下 `.ops { display: none }`（断点与 NavigationShell 一致，右键菜单兜底）。
- **padding**：行 padding `10px 12px` → `6px 16px`（垂直紧凑；水平 16px 对齐 MD3 label 左 16dp）。
- **进度条等长兜底**：`.otp-item` 加 `width: 100%`。
- **卡片瘦身**：`.codes-card` 改用 MdCard 现成 `compact` 档（padding 16→8px）；`.codes-card` gap 8→4px。
- 头像 36px 垂直居中不变。验证码字号 18px 不变（可读性优先）。
- 效果预估：CodesPage 行高 81→~54px；760×560 主窗可见条目 4→约 6 条。
- **真机复验项**：三端进度条逐行等长（若仍复现不等长，按 systematic-debugging 另查，不臆修）。

### 2.5 mini/popup compact 档（MD3 density 语义）

`QuickCodesPanel` 加 `compact` prop，MiniApp 与 popup 两宿主开启，CodesPage 不开：

| 元素 | 现状 | compact 档 | 依据 |
|------|------|-----------|------|
| 搜索框（MdTextField 加 `dense` prop） | 高 ~48px、body-large 16px | 高 ~40px、body-medium 14px、padding 22/16/6→10/12/4 | 槽位下移（type 角色选择）；高度 deviation 标注 |
| 标签 chips（MdChip 加 `compact` prop） | 32px、body-medium | 28px、body-small 12px | density -4dp 一档 + type 槽位 |
| ∧/∨ 按钮 | 32px | 28px 视觉，命中区 ≥32px | deviation（48dp 目标不适用于 opt-in 小窗） |
| frozen gap / 行内 gap | 8px | 6px | 信息密度杠杆（布局间距） |
| 行 padding | 10px 12px | 6px 12px | density 逻辑；OtpListItem 加 `compact` prop 控制水平 16→12px，QuickCodesPanel 经 `compact` 链路透传，CodesPage 不传保持 §2.4 的 6px 16px |
| mini titlebar | 34px | 30px | 信息密度杠杆 |

- 字号缩放全部走标准 type 角色（body-medium/body-small/label-medium），不在 density 语义内缩放文字，与官方"密度不缩字号"规则解耦。
- mini 头部区 136→~104px、条目行 62→~50px；420px 高窗口可见 4.7→约 6 行。

### 2.6 QuickCodesPanel contextMenu 默认值（`QuickCodesPanel.vue`）

- `withDefaults` 补 `contextMenu: false`，对齐既有注释语义；mini/popup 右键恢复浏览器默认菜单（当前 preventDefault 后空转）。

### 2.7 安装服务诊断增强（`apps/desktop/src-tauri` + `SecurityCard.vue` + i18n）

代码链路无 bug（本机实证），本轮交付可诊断性与错误分类：

1. **子进程日志落盘**：`--elevation-install` 与 `--elevation-service` 的全部 `eprintln!` 同步写入服务目录日志（install.log / service.log）。服务启动即写 "started" 行——若进程被杀软击杀则日志断尾，可实证拦截。落盘失败静默（不影响主流程）。
2. **StartService 后等待 RUNNING**：`start_if_stopped` 后轮询 query_status（5s 超时），未达 RUNNING 即报"服务启动未完成（可能被安全软件拦截）"并附 SCM 错误码。
3. **错误分类透传**：`trigger_install` 识别 runas 退出码 `0xFFFFFFFF`（UAC 取消）；提权进程退出码非零时携带原始码；`abe_bind` 失败把分类串传给前端（当前只进 console.warn）。
4. **SecurityCard 分类文案**：`abeBindFailed` 拆为三条 zh/en——"已取消 UAC 授权，安装中止" / "安装失败（原因/错误码），详见日志" / "服务未就绪：若安装了第三方安全软件（如 ESET），请将 `C:\ProgramData\TotpTools\service\` 加入信任后重试"。内联提示保留现有形态。
5. **文档**：`docs/e2e/2026-10-07-abe-service-checklist.md` 追加 ESET 排除步骤与日志查看方法（当日勘误惯例）。
6. 不动：服务安装位置、DACL 策略、10s 轮询预算（有日志实证后再议）。

## 3. 测试

- **单测更新**：TagFilterRow 气泡结构；OtpListItem 移除 QR 后结构/进度条 width:100%/无 ops 渲染断言调整；MdTextField dense、MdChip compact；QuickCodesPanel compact 透传与 contextMenu 默认值；elevation 错误分类纯函数、日志写入、RUNNING 等待（Windows 侧 mock）。
- **覆盖率**：不低于 CI gate 现状（68.19/47.35）。
- **真机清单**（docs/e2e 新增或并入现有）：三端宽/窄窗冻结与黑线核对、mini/popup 紧凑档与右键菜单、进度条等长、ESET 排除后服务安装全链路（安装→绑定→换口令→卸载）。

## 4. 提交划分（原子）

1. `fix(ui)` 悬浮框自适应（TagFilterRow）
2. `fix(ui)` 冻结区分隔线+描边保留（CodesPage/QuickCodesPanel）
3. `fix(ui)` 窄窗 sticky 恢复（NavigationShell）
4. `refactor(ui)` QR 按钮移除+ops 窄窗隐藏+行紧凑+进度条兜底（OtpListItem/CodesPage）
5. `feat(ui)` mini/popup compact 档（MdTextField dense/MdChip compact/QuickCodesPanel/MiniApp/popup）
6. `fix(ui)` contextMenu 默认值（可并入 5）
7. `feat(desktop)` 安装/服务日志+错误分类+RUNNING 等待（Rust）
8. `fix(ui)` SecurityCard 分类文案+i18n（可与 7 合并为一笔 feat）
9. `docs(e2e)` 真机清单勘误
