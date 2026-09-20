import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { createMemoryStorage } from '@totp/core'
import { createTestI18n } from './helpers/i18n'

const mockUriA = 'otpauth://totp/GitHub:alice?secret=JBSWY3DPEHPK3PXP&issuer=GitHub'
const mockUriB = 'otpauth://totp/GitLab:bob?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=GitLab'

// DecodeResult 用真实模块的返回类型（union），失败分支 mockReturnValueOnce({error}) 才能过 vue-tsc
type DecodeResult = ReturnType<typeof import('../src/qr/decodeQr').decodeQrToUri>
vi.mock('../src/qr/decodeQr', () => ({
  // 工厂不能引用非 mock 前缀外层变量（vi.mock hoisting），uri 用 mock 前缀常量（vitest 会连同 hoist）
  decodeQrToUri: vi.fn<() => DecodeResult>(() => ({ uri: mockUriA })),
}))
// imageSource 保留真实 imagesFromClipboard（走真剪贴板 items 解析），仅 mock 像素读取
vi.mock('../src/qr/imageSource', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/qr/imageSource')>()
  return {
    ...actual,
    blobToPixels: vi.fn(async () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 })),
  }
})

import BatchPastePanel from '../src/components/BatchPastePanel.vue'
import type { ImagePixels } from '../src/qr/decodeQr'
import { decodeQrToUri } from '../src/qr/decodeQr'
import { blobToPixels } from '../src/qr/imageSource'
import { createVueStore } from '../src/store'

function mkStore() {
  const store = createVueStore(createMemoryStorage())
  return store.initStore().then(() => store)
}

/** 构造剪贴板文件项：仅 imagesFromClipboard 触及 kind/type/getAsFile 三成员 */
function fileItem(name: string): DataTransferItem {
  return {
    kind: 'file',
    type: 'image/png',
    getAsFile: () => new File(['x'], name, { type: 'image/png' }),
  } as unknown as DataTransferItem
}

async function pasteItems(w: ReturnType<typeof mount>, items: DataTransferItem[]): Promise<void> {
  await w.find('[data-test="paste-zone"]').trigger('paste', { clipboardData: { items } })
}

describe('BatchPastePanel 批量图片', () => {
  it('粘贴 2 张图 1 成 1 败：结果区 1 行可添加 + 1 行失败提示，添加计 1', async () => {
    const store = await mkStore()
    const w = mount(BatchPastePanel, { global: { plugins: [createTestI18n()] }, props: { store } })
    vi.mocked(decodeQrToUri).mockReturnValueOnce({ uri: mockUriB }).mockReturnValueOnce({ error: '未识别到二维码' })
    await pasteItems(w, [fileItem('a.png'), fileItem('b.png')])
    await vi.waitFor(() => expect(w.findAll('[data-test="paste-row"]')).toHaveLength(1))
    expect(w.text()).toContain('b.png')
    expect(w.text()).toContain('未识别到二维码')
    await w.find('[data-test="paste-commit"]').trigger('click')
    await vi.waitFor(() => expect(w.emitted('added')?.[0]).toEqual([1]))
    expect(store.vault.entries).toHaveLength(1)
  })

  it('成功图片与文本解析结果合并计数：1 文本行 + 1 图行，添加计 2', async () => {
    const store = await mkStore()
    const w = mount(BatchPastePanel, { global: { plugins: [createTestI18n()] }, props: { store } })
    await w.find('textarea').setValue(mockUriA)
    await w.find('[data-test="paste-parse"]').trigger('click')
    expect(w.findAll('[data-test="paste-row"]')).toHaveLength(1)
    vi.mocked(decodeQrToUri).mockReturnValueOnce({ uri: mockUriB })
    await pasteItems(w, [fileItem('b.png')])
    await vi.waitFor(() => expect(w.findAll('[data-test="paste-row"]')).toHaveLength(2))
    await w.find('[data-test="paste-commit"]').trigger('click')
    await vi.waitFor(() => expect(w.emitted('added')?.[0]).toEqual([2]))
    expect(store.vault.entries).toHaveLength(2)
  })

  it('同一二维码贴两次：去重不双写，落库恰 1 条', async () => {
    const store = await mkStore()
    const w = mount(BatchPastePanel, { global: { plugins: [createTestI18n()] }, props: { store } })
    const zone = w.find('[data-test="paste-zone"]')
    await pasteItems(w, [fileItem('a.png')])
    await vi.waitFor(() => expect(w.findAll('[data-test="paste-row"]')).toHaveLength(1))
    // 第二次解码用受控 promise：确保「仍 1 行」的断言发生在第二次解码完成之后
    let resolvePixels!: (v: ImagePixels) => void
    vi.mocked(blobToPixels).mockImplementationOnce(
      () => new Promise<ImagePixels>((res) => { resolvePixels = res }),
    )
    await pasteItems(w, [fileItem('a2.png')])
    expect(w.text()).toContain('解码中')
    resolvePixels({ data: new Uint8ClampedArray(4), width: 1, height: 1 })
    await vi.waitFor(() => expect(w.text()).not.toContain('解码中'))
    expect(w.findAll('[data-test="paste-row"]')).toHaveLength(1)
    await w.find('[data-test="paste-commit"]').trigger('click')
    await vi.waitFor(() => expect(w.emitted('added')?.[0]).toEqual([1]))
    expect(store.vault.entries).toHaveLength(1)
  })

  it('拖放图片文件同样进入解码并出现在结果区', async () => {
    const store = await mkStore()
    const w = mount(BatchPastePanel, { global: { plugins: [createTestI18n()] }, props: { store } })
    const file = new File(['x'], 'drop.png', { type: 'image/png' })
    await w.find('[data-test="paste-zone"]').trigger('drop', { dataTransfer: { files: [file] } })
    await vi.waitFor(() => expect(w.findAll('[data-test="paste-row"]')).toHaveLength(1))
    expect(w.text()).toContain('GitHub')
  })

  it('拖入非图片文件：preventDefault 兜底取消导航，rows/imageErrors 不变', async () => {
    const store = await mkStore()
    const w = mount(BatchPastePanel, { global: { plugins: [createTestI18n()] }, props: { store } })
    // VTU 2.5 的 trigger 会跳过原型上无 setter 的属性（preventDefault 正是），无法注入 mock；
    // 构造真实 drop 事件 spy preventDefault，并以 defaultPrevented 断言导航确被取消
    const event = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'dataTransfer', {
      value: { files: [new File(['x'], 'doc.pdf', { type: 'application/pdf' })] },
    })
    const preventDefault = vi.spyOn(event, 'preventDefault')
    w.find('[data-test="paste-zone"]').element.dispatchEvent(event)
    await nextTick()
    expect(preventDefault).toHaveBeenCalledTimes(1)
    expect(event.defaultPrevented).toBe(true)
    expect(w.findAll('[data-test="paste-row"]')).toHaveLength(0)
    expect(w.findAll('[data-test="paste-image-error"]')).toHaveLength(0)
  })
})
