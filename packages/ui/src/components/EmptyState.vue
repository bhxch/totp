<script setup lang="ts">
import { computed } from 'vue'
import type { IconPath } from './iconPaths'
import * as iconPaths from './iconPaths'

/** 统一空态（Task 6，Phase 1 审查共性）：四处空态样式不一（padding 16/8/32px、各自 opacity .6）
 *  收口为 padding 32px 0 + body-medium + on-surface-variant + 居中。
 *  文案经 text prop 注入（MiniApp 等 desktop 壳层无 i18n 插件，tr 取词后传入），组件零 i18n 依赖；
 *  icon 可选传 iconPaths 注册名（如 'close'），未知名优雅降级不渲染 svg */
const props = defineProps<{ text: string; icon?: string }>()

/** iconPaths 是具名常量集，按名查表：注册表收敛在 iconPaths.ts 单点，此处不复制清单 */
const REGISTRY = iconPaths as unknown as Record<string, IconPath | undefined>
const path = computed(() => (props.icon ? REGISTRY[props.icon] : undefined))
</script>

<template>
  <div class="empty-state">
    <!-- Material Symbols 24dp 惯例（对照 MdFab/CodesPage 把手内联 SVG 先例）；icon 是可选装饰，对读屏隐藏 -->
    <svg v-if="path" :viewBox="path.viewBox" width="24" height="24" fill="currentColor" aria-hidden="true"><path :d="path.d" /></svg>
    {{ text }}
  </div>
</template>

<style scoped>
/* 统一目标值（brief Interfaces 逐字）：替代四处各自的 padding 16/8/32px + opacity .6 */
.empty-state { text-align: center; padding: 32px 0; color: var(--md-sys-color-on-surface-variant); font-size: var(--md-sys-typescale-body-medium); }
.empty-state svg { display: block; margin: 0 auto 8px; }
</style>
