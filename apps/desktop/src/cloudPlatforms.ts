/**
 * desktop 云同步平台与自动云 runner 装配（P4 自 App.vue 抽出，纯搬移行为不变；plan16 T14 源化口径，
 * 键约定见 ui cloudPlatform.ts 注释块）：
 * - revSeal：rev 基线（spec §1.2）+ DEK seal 静态保护——手动/自动两侧共用同一 seal（共享
 *   cloudSyncState 键，缺 seal 侧会把密文当明文 bag 互踩并泄漏 baseSnapshot）；
 * - createCloudPlatform：CloudCard 全部成员——源元数据明文存 AppData backupSources 键；源凭据是
 *   秘密，存 DEK 保管区（store.saveSourceCredOp/removeSourceCredOp，解锁态限定，未解锁中文报错）；
 *   基线按源 id 存 sourceRevs；旧 cloudCreds/cloudCred/cloudRevs/cloudRev 四键由
 *   migrateLegacyCloudSources 一次性迁移（runLegacyMigrations）；冲突副本写
 *   backups/conflict-{sourceId}-{ts}.totpbackup；采用云端数据经 store.replaceAllOp 整体替换。
 *   自审（竞态，低概率接受）：自动同步在途期间用户于 CloudCard 改源/凭据，读-改-写可能互相覆盖
 *   （backupSources/sourceRevs 均为整键覆写）；runner busy 只防自动与自动重叠，与手动同步的并发
 *   为已知边界，不引入跨实例锁。
 * - createDesktopCloudSync：自动云同步 runner（D6，ui 共享实现，desktop/extension 同一编排）——
 *   loadSources 装配「启用云源 × 保管区凭据」对（无凭据的源跳过——锁定态 credsCache 为空自然全
 *   跳过）；冲突副本已由 onConflictBackup 落盘，故 adopt 分支自动执行、不弹确认——裁定来源=设计 §4
 *   「自动执行结果不打扰」（区别于 CloudCard 手动同步的两步确认）；GDrive 首推凭据回存由
 *   CloudCard 手动通道持有（runner deps 新口径不含 onCredChange）。
 * deps 以 getStore/getAdapter/tr 注入（闭包实时读取，未就绪中文报错语义与原实现一致）。
 */
import {
  loadDeviceId, loadSources, loadSyncState, saveSyncState,
  type BackupSource, type CloudCred, type Seal, type StorageAdapter, type Vault,
} from '@totp/core'
import {
  createCloudBackend, createCloudSyncRunner, requestMergeConfirm, setSyncProgress,
  type CloudPlatform, type VueStore,
} from '@totp/ui'
import { saveConflictBackupToDir, saveCloudSourcesPreservingLocal } from './backupService'
import {
  CLOUD_AUTO_STATUS_KEY, loadCloudPrefs, persistCloudPrefs, readAutoStatusText, recordAutoStatus,
  readCloudContentHash, writeCloudContentHash,
} from './desktopPrefs'

export interface CloudPlatformDeps {
  /** store 浅包装实时读取（未就绪 null → 平台方法「数据尚未就绪」中文报错） */
  getStore(): VueStore | null
  /** adapter 实时读取（onMounted createTauriFs 后赋值） */
  getAdapter(): StorageAdapter | null
  /** 壳层取词（runner 状态摘要/retention 提示记录时取词，随 locale 联动） */
  tr(key: string, params?: Record<string, unknown>): string
}

/** platform 工厂共用的就绪断言：store/adapter 未就绪时统一中文报错（卡片展示） */
function requireStore(deps: CloudPlatformDeps): VueStore {
  const s = deps.getStore()
  if (!s) throw new Error('数据尚未就绪')
  return s
}

function requireAdapter(deps: CloudPlatformDeps): StorageAdapter {
  const a = deps.getAdapter()
  if (!a) throw new Error('数据尚未就绪')
  return a
}

/** 全部源列表（云源+本地源；各消费方按 kind 过滤） */
async function loadAllSources(deps: CloudPlatformDeps): Promise<BackupSource[]> {
  return loadSources(requireAdapter(deps))
}

/** 备份加密强度档位（plan16 T11.5）：云上传/冲突副本 envelope 生成口径与本地备份一致；store 未就绪兜底 balanced */
function kdfProfileOf(deps: CloudPlatformDeps) {
  return deps.getStore()?.settings.backupKdfProfile ?? 'balanced'
}

/** store 整体替换的唯一实现：cloudPlatform.persistDownloaded / 云 runner persistAdopted 共用 */
async function replaceAllOps(deps: CloudPlatformDeps, v: Vault): Promise<void> {
  await requireStore(deps).replaceAllOp(v)
}

/** rev 基线 seal（spec §1.2 静态保护，T9 装配约定 5）：解锁态经 store 的 DEK seal 助手加密。
 *  两态语义（审查 Important 1 修正）：未启用加密（security 为空）→ sealWithDek 返回 null → 明文回落
 *  （明文库语义）；加密启用但窗口锁定（DEK 已清）→ sealWithDek 抛 'vault locked' → 不吞错，
 *  落盘整体失败（下轮按旧基线重做），绝不把 baseSnapshot/冲突记录明文回落落盘。
 *  unseal 不可解（换 DEK/明文记录）回落原文——core 解析层自然判废（明文可解析=兼容读取，
 *  密文垃圾解析失败=回落空态重建） */
export function revSeal(s: VueStore): Seal {
  return {
    seal: async (plain) => (await s.sealWithDek(plain)) ?? plain,
    unseal: async (sealed) => (await s.unsealWithDek(sealed)) ?? sealed,
  }
}

export function createCloudPlatform(deps: CloudPlatformDeps): CloudPlatform {
  const { tr } = deps
  return {
    // ---- 源模型成员（plan16 T14；本卡仅消费云源，local 项归 BackupCard）----
    loadSources: async () => (await loadAllSources(deps)).filter((s) => s.kind !== 'local'),
    // 审查 I11：合并写入——保留并发改动中的本地源（BackupCard 通道），仅覆盖本卡提交的云源列表
    saveSources: (list) => saveCloudSourcesPreservingLocal(requireAdapter(deps), list),
    saveCred: (id, cred) => requireStore(deps).saveSourceCredOp(id, cred),
    removeCred: (id) => requireStore(deps).removeSourceCredOp(id),
    // getter 形态：CloudCard 渲染/回调按 id 动态读取（p.creds[id]），锁定清空/解锁装载/保存后即时可见
    get creds() { return requireStore(deps).credsCache.value },
    readVaultJson() {
      const s = deps.getStore()
      if (!s) throw new Error('数据尚未就绪')
      return JSON.stringify(s.vault)
    },
    persistDownloaded: (json) => replaceAllOps(deps, JSON.parse(json) as Vault),
    saveConflictBackup: async (bytes, sourceId) => saveConflictBackupToDir(bytes, null, sourceId),
    // rev 基线（spec §1.2）+ DEK seal 静态保护：与 runner 通道共用同一 revSeal（共享 cloudSyncState 键）
    loadSourceState: (id) => loadSyncState(requireAdapter(deps), id, revSeal(requireStore(deps))),
    saveSourceState: (id, st) => saveSyncState(requireAdapter(deps), id, st, revSeal(requireStore(deps))),
    deviceId: () => loadDeviceId(requireAdapter(deps)),
    // KDF 档位（备份设置所选）：云上传/冲突副本 envelope 生成口径与本地备份一致
    kdfProfile: () => kdfProfileOf(deps),
    autoPrefs: {
      get: () => loadCloudPrefs(),
      set: (p) => persistCloudPrefs(p),
    },
    loadAutoStatus: async () => readAutoStatusText(CLOUD_AUTO_STATUS_KEY),
  }
}

export function createDesktopCloudSync(deps: CloudPlatformDeps) {
  const { tr } = deps

  /** keep 源远端滚动删除的待并入提示（runner 顺序保证：先逐源 onRetentionDeleted 后 recordStatus，
   *  状态写盘前拼入 summary 并清空，不跨轮残留） */
  let retentionNotes: string[] = []

  /** 源 id→名称进程内缓存（审查 I4：runner sourceName 同步解析显示名用）；runner 每轮 loadSources
   *  装配时刷新（summary/onRetentionDeleted 均在其后，缓存必已就绪）；取不到回退 id */
  const cloudSourceNames = new Map<string, string>()

  return createCloudSyncRunner({
    isLocked: () => deps.getStore()?.locked.value ?? true,
    getSecret: () => deps.getStore()?.backupSecret.value ?? null,
    getVaultJson: () => JSON.stringify(deps.getStore()?.vault ?? null),
    loadSources: async () => {
      const s = requireStore(deps)
      const all = await loadAllSources(deps)
      for (const x of all) cloudSourceNames.set(x.id, x.name)
      return all
        .filter((x) => x.kind !== 'local') // 云通道只装配云源（本地源归 BackupCard 通道）
        .map((x) => ({ source: x, cred: s.credsCache.value[x.id] }))
        .filter((p): p is { source: BackupSource; cred: CloudCred } => p.cred !== undefined)
    },
    // rev 基线（spec §1.2）+ DEK seal 静态保护（T9 装配约定 5：baseSnapshot 明文落盘问题的修复）
    loadSyncState: (id) => loadSyncState(requireAdapter(deps), id, revSeal(requireStore(deps))),
    saveSyncState: (id, st) => saveSyncState(requireAdapter(deps), id, st, revSeal(requireStore(deps))),
    // 内容门持久基线（spec §1.3）：localStorage 键 cloudContentHash（跨会话/页面重开生效）
    loadContentHash: async () => readCloudContentHash(),
    saveContentHash: async (h) => writeCloudContentHash(h),
    deviceId: () => loadDeviceId(requireAdapter(deps)),
    makeBackend: (cred) => createCloudBackend(cred),
    persistAdopted: (json) => replaceAllOps(deps, JSON.parse(json) as Vault),
    // 审查 I9：Promise 原样交回 runner/core（syncWithCloudRev await 冲突回调）——写盘失败让该目标
    // 同步失败（recordStatus 记失败），不再静默吞掉后照常采纳远端并回推覆盖云端旧版本
    saveConflictBackup: (key, bytes) => saveConflictBackupToDir(bytes, null, key),
    kdfProfile: () => kdfProfileOf(deps),
    sourceName: (id) => cloudSourceNames.get(id) ?? id,
    // D2 抽串：runner 状态摘要经注入 t() 记录时取词（tr 内部读 locale ref；runner 回调均在 i18n 装入后触发）
    t: (key, params) => tr(key, params),
    onRetentionDeleted: (name, deleted) => {
      // D2 抽串：记录时取词（摘要持久化于 cloudAutoStatus，展示端按落盘内容显示）
      retentionNotes.push(deleted >= 0 ? tr('desktop.retentionCleaned', { name, count: deleted }) : tr('desktop.retentionUnsupported', { name }))
    },
    recordStatus: (ok, summary) => {
      const notes = retentionNotes.join(tr('desktop.noteSep'))
      retentionNotes = []
      recordAutoStatus(CLOUD_AUTO_STATUS_KEY, ok, notes ? `${summary}${tr('desktop.noteSep')}${notes}` : summary)
    },
    // 条目冲突入库桥（spec §3/§4）：fire-and-forget，入库失败不影响同步结果（下轮合并重报）
    onMergeConflicts: (conflicts) => {
      void requireStore(deps).addMergeConflictsOp(conflicts).catch((err) => console.warn('[cloudAutoSync] 冲突记录入库失败', err))
    },
    // 未裁决冲突计数（宿主闭包读 store.conflictCount）
    conflictCount: () => deps.getStore()?.conflictCount.value ?? 0,
    // 冲突强提示（spec §4 应用内横幅）：desktop=SyncPage 健康条 SyncHealthBar 徽标高亮（store
    // conflictCount 同源），此处留 console 留痕；托盘 tooltip 计数不做，记 backlog
    onConflicts: (count) => {
      console.info('[cloudAutoSync] 未裁决同步冲突:', count)
    },
    // 手动合并预览确认（spec §4，T11）：经 cloudSyncBridge 挂起征询 → CloudCard 的
    // MergePreviewDialog 打开，组件事件 settle 结清（取消/卸载=false，runner 记跳过态）
    onManualConfirm: (preview) => requestMergeConfirm(preview),
    // 逐源进度（spec §5 ⑥，T11）：经 cloudSyncBridge → CloudCard「x/y 源完成」spinner
    onProgress: (done, total) => setSyncProgress(done, total),
    onError: (err) => console.warn('[cloudAutoSync]', err),
  })
}
