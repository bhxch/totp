<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { DevtoolsPlatform } from './devtoolsPlatform'
import MdSwitch from './md/MdSwitch.vue'
import MdTextField from './md/MdTextField.vue'

const { t } = useI18n()

const props = defineProps<{
  /** 开发者平台实现（桌面宿主桥接 devtools_* 命令）；挂载即拉取当前配置预填 */
  platform: DevtoolsPlatform
}>()

// ---------- WebView 远程调试（验收条目4，桌面专属）：开关+端口写 settings.json，重启后经环境注入生效 ----------
const devtoolsEnabled = ref(false)
const devtoolsPort = ref('9222')
/** 最近一次成功提交（或后端返回）的配置：非法输入/写失败回显基准 */
let devtoolsGood: { enabled: boolean; port: number } = { enabled: false, port: 9222 }
/** 后端保存失败回显（审查 M6：端口与已启用 MCP 冲突被 Rust 拒绝等，须可见而非静默回滚） */
const devtoolsError = ref('')

onMounted(async () => {
  try {
    const cfg = await props.platform.getConfig()
    devtoolsEnabled.value = cfg.enabled
    devtoolsPort.value = String(cfg.port)
    devtoolsGood = cfg
  } catch {
    // 预填失败保持默认关（与后端缺省一致），不阻断设置页其余部分
  }
})

/** 开关切动与端口 change（失焦/回车）同一提交路径；非法端口回显当前值不提交 */
async function commitDevtools(): Promise<void> {
  const n = Number(devtoolsPort.value)
  if (devtoolsPort.value.trim() === '' || !Number.isInteger(n) || n < 1024 || n > 65535) {
    devtoolsPort.value = String(devtoolsGood.port)
    devtoolsEnabled.value = devtoolsGood.enabled
    return
  }
  try {
    await props.platform.setConfig(devtoolsEnabled.value, n)
    devtoolsGood = { enabled: devtoolsEnabled.value, port: n }
    devtoolsError.value = ''
  } catch (e) {
    // Tauri invoke 以字符串 reject（Rust Err(String)），非 Error 实例
    devtoolsError.value = `${t('settingsPage.devtoolsSaveFailed')}：${e instanceof Error ? e.message : String(e)}`
    devtoolsEnabled.value = devtoolsGood.enabled
    devtoolsPort.value = String(devtoolsGood.port)
  }
}
</script>

<template>
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
</template>

<style scoped>
/* 开发者卡（验收条目4）：标题排版同 McpServerCard；警示文案用 error 色（高危提示必须醒目） */
.devtools-card { display: flex; flex-direction: column; gap: 8px; }
.devtools-card h2 { font-size: var(--md-sys-typescale-title-medium); margin: 0; }
.devtools-error { color: var(--md-sys-color-error); font-size: var(--md-sys-typescale-body-small); margin: 0; }
.devtools-row { display: flex; justify-content: space-between; gap: 16px; flex-wrap: wrap; align-items: flex-start; }
.devtools-warn { color: var(--md-sys-color-error); font-size: var(--md-sys-typescale-body-small); margin: 0; flex: 1; min-width: 0; }
.devtools-port-row { align-items: center; }
.devtools-port { width: 140px; }
.devtools-restart { font-size: var(--md-sys-typescale-body-small); opacity: .65; }
</style>
