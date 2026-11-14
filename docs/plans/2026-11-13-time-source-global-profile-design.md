# 网络时间源 全球链与源链剖面 设计（2026-11-13）

## 背景与目标

用户场景（2026-11-13）：时间源特性（plan24）落地后，预置的 NTP / HTTP 源几乎都是大陆直连可达的
（阿里云 / 腾讯云 / 东北大学 / NTP Pool 中国区 / 清华 / 淘宝 / 苏宁 / 百度 / Gitee / 京东…），
海外用户命中这些源会逐个超时——一轮 fallback 链走完即失败，无法校时。

目标（用户裁定）：

1. 再加一批**全球适用**的源（NTP + HTTP）；
2. 准备**两条 fallback 链**——**语言为中文时用现有链，其他语言用国际链**；
3. 修一个漏项：桌面 mini 窗右上角漏加「立即同步」按钮。

## 事实基础（2026-11-13 本机实测，已对源核实）

- **NTP 池（UDP 123，node dgram 直探，stratum 与互相偏差）**：
  - 可达且互相一致（各源相对本机钟差 -405~-427ms，两两差 ≤22ms，即源间一致度 ±15ms 级）：
    `pool.ntp.org`(s2)、`time.cloudflare.com`(s3)、`time.apple.com`(s1)、
    `time.nist.gov`(s1)、`ntp.nict.jp`(s1)、`europe.pool.ntp.org`(s2)、
    `asia.pool.ntp.org`(s2)、`ntp.ubuntu.com`(s2)；
  - 不可达：`time.google.com`、`ntp.microsoft.com`、`time.windows.com`（CN 链路超时，CN 链保留
    `windows` 作海外兜底不变）、`ntp.pool.ntp.org`。
- **HTTPS 端点**：
  - `https://timeapi.io/api/time/current/zone?timeZone=UTC` → JSON 组件
    `{year,month,day,hour,minute,seconds,milliSeconds,…}`，请求 UTC 即组件为 UTC，毫秒精度、动态生成；
    注意 `dateTime` 串**无时区后缀**，故按组件换算而非解析串；HEAD 返回 405（必须 GET）。
  - `https://www.cloudflare.com/cdn-cgi/trace` → `ts=<秒浮点>`（anycast，动态，秒级精度）。
  - `https://cp.cloudflare.com/generate_204` → `Date` 头新鲜（实测与本机差 2s，204 无缓存设计）。
  - `https://www.microsoft.com` → `Date` 头新鲜（差 2s）。
  - `https://worldtimeapi.org/api/timezone/Etc/UTC` → 连接被重置（不可用，剔除）。
- **Date 头新鲜度教训**：`https://www.apple.com` 的 `Date` 滞后 **542s**（`Age: 542`，CDN 缓存）。
  故 Date 头源只作链末位兜底，动态源（毫秒 API / trace）在前——沿用 2026-11-10「淘宝 HEAD Date
  滞后 43s」的同源教训（spec §事实基础）。
- **缓存证据盘点（2026-11-13 实测各源响应头）**：`gitee.com` → `s-maxage=60, stale-while-revalidate=120`、
  `jd.com` → `max-age=120` + `Age: 1`（**两者的 Date 头可滞后数十秒~数分钟**）；
  `baidu.com` → `private, no-cache, no-store`（新鲜）、`cp.cloudflare.com/generate_204` → 无缓存头、
  `www.microsoft.com` → `max-age=0, no-cache, no-store`（新鲜）、`timeapi.io` / 淘宝毫秒 API → 无缓存头、
  Cloudflare trace → `Expires: 1970`（等效不缓存）。→ 缓存护栏（§3）。
- **RTT 偏置教训（2026-11-13 真源探针，两轮独立复现）**：HTTP JSON 接口与 Date 头的时间戳在
  **响应构建时**生成，而中点公式（`server - (t0+t1)/2`）假设服务端时刻落在请求/响应中点——
  origin 排队数秒再出响应时该假设失效：实测 `timeapi.io` 与 `cp.cloudflare.com/generate_204`
  在 RTT≈8.1s 时偏置 **+3.9~4.1s**（两源同量级），而在 RTT≈0.2s 时偏置仅 **+3~11ms**。
  残差偏置 ≤ RTT/2 → 故设「可采信 RTT 上限 800ms」（§3 护栏），慢应答不采信。
  另注：Cloudflare trace 的 `ts` 是**整秒**（`…708.000`），即秒级量化（±500ms），但新鲜不缓存
  （连续三次请求 ts 逐次递增，`cf-cache-status`/`age` 均无）。
- **真源走查（经 Rust 实际代码路径，临时探针，已移除）**：SNTP 池——大陆链命中 `neu`（36ms）、
  国际链命中 `nict`（86ms），两者偏移量相差 6ms（互相印证）；HTTPS 降级——大陆链命中
  `taobao-api`（85ms）、国际链慢 `timeapi` 被护栏拦下后落到 `cloudflare-trace`（2.6s）✓。

## 设计

### §1 剖面模型（core）

`packages/core/src/time/timeSync.ts` 新增：

- `type TimeSourceProfile = 'cn' | 'global'`；
- `normalizeTimeSourceProfile(raw)`：**仅** `'global'` 归国际链，其余（含非法值）回大陆链
  （宽容归一口径同 `normalizeTimeSyncState`；未知值不放宽成国际链）；
- 源 id 清单拆四份（id 单一事实源仍在 core，URL/解析在端实现，label 在 ui）：
  - `HTTPS_TIME_SOURCE_IDS_CN`（原 7 项，**原样保留**）、
    `HTTPS_TIME_SOURCE_IDS_GLOBAL`（4 项）；
  - `NTP_TIME_SOURCE_IDS_CN`（原 7 项，**原样保留**）、`NTP_TIME_SOURCE_IDS_GLOBAL`（8 项）；
- `httpsTimeSourceIds(profile)` / `ntpTimeSourceIds(profile)`：按剖面取链。

两链 id 交集仅 `cloudflare-trace`（同 id 同 URL 同解析形态，语义无冲突；core 单测钉住）。

### §2 界面语言 → 剖面（ui）

`packages/ui/src/timeSource.ts` 新增 `timeSourceProfileFor(locale)`：

- 显式 `'zh'` → `'cn'`；显式 `'en'` → `'global'`；
- `'auto'` → 按**浏览器语言**（`/^zh/i`）：`zh*` → `'cn'`，其余 → `'global'`。

口径说明：`auto` 下界面文案按 i18n 规则回落中文（`resolveLocale`），但**源链按用户真实语言取**——
非中文浏览器环境用国际链更稳（大陆链源在境外常不可达/被限速），反之亦然。语言设置运行时可改，
剖面每次校准现取（即时生效，无需重启）。

> 勘误备查：若改为「按界面实际显示语言（回落后）判定」，则德语/日语浏览器会落到大陆链，与
> 「全球适用」目标相悖，故不取该口径。

### §3 源链构成

**扩展端（HTTPS，`apps/extension/src/timeSyncCalibrator.ts`）**：

| 链 | 序 | 源 | 形态 |
|---|---|---|---|
| cn | 1-2 | `taobao-api` / `suning-api` | 毫秒 API（JSON） |
| cn | 3-6 | `baidu` / `qq` / `gitee` / `jd` | `Date` 头 |
| cn | 7 | `cloudflare-trace` | trace 文本 |
| global | 1 | `timeapi` | 毫秒 API（组件 → epoch） |
| global | 2 | `cloudflare-trace` | trace 文本 |
| global | 3-4 | `cloudflare-204` / `microsoft` | `Date` 头 |

**桌面端（`apps/desktop/src-tauri/src/time_sync.rs`）**：

- SNTP 池（主路径，池 racing）：cn = 原 7 项；global = `time-cloudflare` / `pool` / `time-nist` /
  `time-apple` / `nict` / `europe-pool` / `asia-pool` / `ubuntu`；
- HTTPS 降级（SNTP 全败后）：cn = `taobao-api` / `suning-api`（毫秒 API）；global = `timeapi` /
  `cloudflare-trace` / `cloudflare-204` / `microsoft`。

解析形态按源定制（Rust 侧 `ParseKind`）：`JsonMillis`（淘宝 `data.t` / 苏宁 `currentTime`）、
`JsonCivil`（timeapi 组件）、`TraceTs`（trace `ts=`）、`DateHeader`（RFC7231 `Date`）。

**Rust 侧就地实现 RFC7231 Date 解析**（`parse_http_date` + `days_from_civil` + `civil_to_epoch_ms`）：
2026-11-10 的设计以「无日期解析依赖」为由回避 Date 头源（spec §5），现国际链需要 Date 头兜底，
遂就地手写实现（**零新增依赖**，不引 chrono/httpdate），并以单测锁定格式与闰年锚点。

**RTT 护栏（两端同口径）**：core `HTTPS_TRUSTED_RTT_MS = 800` / `isTrustedHttpRtt(rttMs)`，
Rust 侧 `HTTPS_TRUSTED_RTT_MS` + `rtt_trusted(rtt_ms)`。HTTP 源的应答 RTT 超过上限即**不采信**
（该源兜底下一源）：origin 排队数秒时中点公式的残差偏置可达 ±RTT/2（实测 RTT 8.1s → +4.0s），
慢应答宁弃勿采——宁可换源，也不可采纳一个错几秒的偏移（错 4s ≈ 每 30s 窗口有 8s 取错码）。
SNTP 不受此限（协议自带精确时戳与 RTT 补偿），桌面主路径不受影响。
*口径说明*：客户端实测 RTT 含 DNS/TCP/TLS 建连与读体时间，而偏置只取决于**服务端处理延迟**
（`bias ≈ (服务端处理 − 传输)/2`）——故该护栏**保守**：慢链路上可能误杀可用源（宁可换源，
不可采信坏值），最坏后果是本轮校准失败 → 回退设备时间（既有行为，无回归）。

**缓存护栏（两端同口径）**：应答若带**缓存证据**（`Age > 0` 或 `Cache-Control` 含正
`max-age`/`s-maxage`）即**不采信**（该源兜底下一源）——被 CDN 缓存过的应答，其 Date 头/JSON 时刻
可滞后数十秒起（实测 gitee `s-maxage=60+swr=120`、jd `max-age=120`），滞后量级足以让偏移错上百秒
（偏移被采纳后 6h 内出码错）。无缓存证据者（`no-store`/`no-cache`/`max-age=0`/无 Cache-Control）
照常采信。
*对大陆链的影响*：清单与源序**不变**（用户裁定「中文时用现在的」），只是运行时拒绝带缓存证据的
应答——即 gitee/jd 在其响应被 CDN 缓存时自动跳过（实测两者确实带正 TTL），大陆链实际可用源
收敛为 淘宝/苏宁毫秒 API → 百度 → Cloudflare trace（仍足够），且不再有「采纳滞后 Date」的隐患。

### §4 端实现接线（剖面谁判、谁传）

剖面判定需要**界面语言**，而扩展 SW / Rust 端都拿不到界面上下文（locale 在 settings，SW 不读
settings、Rust 无 i18n）——故判定留在前端，端侧只按传入值取链：

- 扩展：页面侧 `installExtensionTimeSync` 算剖面 → 消息
  `{type:'time-sync-calibrate', preferred, profile}` → background `normalizeTimeSourceProfile(msg.profile)`
  → `calibrateNetworkTime(preferred, profile)`；
- 桌面：`installDesktopTimeSync` 算剖面 → `invoke('time_calibrate', { preferred, profile })` →
  Rust `time_calibrate(preferred, profile)` → `profile_from`（仅 `'global'` 生效）。

**跨链 preferred**：用户在链 A 选了源，切语言到链 B 后该 id 不在 B 链内——端侧忽略它走内置序
（扩展 `sources.find` 跳过；Rust `pool_order` 只认本链 id）；设置页下拉显示「自动」，但**偏好值
本身保留**（切回原语言即恢复该首选源）。

### §5 UI

- **设置页**：首选源下拉按当前剖面列源（桌面 NTP 组 / 扩展 HTTPS 组）；状态行「来源 xx」label 表
  扩到两链全部 id（`SOURCE_LABEL_KEYS` + 12 个新 i18n 键，zh/en 双份）。
- **桌面 mini 窗（补漏）**：mini 只有出码列表，network 模式下无任何手动校时入口——标题栏右侧
  （同步钮 → 固定 → 收起）补「立即同步」按钮：仅 `settings.timeSource === 'network'` 渲染，
  在途禁用 + 图标旋转，结果走全局 toast 三态（落后 / 超前 / 已对齐 / 失败）。
  取词用壳层 `tr`（mini 的 i18n 插件随 boot 异步装入，setup 同步段取不到 `useI18n`）→
  `useTimeSyncAction` 增可选注入取词函数；同时把该 composable 改为**每次现取 `timeSource()` 单例**
  （原实现在 setup 期捕获实例，会拿到 mini 聚焦重载前的降级实例 → 校准恒败）。

### §6 边界与不变量

- **大陆链零变化**：中文用户（含显式 zh / auto+中文浏览器）走原链、原源序、原解析，行为与
  2026-11-10 实测基线一致；原 id 清单与 label 不删不改（只新增国际链项）。
- **校准失败恒回退设备时间**：两链均如此（spec §7 不变量不变）；剖面只改「试哪些源」，不改失败语义。
- **不新增依赖**：Rust 侧 Date 解析就地实现；TS 侧用内置 `Date`/`Date.UTC`。
- **出码永不等待网络**：剖面切换不改变取时路径（`effectiveNowMs` 不变）。
- **零新增网络面**：源表是白名单常量，无用户输入拼接；`preferred` 仍只作置顶 hint（不在链内即忽略）。
- **偏移量仍属设备本地**：`TimeSyncState` 不变（剖面不入状态——它是派生量，语言变了自然重选链）。

### §7 测试

- **core**：四份源 id 清单顺序、两链 id 交集仅 `cloudflare-trace`、`normalizeTimeSourceProfile`
  宽容归一、按剖面取链（`packages/core/test/timeSync.test.ts`）。
- **ui**：`timeSourceProfileFor` 三档判定（显式 zh/en + auto 按浏览器语言）；
  设置页首选源下拉按剖面切换、跨链 id 显示 auto 且偏好保留（`SettingsPage*.test.ts`）。
- **扩展**：校准器国际链序（timeapi → trace → 204）、组件解析、跨链 preferred 被忽略、cn 链不受影响；
  **RTT 护栏**：慢应答（>800ms）不采信 → 兜底下一源；消息带 profile、background 归一
  （`timeSyncCalibrator.test.ts` / `background.test.ts` / `timeSyncInstall.test.ts`）。
- **桌面（Rust）**：池按剖面选择、剖面归一、两链 id 不重叠、`days_from_civil` 闰年锚点、
  `civil_to_epoch_ms` 越界/不存在日期拒绝（31 Feb）、JSON/trace/Date 四种解析形态、Date 头畸形拒绝、
  `rtt_trusted` 边界、`cc_has_positive_ttl` 缓存指令判别。
- **桌面（前端）**：invoke 带 `profile`（随界面语言）；mini 同步钮渲染条件 / 点击校准 / 失败 toast。
- **单例响应性**：ui `timeSource` 单例改由 `shallowRef` 持有——宿主覆盖安装（桌面 mini 聚焦重载
  store 后再装一次）会换掉实例，普通变量替换不触发响应式，消费方（`useTimeSyncAction` 的 syncing
  computed、设置页状态行）会一直盯着被换掉的旧实例（旋转/禁用失效、状态行停在旧快照）；
  设置页改为每次现取 `timeSource()`，不再在 setup 期捕获实例。

### §8 未决与风险

- **Date 头源可能滞后**：链末位兜底（实测 apple.com 滞后 542s、taobao 43s）。若动态源全败而
  Date 头源恰好被 CDN 缓存，会采纳一个滞后的偏移——**已知风险**，故 Date 头源不排首位，且
  滞后量级（分钟级）会明显反映在设置页状态行的偏差值上，用户可「立即同步」重试换源。
- **国际链源的境外可达性未在境外实测**：本次实测网络出口在中国大陆（trace 显示 `colo=SJC`，
  但经代理出网）；国际链源均为全球公开服务的常规用法（NTP Pool / Cloudflare / NIST / Apple /
  NICT / Ubuntu），境外可达性以「公开服务常规用法 + 实测响应自洽」为依据，正式发版前建议
  在境外网络做一次真机走查（`docs/e2e/`）。
- **auto 口径**：`auto` 按浏览器语言而非界面回落文案判定（§2 勘误备查），若后续产品要求
  「界面显示什么语言就用什么链」，改 `timeSourceProfileFor` 一处即可（其余链路不动）。
- **RTT 护栏的取舍**：上限 800ms 是「残差偏置 ≤400ms」与「慢链仍可用」的折中——比 800ms 更严
  会拒掉部分境外可达源（更松则偏置逼近秒级）。实测境外/国内各源的常态 RTT 均在 200~600ms
  区间内，护栏只在 origin 异常排队时才生效。
