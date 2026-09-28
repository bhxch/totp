# 桌面版 GPU 占用 Profile 报告（2026-09-28）

## 结论摘要

「打开页面 GPU 占用高」的根因是**每个条目的倒计时进度环动画**：`useOtpCodes.ts` 的 1s interval 每 60 秒钟表周期更新一次 `stroke-dashoffset`，而 `OtpListItem.vue` 用 `transition: stroke-dashoffset 1s linear` 把这次跳变补间铺满整秒，等效于**每个可见条目一个永不停歇的 ~60fps SVG 重绘动画**。SVG 的 `stroke-dashoffset` 是 paint 属性（无合成器加速），每帧都要走 paint→raster→composite 全管线。

实测（9 条目，release 构建，GPU Engine 性能计数器 + CDP trace）：

| 场景 | GPU 占用 | renderer 帧率 | Paint 次数 |
|---|---|---|---|
| 基线（codes 页静置，动画开） | **3.3–4.4%**（几乎全在 3D engine） | 53.7 fps | 5360 次/10s |
| 仅禁用 `.ring-fg` 的 transition | **0–0.13%** | 1.1 fps | 80 次/8s |
| 进度环 `display:none` | **0%** | — | — |
| 恢复动画（回归确认） | 3.5–4.4% | — | — |

**仅一条 CSS（transition）就贡献了 ~97% 的 GPU 占用**；CPU 侧同理由渲染管线主导（JS 的 1s interval 每 10s 只花 13.5ms，可忽略）。占用随条目数线性放大：9 条目 ≈4%，30 条目估算 12–15%，大库 + 核显机型会显著更高。

两个减轻因素（现状已兜底，无需修）：
- 窗口被完全遮挡/最小化时，WebView2 的 occlusion 检测自动停渲染（实测 GPU→0），timer 同时被 Chromium 节流；
- 锁定态下 `NavigationShell` 卸载，codes 页 interval 随之停止。

## 测量方法

- 构建：`pnpm exec tauri build --no-bundle`（release 二进制 `src-tauri/target/release/totp-desktop.exe`）。
- 运行：`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9333"` 注入 CDP（应用自身 devtools 开关保持关闭，外部 env 优先）。
- GPU/CPU：Windows `GPU Engine(*)\Utilization Percentage` 性能计数器按进程树 pid 过滤（脚本 `.temp/perf/sample2.ps1`，预建 .NET PerformanceCounter，每 10s 重建实例防漂移）；CPU 用 `TotalProcessorTime` 差分对全机核数归一。
- 帧级：CDP `Tracing.start/end`（devtools.timeline），分析脚本 `.temp/perf/tracestat.py`；eval/切页脚本 `.temp/perf/cdp.mjs`。
- 注意事项（踩坑）：窗口被终端遮挡会让 WebView2 停渲染导致采样归零（首轮 B1/B2 数据因此作废）；采样期间用 `topmost.ps1` 把主窗置顶规避。counter 首轮 NextValue 无效需丢弃，重建实例表会产生单样本 0 值伪影。

## 帧级证据（trace，codes 页 10s）

| 指标 | transition 开 | transition 关（8s） |
|---|---|---|
| DrawFrame | 536 帧 = **53.7 fps** | 8 帧 = **1.1 fps** |
| Paint 事件 | 5360 次 / 152.8ms | 80 次 / 2.0ms |
| UpdateLayoutTree / Layerize / PrePaint | 各 536 次 | 各 8 次 |
| TimerFire（1s interval 的 JS 本体） | 10 次 / 13.5ms | 8 次 / 13.3ms |

即：**JS 每秒只工作 1.35ms，其余全部渲染开销由 transition 补间制造**。切页 trace（settings→codes）显示布局成本很小（6 次 Layout 共 23.2ms），切回后立即被动画接管（34.7 fps）。

## 根因链

1. `packages/ui/src/composables/useOtpCodes.ts:47` — `setInterval(recompute, 1000)`，每秒重算全部条目并整表替换 `codes.value`；
2. `packages/ui/src/components/OtpListItem.vue:124,148` — `:stroke-dashoffset="dashOffset"` 每秒变一次，`.ring-fg { transition: stroke-dashoffset 1s linear }` 将其补间成每帧变化；
3. `stroke-dashoffset` 不走合成器 → 每帧主线程 paint 全部可见环（9 条目 × 60fps = 每秒 ~540 次环重绘）；
4. 主窗 + mini 窗两个 WebView 共用此组件（`lib.rs:604-605` 启动即创建），mini 隐藏时不渲染（无 GPU 开销）但其 1s interval 持续空转；
5. 默认落地页即 `/codes`（`routes.ts:12`），打开即全速动画——与「开启页面时 GPU 高」的时序完全吻合。

## 修复建议

P0（改一行，收益 ~80–97%）：
- `OtpListItem.vue:148` 的 `transition: stroke-dashoffset 1s linear`：
  - 方案 a（保平滑感、省 ~85%）：改 `steps(6, end)` 或 `steps(10, end)`，每秒 6–10 次 paint；
  - 方案 b（省 ~97%）：去掉 transition，环每秒离散跳变（Google Authenticator / Aegis 均为此模式）；
  - 无论 a/b，顺手加 `@media (prefers-reduced-motion: reduce)` 禁用。

P1：
- `useOtpCodes` 在 `document.hidden`（主窗到托盘、mini 失焦自动隐藏时）暂停 interval，可见时恢复——省 CPU/电池（GPU 已由 occlusion 兜底）；
- mini 窗隐藏时同样停表（`MiniApp.vue:82`），消除双份空转。

P2（次级，量级小）：
- `codes.value = next` 整表替换改为原地更新（大库时 vnode diff 收益）；
- 每 ~30s 一次的单秒 CPU 脉冲（实测 18–20%，全机归一 ≈2 核秒）：自动备份 tick / 云同步轮询读盘解析的突发，摊薄 ~0.6%，无感知，暂不处理；
- 内存：进程树 ~460–530MB，mini 冻结（releasePolicy pause 档）可省 ~23MB，默认关闭维持现状。

## 数据附录（GPU % 全机归一，3D engine 为主）

```
C0_startup   启动后 0–19s   GPU 3.6–4.0  CPU ~1.0   WS 487→511MB
C2_notransition 禁 transition GPU 0–0.13  CPU ~0.1   WS ~497MB
C3_noring    环 display:none  GPU 0        CPU ~0.1   WS ~503MB
C4_minifrozen 恢复+mini 冻结  GPU 3.5–3.9  CPU ~1.0   WS 505→441MB
C5_recovered 全恢复           GPU 3.5–4.4  CPU ~0.9   WS ~464MB
```

原始数据：`.temp/perf/samples2.csv`（gitignore 内）；trace：`.temp/perf/trace_on.json`、`trace_off.json`、`trace_switch.json`。

## 修复实施与复测（2026-09-28 当日闭环）

裁定：P0 方案 b（去补间、看齐 Aegis）+ 顺手 reduced-motion；P1 按建议实施；次级项优化。
commit：`bae01cd`（渲染侧：OtpListItem 去 transition + CloudCard spinner reduced-motion）、`01bc717`（CPU 侧：useOtpCodes 窗口缓存 + hidden 停表 + 慢轮次防重入，三端共用组件直受益；新增行为测试 5 例，ui 1076 / desktop 339 / extension 287 全绿）。

复测（release 重构建，同口径采样）：

| 场景 | GPU 占用 | CPU | 此前 |
|---|---|---|---|
| codes 页可见 | **0–0.23%** | ~0.1% | GPU 3.3–4.4% / CPU ~1% |
| 主窗隐藏（托盘态） | ~0.1% | ~0 | — |
| 35s trace 主线程活动 | 1.7–5.9 ms/s，均匀无脉冲 | — | 每 30s 单秒脉冲 18–20% |

### 勘误与真机补充发现（修正上文报告）

1. **「codes.value 整表替换改原地更新」复核后无收益，未按原文实施**：Vue 响应式下 remaining 每秒必变，无论替换 Map 实例还是原地 set，全部行组件都必然重新求值，diff 量不变。改为实施 **HMAC 窗口缓存**（code 是「条目引用+窗口号」的纯函数，四类型均成立——totp/steam/yandex 按窗口取码、hotp 恒定）：每秒 CPU 从 O(N) 次 HMAC 降为仅窗口轮换条目重算，才是实质优化（commit 01bc717）。
2. **Tauri/WebView2 下 `document.visibilityState` 不随窗口 hide 变化（真机实测恒 `visible`）**：P1 的 hidden 停表对 desktop「隐藏到托盘/mini 失焦隐藏」场景不生效，代码保留（extension popup 等浏览器环境有效，且无害）。desktop 隐藏态的低成本实际由两层达成：WebView2 occlusion 停渲染（GPU，profile 已实测）+ 窗口缓存消掉 HMAC 大头（CPU，隐藏态实测 ≈0）。若后续要在 desktop 精确停表，需 Rust 侧窗口可见性事件传播（@tauri-apps/api v2 无 onVisibleChanged，MiniApp.vue 注释有同款记录）。
3. **30s CPU 脉冲已随 transition 移除消失**（修复后 35s trace 主线程 1.7–5.9ms/s 均匀、D1–D3 三轮采样无脉冲）：原脉冲系 30s 周期任务（调度 tick/备份 hash 等）触发整页失效重绘后，被 60fps 补间渲染管线放大成秒级峰值的表象，非独立性能问题，无需单独修。
