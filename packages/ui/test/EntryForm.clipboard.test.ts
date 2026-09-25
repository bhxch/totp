import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createMemoryStorage, getBuiltinIcons, type OtpEntry } from '@totp/core'
import { createIconStore } from '../src/iconStore'

const URI = 'otpauth://totp/ClipSvc:me@x.com?secret=JBSWY3DPEHPK3PXP&issuer=ClipSvc'

type Snapshot = { image: Blob | null; text: string }
const { readClipboardSnapshot } = vi.hoisted(() => ({ readClipboardSnapshot: vi.fn() }))
const { decodeQrToUri } = vi.hoisted(() => ({ decodeQrToUri: vi.fn() }))
// readClipboardSnapshot 受控替身；resolveTextIntent 保持真实实现（意图分流逻辑本体另有纯函数测试）
vi.mock('../src/clipboardImport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/clipboardImport')>()
  return { ...actual, readClipboardSnapshot }
})
// 像素解码与 QR 识别均受控（jsdom 无 2d 上下文，同 BatchPastePanel.images 模式）
vi.mock('../src/qr/imageSource', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/qr/imageSource')>()
  return { ...actual, blobToPixels: vi.fn(async () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 })) }
})
vi.mock('../src/qr/decodeQr', () => ({ decodeQrToUri }))

import EntryForm from '../src/components/EntryForm.vue'
import { createVueStore } from '../src/store'
import { createTestI18n } from './helpers/i18n'

async function mountForm(over: Record<string, unknown> = {}): Promise<VueWrapper> {
  const store = createVueStore(createMemoryStorage())
  await store.initStore()
  const iconStore = createIconStore(createMemoryStorage())
  const w = mount(EntryForm, {
    global: { plugins: [createTestI18n()] },
    props: { initial: null, tags: [], icons: { builtin: getBuiltinIcons(), stored: iconStore.icons }, iconStore, ...over },
  })
  await vi.waitFor(() => expect(w.find('[data-test="clipboard-pick"]').exists()).toBe(true))
  return w
}

beforeEach(() => {
  readClipboardSnapshot.mockReset()
  decodeQrToUri.mockReset()
  decodeQrToUri.mockReturnValue({ uri: URI }) // 默认：识别成功回预填 URI；单用例可 mockReturnValueOnce 覆盖
})

describe('EntryForm 剪贴板三意图', () => {
  it('prefill：单条 URI → 覆盖 OTP 字段（issuer/label/secret 回填）', async () => {
    readClipboardSnapshot.mockResolvedValue({ image: null, text: URI })
    const w = await mountForm()
    await w.find('[data-test="clipboard-pick"]').trigger('click')
    await vi.waitFor(() => expect((w.find('input[aria-label="服务名"]').element as HTMLInputElement).value).toBe('ClipSvc'))
    expect((w.find('input[aria-label="账户名"]').element as HTMLInputElement).value).toBe('me@x.com')
    expect((w.find('input[placeholder="密钥 base32"]').element as HTMLInputElement).value).toBe('JBSWY3DPEHPK3PXP')
  })

  it('batch：多行 URI → importBatch 收到整批条目并上抛 batch-imported', async () => {
    readClipboardSnapshot.mockResolvedValue({ image: null, text: `${URI}\n${URI.replace('ClipSvc', 'Other')}` })
    const importBatch = vi.fn(async (entries: OtpEntry[]) => entries.length)
    const w = await mountForm({ importBatch })
    await w.find('[data-test="clipboard-pick"]').trigger('click')
    await vi.waitFor(() => expect(importBatch).toHaveBeenCalledTimes(1))
    expect(importBatch.mock.calls[0]![0]).toHaveLength(2)
    expect(w.emitted('batch-imported')![0]).toEqual([2])
  })

  it('batch 无能力（宿主未提供 importBatch）→ 「无法读取剪贴板」兜底错误', async () => {
    readClipboardSnapshot.mockResolvedValue({ image: null, text: `${URI}\n${URI}` })
    const w = await mountForm()
    await w.find('[data-test="clipboard-pick"]').trigger('click')
    await vi.waitFor(() => expect(w.text()).toContain('无法读取剪贴板'))
  })

  it('error：空剪贴板 → 「剪贴板没有可用内容」；解析失败消息透传', async () => {
    readClipboardSnapshot.mockResolvedValue({ image: null, text: '   ' })
    const w = await mountForm()
    await w.find('[data-test="clipboard-pick"]').trigger('click')
    await vi.waitFor(() => expect(w.text()).toContain('剪贴板没有可用内容'))

    readClipboardSnapshot.mockResolvedValue({ image: null, text: '{"foo": 1}' })
    await w.find('[data-test="clipboard-pick"]').trigger('click')
    await vi.waitFor(() => expect(w.text()).toContain('通用 JSON'))
  })

  it('读取失败（clipboard.read 抛错）→ 「无法读取剪贴板（需要授权或内容不可读）」', async () => {
    readClipboardSnapshot.mockRejectedValue(new Error('NotAllowedError'))
    const w = await mountForm()
    await w.find('[data-test="clipboard-pick"]').trigger('click')
    await vi.waitFor(() => expect(w.text()).toContain('需要授权或内容不可读'))
  })

  it('busy 防重入：读取在途期间再次点击不叠加请求', async () => {
    let release!: (v: Snapshot) => void
    const gate = new Promise<Snapshot>((r) => { release = r })
    readClipboardSnapshot.mockReturnValue(gate)
    const w = await mountForm()
    await w.find('[data-test="clipboard-pick"]').trigger('click')
    await w.find('[data-test="clipboard-pick"]').trigger('click') // busy 中第二次点击
    release({ image: null, text: URI })
    await vi.waitFor(() => expect((w.find('input[aria-label="服务名"]').element as HTMLInputElement).value).toBe('ClipSvc'))
    expect(readClipboardSnapshot).toHaveBeenCalledTimes(1)
  })
})

describe('EntryForm 剪贴板图片 QR', () => {
  it('有图有文：图优先走 QR 识别 → 预填', async () => {
    readClipboardSnapshot.mockResolvedValue({ image: new Blob(['x'], { type: 'image/png' }), text: URI })
    const w = await mountForm()
    await w.find('[data-test="clipboard-pick"]').trigger('click')
    await vi.waitFor(() => expect((w.find('input[aria-label="服务名"]').element as HTMLInputElement).value).toBe('ClipSvc'))
  })

  it('图解码失败（非二维码）：错误直接展示不崩', async () => {
    decodeQrToUri.mockReturnValueOnce({ error: '未识别到二维码' })
    readClipboardSnapshot.mockResolvedValue({ image: new Blob(['x'], { type: 'image/png' }), text: '' })
    const w = await mountForm()
    await w.find('[data-test="clipboard-pick"]').trigger('click')
    await vi.waitFor(() => expect(w.text()).toContain('未识别到二维码'))
  })

  it('图解码成功但非 otpauth URI：解析错误直接展示', async () => {
    decodeQrToUri.mockReturnValueOnce({ uri: 'https://example.com/nope' })
    readClipboardSnapshot.mockResolvedValue({ image: new Blob(['x'], { type: 'image/png' }), text: '' })
    const w = await mountForm()
    await w.find('[data-test="clipboard-pick"]').trigger('click')
    await vi.waitFor(() => expect(w.text()).toContain('不是有效的 otpauth'))
  })
})

describe('EntryForm 剪贴板预填字段回填（counter/pin 两向）', () => {
  it('hotp URI：counter 回填表单（applyPrefill counter 分支）', async () => {
    readClipboardSnapshot.mockResolvedValue({
      image: null,
      text: 'otpauth://hotp/HotpSvc:me@x.com?secret=JBSWY3DPEHPK3PXP&counter=7',
    })
    const w = await mountForm()
    await w.find('[data-test="clipboard-pick"]').trigger('click')
    await vi.waitFor(() => expect((w.find('input[aria-label="服务名"]').element as HTMLInputElement).value).toBe('HotpSvc'))
    expect((w.find('.counter input').element as HTMLInputElement).value).toBe('7')
  })

  it('yaotp URI：pin 回填表单（applyPrefill pin 分支）', async () => {
    readClipboardSnapshot.mockResolvedValue({
      image: null,
      text: 'otpauth://yaotp/Ya:user?secret=JBSWY3DPEHPK3PXP&pin=1234',
    })
    const w = await mountForm()
    await w.find('[data-test="clipboard-pick"]').trigger('click')
    await vi.waitFor(() => expect((w.find('input[placeholder="Yandex PIN"]').element as HTMLInputElement).value).toBe('1234'))
  })
})

describe('EntryForm 图标包大小前置拦截（F15 第一道闸）', () => {
  it('超 10MB 文件：读入前拒绝并提示，不进入 zip 解压', async () => {
    const w = await mountForm()
    const importIconPackZip = vi.fn()
    const mod = await import('../src/iconImport')
    const spy = vi.spyOn(mod, 'importIconPackZip').mockImplementation(importIconPackZip as never)
    await w.find('details.icon-picker summary').trigger('click')
    const big = new File([new Uint8Array(8)], 'big.zip')
    Object.defineProperty(big, 'size', { value: 11 * 1024 * 1024 })
    Object.defineProperty(w.find('input.pack-file').element, 'files', { value: [big], configurable: true })
    await w.find('input.pack-file').trigger('change')
    await vi.waitFor(() => expect(w.find('.icon-picker .error').text()).toContain('图标包超过 10MB 大小上限'))
    expect(importIconPackZip).not.toHaveBeenCalled()
    spy.mockRestore()
  })
})
