# 八项改进批量设计：MV3 迁移 / webview 释放策略 / UI·UX 与文档

- 日期：2026-09-23
- 状态：待评审
- 类型：批量设计（1 项架构级迁移 + 1 项架构级新特性 + 6 项 bounded 改进）
- 决策记录：本文档所有"已定"选项均经用户逐项确认（MV3 彻底切换、min_version 140、三段式释放、锁库双开关、MCP 片段嵌真 token、壳层统一滚动、全能剪贴板导入、README 全面刷新、gecko id `totp@bhxch.github.io`）。

## 0. 背景与范围

对 TOTP 工具（浏览器扩展 + Tauri 桌面端 + 共享 `packages/core`、`packages/ui`）做一批改进，共 8 项：

| 编号 | 主题 | 级别 |
| --- | --- | --- |
| 1 | Firefox 扩展 MV2 → MV3，`browser.*` 统一 | 架构级 |
| 2 | 导入帮助文案补齐（FoxAuth 等漏项） | bounded |
| 3 | MCP 连接 token 体验修复 | bounded |
| 4 | 壳层统一滚动（rail 固定 + 内容内滚） | bounded |
| 5 | 备注控件统一（MdTextField multiline） | bounded |
| 6 | 手动填写页剪贴板导入按钮 | bounded |
| 7 | 桌面端 webview 三段式释放策略 | 架构级 |
| 8 | README 双语化与文档链接化 | bounded |

实施顺序：2 → 3 → 4 → 5 → 6 → 1 → 7 → 8（#8 依赖 #1/#6/#7 落定后的最终事实）。

## 1. Firefox 扩展迁移 MV3

### 1.1 目标与非目标

目标：Firefox 目标产物从 MV2 切到 MV3，与 Chrome 同为 MV3，消除双 manifest 时代；API 调用统一到 `browser.*`；差异点收敛到三层模式（见 1.4）。

非目标：不引入新的扩展能力；不处理 AMO 上传流程本身；`offscreen` 清剪贴板等 Firefox 缺失 API 维持现有运行时降级，不做替代实现。

### 1.2 Manifest 变更（`apps/extension/wxt.config.ts`）

- `manifest({ browser })` 内对 firefox 覆盖 `manifest_version: 3`；产物目录随之变为 `.output/firefox-mv3`。
- `browser_specific_settings.gecko`：id 改为 `totp@bhxch.github.io`（email 形式，AMO 合法；一经发布不可更改），`strict_min_version: '140.0'`。
- 权限：双端追加 `clipboardRead`（供第 6 节剪贴板导入）；firefox 分支移除 `offscreen`（Chrome MV3 专属，Firefox 会因未知权限告警）。其余 `storage/unlimitedStorage/clipboardWrite/activeTab/alarms/notifications/contextMenus/idle` 双端保留。
- Background 形态：首选 firefox MV3 event page——在 manifest 覆盖中设置 `background: { scripts: ['background.js'] }`（现有代码已按事件驱动 + SW 生命周期风格编写：alarms 绝对时间触发、contextMenus 幂等注册、SW 冷启动兜底拉同步，event page 零改动兼容）。若 WXT 对 MV3 强制 service worker 形态，则接受 firefox MV3 service worker（Firefox 121+ 支持，代码同样兼容），以此作为明确备选，不阻塞。
- `protocol_handlers`（`ext+otpauth`）保留，MV3 下不变。

### 1.3 API 命名空间统一与 capabilities 收拢

- `apps/extension` 内全部 `chrome.*` 调用改为 `import { browser } from 'wxt/browser'`（WXT 内置 Promise 化包装，双 MV3 下行为一致）：`entrypoints/background.ts`、`entrypoints/popup/App.vue`、`entrypoints/options/App.vue`、`entrypoints/offscreen/offscreen.ts`、`src/dekSession.ts`、`src/chromeStorage.ts`、`src/lockEnforcer.ts`、`src/conflictBadge.ts`（文件清单以实施时 grep `chrome.` 为准）。
- `packages/ui` 共享层**不引入 wxt 依赖**（该包同时被桌面端构建引用）：维持全局探测风格，新建 `packages/ui/src/extensionCapabilities.ts`，用 `globalThis.browser ?? globalThis.chrome` 探测。能力收拢为四个接口，替代散落的内联判断（`App.vue` 的 `!chrome.offscreen`、`lockEnforcer.ts` 的 idle 检测、`conflictBadge.ts` 的 `chrome.action?.`、`clipboardClearer.ts` 的调度）：
  - `clipboardClearViaOffscreen`（offscreen 不可用 → 降级为仅本地清空，行为同现状）
  - `idleDetection`（不可用 → 上报"空闲自动锁定未启用"，行为同现状）
  - `openPopup`（存在性检查 + try/catch 静默降级，行为同现状）
  - `setBadgeText`（可选调用，行为同现状）
- 桌面端宿主（Tauri）在共享层眼中等价于"无扩展 API"，全能力降级，与现状一致。

### 1.4 差异处理模式（定案）

1. Manifest 层差异 → `wxt.config.ts` 的 `manifest({ browser })` 配置式分支集中处理。
2. 运行时能力差异 → `extensionCapabilities.ts` 特性检测 + 统一降级（Strategy 模式的轻量形态），调用点只问"能力可用吗"。
3. API 调用 → `browser.*` 统一命名空间。

### 1.5 CI 与产物

- `.github/workflows/build.yml` matrix `[chrome, firefox]` 不变；现有打包路径 `${browser}-mv3` 在 firefox 产出 mv3 后自动正确（该路径 bug 随本次迁移愈合）。
- 新增产物断言步骤：对两个产物分别校验 `manifest_version === 3`；firefox 产物额外校验：权限不含 `offscreen`、gecko id 为 `totp@bhxch.github.io`、`strict_min_version` 为 `140.0`、background 为 scripts 或 service_worker 之一且文件存在。

### 1.6 Commit 划分与验证

- Commit A：manifest/权限/id/min_version 切 MV3 + CI 断言。
- Commit B：`browser.*` 统一 + `extensionCapabilities.ts` 收拢（纯重构，行为不变）。
- 验证：`pnpm exec wxt build -b chrome` 与 `pnpm exec wxt build -b firefox` 双绿 + 断言通过；真机清单见第 10 节。

## 2. 导入帮助文案补齐

- 问题：`ImportCard.vue` 帮助区三行文案（i18n `importCard.formatsEncrypted / formatsApps / formatsText`，zh/en 两份）与实际解析能力不符，已确认漏 FoxAuth（加密类）、Ente Auth（应用类）；README.md 的清单已正确。
- 方案：以 `packages/core/src/import` 实现为准（`types.ts` 的 `ImportFormat` union + `sniff.ts` 判定序 + 各 parser）生成完整格式清单，逐项映射到三行文案，中英同步补齐；历史 spec/plan 文档为时点记录，不回改。
- 验证：新增/更新 locale 一致性测试（对齐 `packages/core` 导出的格式枚举，断言三行文案覆盖全部格式名），跑现有 i18n 测试套件。

## 3. MCP 连接 token 体验修复

- 问题：校验逻辑四层（恒时比较 fail-closed、空 token 拒启、启用时自动生成、CLI 最小长度）无洞；体验问题在 UI——未启用时 token 空串可被显示/复制为空，连接片段用 `Bearer <MCP token>` 占位符需手动替换才可用。
- 方案：
  - `apps/desktop/src/mcpCard.ts`：`connectionSnippet` 在 `cfg.token` 非空时嵌入真实 token，复制片段即可直接使用（token 本就同卡片可见可复制，泄露面不变）；空 token 时维持占位并输出引导注释。
  - `apps/desktop/src/McpServerCard.vue`：token 为空时显示"启用后自动生成"占位文案，复制 Token 按钮置灰；保存启用后以 `mcp_set_config` 返回的最新 cfg 立即刷新显示（后端 `fill_blank_token_if_enabled` 已保证此时必有值，不动 Rust 侧）。
- 验证：更新 `mcpCard.ts` 纯函数测试（嵌 token / 空 token 两分支快照）；真机走查"未启用 → 启用 → 复制片段直接连接"。

## 4. 壳层统一滚动

- 现状：滚动发生在 body（`.nav-shell` 仅 `min-height: 100dvh`，无 overflow），左侧 NavigationRail 随页面滚走。
- 方案（`packages/ui/src/pages/NavigationShell.vue`）：
  - 宽屏：`.nav-shell { height: 100dvh; overflow: hidden }`，`.nav-shell__main { overflow-y: auto }`；rail 定高固定。
  - 窄屏（`nav-shell--narrow`，<600px 顶部 Tabs）：维持文档流整页滚动，不改。
  - 页面级 `.page` 的 padding/gap 不动；CodesPage 的 FAB 为 fixed 定位不受影响；MdDialog/MdSelect 浮层不受影响。
- 验证：宽窄两档视口走查全部页面（Codes/Import/Settings 等）滚动与浮层行为；现有组件测试跑绿。

## 5. 备注控件统一

- 现状：`EntryForm.vue` 备注是表单内唯一裸原生 `<textarea>`，无设计 token，与 MdTextField（filled 背景 + 下边框 + 浮动标签）视觉脱节。
- 方案：
  - `packages/ui/src/components/md/MdTextField.vue`：新增 `multiline?: boolean` 与 `rows?: number` props，为 true 时渲染 `<textarea>`（v-model/label/error/placeholder 语义与单行一致），复用现有 `.md-text-field__box` 样式与聚焦态。
  - `EntryForm.vue`：备注字段换用 `<MdTextField multiline :rows="3">`，删除裸 textarea 的补丁样式。
- 验证：备注多行输入/表单校验/深浅色与 AMOLED 主题下视觉核对；EntryForm 现有测试跑绿。

## 6. 手动填写页剪贴板导入

- 目标：手动填写（manual Tab）内一键从剪贴板导入，复用现有识别与解析能力，免去打开文件选择器。
- 交互（`packages/ui/src/components/EntryForm.vue`，secret 行与"从图片识别"并排新增"从剪贴板导入"按钮）：
  1. `navigator.clipboard.read()`（需用户手势）。
  2. 含图片 → `blobToPixels` + `decodeQrToUri` → `parseUriToEntryData` 预填表单。
  3. 含文本 → `parsePastedText` / `sniffFormat` 解析：恰好单条可编辑条目 → 预填表单；多条 → 复用粘贴 Tab 同一入库通道（`EntryFormDialog` 已有批量入库回调链路）批量入库，完成后关闭对话框并提示入库条数。
  4. 剪贴板为空 / 无图片无文本 / 解析失败 → toast 错误提示，不动表单。
- 分流逻辑抽为纯函数（剪贴板 items → 意图：qr | single-entry | batch | none）便于单测。
- 权限：本项实施时即在 `wxt.config.ts` 双端 permissions 追加 `clipboardRead`（MV2 语法下同样合法，不依赖 #1 先行）；第 1 节迁移时保留该权限。桌面端 WebView2 的异步剪贴板读行为列入真机验证；不可用时按钮给出平台提示。
- i18n：zh/en 增按钮文案、成功/失败提示。
- 验证：纯函数单测（图片/单条 URI/多格式文本/空内容四分支）；双端真机验证（扩展 popup/options 需 clipboardRead 授权行为，桌面 WebView2）。

## 7. 桌面端 webview 三段式释放策略

### 7.1 目标与非目标

目标：窗口隐藏后按用户可配置的策略分级释放资源：隐藏（现状）→ 暂停 → 销毁 webview 仅留托盘进程；每档是否锁定 vault 由用户独立选择。

非目标：不做开机自启/单实例；不改变"关窗即隐藏到托盘"的即时行为；不在 Windows 之外追求暂停档全功能。

### 7.2 三段语义（Windows / WebView2）

1. **隐藏（即时，现状）**：关窗/失焦一律 `window.hide()`；WebView2 隐藏时自动挂起渲染。
2. **暂停（hide 后 `pauseMinutes`）**：通过 `window.with_webview` 取 `ICoreWebView2Controller`，QI `ICoreWebView2_6` 调 `TrySuspend`；要求窗口不可见，失败则维持隐藏并记日志。mac/Linux 无对应 API，该档降级为"无操作"，仅销毁档生效。
3. **销毁（暂停后 `destroyMinutes`；若暂停档禁用/失败则从 hide 起算）**：`destroy()` main 与 mini 两个 webview（进程与托盘保留）；托盘左键/菜单「显示主窗口」/全局快捷键触发时按 `tauri.conf.json` 同参 `WebviewWindowBuilder` 重建对应窗口并聚焦。

### 7.3 计时与状态机（Rust 侧）

- 计时由 Rust 托管（前端会被暂停/销毁，不可依赖）：30s tick 轮询 main/mini 可见性的状态机模块 `apps/desktop/src-tauri/src/release_policy.rs`——记录"全部隐藏"起始时刻与暂停发生时刻，驱动两档转换；任一窗口可见即重置状态并 resume。
- 轮询而非事件监听的原因：覆盖所有隐藏路径（Rust 拦截关窗、mini 失焦、前端"隐藏到托盘"按钮），无事件盲区，实现最简。
- 销毁/重建需处理与现有 `CloseRequested::prevent_close`、`Focused(false)` 隐藏、`LAST_FOCUS_HIDE` 竞态守卫的共存：销毁仅由状态机触发，托盘/快捷键路径只做"已销毁则重建再 show"。

### 7.4 锁库选项（用户自选，两个独立开关）

- `lockOnPause`（默认 **关**）：暂停档挂起同时执行既有锁定流程（清密钥、UI 回锁定页）。
- `lockOnDestroy`（默认 **开**）：销毁档锁定。销毁本身使前端内存密钥随 webview 清除，即天然锁库；选 **关** 时，销毁前前端将当前会话密钥交 Rust 进程内存暂存（不落盘），重建后经 invoke 回注恢复解锁状态，锁库或退出时清除暂存。密钥交接的具体载体（前端会话密钥存取点 ↔ Rust 暂存命令）在实施计划中落到具体文件，行为契约为：不锁库路径下重建后无需重新解锁；锁库路径下重建后必为锁定页。
- 暂停档（suspend）期间前端冻结，`lockIdleMinutes` 空闲锁定在暂停期间不生效（见 10.3 风险）。

### 7.5 设置与 UI

- 设置走 Rust 轨：`settings.json` 新增 `releasePolicy` 键（合并写、保留外来键、原子写，模式同 `devtools`/`mcp`）：

  ```json
  "releasePolicy": { "pauseMinutes": 5, "destroyMinutes": 30, "lockOnPause": false, "lockOnDestroy": true }
  ```

  分钟数 0 = 禁用该档（`pauseMinutes=0` 时销毁计时从 hide 起算；两档全 0 = 功能关闭，等价现状）。默认 5 / 30。
- Tauri 命令：`release_policy_get` / `release_policy_set`，注册进 invoke_handler。
- 前端：SettingsPage 桌面专属区块新增"窗口资源释放"卡片（两档分钟数输入 + 两个锁库开关），经 platform props 桥接（模式同 devtoolsPlatform）；zh/en 文案。
- 变更即时生效：状态机每 tick 读最新配置；销毁后修改配置仍可持久化（Rust 轨独立于前端存活）。

### 7.6 验证

- Rust 状态机单测（时间推进 × 配置组合：0/0、5/30、仅销毁、仅暂停；锁库两态）。
- 真机：隐藏后观察 TrySuspend 生效（CPU/GPU 下降）与失败降级；销毁后任务管理器内存回落、托盘可用、重建成功；锁库开/关两条重建路径；迷你窗与主窗组合隐藏场景。

## 8. README 双语化与文档链接化

- 范围：全面刷新。
- 交付物：
  - `README.md`（中文）重写：结构重排（简介/特性 → 安装 → 使用 → 导入格式清单 → MCP → 构建 → 架构与文档索引 → 安全说明 → License）；补 MCP 章节（默认端口 47215、Bearer 认证、四档 gate、`.mcp.json` 连接示例、token 在设置页 MCP 卡片复制/重生成）；同步第 1/6/7 节落定后的事实（Firefox MV3、min_version 140、`clipboardRead`、释放策略设置、剪贴板导入）；顶部语言切换行：`[简体中文](README.md) | [English](README_en.md)`。
  - `README_en.md`（英文）：与中文版结构逐节对应的全量翻译，顶部同样的互链行。
  - 两份 README 内**所有**文档引用改用 markdown 相对链接（现状为反引号纯文本路径）；新增内容一律使用链接格式。
- 验证：链接逐个可达（相对路径校验）；中英结构对照走查；构建命令按 README 可复现。

## 9. 实施顺序与 Commit 划分

| 顺序 | 项 | Commit 粒度 |
| --- | --- | --- |
| 1 | #2 文案补齐 | 1 个（i18n zh/en + 测试） |
| 2 | #3 MCP token | 1 个（mcpCard + 卡片 + 测试） |
| 3 | #4 壳层滚动 | 1 个 |
| 4 | #5 备注控件 | 1 个（MdTextField multiline + EntryForm 接线） |
| 5 | #6 剪贴板导入 | 1 个（纯函数 + 按钮 + i18n + `clipboardRead` 权限） |
| 6 | #1 MV3 | 2 个（A：manifest/权限/id/CI；B：browser.* + capabilities） |
| 7 | #7 释放策略 | 2–3 个（Rust 状态机+命令；前端卡片+桥接；DEK 暂存回注） |
| 8 | #8 README | 1 个（README 重写 + README_en + 链接化） |

每项完成后即时 commit（Angular 规范，why + what 单句）；不含 `.output` 等构建产物。

## 10. 风险与真机验证清单

### 10.1 MV3 迁移

- WXT 对 firefox MV3 + event page 的支持若与预期不符 → 回退到备选（firefox MV3 service worker），代码双兼容，不阻塞。
- `browser.*` 替换为机械改动但涉及异步化，逐文件核对 await 语义；Commit B 单独可回退。
- Firefox MV3 下 `storage.session`（140 支持）、`idle`、`contextMenus`、`alarms` 均可用；offscreen 降级路径维持现状。

### 10.2 剪贴板读取

- 扩展端 `navigator.clipboard.read()` 需 `clipboardRead` 且 Firefox 要求用户手势（按钮点击天然满足）；桌面 WebView2 行为需真机确认，不可用时按钮级提示，不做 polyfill。

### 10.3 释放策略

- `TrySuspend` 需 WebView2 Runtime 支持 `ICoreWebView2_6`（2021+ Runtime 均具备）；失败静默降级维持隐藏。
- 暂停档挂起期间前端定时器冻结：`lockIdleMinutes` 空闲锁定在暂停期间失效，由 `lockOnPause`（默认关，由用户权衡）与销毁档兜底；该取舍已在 UI 文案中说明。
- 销毁重建与 `prevent_close`/失焦隐藏竞态：销毁仅由状态机触发，重建统一走托盘/快捷键入口，逻辑单点。
- DEK 不锁库路径的 Rust 暂存仅存进程内存，退出/锁库必清，不落盘。

### 10.4 真机清单（合并）

- Chrome + Firefox 140：popup/options 打开、锁定/解锁、contextMenus、空闲锁定、图片识别、剪贴板导入、清剪贴板降级提示、badge。
- Windows 桌面：MCP 启用即生成 token、复制片段直连；释放策略三段与锁库两态；WebView2 内存对比。
- 构建矩阵：`wxt build -b chrome|firefox` + CI 断言 + `cargo test` + 前端测试套件全绿。
