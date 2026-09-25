import { describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createMemoryStorage, getBuiltinIcons, type OtpEntry } from '@totp/core'
import { zipSync } from 'fflate'
import { createIconStore } from '../src/iconStore'

const { decodeQrToUri } = vi.hoisted(() => ({ decodeQrToUri: vi.fn() }))
vi.mock('../src/qr/decodeQr', () => ({ decodeQrToUri }))
vi.mock('../src/qr/imageSource', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/qr/imageSource')>()
  return { ...actual, blobToPixels: vi.fn(async () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 })) }
})

import EntryForm from '../src/components/EntryForm.vue'
import { createTestI18n } from './helpers/i18n'

// jsdom 25 的 Blob 未实现 arrayBuffer()：FileReader polyfill（仅测试环境生效，EntryForm.test.ts 同款）
if (typeof Blob.prototype.arrayBuffer !== 'function') {
  Blob.prototype.arrayBuffer = function (this: Blob): Promise<ArrayBuffer> {
    return new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as ArrayBuffer)
      reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'))
      reader.readAsArrayBuffer(this)
    })
  }
}

function mkIconStore() {
  return createIconStore(createMemoryStorage())
}

async function mountForm(props: Record<string, unknown> = {}): Promise<VueWrapper> {
  const iconStore = mkIconStore()
  const w = mount(EntryForm, {
    global: { plugins: [createTestI18n()] },
    props: { initial: null, tags: [], icons: { builtin: getBuiltinIcons(), stored: iconStore.icons }, iconStore, ...props },
  })
  return w
}

async function pickOption(w: VueWrapper, ariaLabel: string, label: string): Promise<void> {
  await w.find(`button[aria-label="${ariaLabel}"]`).trigger('click')
  await w.findAll('[role="option"]').find((o) => o.text() === label)!.trigger('click')
}

function setFiles(w: VueWrapper, selector: string, files: File[]): void {
  Object.defineProperty(w.find(selector).element, 'files', { value: files, configurable: true })
}

function mkEntry(): OtpEntry {
  return {
    uuid: 'u1', type: 'totp', issuer: 'GitHub', label: 'me@ex.com', secret: 'JBSWY3DPEHPK3PXP',
    algorithm: 'SHA1', digits: 6, period: 30, tagIds: [], order: 0, createdAt: 0,
  }
}

describe('EntryForm 提交校验守卫（digits/period/counter 三向）', () => {
  it('totp digits 越界（9）：digitsError 阻止提交', async () => {
    const w = await mountForm()
    await w.find('.digits input').setValue('9')
    await w.find('form').trigger('submit')
    expect(w.text()).toContain('位数必须为 6/7/8')
    expect(w.emitted('save')).toBeUndefined()
  })
  it('period 非法（0）：periodError 阻止提交', async () => {
    const w = await mountForm()
    await w.find('.period input').setValue('0')
    await w.find('form').trigger('submit')
    expect(w.text()).toContain('周期必须为 ≥1 的数字')
    expect(w.emitted('save')).toBeUndefined()
  })
  it('hotp counter 非法（负数）：counterError 阻止提交', async () => {
    const w = await mountForm()
    await pickOption(w, '类型', 'HOTP（计数器）')
    await vi.waitFor(() => expect(w.find('.counter').exists()).toBe(true))
    await w.find('.counter input').setValue('-1')
    await w.find('form').trigger('submit')
    expect(w.text()).toContain('计数器必须为非负整数')
    expect(w.emitted('save')).toBeUndefined()
  })
})

describe('EntryForm QR 文件选择边界', () => {
  it('change 事件无文件（取消选择）：静默返回不崩', async () => {
    decodeQrToUri.mockReset()
    const w = await mountForm()
    await w.find('[data-test="qr-file"]').trigger('change')
    expect(decodeQrToUri).not.toHaveBeenCalled()
  })
  it('图非 otpauth 二维码：解析错误直接展示', async () => {
    decodeQrToUri.mockReset()
    decodeQrToUri.mockReturnValue({ uri: 'https://example.com/not-a-otpauth' })
    const w = await mountForm()
    setFiles(w, '[data-test="qr-file"]', [new File([new Uint8Array([1])], 'qr.png', { type: 'image/png' })])
    await w.find('[data-test="qr-file"]').trigger('change')
    await vi.waitFor(() => expect(w.text()).toContain('不是有效的 otpauth'))
  })
})

describe('EntryForm 内联建 tag 守卫', () => {
  it('空名称回车：不调 createTag', async () => {
    const createTag = vi.fn(async () => 't1')
    const w = await mountForm({ tags: [], createTag })
    await w.find('.new-tag input').setValue('   ')
    await w.find('.new-tag input').trigger('keydown.enter')
    expect(createTag).not.toHaveBeenCalled()
  })
})

describe('EntryForm 当前图标解析回退', () => {
  it('icons prop 缺省（未注入）：builtin 回退 getBuiltinIcons() 内置表仍可渲染 svg', async () => {
    const w = mount(EntryForm, {
      global: { plugins: [createTestI18n()] },
      props: { initial: { ...mkEntry(), icon: { kind: 'builtin' as const, id: 'github' } }, tags: [] },
    })
    await vi.waitFor(() => expect(w.find('svg').exists()).toBe(true))
  })
})

describe('EntryForm 图标包导入异常路径', () => {
  it('change 无文件：不进入导入流程', async () => {
    const w = await mountForm()
    const mod = await import('../src/iconImport')
    const spy = vi.spyOn(mod, 'importIconPackZip')
    await w.find('details.icon-picker summary').trigger('click')
    await w.find('input.pack-file').trigger('change')
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })
  it('解压抛非 Error 值：String 兜底展示', async () => {
    const w = await mountForm()
    const mod = await import('../src/iconImport')
    const spy = vi.spyOn(mod, 'importIconPackZip').mockImplementation(() => { throw 'boom-string' })
    await w.find('details.icon-picker summary').trigger('click')
    setFiles(w, 'input.pack-file', [new File([zipSync({ 'a/x.png': new Uint8Array([1]) })], 'pack.zip')])
    await w.find('input.pack-file').trigger('change')
    await vi.waitFor(() => expect(w.find('.icon-picker .error').text()).toBe('boom-string'))
    spy.mockRestore()
  })
})
