# 云备份 CORS 规避、每源代理与保留天数 设计（2026-09-30）

## 背景与目标

云备份五个后端（webdav / s3 / gist / gdrive / onedrive）的全部 HTTP 请求由网页层直接 `fetch`：唯一出口 `packages/core/src/cloud/backend.ts:101` 的 `cloudFetch`，扩展 manifest 无 host_permissions、background 不出网，桌面端无任何原生网络通道——跨源请求被 CORS 全量拦截（坚果云 WebDAV 实测复现）。

**裁定（用户 2026-09-30）**：方案 A——core 单点可注入 + 扩展 background 代理 + 桌面自写 Rust command；同时追加三项：

1. 文档说明扩展为何申请全量 host 权限；
2. 每个云源可配置**网络代理**（http / https / socks5 / socks5h / 系统代理）；
3. 保留策略在「保留最近 n 份」基础上增加「最近 n 天」：**两条件都不满足才删除**；本地备份同步支持。

## 一、core 网络出口可注入

`cloudFetch` 保持模块级单点，改为可替换实现：

```ts
// backend.ts
let fetchImpl: CloudFetch = globalThis.fetch
export function setCloudFetch(impl: CloudFetch): void  // 宿主启动时注入
```

- 默认仍为全局 `fetch`：core 单测、未注入宿主行为零变化。
- 五 provider 与 OAuth token 刷新（`oauthRefresh.ts` 的 `createAuthFetch` 闭包底层同样走 `cloudFetch`）自动全覆盖，provider 业务逻辑零改动。

### 每源代理的透传

`cloudFetch` 增加第三参 `proxy?: CloudProxy`（`{ mode: 'none' | 'system' | 'custom'; url?: string }`），各 provider 在调用处透传 `cred.proxy`；`createAuthFetch(cred)` 闭包捕获并透传。宿主注入的实现按此参数路由。页面层直接 `fetch` 时忽略该参数（扩展端代理见下）。

## 二、扩展端（apps/extension）

### host_permissions 与 background 代理

- `wxt.config.ts` 增加 `host_permissions: ['http://*/*', 'https://*/*']`。
- `background.ts` 新增消息代理：`{ type: 'cloudFetch', url, method, headers, bodyB64, requestId }` → SW 内 `fetch`（有 host_permissions 即不受 CORS 限制）→ 返回 `{ ok, status, statusText, headers, bodyB64, error? }`。二进制体 base64 编解码；页面端用 `new Response(body, { status, statusText, headers })` 重建真 `Response`（`ok/status/arrayBuffer/text/json` 天然正确）。
  > 裁定（2026-10-01）：消息类型以实施计划为准，采用 'cloud-fetch'。
- 页面端注入 `setCloudFetch(backgroundProxiedFetch)`：popup/options 全部云请求经 background。S3 SigV4 签名仍在页面层算好、代理只转发 headers，签名逻辑不动。
- MV3 SW 生命周期：请求进行中 SW 存活（分钟级内安全）；不做 keepalive，超长上传出现再补。扩展端 background fetch 统一 60s 超时（与桌面 DEFAULT_TIMEOUT_MS 对齐），由实现层补齐（2026-10-01 补充）。
- README（中/英）权限说明节写明理由：扩展需对用户任意配置的 WebDAV/S3/OAuth 端点出网，浏览器对页面层 fetch 施加 CORS，因此请求统一经 background（host_permissions 是其出网前提），故申请全站 host 权限；数据仅在备份往返中使用。

### 扩展端每源代理的限制

浏览器扩展无法 per-request 指定网络代理（`chrome.proxy` 仅全局）。云源卡的代理配置在扩展端**展示但禁用**，附说明「仅桌面版生效；扩展端请配置浏览器/系统代理」。

## 三、桌面端（apps/desktop）

### 自写 Rust command（不用 tauri-plugin-http：其 JS fetch 不支持 per-request 代理）

`src-tauri` 新增 `cloud_http_fetch` command：

- 入参：`{ url, method, headers, bodyB64, proxy: { mode: 'none'|'system'|'custom', url? } , timeoutMs? }`。
- 实现：`reqwest::Client`（启用 `socks` feature 支持 `socks5://` / `socks5h://`；`Proxy::all(url)` 解析 http/https/socks5(h) scheme）。`mode: 'system'` = reqwest 默认环境代理行为（HTTP_PROXY/HTTPS_PROXY/ALL_PROXY）；`custom` 且 url 非法 → 返回结构化错误。
- Client 按 `(mode, url)` 键缓存于 `Mutex<HashMap>`，避免每请求重建连接池。
- 超时默认 60s（`timeoutMs` 可覆盖）；返回 `{ status, headers, bodyB64 }`；网络错误映射为结构化错误（含 reqwest 错误分类）。
- desktop 宿主（`cloudPlatforms.ts`）注入 `setCloudFetch`：构造 `Response` 同扩展端，proxy 参数逐请求带给 command。

### 云源代理 UI

`CloudCredFields.vue` 各后端统一追加代理配置行：下拉（直连 / 系统代理 / 自定义）+ 自定义时 URL 输入（支持 `http://` `https://` `socks5://` `socks5h://`）。存入 CloudCred（`proxy` 字段），随 secretBag 加密持久化，走现有 `saveCred` 通道，无新存储路径。

## 四、保留策略：n 份 + n 天

### 类型与语义

`packages/core/src/backup/sources.ts`：

```ts
type Retention = { type: 'overwrite' } | { type: 'keep'; n: number; days?: number }
```

- `n ≥ 1`（整数，默认 1=现「保留最近」行为）；`days ≥ 0`（整数，**缺省/0 = 忽略天数条件**），向后兼容旧持久化数据（无 days 字段 = 0）。
- 删除条件（keep 名单内，严格 `BACKUP_NAME_RE` 才参与，overwrite/conflict 名永不滚动删除——现状不变）：**超出 n 份 且 超过 n 天**（`days > 0` 时天数条件才生效），两条件同时不满足才删。
  > 勘误（2026-10-01）：原文「同时不满足才删」系笔误，正确语义为「两条件都满足才删」，实现与测试均按此执行。
- 文件年龄由文件名时间戳（`vault-YYYYMMDD-HHMMSS`）解析，`ageDays = floor((now - ts) / 86400s)`；名单本就只含可解析时间戳的严格名，无歧义。

### 核心改动

- `policy.ts` `selectBackupsToKeep(names, keep, days?)`：days 维度过滤（`days` 缺省/0 时行为与现状逐字节一致，现有单测不破）。
- 消费点透传：本地 `apps/desktop/src/backupService.ts:152`（`retention.days`）；云端 `packages/core/src/cloud/retention.ts:26`（keep 来源处带 days）。

### UI 与 i18n

- 云源保留设置（`CloudCard.vue` 保留策略行）与本地备份源保留设置（`packages/ui` LocalSourceView）各追加「保留天数」数字输入：默认 0，min 0，说明「0 = 不限天数；份数与天数任一满足即保留」。
- 中英 i18n 同步。

## 五、测试

- core：`selectBackupsToKeep` days 边界（days=0、ageDays 恰等于 days、跨月/跨年、n 与 days 交叠）；`Retention` 旧数据无 days 字段兼容。
- 扩展：background 代理单测（b64 往返、`Response` 重建、非 2xx、网络错误结构化）；注入后 provider 冒烟（mock SW 消息）。
- 桌面 Rust：`cloud_http_fetch` 单测（b64 编解码、Client 缓存键、非法 proxy url 错误、超时参数）；代理真连列为真机清单。
- 真机验证清单：坚果云 WebDAV（扩展 background 代理 + 桌面直连）、socks5h 代理上传/列/删、GDrive OAuth token 刷新走新通道、PROPFIND 列目录、保留天数滚动删除实际触发。

## 非目标

- 扩展端 per-request 网络代理（浏览器平台限制，文档引导浏览器/系统代理）。
- MV3 SW keepalive 心跳。
- 上传分片/断点续传。
- 路径预览（bounded 项②，独立实施，不入本 spec）。
