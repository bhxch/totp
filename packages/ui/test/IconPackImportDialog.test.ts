// packages/ui/test/IconPackImportDialog.test.ts
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import IconPackImportDialog from '../src/components/IconPackImportDialog.vue'
import { createTestI18n } from './helpers/i18n'

function mountDialog(props: Partial<InstanceType<typeof IconPackImportDialog>['$props']> = {}) {
  return mount(IconPackDialog, {
    global: { plugins: [createTestI18n()] },
    props: {
      open: true,
      defaultName: 'MyPack',
      existingPacks: { aegisicons: { name: 'Aegis Icons' }, mypack: { name: 'My Pack' } },
      ...props,
    },
  })
}
import IconPackDialog from '../src/components/IconPackImportDialog.vue'

describe('IconPackImportDialog', () => {
  it('open 时预填 defaultName', () => {
    const w = mountDialog()
    expect((w.find('input').element as HTMLInputElement).value).toBe('MyPack')
  })

  it('快捷填入：点击既有包 chip 回填显示名', async () => {
    const w = mountDialog()
    await w.findAll('.quick-chip').find((c) => c.text() === 'Aegis Icons')!.trigger('click')
    expect((w.find('input').element as HTMLInputElement).value).toBe('Aegis Icons')
  })

  it('normalize 命中既有包 → 显示覆盖提示', async () => {
    const w = mountDialog()
    await w.find('input').setValue('my.pack')
    expect(w.find('.override-hint').text()).toContain('My Pack')
  })

  it('空名禁用确认；确认 emit trim 后的名字', async () => {
    const w = mountDialog()
    await w.find('input').setValue('   ')
    expect(w.find('.md-dialog__actions button:last-child').attributes('disabled')).toBeDefined()
    await w.find('input').setValue('  Aegis Icons  ')
    await w.find('.md-dialog__actions button:last-child').trigger('click')
    expect(w.emitted('confirm')![0]).toEqual(['Aegis Icons'])
  })

  it('busy 时确认禁用、取消可用且错误透出', async () => {
    const w = mountDialog({ busy: true, error: 'boom' })
    expect(w.find('.md-dialog__actions button:last-child').attributes('disabled')).toBeDefined()
    // busy 时取消是逃生通道，必须始终可点（审查 Important：不得 :disabled="busy"）
    const cancel = w.find('.md-dialog__actions button:first-child')
    expect(cancel.attributes('disabled')).toBeUndefined()
    await cancel.trigger('click')
    expect(w.emitted('close')).toHaveLength(1)
    expect(w.find('.error').text()).toBe('boom')
  })
})
