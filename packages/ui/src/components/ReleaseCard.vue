<script setup lang="ts">
import { reactive, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ReleasePolicyDto, ReleasePlatform } from './releasePlatform'
import { validateReleaseMinutes } from './releasePlatform'
import MdSwitch from './md/MdSwitch.vue'
import MdTextField from './md/MdTextField.vue'

const { t } = useI18n()

const props = defineProps<{
  /** 释放平台实现（桌面宿主桥接 release_policy_* 命令）；挂载即拉取当前策略预填 */
  platform: ReleasePlatform
}>()

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

onMounted(async () => {
  try {
    const cfg = await props.platform.getConfig()
    releaseGood = cfg
    Object.assign(releaseCfg, cfg)
    releasePauseInput.value = String(cfg.pauseMinutes)
    releaseDestroyInput.value = String(cfg.destroyMinutes)
  } catch {
    // 预填失败保持缺省 5/30/false/true，不阻断设置页其余部分
  }
})

/** 非法输入/写失败统一回显基线（devtoolsGood 同款兜底） */
function rollbackReleaseInputs(): void {
  releasePauseInput.value = String(releaseGood.pauseMinutes)
  releaseDestroyInput.value = String(releaseGood.destroyMinutes)
  Object.assign(releaseCfg, releaseGood)
}

/** 整卡唯一提交出口：成功前进基线并清错误，失败回显基线并展示错误 */
async function commitReleaseConfig(next: ReleasePolicyDto): Promise<void> {
  try {
    await props.platform.setConfig(next)
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
</template>

<style scoped>
/* 释放策略卡（Task 14）：标题排版同 devtools/MCP 卡；行内左对齐布局（label+输入+开关+说明一行，不做两端散开） */
.release-card { display: flex; flex-direction: column; gap: 8px; }
.release-card h2 { font-size: var(--md-sys-typescale-title-medium); margin: 0; }
.release-error { color: var(--md-sys-color-error); font-size: var(--md-sys-typescale-body-small); margin: 0; }
.release-row { display: flex; align-items: center; justify-content: flex-start; gap: 12px; flex-wrap: wrap; }
.release-min { width: 140px; }
.release-hint { font-size: var(--md-sys-typescale-body-small); opacity: .65; margin: 0; }
.row-label { font-size: var(--md-sys-typescale-body-medium); }
</style>
