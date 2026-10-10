# 云端源备份列表与管理动作 设计（2026-10-10）

## 背景与目标

本地源（桌面端 BackupCard）已具备「备份列表 + 按名恢复（两步覆盖确认）」的用户可见能力；云端源
的 `listBackups`/`listBackupsEx` 五后端齐备但仅内部消费（keep-n 滚动删除、keep 读最新份），无任何
用户可见列表与管理入口。本设计为云端源补齐对齐能力，并按用户裁定扩展两项本地源也没有的动作：

1. **列表**：每源列出远端时间戳备份（手动刷新，按需加载）；
2. **恢复**：从指定历史份整库替换本地（对齐本地 restoreByName + adopt 确认语义）；
3. **导出**：把云端某份密文原件下载存盘（本地源也没有，超越对齐）；
4. **删除**：手动删除指定云端备份（超越对齐；保留策略自动滚动删除之外的补充）。

平台范围：**桌面 + 扩展双端**（两端云网络层与存储层条件均已具备）。

## 事实基础（均已对源码核实，2026-10-10）

- 五后端 `listBackups` 全部实现且名单域与 `delete`/`get` 同域：webdav/s3/onedrive 返回 `dir/name`
  完整路径（`webdav.ts:88`、`s3.ts:179`、`retention.ts:24-26` 的 basename 映射注释），gist/gdrive
  返回裸名；口径统一 `BACKUP_NAME_RE`（`vault-{yyyyMMdd-HHmmss}.totpbackup`，`policy.ts:22`）。
- s3/gdrive/onedrive 另有 `listBackupsEx`（分页续传 + 10 页上限 + `complete` 截断标志，F6）；
  webdav/gist 仅有 `listBackups`（视为 complete=true，`retention.ts:23` 既有回退语义）。
- `openBackupEnvelope` 已自 core 导出（`core/src/index.ts:33` `export * from './backup/envelope'`）；
  `parseVaultJson` 为 ui 侧既有恢复校验（`CloudCard.vue:502` onSync 先行校验同款）。
- 桌面通用二进制保存已存在：`pickBackupSaveOs` + `writeBytesFileOs`（`backupPlatform.ts:149-154`
  `saveImageFile` 同款），无新 Rust command 需求。
- 扩展端 Blob 下载先例：`exportConflictCopy`（`CloudCard.vue:99-107`）。
- Gist 删除为伪删：PATCH `content=''`（`gist.ts:59-62`，代码注释明确「保留实现以备未来清理云端备份
  功能」——即本功能）；`listBackups` 过滤 `content==''` 残留（`gist.ts:67-74`），删除后条目即刻从
  列表与滚动删除中消失，但 gist 侧文件骨架残留（GitHub API 不支持真删）。
- gdrive 无 objectPath 概念（凭据为 fileId，时间戳文件名不生效、keep 等价覆盖，UI 已隐藏保留策略
  配置，`CloudCard.vue:650-652`）。

## 设计

### §1 列表：每源卡内折叠区 + 按需加载（方案 A，已裁定）

CloudCard 每源展开区内、凭据字段区之后新增「云端备份」区块：

- 标题行 + 手动「刷新」按钮；**挂载不自动拉取**（避免打开页面触发 N 个网络请求）。
- 每源内存缓存 `backupsBySource: Record<sourceId, { names: string[]; complete: boolean }>`；
  手动刷新是唯一更新入口；源移除时随 `removeTarget` 清缓存。凭据编辑不自动失效缓存（用户自行刷新）。
- UI 经既有 `createCloudBackend(cred)` 直调后端（与 onSync 同款构造，`CloudCard.vue:414`），凭据取
  编辑副本回落已存凭据（`onConfirmReset` 同口径）：s3/gdrive/onedrive 调 `listBackupsEx`，
  webdav/gist 调 `listBackups` 并补 `complete: true`。
- 展示：basename **倒序**（字典序=时间序）；时间戳可解析时以 `backupNameTimestampMs`（`policy.ts:33`）
  附加友好时间。恢复/删除一律用列表原名（与 delete 同域，不做 basename 映射回构）。
- `complete === false` 时列表尾部显示「列表可能不完整」提示（F6 既有告警语义的 UI 化）。
- 刷新失败：区块内行内错误提示，不影响其他源与其余卡内功能。
- 锁定态/缺凭据：与 onSync 同口径提示「缺少凭据：解锁后保存凭据后再同步」式文案，不崩不拉。

**列表口径**：仅 `BACKUP_NAME_RE` 时间戳份（与滚动删除一致）。**overwrite 源列表为空**，显示说明
「覆盖模式云端仅单一对象，由同步链路管理」——同步下载链路已覆盖其恢复需求；不做「当前对象固定行」
特例（gdrive 无 objectPath，特例需再开一路后端 API，YAGNI，导出入口记 backlog）。

### §2 恢复：对齐本地 restoreByName 的两步确认

选中份 → `backend.get(原名)` → `JSON.parse` → `openBackupEnvelope(parsed, sessionSecret)` →
`parseVaultJson` 校验 → 行内**两步确认** → `persistDownloaded(json)`（既有整体替换链路）。

- 解密与校验在确认**前**完成：坏份/错口令不进入确认流（onSync `parseVaultJson` 先行同款，
  `CloudCard.vue:502`）。口令不匹配沿用既有「口令不匹配」中文错误提示通道。
- **刻意不写 SourceSyncState 基线**（与 adopt 的 `pendingStates` 机制相反）：恢复历史份 = 本地有意
  偏离云端最新，基线保持不动，下次同步按既有四分支自然收敛（本地已改 → 上传/合并提示）。若误写
  基线会把「恢复出的旧内容」声明为「与云端最新同步」，静默掩盖分歧。
- 恢复按钮需 `sessionSecret` 非空（与同步按钮同禁用条件）。

### §3 删除：两步确认 + gist 伪删如实标注

- 行内两步确认（点名 + 不可撤销说明）→ `backend.delete(原名)` → 成功后刷新该源列表。
- gist 确认文案附加伪删语义说明：「Gist 无法真删：内容被置空，条目骨架残留但不再出现在列表与
  滚动删除中」。
- **rev 基线不动**，边缘行为依赖既有编排分支收敛，均无需新增状态处理：
  - 删 keep 源最新份：下轮同步 `readPath` 回落到次新份，rev 与基线不符 → 内容比对分支（内容一致
    仅刷基线 / 不一致走下载确认或本地改动上传合并）；rev 回拨由既有碰撞核验兜底（`syncOrchestrator.ts`
    审查 Critical-1 同 rev 碰撞核验：baseSnapshot 存在而远端内容不符仍视为已变）。
  - 删 overwrite 源唯一对象（列表口径不含固定对象，故仅经滚动删除/外部操作可达，此处记录备忘）：
    下轮同步走「云端无对象 → rev 续钟重推」分支（`syncOrchestrator.ts:132-138`）。
- 手动列表操作走卡内既有 `busy` 位：操作期间同步按钮禁用（既有 `:disabled="busy"`），反向亦然
  （确认行按钮均 `:disabled="busy"`），与同步/滚动删除天然互斥，无需入 `runExclusive` 单飞链。

### §4 导出：密文原件 + 新平台可选成员

- 新可选成员 `CloudPlatform.saveBackupFile?(name: string, bytes: Uint8Array): Promise<boolean>`
  （`false` = 用户取消另存）。导出**不解密**：`backend.get(原名)` 原样字节落盘，便于离线留存与迁移。
- desktop 实现：`pickBackupSaveOs`（文件过滤器补 `.totpbackup`）+ `writeTextFileOs`——云端密文
  原件本质是信封 JSON 的 UTF-8 文本（`put` 前 `JSON.stringify`，`syncOrchestrator.ts:64-69`），
  文本管道无损；`writeBytesFileOs` 白名单是 `.png` 专属（`dialog_grants.rs:506`），不适用
  （2026-10-10 计划期勘误：初稿误写 writeBytesFileOs）。Rust 仍零改动。
  extension 实现：Blob 下载（`exportConflictCopy`/`saveTextFile` 同款 `downloadBlob` 通道）。
- 未提供该成员的宿主不渲染导出按钮（能力检测，BackupCard `v-if="platform.restoreByName"` 同模式）。
- Gist 超 1MB 被截断的份：`get` 抛既有中文错误（`gist.ts:56`），导出按钮报错即可。

### §5 UI 与状态机（CloudCard.vue）

- confirm 槽扩展：`useConfirmPattern(['adopt','reset','remove'])` 增 `backupRestore`、`backupDel`
  两槽，payload = `${sourceId}\n${name}`（槽互斥语义免费获得；confirmPending 已并入同步按钮禁用链）。
- 列表项按钮禁用矩阵：恢复 = `busy || !sessionSecret`；导出/删除 = `busy`；确认行展开期间由
  `confirmPending` 统一禁用同步。
- i18n：`cloudCard.*` 域新增键（zh/en 双份）：区块标题、刷新、截断提示、空态（含 overwrite 说明）、
  恢复/导出/删除按钮、两步确认文案（恢复/删除各一）、gist 伪删标注、缺凭据复用既有键。

### §6 接口与模块清单

| 层 | 文件 | 改动 |
|---|---|---|
| ui 接口 | `packages/ui/src/components/cloudPlatform.ts` | +`saveBackupFile?` 可选成员 |
| ui 组件 | `packages/ui/src/components/CloudCard.vue` | 云端备份区块、两 confirm 槽、恢复/导出/删除逻辑、缓存 |
| ui i18n | locales（zh/en，`cloudCard.*` 域） | ~10 键 |
| desktop | `apps/desktop/src/cloudPlatform.ts` | `saveBackupFile`（pickBackupSaveOs + writeBytesFileOs） |
| extension | options 平台工厂 | `saveBackupFile`（Blob 下载） |
| core | — | **零改动** |
| Rust | — | **零改动** |

## 测试策略

- ui 新增 `packages/ui/test/cloudCard.backupList.test.ts`：区块按能力/凭据渲染、刷新拉取与截断提示、
  倒序与 basename 展示、恢复两步确认全流程（mock backend 信封）、口令错不进确认、删除确认 + gist
  标注、导出能力检测与调用、overwrite 空态、源移除清缓存。
- desktop：`cloudPlatforms.test.ts` 补 `saveBackupFile`（取消返回 false / 写盘调用断言）。
- extension：平台工厂测试补 `saveBackupFile`（Blob 下载 mock）。
- 既有 CloudCard/BackupCard/core 测试回归。

## YAGNI / 未做（明确排除）

- overwrite 固定对象的列表行/导出入口（backlog）。
- gist 真删（上游 API 不支持，backlog 待上游）。
- 跨源聚合视图、批量删除/导出、备份内容预览、单份重命名/移动（本地源亦无）。
- 列表自动加载/轮询、分页 UI（截断提示 + 重试已够用，滚动删除口径本就 10 页上限）。

## Backlog 追加项

- overwrite 固定对象（`resolveObjectPath`）的导出/恢复独立入口（当前由同步下载链路覆盖恢复语义）。
- gist 真删（GitHub API 若支持文件级删除时，替换伪删并移除 UI 标注）。
