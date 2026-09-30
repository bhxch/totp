import {
  loadDeviceId, loadSources, loadSyncState, saveSyncState,
  type BackupSource, type CloudCred, type Seal, type StorageAdapter, type Vault,
} from '@totp/core'
import type { CloudAutoPrefs, CloudPlatform } from '../components/cloudPlatform'
import type { VueStore } from '../store'
import { requireRef, toGetter, type HostRef } from './internal'
import { createRevSeal } from './revSeal'

/**
 * overrides 差异点清单(R4 纪律:仅已核实差异进 overrides):
 * 同型成员(内置,10)= loadSources(读全集滤 local,本卡仅消费云源)/saveCred/removeCred
 * (store 保管区 op)/creds(credsCache 只读视图 getter)/readVaultJson/persistDownloaded
 * (store.replaceAllOp 整体替换)/loadSourceState/saveSourceState(rev 基线 + DEK seal)/
 * deviceId/kdfProfile。
 * 注入差异(8 键 = 2 必选 + 6 可选,全部已核实):
 * - saveSources(必):desktop=合并写保留并发本地源(BackupCard 并发通道);extension=core
 *   saveSources 直写(无本地源);
 * - autoPrefs(必,存储通道):desktop=localStorage;extension=storage.local 异步+进程内缓存;
 * - saveConflictBackup(已核实差异「目录冲突副本」):desktop=AppData 目录文件(返回副本名);
 *   extension=storage.local 列表滚动删;
 * - loadAutoStatus(存储通道):desktop 同步 localStorage 不取词;extension 异步 + 展示时取词;
 * - listConflictCopies / exportConflictCopy:extension 独有能力(T11 冲突区块),缺省不渲染副本区;
 * - onManualSynced:extension 独有(凭据失效警示恢复闭环,属 badge/横幅通道族);
 * - proxySupport(③ 每源代理能力声明):desktop true(reqwest 生效);extension false(浏览器无法
 *   per-request 代理,UI 不渲染代理控件);缺省 false。
 * overrides 键数 8 ≪ 字面量成员 18(同型 10)→ 该工厂可抽。
 */

export interface StoreBackedCloudPlatformOverrides {
  /** 持久化云源列表(两端通道不同):审查 I11 语义由 desktop 实现自带(保留并发本地源) */
  saveSources(list: BackupSource[]): Promise<void>
  /** 云同步自动触发偏好读写(CloudCard 自动区;get 允许异步返回,卡片 await 兼容两种形态) */
  autoPrefs: { get(): CloudAutoPrefs | Promise<CloudAutoPrefs>; set(p: CloudAutoPrefs): void | Promise<void> }
  /** 冲突副本落盘(key=源 id,参数序与 CloudRunnerOverrides.saveConflictBackup 一致防写反);
   *  返回副本名回填提示。缺省=不落副本 */
  saveConflictBackup?(key: string, bytes: Uint8Array): Promise<string | null>
  /** 「上次自动同步」状态文本(宿主自 cloudAutoStatus 键 JSON {at,ok,summary} 格式化);缺省不显示状态行 */
  loadAutoStatus?(): Promise<string | null>
  /** 冲突副本元数据列表(extension 独有);缺省=CloudCard 不渲染副本区 */
  listConflictCopies?(): Promise<Array<{ name: string; at: number }>>
  /** 手动导出冲突副本(extension 独有;无名/已滚动清理=false 交 UI 提示) */
  exportConflictCopy?(name: string): Promise<boolean>
  /** 手动同步全部目标成功回调(extension 独有,审查 I1);缺省不通知 */
  onManualSynced?(): void
  /** 每源网络代理能力声明(③):desktop true / extension false;缺省 false=CloudCredFields 不渲染代理控件 */
  proxySupport?: boolean
}

/**
 * store 直驱 CloudPlatform 装配(R4 自两端收敛;返回 CloudPlatform 形状不变)。
 * store/adapter 经 HostRef 注入(值或 getter):desktop 装配期未就绪传 getter,成员调用时
 * 实时解析,未就绪统一同步 throw「数据尚未就绪」(desktop 原语义收敛点);extension 持值直传。
 * 自审(竞态,desktop 原注释保留):自动同步在途期间用户于 CloudCard 改源/凭据,读-改-写可能
 * 互相覆盖;runner busy 只防自动与自动重叠,与手动同步的并发为已知边界,不引入跨实例锁。
 */
export function createStoreBackedCloudPlatform(
  store: HostRef<VueStore>,
  adapter: HostRef<StorageAdapter>,
  overrides: StoreBackedCloudPlatformOverrides,
): CloudPlatform {
  const storeOf = toGetter(store)
  const adapterOf = toGetter(adapter)
  const requireStore = (): VueStore => requireRef(storeOf)
  const requireAdapter = (): StorageAdapter => requireRef(adapterOf)
  const seal = (): Seal => createRevSeal(requireStore())

  return {
    // ---- 源模型成员(plan16 T13/T14;本卡仅消费云源,local 项归 BackupCard)----
    loadSources: async () => (await loadSources(requireAdapter())).filter((s) => s.kind !== 'local'),
    saveSources: (list) => overrides.saveSources(list),
    saveCred: (id, cred) => requireStore().saveSourceCredOp(id, cred),
    removeCred: (id) => requireStore().removeSourceCredOp(id),
    // getter 形态:CloudCard 渲染/回调按 id 动态读取(p.creds[id]),锁定清空/解锁装载/保存后即时可见
    get creds() { return requireStore().credsCache.value },
    readVaultJson() {
      return JSON.stringify(requireStore().vault)
    },
    persistDownloaded: (json) => requireStore().replaceAllOp(JSON.parse(json) as Vault),
    saveConflictBackup: overrides.saveConflictBackup
      ? (key, bytes) => overrides.saveConflictBackup!(key, bytes)
      : undefined,
    ...(overrides.listConflictCopies ? { listConflictCopies: overrides.listConflictCopies } : {}),
    ...(overrides.exportConflictCopy ? { exportConflictCopy: overrides.exportConflictCopy } : {}),
    // rev 基线(spec §1.2)+ DEK seal 静态保护:与 runner 通道共用同一 revSeal(共享 cloudSyncState 键)
    loadSourceState: (id) => loadSyncState(requireAdapter(), id, seal()),
    saveSourceState: (id, st) => saveSyncState(requireAdapter(), id, st, seal()),
    deviceId: () => loadDeviceId(requireAdapter()),
    // KDF 档位(备份设置所选):云上传/冲突副本 envelope 生成口径与本地备份一致;未就绪兜底 balanced
    kdfProfile: () => storeOf()?.settings.backupKdfProfile ?? 'balanced',
    autoPrefs: overrides.autoPrefs,
    ...(overrides.loadAutoStatus ? { loadAutoStatus: overrides.loadAutoStatus } : {}),
    ...(overrides.onManualSynced ? { onManualSynced: overrides.onManualSynced } : {}),
    proxySupport: overrides.proxySupport,
  }
}
