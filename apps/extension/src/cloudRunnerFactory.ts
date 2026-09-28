/**
 * 扩展宿主云同步 runner 工厂(跨端同步 T2 → R4 装配下沉后为宿主差异薄壳):
 * 装配骨架(loadSources 装配对/rev 基线 seal/backend/桥接面/run 包装)由 @totp/ui host 的
 * createCloudSyncRunnerForStore 单点承载(desktop 同一编排,overrides 差异清单见其文件头),
 * 本模块仅注入 extension 已核实差异:
 * - 存储通道:storage.local(cloudContentHash 内容门/cloudAutoStatus 状态/cloudConflictCount);
 * - 冲突副本:conflictCopies 列表限 5 份滚动删(无目录文件能力,废除后台自动文件下载);
 * - 文案键:cloudAuto.noteSep/retention*(记录时翻译,提示随 cloudAutoStatus 落盘,存什么显示什么);
 * - badge 通道:onConflicts → storage.local 跨上下文通道(popup/后台读取)+ action badge「!」
 *   (conflictBadge,存在性守卫);console 留痕由 host 内置;横幅本体=SyncPage 健康条/CloudCard 冲突区块;
 * - authError 包装(T4):runner 凭据失效暂存 → run reject(status 挂错误对象,审查 I2 结构化判定)——
 *   syncScheduler 的凭据失效分类(停轮询)经 reject 感知,core 编排对目标级失败不抛错。
 * 锁定态零网络:runner 内部 isLocked/无 secret 直接 return(cloudRunner 守护),调用侧
 * syncScheduler gate 双保险。
 */
import type { VueStore } from '@totp/ui'
// host 工厂经 '@totp/ui/host' 子出口导入(理由见 host/index.ts 头注释:宿主测试对 '@totp/ui'
// 的全量 vi.mock 只需覆盖 runner/桥四件;host 内部自引用 '@totp/ui' 命中同一 mock)
import { createCloudSyncRunnerForStore } from '@totp/ui/host'
import { retentionDeletedNote } from './cloudCredStore'
import { setConflictBadge } from './conflictBadge'
import { addConflictCopy } from './conflictCopies'
import { storageAdapter } from './store'

export interface ExtensionCloudRunnerDeps {
  /** 宿主 store(locked/backupSecret/vault/credsCache/settings/replaceAllOp 均取自它) */
  store: VueStore
  /** 状态摘要/清理提示翻译器(options=i18n.global.t 包装;popup=useI18n t 包装,同签名) */
  t(key: string, params?: Record<string, unknown>): string
}

export function createExtensionCloudRunner(deps: ExtensionCloudRunnerDeps): { run(mode?: 'auto' | 'manual' | 'pull'): Promise<void> } {
  const { store, t } = deps
  return createCloudSyncRunnerForStore(store, storageAdapter, {
    t,
    // T4:凭据失效上抛 → syncScheduler 分类停轮询(恢复闭环:手动同步成功 resume())
    authFailureThrows: true,
    // 内容门持久基线(spec §1.3):storage.local 键 cloudContentHash,null=删键
    contentHash: {
      load: () => storageAdapter.get('cloudContentHash'),
      save: async (h) => {
        if (h === null) await storageAdapter.delete('cloudContentHash')
        else await storageAdapter.set('cloudContentHash', h)
      },
    },
    // 冲突副本入 storage.local 列表(spec §4):不自动触发浏览器下载,导出仅 UI 显式调用
    // exportConflictCopy。Promise 原样交回 core(写失败=该目标同步失败)
    saveConflictBackup: (key, bytes) => addConflictCopy(storageAdapter, bytes, key),
    // 审查 Minor:deleted=0 不追加(「清理 0 份」无信息量);负值=后端不支持远端清理。
    // D2 R1 key 化(cloudAuto.retention*):记录时翻译
    retentionNote: (name, deleted) => retentionDeletedNote(t, name, deleted),
    recordStatus: (ok, summary, notes) => {
      // D2 R1:分隔符走 cloudAuto.noteSep(对齐 desktop.noteSep,en 为 '; ')
      const sep = t('cloudAuto.noteSep')
      const joined = notes.join(sep)
      // 状态记录不 await:storage 写失败不影响同步主流程。ok 三态(批 4):true/false/null(跳过)
      void storageAdapter
        .set('cloudAutoStatus', JSON.stringify({ at: Date.now(), ok, summary: joined ? `${summary}${sep}${joined}` : summary }))
        .catch(() => {})
    },
    onConflicts: (count) => {
      void storageAdapter.set('cloudConflictCount', JSON.stringify(count)).catch(() => {})
      setConflictBadge(count)
    },
  })
}
