/**
 * 扩展宿主云同步 runner 工厂（跨端同步 T2）：从 options App.vue 抽出 createCloudSyncRunner
 * 的装配（原 options 独享 → popup/options 共用），两宿主差异仅 i18n t 注入。
 * - popup：打开时/解锁时单次跟随拉取（run('pull')，syncScheduler intervalMs=null）；
 * - options：存活期自动云同步（既有 createAutoRunScheduler change/interval 通道，run() 推拉）+
 *   跟随调度（run('pull')，跨端同步审查 C1：跟随为 pull-only 通道，远端 hash 基线去重）。
 * 锁定态零网络：runner 内部 isLocked/无 secret 直接 return（cloudRunner 守护），调用侧
 * syncScheduler gate 双保险。
 */
import { loadDeviceId, loadSourceRevs, loadSyncState, saveSourceRev, saveSyncState, type BackupSource, type CloudCred, type Vault } from '@totp/core'
import { createCloudBackend, createCloudSyncRunner, type VueStore } from '@totp/ui'
import { conflictBackupName, loadSourcesImpl, retentionDeletedNote } from './cloudCredStore'
import { storageAdapter } from './store'

export interface ExtensionCloudRunnerDeps {
  /** 宿主 store（locked/backupSecret/vault/credsCache/settings/replaceAllOp 均取自它） */
  store: VueStore
  /** 状态摘要/清理提示翻译器（options=i18n.global.t 包装；popup=useI18n t 包装，同签名） */
  t(key: string, params?: Record<string, unknown>): string
}

/** 冲突副本 Blob 下载：命名经 conflictBackupName（带 backendKey 时
 *  conflict-{backendKey}-{yyyyMMdd-HHmmss}.totpbackup，匹配 READABLE_BACKUP_RE 可恢复）。
 *  runner 自动通道与 options CloudCard 手动通道（cloudPlatform.saveConflictBackup）共用 */
export async function downloadConflictBackup(bytes: Uint8Array, backendKey?: string): Promise<string> {
  const name = conflictBackupName(backendKey, new Date())
  const blob = new Blob([bytes as BlobPart], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
  return name
}

export function createExtensionCloudRunner(deps: ExtensionCloudRunnerDeps): { run(mode?: 'auto' | 'manual' | 'pull'): Promise<void> } {
  const { store, t } = deps
  /** keep 源远端滚动删除的待并入提示（runner 顺序保证：先逐源 onRetentionDeleted 后 recordStatus，
   *  状态写盘前拼入 summary 并清空，不跨轮残留） */
  let retentionNotes: string[] = []

  /** 源 id→名称进程内缓存（审查 I4：runner sourceName 同步解析显示名用）；runner 每轮 loadSources
   *  装配时刷新（summary/onRetentionDeleted 均在其后，缓存必已就绪）；取不到回退 id */
  const cloudSourceNames = new Map<string, string>()

  /** 本轮凭据失效消息与状态码（T4）：runner 经 onAuthFailure 上抛，包装 run 在 resolve 后转 reject——
   *  core 编排对目标级失败不抛错，不转 reject 则 syncScheduler 的凭据失效分类（停轮询）永不触发。
   *  status 为 CloudHttpError 携带的数字状态码（审查 I2 结构化判定），缺省 undefined 走消息兜底 */
  let authError: string | null = null
  let authStatus: number | undefined

  const runner = createCloudSyncRunner({
    isLocked: () => store.locked.value,
    getSecret: () => store.backupSecret.value,
    getVaultJson: () => JSON.stringify(store.vault),
    loadSources: async () => {
      const sources = await loadSourcesImpl(storageAdapter)
      for (const s of sources) cloudSourceNames.set(s.id, s.name)
      return sources
        .filter((s) => s.kind !== 'local') // 云卡通道只装配云源（本地源归 BackupCard，extension 无）
        .map((s) => ({ source: s, cred: store.credsCache.value[s.id] }))
        .filter((p): p is { source: BackupSource; cred: CloudCred } => p.cred !== undefined)
    },
    loadTargetHash: async (id) => (await loadSourceRevs(storageAdapter))[id] ?? null,
    saveTargetHash: (id, h) => saveSourceRev(storageAdapter, id, h),
    // rev 基线（spec §1.2）：seal 缺省=明文落盘，DEK 静态保护随 T9 装配约定接入
    loadSourceState: (id) => loadSyncState(storageAdapter, id),
    saveSourceState: (id, st) => saveSyncState(storageAdapter, id, st),
    deviceId: () => loadDeviceId(storageAdapter),
    makeBackend: (cred) => createCloudBackend(cred),
    persistAdopted: (json) => store.replaceAllOp(JSON.parse(json) as Vault),
    saveConflictBackup: (key, bytes) => {
      void downloadConflictBackup(bytes, key).catch(() => {})
    },
    // KDF 档位（备份设置所选）：云上传/冲突副本 envelope 生成口径与本地备份一致
    kdfProfile: () => store.settings.backupKdfProfile,
    sourceName: (id) => cloudSourceNames.get(id) ?? id,
    onRetentionDeleted: (name, deleted) => {
      // 审查 Minor：deleted=0 不追加（「清理 0 份」无信息量）；负值=后端不支持远端清理。
      // D2 R1 key 化（cloudAuto.retention*）：记录时翻译——提示随 cloudAutoStatus 落盘，存什么显示什么
      const note = retentionDeletedNote(t, name, deleted)
      if (note) retentionNotes.push(note)
    },
    // D2 抽串：runner 状态摘要经注入 t() 记录时取词（i18n 在入口挂载已同步装入，回调必然晚于装入）
    t,
    // 状态记录不 await：storage 写失败不影响同步主流程。ok 三态（批 4）：true/false/null（跳过）
    recordStatus: (ok: boolean | null, summary) => {
      // D2 R1：分隔符走 cloudAuto.noteSep（对齐 desktop.noteSep，en 为 '; '）
      const notes = retentionNotes.join(t('cloudAuto.noteSep'))
      retentionNotes = []
      void storageAdapter.set('cloudAutoStatus', JSON.stringify({ at: Date.now(), ok, summary: notes ? `${summary}${t('cloudAuto.noteSep')}${notes}` : summary })).catch(() => {})
    },
    onError: (err) => console.warn('[cloudAutoSync]', err),
    onAuthFailure: (msg, status) => {
      authError = msg
      authStatus = status
    },
  })

  return {
    async run(mode?: 'auto' | 'manual' | 'pull'): Promise<void> {
      authError = null
      authStatus = undefined
      await runner.run(mode)
      if (authError !== null) {
        // T4：凭据失效上抛 → syncScheduler 分类停轮询；status 挂错误对象（审查 I2 结构化判定优先）
        const err: Error & { status?: number } = new Error(authError)
        if (authStatus !== undefined) err.status = authStatus
        throw err
      }
    },
  }
}
