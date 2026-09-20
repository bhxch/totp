import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { createMemoryStorage, newEntryFromUri } from '@totp/core'
import { createVueStore } from '../../src/store'
import CodesPage from '../../src/pages/CodesPage.vue'

// jsdom 无 2d 上下文：ctx stub null（QrSheetDialog 绘制早退）；toDataURL stub 固定 PNG dataUrl
vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,AAAA')

async function storeWithTwo() {
  const s = createVueStore(createMemoryStorage())
  await s.initStore()
  await s.addEntryOp(newEntryFromUri('otpauth://totp/Alpha:a?secret=JBSWY3DPEHPK3PXP', 1))
  await s.addEntryOp(newEntryFromUri('otpauth://totp/Beta:b?secret=JBSWY3DPEHPK3PXP', 2))
  return s
}

async function mountInSelectMode(props: Record<string, unknown> = {}) {
  const s = await storeWithTwo()
  const w = mount(CodesPage, { props: { store: s, ...props } })
  await vi.waitFor(() => expect(w.text()).toContain('Alpha'))
  await w.find('[data-test="select-mode"]').trigger('click')
  return { s, w }
}

function rowChecks(w: ReturnType<typeof mount>) {
  return w.findAll('.row input[type="checkbox"]')
}

describe('CodesPage 选择模式（spec §2.5 多选拼版，仅 options 宿主消费）', () => {
  it('「选择」进入选择模式：每行渲染勾选框；勾选 1 条后操作条出现「生成二维码(1)」', async () => {
    const { w } = await mountInSelectMode()
    expect(rowChecks(w)).toHaveLength(2)
    expect(w.find('[data-test="select-bar"]').exists()).toBe(false)
    await rowChecks(w)[0]!.setValue(true)
    const bar = w.find('[data-test="select-bar"]')
    expect(bar.exists()).toBe(true)
    expect(bar.text()).toContain('生成二维码(1)')
  })

  it('取消勾选后集合回空，操作条消失；「取消」退出选择模式并清空勾选框', async () => {
    const { w } = await mountInSelectMode()
    await rowChecks(w)[0]!.setValue(true)
    await rowChecks(w)[0]!.setValue(false)
    expect(w.find('[data-test="select-bar"]').exists()).toBe(false)
    await rowChecks(w)[1]!.setValue(true)
    await w.find('[data-test="select-cancel"]').trigger('click')
    expect(w.find('[data-test="select-bar"]').exists()).toBe(false)
    expect(rowChecks(w)).toHaveLength(0) // 已退出选择模式
  })

  it('操作条「生成二维码(N)」打开拼版 Dialog：headline 计数、警示文案；未传 saveImage 时「保存图片」隐藏', async () => {
    const { w } = await mountInSelectMode()
    await rowChecks(w)[0]!.setValue(true)
    await w.find('[data-test="sheet-open"]').trigger('click')
    expect(w.find('.md-dialog').exists()).toBe(true)
    expect(w.find('.md-dialog__headline').text()).toBe('扫码迁移（1 个条目）')
    expect(w.find('.md-dialog canvas').exists()).toBe(true)
    expect(w.text()).toContain('二维码包含完整密钥')
    expect(w.find('[data-test="sheet-save"]').exists()).toBe(false)
    await w.find('[data-test="sheet-close"]').trigger('click')
    expect(w.find('.md-dialog').exists()).toBe(false)
  })

  it('传 saveImage 时「保存图片」可见，点击以固定名 + canvas PNG dataUrl 调用', async () => {
    const saveImage = vi.fn().mockResolvedValue(true)
    const { w } = await mountInSelectMode({ saveImage })
    await rowChecks(w)[0]!.setValue(true)
    await rowChecks(w)[1]!.setValue(true)
    await w.find('[data-test="sheet-open"]').trigger('click')
    const save = w.find('[data-test="sheet-save"]')
    expect(save.exists()).toBe(true)
    await save.trigger('click')
    expect(saveImage).toHaveBeenCalledTimes(1)
    expect(saveImage).toHaveBeenCalledWith('totp-qr-sheet.png', 'data:image/png;base64,AAAA')
  })
})
