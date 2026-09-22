/**
 * 扩展宿主云同步 runner 工厂（跨端同步 T2）：从 options App.vue 抽出 createCloudSyncRunner
 * 的装配（原 options 独享 → popup/options 共用），两宿主差异仅 i18n t 注入。
 * - popup：打开时/解锁时单次跟随拉取（run('pull')，syncScheduler intervalMs=null）；
 * - options：存活期自动云同步（既有 createAutoRunScheduler change/interval 通道，run() 推拉）+
 *   跟随调度（run('pull')，spec §1.3 pull-only 只读形态）。
 * T9/10 装配约定落实：
 * - rev 基线 seal（spec §1.2 静态保护）：loadSyncState/saveSyncState 接 store 的 DEK seal 助手——
 *   解锁态 baseSnapshot 以 DEK 加密落盘，未启用加密（seal 助手返回 null）按明文回落；
 * - 冲突副本落位改 conflictCopies 列表（storage.local，限 5 份滚动删），废除后台自动文件下载；
 * - 条目冲突入库/计数桥：onMergeConflicts → store.addMergeConflictsOp；conflictCount →
 *   store.conflictCount；onConflicts → storage.local 'cloudConflictCount'（跨上下文通道）+
 *   action badge「!」（conflictBadge，存在性守卫）+ console 留痕；
 * - onManualConfirm/onProgress（T11）→ cloudSyncBridge：manual 合并预览经 CloudCard 对话框裁定，
 *   逐源进度驱动 CloudCard「x/y 源完成」。
 * 锁定态零网络：runner 内部 isLocked/无 secret 直接 return（cloudRunner 守护），调用侧
 * syncScheduler gate 双保险。
 */
import { loadDeviceId, loadSyncState, saveSyncState, type BackupSource, type CloudCred, type Seal, type SourceSyncState, type Vault } from '@totp/core'
import { createCloudBackend, createCloudSyncRunner, requestMergeConfirm, setSyncProgress, type VueStore } from '@totp/ui'
import { setConflictBadge } from './conflictBadge'
import { loadSourcesImpl, retentionDeletedNote } from './cloudCredStore'
import { addConflictCopy } from './conflictCopies'
import { storageAdapter } from './store'

export interface ExtensionCloudRunnerDeps {
  /** 宿主 store（locked/backupSecret/vault/credsCache/settings/replaceAllOp 均取自它） */
  store: VueStore
  /** 状态摘要/清理提示翻译器（options=i18n.global.t 包装；popup=useI18n t 包装，同签名） */
  t(key: string, params?: Record<string, unknown>): string
}

/** rev 基线 seal（spec §1.2 静态保护，T9 装配约定 5）：解锁态经 store DEK 加密；seal 助手未启用
 *  加密（返回 null）按明文回落，与 core syncState「seal 缺省=明文库明文落盘」语义对齐；锁定抛
 *  'vault locked'（在途锁定不得明文回落，落盘整体失败按下轮重做处理）。
 *  unseal 不可解（换 DEK/明文记录）回落原文——core 解析层自然判废（明文可解析=兼容读取，
 *  密文垃圾解析失败=回落空态）。
 *  导出供 options App.vue 的 CloudCard 手动通道（cloudPlatform.loadSourceState/saveSourceState）
 *  共用——与 runner 通道同一 seal 形态，共享 cloudSyncState 键互不互踩（审查 Critical 1）。 */
export function revSeal(store: VueStore): Seal {
  return {
    seal: async (plain) => (await store.sealWithDek(plain)) ?? plain,
    unseal: async (sealed) => (await store.unsealWithDek(sealed)) ?? sealed,
  }
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
    // rev 基线（spec §1.2）+ DEK seal 静态保护（baseSnapshot 明文落盘问题的修复）
    loadSyncState: (id): Promise<SourceSyncState> => loadSyncState(storageAdapter, id, revSeal(store)),
    saveSyncState: (id, st) => saveSyncState(storageAdapter, id, st, revSeal(store)),
    // 内容门持久基线（spec §1.3）：storage.local 键 cloudContentHash
    loadContentHash: () => storageAdapter.get('cloudContentHash'),
    saveContentHash: async (h) => {
      if (h === null) await storageAdapter.delete('cloudContentHash')
      else await storageAdapter.set('cloudContentHash', h)
    },
    deviceId: () => loadDeviceId(storageAdapter),
    makeBackend: (cred) => createCloudBackend(cred),
    persistAdopted: (json) => store.replaceAllOp(JSON.parse(json) as Vault),
    // 冲突副本入 storage.local 列表（spec §4，限 5 份滚动删）：不再自动触发浏览器下载，
    // 导出仅由 UI 显式调用 exportConflictCopy。Promise 原样交回 core（写失败=该目标同步失败）
    saveConflictBackup: (key, bytes) => addConflictCopy(storageAdapter, bytes, key),
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
    // 条目冲突入库桥（spec §3/§4）：fire-and-forget，入库失败不影响同步结果（下轮合并重报）
    onMergeConflicts: (conflicts) => {
      void store.addMergeConflictsOp(conflicts).catch((err) => console.warn('[cloudAutoSync] 冲突记录入库失败', err))
    },
    // 未裁决冲突计数（宿主闭包读 store.conflictCount）
    conflictCount: () => store.conflictCount.value,
    // 冲突强提示（spec §4 badge/横幅）：storage.local 跨上下文通道（popup/后台读取）+ action
    // badge「!」（T11，存在性守卫见 conflictBadge）+ console 留痕；横幅本体=SyncPage 健康条/CloudCard 冲突区块
    onConflicts: (count) => {
      console.info('[cloudAutoSync] 未裁决同步冲突:', count)
      void storageAdapter.set('cloudConflictCount', JSON.stringify(count)).catch(() => {})
      setConflictBadge(count)
    },
    // 手动合并预览确认（spec §4，T11）：经 cloudSyncBridge 挂起征询 → CloudCard 的
    // MergePreviewDialog 打开，组件事件 settle 结清（取消/卸载=false，runner 记跳过态）
    onManualConfirm: (preview) => requestMergeConfirm(preview),
    // 逐源进度（spec §5 ⑥，T11）：经 cloudSyncBridge → CloudCard「x/y 源完成」spinner
    onProgress: (done, total) => setSyncProgress(done, total),
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
