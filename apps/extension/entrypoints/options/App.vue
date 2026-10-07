<script setup lang="ts">
import { createAutoRunScheduler } from '@totp/core'
import { createAppI18n, createIconStore, LockScreen, NavigationShell, PersistErrorBanner, ToastHost, useTheme, useToast } from '@totp/ui'
import { getCurrentInstance, onMounted, onUnmounted, ref, watch } from 'vue'
import { createExtensionCloudRunner } from '../../src/cloudRunnerFactory'
import { hasLegacyCloudKeys, migrateLegacySources } from '../../src/cloudCredStore'
import { setConflictBadge } from '../../src/conflictBadge'
import {
  createCloudAutoPrefsChannel, createFollowScheduler, createOptionsBackupPlatform, createOptionsCloudPlatform,
  createOptionsSchemesApi, createOptionsSecurityPlatform, createOptionsSyncPlatform, scheduleClipboardClear,
} from '../../src/optionsPlatforms'
import { createIdleLockWatcher } from '../../src/lockEnforcer'
import { createDekSession } from '../../src/dekSession'
import { createExtensionStore, persistFailed, storageAdapter } from '../../src/store'

// spec §7 末尾：options 窗口独立解锁——windowId='options' 与 popup 隔离，各持各的 DEK。
// plan16 T12：dekPersist 接 ext.storage.session——解锁态 DEK 入会话存储，popup 经共享
// session 区自动恢复解锁；本页 initStore 时同样从 session DEK 自动解锁（重启浏览器即清）。
// onCommittedExtra：写提交 → 存活期自动云同步的变更通知（scheduler 在下方定义；写提交只会
// 发生在挂载后的异步时点，闭包引用无 TDZ 问题）
const store = createExtensionStore('options', {
  onCommittedExtra: () => scheduler.notifyChanged(),
  dekPersist: createDekSession(),
  // R16⑤ 宿主接线（评审 A2 方案 a）：落盘失败置 persistFailed，模板常驻告警条（PersistErrorBanner）
  onPersistError: (e) => {
    console.error('[store] persist failed:', e)
    persistFailed.value = true
  },
})
// D1 i18n 挂载：store 在本组件 setup 创建（页面生命周期内唯一实例），装入当前 app 供全部子组件
// useI18n/$t。appContext.app 须在 setup 同步段取；装入发生在 setup 中段，本组件自身的 script setup
// 内 useI18n() 不可用（注入尚未就绪），壳层翻译走 i18n.global.t——子组件不受限
const i18n = createAppI18n(store)
getCurrentInstance()?.appContext.app.use(i18n)
/** 壳层翻译（i18n.global.t 包装：overload 直赋 TranslateFn 不兼容，同 runner deps.t 既有包装口径；
 *  平台装配与状态格式化共用） */
const tr = (key: string, params: Record<string, unknown> = {}): string => i18n.global.t(key, params)
const { initStore, registerStorageSync, locked, hasEncryption, settings } = store

const icons = createIconStore(storageAdapter)

/** 导入映射方案存取（坏 JSON → 空表容错；R4 抽 optionsPlatforms 可脱离组件单测） */
const schemesApi = createOptionsSchemesApi()

const loadError = ref('')
/** plan16 T13 迁移提示：本次挂载/解锁迁移了 N 个旧云目标时显示（幂等重跑=0 不再提示） */
const migrateNote = ref('')
/** 审查 I6：迁移被跳过/失败后旧键仍滞留 storage 时的 UI 提示（与 migrateNote 同层展示）。
 *  未启用加密的用户迁移链走不通（saveCred 需 DEK），若无此提示云目标会静默消失、无任何解释；
 *  下次运行成功迁移（旧键删除）后检测自然为 false，提示消失 */
const legacyNote = ref('')

/** 旧数据迁移编排（plan16 T13，幂等可重复跑）：vault.backupSecret → 保管区（store op）→
 *  旧云多目标键 → 源模型 + 保管区凭据。仅解锁态执行（保管区写入需 DEK）；未启用加密时
 *  saveCred 守护抛错 → 旧键保留（先写新后删旧），待启用加密后任一次重跑自愈。
 *  审查 I6：跳过/失败不以 console.warn 收场——旧键仍在则置 legacyNote 给用户可见的出口 */
async function runLegacyMigrations(): Promise<void> {
  if (store.locked.value) return
  try {
    await store.migrateLegacySecrets()
    const n = await migrateLegacySources(storageAdapter, { saveCred: store.saveSourceCredOp })
    if (n > 0) migrateNote.value = i18n.global.t('options.migrated', { count: n })
  } catch (e) {
    console.warn('[migrate] 旧数据迁移失败（旧键保留，解锁后重试）', e)
  }
  // 成功迁移后旧键已删 → 检测为 false 提示自然消失；仍滞留（跳过/失败）→ 提示置位
  legacyNote.value = (await hasLegacyCloudKeys(storageAdapter))
    ? i18n.global.t('options.legacyNote')
    : ''
}

onMounted(async () => {
  try {
    await initStore()
    // 主题接线:initStore 成功后挂 useTheme(设置已加载为真实值;首帧属性由 html 内联脚本负责)
    useTheme(store)
    registerStorageSync()
    await icons.init()
    // 旧数据迁移（plan16 T13）：initStore 已含会话 DEK 自动恢复，解锁态在此直接跑（幂等）
    await runLegacyMigrations()
    // 自动云同步（页面存活期，勘误 §4.1）：读偏好填充缓存后启动调度器；initStore 失败（页面不可用）则不启动
    await autoPrefs.refresh()
    scheduler.start()
    // 跟随拉取调度（跨端同步 T2）：解锁边沿 + 3min 轮询，gate 内查锁定态
    followScheduler.start()
    // T4：start() 复位 scheduler 内部 authFailed 标志，宿主 ref 同步镜像（重启 options 页即清警示）
    cloudAuthFailed.value = followScheduler.authFailed()
    // 打开即首拉一次（终审修复，与 popup 对称）：session DEK 恢复路径 locked 恒 false、无解锁边沿，
    // 已解锁态打开否则要等 3min tick 才见云端更新；锁定态由 gate 拦截（零网络零写盘）
    void followScheduler.syncNow()
    // idle/锁屏自动锁定（plan16 T12）：initStore 后启动（settings/加密态已就绪，watcher 内部自判 prefs）
    lockWatcher.start()
    // T11 badge 初始对账（spec §4）：以持久计数恢复「!」标记——action badge 跨页面会话残留，
    // 打开 options 时按 cloudConflictCount 键真值校正（全裁决后=0 清空）
    try {
      const raw = await storageAdapter.get('cloudConflictCount')
      const n = raw === null ? 0 : Number(JSON.parse(raw))
      setConflictBadge(Number.isFinite(n) && n > 0 ? n : 0)
    } catch { setConflictBadge(0) }
  } catch (e) {
    loadError.value = i18n.global.t('options.readError', { message: e instanceof Error ? e.message : String(e) })
  }
})

// 页面卸载即停：清防抖与定时器，stop 后在途 run 不再补跑（彻底静默）；锁定轮询同停
onUnmounted(() => {
  scheduler.stop()
  followScheduler.stop()
  lockWatcher.stop()
})

// R3-I1：复制成败反馈上移宿主（CodesPage emit 无回执不再自弹「已复制」）——写入完成按结果
// toast，失败 error toast（与 desktop/popup 同口径，设计 §3.2）；仍纳入 scheduleClipboardClear
// 30s 清除链（写入成功才武装，失败不武装）
const toast = useToast()
async function copyToClipboard(code: string) {
  try {
    await navigator.clipboard.writeText(code)
    scheduleClipboardClear(settings)
    toast.show(tr('options.copied'))
  } catch {
    toast.show(tr('options.copyFailed'), 'error')
  }
}

// ---------- 平台装配（R4 抽 optionsPlatforms；App.vue 留生命周期接线）----------

/** 安全平台：security/剪贴板/锁定策略由 ui host createSecurityOpsFromStore 绑 store 承载；
 *  extension 差异=popup 关窗延迟 + lockOnRestart 不支持（见 optionsPlatforms 注释） */
const securityPlatform = createOptionsSecurityPlatform(store)
/** 浏览器同步平台（extension 独有：开关持久化 + sync:status 状态读取） */
const syncPlatform = createOptionsSyncPlatform(store)
/** 备份平台（extension 独有：Blob 下载 + 文件选择 + KDF 档位） */
const backupPlatform = createOptionsBackupPlatform(store, tr)
/** 自动云偏好通道（storage.local 异步 → 进程内缓存；cloudPlatform 与 scheduler 同源读） */
const autoPrefs = createCloudAutoPrefsChannel(storageAdapter)

/** 存活期自动云同步 runner（D6，host 共享编排；extension 差异注入见 cloudRunnerFactory） */
const cloudSync = createExtensionCloudRunner({ store, t: tr })

/** 云凭据失效标志（跨端同步 T4）：followScheduler 经 onAuthFailed 置位 → SyncCard 重授权警示；
 *  start() 复位语义在宿主镜像（scheduler 内部标志随 start() 复位，ref 同步对齐） */
const cloudAuthFailed = ref(false)

/** 跟随拉取调度（跨端同步 T2）：解锁边沿 + 3min 轮询，经 syncScheduler gate（锁定态零网络）。
 *  与既有 cloudAutoPrefs 的 change/interval 通道相互独立（autoFollow 是跟随拉取的开关，勿混）；
 *  T9：跟随走 pull-only 只读形态 run('pull')——syncWithCloudRev preview 判定，downloaded/merged
 *  只采纳落盘不写云（零上传零副本），本地内容不变也能拉到云端更新 */
const followScheduler = createFollowScheduler(store, {
  runPull: () => cloudSync.run('pull'),
  intervalMs: () => (settings.syncPrefs.autoFollow ? 180_000 : null),
  // T4：凭据失效（401/403）→ 停轮询 + SyncCard 重授权警示（恢复闭环：手动同步成功 onManualSynced → resume()）
  onAuthFailed: () => { cloudAuthFailed.value = true },
})

// 审查 M4：intervalMs 仅 start 读取一次——开关变更 stop+start 重建轮询，新间隔/关停即时生效；
// start() 复位 authFailed 标志，宿主 ref 同步镜像（与挂载时同口径，防警示滞留）
watch(() => settings.syncPrefs.autoFollow, () => {
  followScheduler.stop()
  followScheduler.start()
  cloudAuthFailed.value = followScheduler.authFailed()
})

/** core 调度器（勘误 §4.1：不用 ext.alarms——SW 后台无解锁 DEK、读不到会话备份口令，
 *  alarms 触发的同步无法加密；改为 options 页存活期运行，页面卸载即停）。
 *  guard 按 reason 双开关过滤；开关与间隔读进程内缓存（异步读进不了同步回调，滞后见上注释） */
const scheduler = createAutoRunScheduler({
  debounceMs: 10_000,
  intervalMs: () => (autoPrefs.get().onInterval ? autoPrefs.get().intervalMinutes * 60_000 : null),
  run: async (reason) => {
    const p = autoPrefs.get()
    if (reason === 'change' && !p.onChange) return
    if (reason === 'interval' && !p.onInterval) return
    await cloudSync.run()
  },
})

// ---------- idle/锁屏自动锁定（plan16 T12，设计 §1 锁定策略·extension 执行端）----------
/** 每 tick 现读 settings.lockPrefs（core loadSettings 已归一化）；加密未启用 → null 不动作。
 *  与 locked 无关：watcher 内部自判（锁定态 tick 无副作用）。store.lock() 已清 dekPersist（T7），
 *  watcher 只需调 lock 不自清 session。异常经 onError 上报不中断轮询 */
const lockWatcher = createIdleLockWatcher({
  getPrefs: async () => {
    if (!hasEncryption.value) return null
    return { idleMinutes: settings.lockIdleMinutes, lockOnSystemLock: settings.lockOnSystemLock }
  },
  lock: () => store.lock(),
  onError: (e) => console.warn('[lockWatcher]', e),
})

/** 云同步平台（host 共享装配 + extension 差异；onManualSynced 闭包引用其后声明的
 *  followScheduler/cloudAuthFailed——回调仅发生于挂载后异步时点，无 TDZ 问题） */
const cloudPlatform = createOptionsCloudPlatform({
  store,
  t: tr,
  autoPrefs,
  // 审查 I1 恢复闭环：CloudCard 手动同步全部目标成功后回调——复位云凭据失效警示并重启跟随轮询
  // （用户重新授权 + 手动同步成功即闭环，无需重开 options 页）。回调内同步调用，宿主自兜错
  onManualSynced: () => {
    followScheduler.resume()
    cloudAuthFailed.value = followScheduler.authFailed()
  },
})
</script>

<template>
  <!-- 解锁成功回调补跑迁移（plan16 T13，幂等）：口令/PRF 解锁各路径在 LockScreen 内 emit unlocked -->
  <LockScreen v-if="locked" :store="store" @unlocked="runLegacyMigrations" />
  <template v-else>
    <div v-if="loadError" class="error">{{ loadError }}</div>
    <template v-else>
      <!-- R16⑤（评审 A2 方案 a）：落盘失败常驻告警，与主体并列不互斥 -->
      <PersistErrorBanner :show="persistFailed" :text="tr('app.persistError')" />
      <!-- 迁移提示与主体并列（非互斥）：一次性提示，下次挂载重跑迁移=0 后不再出现；
           legacyNote（审查 I6）：迁移跳过/失败且旧键仍在时提示，成功迁移后消失 -->
      <div v-if="migrateNote" class="migrate-note">{{ migrateNote }}</div>
      <div v-if="legacyNote" class="migrate-note">{{ legacyNote }}</div>
      <!-- 同构五页:与桌面同一 Shell(无 railActions → 设置页不渲染桌面专属项;传 syncPlatform → 渲染扩展专属项) -->
      <NavigationShell :store="store" :platform="backupPlatform" :security-platform="securityPlatform" :sync-platform="syncPlatform" :cloud-platform="cloudPlatform" :cloud-auth-failed="cloudAuthFailed" :icons="icons" :schemes-api="schemesApi" @copy="copyToClipboard" />
    </template>
  </template>
  <!-- 全局 toast 渲染端（P3 item-layout toast 设计）：模板根级、独立于锁定态 v-if 链，无 props 直读模块态 -->
  <ToastHost />
</template>

<style>
/* body 级样式须在非 scoped 块：scoped 会编译为 body[data-v-x] 永不匹配（审查 Minor），
   与 desktop App.vue 同做法 */
body { font-family: system-ui, sans-serif; margin: 0; }
</style>
<style scoped>
.error { color: var(--md-sys-color-error); font-size: var(--md-sys-typescale-body-small); padding: 16px; }
.migrate-note { color: var(--md-sys-color-primary); font-size: var(--md-sys-typescale-body-small); padding: 8px 16px; }
</style>
