/**
 * desktop 云同步平台与自动云 runner 装配(R4 改造:两端同型的装配骨架下沉 @totp/ui host
 * ——createStoreBackedCloudPlatform/createCloudSyncRunnerForStore/revSeal,overrides 差异清单
 * 见 host 各文件头;本模块收敛为宿主差异薄壳 + deps 适配,导出面 createCloudPlatform/
 * createDesktopCloudSync 与 CloudPlatformDeps{getStore,getAdapter,tr} 不变,App.vue 零改动):
 * - 源元数据明文存 AppData backupSources 键;源凭据是秘密,存 DEK 保管区(store.saveSourceCredOp/
 *   removeSourceCredOp,解锁态限定,未解锁中文报错);基线按源 id 存 sourceRevs(cloudSyncState);
 *   冲突副本写 backups/conflict-{sourceId}-{ts}.totpbackup(目录文件,host 已核准差异通道);
 *   旧 cloudCreds/cloudCred/cloudRevs/cloudRev 四键由 migrateLegacyCloudSources 一次性迁移
 *   (runLegacyMigrations);采用云端数据经 store.replaceAllOp 整体替换。
 * - desktop 宿主差异(host overrides 注入):saveSources 合并写保留并发本地源(BackupCard 并发
 *   通道,审查 I11)/autoPrefs 与内容门基线走 localStorage/冲突副本目录文件/recordStatus 写盘
 *   经 recordAutoStatus(desktop.noteSep 分隔)。desktop 无跟随调度器,不传 authFailureThrows
 *   (凭据失效不转 run reject,可观测行为与原装配一致)。
 * deps 以 getStore/getAdapter/tr 注入(闭包实时读取,未就绪中文报错语义由 host requireRef 收敛)。
 */
import type { StorageAdapter } from '@totp/core'
import type { CloudPlatform, VueStore } from '@totp/ui'
// host 工厂经 '@totp/ui/host' 子出口导入(不经主出口:宿主测试对 '@totp/ui' 的全量 vi.mock
// 只需覆盖宿主直接消费的 runner/桥四件;host 内部自引用 '@totp/ui' 命中同一 mock,见 host/index.ts)
import { createCloudSyncRunnerForStore, createStoreBackedCloudPlatform, createRevSeal } from '@totp/ui/host'
import { saveConflictBackupToDir, saveCloudSourcesPreservingLocal } from './backupService'
import {
  CLOUD_AUTO_STATUS_KEY, loadCloudPrefs, persistCloudPrefs, readAutoStatusText, recordAutoStatus,
  readCloudContentHash, writeCloudContentHash,
} from './desktopPrefs'
import { requireAdapter } from './storeAccess'

export interface CloudPlatformDeps {
  /** store 浅包装实时读取（未就绪 null → 平台方法「数据尚未就绪」中文报错） */
  getStore(): VueStore | null
  /** adapter 实时读取（onMounted createTauriFs 后赋值） */
  getAdapter(): StorageAdapter | null
  /** 壳层取词（runner 状态摘要/retention 提示记录时取词，随 locale 联动） */
  tr(key: string, params?: Record<string, unknown>): string
}

/** rev 基线 seal:实现收敛至 ui host(R4);手动通道与 runner 通道共用同一 seal(共享
 *  cloudSyncState 键,缺 seal 侧会把密文当明文 bag 互踩并泄漏 baseSnapshot) */
export { createRevSeal as revSeal }

/** saveSources 宿主实现就绪断言收敛至 storeAccess(host 工厂内置 require 覆盖不到的 override 通道) */

export function createCloudPlatform(deps: CloudPlatformDeps): CloudPlatform {
  return createStoreBackedCloudPlatform(
    () => deps.getStore(),
    () => deps.getAdapter(),
    {
      // 审查 I11：合并写入——保留并发改动中的本地源（BackupCard 通道），仅覆盖本卡提交的云源列表
      saveSources: (list) => saveCloudSourcesPreservingLocal(requireAdapter(deps.getAdapter), list),
      saveConflictBackup: async (key, bytes) => saveConflictBackupToDir(bytes, key),
      autoPrefs: {
        get: () => loadCloudPrefs(),
        set: (p) => persistCloudPrefs(p),
      },
      loadAutoStatus: async () => readAutoStatusText(CLOUD_AUTO_STATUS_KEY),
      // ③ 每源代理：desktop reqwest 支持 per-request 代理，CloudCredFields 渲染代理控件
      proxySupport: true,
    },
  )
}

export function createDesktopCloudSync(deps: CloudPlatformDeps) {
  const { tr } = deps
  return createCloudSyncRunnerForStore(
    () => deps.getStore(),
    () => deps.getAdapter(),
    {
      // D2 抽串：runner 状态摘要经注入 t() 记录时取词（tr 内部读 locale ref；runner 回调均在 i18n 装入后触发）
      t: (key, params) => tr(key, params),
      // 内容门持久基线（spec §1.3）：localStorage 键 cloudContentHash（跨会话/页面重开生效）
      contentHash: { load: async () => readCloudContentHash(), save: async (h) => writeCloudContentHash(h) },
      // 审查 I9：Promise 原样交回 runner/core（syncWithCloudRev await 冲突回调）——写盘失败让该目标
      // 同步失败（recordStatus 记失败），不再静默吞掉后照常采纳远端并回推覆盖云端旧版本
      saveConflictBackup: (key, bytes) => saveConflictBackupToDir(bytes, key),
      // D2 抽串：记录时取词（摘要持久化于 cloudAutoStatus，展示端按落盘内容显示）
      retentionNote: (name, deleted) =>
        deleted >= 0 ? tr('desktop.retentionCleaned', { name, count: deleted }) : tr('desktop.retentionUnsupported', { name }),
      recordStatus: (ok, summary, notes) => {
        const sep = tr('desktop.noteSep')
        const joined = notes.join(sep)
        recordAutoStatus(CLOUD_AUTO_STATUS_KEY, ok, joined ? `${summary}${sep}${joined}` : summary)
      },
    },
  )
}
