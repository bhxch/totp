<script setup lang="ts">
defineProps<{
  modelValue: string
  /** I49：开启后搜索会匹配 secret（密钥 base32），默认关闭（避免明文密钥常驻列表 DOM/UI 状态） */
  searchSecret?: boolean
}>()
const emit = defineEmits<{
  'update:modelValue': [string]
  'update:searchSecret': [boolean]
}>()
function onSecretToggle(e: Event): void {
  emit('update:searchSecret', (e.target as HTMLInputElement).checked)
}
</script>

<template>
  <div class="search-row">
    <input
      class="search"
      type="search"
      placeholder="搜索服务名或账户…"
      :value="modelValue"
      @input="$emit('update:modelValue', ($event.target as HTMLInputElement).value)"
    />
    <!-- I49：搜 secret 默认关闭，开启时密钥会进入可见的过滤路径，列表 DOM 不写明文但匹配结果会显示条目 -->
    <label class="secret-toggle" :title="searchSecret ? '关闭密钥匹配（当前开启）' : '开启后会用密钥 base32 串匹配（默认关闭）'">
      <input
        class="secret-toggle-input"
        type="checkbox"
        :checked="searchSecret"
        @change="onSecretToggle"
      />
      搜 secret
    </label>
  </div>
</template>

<style scoped>
.search-row { display: flex; gap: 8px; align-items: center; }
.search { flex: 1; box-sizing: border-box; padding: 7px 10px; border: 1px solid rgba(128,128,128,.4); border-radius: 8px; background: transparent; color: inherit; }
.search:focus { outline: none; border-color: #4a90d9; }
.secret-toggle { font-size: 12px; opacity: .75; display: flex; align-items: center; gap: 4px; cursor: pointer; white-space: nowrap; }
.secret-toggle-input { margin: 0; }
</style>
