import { describe, expect, it } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import EntryForm from '../src/components/EntryForm.vue'
import { createTestI18n } from './helpers/i18n'

/** MdSelect 点选：按 aria-label 开弹层，按显示文本点选项（EntryForm.test.ts 同款交互） */
async function pickOption(w: VueWrapper, ariaLabel: string, label: string): Promise<void> {
  await w.find(`button[aria-label="${ariaLabel}"]`).trigger('click')
  await w.findAll('[role="option"]').find((o) => o.text() === label)!.trigger('click')
}

describe('EntryForm yandex（yaotp）', () => {
  it('type 切 yandex：digits 实时置 8、PIN 输入框出现；save 携带 pin 且不提交 counter', async () => {
    const w = mount(EntryForm, { global: { plugins: [createTestI18n()] }, props: { initial: null, tags: [] } })
    await pickOption(w, '类型', 'Yandex（yaotp）')
    expect((w.find('.digits input').element as HTMLInputElement).value).toBe('8')
    expect(w.find('input[aria-label="Yandex PIN（可选）"]').exists()).toBe(true)
    await w.find('input[placeholder="密钥 base32"]').setValue('KJTEUGOD5SNXVWBCWJ4G36W4IA')
    await w.find('input[aria-label="Yandex PIN（可选）"]').setValue('1234')
    await w.find('form').trigger('submit')
    expect(w.emitted('save')![0]![0]).toMatchObject({ type: 'yandex', digits: 8, pin: '1234', algorithm: 'SHA1' })
    expect((w.emitted('save')![0]![0] as { counter?: number }).counter).toBeUndefined()
  })
  it('离开 yandex 回 totp：digits 回落 6、PIN 框消失、save 不携带 pin', async () => {
    const w = mount(EntryForm, { global: { plugins: [createTestI18n()] }, props: { initial: null, tags: [] } })
    await pickOption(w, '类型', 'Yandex（yaotp）')
    await pickOption(w, '类型', 'TOTP')
    expect((w.find('.digits input').element as HTMLInputElement).value).toBe('6')
    expect(w.find('input[aria-label="Yandex PIN（可选）"]').exists()).toBe(false)
    await w.find('input[placeholder="密钥 base32"]').setValue('JBSWY3DPEHPK3PXP')
    await w.find('form').trigger('submit')
    expect((w.emitted('save')![0]![0] as { pin?: string }).pin).toBeUndefined()
  })
  it('yandex 位数被改为非 8 → submit 报错不 emit save', async () => {
    const w = mount(EntryForm, { global: { plugins: [createTestI18n()] }, props: { initial: null, tags: [] } })
    await pickOption(w, '类型', 'Yandex（yaotp）')
    await w.find('.digits input').setValue('7')
    await w.find('input[placeholder="密钥 base32"]').setValue('KJTEUGOD5SNXVWBCWJ4G36W4IA')
    await w.find('form').trigger('submit')
    expect(w.find('.error').exists()).toBe(true)
    expect(w.emitted('save')).toBeUndefined()
  })
})
