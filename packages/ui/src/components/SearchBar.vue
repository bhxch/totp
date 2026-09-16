<script setup lang="ts">
import MdCheckbox from './md/MdCheckbox.vue'
import MdTextField from './md/MdTextField.vue'

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
      label="搜索"
      placeholder="搜索服务名或账户…"
      aria-label="搜索服务名或账户"
      :model-value="modelValue"
      @update:model-value="emit('update:modelValue', $event)"
    />
    <!-- I49：搜 secret 默认关闭，开启时密钥会进入可见的过滤路径，列表 DOM 不写明文但匹配结果会显示条目 -->
    <MdCheckbox
      class="secret-toggle"
      :model-value="!!searchSecret"
      label="搜 secret"
      aria-label="搜 secret"
      :title="searchSecret ? '关闭密钥匹配（当前开启）' : '开启后会用密钥 base32 串匹配（默认关闭）'"
      @update:model-value="emit('update:searchSecret', $event)"
    />
  </div>
</template>

<style scoped>
.search-row { display: flex; gap: 8px; align-items: center; }
.grow { flex: 1; }
.secret-toggle { font-size: 12px; opacity: .75; white-space: nowrap; }
</style>
