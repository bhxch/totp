<script setup lang="ts">
import { getBuiltinIcons, parsePastedText, toOtpDigits, type OtpEntry, type TagFilterMode } from '@totp/core'
import { createIconStore, EntryForm, fullIconsReady, LockScreen, MdCheckbox, MdIconButton, NAV_ICONS, normalizeExtOtpauth, parseUriToEntryData, PersistErrorBanner, prefillFromParsed, QuickCodesPanel, resolvePopupVisible, sortEntries, ToastHost, useOtpCodes, useTheme, useToast, type EntryFormData } from '@totp/ui'
import { computed, onMounted, onScopeDispose, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { decodePending, isPendingExpired, PENDING_OTPAUTH_KEY } from '../../src/pendingOtpauth'
import { ext } from '../../src/extApi'
import { createExtensionCloudRunner } from '../../src/cloudRunnerFactory'
import { createFollowScheduler, scheduleClipboardClear } from '../../src/optionsPlatforms'
import { persistFailed, storageAdapter } from '../../src/store'
import {
  addEntryOp, addTagOp, commitSettings, initStore, locked, registerStorageSync, settings, store, updateEntryOp, vault,
} from '../../src/store'

const icons = createIconStore(storageAdapter)

// D2 抽串：popup 壳层文案走 i18n（popup.*）。i18n 插件由 main.ts 在 mount 前同步装入，useI18n 可用
const { t } = useI18n()
// 全局 toast（P3 item-layout toast 设计）：模块级单例，ToastHost（模板根级已挂）直读同一状态渲染
const toast = useToast()

// ---------- 跟随拉取（跨端同步 T2）：popup 打开时/解锁时单次拉取云端更新，不轮询 ----------
// runner 工厂与 options 共用（cloudRunnerFactory），差异仅 i18n 注入（useI18n t 的包装同签名）。
// 调度装配（7 依赖同型 5）收敛至 optionsPlatforms.createFollowScheduler（R4，popup/options 共用），
// popup 差异=intervalMs null 不轮询 + onAuthFailed 仅留痕。
// 锁定态零网络：syncScheduler gate（isUnlocked && autoFollowEnabled）+ runner 内部 isLocked 守护双保险
const cloudSync = createExtensionCloudRunner({ store, t: (key, params = {}) => t(key, params) })
const syncFollow = createFollowScheduler(store, {
  // 跨端同步审查 C1：跟随走 pull-only 通道（下载后远端 hash 基线去重，零上传零副本）；
  // 旧实现走全量推拉 run()，本地零变化也每次打开重写云端（密文随机 IV 恒判本地较新）
  runPull: () => cloudSync.run('pull'),
  intervalMs: () => null, // popup 不轮询
  // T4：popup 无常驻 UI 通道，仅留痕（scheduler 内部已置位停动作资格）；options 经 SyncCard 渲染警示
  onAuthFailed: () => console.warn('[syncFollow] 云凭据失效（401/403），自动跟随已暂停'),
})
// 启动跟随（解锁边沿由 start 内钩子承接，仅覆盖「锁定态打开→用户输口令」的 true→false 翻转）。
// 首拉不放此处（终审修复）：mount 时刻 store 未 init，backupSecret 恒 null（仅 applyDekAndUnlock
// 装载）——立即 syncNow 必走 runner noSecret 早退写伪 cloudAutoStatus；且 session DEK 恢复路径
// locked 全程 false（initStore 直进解锁，无 true→false 边沿），watch(locked) 钩子捕获不到，
// 首拉在下方 async onMounted 的 initStore 完成后显式执行
onMounted(() => {
  syncFollow.start()
})
onScopeDispose(() => syncFollow.stop())

/** 深链跳转:popup 精简后管理面全在主界面态,「打开主界面」直达 options 的 /codes 页(hash 路由);
 *  设置齿轮直达 /settings。openOptionsPage 不支持 hash 故统一用 tabs.create */
const SETTINGS_ICON_PATH = NAV_ICONS.settings
const MAIN_ICON_PATH = NAV_ICONS.codes
function openMain(): void {
  void ext!.tabs.create({ url: ext!.runtime.getURL('options.html#/codes') })
}
function openSettings(): void {
  void ext!.tabs.create({ url: ext!.runtime.getURL('options.html#/settings') })
}

const loaded = ref(false)
const error = ref('')
const query = ref('')
const tabUrl = ref<string | null>(null)

onMounted(async () => {
  try {
    await initStore()
    // 打开即跟随一次（终审修复：首拉在 initStore 完成后——DEK/会话口令已就位，加密库解锁态
    // 可真实拉取；锁定/关开关被 syncScheduler gate 拦截（gate 先于 runner，零写盘），前者
    // 等解锁边沿钩子承接。initStore 失败走 catch 不拉取（store 未就绪无意义））
    void syncFollow.syncNow()
    // 主题接线:initStore 成功后挂 useTheme(设置已加载为真实值;首帧属性由 html 内联脚本负责)
    useTheme(store)
    registerStorageSync()
    // 恢复持久化选中集合：按当前 tags 过滤，防止跨设备删除后盘上残留悬空 id 进入筛选
    // （all 模式误报空列表 / any 模式常驻并被持久化 watch 写回盘上）；initStore 已 await 完成，
    // vault.tags 此刻确定已装载，过滤是确定性的。仅在确有有效选中时赋值：空→空赋值也会触发持久化
    // watch，省去一次冗余 settings 落盘
    if (settings.rememberTagFilter) {
      const valid = new Set(vault.tags.map((t) => t.id))
      const restored = settings.lastTagFilterIds.filter((id) => valid.has(id))
      if (restored.length > 0) selectedTagIds.value = restored
    }
    await icons.init()
  } catch (e) {
    error.value = t('popup.readError', { message: e instanceof Error ? e.message : String(e) })
  } finally {
    loaded.value = true
  }
  // 协议回调（?uri=）/右键菜单（pendingOtpauth）导入预填，不阻塞后续标签页 URL 读取
  void consumePendingOtpauth()
  // R5-M4：popup 已开时再次右键 → 新信封经 onChanged 到达，运行中同样消费（此前仅 onMounted
  // 消费一次，信封滞留到下次打开才被看到）。防重入由 consumeStoragePending 读空即返回天然保证
  try {
    ext!.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes[PENDING_OTPAUTH_KEY]) return
      void consumeStoragePending()
    })
  } catch { /* 扩展上下文不可用（如纯浏览器调试）忽略 */ }
  try {
    const [tab] = await ext!.tabs.query({ active: true, currentWindow: true })
    if (tab?.url?.startsWith('http')) tabUrl.value = tab.url
  } catch (e) {
    console.warn('[popup] 无法读取当前标签页 URL:', e)
    // 读不到标签页 URL（如非扩展环境）时 tabUrl 保持 null，不过滤
  }
})

// R14 收尾：排序收敛 sortEntries 单点（原内联 comparator 靠注释与 ui 同步，口径本就同构）
const sorted = computed(() => sortEntries(vault.entries))
const { codes } = useOtpCodes(sorted)
/** EntryForm 图标数据源：builtin 全集 + store 内 stored/url dataUrl 映射。纳入 fullIconsReady
 *  依赖（2026-10-05 full-icons）：全量注册进 core 单一注册表后触发重算，非精选 builtin 引用自动补渲染 */
const entryIcons = computed(() => {
  void fullIconsReady.value // 全量注册后重算：非精选 builtin path 就位
  return { builtin: getBuiltinIcons(), stored: icons.icons }
})

const filterOn = computed(() => settings.urlFilterEnabled)
/** 标签筛选选中态：rememberTagFilter 开启时自 settings 恢复并回写（spec §3） */
const selectedTagIds = ref<string[]>(settings.rememberTagFilter ? [...settings.lastTagFilterIds] : [])
const tagMode = computed(() => settings.tagFilterMode)
async function setTagMode(m: TagFilterMode) {
  settings.tagFilterMode = m
  await commitSettings()
}
watch(selectedTagIds, (ids) => {
  if (!settings.rememberTagFilter) return
  settings.lastTagFilterIds = [...ids]
  void commitSettings()
})
// 悬空 tag 清理：tag 被删/同步变更后从选中集合剔除（联动持久化 watch 一并落盘）；
// immediate 兜底覆盖补偿恢复前 tags 已装载的首轮（恢复点过滤后通常 no-op）
watch(
  () => vault.tags.map((t) => t.id),
  (ids) => {
    const next = selectedTagIds.value.filter((id) => ids.includes(id))
    if (next.length !== selectedTagIds.value.length) selectedTagIds.value = next
  },
  { immediate: true },
)

/** 四级回退链（spec §3）：搜索 → tag → URL 分级放宽；tabUrl 仅 http(s)（onMounted 既有判定） */
const filterResult = computed(() => resolvePopupVisible({
  entries: sorted.value,
  query: query.value,
  selectedTagIds: new Set(selectedTagIds.value),
  tagMode: settings.tagFilterMode,
  urlFilterActive: filterOn.value && !!tabUrl.value,
  tabUrl: tabUrl.value,
}))
const visible = computed(() => filterResult.value.visible)
const toggleFilter = async () => {
  settings.urlFilterEnabled = !settings.urlFilterEnabled
  await commitSettings()
}

const creating = ref(false)
// ---------- otpauth URI 导入预填（协议回调 ?uri= / pendingOtpauth 共用；P4 后 popup 唯一新建入口） ----------
const importError = ref('')
/** 导入预填对象（OtpEntry 形状，uuid/order/createdAt 为哑值） */
const prefill = ref<OtpEntry | null>(null)
/** 每次导入自增，驱动 EntryForm 重挂载以刷新预填 */
const formKey = ref(0)

/** 进确认态共享收口（URI 预填 / pasted 单条预填共用）：清错误 → 挂预填 → 开表单 → 换 key 重挂载刷新 */
function enterConfirmState(entry: OtpEntry): void {
  importError.value = ''
  prefill.value = entry
  creating.value = true
  formKey.value++
}

/** URI → 表单预填；成功返回 null（并清除既有错误提示），失败返回中文错误消息（后台入口共用） */
function applyOtpauthPrefill(uri: string): string | null {
  const r = parseUriToEntryData(uri.trim())
  if ('error' in r) return r.error
  enterConfirmState(r.data)
  return null
}

/**
 * 信封分派（uri 预填 / pasted 复解 / 过期提示共用尾部）：?uri= 协议回调与 storage 信封两入口
 * 汇聚于此。decode 失败 → 旧裸 URI 兼容（形状规则见 pendingOtpauth.ts）
 */
async function dispatchPendingRaw(raw: string): Promise<void> {
  // P5 信封分派（Global Constraints）：JSON 解析失败/形状不符 → 旧版裸 URI 兼容
  const envelope = decodePending(raw)
  // R5-I3：带 ts 信封超过 PENDING_TTL_MS → 信封已在读取时删除（raw 路径先 remove），提示重试；
  // 无 ts 旧信封不过期（升级兼容，isPendingExpired 内裁定）
  if (envelope !== null && isPendingExpired(envelope)) {
    importError.value = t('popup.pendingExpired')
    return
  }
  if (envelope === null || envelope.kind === 'uri') {
    const err = applyOtpauthPrefill(normalizeExtOtpauth(envelope === null ? raw : envelope.text))
    if (err) importError.value = err
    return
  }
  // kind=pasted：popup 侧以同一 parsePastedText 复解 background 写盘的原始文本（写读口径一致，
  // 结果确定）。单条进确认态（哑值预填 uuid 空串 → EntryForm isNew 按「添加」处理，保存时宿主
  // 覆盖 uuid/order/createdAt）；0 条/多条理论不可达（background 写盘前已按同口径拦截），兜底防静默
  const parsed = parsePastedText(envelope.text)
  if ('unsupported' in parsed) {
    importError.value = parsed.unsupported
    return
  }
  if (parsed.entries.length === 1) {
    enterConfirmState(prefillFromParsed(parsed.entries[0]!))
    return
  }
  // R5-M1：原硬编码中文入 i18n 键表（popup.importNone / popup.batchImportHint）
  importError.value = parsed.entries.length === 0
    ? t('popup.importNone')
    : t('popup.batchImportHint', { count: parsed.entries.length })
}

/**
 * 从 storage 读 pending 信封并消费（读取即清除）；无信封即 no-op——天然防重入（消费后即删，
 * 消费触发的 remove 自写回声 / 重复 onChanged 读到空直接返回）。R5-M4：popup 已开时再次右键
 * 的信封也由此消费（onChanged 触发）。理论上 get 与 remove 交错可双读同一 raw，消费动作
 * （预填重挂同内容表单）幂等无害，不做加锁
 */
async function consumeStoragePending(): Promise<void> {
  let raw = ''
  try {
    const got = await ext!.storage.local.get(PENDING_OTPAUTH_KEY)
    raw = typeof got[PENDING_OTPAUTH_KEY] === 'string' ? got[PENDING_OTPAUTH_KEY].trim() : ''
    if (raw) await ext!.storage.local.remove(PENDING_OTPAUTH_KEY)
  } catch { /* 扩展上下文不可用（如纯浏览器调试）忽略 */ }
  if (raw) await dispatchPendingRaw(raw)
}

/**
 * 后台导入 mount 入口：popup URL 带 ?uri=（Firefox ext+otpauth 协议回调）或 local
 * `pendingOtpauth`（Chrome 右键菜单写入）→ 分派预填；?uri= 优先（协议回调即时性最高）
 */
async function consumePendingOtpauth(): Promise<void> {
  let raw = ''
  try {
    raw = new URLSearchParams(window.location.search).get('uri')?.trim() ?? ''
  } catch { /* 无 location 场景忽略 */ }
  if (raw) {
    await dispatchPendingRaw(raw)
    return
  }
  await consumeStoragePending()
}

function closeForm() {
  creating.value = false
  prefill.value = null
  importError.value = ''
}

async function onSave(data: EntryFormData) {
  // URI 导入预填：表单内未改 type 时携带 URI 中的 algorithm/digits/period/counter
  const carried = prefill.value?.type === data.type ? prefill.value : null
  await addEntryOp({
    ...data,
    uuid: crypto.randomUUID(),
    algorithm: carried?.algorithm ?? 'SHA1',
    // digits 经 toOtpDigits 收口：carried 来自 parseUriToEntryData（其内部经 toOtpDigits 收口，
    // 含 totp/hotp URI digits=5→6 的非恒等修正，见 core typeProfiles 守卫）可直传，纯手写路径
    // 以表单提交值收口——steam 恒 5、yandex 恒 8、其余 6/7/8。不得回退字面量 5/6：
    // 此前 `steam ? 5 : 6` 把表单提交的 yandex digits=8 覆写为 6，addEntry 写路径不校验直接落盘，
    // 下次 loadVault 经 validateVaultObject 整记录拒绝（'vault corrupted'）致整个 vault 不可用
    digits: carried?.digits ?? toOtpDigits(data.digits ?? 6, data.type),
    period: carried?.period ?? data.period ?? 30,
    ...(carried?.type === 'hotp' ? { counter: carried.counter ?? 0 } : {}),
    order: 0,
    createdAt: Date.now(),
  })
  closeForm()
}

let closeTimer: ReturnType<typeof setTimeout> | null = null
/** 双击揭示代次（审查 I-1 武装竞态守卫）：copy 开始快照、武装前比对 */
let revealGeneration = 0
/** R5-M2 标签页形态标记（background Firefox 回退 tabs.create popup.html?pending=1）：
 * 弹窗形态取完码自动关窗收起；标签页形态跳过自动关窗武装——window.close 关用户标签页语义突兀
 * （storage 兜底消费不依赖该参数，仅作形态判别） */
const isTabFallback = new URLSearchParams(window.location.search).has('pending')

async function copy(entry: OtpEntry) {
  // I-1：copy 开始即快照揭示代次——copy 是 async，若双击落在下方 await 期间，
  // cancelAutoClose 执行时 closeTimer 还是 null（取消落空），须靠代次失配在武装点跳过
  const generation = revealGeneration
  const c = codes.value.get(entry.uuid)?.code
  if (!c) return
  try {
    await navigator.clipboard.writeText(c)
  } catch {
    // 复制失败：error toast 替代「已复制」（P3 横幅迁移），不武装自动关窗（用户需要时间看到失败原因）
    toast.show(t('popup.copyFailed'), 'error')
    return
  }
  scheduleClipboardClear(settings)
  // HOTP：复制的是旧 counter 的码（RFC 语义），复制完成后再递增
  if (entry.type === 'hotp') await updateEntryOp(entry.uuid, { counter: (entry.counter ?? 0) + 1 })
  // 「已复制」反馈：toast 提示后按 popupCloseDelayMs 延迟关闭（简单实现：不重置，到点关闭）
  toast.show(t('popup.copiedBanner'))
  if (closeTimer) clearTimeout(closeTimer)
  // I-1 竞态守卫：await 期间发生过双击揭示 → 不武装，否则刚取消过的揭示又被本 timer 截断
  if (generation !== revealGeneration) return
  // R5-M2：标签页形态不武装自动关窗（用户自行关闭，closeTimer 空转无意义）
  if (isTabFallback) return
  // M23：loadSettings 走 DEFAULT_SETTINGS 合并兜底（见 vaultStore.loadSettings M4），popupCloseDelayMs 必为 number
  closeTimer = setTimeout(() => window.close(), settings.popupCloseDelayMs)
}

/** 双击揭示（OtpListItem 内部 8s）时取消本次复制后自动关闭（终审 Important-1）：刚看过码的会话不再自动关，符合「刚交互过」直觉。
 *  审查 I-1：同时递增揭示代次——双击先于 copy 的 await 落地派发时（慢机器可复现），此处 closeTimer
 *  还是 null、clearTimeout 取消落空，在途 copy 靠代次失配在武装点跳过，揭示不被自动关闭截断 */
function cancelAutoClose(): void {
  revealGeneration++
  if (closeTimer) clearTimeout(closeTimer)
  closeTimer = null
}
</script>

<template>
  <LockScreen v-if="locked" :store="store" :allow-passkey="false" />
  <main v-else>
    <!-- R16⑤（评审 A2 方案 a）：落盘失败常驻告警（锁屏态 store 写路径不可达，仅解锁主体需要） -->
    <PersistErrorBanner :show="persistFailed" :text="t('app.persistError')" />
    <header>
      <h1>{{ t('popup.title') }}</h1>
      <div class="header-ops">
        <!-- P4 精简：管理面移交主界面态，「打开主界面」直达 options#/codes；快捷新增仅剩 pending 确认态 -->
        <MdIconButton :title="t('popup.openMain')" :aria-label="t('popup.openMain')" @click="openMain">
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path :d="MAIN_ICON_PATH" fill="currentColor" /></svg>
        </MdIconButton>
        <MdIconButton :title="t('popup.settings')" :aria-label="t('popup.openSettings')" @click="openSettings">
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path :d="SETTINGS_ICON_PATH" fill="currentColor" /></svg>
        </MdIconButton>
      </div>
    </header>

    <div v-if="error" class="error">{{ error }}</div>

    <!-- URL 过滤行与 hint 留在面板上方（宿主管辖，不进面板）：四级回退链的过滤执行在宿主 -->
    <div class="filter-row" v-if="tabUrl">
      <!-- M3 MdCheckbox(审查 X10):原 UA 原生 checkbox 深色 scheme 下未选中即深灰填充,即「复选框底色偏深」根因 -->
      <MdCheckbox :model-value="filterOn" :label="t('popup.filterBySite')" @update:model-value="toggleFilter" />
      <span v-if="!filterResult.hint && filterOn && filterResult.urlMatchCount > 0" class="hint">{{ t('popup.matchCount', { count: filterResult.urlMatchCount }) }}</span>
    </div>
    <!-- hint 不受 tabUrl 门控：无标签页 URL（新标签页等）时放宽提示仍可达（spec §3 回退提示） -->
    <span v-if="filterResult.hint" class="hint hint-row">{{ t(filterResult.hint) }}</span>

    <!-- 非法 pending URI 报错常显（无粘贴框后的唯一 importError 渲染位） -->
    <div v-if="importError" class="error">{{ importError }}</div>

    <!-- 快捷新增确认态：仅 pending 预填入口（?uri= 协议回调 / 后台 pendingOtpauth），无 Tab 纯手动。
         :key 预填重挂载机制、onSave 新建分支、cancel=closeForm 语义不变 -->
    <EntryForm v-if="creating" :key="prefill ? `prefill-${formKey}` : 'new'" :initial="prefill" :tags="vault.tags" :create-tag="addTagOp" :icons="entryIcons" :icon-store="icons" @save="onSave" @cancel="closeForm" />

    <!-- P4 Task 3：搜索行 + 标签行 + 列表区整体换装 QuickCodesPanel（冻结筛选行 + 纯取码列表 +
         两态空文案，行内 QR/管理入口恒关）。过滤编排（四级回退/URL 站点）与复制/自动关窗通道留宿主 -->
    <!-- R5-I1：空态两态判定在面板内只看 query/标签选中，不感知 URL 过滤——URL 过滤激活时
         「全空」实为站点无匹配，emptyText 换 noMatch 文案防「暂无条目，点击右上角录入」误导
         （右上角按钮语义是打开主界面而非添加）；过滤关闭回退引导文案（旧行为不变） -->
    <QuickCodesPanel
      v-model:query="query"
      :codes="codes" :icons="icons" :loading="!loaded" :entries="visible"
      :empty-text="filterOn && tabUrl ? t('popup.noMatch') : t('popup.empty')" :no-match-text="t('popup.noMatch')"
      tag-row :tags="vault.tags"
      v-model:selected-tag-ids="selectedTagIds"
      :tag-mode="tagMode" @update:tag-mode="setTagMode"
      @copy="(e) => copy(e)" @dblclick="cancelAutoClose"
    />
  </main>
  <!-- 全局 toast 渲染端（P3 item-layout toast 设计）：模板根级、独立于锁定态 v-if 链，无 props 直读模块态 -->
  <ToastHost />
</template>

<style>
body { font-family: system-ui, sans-serif; margin: 0; padding: 8px; }
/* R5-M6：body padding 8px = sticky 冻结条两侧缝隙宽，面板 .frozen 负 margin 补偿取同值 */
main { display: flex; flex-direction: column; gap: 4px; --frozen-bleed: 8px; }
header { display: flex; align-items: center; justify-content: space-between; padding: 4px 4px 8px; }
.header-ops { display: flex; align-items: center; gap: 6px; }
h1 { font-size: var(--md-sys-typescale-title-medium); margin: 0; }
.error { color: var(--md-sys-color-error); font-size: var(--md-sys-typescale-body-small); }
.filter-row { display: flex; align-items: center; gap: 8px; font-size: var(--md-sys-typescale-body-small); padding: 0 4px; }
.hint { opacity: .6; }
.hint-row { padding: 0 4px; }
</style>
