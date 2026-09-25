import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createMemoryStorage, newEntryFromUri } from '@totp/core'

const URI_A = 'otpauth://totp/GitHub:alice?secret=JBSWY3DPEHPK3PXP&issuer=GitHub'
// 与 vault 现有 GitHub/alice 同 issuer+label 异 secret → conflict
const URI_CONFLICT = 'otpauth://totp/GitHub:alice?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=GitHub'
// drop 用图片 QR 受控结果（vi.mock 工厂引用；vite-node 按序执行，常量须先于组件 import 声明）
const MOCK_URI = 'otpauth://totp/DropSvc:carol?secret=MFRGGZDFMZTWQ2LK&issuer=DropSvc'

type DecodeResult = ReturnType<typeof import('../src/qr/decodeQr').decodeQrToUri>
vi.mock('../src/qr/decodeQr', () => ({
  decodeQrToUri: vi.fn<() => DecodeResult>(() => ({ uri: MOCK_URI })),
}))
vi.mock('../src/qr/imageSource', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/qr/imageSource')>()
  return { ...actual, blobToPixels: vi.fn(async () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 })) }
})

import BatchPastePanel from '../src/components/BatchPastePanel.vue'
import { decodeQrToUri } from '../src/qr/decodeQr'
import { createVueStore } from '../src/store'
import { createTestI18n } from './helpers/i18n'

async function pickChoice(w: ReturnType<typeof mount>, target: string, label: string): Promise<void> {
  await w.find(`button[aria-label="处理方式 ${target}"]`).trigger('click')
  await w.findAll('[role="option"]').find((o) => o.text() === label)!.trigger('click')
}

async function mkStoreWithGitHub() {
  const store = createVueStore(createMemoryStorage())
  await store.initStore()
  await store.addEntryOp(newEntryFromUri(URI_A, 0))
  return store
}

describe('BatchPastePanel parser 抛错兜底', () => {
  it('嗅探 aegis 但解析中断（结构级 throw）→ 错误展示不炸；无行时提交禁用', async () => {
    const store = createVueStore(createMemoryStorage())
    await store.initStore()
    const w = mount(BatchPastePanel, { global: { plugins: [createTestI18n()] }, props: { store } })
    await w.find('textarea').setValue('{"db": {}, "header": {}, "entries": 42}')
    await w.find('[data-test="paste-parse"]').trigger('click')
    expect(w.find('.err').text().length).toBeGreaterThan(0)
    expect(w.findAll('[data-test="paste-row"]')).toHaveLength(0)
    expect((w.find('[data-test="paste-commit"]').element as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('BatchPastePanel conflict 行内决策（replace/merge 批次落库）', () => {
  it('conflict 行选「覆盖现有」：commit 后原条目被替换', async () => {
    const store = await mkStoreWithGitHub()
    const w = mount(BatchPastePanel, { global: { plugins: [createTestI18n()] }, props: { store } })
    await w.find('textarea').setValue(URI_CONFLICT)
    await w.find('[data-test="paste-parse"]').trigger('click')
    expect(w.find('.kind--conflict').text()).toBe('冲突')
    await pickChoice(w, 'GitHub', '覆盖现有')
    await w.find('[data-test="paste-commit"]').trigger('click')
    await vi.waitFor(() => expect(w.emitted('added')?.[0]).toEqual([1]))
    expect(store.vault.entries).toHaveLength(1)
    expect(store.vault.entries[0]!.secret).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ') // 已被覆盖
  })

  it('conflict 行选「并存并集」：commit 后两条并存', async () => {
    const store = await mkStoreWithGitHub()
    const w = mount(BatchPastePanel, { global: { plugins: [createTestI18n()] }, props: { store } })
    await w.find('textarea').setValue(URI_CONFLICT)
    await w.find('[data-test="paste-parse"]').trigger('click')
    await pickChoice(w, 'GitHub', '并存并集')
    await w.find('[data-test="paste-commit"]').trigger('click')
    await vi.waitFor(() => expect(w.emitted('added')?.[0]).toEqual([1]))
    expect(store.vault.entries).toHaveLength(2)
  })

  it('conflict 行保持「跳过」：added=0 且 vault 不变', async () => {
    const store = await mkStoreWithGitHub()
    const w = mount(BatchPastePanel, { global: { plugins: [createTestI18n()] }, props: { store } })
    await w.find('textarea').setValue(URI_CONFLICT)
    await w.find('[data-test="paste-parse"]').trigger('click')
    await w.find('[data-test="paste-commit"]').trigger('click') // 默认 skip
    await vi.waitFor(() => expect(w.emitted('added')?.[0]).toEqual([0]))
    expect(store.vault.entries).toHaveLength(1)
  })

  it('混合批次：new 行默认 add + conflict 行改 replace，一次 commit 两批生效', async () => {
    const store = await mkStoreWithGitHub()
    const w = mount(BatchPastePanel, { global: { plugins: [createTestI18n()] }, props: { store } })
    await w.find('textarea').setValue(`${URI_CONFLICT}\notpauth://totp/NewSvc:bob?secret=MFRGGZDFMZTWQ2LK&issuer=NewSvc`)
    await w.find('[data-test="paste-parse"]').trigger('click')
    expect(w.findAll('[data-test="paste-row"]')).toHaveLength(2)
    await pickChoice(w, 'GitHub', '覆盖现有')
    await w.find('[data-test="paste-commit"]').trigger('click')
    await vi.waitFor(() => expect(w.emitted('added')?.[0]).toEqual([2]))
    expect(store.vault.entries).toHaveLength(2)
    expect(store.vault.entries.map((e) => e.issuer).sort()).toEqual(['GitHub', 'NewSvc'])
    expect(store.vault.entries.find((e) => e.issuer === 'GitHub')!.secret).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ')
  })
})

describe('BatchPastePanel 解析失败呈现', () => {
  it('unsupported 格式（无法识别）→ 错误横幅透传 parser 消息', async () => {
    const store = createVueStore(createMemoryStorage())
    await store.initStore()
    const w = mount(BatchPastePanel, { global: { plugins: [createTestI18n()] }, props: { store } })
    await w.find('textarea').setValue('{"foo": 1}')
    await w.find('[data-test="paste-parse"]').trigger('click')
    expect(w.text()).toContain('通用 JSON 请走导入页配置字段映射')
    expect(w.findAll('[data-test="paste-row"]')).toHaveLength(0)
  })
  it('0 条可导入 + 全行失败 → 「没有可导入的条目（N 行无法解析）」', async () => {
    const store = createVueStore(createMemoryStorage())
    await store.initStore()
    const w = mount(BatchPastePanel, { global: { plugins: [createTestI18n()] }, props: { store } })
    await w.find('textarea').setValue('xx otpauth://totp/a\nyy otpauth://totp/b')
    await w.find('[data-test="paste-parse"]').trigger('click')
    expect(w.text()).toContain('没有可导入的条目（2 行无法解析）')
  })
})

describe('BatchPastePanel suspect 行（同 seed 异账户）', () => {
  it('suspect 行仅 skip/add 两选项（无覆盖/并集语义）且默认跳过', async () => {
    const store = createVueStore(createMemoryStorage())
    await store.initStore()
    // 与现有 GitHub/alice 同 secret 异 issuer+label → suspect（疑似同账户换皮）
    await store.addEntryOp(newEntryFromUri(URI_A, 0))
    const w = mount(BatchPastePanel, { global: { plugins: [createTestI18n()] }, props: { store } })
    await w.find('textarea').setValue('otpauth://totp/OtherSvc:other@x.com?secret=JBSWY3DPEHPK3PXP&issuer=OtherSvc')
    await w.find('[data-test="paste-parse"]').trigger('click')
    expect(w.find('.kind--suspect').text()).toBe('疑似重复')
    await w.find('button[aria-label="处理方式 OtherSvc"]').trigger('click')
    const labels = w.findAll('[role="option"]').map((o) => o.text())
    expect(labels).toEqual(['跳过', '仍然添加'])
    await w.findAll('[role="option"]')[0]!.trigger('click') // 保持跳过
    await w.find('[data-test="paste-commit"]').trigger('click')
    await vi.waitFor(() => expect(w.emitted('added')?.[0]).toEqual([0]))
    expect(store.vault.entries).toHaveLength(1)
  })
})

describe('BatchPastePanel drop 边界', () => {
  it('无 dataTransfer 的 drop 事件：兜底不崩不导航', async () => {
    const store = createVueStore(createMemoryStorage())
    await store.initStore()
    const w = mount(BatchPastePanel, { global: { plugins: [createTestI18n()] }, props: { store } })
    w.find('[data-test="paste-zone"]').element.dispatchEvent(new Event('drop', { bubbles: true, cancelable: true }))
    await nextTick()
    expect(w.findAll('[data-test="paste-row"]')).toHaveLength(0)
    expect(w.findAll('[data-test="paste-image-error"]')).toHaveLength(0)
  })
})

describe('BatchPastePanel 拖拽混合文件', () => {
  it('drop 混合图片+非图片：仅图片进解码，非图片被过滤', async () => {
    const store = createVueStore(createMemoryStorage())
    await store.initStore()
    const w = mount(BatchPastePanel, { global: { plugins: [createTestI18n()] }, props: { store } })
    const img = new File(['x'], 'mix.png', { type: 'image/png' })
    const pdf = new File(['x'], 'mix.pdf', { type: 'application/pdf' })
    await w.find('[data-test="paste-zone"]').trigger('drop', { dataTransfer: { files: [img, pdf] } })
    await vi.waitFor(() => expect(w.findAll('[data-test="paste-row"]')).toHaveLength(1))
    expect(w.text()).toContain('DropSvc')
    expect(w.findAll('[data-test="paste-image-error"]')).toHaveLength(0)
    expect(decodeQrToUri).toHaveBeenCalledTimes(1) // pdf 未进解码
  })
})
