<script setup lang="ts">
import { computed } from 'vue'
import type { AppSettings } from '@totp/core'
import { useI18n } from 'vue-i18n'
import type { SecurityPlatform } from '../components/securityPlatform'
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
}>(), { securityPlatform: null, showDesktop: false, showExtension: false })

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
</script>

<template>
  <section class="page">
    <MdCard class="block">
      <template #header>{{ t('settingsPage.appearance') }}</template>
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
  </section>
</template>

<style scoped>
.page { padding: 16px; display: flex; flex-direction: column; gap: 12px; }
.row { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
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
</style>
