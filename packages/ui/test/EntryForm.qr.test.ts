import { mount, type VueWrapper } from '@vue/test-utils'
import { createTestI18n } from './helpers/i18n'
import { describe, expect, it, vi } from 'vitest'

const mockUri = 'otpauth://totp/Gen:pix?secret=JBSWY3DPEHPK3PXP&issuer=Gen'
// DecodeResult 用真实模块的返回类型（union），失败分支 mockReturnValueOnce({error}) 才能过 vue-tsc
type DecodeResult = ReturnType<typeof import('../src/qr/decodeQr').decodeQrToUri>
vi.mock('../src/qr/decodeQr', () => ({
  // 工厂不能引用非 mock 前缀外层变量（vi.mock hoisting），uri 内联为 mockUri（vitest 会连同 hoist）
  decodeQrToUri: vi.fn<() => DecodeResult>(() => ({ uri: mockUri })),
}))
vi.mock('../src/qr/imageSource', () => ({
  blobToPixels: vi.fn(async () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 })),
}))

import EntryForm from '../src/components/EntryForm.vue'

/** 模拟选择二维码图片并触发 change（configurable 使同一 wrapper 可重复定义，双次选文件用） */
async function pickQr(w: VueWrapper): Promise<void> {
  const input = w.find<HTMLInputElement>('input[type="file"][data-test="qr-file"]')
  Object.defineProperty(input.element, 'files', { value: [new File(['x'], 'q.png', { type: 'image/png' })], configurable: true })
  await input.trigger('change')
}

describe('EntryForm 从图片识别', () => {
  it('识别成功回填 issuer/label/secret', async () => {
    const w = mount(EntryForm, { global: { plugins: [createTestI18n()] } })
    await pickQr(w)
    await vi.waitFor(() => {
      const issuer = w.find('[aria-label="服务名"] input, [aria-label="服务名"]').element as HTMLInputElement
      expect(issuer.value).toBe('Gen')
    })
  })
  it('识别失败显示中文原因', async () => {
    const { decodeQrToUri } = await import('../src/qr/decodeQr')
    vi.mocked(decodeQrToUri).mockReturnValueOnce({ error: '未识别到二维码' })
    const w = mount(EntryForm, { global: { plugins: [createTestI18n()] } })
    await pickQr(w)
    await vi.waitFor(() => expect(w.text()).toContain('未识别到二维码'))
  })
  it('yandex 二维码预填：pin 回填表单（I1b，yaotp URI 的 pin 不再丢失）', async () => {
    const { decodeQrToUri } = await import('../src/qr/decodeQr')
    vi.mocked(decodeQrToUri).mockReturnValueOnce({
      uri: 'otpauth://yaotp/Yandex:user?secret=KJTEUGOD5SNXVWBCWJ4G36W4IA&pin=1234',
    })
    const w = mount(EntryForm, { global: { plugins: [createTestI18n()] } })
    await pickQr(w)
    await vi.waitFor(() => {
      const pin = w.find('[aria-label="Yandex PIN（可选）"]').element as HTMLInputElement
      expect(pin.value).toBe('1234')
    })
  })
  it('QR 预填成功后清除残留错误（Task 15 遗留）', async () => {
    const { decodeQrToUri } = await import('../src/qr/decodeQr')
    const w = mount(EntryForm, { global: { plugins: [createTestI18n()] } })
    vi.mocked(decodeQrToUri).mockReturnValueOnce({ error: '未识别到二维码' })
    await pickQr(w)
    await vi.waitFor(() => expect(w.text()).toContain('未识别到二维码'))
    vi.mocked(decodeQrToUri).mockReturnValueOnce({ uri: mockUri })
    await pickQr(w)
    await vi.waitFor(() => expect(w.text()).not.toContain('未识别到二维码'))
  })
})
