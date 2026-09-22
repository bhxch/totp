# 设计：同步体验优化（逻辑时钟 + 活动目标 + 三方合并）与 MCP 工具面扩展

## 背景与目标

当前云同步（`packages/core/src/cloud/` + `packages/ui/src/components/cloudRunner.ts`）存在七处
体验生硬点（头脑风暴阶段全链路梳理，均有源码证据）。本设计一次性修复其中六处，并为
MCP server 增加触发器工具与工具暴露面勾选。

**目标：**

1. 「该上传还是该下载」判定模型换成逻辑时钟版本号，判定过程对用户可见（三态）。
2. 多云目标引入「活动目标（primary）单选」，收敛裁决权可预测。
3. 冲突处理升级为条目级三方合并，不再整库「云端胜出」。
4. 冲突强提示：badge/横幅/冲突列表，废除后台突然弹文件下载。
5. 宿主内同步互斥（single-flight）、配置状态归位、逐源进度、GDrive/OneDrive OAuth 刷新。
6. MCP 新增 `trigger_backup`/`trigger_sync` 触发器工具（默认不暴露）+ 设置页工具暴露面勾选。

**非目标（明确不做）：**

- 扩展端后台（页面存活期之外）同步——用户裁定现状可接受，维持「options/popup 存活期调度」。
- 浏览器同步通道（`chrome.storage.sync`，`apps/extension/src/syncEngine.ts`）不动——它本就是
  rev LWW 模型，与云同步互不影响。
- 条目内字段级（field-level）合并；冲突粒度到条目为止。
- GDrive/OneDrive 内嵌公共 OAuth client；用户自建 client 填入凭据。

## 决策记录（头脑风暴批准）

| 决策点 | 裁定 |
|---|---|
| 方向判定模型 | 逻辑时钟版本号（rev + deviceId），UI 呈现「本地较新/云端较新/已同步」三态 |
| 同步源形态 | 活动目标单选：primary 裁决，replica 收敛复制 |
| 冲突算法 | 条目级三方合并（含共同祖先追踪），冲突条目出裁决列表 |
| MCP 触发器安全语义 | 默认不在暴露面；action 类工具非 token 档逐次确认，token 档放行 |
| 范围 | 七处中修 ①③④⑤⑥⑦；②（扩展端后台同步）不修 |

## 设计

### §1 同步内核：逻辑时钟版本号模型

#### §1.1 envelope v2 → v3

`packages/core/src/backup/envelope.ts`：`BackupEnvelope` 增加 `format: 3`，头部新增字段：

```ts
{
  format: 3,
  rev: number,          // 本信封的逻辑时钟，单调递增
  deviceId: string,     // 写入设备标识（本机首次同步时生成的持久 UUID）
  baseRev: number,      // 本端做上次收敛时的云端 rev
  baseContentHash: string, // baseRev 版本解密后 vault JSON 的规范化内容 hash
  // 其余 v2 字段（kdf 档位、wrappedDek、ciphertext 等）不变
}
```

`baseRev`/`baseContentHash` 是上传方声明的「共同祖先」指针，供对端校验三方合并前提。

#### §1.2 本端持久状态

StorageAdapter 新键（`packages/core/src/storage/vaultStore.ts` 注册），按 sourceId 一份：

```ts
interface CloudSyncState {
  lastKnownRemoteRev: number; // 上次见到的云端 rev
  baseSnapshot: string;       // 上次与本端内容收敛一致的完整 vault JSON（共同祖先快照）
  lastContentHash?: string;   // auto 通道持久化内容门（§1.3）
  primaryRev?: Record<string, number>; // replica 目标的 rev 记录（见 §2）
}
```

**静态保护**：`baseSnapshot` 是 vault 明文副本，启用库加密时必须以 DEK 加密落盘
（与 vault 密文同保护级），未启用加密时随 vault 同为明文；读取需解锁态。§3 的
`mergeConflicts` 记录含条目 secret，同样适用此规则。`deviceId` 同样持久本地（独立键，
首次同步生成 UUID）。锁定态不可写云的原则不变：状态写入随现有 `onCommitted`
落盘通道。

#### §1.3 方向判定（重写 `syncOrchestrator.ts`）

对 primary 目标，替换现有 sha256 字节摘要判定（含 `syncOrchestrator.ts:8-11` 勘误自认的
「in-sync 生产不可达」缺陷）：

```
拉取远端 envelope（网络失败 → 该源记 error，不重试风暴）
remoteRev == state.lastKnownRemoteRev 且 localVault == baseSnapshot → 已同步（零写）
localVault == baseSnapshot（本地未动）                              → 纯下载：采纳远端，
                                                                     base := 远端内容
remoteRev == state.lastKnownRemoteRev（云端未动）                   → 纯上传：rev := remoteRev+1，
                                                                     base := 本地新内容
其余（双方都动）                                                    → 三方合并（§3），
                                                                     合并结果 rev := remoteRev+1 上传
```

「本地较新 / 云端较新 / 已同步 / 需合并」四态返回给 UI，替代现在不可见的 hash 比对。

**内容门持久化**：auto 通道的 `lastAutoVaultHash`（`cloudRunner.ts:119-124` 实例内存级）改为
持久化「解密后 vault JSON 规范化序列化再 sha256」的内容 hash；未变零网络，页面重开不再
盲目全量推拉。规范化序列化 = 稳定键序 + 无空白，消除随机 IV/键序抖动。

> **勘误（终审 Fix2/I-2）**：「未变零网络」修正为「门命中 = 降级执行 pull-only 检查，而非全静默」。
> 理由 = 下载可达性：desktop 唯一云触发是 auto 通道，门命中若全静默短路（连 GET 都不发），
> 闲置端永远收不到对端变更，状态行记「内容未变」误导——与 §1.3 判定表「远端已变 → 下载/合并」
> 的双向同步设计矛盾。门命中时复用 pull-only 只读轮（零写云、远端基线去重、in-sync 零处理）；
> pull 轮不推门基线（与 pull 轮失败不推门语义一致），采纳使本地内容前进后门自然未命中，
> 下一轮完整推拉轮收敛并自愈刷新基线。

上传后保留「put 后 get 回读」校验（`syncOrchestrator.ts:76-93`），回读校验 `rev` 而非字节 hash。

#### §1.4 v2 兼容

读到无 `rev` 的旧 envelope：视为「无版本祖先」，走解密 + 内容比对保守路径——内容与本地
一致则仅刷基线（以 v3 回写）；不一致则本地内容存冲突副本（沿用现有 conflict 机制）后采纳，
并立即以 v3 格式回写。全链路一次同步后自然完成 v3 升级，无迁移工具。

### §2 活动目标单选

`BackupSource`（`packages/core/src/backup/sources.ts`）增加 `role: 'primary' | 'replica'`：

- 启用源中有且仅有一个 primary；添加第 2 个源默认 replica；UI 可切换，切换互斥
  （原 primary 自动降为 replica）。
- 存量单源用户无感：单源恒为 primary。
- 未启用任何源：无 primary，同步面板只提示添加源。

每轮同步流程（重写 `multiTarget.ts`）：

1. **primary 全量推拉**：按 §1.3 判定 + 合并，产出 `finalVault` 与 finalRev。
2. **replica 收敛复制**：逐个 replica——
   - 其 `rev` 与 `primaryRev[replicaId]` 记录一致且解密内容 == final → 跳过（零写）；
   - `rev` 与记录一致但内容不同（罕见：外部改写）→ 该目标现有内容先存冲突副本，再推平；
   - `rev` 比记录新（其他设备误把它当主目标写入）→ **先拉取该内容与本端做一次条目级
     三方合并，合并结果并入 final，再推平该目标**——任何误配置下不丢数据；
   - 推平 = 上传 final（`rev := 该目标 remoteRev + 1`），更新记录。
3. 失败语义不变：单目标失败不阻断其余目标（outcome + error），终局不刷新内容门基线。

### §3 条目级三方合并（core 纯函数，`packages/core/src/merge/`）

输入 `base / ours / theirs` 三份 vault JSON，条目身份 = `entry.id`：

| 情形 | 裁决 |
|---|---|
| 仅一方改/增 | 采纳该方 |
| 双方同改 | 任取 |
| 一方删、另一方未动 | 删除生效 |
| 一方删、另一方改 | 保留修改方，生成条目冲突记录 |
| 双方改成不同内容 | 取 `updatedAt` 新者为主体，另一方存入条目冲突记录 |

- 条目冲突记录：`{ entryId, issuer, label, ours, theirs, base }`，持久化本地
  （StorageAdapter 新键 `mergeConflicts`），供 UI 裁决列表消费；裁决动作 = 取本地方/取云地方，
  产生一次正常变更走同步通道。
- 非条目字段（settings、tags 等）同表规则；settings 冲突取 `updatedAt` 新者。
- **祖先校验与降级**：合并前校验远端 envelope `baseContentHash == hash(baseSnapshot)`；
  不匹配（新设备无快照等）→ 降级两方合并（双方条目并集、同 id 冲突取 `updatedAt` 新者），
  仍优于整库覆盖。
- **不阻塞上传**：合并结果（含未裁决冲突）照常 `rev+1` 上传，冲突留 UI 裁决。
- 手动通道在合并前出差异预览（§4）；自动通道静默合并 + 冲突强提示。

### §4 冲突强提示与副本落位（修③）

- **extension**：
  - 冲突副本不再后台触发浏览器下载（废除 `cloudRunnerFactory.ts:25-35` 的自动
    `a.click()`）。副本写入 `chrome.storage.local` 冲突列表（加密 envelope 原样存储，
    限保留最近 5 份，超出滚动删除）。
  - extension action badge 显示「!」；popup/options 顶部横幅「存在 N 条同步冲突」。
  - 冲突列表 UI：查看/逐条裁决/手动点击才导出 `.totpbackup` 文件。
- **desktop**：副本继续落 AppData backups 目录（已在备份恢复列表可见，
  `policy.ts:24` 已含 conflict 名）；应用内横幅 + 托盘 tooltip 计数。
- **裁决入口统一**：CloudCard 新增「冲突」区块（条目冲突裁决列表 + 冲突副本列表入口），
  替代现在仅一行「冲突已解决」小字的弱感知。
- badge/横幅在冲突全部裁决后自动清除。

### §5 其余修复

- **④ 宿主内互斥**：manual 与 auto 共用 single-flight 互斥（`cloudRunner.ts:11-13` 自认的
  并发口子）：手动到来时若自动在跑，排队等待合并执行，不并发。跨宿主（desktop 与
  extension 同时写云）不额外加锁，由 rev 模型天然裁决为合并。
- **⑤ 配置归位**：「云凭据失效」警示从 SyncCard 移到 CloudCard（修正
  `SyncCard.vue:111-116` 的语义错挂）；SyncPage 顶部新增「同步健康」摘要条
  （两通道状态汇总 + 指引链接）。卡片结构不做大改版，BackupSecretCard/CloudCard/SyncCard
  位置不变。
- **⑥ 进度指示**：同步进行中逐源显示 spinner 与「x/y 源完成」总进度；结果态沿用现有
  statusMap 文案（uploaded/downloaded/merged/in-sync/error）；多目标保持串行。
- **⑦ OAuth 刷新**：GDrive/OneDrive 凭据（`CloudCred`）新增可选 OAuth 模式字段：
  `clientId`/`clientSecret`/`refreshToken`（敏感字段入 DEK 保管区 secretBag，与现有
  凭据存储同通道）。任一请求 401 时自动以 refresh_token 换新 access_token（GDrive 走
  `oauth2.googleapis.com/token`，OneDrive 走 Microsoft identity platform），新 access token
  仅存会话内存。刷新失败（refresh_token 失效）→ 凭据失效语义同现状。保留现有手工
  access token 模式，凭据表单提供两种模式切换。

### §6 MCP：触发器工具 + 工具暴露面

#### §6.1 工具定义

`mcp_server.rs` 新增 `#[tool]` 方法，`mcpBridge.ts` 新增对应分支（沿用现有改动路径）：

- `trigger_backup`：触发一次全部启用本地目录源的备份（`createBackupToSources`）。
  参数：无。返回 `{ triggered: boolean, reason?: string }`。
- `trigger_sync`：触发一次手动通道云同步（`cloudSync.run('manual')`）。
  参数：无。返回 `{ triggered: boolean, reason?: string }`。

前置不满足时返回明确 reason，不猜测不重试：`vault locked` / `no backup secret` /
`no enabled sources` / `no primary target`。**绝不返回 vault 数据**。

#### §6.2 工具级安全标记与门控叠加

工具静态元数据表新增 `kind`：

| 工具 | kind | 默认暴露 |
|---|---|---|
| `list_accounts` | read | 是 |
| `get_code` | read | 是 |
| `trigger_backup` | action | 否 |
| `trigger_sync` | action | 否 |

门控规则叠加在现有四档（token/wildcard/exact/alwaysAsk）与首连审批之上：

1. 工具不在 `exposedTools` → `tool disabled` 错误（每请求重读配置，即时生效，与
   mode/whitelist 同模式）。
2. read 工具：现有门控行为完全不变（向后兼容）。
3. **action 工具**：token 档 → 直接放行（持有 token 即主人）；wildcard/exact/alwaysAsk 档 →
   **逐次桌面确认弹窗**（复用 `mcp://approval` 事件通道但为工具级、无 TTL，
   60s 超时 fail-closed；现有 5s 桥超时对确认场景延长为 60s）。
   无头模式下确认事件发往隐藏窗口 = 无人确认恒拒绝，符合现有无头设计裁定
   （应配 token 档）。

#### §6.3 暴露面配置与设置页

- `McpConfig` 增加 `exposedTools: string[]`，默认 `["list_accounts", "get_code"]`——
  存量用户行为零变化；`settings.json` 存储与读写路径同现有 `mcp` 键。
- `McpServerCard.vue` 新增「暴露工具」勾选组：`v-for + MdCheckbox`（参照
  `EntryForm.vue:429-435` 范式），action 工具行附「触发写操作，仅 token 档免确认」说明文案。
  勾选变更走 `mcp_set_config` 整体回写（即时生效）。
- 「只读边界」设计裁定在 `docs/plans/2026-09-21-mcp-server-design.md` 追加勘误段落：
  边界从「只读」放宽为「默认只读 + 用户显式勾选的 action 工具（更严门控）」。

## 错误处理

- 网络失败：单源 error，不阻断其余目标，不重试风暴（沿用现状）。
- rev 判定遇到回退（远端 rev < 本地记录）：以远端为准重置记录并走下载路径；
  同 DEK 谱系的 vault 回退仍由 `VaultRollbackError` 水位拦截（`securityStore.ts:42-52`），
  本设计不触碰该防线。
- 合并冲突记录损坏/超限（>100 条）：丢弃最旧记录，UI 提示不完整。
- OAuth 刷新失败：该源标凭据失效，自动跟随暂停（沿用现状语义）。
- MCP 触发器：所有前置不满足均结构化 reason 返回；确认超时 fail-closed。

## 测试策略

- **core 单测**：三方合并各分支（含删改冲突、双方同改、祖先不匹配降级、settings 取新者）；
  版本判定四分支；v2→v3 兼容路径；规范化内容 hash 稳定性（键序抖动不变）。
- **编排集成**：primary 裁决 + replica 推平；replica 领先时先合并再推平；单目标失败不阻断；
  内容门持久化（重开不重推）。
- **UI**：冲突列表组件裁决流、差异预览、进度态、暴露面勾选持久化。
- **MCP**：exposedTools 门控（disable 错误）、action 工具逐次确认与 60s 超时、
  token 档放行、`mcpBridge` 触发分支锁定态 reason、存量两工具行为不变。
- **E2E**：双 store 实例模拟两设备——收敛、并发写触发合并、冲突裁决后二次同步收敛。

## 验收口径

1. 两个设备同时改不同条目 → 下轮同步自动合并，双方条目都在，无整库覆盖。
2. 同一条目两设备改成不同内容 → 合并取新者 + 冲突列表可一键改选，裁决后二次同步收敛。
3. CloudCard 状态行可见「本地较新/云端较新/已同步」；同步中可见逐源进度。
4. 页面重开 + 内容未变 → 零云盘写请求（keep 源不再沉淀重复文件）。
5. 冲突发生 → badge/横幅出现，无自动文件下载；副本可从列表手动导出。
6. MCP 默认暴露面下 `trigger_sync` 返回 `tool disabled`；勾选后 wildcard 档逐次确认、
   token 档直接触发成功；未勾选原两工具行为与现状一致。
7. GDrive OAuth 模式下 access token 过期 → 自动刷新，同步不中断。
