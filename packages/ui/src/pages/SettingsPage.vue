<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import type { AppSettings } from '@totp/core'
import { useI18n } from 'vue-i18n'
import type { DevtoolsPlatform } from '../components/devtoolsPlatform'
import type { McpPlatform } from '../components/mcpCard'
import type { ReleasePolicyDto, ReleasePlatform } from '../components/releasePlatform'
import { validateReleaseMinutes } from '../components/releasePlatform'
import type { SecurityPlatform } from '../components/securityPlatform'
import McpServerCard from '../components/McpServerCard.vue'
import MdCard from '../components/md/MdCard.vue'
import MdSegmentedButton from '../components/md/MdSegmentedButton.vue'
import MdSelect from '../components/md/MdSelect.vue'
import MdSwitch from '../components/md/MdSwitch.vue'
import MdTextField from '../components/md/MdTextField.vue'
import type { VueStore } from '../store'
import { THEME_PALETTES, useTheme } from '../theme/useTheme'

const props = withDefaults(defineProps<{
  /** 全局响应式 store（settings 读写源；NavigationShell pageProps 按 /settings 分发） */
  store: VueStore
  /** 安全平台实现；仅其 setClipboardClear 存在才渲染剪贴板自动清除项 */
  securityPlatform?: SecurityPlatform | null
  /** 桌面端宿主 → 渲染失焦自动隐藏（blurHideEnabled 为桌面专属行为） */
  showDesktop?: boolean
  /** 扩展端宿主 → 渲染 URL 过滤开关与 popup 关闭延迟 */
  showExtension?: boolean
  /** MCP 平台实现；null（扩展宿主缺省）时整卡不渲染（桌面专属） */
  mcpPlatform?: McpPlatform | null
  /** 开发者平台实现（桌面宿主桥接 devtools_* 命令）；null 时开发者卡不渲染（桌面专属） */
  devtoolsPlatform?: DevtoolsPlatform | null
  /** 释放策略平台实现（桌面宿主桥接 release_policy_* 命令）；null 时释放卡不渲染（桌面专属） */
  releasePlatform?: ReleasePlatform | null
}>(), { securityPlatform: null, showDesktop: false, showExtension: false, mcpPlatform: null, devtoolsPlatform: null, releasePlatform: null })

// 解构出顶层 writable computed：模板自动解包，v-model/赋值直达 useTheme 的 set
// （set 内部已写 settings + localStorage 镜像 + commitSettings，无需页面重复处理）
const { mode, color, resolvedMode } = useTheme(props.store)

// D2 抽串：设置页文案走 i18n（settingsPage.*）；选项表为 computed——locale 切换后文案联动
const { t } = useI18n()

const MODE_OPTIONS = computed(() => [
  { value: 'auto', label: t('settingsPage.modeAuto') },
  { value: 'light', label: t('settingsPage.modeLight') },
  { value: 'dark', label: t('settingsPage.modeDark') },
])

/** 当前生效模式文案（resolvedMode 由 useTheme 按 auto+系统偏好解析） */
const resolvedLabel = computed(() => (resolvedMode.value === 'dark' ? t('settingsPage.modeDark') : t('settingsPage.modeLight')))

/** 色板显示名（D2）：palettes.json 的 zh label 为数据文件不在 i18n 侧，按 id 映射到 settingsPage.palette.* */
const paletteLabel = (id: string): string => t(`settingsPage.palette.${id}`)

// Task 6 审查裁定：设置项直写 settings + commitSettings，不做「条件否决 v-model」
type BoolKey = 'blurHideEnabled' | 'urlFilterEnabled' | 'clipboardClearEnabled' | 'rememberTagFilter'
async function setBool(key: BoolKey, v: boolean): Promise<void> {
  props.store.settings[key] = v
  await props.store.commitSettings()
}

/** 云同步跟随开关（跨端同步 T3）：syncPrefs 嵌套字段不在顶层 BoolKey 内，单独 setter */
async function setAutoFollow(v: boolean): Promise<void> {
  props.store.settings.syncPrefs.autoFollow = v
  await props.store.commitSettings()
}

// ---------- 语言选择（D1）：MdSelect emit 值为泛化 string|number，赋值前收敛回 AppSettings['locale'] ----------
const LOCALE_OPTIONS = computed<Array<{ value: AppSettings['locale']; label: string }>>(() => [
  { value: 'auto', label: t('settingsPage.localeAuto') },
  { value: 'zh', label: t('settingsPage.localeZh') },
  { value: 'en', label: t('settingsPage.localeEn') },
])
/** 语言切换：写 settings.locale 后 commitSettings 落盘；i18n locale 由 createAppI18n 的 watch 联动 */
async function setLocale(v: string | number): Promise<void> {
  props.store.settings.locale = v as AppSettings['locale']
  await props.store.commitSettings()
}

/** 纯黑（AMOLED）对比度档（Task 20）：开关语义映射到 'standard' | 'amoled'；css 覆盖层仅在暗色观感生效 */
async function setThemeContrast(v: boolean): Promise<void> {
  props.store.settings.themeContrast = v ? 'amoled' : 'standard'
  await props.store.commitSettings()
}

/** popup 关闭延迟（毫秒）：number 语义输入，空串/非法/负值忽略不落盘，小数取整落盘 */
async function setPopupDelay(v: string): Promise<void> {
  if (v.trim() === '') return
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0) return
  props.store.settings.popupCloseDelayMs = Math.round(n)
  await props.store.commitSettings()
}

// 剪贴板自动清除：与 SecurityCard 内开关同语义，设置页同步提供一份；无该能力的宿主不渲染
const hasClipboardClear = computed(() => typeof props.securityPlatform?.setClipboardClear === 'function')
// 通用卡恒渲染：即使宿主无 desktop/extension/剪贴板能力，也有「记住标签筛选」开关兜底
const hasGeneralItems = computed(() => true)

// ---------- WebView 远程调试（验收条目4，桌面专属）：开关+端口写 settings.json，重启后经环境注入生效 ----------
const devtoolsEnabled = ref(false)
const devtoolsPort = ref('9222')
/** 最近一次成功提交（或后端返回）的配置：非法输入/写失败回显基准 */
let devtoolsGood: { enabled: boolean; port: number } = { enabled: false, port: 9222 }
/** 后端保存失败回显（审查 M6：端口与已启用 MCP 冲突被 Rust 拒绝等，须可见而非静默回滚） */
const devtoolsError = ref('')

onMounted(async () => {
  if (props.devtoolsPlatform) {
    try {
      const cfg = await props.devtoolsPlatform.getConfig()
      devtoolsEnabled.value = cfg.enabled
      devtoolsPort.value = String(cfg.port)
      devtoolsGood = cfg
    } catch {
      // 预填失败保持默认关（与后端缺省一致），不阻断设置页其余部分
    }
  }
  // 释放策略预填（Task 14）：失败保持缺省 5/30/false/true，不阻断设置页其余部分
  if (props.releasePlatform) {
    try {
      const cfg = await props.releasePlatform.getConfig()
      releaseGood = cfg
      Object.assign(releaseCfg, cfg)
      releasePauseInput.value = String(cfg.pauseMinutes)
      releaseDestroyInput.value = String(cfg.destroyMinutes)
    } catch {
      // 预填失败保持缺省，不阻断设置页其余部分
    }
  }
})

/** 开关切动与端口 change（失焦/回车）同一提交路径；非法端口回显当前值不提交 */
async function commitDevtools(): Promise<void> {
  const platform = props.devtoolsPlatform
  if (!platform) return
  const n = Number(devtoolsPort.value)
  if (devtoolsPort.value.trim() === '' || !Number.isInteger(n) || n < 1024 || n > 65535) {
    devtoolsPort.value = String(devtoolsGood.port)
    devtoolsEnabled.value = devtoolsGood.enabled
    return
  }
  try {
    await platform.setConfig(devtoolsEnabled.value, n)
    devtoolsGood = { enabled: devtoolsEnabled.value, port: n }
    devtoolsError.value = ''
  } catch (e) {
    // Tauri invoke 以字符串 reject（Rust Err(String)），非 Error 实例
    devtoolsError.value = `${t('settingsPage.devtoolsSaveFailed')}：${e instanceof Error ? e.message : String(e)}`
    devtoolsEnabled.value = devtoolsGood.enabled
    devtoolsPort.value = String(devtoolsGood.port)
  }
}

// ---------- 窗口资源释放（spec 批⑧ §7.4-7.5，桌面专属）：两档分钟数（0=禁用）+ 各自锁库开关 ----------
// Rust release_tick 每轮现读配置，改设置即时生效；提交模式仿开发者卡（getConfig→ref→change 提交 + 基线回显）
const releaseCfg = reactive<ReleasePolicyDto>({ pauseMinutes: 5, destroyMinutes: 30, lockOnPause: false, lockOnDestroy: true })
/** 分钟输入框字符串态（change 提交模式，同 devtools 端口）：输入中不提交，失焦/回车校验后提交 */
const releasePauseInput = ref('5')
const releaseDestroyInput = ref('30')
/** 最近一次成功提交（或后端返回）的配置：非法输入/写失败回显基准 */
let releaseGood: ReleasePolicyDto = { ...releaseCfg }
/** 后端保存失败回显（同 devtools 卡口径：写失败须可见而非静默回滚） */
const releaseError = ref('')

/** 非法输入/写失败统一回显基线（devtoolsGood 同款兜底） */
function rollbackReleaseInputs(): void {
  releasePauseInput.value = String(releaseGood.pauseMinutes)
  releaseDestroyInput.value = String(releaseGood.destroyMinutes)
  Object.assign(releaseCfg, releaseGood)
}

/** 整卡唯一提交出口：成功前进基线并清错误，失败回显基线并展示错误 */
async function commitReleaseConfig(next: ReleasePolicyDto): Promise<void> {
  const platform = props.releasePlatform
  if (!platform) return
  try {
    await platform.setConfig(next)
    releaseGood = next
    Object.assign(releaseCfg, next)
    releaseError.value = ''
  } catch (e) {
    // Tauri invoke 以字符串 reject（Rust Err(String)），非 Error 实例
    releaseError.value = `${t('settingsPage.releaseSaveFailed')}：${e instanceof Error ? e.message : String(e)}`
    rollbackReleaseInputs()
  }
}

/** 分钟数 change 提交（失焦/回车）：0-1440 整数合法；空串/非法回显当前值不提交 */
async function onReleaseMinutes(field: 'pauseMinutes' | 'destroyMinutes'): Promise<void> {
  const input = field === 'pauseMinutes' ? releasePauseInput : releaseDestroyInput
  // 空串守卫（审查 I1）：Number('') === 0 且 0 通过校验，不拦会静默提交 0=禁用该档；拒绝口径同 devtools 卡
  if (input.value.trim() === '') {
    input.value = String(releaseGood[field])
    return
  }
  const n = Number(input.value)
  if (!validateReleaseMinutes(n)) {
    rollbackReleaseInputs()
    return
  }
  await commitReleaseConfig({ ...releaseGood, [field]: n })
}

/** 锁库开关（spec §7.5）：即点即提交 */
async function onReleaseFlag(field: 'lockOnPause' | 'lockOnDestroy', v: boolean): Promise<void> {
  await commitReleaseConfig({ ...releaseGood, [field]: v })
}
</script>

<template>
  <section class="page">
    <MdCard class="block">
      <template #header>{{ t('settingsPage.appearance') }}</template>
      <div class="appearance-rows">
        <div class="row">
          <span class="row-label">{{ t('settingsPage.themeMode') }}</span>
          <MdSegmentedButton v-model="mode" :options="MODE_OPTIONS" />
        </div>
        <div class="row">
          <span class="row-label">{{ t('settingsPage.themeColor') }}</span>
          <div class="dots" role="group" :aria-label="t('settingsPage.themeColor')">
            <button v-for="p in THEME_PALETTES" :key="p.id" type="button" class="theme-dot md-swatch"
              :class="{ 'theme-dot--selected': color === p.id }" :style="{ background: p.hex }"
              :data-color-id="p.id" :title="paletteLabel(p.id)" :aria-label="paletteLabel(p.id)" :aria-pressed="color === p.id"
              @click="color = p.id"
            >
              <span v-if="color === p.id" class="theme-dot__check" aria-hidden="true">✓</span>
            </button>
          </div>
        </div>
        <div class="row">
          <span class="row-label">{{ t('settingsPage.amoled') }}<span class="row-hint">{{ t('settingsPage.amoledHint') }}</span></span>
          <MdSwitch
            class="set-theme-contrast" :model-value="store.settings.themeContrast === 'amoled'"
            @update:model-value="setThemeContrast"
          />
        </div>
      </div>
      <div class="row">
        <span class="row-label">{{ t('settingsPage.language') }}</span>
        <MdSelect
          class="set-locale" :label="t('settingsPage.uiLanguage')" :aria-label="t('settingsPage.uiLanguage')"
          :model-value="store.settings.locale" :options="LOCALE_OPTIONS" @update:model-value="setLocale"
        />
      </div>
      <p class="theme-resolved">{{ t('settingsPage.resolved', { label: resolvedLabel, suffix: mode === 'auto' ? t('settingsPage.autoSuffix') : '' }) }}</p>
    </MdCard>

    <MdCard v-if="hasGeneralItems" class="block">
      <template #header>{{ t('settingsPage.general') }}</template>
      <div v-if="showDesktop" class="row">
        <span class="row-label">{{ t('settingsPage.blurHide') }}</span>
        <MdSwitch
          class="set-blur-hide" :model-value="store.settings.blurHideEnabled"
          @update:model-value="setBool('blurHideEnabled', $event)"
        />
      </div>
      <template v-if="showExtension">
        <div class="row">
          <span class="row-label">{{ t('settingsPage.autoFollow') }}<span class="row-hint">{{ t('settingsPage.autoFollowHint') }}</span></span>
          <MdSwitch
            class="set-auto-follow" :model-value="store.settings.syncPrefs.autoFollow"
            @update:model-value="setAutoFollow"
          />
        </div>
        <div class="row">
          <span class="row-label">{{ t('settingsPage.urlFilter') }}</span>
          <MdSwitch
            class="set-url-filter" :model-value="store.settings.urlFilterEnabled"
            @update:model-value="setBool('urlFilterEnabled', $event)"
          />
        </div>
        <div class="row">
          <span class="row-label">{{ t('settingsPage.popupDelay') }}</span>
          <MdTextField
            class="set-popup-delay" :label="t('settingsPage.popupDelay')" type="number"
            :model-value="String(store.settings.popupCloseDelayMs)" @update:model-value="setPopupDelay"
          />
        </div>
      </template>
      <div v-if="hasClipboardClear" class="row">
        <span class="row-label">{{ t('settingsPage.clipboardClear') }}</span>
        <MdSwitch
          class="set-clipboard-clear" :model-value="store.settings.clipboardClearEnabled"
          @update:model-value="setBool('clipboardClearEnabled', $event)"
        />
      </div>
      <div class="row">
        <span class="row-label">{{ t('settingsPage.rememberTagFilter') }}</span>
        <MdSwitch
          class="set-remember-tag-filter" :model-value="store.settings.rememberTagFilter"
          @update:model-value="setBool('rememberTagFilter', $event)"
        />
      </div>
    </MdCard>

    <!-- 窗口资源释放（桌面专属，spec 批⑧ §7.4-7.5）：两档分钟数（0=禁用）+ 各自锁库开关；Rust tick 每轮现读，改设置即时生效 -->
    <MdCard v-if="showDesktop && releasePlatform" class="block">
      <div class="release-card">
        <h2>{{ t('settingsPage.releaseTitle') }}</h2>
        <p v-if="releaseError" class="release-error" role="alert">{{ releaseError }}</p>
        <div class="row release-row">
          <span class="row-label">{{ t('settingsPage.releasePause') }}</span>
          <MdTextField
            v-model="releasePauseInput" class="release-min" type="number" min="0" max="1440"
            :label="t('settingsPage.releaseMinutes')" :aria-label="t('settingsPage.releaseMinutes')"
            @change="onReleaseMinutes('pauseMinutes')"
          />
          <MdSwitch
            class="set-release-lock-pause" :model-value="releaseCfg.lockOnPause"
            :aria-label="t('settingsPage.releaseLockOnPause')" @update:model-value="onReleaseFlag('lockOnPause', $event)"
          />
          <span class="row-label">{{ t('settingsPage.releaseLockOnPause') }}</span>
        </div>
        <div class="row release-row">
          <span class="row-label">{{ t('settingsPage.releaseDestroy') }}</span>
          <MdTextField
            v-model="releaseDestroyInput" class="release-min" type="number" min="0" max="1440"
            :label="t('settingsPage.releaseMinutes')" :aria-label="t('settingsPage.releaseMinutes')"
            @change="onReleaseMinutes('destroyMinutes')"
          />
          <MdSwitch
            class="set-release-lock-destroy" :model-value="releaseCfg.lockOnDestroy"
            :aria-label="t('settingsPage.releaseLockOnDestroy')" @update:model-value="onReleaseFlag('lockOnDestroy', $event)"
          />
          <span class="row-label">{{ t('settingsPage.releaseLockOnDestroy') }}</span>
        </div>
        <p class="release-hint">{{ t('settingsPage.releaseHint') }}</p>
      </div>
    </MdCard>

    <!-- MCP 服务器（桌面专属）：卡自带 h2 标题（同 SecurityPage F2 去重惯例），边界由 MdCard outlined 统一 -->
    <MdCard v-if="showDesktop && mcpPlatform" class="block">
      <McpServerCard :platform="mcpPlatform" />
    </MdCard>

    <!-- 开发者（桌面专属，验收条目4）：WebView 远程调试开关；改配置需重启应用（run 最早期环境注入） -->
    <MdCard v-if="showDesktop && devtoolsPlatform" class="block">
      <div class="devtools-card">
        <h2>{{ t('settingsPage.devtoolsTitle') }}</h2>
        <p v-if="devtoolsError" class="devtools-error" role="alert">{{ devtoolsError }}</p>
        <div class="row devtools-row">
          <p class="devtools-warn">{{ t('settingsPage.devtoolsWarn') }}</p>
          <MdSwitch
            class="set-devtools" :model-value="devtoolsEnabled"
            :aria-label="t('settingsPage.devtoolsTitle')" @update:model-value="devtoolsEnabled = $event; commitDevtools()"
          />
        </div>
        <div v-if="devtoolsEnabled" class="row devtools-port-row">
          <MdTextField
            v-model="devtoolsPort" class="devtools-port" type="number" min="1024" max="65535"
            :label="t('settingsPage.devtoolsPort')" :aria-label="t('settingsPage.devtoolsPort')" @change="commitDevtools"
          />
          <span class="devtools-restart">{{ t('settingsPage.devtoolsRestart') }}</span>
        </div>
      </div>
    </MdCard>
  </section>
</template>

<style scoped>
.page { padding: 16px; display: flex; flex-direction: column; gap: 12px; }
.row { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
/* 外观卡片行距统一 16px 并对齐行高（验收条目8）：三行主题设置包在同一容器内 */
.appearance-rows { display: flex; flex-direction: column; gap: 16px; }
.appearance-rows .row { min-height: 32px; }
.row-label { font-size: var(--md-sys-typescale-body-medium); }
.row-hint { display: block; font-size: var(--md-sys-typescale-body-small); opacity: .65; }
.dots { display: flex; gap: 10px; flex-wrap: wrap; }
.theme-dot { width: 30px; height: 30px; border-radius: 50%; border: none; cursor: pointer; padding: 0;
  display: inline-flex; align-items: center; justify-content: center; transition: transform .15s; }
.theme-dot:hover { transform: scale(1.1); }
.theme-dot--selected { outline: 2px solid var(--md-sys-color-primary); outline-offset: 2px; }
.theme-dot__check { color: #fff; font-size: var(--md-sys-typescale-body-medium); line-height: 1; text-shadow: 0 0 2px rgba(0, 0, 0, .6); }
.theme-resolved { font-size: var(--md-sys-typescale-body-small); opacity: .65; margin: 0; }
.set-popup-delay { max-width: 220px; }
/* 开发者卡（验收条目4）：标题排版同 McpServerCard；警示文案用 error 色（高危提示必须醒目） */
.devtools-card { display: flex; flex-direction: column; gap: 8px; }
.devtools-card h2 { font-size: var(--md-sys-typescale-title-medium); margin: 0; }
.devtools-error { color: var(--md-sys-color-error); font-size: var(--md-sys-typescale-body-small); margin: 0; }
.devtools-row { align-items: flex-start; }
.devtools-warn { color: var(--md-sys-color-error); font-size: var(--md-sys-typescale-body-small); margin: 0; flex: 1; min-width: 0; }
.devtools-port-row { align-items: center; }
.devtools-port { width: 140px; }
.devtools-restart { font-size: var(--md-sys-typescale-body-small); opacity: .65; }
/* 释放策略卡（Task 14）：标题排版同 devtools/MCP 卡；行内左对齐布局（label+输入+开关+说明一行，不做两端散开） */
.release-card { display: flex; flex-direction: column; gap: 8px; }
.release-card h2 { font-size: var(--md-sys-typescale-title-medium); margin: 0; }
.release-error { color: var(--md-sys-color-error); font-size: var(--md-sys-typescale-body-small); margin: 0; }
.release-row { justify-content: flex-start; gap: 12px; }
.release-min { width: 140px; }
.release-hint { font-size: var(--md-sys-typescale-body-small); opacity: .65; margin: 0; }
</style>
