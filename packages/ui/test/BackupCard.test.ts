import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import BackupCard from '../src/components/BackupCard.vue'

const platform = {
  createBackup: vi.fn().mockResolvedValue('created'),
  mode: { type: 'keep' as const, n: 5 },
  setMode: vi.fn().mockResolvedValue(undefined),
}

describe('BackupCard', () => {
  beforeEach(() => vi.clearAllMocks())

  it('口令不一致不调用 createBackup', async () => {
    const w = mount(BackupCard, { props: { platform, vaultJson: '{}' } })
    const inputs = w.findAll('input[type="password"]')
    await inputs[0]!.setValue('a')
    await inputs[1]!.setValue('b')
    await w.find('button.backup-now').trigger('click')
    expect(platform.createBackup).not.toHaveBeenCalled()
  })
  it('口令一致调用并显示结果', async () => {
    const w = mount(BackupCard, { props: { platform, vaultJson: '{}' } })
    const inputs = w.findAll('input[type="password"]')
    await inputs[0]!.setValue('a')
    await inputs[1]!.setValue('a')
    await w.find('button.backup-now').trigger('click')
    await vi.waitFor(() => expect(platform.createBackup).toHaveBeenCalledWith('{}', 'a'))
    expect(w.text()).toContain('备份成功')
  })
  it('空口令不调用', async () => {
    const w = mount(BackupCard, { props: { platform, vaultJson: '{}' } })
    await w.find('button.backup-now').trigger('click')
    expect(platform.createBackup).not.toHaveBeenCalled()
  })
})
