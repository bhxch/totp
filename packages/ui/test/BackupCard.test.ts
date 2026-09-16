import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { reactive, ref } from 'vue'
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
  it('恢复内容缺 groups：不进入确认流程、不调用 replaceAllOp 并显示错误', async () => {
    const restorePlatform = {
      createBackup: vi.fn().mockResolvedValue('created'),
      mode: { type: 'keep' as const, n: 5 },
      setMode: vi.fn().mockResolvedValue(undefined),
      restoreFromPicker: vi.fn().mockResolvedValue({ json: JSON.stringify({ version: 1, entries: [] }) }),
      replaceAllOp: vi.fn().mockResolvedValue(undefined),
    }
    const w = mount(BackupCard, { props: { platform: restorePlatform, vaultJson: '{}' } })
    await w.findAll('input[type="password"]')[0]!.setValue('a')
    const btn = w.findAll('button').find((b) => b.text() === '从文件恢复')!
    await btn.trigger('click')
    await vi.waitFor(() => expect(w.text()).toContain('备份内容不是有效的 vault 数据'))
    expect(restorePlatform.replaceAllOp).not.toHaveBeenCalled()
    expect(w.find('.confirm-row').exists()).toBe(false)
  })

  it('I70：keep→overwrite→keep 切换时保留本地 keepN，不丢失用户配置', async () => {
    // 用 reactive 包装让模板访问自动解包 ref（vue-test-utils mount 默认不深 reactive）
    const mode = reactive<{ type: 'keep'; n: number } | { type: 'overwrite' }>({ type: 'keep', n: 7 })
    const platform = {
      createBackup: vi.fn().mockResolvedValue('created'),
      mode,
      setMode: vi.fn(async (m: { type: 'keep'; n: number } | { type: 'overwrite' }) => {
        Object.assign(mode, m)
      }),
    }
    const w = mount(BackupCard, { props: { platform, vaultJson: '{}' } })
    // 初始 keep n=7：keep-n input 可见
    expect(w.find('.keep-n input').exists()).toBe(true)
    // 切到 overwrite
    const overwriteRadio = w.findAll('input[type="radio"]')[1]!
    await overwriteRadio.setValue(true)
    await vi.waitFor(() => expect(mode.type).toBe('overwrite'))
    expect(w.find('.keep-n input').exists()).toBe(false)
    // 切回 keep：应使用本地 keepN（即用户配置的 7），不会变成默认 3
    const keepRadio = w.findAll('input[type="radio"]')[0]!
    await keepRadio.setValue(true)
    await vi.waitFor(() => {
      expect(mode.type).toBe('keep')
      // I70：切回 keep 保留用户配置的 keepN（不是默认 3）
      if (mode.type === 'keep') expect(mode.n).toBe(7)
    })
  })
})
