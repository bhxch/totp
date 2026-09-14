# TOTP 工具 计划9：浏览器同步加密分片 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 插件端 `chrome.storage.sync` 作为默认同步通道：加密 vault 分片存储（每片 <8KB）、同步元数据（revision/updatedAt）、超限检测与提示、扩展端跨设备同步（settings 一并密文同步）、开关与状态 UI。

**Architecture:** core 新增 `sync/`（分片切分/合并纯函数 + SyncMeta）；extension 新增 sync 模块：监听本地 vault/settings 变更 → 加密分片写 sync；`chrome.storage.onChanged` 监听 sync 区 → 比对 revision → 拉取合并（revision 单调递增，LWW）；超限（QUOTA_BYTES_PER_ITEM/total）时提示切云后端（云后端属计划 10，本计划提示文案预留）。

**Tech Stack:** 现有栈不变（chrome.storage.sync API、core crypto 已有）。

**Spec:** `docs/plans/2026-09-13-totp-tool-design.md`（第 6 节浏览器同步通道；无加密态时同步明文？——裁定：加密未启用时同步通道仍走分片但存明文 JSON（与本地一致的信任模型），提示建议启用加密；SecurityCard 文案说明）

## Global Constraints

- 沿用全部既有约束；本计划仅 extension 端（desktop 无浏览器同步）
- 分片格式：`sync:v1:{i}/{n}` 键名（如 `sync:v1:0/3`），值 = JSON `{ rev, updatedAt, part, total, data }`；data 为 vault JSON（加密态=EncryptedVault JSON 字符串；明文态=Vault JSON 字符串）的 UTF-8 分片（按字符切，避免代理对劈裂——按 code unit 切但重组用数组拼接保证无损：**裁定按 UTF-8 字节切分后 base64 存储分片，规避多字节截断**）
- sync 元数据键 `sync:meta`：`{ rev: number; updatedAt: number; total: number; sha256?: string }`——rev 每次本地写 +1；接收端 rev 大者胜；相等比 updatedAt
- 清理：分片数减少时删除多余旧片
- settings 同步：`sync:settings` 键整体一份（settings 是小对象无需分片；加密态敏感字段无——settings 本身不含 secret，明文可接受？——**裁定 settings 含 blurHide/clipboardClear/延迟等非敏感项，明文同步**）
- 超限检测：写前 `chrome.storage.sync.getBytesInUse` 与 `QUOTA_BYTES`（102400）比较；单项 `QUOTA_BYTES_PER_ITEM`（8192）约束分片大小（每片 data ≤7000 字节预留包装）；超限→设置页横幅提示「条目过多，浏览器同步已达上限，请配置云备份」+ 同步状态条显示错误
- 同步开关：settings 加 `syncEnabled: boolean`（默认 false——首次启用需用户显式开启，提示密文说明）
- 既有回归保障：sync 关闭时行为与当前完全一致

---

### Task 1: core 分片与合并纯函数（TDD）

**Files:**
- Create: `packages/core/src/sync/chunks.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/syncChunks.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface SyncChunk { rev: number; updatedAt: number; part: number; total: number; data: string }  // data=base64
  export interface SyncMeta { rev: number; updatedAt: number; total: number }
  export function splitIntoChunks(payload: string, rev: number, updatedAt: number, maxDataBytes?: number): SyncChunk[]  // UTF-8 字节切分（默认 7000），每片 base64；payload 空→单空片
  export function mergeChunks(chunks: SyncChunk[]): string | null  // 校验 part/total 完整、rev/updatedAt 一致→拼接 base64 解码 UTF-8；不完整/不一致→null
  export function chunksToMeta(chunks: SyncChunk[]): SyncMeta
  export function staleChunkKeys(existing: SyncChunk[], fresh: SyncChunk[]): string[]  // 键名计算：`sync:v1:${part}/${total}`——返回 fresh 写入后应删除的多余旧键（旧 total>新 total 的片键）
  export function chunkKey(part: number, total: number): string
  ```
- 测试：空串/短串单片/跨多片/多字节 UTF-8（emoji 中文）往返、rev/updatedAt 贯穿、不一致片 null、stale 键计算

- [ ] **Step 1: TDD → Commit**

```bash
git add packages/core/
git commit -m "feat(core): 浏览器同步分片切分/合并/元数据纯函数"
```

---

### Task 2: extension sync 模块（TDD 可测部分 + 接线）

**Files:**
- Create: `apps/extension/src/syncEngine.ts`
- Modify: `apps/extension/src/store.ts`（薄封装扩展：syncEnabled settings；commit 后触发 push 调度）
- Modify: `apps/extension/entrypoints/background.ts`（SW 内 sync 推送/拉取逻辑——SW 无法复用页面 store；裁定：**推送经 chrome.runtime.sendMessage 由 background 执行**，background 直接读 local 键做分片写 sync；页面端只发通知）
- Modify: `apps/extension/wxt.config.ts`（permissions 加 `alarms`——已有；无需新增 storage——已有）
- Test: `apps/extension/test/syncEngine.test.ts`（若 WXT 工程不便测试，逻辑下沉 core 或 ui；**裁定：分片已下沉 core，syncEngine 编排逻辑以 typecheck+build+产物核对验收**）

**Interfaces:**
- `scheduleSyncPush()`（页面端调用：debounce 1s → sendMessage {type:'sync-push'}）；background：`chrome.storage.local.get(['vault','security'])` → 组 payload（security 存在=加密态 payload 为 EncryptedVault JSON，否则 Vault JSON）→ rev = (sync:meta.rev ?? 0) + 1 → splitIntoChunks → 写 sync 分片 + sync:meta + `sync:settings`（settings 直读 local）→ 清 stale → `getBytesInUse` 超限检测（>QUOTA_BYTES*0.9 置 `sync:status`={state:'quota'}）
- background `chrome.storage.onChanged`(sync 区) → 读 sync:meta 与本地 rev 比对：远端 rev 更大 → 拉取全部分片 mergeChunks → 写 local vault（+security 键同态：若 payload 是 EncryptedVault 则 local security 由远端 `sync:security` 键同步——**裁定：security 键也进同步（sync:security 单键），使新设备可直接解锁**）→ `sync:status`={state:'ok', at}
- 冲突：rev 相等且 updatedAt 不同→取 updatedAt 新；本地与远端并发写（rev 相差 1 内）由 rev 单调 + 推送重读保证最终一致（简单 LWW，冲突副本不做——设计 §6 冲突副本属云同步计划）
- `sync:status` 键：`{ state: 'ok'|'quota'|'error'|'off', at: number }` 供 UI 状态条

- [ ] **Step 1: 实现 + 接线（settings.syncEnabled 开关控制全部调度；options 页 SecurityCard 或独立 SyncCard 加开关与状态条——归 Task 3）**

- [ ] **Step 2: 产物核对（manifest permissions/背景逻辑在产物 background.js）+ Commit**

```bash
git add apps/extension/ pnpm-lock.yaml
git commit -m "feat(extension): 浏览器sync分片推送/拉取引擎(background承载)"
```

---

### Task 3: SyncCard 设置与状态 UI

**Files:**
- Create: `packages/ui/src/components/SyncCard.vue`
- Modify: `packages/ui/src/index.ts`、`packages/ui/src/components/VaultManager.vue`（挂载，extension 场景）
- Modify: `apps/extension/entrypoints/options/App.vue`（platform 组装：读 sync:status/syncEnabled、开关）
- Test: `packages/ui/test/SyncCard.test.ts`

**Interfaces:**
- SyncCard props `{ platform: { syncEnabled: boolean; setSyncEnabled(v): Promise<void>; status: { state: string; at: number } | null; canSync: boolean } | null }`（desktop 不组装=不渲染）
- UI：开关「启用浏览器同步（Chrome/Edge，加密数据分片同步）」+ 状态条（上次同步时间/状态：ok quota error）+ quota 时黄色提示「同步空间已满——建议配置云备份后关闭浏览器同步」
- settings.syncEnabled 进 core AppSettings（默认 false；typeof 收紧；SecurityCard/既有断言更新）

- [ ] **Step 1: core settings 扩展（TDD）→ SyncCard（TDD 3 用例：开关触发/状态渲染/quota 提示）→ 三端接线（desktop 不组装）→ 产物核对 → Commit**

```bash
git add packages/ apps/
git commit -m "feat(ui): SyncCard浏览器同步开关与状态条"
```

---

### Task 4: 回归 + README

**Files:**
- Modify: `README.md`（补「浏览器同步」段：开关位置、加密分片机制、超限行为、Firefox/手动格式说明）

- [ ] **Step 1: 回归（pnpm test / typecheck / 双 build / extension 产物核对）→ README → Commit**

```bash
git add README.md
git commit -m "docs: README补充浏览器同步说明"
```
