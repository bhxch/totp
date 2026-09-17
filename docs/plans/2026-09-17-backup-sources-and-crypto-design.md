# 设计：备份源统一模型 + 密钥出密文 + envelope v2 + 导入去重 + 锁定策略

日期：2026-09-17
状态：已评审定稿（brainstorming 四节逐节确认）

## 背景与目标

用户六点诉求：

1. 导入支持去重——同一文件反复导入不应产生重复条目。
2. 密钥不能放密文中一起加密——备份口令存在 vault 内（plan15 决策），云上传时整个 vault JSON（含口令自身）又被该口令加密，密文里含自己的密钥。
3. 加密方式可选——当前 envelope 算法硬编码 argon2id + AES-256-GCM。
4. 考虑密钥/IV 定期轮换。
5. 备份源支持同一类型反复添加（多个同源账户）；本地也作为一种源。
6. 每个源都支持覆盖或保留最近 n 份。

评审中追加：Bitwarden 式锁定选项（用户选择何时锁定）；主口令未更换天数提示。

## 现状结论（评审时核实）

- **导入**：已有冲突检测，键 = issuer+label（trim+大小写不敏感），策略 skip/replace/merge（`packages/core/src/import/conflict.ts`）。无 secret 维度去重。
- **加密**：本地库与备份信封同构——argon2id 派生 KEK 包裹随机 DEK，DEK 以 AES-256-GCM 加密数据。备份口令 `backupSecret` 存 vault 内（`model.ts`）。
- **IV**：本地库每次写入、每份备份每次生成、每次云上传均全新随机 12B nonce——已天然满足，无需机制。
- **密钥**：云备份每份 envelope 全新 salt+DEK（每次即轮换）；仅本地库 DEK 长期固定。
- **云凭据**：`cloudCreds` 明文存设备侧（storage.local / AppData settings），未受 DEK 保护；同后端类型仅一份凭据（键约定 `cred.backend`）；云目标固定覆盖单文件；keep-n 仅桌面本地备份目录有。
- **锁定**：按窗口独立解锁，DEK 在各上下文 JS 内存；无自动锁定；自动备份/云同步在锁定态本就跳过（`autoBackup.ts` locked 守护）。

## §1 安全布局：DEK 保管区 + 源列表拆分存储

### 保管区（secret bag）

新增设备侧存储键 `secretBag`：`{ v: 1, nonce, ciphertext }`，AES-256-GCM，密钥 = 解锁态持有的库 DEK，每次写入新随机 nonce。明文 JSON：

```json
{ "backupPassword": "…", "creds": { "<sourceId>": { …CloudCred } } }
```

vault JSON 中的 `backupSecret` 字段删除（连同 `vaultSecret.ts` 纯函数与 plan15 的 ui store 守护逻辑，该决策反转）。

效果：

- 云 envelope 密文不再包含自己的口令；
- 备份口令 + 全部云凭据受本地主口令（DEK）保护（补齐现状云凭据明文短板）；
- 磁盘上除 vault 密文与保管区密文外无任何秘密。

### 源列表拆两处

凭据是秘密、元数据不是：

- 明文 settings 键 `backupSources`：`[{ id, kind, name, retention, enabled, objectPath?, dir? }]`——锁定态也要能渲染列表与开关；
- 保管区：凭据按 `sourceId` 关联；
- 基线 `sourceRevs: Record<sourceId, hash>` 替代按 backend 类型作键的 `cloudRevs`。

### 锁定语义统一

锁 = 丢弃 DEK（各上下文内存 + `chrome.storage.session`），保管区、云凭据、备份口令同时不可用；解锁即恢复。

锁定策略四触发器，用户可叠加配置（新键 `lockPrefs`）：

| 触发器 | 范围 | 说明 |
| --- | --- | --- |
| 重启即锁（默认开） | 两端 | 扩展端 DEK 进 `chrome.storage.session`（浏览器退出即清、不落盘），附带收益：options/popup 共享解锁态 |
| 空闲超时 N 分钟 | 两端 | 可配置 |
| 系统锁屏 | 仅桌面 | Tauri 事件；扩展端无可靠系统锁屏事件 |
| 从不自动锁 | 两端 | 仅手动锁 |

### 迁移（一次性、幂等、先写新后删旧）

- 旧 vault 内 `backupSecret` → 写入保管区，从 vault 删除并重写；
- `cloudCreds`（按 backend）→ 建源（id 初值沿用 backend 键）凭据迁入保管区；`cloudRevs` → `sourceRevs`；
- 桌面既有 backups 目录 → 一条 `local` 源。

### 明确接受的代价

云恢复到新设备后需重输备份口令 + 重配云凭据（凭据本就不同步，仅口令多一次输入）。

## §2 envelope v2：KDF 档位 + 密钥被动轮换

应用未发布——**放弃 v1 兼容**，信封直接定稿 v2，读端只认 v2：

```jsonc
{
  "v": 2,
  "kdf": { "alg": "argon2id", "profile": "balanced", "m": 65536, "t": 3, "p": 1, "salt": "…" },
  "wrapNonce": "…", "wrappedDek": "…",
  "aead": "aes-256-gcm",
  "dataNonce": "…", "ciphertext": "…"
}
```

### KDF 档位

| 档位 | m (KiB) | t | 依据 |
| --- | --- | --- | --- |
| fast | 19456 | 2 | OWASP 最低档 |
| balanced（默认） | 65536 | 3 | 现值 |
| paranoid | 262144 | 4 | 保守 |

- 备份/云上传按备份设置所选档位生成 envelope；
- 本地库档位在安全设置选择，**下次改主口令时生效**（UI 注明，不强制重加密）；
- 读端 KDF 参数钳制逻辑不变（钳的是展开值，`profile` 仅记录写入意图）。

### 被动轮换（不做定时轮换）

轮换绑定两件事，流程一致：重生成 salt → 重生成 DEK → 全库重加密 → 重加密保管区（DEK 变更的隐含依赖，必须列入改口令流程）→ 刷新 `passwordChangedAt`：

1. 改主口令；
2. 变更 KDF 档位（顺路完成）。

### IV

维持现状：每次写入/每份文件全新随机 12B nonce，无额外机制。

### 主口令天数提示

`SecuritySettings` 加 `passwordChangedAt`；安全页显示「本地主口令已 N 天未更换」，超 180 天强调色；改口令/被动轮换时刷新。

## §3 备份源统一模型

### 源（BackupSource）

```ts
interface BackupSource {
  id: string                      // uuid，取代 cred.backend 作键
  kind: 'webdav' | 's3' | 'gist' | 'gdrive' | 'onedrive' | 'local'
  name: string                    // 用户可见别名
  retention: { type: 'overwrite' } | { type: 'keep'; n: number }
  enabled: boolean
  objectPath?: string             // 云源，沿 resolveObjectPath 校验
  dir?: string                    // 本地源（仅桌面）
}
```

- 同 kind 可加任意多条（两个 WebDAV 账号 = 两条源）；
- 备份口令全局一把（所有源同一口令）；每源独立口令列为未来扩展，本期不做；
- core `syncMultipleTargets` 本就按目标列表 + 独立基线设计，`key` 换成源 id 即可，改动集中在宿主装配与 `sourceRevs`。

### 每源 retention 语义

- `overwrite`：云源写固定对象路径（现状）；本地源写 `vault-backup.totpbackup`（现状）；
- `keep n`：云源在同目录/同前缀写 `vault-{ts}.totpbackup`，随后列远端 + 按 `BACKUP_NAME_RE` 滚动删除超额旧份；`conflict-*` 副本不参与滚动删除（沿用现状）。五种云后端各补 list+delete：WebDAV（PROPFIND/DELETE）、S3（ListObjectsV2/DeleteObjects）、Gist（同 gist 多文件）、GDrive（files.list/delete）、OneDrive（children/delete）。本地源即现有滚动删除推广到「目录=源」。

### 平台差异与编排

- 本地源仅桌面端；扩展端源类型面板隐藏 `local`，保留云源 + 现有手动导出/导入（评审裁定：下载目录易被清理打断 keep-n 链、删用户文件侵入性强，YAGNI）；
- 自动备份/云同步 runner 遍历 enabled 源逐个执行；手动「立即备份」= 全部 enabled 源；
- 桌面 AppData/backups 与用户自选目录各自可建源。

## §4 导入去重

### 判定树（导入预览阶段一次算好，逐条标注）

1. 与现有条目**全字段一致**（type/issuer/label/secret/algorithm/digits/period/counter）→ 标「完全相同」，自动跳过，不可改；
2. **secret+algorithm 相同**但其余字段有差异 → 标「疑似同账户」，默认跳过，每条可单独改为「新增」或「覆盖」（覆盖按 secret 定位现有条目更新字段）；
3. secret 不同但 **issuer+label 撞现有** → 现有冲突三选（跳过/覆盖/并存），交互不变；
4. 无碰撞 → 正常导入。

secret 维度（1/2）优先于 issuer+label 维度（3），一条 incoming 最多落一个分支。导入文件**内部**先合并完全重复行，避免预览计数虚高。

### UI

ImportCard 预览四组计数：新增 / 完全相同已跳过 / 疑似同账户待确认 / 冲突待选择；「全部导入」只提交已确认项。

## 测试策略（vitest，预计 +60~80 例）

- **core**：去重判定树纯函数；envelope v2 往返 + 三档位参数展开；保管区加解密、迁移幂等（先写新后删旧、中断不丢数据）；每源 keep-n 滚动删除（fake backend 列/删）；多目标按源 id 收敛与基线平移。
- **ui**：ImportCard 四组预览状态机；lockPrefs 偏好；备份源卡增删改/启停/retention 编辑。
- **宿主**：desktop 本地源滚动删除与目录覆盖；extension `chrome.storage.session` DEK 存取（adapter 假实现）；旧数据迁移用例（vault.backupSecret + cloudCreds + cloudRevs → 保管区 + backupSources + sourceRevs）。

## 明确不做（YAGNI）

- 定时自动轮换 DEK（被动轮换已覆盖泄漏窗口，锁定策略才是主控制面）；
- 每源独立备份口令；
- AEAD 算法可选（XChaCha20 等，避免 WebCrypto 外新依赖与双实现测试面）；
- 扩展端本地源（chrome.downloads 方案）；
- envelope v1 读兼容（未发布，直接定稿 v2）。
