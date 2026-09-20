<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import MdCheckbox from './md/MdCheckbox.vue'
import MdTextField from './md/MdTextField.vue'

const { t } = useI18n()

defineProps<{
  modelValue: string
  /** I49：开启后搜索会匹配 secret（密钥 base32），默认关闭（避免明文密钥常驻列表 DOM/UI 状态） */
  searchSecret?: boolean
}>()
const emit = defineEmits<{
  'update:modelValue': [string]
  'update:searchSecret': [boolean]
}>()
</script>

<template>
  <div class="search-row">
    <MdTextField
      class="grow"
      type="search"
      :label="t('searchBar.searchLabel')"
      :placeholder="t('searchBar.searchPlaceholder')"
      :aria-label="t('searchBar.searchAria')"
      :model-value="modelValue"
      @update:model-value="emit('update:modelValue', $event)"
    />
    <!-- I49：搜 secret 默认关闭，开启时密钥会进入可见的过滤路径，列表 DOM 不写明文但匹配结果会显示条目 -->
    <MdCheckbox
      class="secret-toggle"
      :model-value="!!searchSecret"
      :label="t('searchBar.searchSecretLabel')"
      :aria-label="t('searchBar.searchSecretLabel')"
      :title="searchSecret ? t('searchBar.secretToggleOnTitle') : t('searchBar.secretToggleOffTitle')"
      @update:model-value="emit('update:searchSecret', $event)"
    />
  </div>
</template>

<style scoped>
.search-row { display: flex; gap: 8px; align-items: center; }
.grow { flex: 1; }
.secret-toggle { font-size: var(--md-sys-typescale-body-small); opacity: .75; white-space: nowrap; }
</style>
