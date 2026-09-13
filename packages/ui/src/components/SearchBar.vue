<script setup lang="ts">
defineProps<{ modelValue: string }>()
defineEmits<{ 'update:modelValue': [string] }>()
</script>

<template>
  <input
    class="search"
    type="search"
    placeholder="搜索服务名或账户…"
    :value="modelValue"
    @input="$emit('update:modelValue', ($event.target as HTMLInputElement).value)"
  />
</template>

<style scoped>
.search { width: 100%; box-sizing: border-box; padding: 7px 10px; border: 1px solid rgba(128,128,128,.4); border-radius: 8px; background: transparent; color: inherit; }
.search:focus { outline: none; border-color: #4a90d9; }
</style>
