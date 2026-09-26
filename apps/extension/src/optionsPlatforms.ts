/**
 * options 页宿主装配(R4 自 App.vue 抽出,循 cloudRunnerFactory 先例,装配可脱离组件单测;
 * popup 共用其中 followScheduler/clipboardClear 通道):App.vue 留生命周期接线(store/i18n/
 * 调度器启停/迁移编排/badge 对账),平台装配在此。
 * 跨端共性已下沉 @totp/ui host(overrides 差异清单见各工厂文件头),本模块承载 extension
 * 差异注入与 extension 独有平台(backup/sync/schemes):
 * - cloudPlatform:createStoreBackedCloudPlatform + extension 差异(storage.local 通道、冲突副本
 *   列表、loadAutoStatus 展示时取词、onManualSynced 恢复闭环);
 * - securityPlatform:createSecurityOpsFromStore + extension 差异(popup 关窗延迟、
 *   lockOnRestart 不支持——DEK 存 ext.storage.session,浏览器退出必清,两取值行为一致);
 * - createFollowScheduler:popup/options 跟随拉取调度装配(7 依赖同型 5:isUnlocked/onUnlocked/
 *   runPull 形态/autoFollowEnabled/onError 逐字;差异 2:intervalMs 轮询间隔、onAuthFailed
 *   凭据失效通知;runPull 的 runner 实例由宿主持有故经 opts 注入)。desktop 无跟随调度器,
 *   该共性为 extension 内部两宿主共性,调度器本体(syncScheduler)为 extension 既有可单测模块。
 */
import {
  backupFileName, base64ToBytes, createBackupEnvelope, normalizeSchemes, openBackupEnvelope, OVERWRITE_NAME,
  SCHEMES_KEY,
  type BackupEnvelope, type BackupSource, type ImportScheme, type Retention, type StorageAdapter,
} from '@totp/core'
import {
  CLIPBOARD_CLEAR_DELAY_MS,
  type BackupPlatform, type CloudAutoPrefs, type CloudPlatform, type ImportSchemesApi, type SecurityPlatform,
  type SyncPlatform, type VueStore,
} from '@totp/ui'
// host 工厂经 '@totp/ui/host' 子出口导入(理由见 host/index.ts 头注释)
import { createSecurityOpsFromStore, createStoreBackedCloudPlatform, downloadBlob } from '@totp/ui/host'
import { ref, watch } from 'vue'
import { formatAutoStatusText, saveSourcesImpl, type TranslateFn } from './cloudCredStore'
import { addConflictCopy, exportConflictCopy, listConflictCopies } from './conflictCopies'
import { canOffscreen, ext } from './extApi'
import { createSyncScheduler, type SyncScheduler } from './syncScheduler'
import { markSyncOff, SYNC_STATUS_KEY } from './syncEngine'
import { storageAdapter } from './store'

/** 宿主取词(与 runner deps.t 同签名) */
type Tr = (key: string, params?: Record<string, unknown>) => string

// ---------- 跟随拉取调度(popup/options 共用,跨端同步 T2)----------

export interface FollowSchedulerOptions {
  /** 跟随拉取通道(pull-only 只读形态):宿主经共用 runner 工厂装配,实例由宿主持有 */
  runPull(): Promise<unknown>
  /** 轮询间隔毫秒;null=不轮询(popup)。options=autoFollow 开启时 180s(仅 start 读取一次,
   *  开关/间隔变更由宿主 watch stop+start 重建) */
  intervalMs(): number | null
  /** [可选] 凭据失效通知(T4):popup 仅留痕;options 置宿主 ref → SyncCard 重授权警示 */
  onAuthFailed?(): void
}

/** 跟随拉取调度器装配:解锁边沿 + 轮询,经 syncScheduler gate(锁定态零网络)。gate 每次触发现读
 *  settings(响应式),开关关闭后即时静默;autoFollowEnabled 口径两端逐字(autoFollow !== false) */
export function createFollowScheduler(store: VueStore, opts: FollowSchedulerOptions): SyncScheduler {
  return createSyncScheduler({
    isUnlocked: () => !store.locked.value,
    onUnlocked: (cb) => watch(store.locked, (v) => { if (!v) cb() }),
    runPull: opts.runPull,
    autoFollowEnabled: () => store.settings.syncPrefs.autoFollow !== false,
    intervalMs: opts.intervalMs,
    onError: (e) => console.warn('[syncFollow]', e),
    onAuthFailed: opts.onAuthFailed,
  })
}

// ---------- 复制后清剪贴板(popup/options 逐字共用)----------

/**
 * 30s 清剪贴板:统一走 background(alarms+offscreen) 承载(popup 复制后即将关闭,本地定时器
 * 随窗口销毁不可靠;重复复制由同名 alarm 覆盖重置);Firefox 无 offscreen API 降级不调度
 */
export function scheduleClipboardClear(settings: { clipboardClearEnabled: boolean }): void {
  if (!settings.clipboardClearEnabled) return
  if (!canOffscreen()) return
  void ext!.runtime.sendMessage({ type: 'schedule-clipboard-clear', delayMs: CLIPBOARD_CLEAR_DELAY_MS }).catch(() => {})
}

// ---------- 自动云同步偏好通道(cloudAutoPrefs 键,storage.local 异步读写)----------

const CLOUD_AUTO_PREFS_KEY = 'cloudAutoPrefs'
const DEFAULT_CLOUD_AUTO_PREFS: CloudAutoPrefs = { onChange: false, onInterval: false, intervalMinutes: 60 }

/** 归一化(与 desktop loadCloudPrefs 同口径):缺失位 false;间隔非法/<15 回退 60(匹配调度器 30s tick 粒度) */
function normalizeCloudAutoPrefs(parsed: unknown): CloudAutoPrefs {
  const p = (parsed ?? {}) as Partial<CloudAutoPrefs>
  const minutes = Number(p.intervalMinutes)
  return {
    onChange: p.onChange === true,
    onInterval: p.onInterval === true,
    intervalMinutes: Number.isInteger(minutes) && minutes >= 15 ? minutes : DEFAULT_CLOUD_AUTO_PREFS.intervalMinutes,
  }
}

export interface CloudAutoPrefsChannel {
  /** 进程内缓存同步读:storage.local 异步读进不了同步 get()/intervalMs 回调——挂载时 refresh 一次、
   *  set 时双写;页面打开期间他端/跨页对 storage 的直改需待下次挂载才可见(容忍滞后,已知边界) */
  get(): CloudAutoPrefs
  /** 挂载时读盘填充缓存(坏 JSON/读取失败保持缓存现值) */
  refresh(): Promise<void>
  /** 先更缓存再异步落盘:guard/intervalMs 立即按新值生效 */
  set(p: CloudAutoPrefs): Promise<void>
}

export function createCloudAutoPrefsChannel(adapter: StorageAdapter): CloudAutoPrefsChannel {
  let cache: CloudAutoPrefs = { ...DEFAULT_CLOUD_AUTO_PREFS }
  return {
    get: () => cache,
    async refresh() {
      try {
        const raw = await adapter.get(CLOUD_AUTO_PREFS_KEY)
        if (raw) cache = normalizeCloudAutoPrefs(JSON.parse(raw))
      } catch { /* 坏 JSON/读取失败保持缓存现值 */ }
    },
    async set(p) {
      cache = p
      await adapter.set(CLOUD_AUTO_PREFS_KEY, JSON.stringify(p))
    },
  }
}

// ---------- 云同步平台(createStoreBackedCloudPlatform + extension 差异)----------

export interface OptionsCloudPlatformDeps {
  store: VueStore
  /** 状态文本取词(loadAutoStatus 展示时取词,summary 原文为记录时翻译不回填) */
  t: Tr
  /** 自动云偏好通道(宿主持有:scheduler guard 同源读) */
  autoPrefs: CloudAutoPrefsChannel
  /** 审查 I1 恢复闭环:手动同步全部目标成功 → 复位凭据失效警示并重启跟随轮询 */
  onManualSynced?(): void
}

export function createOptionsCloudPlatform(deps: OptionsCloudPlatformDeps): CloudPlatform {
  const { store, t, autoPrefs } = deps
  return createStoreBackedCloudPlatform(store, storageAdapter, {
    // 审查 I11 在 desktop 侧(合并写保留并发本地源);extension 无本地源,core 直写即全量语义
    saveSources: (list: BackupSource[]) => saveSourcesImpl(storageAdapter, list),
    // 冲突副本入 storage.local 列表(spec §4,限 5 份滚动删):不自动触发浏览器下载,
    // 导出仅由 UI 显式触发;sourceId 仅用于副本命名区分来源
    saveConflictBackup: (bytes, sourceId) => addConflictCopy(storageAdapter, bytes, sourceId),
    // T11 冲突区块:副本元数据列表 + 手动导出(唯一下载出口;desktop 无此二能力=不渲染副本区)
    listConflictCopies: async () => (await listConflictCopies(storageAdapter)).map((c) => ({ name: c.name, at: c.at })),
    exportConflictCopy: (name) => exportConflictCopy(storageAdapter, name),
    autoPrefs: {
      get: () => autoPrefs.get(),
      set: (p) => autoPrefs.set(p),
    },
    loadAutoStatus: async () => {
      try {
        // cloudAutoStatus 键原文 → 三态格式化纯函数(单测覆盖;审查 Minor-2 抽出)。
        // D2 R1:标签/分隔符展示时取词(cloudAuto.status*),summary 原文为记录时翻译不回填
        return formatAutoStatusText(await storageAdapter.get('cloudAutoStatus'), t as TranslateFn)
      } catch {
        return null
      }
    },
    onManualSynced: deps.onManualSynced,
  })
}

// ---------- 安全平台(createSecurityOpsFromStore + extension 差异)----------

export function createOptionsSecurityPlatform(store: VueStore): SecurityPlatform {
  return createSecurityOpsFromStore(store, {
    // 「已复制」自动关窗延迟(extension 有 popup,提供;desktop 无 popup 不渲染该输入)
    popup: {
      async setCloseDelay(ms) {
        store.settings.popupCloseDelayMs = ms
        await store.commitSettings()
      },
    },
    // 审查 Minor:lockOnRestart 在 ext 无效果(DEK 存 ext.storage.session,浏览器退出必清,
    // 两取值行为一致)——显式声明不支持,SecurityCard 隐藏「重启后保持锁定」控件防无效设置
    lockPrefsUnsupported: ['lockOnRestart'],
  })
}

// ---------- 浏览器同步平台(extension 独有)----------

export function createOptionsSyncPlatform(store: VueStore): SyncPlatform {
  const { settings, commitSettings } = store
  return {
    get syncEnabled() { return settings.syncEnabled },
    // 明文同步警示:SyncCard 据此在「开关开启且未启用加密」时提示(hasEncryption 直接暴露 ComputedRef<boolean>)
    hasEncryption: store.hasEncryption,
    async setSyncEnabled(v) {
      settings.syncEnabled = v
      await commitSettings()
      if (!v) {
        await markSyncOff().catch(() => {})
        return
      }
      // 开启同步:主动调度一次拉取(开启开关只写 local settings,不触发 background 的 onChanged('sync')；
      // 缺这次拉取,新设备开启后若不写盘将永不应用远端较新数据)。SW 未就绪/上下文失效时忽略。
      try {
        void ext!.runtime.sendMessage({ type: 'sync-pull' }).catch(() => {})
      } catch { /* 扩展上下文失效(重载中):忽略 */ }
    },
    async readStatus() {
      try {
        const raw = (await ext!.storage.local.get(SYNC_STATUS_KEY))[SYNC_STATUS_KEY]
        if (typeof raw !== 'object' || raw === null) return null
        const s = raw as { state?: unknown; at?: unknown }
        return typeof s.state === 'string' && typeof s.at === 'number' ? { state: s.state, at: s.at } : null
      } catch {
        return null
      }
    },
    canSync: !!ext?.storage.sync,
  }
}

// ---------- 备份平台(extension 独有;文件选择/Blob 下载通道)----------

/**
 * 动态 input[type=file] 选择文件(accept 指定扩展名过滤)。
 * 取消:input cancel 事件(Chromium 113+)→ null;旧内核无 cancel 事件会永挂起 → 30s 超时 reject「文件选择超时」兜底
 * (选超时而非 window focus 监听:系统文件选择器的焦点恢复语义跨内核不一致,超时是无条件、最简可靠的兜底)。
 * input 挂到 body(部分内核 detached input 不触发文件框),结算后移除。
 */
function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (f: File | null) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      input.remove()
      resolve(f)
    }
    timer = setTimeout(() => {
      if (settled) return
      settled = true
      input.remove()
      reject(new Error('文件选择超时'))
    }, 30_000)
    input.onchange = () => finish(input.files?.[0] ?? null)
    input.oncancel = () => finish(null)
    document.body.appendChild(input)
    input.click()
  })
}

// R11/R16⑪:导入扩展名单一派生来源(此前两处内联 accept 字面量,同集合不同排序)。
// 文本组+二进制组两段与 Rust 侧 apps/desktop/src-tauri/src/dialog_grants.rs 的
// IMPORT_TEXT_EXTENSIONS/IMPORT_BINARY_EXTENSIONS 一一对应,由该文件测试模块的镜像断言
// (include_str! 提取本文件同名常量)锁定集合一致,防三端漂移
const IMPORT_TEXT_EXTENSIONS = ['.json', '.jsonl', '.wauth', '.xml', '.txt', '.aegis'] as const
const IMPORT_BINARY_EXTENSIONS = ['.db', '.sqlitedb', '.sqlite', '.zip'] as const
const IMPORT_ACCEPT = [...IMPORT_TEXT_EXTENSIONS, ...IMPORT_BINARY_EXTENSIONS].join(',')

// ---------- 备份文件命名偏好(化石读取)----------
// 文件命名偏好存扩展页 localStorage(非同步内容):keep=时间戳文件名下载;overwrite=固定名下载。
// 【只读兼容化石】无设置入口(T9 后 BackupCard 已无模式切换,本地源归 desktop;扩展端全仓无写入方,
// 仅老版本用户的 localStorage 残留值仍生效);且残留值中仅 overwrite 影响下载名(keep 分支的 n
// 在 createBackup 恒走时间戳名,实际不被消费),保留读取只为不丢 overwrite 兼容
const BACKUP_MODE_KEY = 'backupMode'
const BACKUP_KEEP_N_KEY = 'backupKeepN'
const DEFAULT_KEEP_N = 3

function loadBackupMode(): Retention {
  try {
    if (localStorage.getItem(BACKUP_MODE_KEY) === 'overwrite') return { type: 'overwrite' }
    const n = Number(localStorage.getItem(BACKUP_KEEP_N_KEY))
    return { type: 'keep', n: Number.isInteger(n) && n >= 1 ? n : DEFAULT_KEEP_N }
  } catch {
    return { type: 'keep', n: DEFAULT_KEEP_N }
  }
}

export function createOptionsBackupPlatform(store: VueStore, t: Tr): BackupPlatform {
  const { settings, commitSettings, replaceAllOp } = store
  const backupMode = ref<Retention>(loadBackupMode())
  // 最后一次导入选择的 File(工厂内缓存):SQLite 字节入口复用,避免同一文件二次弹窗
  let lastImportFile: File | null = null
  const pickBackupFile = (): Promise<File | null> => pickFile('.totpbackup')
  const downloadEnvelope = (envelope: BackupEnvelope, name: string): void => {
    downloadBlob(name, new Blob([JSON.stringify(envelope, null, 2)], { type: 'application/json' }), 1_000)
  }

  return {
    async createBackup(vaultJson, password) {
      // plan16 T11.5:本地备份 envelope 按备份设置所选 KDF 档位生成(默认 balanced 兜底旧设置)
      const envelope = await createBackupEnvelope(vaultJson, password, settings.backupKdfProfile)
      const overwrite = backupMode.value.type === 'overwrite'
      const name = overwrite ? OVERWRITE_NAME : backupFileName(new Date())
      downloadEnvelope(envelope, name)
      // T9 后 BackupCard 直接展示宿主摘要:返回记录时语言文案(含文件名,诚实反映导出结果;D2 i18n)
      return overwrite ? t('options.exportedOverwrite', { name }) : t('options.exported', { name })
    },
    async restoreFromPicker(password) {
      const file = await pickBackupFile()
      if (!file) return null
      return { json: await openBackupEnvelope(JSON.parse(await file.text()), password) }
    },
    replaceAllOp: (v) => replaceAllOp(v),
    // 导入:浏览器 input file 读取文本;无 DPAPI 能力,WinAuth DPAPI 条目由 core 逐条 failure「请用桌面版」
    async readImportFile() {
      const file = await pickFile(IMPORT_ACCEPT)
      if (!file) return null
      lastImportFile = file
      return { text: await file.text(), name: file.name }
    },
    // SQLite 字节入口:文本管道会损坏二进制,复用最近一次选择的文件(File.arrayBuffer 原生读字节);
    // 无最近选择时补弹选择器
    async readImportFileBytes() {
      const file = lastImportFile ?? (await pickFile(IMPORT_ACCEPT))
      if (!file) return null
      lastImportFile = file
      return { bytes: new Uint8Array(await file.arrayBuffer()), name: file.name }
    },
    // 备份加密强度档位(plan16 T11.5):settings 持久化(跨端随设置同步;extension 无本地源,仅影响 envelope 生成)
    backupKdfProfile: {
      get: () => settings.backupKdfProfile,
      set: (p) => {
        settings.backupKdfProfile = p
        void commitSettings()
      },
    },
    // 文本导出(批① §2.3):otpauth 文本/Aegis JSON 走 Blob 下载(downloadBlob 同款 a[download] 通道);
    // 浏览器下载无「取消」回执,恒 true
    async saveTextFile(name, content) {
      downloadBlob(name, new Blob([content], { type: 'application/octet-stream' }))
      return true
    },
    // 图片导出(批① §2.5 多选二维码拼版 PNG):dataUrl 解 base64 → Blob 走同一 a[download] 通道;无「取消」回执,恒 true
    async saveImageFile(name, dataUrl) {
      const bytes = base64ToBytes(dataUrl.slice(dataUrl.indexOf(',') + 1))
      downloadBlob(name, new Blob([bytes as BlobPart], { type: 'image/png' }))
      return true
    },
  }
}

// ---------- 导入映射方案存取 ----------

/**
 * 导入映射方案存取:直读写 storageAdapter 的 SCHEMES_KEY(跨端随 storage 同步)。
 * load 容错:坏 JSON/读失败 → 空表(core normalizeSchemes 兜底解析)。
 */
export function createOptionsSchemesApi(): ImportSchemesApi {
  return {
    async load(): Promise<ImportScheme[]> {
      try {
        const raw = await storageAdapter.get(SCHEMES_KEY)
        return raw ? normalizeSchemes(JSON.parse(raw)) : []
      } catch {
        return []
      }
    },
    async save(list: ImportScheme[]): Promise<void> {
      await storageAdapter.set(SCHEMES_KEY, JSON.stringify(list))
    },
  }
}
