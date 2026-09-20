<script setup lang="ts">
import type { OtpEntry } from '@totp/core'
import { ref, watch } from 'vue'
import MdButton from './md/MdButton.vue'
import MdDialog from './md/MdDialog.vue'
import { renderQrSheet } from './qrSheet'

const props = defineProps<{
  open: boolean
  entries: OtpEntry[]
  /** [可选] 保存实现（宿主注入：extension=a[download]、desktop=Tauri save 对话框）；未传时「保存图片」隐藏 */
  saveImage?: (name: string, dataUrl: string) => Promise<boolean>
}>()
const emit = defineEmits<{ close: [] }>()
const canvasRef = ref<HTMLCanvasElement | null>(null)

watch(
  () => [props.open, props.entries] as const,
  ([open, entries]) => {
    if (!open || entries.length === 0) return
    // canvas 随下一帧可用（MdDialog v-if 挂载）；jsdom 无 2d 时 renderQrSheet 早退只回布局
    void Promise.resolve().then(() => {
      if (canvasRef.value) renderQrSheet(canvasRef.value, entries)
    })
  },
  { immediate: true },
)

/** 保存图片：canvas → PNG dataUrl 交宿主落盘（固定名，dataUrl 只在调用链内存在） */
function onSave() {
  const dataUrl = canvasRef.value?.toDataURL('image/png')
  if (dataUrl) void props.saveImage?.('totp-qr-sheet.png', dataUrl)
}
</script>
<template>
  <MdDialog class="sheet-dialog" :open="open && entries.length > 0" :headline="`扫码迁移（${entries.length} 个条目）`" @close="emit('close')">
    <div class="sheet-wrap">
      <canvas ref="canvasRef" role="img" :aria-label="`包含 ${entries.length} 个条目密钥的二维码拼版`"></canvas>
      <p class="sheet-warn">二维码包含完整密钥，请勿截图或分享</p>
    </div>
    <template #actions>
      <MdButton v-if="saveImage" data-test="sheet-save" @click="onSave">保存图片</MdButton>
      <MdButton data-test="sheet-close" @click="emit('close')">关闭</MdButton>
    </template>
  </MdDialog>
</template>
<style scoped>
/* 拼版宽（2 列 520px 起）：放开 MdDialog 560px 默认上限，attrs class 落在其根元素（父作用域样式可命中子组件根） */
.sheet-dialog { max-width: 920px; }
.sheet-wrap { display: grid; place-items: center; gap: 10px; }
/* 大画布缩到弹窗宽内展示（height:auto 保比例；保存导出的仍是全尺寸 PNG） */
.sheet-wrap canvas { max-width: 100%; height: auto; background: #fff; border-radius: 8px; }
.sheet-warn { color: var(--md-sys-color-error); font-size: var(--md-sys-typescale-body-medium); }
</style>
