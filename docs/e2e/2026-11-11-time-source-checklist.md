# 网络时间源校准 e2e 真机走查（2026-11-11）

## 范围

plan24（时间源特性，cce93a7..1e98f0a）的真机行为验证：桌面端（Rust SNTP 池 + 毫秒 API 降级链、双窗、持久化）与扩展端（HTTPS 七源序 + background 消息通道、popup 齐平按钮）。走查方式沿用 2026-10-06/10-09/10-10 惯例：桌面 `pnpm tauri dev`（debug，mcp-bridge 9223）+ tauri-mcp 驱动；扩展端本轮新增 Edge `--load-extension` + `--remote-debugging-port=9222` + 原生 CDP WebSocket 驱动（`F:/tmp/totp-plan24-e2e/cdp-drive.mjs`，Node 24 内置 WebSocket，agent-browser 的 attach 不兼容 Edge CDP 已绕过）。

## 数据安全协议

- 桌面：本机 `Roaming\com.totp.desktop` 无存量（首次运行），协议简化为「无备份必要 + 会话后删除新建目录」——已执行（vault/settings/backupSources 三文件随目录删除）。
- 扩展：Edge 独立 profile（`F:/tmp/totp-plan24-e2e/edge-profile`），会话后删除；扩展 profile 内 settings 已切回 `device` 后再清理。
- 测试条目：RFC 6238 附录 B 公开测试向量（`12345678901234567890`），非真实秘密。
- 测试产物（截图/驱动脚本）留存 `F:/tmp/totp-plan24-e2e/`。

## 桌面端结论：D1-D9 全 ✅（D7 部分实证 + D9 单测覆盖标注），控制台零 error 零 warn

| # | 场景 | 结果 | 证据/说明 |
|---|---|---|---|
| D1 | 设置页时间源卡 device 模式渲染 | ✅ | 仅模式行（「设备时间」选中），首选源/同步钮/状态行均不渲染（spec §6） |
| D2 | 切 network → 自动校准（§3-②） | ✅ | **真机 Rust SNTP 校准成功：来源「东北大学 NTP」（stratum-1）、offsetMs=-728**；localStorage `timeSyncState` 落盘 schema 完整（v/offsetMs/syncedAt/sourceId/lastAttemptAt/lastAttemptFailed/preferredSourceId）；UDP 123 真实网络路径打通（终审 ⚠️2 之一闭合） |
| D3 | 出码页同步钮齐平渲染 | ✅ | `.card-head-ops` 内 `[data-test="codes-sync-now"]`，与「选择」钮同排不增行 |
| D4 | 条目落库 | ✅ | RFC 向量条目（totp/SHA1/6/30）经 EntryFormDialog 落盘（vault.json 核对） |
| D5 | **偏移注入端到端** | ✅ | **窗口边界实证**：nowSec%30==0 边界处 UI 显示 `450820`（counter=floor((now−0.728s)/30)=59811822），与 node 独立 RFC 计算完全吻合；下一窗 `731217` 同吻合。双击揭示为既有交互（Aegis 式 8s），shift+Enter 可编程揭示 |
| D5b | 出码页同步钮点击 | ✅ | syncedAt 前进（真机二次校准）；toast「本机超前网络时间 0.7 秒」（三态方向+秒数正确） |
| D6 | device 回切 | ✅ | 出码页按钮消失（network 模式条件渲染） |
| D7 | mini 双窗共享 | ✅（部分） | mini 与 main 的 localStorage `timeSyncState` 一致（sourceId=neu）——双窗偏移共享路径实证；mini vault 未重载（从未聚焦，既有双窗语义非本特性），出码链路与 main 同代码路径（单测覆盖） |
| D8 | 控制台健康度 | ✅ | error=0、warn=0 |
| D9 | settings 持久化 | ✅ | `settings.json` 的 `timeSource` 字段随切换正确写盘（device 回切后 =device） |
| — | 断网全源失败降级 | ⏭️ | 不在本机做断网（影响真实环境）；「全败→Err→回退设备时间」由 core 决策单测 + Task 2 集成阳性用例覆盖 |

## 扩展端结论：X1-X4、X6、X7 ✅（X5 下拉存在 + 单测保证），SW 消息通道端到端

| # | 场景 | 结果 | 证据/说明 |
|---|---|---|---|
| X1 | Edge `--load-extension` 加载 + popup 渲染 | ✅ | MV3 兼容；popup title「TOTP」，英文 locale 生效（浏览器语言 en） |
| X2 | options 时间源卡渲染 + 切 network | ✅ | MdSegmentedButton 两项，点击展开首选源+同步钮 |
| X3 | **真实 HTTPS 源序校准** | ✅ | **`sourceId: "taobao-api"`（七源序第一源）真机成功、offsetMs=-730**；chrome.storage.local `timeSyncState` 落盘完整。与桌面 SNTP 的 -728 交叉印证（两独立通道测得同一时钟偏差 ±2ms）；⚠️2（毫秒 API 真实响应形状）闭合 |
| X4 | popup 顶栏同步钮 + 消息通道 | ✅ | 钮在 `.header-ops` 内齐平；点击 → sendMessage → **background SW 真实执行七源校准** → 回包 → 校准落盘（syncedAt 前进）→ toast「Device is 0.7s ahead of network time」（英文三态） |
| X5 | 首选源下拉 | ✅ | MdSelect 渲染正常（浮层清单的 DOM 探针不适配自定义组件，七源+auto 清单由 SettingsPage.test.ts 单测钉死） |
| X6 | 状态行三段 | ✅ | 「Last synced 08:01:08 · source Taobao time API · Device is 0.7s ahead」（时刻+来源+偏差方向，i18n 英文） |
| X7 | device 回切 | ✅ | 设置卡同步钮消失；`chrome.storage.local.settings.timeSource=device` 落盘恢复 |
| — | SW 冷启动 sendResponse 时序 | ⏭️ | SW 常驻由浏览器管理；「回包通道保持」由 background.test.ts 单测覆盖（Review Focus 1）；真机反复校准 5+ 次无一失败即为旁证 |

## 遗留与标注

- 断网降级、SW 冷启动时序两项不在本轮真机范围（原因与覆盖方式见上表 ⏭️ 行）。
- 桌面 mini 窗聚焦重载后出码的可视化验证依赖原生窗口聚焦（tauri-mcp 无此能力），链路等价性由单测与 D7 共享实证背书。
