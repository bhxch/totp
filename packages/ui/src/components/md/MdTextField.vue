<script lang="ts">
// 模块级计数器:跨实例唯一(测试中每次 mount 为独立 app,useId() 会重置)
let errorIdCounter = 0
let hintIdCounter = 0
</script>
<script setup lang="ts">
import { computed, useAttrs } from 'vue'
// inheritAttrs:false + $attrs 透传内部 input：autocomplete/min/max/disabled/onKeydown/data-* 等直达原生 input；
// class/style 例外——关闭自动继承后 Vue 不再落根，须显式绑回根元素（消费方布局 class 依赖根元素）
defineOptions({ inheritAttrs: false })
const props = withDefaults(defineProps<{ modelValue: string; label: string; type?: string; error?: string; hint?: string; placeholder?: string; ariaLabel?: string; multiline?: boolean; rows?: number; dense?: boolean }>(), { type: 'text', error: '', hint: '', placeholder: '', multiline: false, rows: 3, dense: false })
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()
const errorId = `md-text-field-error-${++errorIdCounter}`
const hintId = `md-text-field-hint-${++hintIdCounter}`
// aria-describedby 读屏关联（Phase 2 审查挂账）：error 优先指 error id（现状语义不变），
// 否则 hint 存在指 hint id，都无移除（supporting 文案未渲染时悬空引用比无引用更扰读屏）
const describedBy = computed(() => (props.error ? errorId : props.hint ? hintId : undefined))
const attrs = useAttrs()
// disabled 经 $attrs 透传内部 input,组件内自行感知以做视觉降级(对齐 MdSwitch/MdCheckbox 的 opacity .38);
// $attrs 响应式,动态增删 disabled 时类名跟随。'' 与缺省视为禁用/未禁用的 HTML 原生语义边界
const isDisabled = computed(() => {
  const v = attrs.disabled
  return v !== undefined && v !== false
})
const inputAttrs = computed(() => {
  const rest: Record<string, unknown> = { ...attrs }
  delete rest.class
  delete rest.style
  return rest
})
</script>
<template>
  <div class="md-text-field" :class="[attrs.class, { 'md-text-field--error': !!error, 'md-text-field--disabled': isDisabled }]" :style="attrs.style">
    <label class="md-text-field__box" :class="{ 'md-text-field__box--dense': dense }">
      <span class="md-text-field__label" :class="{ 'md-text-field__label--floated': multiline || !!modelValue || !!placeholder }">{{ label }}</span>
      <input v-if="!multiline" v-bind="inputAttrs" class="md-text-field__input" :type="type" :value="modelValue" :placeholder="placeholder"
        :aria-label="ariaLabel" :aria-invalid="error ? 'true' : undefined" :aria-describedby="describedBy"
        @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)" />
      <textarea v-else v-bind="inputAttrs" class="md-text-field__input md-text-field__textarea" :rows="rows" :value="modelValue" :placeholder="placeholder"
        :aria-label="ariaLabel" :aria-invalid="error ? 'true' : undefined" :aria-describedby="describedBy"
        @input="emit('update:modelValue', ($event.target as HTMLTextAreaElement).value)" />
    </label>
    <!-- supporting 槽位：error 优先（error 态被 error 文本取代），常态兜底 hint（Task 4）；
      读屏经 aria-describedby 关联（error→errorId / hint→hintId，Task 2） -->
    <p v-if="error || hint" :id="error ? errorId : hintId" :class="error ? 'md-text-field__error' : 'md-text-field__hint'">{{ error || hint }}</p>
  </div>
</template>
<style scoped>
.md-text-field { display: flex; flex-direction: column; gap: 4px; font: inherit; }
/* filled 容器 56dp（M3 官网核实）：用 min-height 而非 height——dense 块的 min-height:40px
 * 同特异性后序天然覆写生效（Task 7 dense 与 56 基线并存，Task 7 复审裁定） */
.md-text-field__box { position: relative; box-sizing: border-box; display: flex; flex-direction: column; justify-content: center;
  min-height: 56px; padding: 0 16px; background: var(--field-bg, var(--md-sys-color-surface-container-highest));
  border-radius: 4px 4px 0 0; border-bottom: 1px solid var(--md-sys-color-outline-variant); }
/* hover state layer：混入 filled 底色而非 transparent（brief 字面 color-mix transparent 会整体替换
 * background 丢失 filled 底色；8% on-surface 混入底色与 state layer 叠加等价）；
 * 补 disabled 豁免（Task 3）：祖链 :not(--disabled) 限定，禁用态不再浮起 */
.md-text-field:not(.md-text-field--disabled) .md-text-field__box:hover:not(:focus-within) { --field-bg: color-mix(in srgb, var(--md-sys-color-on-surface) var(--md-sys-state-layer-hover), var(--md-sys-color-surface-container-highest)); }
/* active indicator 绝对定位叠于底边框（bottom:-1px 盖住 1px border），聚焦 scaleX 展开；
 * 取代原「1px→2px border」写法，消除聚焦时 1px 布局位移 */
.md-text-field__box::after { content: ''; position: absolute; left: 0; right: 0; bottom: -1px; height: 2px;
  background: var(--md-sys-color-primary); transform: scaleX(0); transition: transform .12s; }
.md-text-field__box:focus-within::after { transform: scaleX(1); }
.md-text-field__box:focus-within { border-bottom-color: transparent; }
.md-text-field--error .md-text-field__box { border-bottom-color: var(--md-sys-color-error); }
.md-text-field--error .md-text-field__box::after { background: var(--md-sys-color-error); }
.md-text-field--disabled { opacity: .38; cursor: default; }
.md-text-field--disabled .md-text-field__input { cursor: default; }
.md-text-field__label { position: absolute; left: 16px; top: 50%; transform: translateY(-50%);
  font-size: var(--md-sys-typescale-body-large); color: var(--md-sys-color-on-surface-variant); pointer-events: none; transition: all .15s; }
.md-text-field__label--floated,
.md-text-field__box:focus-within .md-text-field__label { top: 8px; transform: none; font-size: var(--md-sys-typescale-body-small); }
/* dense 40px 槽：floated label 收缩至 label-small 并贴顶，input 下移——真机量测重叠 5px 的修正（40px 槽为本项目 opt-in deviation，M3 无 density 规范） */
.md-text-field__box--dense .md-text-field__label--floated,
.md-text-field__box--dense:focus-within .md-text-field__label { top: 2px; font-size: var(--md-sys-typescale-label-small); line-height: 1; }
.md-text-field__box:focus-within .md-text-field__label { color: var(--md-sys-color-primary); }
.md-text-field--error .md-text-field__box:focus-within .md-text-field__label,
.md-text-field--error .md-text-field__label { color: var(--md-sys-color-error); }
/* padding 迁入 box（0 16px），input 仅占内容行；行高固定 24 保 56px 内垂直节奏 */
.md-text-field__input { width: 100%; box-sizing: border-box; border: none; outline: none; background: transparent;
  padding: 0; font: inherit; font-size: var(--md-sys-typescale-body-large); line-height: 24px; color: var(--md-sys-color-on-surface); }
.md-text-field__input::placeholder { color: var(--md-sys-color-on-surface-variant); }
.md-text-field__error { margin: 0; padding: 0 16px; font-size: var(--md-sys-typescale-body-small); color: var(--md-sys-color-error); }
/* hint：supporting 槽位常态文案（error 优先），body-small on-surface-variant（M3 supporting text） */
.md-text-field__hint { margin: 0; padding: 0 16px; font-size: var(--md-sys-typescale-body-small); color: var(--md-sys-color-on-surface-variant); }
/* multiline：box 只给水平 padding，textarea 首行自留浮动 label 空间（原顶部 22px 由 input padding 承担） */
.md-text-field__textarea { resize: vertical; min-height: 72px; line-height: 1.5; padding-top: 24px; }
/* dense 档（spec §2.5 compact，mini/popup 快速窗）：40px 高 + body-medium 槽位。
 * min-height:40 后序覆写 56 基线；padding 覆写 box 的 0 16px（input padding 已归零，本块零改动生效） */
.md-text-field__box--dense { min-height: 40px; padding: 11px 12px 3px; }
.md-text-field__box--dense .md-text-field__label { left: 12px; } /* dense 水平 padding 12px，label 同步内缩（Task 7 挂账的 4px 错位） */
.md-text-field__box--dense .md-text-field__label--floated,
.md-text-field__box--dense:focus-within .md-text-field__label { top: 2px; } /* 40px 槽位内 label top:8px 会压 input 行，上提保间距 */
.md-text-field__box--dense .md-text-field__input { font-size: var(--md-sys-typescale-body-medium); line-height: 20px; }
</style>
