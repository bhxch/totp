# TOTP 工具 计划10：云同步五后端与冲突处理 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付云备份五后端（WebDAV/S3/OneDrive/Google Drive/GitHub Gist）：core 纯 fetch 适配器（统一接口：上传/下载/删除/远端 hash 校验）、双端接入（复用 BackupCard 的加密 envelope 文件作为云端对象）、同步状态条与冲突处理（last-write-wins + 本地冲突副本保留）、桌面定时自动备份（可选）。

**Architecture:** core `cloud/`：`CloudBackend` 接口（put/get/delete/list）+ 五实现（纯 fetch，无 SDK）；凭据存各端安全存储（desktop：settings 键明文凭据？——裁定：凭据存 local storage 键 `cloudCred`（desktop AppData / extension chrome.storage.local），不做系统级加密（M3 计划 11 的 DPAPI 可后续包裹））；ui `CloudCard`（后端选择+凭据表单+立即同步+状态+恢复）；冲突：云端 rev 与本地比对，云端较新→拉取前本地存 `conflict-{ts}.totpbackup` 副本。

**Tech Stack:** 现有栈不变（纯 fetch + base64/二进制处理）。

**Spec:** `docs/plans/2026-09-13-totp-tool-design.md`（第 6 节云后端 + 同步检查/冲突处理）

## Global Constraints

- 沿用全部既有约束；五后端均为 core 运行时模块但零新增依赖（纯 fetch + 手工签名）
- `CloudBackend` 统一接口：
  ```ts
  export interface CloudBackend {
    readonly id: 'webdav' | 's3' | 'gdrive' | 'onedrive' | 'gist'
    put(path: string, data: Uint8Array): Promise<void>
    get(path: string): Promise<Uint8Array | null>
    delete(path: string): Promise<void>
    exists(path: string): Promise<boolean>
  }
  ```
  - S3：AWS Signature V4 手工实现（ SigV4 是本任务最难点——严格按 AWS 文档实现，测试用 AWS 官方签名测试向量锚定）
  - GDrive：简单上传 `uploadType=media`（需 OAuth token 由用户提供——裁定：用户在 Google Cloud Console 自建 OAuth client 提供.refresh token 或 access token，UI 接受 token 粘贴，不做 OAuth 流程跳转——scope 最小化）
  - OneDrive：Microsoft Graph `PUT /me/drive/root:/{path}:/content`（Bearer token 用户粘贴）
  - WebDAV：PUT/GET/DELETE + Basic Auth
  - Gist：`PATCH /gists/{id}`（文件名=path，内容 UTF-8；token 用户粘贴；文件内容为文本）
- 云端对象路径固定 `totp-backup.totpbackup`（内容=P4 加密 envelope JSON；恢复走 openBackupEnvelope 既有链路）
- 凭据/端点存 local 键 `cloudCred`（JSON：{backend, ...字段}）；**口令不存**（每次同步输入或会话缓存——裁定：同步口令会话内缓存于页面内存，与 vault 解锁同级）
- 同步检查：上传后 get 回读字节级比对（hash 比对：前 64 字节+长度+简单校验和即可，避免整文件比较的内存开销——裁定：全量字节比对，envelope 通常 <100KB）
- 冲突：云端存在且本地无对应 rev 记录（`cloudRev` local 键）→ 下载存本地冲突副本 `conflict-{yyyyMMdd-HHmmss}.totpbackup`（桌面 fs / 插件下载）后再覆盖上传；`cloudRev` 记录上次已知的云端内容 hash
- 本计划不含：自动定时同步（backlog）、增量同步（全量覆盖）

---

### Task 1: core CloudBackend 接口 + WebDAV/Gist（TDD）

**Files:**
- Create: `packages/core/src/cloud/backend.ts`、`packages/core/src/cloud/webdav.ts`、`packages/core/src/cloud/gist.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/cloudWebdav.test.ts`（fetch mock 断言请求形状：方法/URL/Authorization 头/_body）

**Interfaces:**
- `backend.ts`：CloudBackend 接口 + `CloudCred` 判别联合（webdav: {serverUrl, username, password}；gist: {token, gistId}；其余 Task 2 扩展）
- webdav.ts：`createWebdavBackend(cred): CloudBackend`（PUT `{serverUrl}/{path}` Basic Auth；GET 404→null；DELETE；exists→GET 期望 200）；路径拼接处理尾斜杠
- gist.ts：`createGistBackend(cred): CloudBackend`——Gist 文件内容是文本：put=PATCH /gists/{gistId} body {files:{[path]:{content: utf8}}}；get=GET /gists/{gistId} 取 files[path].content（truncated 处理：>1MB 拒绝）；delete=content 置空串？Gist 无法删文件——delete=content 置空（语义近似）；exists=GET files[path] 存在且非空
- 测试：vi.stubGlobal fetch + 调用捕获（url/method/headers/body 字符串）；错误路径（401/网络失败抛中文错误）

- [ ] **Step 1: TDD → Commit**

```bash
git add packages/core/
git commit -m "feat(core): CloudBackend接口与WebDAV/Gist适配器"
```

---

### Task 2: S3 SigV4 + GDrive/OneDrive（TDD）

**Files:**
- Create: `packages/core/src/cloud/s3.ts`、`packages/core/src/cloud/gdrive.ts`、`packages/core/src/cloud/onedrive.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/cloudS3.test.ts`（AWS 官方 SigV4 测试向量锚定签名）、`packages/core/test/cloudDrive.test.ts`

**Interfaces:**
- s3.ts：`createS3Backend(cred: { region; bucket; accessKeyId; secretAccessKey; endpoint?: string }): CloudBackend`——SigV4：canonical request/signed headers/string to sign/derived key/HMAC 链/Authorization 头 + x-amz-* 头；PUT/GET(404→null)/DELETE/HEAD(exists)；path 前缀可配（默认根）；endpoint 自定义兼容 MinIO
- **SigV4 测试锚定**：用 AWS 文档示例向量（get-vanilla 等——实现者抓取 AWS SigV4 测试套件 github.com/aws/aws-sdk-java 或文档示例，至少锚定 2 组已知 signature 断言）+ 一次端到端形状断言
- gdrive.ts：`createGDriveBackend(cred: { accessToken }): CloudBackend`——PUT `https://www.googleapis.com/upload/drive/v3/files/{fileId}?uploadType=media`（fileId=固定创建？——裁定：get 按 name 查询 `q=name='totp-backup.totpbackup'`，不存在则 POST multipart 创建后记住 id？简化：**用户在 UI 提供 fileId**（事先手动创建），或首推自动创建并回存 id 到 cred——取后者：cred.gdrive 含 fileId? 可选，put 时若无 fileId 先 `POST /drive/v3/files` 创建（name+empty content）取 id 回写 cred（cred 回写由调用方持久化——接口增加 `onCredChange?(cred): void` 可选回调））
- onedrive.ts：`createOneDriveBackend(cred: { accessToken }): CloudBackend`——Graph PUT upsert content；GET content（404→null）；DELETE；exists→GET /root:/{path} 200

- [ ] **Step 1: TDD（SigV4 向量锚定 + GDrive/OneDrive fetch mock）→ Commit**

```bash
git add packages/core/
git commit -m "feat(core): S3 SigV4与GDrive/OneDrive适配器"
```

---

### Task 3: core 云同步编排（TDD）

**Files:**
- Create: `packages/core/src/cloud/syncOrchestrator.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/cloudSync.test.ts`（mock backend）

**Interfaces:**
- Produces:
  ```ts
  export interface CloudSyncOutcome { action: 'uploaded' | 'downloaded' | 'conflict-resolved' | 'in-sync'; conflictBackup?: string }
  export async function syncWithCloud(opts: {
    backend: CloudBackend
    path: string
    vaultJson: string            // 当前本地明文 vault
    password: string             // envelope 口令（会话缓存由调用方持有）
    localHash: string | null     // 上次已知云端内容 hash（cloudRev）
    onCredChange?: never
  }): Promise<CloudSyncOutcome & { hash: string; envelopeJson: string }>
  ```
  逻辑：exists? → 否：createBackupEnvelope→put→uploaded；是：get→hash 与 localHash 同→in-sync；不同→远端内容 openBackupEnvelope(password) 成功？（远端可解=远端较新或本地曾推）→ 本地 hash 缺失（首次接云）→ 下载存冲突副本 + downloaded（远端覆盖本地）；本地 hash 匹配预期但内容不同→conflict：本地先存冲突副本→下载远端覆盖本地→downloaded/conflict-resolved；openBackupEnvelope 失败（口令错/结构坏）→ 抛中文错误「云端备份口令不匹配，无法合并——请确认口令或手动下载处理」
  - hash：`sha256Hex(bytes)`（crypto.subtle 摘要 hex）
- 本计划不做双向合并（远端胜+本地副本），与设计「last-write-wins + 冲突副本保留」一致

- [ ] **Step 1: TDD（mock backend：不存在/一致/不同可解/不同不可解 4 分支 + 冲突副本回调）→ Commit**

```bash
git add packages/core/
git commit -m "feat(core): 云同步编排(回读校验/冲突副本/LWW下载)"
```

---

### Task 4: ui CloudCard + 双端接入

**Files:**
- Create: `packages/ui/src/components/CloudCard.vue`
- Modify: `packages/ui/src/index.ts`、`packages/ui/src/components/VaultManager.vue`（挂载）
- Modify: `apps/extension/entrypoints/options/App.vue`、`apps/desktop/src/App.vue`（platform 组装）
- Test: `packages/ui/test/CloudCard.test.ts`

**Interfaces:**
- CloudCard props `{ platform: { pickBackendCred(): Promise<{ cred: CloudCred } | null>  // 表单内联而非 picker——裁定：表单内联（后端下拉+动态字段+保存到 cloudCred）; loadCred(): Promise<CloudCred | null>; saveCred(c: CloudCred): Promise<void>; readVaultJson(): string; persistDownloaded(json: string): Promise<void>  // 恢复链路：parseVaultJson→confirm→replaceAllOp（复用 BackupCard 恢复语义）; saveConflictBackup?(bytes: Uint8Array): Promise<string | null>; getPassword(): string | null  // 会话口令缓存（BackupCard 输入过则复用——简化：CloudCard 自带口令输入，与 BackupCard 独立） } | null }`
- UI：后端下拉+动态凭据字段+「保存凭据」+「口令」输入+「立即同步」按钮+状态（uploaded/downloaded/in-sync/conflict/错误）+冲突提示（「云端数据与本地不同，已保留本地冲突副本并采用云端——可从备份列表/文件恢复冲突副本」）
- desktop platform：saveConflictBackup→fs 写 AppData/backups；extension→Blob 下载
- core syncOrchestrator 消费：backend 由 cred 工厂创建（switch backend id）

- [ ] **Step 1: TDD（4 用例：凭据保存/同步按钮调 orchestrator 分支提示/口令缺失不调用/错误展示）→ 实现 → 三端接线 + 产物核对 → Commit**

```bash
git add packages/ apps/ pnpm-lock.yaml
git commit -m "feat(ui): CloudCard云同步五后端接入与冲突处理UI"
```

---

### Task 5: 回归 + README

**Files:**
- Modify: `README.md`（补「云同步」段：五后端、凭据自备（token/密钥）、加密 envelope 上云、冲突处理语义（LWW+副本）、口令自管警示、S3 SigV4/MinIO 兼容）

- [ ] **Step 1: 回归（pnpm test / typecheck / 双 build）→ README → Commit**

```bash
git add README.md
git commit -m "docs: README补充云同步说明"
```
