<script setup lang="ts">
/** 全局 toast 渲染端（P3 item-layout toast 设计）：无 props，直读 useToast 模块级单例
 *  toasts——宿主任意组件 useToast().show() 入队即在此响应式渲染。根组件挂载（三宿主
 *  App.vue 模板根级），固定底部居中悬浮。点击单条即 dismiss。
 *  R3-M9：按 kind 分流双 live region——error 走 role=alert + aria-live=assertive 强播报
 *  （复制失败等须立即感知），success 保持 polite。双容器均为常驻空节点：live region 动态
 *  插拔/动态改 aria-live 属性对读屏器行为不一致，预先存在的分区最稳。混合时序下 error 组
 *  渲染在后但 assertive 播报优先（打断 polite），符合「失败需立即感知」语义。 */
import { computed } from 'vue'
import { useToast } from '../composables/useToast'

const { toasts, dismiss } = useToast()
const politeToasts = computed(() => toasts.value.filter((t) => t.kind !== 'error'))
const errorToasts = computed(() => toasts.value.filter((t) => t.kind === 'error'))
</script>

<template>
  <div class="toast-host">
    <!-- success：role=status + aria-live=polite，非紧急打断礼貌播报 -->
    <div class="toast-group" role="status" aria-live="polite">
      <div
        v-for="t in politeToasts"
        :key="t.key"
        class="toast"
        @click="dismiss(t.key)"
      >
        {{ t.message }}
      </div>
    </div>
    <!-- error：role=alert + aria-live=assertive，强播报 -->
    <div class="toast-group" role="alert" aria-live="assertive">
      <div
        v-for="t in errorToasts"
        :key="t.key"
        class="toast toast--error"
        @click="dismiss(t.key)"
      >
        {{ t.message }}
      </div>
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
.toast-group {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}
.toast {
  pointer-events: auto;
  max-width: min(560px, calc(100vw - 32px));
  background: var(--md-sys-color-inverse-surface);
  color: var(--md-sys-color-inverse-on-surface);
  border-radius: var(--md-sys-shape-corner-extra-small); /* M3 snackbar=extra-small 4dp（原 pill 100px） */
  min-height: 48px; /* M3 snackbar 48dp */
  display: flex;
  align-items: center;
  padding: 10px 16px;
  font-size: var(--md-sys-typescale-body-medium);
  box-shadow: 0 2px 6px var(--md-sys-color-shadow);
  cursor: pointer;
  user-select: none;
}
/* 自定义 error-container 变体（spec §2.10 裁定；错误感知由 role=alert 承担） */
.toast--error {
  background: var(--md-sys-color-error-container);
  color: var(--md-sys-color-on-error-container);
}
</style>
