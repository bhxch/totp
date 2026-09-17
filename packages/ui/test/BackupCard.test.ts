import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { reactive } from 'vue'
import BackupCard from '../src/components/BackupCard.vue'
import type { BackupAutoPrefs, BackupPlatform } from '../src/components/backupPlatform'

const VALID_VAULT = JSON.stringify({ version: 1, entries: [], groups: [], updatedAt: 0 })

/** mock platform 工厂：必选三件套打底，用例按需覆盖/追加可选成员 */
function makePlatform(over: Partial<BackupPlatform> = {}): BackupPlatform {
  return {
    createBackup: vi.fn(async () => 'created' as const),
    mode: { type: 'keep', n: 5 },
    setMode: vi.fn(async () => {}),
    ...over,
  }
}

describe('BackupCard', () => {
  beforeEach(() => vi.clearAllMocks())

  it('无 sessionSecret：立即备份/导出按钮禁用且显示设置口令提示', () => {
    const p = makePlatform({ exportToFile: vi.fn(async () => true) })
    const w = mount(BackupCard, { props: { platform: p, vaultJson: '{}', sessionSecret: null } })
    expect((w.find('button.backup-now').element as HTMLButtonElement).disabled).toBe(true)
    const exportBtn = w.findAll('button').find((b) => b.text() === '导出到文件')!
    expect((exportBtn.element as HTMLButtonElement).disabled).toBe(true)
    expect(p.createBackup).not.toHaveBeenCalled()
    const hint = w.findAll('.hint').find((h) => h.text().includes('先在上方设置备份口令'))
    expect(hint).toBeTruthy()
  })

  it('有 sessionSecret：立即备份以 (vaultJson, sessionSecret) 调 createBackup 并显示成功', async () => {
    const p = makePlatform()
    const w = mount(BackupCard, { props: { platform: p, vaultJson: '{"v":1}', sessionSecret: 'sec' } })
    await w.find('button.backup-now').trigger('click')
    await vi.waitFor(() => expect(p.createBackup).toHaveBeenCalledWith('{"v":1}', 'sec'))
    expect(w.text()).toContain('备份成功')
  })

  it('恢复失败 → 回退口令输入出现 → 用回退口令重试成功（restoreByName 先后收到两个口令）', async () => {
    const p = makePlatform({
      listBackups: vi.fn(async () => [{ name: 'b1.json' }]),
      restoreByName: vi.fn()
        .mockRejectedValueOnce(new Error('decrypt failed'))
        .mockResolvedValueOnce({ json: VALID_VAULT }),
      replaceAllOp: vi.fn(async () => {}),
    })
    const w = mount(BackupCard, { props: { platform: p, vaultJson: '{}', sessionSecret: 's1' } })
    // 备份列表由 listBackups 异步填充：先等「恢复」按钮出现
    await vi.waitFor(() => expect(w.findAll('button').some((b) => b.text() === '恢复')).toBe(true))
    const btn = w.findAll('button').find((b) => b.text() === '恢复')!
    await btn.trigger('click')
    // 首发用会话口令；失败 → 回退区展开
    await vi.waitFor(() => expect(w.find('.fallback-pw').exists()).toBe(true))
    expect(p.restoreByName).toHaveBeenLastCalledWith('b1.json', 's1')
    // 输入一次性口令重试：成功 → 回退区收起、输入清空、进入两步确认
    await w.find('.fallback-pw input').setValue('pw2')
    await w.findAll('button').find((b) => b.text() === '重试')!.trigger('click')
    await vi.waitFor(() => expect(p.restoreByName).toHaveBeenLastCalledWith('b1.json', 'pw2'))
    expect(w.find('.fallback-pw').exists()).toBe(false)
    expect(w.find('.confirm-row').exists()).toBe(true)
  })

  it('sessionSecret=null 点恢复：不调平台方法，直接展开回退口令输入', async () => {
    const p = makePlatform({ restoreFromPicker: vi.fn(async () => null) })
    const w = mount(BackupCard, { props: { platform: p, vaultJson: '{}', sessionSecret: null } })
    const btn = w.findAll('button').find((b) => b.text() === '从文件恢复')!
    await btn.trigger('click')
    expect(p.restoreFromPicker).not.toHaveBeenCalled()
    expect(w.find('.fallback-pw').exists()).toBe(true)
  })

  it('回退区已展开时重试再失败：显示「口令不匹配，请重试」且回退区保持展开', async () => {
    const p = makePlatform({
      listBackups: vi.fn(async () => [{ name: 'b1.json' }]),
      restoreByName: vi.fn().mockRejectedValue(new Error('decrypt failed')),
    })
    const w = mount(BackupCard, { props: { platform: p, vaultJson: '{}', sessionSecret: 's1' } })
    await vi.waitFor(() => expect(w.findAll('button').some((b) => b.text() === '恢复')).toBe(true))
    await w.findAll('button').find((b) => b.text() === '恢复')!.trigger('click')
    // 首发失败：静默展开回退区，无错误提示
    await vi.waitFor(() => expect(w.find('.fallback-pw').exists()).toBe(true))
    expect(w.text()).not.toContain('口令不匹配')
    // 重试再失败：错误提示出现，回退区保持展开供修改
    await w.find('.fallback-pw input').setValue('bad')
    await w.findAll('button').find((b) => b.text() === '重试')!.trigger('click')
    await vi.waitFor(() => expect(w.text()).toContain('口令不匹配，请重试'))
    expect(w.find('.fallback-pw').exists()).toBe(true)
  })

  it('恢复内容缺 groups：不进入确认流程、不调用 replaceAllOp 并显示错误（不误入回退区）', async () => {
    const p = makePlatform({
      restoreFromPicker: vi.fn(async () => ({ json: JSON.stringify({ version: 1, entries: [] }) })),
      replaceAllOp: vi.fn(async () => {}),
    })
    const w = mount(BackupCard, { props: { platform: p, vaultJson: '{}', sessionSecret: 'a' } })
    const btn = w.findAll('button').find((b) => b.text() === '从文件恢复')!
    await btn.trigger('click')
    await vi.waitFor(() => expect(w.text()).toContain('备份内容不是有效的 vault 数据'))
    expect(p.replaceAllOp).not.toHaveBeenCalled()
    expect(w.find('.confirm-row').exists()).toBe(false)
    expect(w.find('.fallback-pw').exists()).toBe(false)
  })

  it('平台未提供 getAutoPrefs/getBackupDir：自动区与目录行不渲染', () => {
    const w = mount(BackupCard, { props: { platform: makePlatform(), vaultJson: '{}', sessionSecret: 'sec' } })
    expect(w.find('.auto-row').exists()).toBe(false)
    expect(w.find('.dir-row').exists()).toBe(false)
  })

  it('autoPrefs 开关切换：每次以最新完整对象调 setAutoPrefs', async () => {
    const prefs: BackupAutoPrefs = { onChange: false, onInterval: false, intervalMinutes: 60 }
    const p = makePlatform({
      getAutoPrefs: vi.fn(() => prefs),
      setAutoPrefs: vi.fn(async () => {}),
    })
    const w = mount(BackupCard, { props: { platform: p, vaultJson: '{}', sessionSecret: 'sec' } })
    const onChangeSw = w.find('input[aria-label="变更后自动备份"]')
    expect(onChangeSw.exists()).toBe(true)
    await onChangeSw.setValue(true)
    await vi.waitFor(() =>
      expect(p.setAutoPrefs).toHaveBeenLastCalledWith({ onChange: true, onInterval: false, intervalMinutes: 60 }),
    )
    // 连续切换：定时开关再开 → 仍带最新完整对象（不丢 onChange）
    await w.find('input[aria-label="定时自动备份"]').setValue(true)
    await vi.waitFor(() =>
      expect(p.setAutoPrefs).toHaveBeenLastCalledWith({ onChange: true, onInterval: true, intervalMinutes: 60 }),
    )
  })

  it('间隔 MdSelect（F6 收口）：开弹层点选以 intervalMinutes=1440 调 setAutoPrefs', async () => {
    const p = makePlatform({
      getAutoPrefs: vi.fn(() => ({ onChange: false, onInterval: false, intervalMinutes: 60 })),
      setAutoPrefs: vi.fn(async () => {}),
    })
    const w = mount(BackupCard, { props: { platform: p, vaultJson: '{}', sessionSecret: 'sec' } })
    await w.find('button[aria-label="自动备份间隔"]').trigger('click')
    await w.findAll('[role="option"]').find((o) => o.text() === '每天')!.trigger('click')
    await vi.waitFor(() =>
      expect(p.setAutoPrefs).toHaveBeenLastCalledWith({ onChange: false, onInterval: false, intervalMinutes: 1440 }),
    )
  })

  it('getAutoStatus：自动区底部渲染「上次自动备份」状态文本；读不到显示「暂无」；未提供则不渲染', async () => {
    const p = makePlatform({
      getAutoPrefs: vi.fn(() => ({ onChange: false, onInterval: false, intervalMinutes: 60 })),
      getAutoStatus: vi.fn(async () => '2026-09-16 12:00 成功：已备份'),
    })
    const w = mount(BackupCard, { props: { platform: p, vaultJson: '{}', sessionSecret: 'sec' } })
    await vi.waitFor(() => expect(w.find('.auto-status').text()).toBe('上次自动备份：2026-09-16 12:00 成功：已备份'))
    // 读不到（null）：显示「暂无」
    const p2 = makePlatform({
      getAutoPrefs: vi.fn(() => ({ onChange: false, onInterval: false, intervalMinutes: 60 })),
      getAutoStatus: vi.fn(async () => null),
    })
    const w2 = mount(BackupCard, { props: { platform: p2, vaultJson: '{}', sessionSecret: 'sec' } })
    await vi.waitFor(() => expect(w2.find('.auto-status').text()).toBe('上次自动备份：暂无'))
    // 平台未提供 getAutoStatus：状态行不渲染
    const w3 = mount(BackupCard, { props: { platform: makePlatform({ getAutoPrefs: vi.fn(() => ({ onChange: false, onInterval: false, intervalMinutes: 60 })) }), vaultJson: '{}', sessionSecret: 'sec' } })
    await flushPromises()
    expect(w3.find('.auto-status').exists()).toBe(false)
  })

  it('目录行：显示当前值；恢复默认调 setBackupDir(null)；更改…选完路径调 setBackupDir(路径)', async () => {
    const p = makePlatform({
      getBackupDir: vi.fn(async () => 'D:\\bk'),
      setBackupDir: vi.fn(async () => {}),
      pickBackupDir: vi.fn(async () => 'E:\\new'),
    })
    const w = mount(BackupCard, { props: { platform: p, vaultJson: '{}', sessionSecret: 'sec' } })
    await vi.waitFor(() => expect(w.find('.dir-row').text()).toContain('D:\\bk'))
    await w.findAll('button').find((b) => b.text() === '恢复默认')!.trigger('click')
    await vi.waitFor(() => expect(p.setBackupDir).toHaveBeenCalledWith(null))
    expect(w.find('.dir-row').text()).toContain('默认（应用数据目录）')
    await w.findAll('button').find((b) => b.text() === '更改…')!.trigger('click')
    await vi.waitFor(() => expect(p.setBackupDir).toHaveBeenLastCalledWith('E:\\new'))
    expect(w.find('.dir-row').text()).toContain('E:\\new')
  })

  it('getBackupDir 渲染时返回 null：显示「默认（应用数据目录）」', async () => {
    const p = makePlatform({
      getBackupDir: vi.fn(async () => null),
      setBackupDir: vi.fn(async () => {}),
    })
    const w = mount(BackupCard, { props: { platform: p, vaultJson: '{}', sessionSecret: 'sec' } })
    await vi.waitFor(() => expect(w.find('.dir-row').exists()).toBe(true))
    expect(w.find('.dir-row').text()).toContain('默认（应用数据目录）')
  })

  it('备份模式分段选择（F5 收口）：aria-checked 单选语义；点击以等价 BackupMode 调 setMode；overwrite 态 N 输入框不渲染', async () => {
    const mode = reactive<{ type: 'keep'; n: number } | { type: 'overwrite' }>({ type: 'keep', n: 5 })
    const platform = {
      createBackup: vi.fn().mockResolvedValue('created'),
      mode,
      setMode: vi.fn(async (m: { type: 'keep'; n: number } | { type: 'overwrite' }) => {
        Object.assign(mode, m)
      }),
    }
    const w = mount(BackupCard, { props: { platform, vaultJson: '{}', sessionSecret: 'sec' } })
    const items = w.findAll('.md-seg__item')
    expect(items.map((i) => i.text())).toEqual(['保留最近', '覆盖单一文件'])
    // 初始 keep：第一段 aria-checked，keep-n 输入渲染
    expect(items[0]!.attributes('aria-checked')).toBe('true')
    expect(items[1]!.attributes('aria-checked')).toBe('false')
    expect(w.find('.keep-n input').exists()).toBe(true)
    // 切 overwrite：以 {type:'overwrite'} 调 setMode；N 输入框随之不渲染、选中段迁移
    await items[1]!.trigger('click')
    await vi.waitFor(() => expect(platform.setMode).toHaveBeenCalledWith({ type: 'overwrite' }))
    await vi.waitFor(() => {
      expect(mode.type).toBe('overwrite')
      expect(w.find('.keep-n input').exists()).toBe(false)
      expect(w.findAll('.md-seg__item')[1]!.attributes('aria-checked')).toBe('true')
    })
  })

  it('overwrite 初态：keep-n 输入框不渲染', () => {
    const p = makePlatform({ mode: { type: 'overwrite' } })
    const w = mount(BackupCard, { props: { platform: p, vaultJson: '{}', sessionSecret: 'sec' } })
    expect(w.find('.keep-n input').exists()).toBe(false)
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
    const w = mount(BackupCard, { props: { platform, vaultJson: '{}', sessionSecret: 'sec' } })
    // 初始 keep n=7：keep-n input 可见
    expect(w.find('.keep-n input').exists()).toBe(true)
    // 切到 overwrite（F5：备份模式为 MdSegmentedButton 分段选择）
    await w.findAll('.md-seg__item')[1]!.trigger('click')
    await vi.waitFor(() => expect(mode.type).toBe('overwrite'))
    expect(w.find('.keep-n input').exists()).toBe(false)
    // 切回 keep：应使用本地 keepN（即用户配置的 7），不会变成默认 3
    await w.findAll('.md-seg__item')[0]!.trigger('click')
    await vi.waitFor(() => {
      expect(mode.type).toBe('keep')
      // I70：切回 keep 保留用户配置的 keepN（不是默认 3）
      if (mode.type === 'keep') expect(mode.n).toBe(7)
    })
  })

  it('导出到文件：exportToFile 成功显示「已导出到文件」，取消（false）显示「已取消」', async () => {
    const p = makePlatform({ exportToFile: vi.fn(async () => true) })
    const w = mount(BackupCard, { props: { platform: p, vaultJson: '{}', sessionSecret: 'sec' } })
    await w.findAll('button').find((b) => b.text() === '导出到文件')!.trigger('click')
    await vi.waitFor(() => expect(p.exportToFile).toHaveBeenCalledWith('{}', 'sec'))
    expect(w.text()).toContain('已导出到文件')
    // 用户在系统对话框取消：saved=false → 提示「已取消」
    const p2 = makePlatform({ exportToFile: vi.fn(async () => false) })
    const w2 = mount(BackupCard, { props: { platform: p2, vaultJson: '{}', sessionSecret: 'sec' } })
    await w2.findAll('button').find((b) => b.text() === '导出到文件')!.trigger('click')
    await vi.waitFor(() => expect(w2.text()).toContain('已取消'))
  })

  it('keep 模式份数修改：keep-n input 变更以 (keep, n) 调 setMode（下取整且最小 1）', async () => {
    const p = makePlatform()
    const w = mount(BackupCard, { props: { platform: p, vaultJson: '{}', sessionSecret: 'sec' } })
    await w.find('.keep-n input').setValue('3')
    await vi.waitFor(() => expect(p.setMode).toHaveBeenCalledWith({ type: 'keep', n: 3 }))
    // 非法输入（0/NaN）：回落最小值 1
    await w.find('.keep-n input').setValue('0')
    await vi.waitFor(() => expect(p.setMode).toHaveBeenLastCalledWith({ type: 'keep', n: 1 }))
  })

  it('恢复第 2 步：确认覆盖调 replaceAllOp(pending) 并显示「恢复成功」；失败显示错误', async () => {
    const p = makePlatform({
      listBackups: vi.fn(async () => [{ name: 'b1.json' }]),
      restoreByName: vi.fn(async () => ({ json: VALID_VAULT })),
      replaceAllOp: vi.fn(async () => {}),
    })
    const w = mount(BackupCard, { props: { platform: p, vaultJson: '{}', sessionSecret: 's1' } })
    await vi.waitFor(() => expect(w.findAll('button').some((b) => b.text() === '恢复')).toBe(true))
    await w.findAll('button').find((b) => b.text() === '恢复')!.trigger('click')
    await vi.waitFor(() => expect(w.find('.confirm-row').exists()).toBe(true))
    await w.findAll('button').find((b) => b.text() === '确认覆盖')!.trigger('click')
    await vi.waitFor(() => expect(w.text()).toContain('恢复成功'))
    expect(p.replaceAllOp).toHaveBeenCalledTimes(1)
    // 失败路径：replaceAllOp 拒绝 → 错误提示
    const p2 = makePlatform({
      listBackups: vi.fn(async () => [{ name: 'b1.json' }]),
      restoreByName: vi.fn(async () => ({ json: VALID_VAULT })),
      replaceAllOp: vi.fn(async () => { throw new Error('replace failed') }),
    })
    const w2 = mount(BackupCard, { props: { platform: p2, vaultJson: '{}', sessionSecret: 's1' } })
    await vi.waitFor(() => expect(w2.findAll('button').some((b) => b.text() === '恢复')).toBe(true))
    await w2.findAll('button').find((b) => b.text() === '恢复')!.trigger('click')
    await vi.waitFor(() => expect(w2.find('.confirm-row').exists()).toBe(true))
    await w2.findAll('button').find((b) => b.text() === '确认覆盖')!.trigger('click')
    await vi.waitFor(() => expect(w2.text()).toContain('replace failed'))
  })
})
