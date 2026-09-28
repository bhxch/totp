<script setup lang="ts">
/** R16⑤ 宿主接线（评审 A2 方案 a）：store commit 落盘失败时的常驻告警条。
 *  语义：一次落盘失败即常驻本窗口存活期——不自动消失、不提供关闭（「数据未保存」
 *  被随手关掉即失去提示意义；后续写成功也不复位，因为无法确认失败窗口期没有缺口），
 *  重启窗口后消失（下次写成功不再出现）。宿主经 store opts.onPersistError 置位。
 *  文案经 text prop 注入而非组件内 useI18n：desktop 壳层不装 i18n 插件（tr 走 i18n.global，
 *  同 McpConsentDialog 的 :t 注入口径），组件保持无 i18n 依赖可在任一宿主渲染。 */
defineProps<{ show: boolean; text: string }>()
</script>

<template>
  <div v-if="show" class="persist-error" role="alert">{{ text }}</div>
</template>

<style scoped>
.persist-error {
  background: var(--md-sys-color-error-container);
  color: var(--md-sys-color-on-error-container);
  font-size: var(--md-sys-typescale-body-small);
  padding: 10px 16px;
}
</style>
