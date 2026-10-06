<script setup lang="ts">
/** 全局 toast 渲染端（P3 item-layout toast 设计）：无 props，直读 useToast 模块级单例
 *  toasts——宿主任意组件 useToast().show() 入队即在此响应式渲染。根组件挂载（三宿主
 *  App.vue 模板根级），固定底部居中悬浮。点击单条即 dismiss。 */
import { useToast } from '../composables/useToast'

const { toasts, dismiss } = useToast()
</script>

<template>
  <!-- role=status + aria-live=polite：toast 非紧急打断，读屏礼貌播报新增内容；
       空态也常驻容器（live region 反复插拔会丢播报），无 toast 项时零尺寸不遮挡 -->
  <div class="toast-host" role="status" aria-live="polite">
    <div
      v-for="t in toasts"
      :key="t.key"
      class="toast"
      :class="{ 'toast--error': t.kind === 'error' }"
      @click="dismiss(t.key)"
    >
      {{ t.message }}
    </div>
  </div>
</template>

<style scoped>
.toast-host {
  position: fixed;
  bottom: 24px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  /* 高于 MdDialog scrim(1000)/MdMenu(1100)：snackbar 悬浮一切内容之上 */
  z-index: 1200;
  /* 容器不挡点击（多列纵向居中非全宽）；单条 toast 自身恢复接收 */
  pointer-events: none;
}
.toast {
  pointer-events: auto;
  max-width: min(560px, calc(100vw - 32px));
  background: var(--md-sys-color-inverse-surface);
  color: var(--md-sys-color-inverse-on-surface);
  border-radius: 100px;
  padding: 10px 16px;
  font-size: var(--md-sys-typescale-body-medium);
  box-shadow: 0 2px 6px var(--md-sys-color-shadow);
  cursor: pointer;
  user-select: none;
}
.toast--error {
  background: var(--md-sys-color-error-container);
  color: var(--md-sys-color-on-error-container);
}
</style>
