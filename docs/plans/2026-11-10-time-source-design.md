# 网络时间源校准 设计（2026-11-10）

## 背景与目标

用户场景（2026-11-10）：系统时间不准确导致 TOTP 验证码错误。TOTP 按 `floor((now-t0)/period)`
取 30s 窗口，时钟漂移是验证码失效的第一原因；服务器侧共识是「客户端校时」而非放宽验证窗口。

目标：时间源可配置——默认跟随设备时钟（现状，零行为变化），可选「网络时间」用校准偏移取码；
出码页与设置页提供「立即同步」入口；支持国内直连时间源（云厂商 NTP + 大站毫秒 API）。

平台范围：**桌面 + 扩展双端**（mini 窗/MCP/托盘经共享模块自动覆盖）。

## 事实基础（均已对源码核实，2026-11-10）

- **算法层已留缝**：`totp`/`steam`/`yandex`/`computeEntryCode` 全部显式收 `timeMs/nowMs`
  （`core/src/otp/totp.ts:3-11`、`entryCode.ts:18-23`），函数内不取时钟；`verifyTotp` 默认
  `Date.now()` 仅用于导入嗅探校验。Rust 无独立 TOTP 实现（MCP get_code 经事件桥转发前端执行，
  `mcp_server.rs:711` → `mcpBridge.ts:112`）。
- **取时调用点仅两类**：`packages/ui/src/composables/useOtpCodes.ts:42`（popup/options/桌面主窗/
  mini 四 UI 共用；recompute 内 `nowSec`/窗口缓存键 `counter` 均自 `nowMs.value` 派生，:44-49，
  取时点唯一）；`apps/desktop/src/mcpBridge.ts:54`（MCP get_code）。
- **设置体系**：`AppSettings`/`DEFAULT_SETTINGS`/`SETTINGS_VALIDATORS`
  （`core/src/storage/vaultStore.ts:113-199`，校验器缺行=编译错误）；浏览器同步整体覆盖 settings
  （`syncEngine.ts:116-135`）；云备份只携带 vault（`backup/envelope.ts:34`），不涉 settings。
- **设备本地键先例**：扩展 `storage.local` 独立键（`optionsPlatforms.ts:77-98` cloudAutoPrefs）；
  桌面 `localStorage`（`desktopPrefs.ts:47-117`），main/mini 双窗同 origin 共享。
- **网络通道现成**：扩展 `host_permissions` http(s) 全放行（`wxt.config.ts:33`）+ background SW
  fetch 先例（`cloudFetchHandler.ts:16-47`，仅放行本扩展 sender.id）；桌面 reqwest 0.13+rustls
  （`cloud_http.rs:127-172`），tokio `net` feature 已开（Cargo.toml:47）；UDP 零先例（可新增，
  `std::net::UdpSocket` 恒可用）。
- **反馈位**：Toast 模块级单例（`useToast.ts`）四宿主已挂；设置卡行内 `role="alert"` 先例
  （`SettingsPage.vue:256-261`）。
- **实测源可用性（2026-11-10 家庭宽带直连）**：
  - SNTP 可达且互相一致 ±3ms：`ntp.aliyun.com`（19-37ms）、`ntp.tencent.com`/`time1.cloud.tencent.com`
    （40-44ms）、`ntp.neu.edu.cn`（stratum-1，19ms）、`cn.pool.ntp.org`（41ms）、`time.windows.com`
    （129ms，海外兜底）。不可达：华为两域（DNS NXDOMAIN）、国家授时中心（UDP 超时）、清华/中科大/
    上交（UDP 超时，校园网环境可命中）、`time.apple.com`（丢包）。
  - HTTPS：`acs.m.taobao.com/gw/mtop.common.getTimestamp/`（毫秒 `data.t`）与
    `f.m.suning.com/api/ct.do`（毫秒 `currentTime`）动态生成可用；baidu/qq/gitee/jd/zhihu/12306
    HEAD `Date` 头新鲜（秒级）；**`www.taobao.com` HEAD `Date` 头滞后 43s（上游 CDN 缓存）且
    query cache-buster 无法绕过——剔除该形态**；`www.cloudflare.com/cdn-cgi/trace`（`ts=` 秒浮点）
    作海外兜底（无代理设备自然超时跳过）。
  - 教训：搜索清单不可尽信（华为/授时中心别名已死）；毫秒 API 天然免疫 CDN 缓存，排最前。

## 设计

### §1 数据模型与存储分层

- **`AppSettings.timeSource: 'device' | 'network'`**（默认 `'device'`）——进 settings、随浏览器
  同步跨设备统一（用户裁定）。校验器宽进：非 `'network'` 一律归 `'device'`。
- **`TimeSyncState`**（设备本地键 `timeSyncState`，不进备份/同步/浏览器 sync）：

  ```ts
  interface TimeSyncState {
    v: 1
    offsetMs: number | null        // 校准偏移（=网络时间-设备时间）；null=从未成功
    syncedAt: number | null        // 上次成功校准时刻（设备时钟 ms）
    sourceId: string | null        // 上次成功校准来源 id
    lastAttemptAt: number | null   // 上次尝试时刻（成败均记；退避依据）
    lastAttemptFailed: boolean     // 上次尝试失败标记
    preferredSourceId: string | null // 用户首选源；null=自动（内置顺序）
  }
  ```

  扩展存 `storage.local['timeSyncState']`（JSON，与 vault/settings 同 adapter）；桌面存
  `localStorage['timeSyncState']`（desktopPrefs 同款模式）。偏移量属设备属性，必须本地化——
  放 AppSettings 会被浏览器同步整体覆盖、且时钟环境本就随设备走。

- **取码时间**：`effectiveNowMs() = Date.now() + offset`（仅 `timeSource==='network'` 且
  `offsetMs !== null` 时加偏移；否则纯设备时间）。**出码永不等待网络**：任何时刻偏移取
  「上次成功校准值」，校准一律后台事务；未成功过（offset=null）时 network 模式回退设备时间。

### §2 core 模块与 ui 单例

- **`core/src/time/timeSync.ts`**（纯函数 + 常量，无 IO）：
  - 常量：`TIME_SYNC_STATE_KEY='timeSyncState'`、`TIME_SYNC_TTL_MS=6h`、跳变阈值
    `CLOCK_JUMP_BACKWARD_MS=5s` / `CLOCK_JUMP_FORWARD_MS=60s`（勘误 2026-11-11：原
    `CLOCK_TICK_MAX_GAP_MS` 随 §3-④ 勘误删除）；
  - `HTTPS_TIME_SOURCE_IDS=['taobao-api','suning-api','baidu','qq','gitee','jd','cloudflare-trace']`、
    `NTP_TIME_SOURCE_IDS=['aliyun','tencent','tencent-time1','neu','cn-pool','tuna','windows']`
    （id 清单 core 单一事实源，URL/解析在端实现，i18n label 在 ui）；
  - 纯函数：`normalizeTimeSyncState`（逐位宽容归一，与 loadSettings 同口径）、
    `shouldAutoCalibrate(state, networkMode, deviceNowMs)`、`clockJumpKind(prevMs, nowMs)`、
    `computeOffsetMs(serverMs, t0, t1)`（NTP 中点公式 `server - (t0+t1)/2`）。
- **`ui/src/timeSource.ts`**（模块级单例，useToast 同款装配模式）：
  - `initTimeSync(deps)`：deps = `{ load, save, isNetworkMode, calibrate(preferred) }`；
    bootstrap 异步装载本地键；未安装时 `timeSource()` 返回降级实例（offset 恒 0，测试/未接线
    上下文零影响）。
  - `state: shallowRef<TimeSyncState>`（引用替换驱动 watch）、`syncing: ref<boolean>`；
  - `effectiveNowMs()` / `noteDeviceTick(deviceNow)`（跳变判定 + TTL 决策 + 静默重校，均仅
    network 模式生效；勘误 2026-11-11：`maxGapMs` 参数随 §3-④ 勘误删除）/ `calibrateNow(opts?)`（手动/切换模式，失败 throw
    供调用方 toast；state 更新 + 落盘）/ `ensureAutoCalibrate()`（上下文激活入口，幂等互斥）。
- **出码接线（两处调用点）**：`useOtpCodes.recompute` 每秒 `noteDeviceTick(Date.now())` 后
  `nowMs.value = timeSource.effectiveNowMs()`（缓存键自 nowMs 派生自动一致）；`watch(timeSource.state)`
  偏移变化立即重算；`mcpBridge.ts:54` 同换。

### §3 刷新策略（TTL 与触发时机，已与用户确认）

| # | 触发点 | 行为 |
|---|---|---|
| 1 | 手动「立即同步」 | 唯一阻塞式入口，结果 toast（成功：偏差+来源；失败：错误提示），无视退避 |
| 2 | 模式切到 network | 无有效偏移时立即校准（设置卡切换处触发，允许等待反馈） |
| 3 | TTL 超龄（6h） | 上下文激活静默后台重校：popup/options 打开、SW 消息唤醒、桌面 boot、每秒 tick、mini 聚焦重载。勘误 2026-11-11：**冷启动入口（ensureAutoCalibrate，上下文全灭后首次激活）用收紧 TTL 10 分钟**，每秒 tick 运行期路径保持 6h——覆盖「上下文全灭期间系统校时」的冷启动盲区（无 tick 可观测跳变，旧 offset 最长错 6h）；`shouldAutoCalibrate` 加 `ttlMs` 参数（默认 6h 保持运行期语义） |
| 4 | 时钟跳变 | 每秒 tick 检测：回退 ≥5s 或前跳 ≥60s 触发（仅 network 模式）→ 静默重校，出码先用旧 offset。勘误 2026-11-11：原「前跳须采样间隔 ≤5s、长间隔=休眠恢复不判」条件删除——墙钟差=正常间隔+跳变幅度，双采样下不可分（原条件使前跳永不可判）；休眠恢复因此多触发一次无害校准，宁可误判不可漏判（漏判外部拉准会让偏移持续错误） |
| 5 | 校准失败 | TTL 内不自动重试（防每次打开 popup 打一串失败请求），保留旧 offset + 设置卡提示；手动随时可重试。勘误 2026-11-11：退避约束覆盖**全部自动路径**——「offset 非 null 且超龄」分支同样受退避（TTL 过后首试失败 → 退避 ttlMs → 期满再试）；回拨路径同（「首试失败且 lastAttemptAt 早于 syncedAt」为持久回拨见证，判陈旧并受同一退避，恢复延迟收敛至 ttl）。跳变触发的间隔守卫已裁定撤销（R16-revoked）：「每次恢复一轮校准」为已知行为——在线时恢复重校让偏移更准，离线时后台失败不阻塞出码，频率以恢复间隔为上限 |

TTL=6h 依据：正常钟晶振漂移每天 1-2s，烂主板可达每天 30s；24h TTL 下烂钟两次校准间可漂 30s
踩 TOTP 窗口边界，6h 压到 ~8s；代价每天最多 4 次请求且仅上下文活跃时发生。

### §4 扩展端

- **`apps/extension/src/timeSyncCalibrator.ts`**（background 承载）：源表 7 项按内置序（§2 id
  清单），每源 `{ id, url, method: 'GET'|'HEAD', parse }`；`t0=Date.now()` → fetch（
  `cache:'no-store'`）→ `t1` → parse → `computeOffsetMs(serverMs, t0, t1)`。单源 5s 超时
  （AbortController），总体 12s 上限；首选源排最前、失败按内置序兜底；全败 reject。
- **消息通道**：popup/options → `sendMessage({type:'time-sync-calibrate', preferred})` →
  SW 校准 → `{ok:true, offsetMs, sourceId}` / `{ok:false}` 回传（sender 校验同 cloud-fetch 口径）。
- **安装点**：popup/main.ts、options/main.ts 各装 ui 单例（unlock 窗不装：无出码列表，解锁自关）。

### §5 桌面端

- **`src-tauri/src/time_sync.rs`**：SNTPv4 客户端（48B 包构造 LI=0/VN=4/Mode=3，transmit
  timestamp 后 8 字节，1900→1970 纪元换算）+ 池 racing（tokio spawn 全池并发，单查询 4s 超时，
  取首个有效响应；`preferred` 参数置顶该源仍全池兜底）；HTTPS 降级 reqwest GET 毫秒 API
  （勘误 2026-11-11，plan24 落地裁定：原拟 baidu→qq `Date` 头，但 Rust 侧无 RFC7231 日期解析
  依赖——改用与扩展端同 id 的 taobao-api→suning-api 毫秒 API，serde_json 解析，降级源 id 跨端
  一致；rustls 校验系统时间——UDP 全断时降级，时钟严重错误时降级失败属可接受边界，SNTP 不经
  TLS 恰为主路径）。命令 `time_calibrate(preferred: Option<String>) -> Result<{offset_ms, source_id}>`。
- **前端安装**：desktopShell 双窗 boot 后安装 ui 单例（localStorage IO 包装 + invoke calibrator）；
  `mcpBridge.ts:54` 换 `effectiveNowMs()`。主路径 SNTP 不受 TLS 时间边界限制（时钟错几年也能校准）。

### §6 UI

- **SettingsPage 时间源卡**：模式选择（设备时间/网络时间，radio 同款交互）；network 展开：
  首选源下拉（「自动（内置优先级）」+ 平台源列表——`showDesktop` 区分 NTP/HTTPS 两组 label）+
  「立即同步」按钮 + 状态行（从未同步 / 上次同步时刻+来源+当前偏差与方向 / 上次失败提示，
  `role="alert"` 先例）。切换模式到 network 且无有效偏移时触发 §3-②。
- **出码页立即同步按钮**：CodesPage `.card-head`（标题行「选择」钮旁）与 popup `.header-ops`
  （齿轮旁）——MdIconButton sync 图标，**仅 `settings.timeSource==='network'` 渲染**，与现有
  按钮齐平不增行（用户裁定）；点击 `calibrateNow()` + toast 反馈，syncing 时图标旋转。
- **图标**：`iconPaths.ts` 增 sync path（Material Symbols sync）。
- **i18n**：zh/en 双份同步新增 `settingsPage.timeSource*`、`codesPage.syncNow`、`popup.syncNow`
  与 toast 文案键；`check-i18n-keys.mjs` 守卫兜漏。

### §7 边界与不变量

- device 模式：零网络请求、零行为变化（回归面=零；未安装 timeSource 的上下文经降级实例同样零影响）。
- 校准失败/超时/全源不可达：恒回退设备时间出码（不阻塞、不出 INVALID）。
- **不接偏移的计时**：锁定策略（lockPolicy）、剪贴板清除延迟、备份调度——安全/调度计时用设备
  时钟语义，不被网络数据改写；`verifyTotp` 导入嗅探校验保持现状（服务端真实时间未知）。
- 锁定态：settings 内存可读；出码 UI 被锁屏覆盖，无特殊处理。
- MV3 SW 休眠无损：offset 已持久化，消息唤醒即决策点（§3-③）。
- HOTP 不受影响（counter 语义无时间）；steam/yandex 经 `computeEntryCode` 自动受益。

### §8 测试

- **core**：`shouldAutoCalibrate`（TTL/退避/病态归一）/ `clockJumpKind`（回退/短间隔前跳/长间隔
  不判）/ `computeOffsetMs` / `normalizeTimeSyncState`；settings 校验器行。
- **ui**：`timeSource` 状态机（校准成功/失败退避/保存/降级实例）；`useOtpCodes` 偏移注入与窗口
  缓存键一致（`vi.setSystemTime`）；SettingsPage 时间源卡交互；CodesPage/popup 按钮条件渲染。
- **扩展**：calibrator 源序/首选源置顶/单源超时/总体上限/三种 parse（mock fetch）。
- **桌面**：Rust SNTP 包构造/解析/纪元换算/偏移公式单测；前端接线（mock invoke）。
- **e2e**：`docs/e2e-test.md` 增时间源场景（桌面真机：模式切换+出码生效+立即同步+断网回退；
  扩展：popup 按钮+设置卡+SW 通道）；批次清单 `docs/e2e/2026-11-10-time-source-checklist.md`。
