# 网络时间源 全球链（源链剖面）e2e 真机走查（2026-11-18）

## 范围

plan24（时间源特性）收尾后的**全球链与源链剖面**特性真机行为验证：2026-11-13 落地的剖面判定与双链
（`12fed01` core 源 id 清单 / `7a77d41` UI 界面语言判定 + 下拉随链切换 / `4c51942` 扩展国际链校准器 /
`cacf444` 桌面按池分池），以及 11-14 的两条护栏（`af353e7` HTTPS 源 RTT 护栏、`3efd95e` 缓存新鲜度护栏）。

覆盖问题：源链剖面是否真按界面语言切、首选源下拉是否随链换、双端国际链能否真机校准、四处「立即同步」
入口是否齐平、偏移是否只落本设备。

走查方式沿用 2026-11-11 惯例：桌面端为 debug 构建（mcp-bridge 仅 debug 装配）+ 直连 MCP Bridge WebSocket
驱动（`capture_native_screenshot` / `execute_js`）；扩展端为 Edge 157 `--load-extension` +
`--disable-features=DisableLoadExtensionCommandLineSwitch` + `--lang=en-US` + CDP 驱动。

## 数据安全协议

- 桌面：应用数据目录 `%APPDATA%/com.totp.desktop` 为本次演示库（12 条随机生成的假密钥、4 个假标签，
  vault 已加密、口令 `demo1234`），会话后可整目录删除；校准用真实网络时间源（只读公开 NTP/HTTPS 端点）。
- 扩展：Edge 独立 profile（`C:/tmp/edge-ext-prof4`），会话后删除；写入 `chrome.storage.local` 的演示数据
  为随机生成的假密钥。
- 本轮不做断网实验（影响真实环境），「全源失败」由 core 决策单测与集成用例覆盖（见「遗留与标注」）。

## 桌面端结论：G1–G8 全 ✅（G5 为等价条件复现，见表内说明）

| # | 场景 | 结果 | 证据/说明 |
| --- | --- | --- | --- |
| G1 | 界面语言切 English → 源链剖面切 global | ✅ | 设置页时间源卡整卡转英文（Calibration source / Preferred source / Sync now）；「Preferred source」下拉由国内链换成国际链 8 源 + Automatic (built-in order)：Cloudflare NTP、NTP Pool (Global)、NIST NTP、Apple NTP、NICT NTP (Japan)、NTP Pool Europe、NTP Pool Asia、Ubuntu NTP——与 core `NTP_TIME_SOURCE_IDS_GLOBAL`（`packages/core/src/time/timeSync.ts`）及 Rust `NTP_POOL_GLOBAL`（`apps/desktop/src-tauri/src/time_sync.rs`）逐项一致。证据图：[desktop-settings-en.png](assets/2026-11-18-time-source-global/e2e-global-settings-en.png) |
| G2 | 国际链真机校准（SNTP 池） | ✅ | 点「Sync now」→ 命中 **`time-apple`（Apple NTP，国际链）**，`offsetMs=-447`；状态行 "Last synced 00:00:18 · source Apple NTP · Device is 0.4s ahead"。SNTP 池并发竞速路径真实打通（本机可达，与 2026-11-13 设计文档源探针结论一致） |
| G3 | 校准结果落盘 | ✅ | localStorage `timeSyncState` = `{v:1, offsetMs:-447, syncedAt, sourceId:"time-apple", lastAttemptAt, lastAttemptFailed:false, preferredSourceId:null}`，schema 与 core `TimeSyncState` 一致 |
| G4 | 偏移只落本设备 | ✅ | 偏移与首选源只写 localStorage 本地键；`settings.json` 只有模式位 `timeSource` 与界面语言，不含偏移 |
| G5 | mini 快速窗「立即同步」按钮 | ✅（等价条件复现） | 网络模式下 mini 标题栏右侧渲染同步钮（`[data-test=mini-sync-now]`，aria-label「立即同步网络时间」）。**自动化环境取不到窗口 OS 焦点**（`isFocused()`=false），mini 的「重显重载」以 `onFocusChanged` 为触发点、无法自动触发，故以 mini 页 reload（等价重 boot、同样从盘重载设置）复现渲染条件。证据图：[mini-sync.png](assets/2026-11-18-time-source-global/e2e-global-mini-sync.png) |
| G6 | 切回「设备时间」 | ✅ | 同步钮消失；`settings.json` 的 `timeSource` 落回 `device` |
| G7 | 语言回切中文 | ✅ | 界面回中文、下拉回国内链；`settings.json` locale=zh |
| G8 | 控制台健康度 | ✅ | 桌面 WebView 控制台 error=0、warn=0 |

### 附带实证：TTL 自动重校的驱动源是出码页 tick（文档口径澄清）

对照实验：注入 7 天前的陈旧偏移（`syncedAt` 远超 TTL 6h）→ 设置页切「网络时间」→ **15 秒内无任何校准尝试**
（`lastAttemptAt` 未前进、`lastAttemptFailed` 未置位）→ 切回出码页 → **下一 tick 即自动重校**
（`syncedAt` 由 7 天前跳到当下，命中国内链 `neu`）。

原因有二：① 切模式时的「立即校准」条件是「无偏移」（`offsetMs === null`），有历史偏移即不触发
（`packages/ui/src/pages/SettingsPage.vue` 的 `setTimeSourceMode`）；② TTL 自动重校的决策挂在出码页
`useOtpCodes` 的 1 秒 tick 上（设置页不挂该 composable，故设置页内不会自动重校）。

**结论**：切到「网络时间」时若本地已有（哪怕已过期）偏移，**不会立即校准**；自动重校需出码页挂载后由
tick 触发，或由「立即同步」手动触发。行为与 spec §3-② 一致，但 CHANGELOG / README 原文未点明这两点，
已在 CHANGELOG「未发布」小节补注（README 只保留用户可见的行为面）。

## 扩展端结论：X1–X5 全 ✅

| # | 场景 | 结果 | 证据/说明 |
| --- | --- | --- | --- |
| X1 | 浏览器语言 en-US + 界面语言「跟随浏览器」→ 剖面 global | ✅ | Edge 以 `--lang=en-US` 启动 → `navigator.language=en-US` → 界面英文（`resolveLocale` 的 `/^en/i` 分支），源链剖面 global（`timeSourceProfileFor('auto')` 的 `/^zh/i` 判定不命中）。两者是**两套独立规则**——auto 下界面文案回落中文、源链却走全球链的情形（如 ja/fr/de 浏览器）仍存在，已在 README/CHANGELOG 注明 |
| X2 | 国际链真机校准（HTTPS 串行链） | ✅ | 设置页切「Network time」→「Sync now」→ background SW 真实执行校准 → 命中 **`timeapi`（TimeAPI.io 毫秒接口，国际链首源）**，`offsetMs=-453`；状态行 "Last synced 12:04:48 AM · source TimeAPI.io time API · Device is 0.5s ahead"。扩展 HTTPS 链首源即命中，无需降级。证据图：[ext-settings-en.png](assets/2026-11-18-time-source-global/e2e-global-ext-en.png) |
| X3 | 首选源下拉随链切换 | ✅ | 国际链列 TimeAPI.io time API、Cloudflare (overseas)、Cloudflare 204 (no-cache)、Microsoft time API + Automatic (built-in order)——与 core `HTTPS_TIME_SOURCE_IDS_GLOBAL` 一致 |
| X4 | popup 顶栏「立即同步」入口 | ✅ | 网络模式下 `[data-test=popup-sync-now]` 存在——四处入口之一（出码页 / 扩展 popup / 设置页 / 桌面 mini） |
| X5 | 跨端交叉印证 | ✅ | 桌面国际链（SNTP / Apple）−447ms 与扩展国际链（HTTPS / TimeAPI.io）−453ms 相差 6ms；与 2026-11-11 国内链走查的 −728ms（SNTP / 东北大学）/ −730ms（HTTPS / 淘宝毫秒 API）属同款互证——两套独立链路测得同一时钟偏差 |

## 遗留与标注

- **mini 同步钮的真机聚焦路径未自动覆盖**（托盘左键 / `Alt+Shift+T` 唤出 → 聚焦 → 重显重载）：自动化环境
  拿不到窗口 OS 焦点，G5 以等价重 boot 复现渲染条件。建议人工过一遍该路径。
- 断网 / 全源失败场景不在本机做（影响真实环境），由 core 决策单测与集成阳性用例覆盖。
- 「界面文案语言」与「源链剖面语言」在 auto 下是两套规则（非中英文浏览器可能出现「界面中文、源链全球」），
  属已知设计取舍，本轮只做记录，未改判定口径。
- 本轮未复核 RTT 护栏与缓存新鲜度护栏的触发样本（需构造慢应答 / 带正 TTL 的源），两条护栏的实证依据仍为
  2026-11-13/11-14 的真源探针记录。

## 复现要点

```bash
# 桌面端：debug 构建 + vite dev，直连 MCP Bridge 驱动
cd apps/desktop && (corepack pnpm dev &)            # 1420
cd apps/desktop/src-tauri && cargo build            # debug（mcp-bridge 仅 debug 装配）
./target/debug/totp-desktop.exe &                   # 桥接监听 127.0.0.1:9223

# 扩展端：Edge 加载 unpacked 扩展 + 英文浏览器语言
msedge.exe --user-data-dir=C:/tmp/edge-ext-prof4 --remote-debugging-port=9333 \
  --no-first-run --lang=en-US --disable-features=DisableLoadExtensionCommandLineSwitch \
  "--load-extension=<abs>/apps/extension/.output/chrome-mv3" \
  "--disable-extensions-except=<abs>/apps/extension/.output/chrome-mv3" about:blank
```

注意：Edge 157 与 Chrome 137+ 同款——不加 `--disable-features=DisableLoadExtensionCommandLineSwitch` 则
`--load-extension` 不生效；且必须用**全新** `--user-data-dir`，复用旧 profile 时扩展不再注册
（`chrome-extension://<id>/popup.html` 报 `ERR_BLOCKED_BY_CLIENT`）。扩展 id 由安装路径派生
（`sha256(utf16le(绝对路径))` 前 16 字节 nibble → `a`+nibble）。
