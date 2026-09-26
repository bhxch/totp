import {
  loadDeviceId, loadSources, loadSyncState, saveSyncState,
  type BackupSource, type CloudCred, type StorageAdapter, type Vault,
} from '@totp/core'
// ui 基建(runner 编排/OAuth backend/确认与进度桥)经包名自引用导入(Node/TS 支持包名自引用):
// 两端宿主测试对 '@totp/ui' 的 vi.mock 是唯一拦截点(cloudPlatforms.test/cloudRunnerFactory.test
// 以桩捕获 runner deps 并直调接线成员;相对路径导入不命中 vi.mock,已实测);生产为无害 ESM
// 循环(index 纯 re-export,此处仅函数体内解引 live binding)。
import { createCloudBackend, createCloudSyncRunner, requestMergeConfirm, setSyncProgress } from '@totp/ui'
import type { VueStore } from '../store'
import { requireRef, toGetter, type HostRef } from './internal'
import { createRevSeal } from './revSeal'

/**
 * overrides 差异点清单(R4 纪律:仅已核实差异进 overrides):
 * 同型成员(内置,17)= isLocked/getSecret/getVaultJson(实时读 store,未就绪中性兜底:锁定/
 * 无 secret/'null' 快照)/loadSources(装配「启用云源×保管区凭据」对:滤 local、无凭据跳过——
 * 锁定态 credsCache 为空自然全跳过;显示名缓存每轮刷新,审查 I4)/loadSyncState/saveSyncState
 * (rev 基线 + DEK seal,与手动通道共用 createRevSeal)/deviceId/makeBackend(五后端 switch)/
 * persistAdopted(replaceAllOp)/kdfProfile/sourceName/onMergeConflicts(fire-and-forget)/
 * conflictCount/onManualConfirm/onProgress/onError/onAuthFailure(条件注册)/run 包装。
 * 注入差异(6 必选 + 1 可选 + 1 标志,全部已核实):
 * - t(非差异、必选注入):runner 状态摘要/retention 提示记录时取词,两端签名同型但绑定各自 i18n;
 * - contentHash(存储通道):desktop=localStorage cloudContentHash;extension=storage.local 同名键;
 * - saveConflictBackup(已核实差异「目录冲突副本」):desktop=AppData 目录文件(返回名随 outcome
 *   透传);extension=storage.local 列表滚动删;
 * - retentionNote(文案键):extension=cloudAuto.retention*(deleted=0 不提示);desktop=
 *   desktop.retention*(deleted=0 照记);
 * - recordStatus(分隔符+写盘通道):desktop=localStorage cloudAutoStatus(desktop.noteSep);
 *   extension=storage.local 同名键(cloudAuto.noteSep);notes 收集/清空顺序语义由工厂内置;
 * - onConflicts(已核准差异「badge/横幅通道」):extension=storage.local cloudConflictCount 跨
 *   上下文通道 + action badge「!」;console 留痕由工厂内置(两端逐字);
 * - authFailureThrows(extension 独有「authError 包装」):true 时 onAuthFailure 暂存消息/状态码,
 *   run resolve 后转 reject(status 挂错误对象,审查 I2 结构化判定)——syncScheduler 凭据失效
 *   分类(停轮询)依赖 reject 感知;desktop 无跟随调度器,不传=不注册收集器、run 无包装
 *   (core 对目标级失败本就不抛错,可观测行为与原装配一致)。
 * overrides 键数 8 ≪ deps 同型成员 17 → 该工厂可抽。
 */

export interface CloudRunnerOverrides {
  /** 状态摘要/清理提示翻译器(D2 抽串:记录时取词,随 locale 联动;摘要持久化后不回填) */
  t(key: string, params?: Record<string, unknown>): string
  /** auto 内容门持久基线(spec §1.3):上次成功同步的规范化内容 hash,null=删键(下轮全量重试) */
  contentHash: { load(): Promise<string | null>; save(h: string | null): Promise<void> }
  /** 冲突副本落盘(key=源 id)。审查 I9:Promise 原样交回 core await——写盘拒绝 → 该目标同步失败 */
  saveConflictBackup(key: string, bytes: Uint8Array): Promise<string | null | void>
  /** keep 源远端滚动删除提示(deleted>0=清理 N 份 / 0=无信息量可不提示 / <0=后端不支持哨兵);
   *  返回 null 不并入状态摘要 */
  retentionNote(name: string, deleted: number): string | null
  /** 「上次自动同步」状态记录(ok 三态:true/false/null=跳过;design §4.1 {at, ok, summary})。
   *  notes=本轮 retention 提示(工厂保证先逐源 onRetentionDeleted 后 recordStatus、消费即清空
   *  不跨轮残留),拼接分隔符与写盘通道由宿主定 */
  recordStatus(ok: boolean | null, summary: string, notes: readonly string[]): void
  /** 冲突强提示宿主通道(spec §4;console 留痕内置):0=全部裁决或无冲突。缺省仅 console */
  onConflicts?(count: number): void
  /** 凭据失效转 run reject(extension 独有,T4):见文件头 overrides 清单 */
  authFailureThrows?: boolean
}

/**
 * store 直驱云同步 runner 装配(R4 自两端收敛;返回 { run } 形状不变,ui createCloudSyncRunner
 * 同一编排,D6 共享实现)。锁定态零网络:runner 内部 isLocked/无 secret 直接 return,调用侧
 * 调度器 gate 双保险。
 */
export function createCloudSyncRunnerForStore(
  store: HostRef<VueStore>,
  adapter: HostRef<StorageAdapter>,
  overrides: CloudRunnerOverrides,
): { run(mode?: 'auto' | 'manual' | 'pull'): Promise<void> } {
  const o = overrides
  const storeOf = toGetter(store)
  const adapterOf = toGetter(adapter)
  const requireStore = (): VueStore => requireRef(storeOf)
  const requireAdapter = (): StorageAdapter => requireRef(adapterOf)

  /** keep 源远端滚动删除的待并入提示(runner 顺序保证:先逐源 onRetentionDeleted 后 recordStatus,
   *  状态写盘前拼入 summary 并清空,不跨轮残留) */
  let retentionNotes: string[] = []

  /** 源 id→名称进程内缓存(审查 I4:runner sourceName 同步解析显示名用);runner 每轮 loadSources
   *  装配时刷新(summary/onRetentionDeleted 均在其后,缓存必已就绪);取不到回退 id */
  const cloudSourceNames = new Map<string, string>()

  /** 本轮凭据失效消息与状态码(T4):runner 经 onAuthFailure 上抛,包装 run 在 resolve 后转 reject
   *  (仅 authFailureThrows 注册收集器——desktop 无调度器依赖 reject,可观测行为不变) */
  let authError: string | null = null
  let authStatus: number | undefined

  const runner = createCloudSyncRunner({
    isLocked: () => storeOf()?.locked.value ?? true,
    getSecret: () => storeOf()?.backupSecret.value ?? null,
    getVaultJson: () => JSON.stringify(storeOf()?.vault ?? null),
    loadSources: async () => {
      const s = requireStore()
      const all = await loadSources(requireAdapter())
      for (const x of all) cloudSourceNames.set(x.id, x.name)
      return all
        .filter((x) => x.kind !== 'local') // 云通道只装配云源(本地源归 BackupCard 通道)
        .map((x) => ({ source: x, cred: s.credsCache.value[x.id] }))
        .filter((p): p is { source: BackupSource; cred: CloudCred } => p.cred !== undefined)
    },
    // rev 基线(spec §1.2)+ DEK seal 静态保护(baseSnapshot 明文落盘问题的修复)
    loadSyncState: (id) => loadSyncState(requireAdapter(), id, createRevSeal(requireStore())),
    saveSyncState: (id, st) => saveSyncState(requireAdapter(), id, st, createRevSeal(requireStore())),
    loadContentHash: () => o.contentHash.load(),
    saveContentHash: (h) => o.contentHash.save(h),
    deviceId: () => loadDeviceId(requireAdapter()),
    makeBackend: (cred) => createCloudBackend(cred),
    persistAdopted: (json) => requireStore().replaceAllOp(JSON.parse(json) as Vault),
    saveConflictBackup: (key, bytes) => o.saveConflictBackup(key, bytes),
    // KDF 档位(备份设置所选):云上传/冲突副本 envelope 生成口径与本地备份一致;未就绪兜底 balanced
    kdfProfile: () => storeOf()?.settings.backupKdfProfile ?? 'balanced',
    sourceName: (id) => cloudSourceNames.get(id) ?? id,
    t: o.t,
    onRetentionDeleted: (name, deleted) => {
      const note = o.retentionNote(name, deleted)
      if (note) retentionNotes.push(note)
    },
    recordStatus: (ok, summary) => {
      const notes = retentionNotes
      retentionNotes = []
      o.recordStatus(ok, summary, notes)
    },
    // 条目冲突入库桥(spec §3/§4):fire-and-forget,入库失败不影响同步结果(下轮合并重报)
    onMergeConflicts: (conflicts) => {
      void requireStore().addMergeConflictsOp(conflicts).catch((err) => console.warn('[cloudAutoSync] 冲突记录入库失败', err))
    },
    // 未裁决冲突计数(宿主闭包读 store.conflictCount;未就绪按 0 上报)
    conflictCount: () => storeOf()?.conflictCount.value ?? 0,
    // 冲突强提示(spec §4):console 留痕两端逐字内置;badge/横幅通道经 overrides(extension)
    onConflicts: (count) => {
      console.info('[cloudAutoSync] 未裁决同步冲突:', count)
      o.onConflicts?.(count)
    },
    // 手动合并预览确认(spec §4,T11):经 cloudSyncBridge 挂起征询 → CloudCard 的
    // MergePreviewDialog 打开,组件事件 settle 结清(取消/卸载=false,runner 记跳过态)
    onManualConfirm: (preview) => requestMergeConfirm(preview),
    // 逐源进度(spec §5 ⑥,T11):经 cloudSyncBridge → CloudCard「x/y 源完成」spinner
    onProgress: (done, total) => setSyncProgress(done, total),
    onError: (err) => console.warn('[cloudAutoSync]', err),
    ...(o.authFailureThrows
      ? {
          onAuthFailure: (msg: string, status?: number) => {
            authError = msg
            authStatus = status
          },
        }
      : {}),
  })

  if (!o.authFailureThrows) return runner

  return {
    async run(mode?: 'auto' | 'manual' | 'pull'): Promise<void> {
      authError = null
      authStatus = undefined
      await runner.run(mode)
      if (authError !== null) {
        // T4:凭据失效上抛 → syncScheduler 分类停轮询;status 挂错误对象(审查 I2 结构化判定优先)
        const err: Error & { status?: number } = new Error(authError)
        if (authStatus !== undefined) err.status = authStatus
        throw err
      }
    },
  }
}
