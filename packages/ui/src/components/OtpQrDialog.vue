<script setup lang="ts">
import { buildOtpUri, type OtpEntry } from '@totp/core'
import { watch, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import MdButton from './md/MdButton.vue'
import MdDialog from './md/MdDialog.vue'
import { drawQrToCanvas, qrMatrix } from '../qr/qrDraw'

const { t } = useI18n()

const props = defineProps<{ open: boolean; entry: OtpEntry | null }>()
const emit = defineEmits<{ close: [] }>()
const canvasRef = ref<HTMLCanvasElement | null>(null)

watch(
  () => [props.open, props.entry] as const,
  ([open, e]) => {
    if (!open || !e) return
    // canvas 随下一帧可用（MdDialog v-if 挂载）
    void Promise.resolve().then(() => {
      if (canvasRef.value) drawQrToCanvas(canvasRef.value, qrMatrix(buildOtpUri({ type: e.type, issuer: e.issuer, label: e.label, secret: e.secret, algorithm: e.algorithm, digits: e.digits, period: e.period, counter: e.counter })), { moduleSize: 6 })
    })
  },
  { immediate: true },
)
</script>
<template>
  <MdDialog :open="open && entry !== null" :headline="entry ? `${entry.issuer} · ${entry.label}` : ''" @close="emit('close')">
    <div class="qr-wrap">
      <canvas ref="canvasRef" role="img" :aria-label="entry ? t('otpQrDialog.canvasAria', { issuer: entry.issuer, label: entry.label }) : ''"></canvas>
      <p class="qr-warn">{{ t('otpQrDialog.qrWarning') }}</p>
    </div>
    <template #actions>
      <MdButton data-test="qr-close" @click="emit('close')">{{ t('otpQrDialog.close') }}</MdButton>
    </template>
  </MdDialog>
</template>
<style scoped>
.qr-wrap { display: grid; place-items: center; gap: 10px; }
.qr-warn { color: var(--md-sys-color-error); font-size: var(--md-sys-typescale-body-medium); }
</style>
