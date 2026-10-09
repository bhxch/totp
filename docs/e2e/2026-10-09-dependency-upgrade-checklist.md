# 全量依赖升级 e2e 真机走查（2026-10-09）

## 范围

依赖升级批 13 commits（5501b60..c0a9b35）的真机行为验证，重点覆盖迁移风险面。走查方式：`pnpm tauri dev`（debug 构建，mcp-bridge 桥接激活）+ tauri-mcp 驱动；截图存 `E:\tmp\cc\dep-upgrade-20261009\e2e\`。

## 结论：6/6 通过，控制台零 error 零 warn

| # | 验证项 | 风险来源 | 结果 | 证据 |
|---|---|---|---|---|
| 1 | 主窗加载 + vue-router 5 hash 路由 + 66 条目渲染 + MD3 视觉基线 | vue-router 4→5、tokens/mcu 0.4.0 | ✅ | `#/codes` 路由正常；01-main-window.png：搜索框浮动 label、tag chips、品牌图标（Steam/GitHub/X）全部正常 |
| 2 | mcp-bridge CapturePreview 原生截屏 | vendored fork（webview2-com 0.39 适配后） | ✅ | "Screenshot captured via native API"——vendor 适配的 screenshot/windows.rs 真机工作，E2E 通道整体恢复 |
| 3 | MCP 服务器启停 + 鉴权 + MCP 握手 | rmcp 3.4.0→3.5.1（Origin 校验强化等） | ✅ | UI 切「运行中」；无 token POST → 401；错 token → 401；带 token+Origin initialize → 200 SSE（serverInfo totp-desktop / tools capability）；UI 切停后端口 connection refused（CancellationToken 停机链路正常） |
| 4 | 释放策略 TrySuspend 链路（隐藏→挂起→二实例重建→恢复） | tauri 2.11→2.12 + windows 0.61→0.62 + webview2-com 0.38→0.39（Interface::cast 同源） | ✅ | 「隐藏到托盘」后进程驻留（~44MB）；第二实例 exit 0 触发回调；主窗重建后 execute-js 响应、02-rebuilt-window.png 渲染完好（无崩溃/白屏） |
| 5 | 设置页回归（主题色 10 色板懒载、下拉浮动 label、释放策略/MCP/授权档位区块） | mcu 0.4.0 tokens-palettes 懒载、wxt 无关（desktop 侧 vite 8 构建） | ✅ | 02 截图：色板渲染、界面语言下拉、「分钟（0=禁用）」浮动 label 正常 |
| 6 | 控制台健康度 | 全部升级 | ✅ | read-logs error=0、warn=0 |

## 覆盖说明（未真机驱动、由其他证据支撑）

- **全局快捷键 ALT+SHIFT+T**：global-shortcut 2.4.0 注册在启动时完成，应用正常启动即证明插件初始化无 panic（B22 场景：注册失败会 exit 101）；按键派发受 ESET 吞键问题（2026-10-09 记录）无法自动化，与本次升级无关。
- **mini 窗口尺寸持久化**：parse/往返纯函数已有单测；lib.rs 窗口构建/恢复代码本次零改动（Task 2 评审确认 try_suspend_window 与 ensure_window 均未动），tauri 2.12 的 inner_size 语义无变化记录。
- **keyring 4.2.0（mac/linux osAutoUnlock）**：Windows 不编译，由 CI ubuntu rust job 编译验证（推送后核对）；Entry API 与 Error match 已静态核对（task-3-report）。
- **wxt 0.21 构建产物契约**：chrome/firefox 双构建 manifest 断言（offscreen/gecko id/strict_min_version 140/background.scripts event page）已在 Task 8 本地预演 PASS；CI build.yml 的 Assert MV3 步骤同脚本兜底。

## 遗留

无阻塞项。vendor 移除时机（上游发兼容版）与 coverage gate 恢复口径见 handoff 决策清单。
