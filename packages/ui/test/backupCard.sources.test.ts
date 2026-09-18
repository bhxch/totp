/** plan16 T9 新增：BackupCard 本地源列表口径用例（源列表渲染/每源 retention 与启用态回写/添加目录/移除两步确认/聚合恢复传 sourceId） */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import BackupCard from '../src/components/BackupCard.vue'
import type { BackupPlatform, LocalSourceView } from '../src/components/backupPlatform'

const src = (over: Partial<LocalSourceView> = {}): LocalSourceView => ({
  id: 's1', name: '默认目录', dir: null, retention: { type: 'overwrite' }, enabled: true, ...over,
})

function makePlatform(over: Partial<BackupPlatform> = {}): BackupPlatform {
  return {
    createBackup: vi.fn(async () => '已备份到 1 个目录'),
    ...over,
  }
}

async function mountCard(p: BackupPlatform, sessionSecret: string | null = 'pw') {
  const w = mount(BackupCard, { props: { platform: p, vaultJson: '{}', sessionSecret } })
  await flushPromises()
  return w
}

/** jsdom 的 crypto.randomUUID 存在性不定：存在则 spy，缺失则 defineProperty 注入；返回还原函数 */
function stubUuid(first: `${string}-${string}-${string}-${string}-${string}`): () => void {
  const c = globalThis.crypto as { randomUUID?: () => string }
  if (typeof c.randomUUID === 'function') {
    const spy = vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(first)
    return () => spy.mockRestore()
  }
  Object.defineProperty(c, 'randomUUID', { value: () => first, configurable: true })
  return () => { delete (c as { randomUUID?: unknown }).randomUUID }
}

describe('BackupCard 本地源列表（plan16 T9）', () => {
  beforeEach(() => vi.clearAllMocks())

  it('L1 源列表渲染：每源一行卡；dir=null 显示「默认（应用数据目录）」，有路径显示路径', async () => {
    const p = makePlatform({
      listLocalSources: vi.fn(async () => [
        src({ id: 's1', name: '默认目录', dir: null }),
        src({ id: 's2', name: 'bk', dir: 'D:\\bk' }),
      ]),
      saveLocalSource: vi.fn(async () => {}),
      removeLocalSource: vi.fn(async () => {}),
    })
    const w = await mountCard(p)
    expect(w.findAll('.source')).toHaveLength(2)
    expect(w.text()).toContain('默认目录')
    expect(w.text()).toContain('默认（应用数据目录）')
    expect(w.text()).toContain('D:\\bk')
  })

  it('L1b 能力缺省：未提供 listLocalSources → 源区不渲染；提供但未提供 pickBackupDir → 无「添加目录」按钮', async () => {
    const w = await mountCard(makePlatform())
    expect(w.find('.sources-block').exists()).toBe(false)
    const p2 = makePlatform({ listLocalSources: vi.fn(async () => [src()]) })
    const w2 = await mountCard(p2)
    expect(w2.find('.sources-block').exists()).toBe(true)
    expect(w2.findAll('button').some((b) => b.text() === '添加目录…')).toBe(false)
  })

  it('L2 retention 编辑回写：切保留最近落 {keep,3}；份数逐键（input）不落盘、change 落 {keep,5}、0 钳 1、切回覆盖落 overwrite', async () => {
    const p = makePlatform({
      listLocalSources: vi.fn(async () => [src({ id: 's1', retention: { type: 'overwrite' } })]),
      saveLocalSource: vi.fn(async () => {}),
      removeLocalSource: vi.fn(async () => {}),
    })
    const w = await mountCard(p)
    await w.find('button.source-toggle').trigger('click') // 展开配置
    expect(w.find('input[aria-label="保留份数"]').exists()).toBe(false) // 默认覆盖无份数输入
    await w.findAll('.md-seg__item').find((b) => b.text() === '保留最近')!.trigger('click')
    await vi.waitFor(() => expect(p.saveLocalSource).toHaveBeenLastCalledWith(expect.objectContaining({ id: 's1', retention: { type: 'keep', n: 3 } })))
    const n = w.find('input[aria-label="保留份数"]')
    expect(n.exists()).toBe(true)
    expect((n.element as HTMLInputElement).value).toBe('3')
    // 逐键（input）只更新内存不落盘（同 onName 模式），blur（change）才落盘
    await n.setValue('30')
    await flushPromises()
    const callsAfterChange = vi.mocked(p.saveLocalSource!).mock.calls.length
    await n.trigger('input') // 再键入不 blur：不落盘
    await flushPromises()
    expect(vi.mocked(p.saveLocalSource!).mock.calls.length).toBe(callsAfterChange)
    // blur（change）落盘：改 5 落 {keep,5}
    await n.setValue('5')
    await vi.waitFor(() => expect(p.saveLocalSource).toHaveBeenLastCalledWith(expect.objectContaining({ retention: { type: 'keep', n: 5 } })))
    // 非法输入钳下限 1（与 T8 CloudCard 口径一致）
    await n.setValue('0')
    await vi.waitFor(() => expect(p.saveLocalSource).toHaveBeenLastCalledWith(expect.objectContaining({ retention: { type: 'keep', n: 1 } })))
    // 切回覆盖：份数输入消失、retention 回 overwrite
    await w.findAll('.md-seg__item').find((b) => b.text() === '覆盖')!.trigger('click')
    expect(w.find('input[aria-label="保留份数"]').exists()).toBe(false)
    await vi.waitFor(() => expect(p.saveLocalSource).toHaveBeenLastCalledWith(expect.objectContaining({ retention: { type: 'overwrite' } })))
  })

  it('L2b 启用开关与名称编辑回写：开关 setValue(false) 落 enabled:false；名称 blur（change）落盘、逐键不落盘', async () => {
    const p = makePlatform({
      listLocalSources: vi.fn(async () => [src({ id: 's1', name: '默认目录' })]),
      saveLocalSource: vi.fn(async () => {}),
      removeLocalSource: vi.fn(async () => {}),
    })
    const w = await mountCard(p)
    await w.find('input[aria-label="默认目录启用"]').setValue(false)
    await vi.waitFor(() => expect(p.saveLocalSource).toHaveBeenLastCalledWith(expect.objectContaining({ id: 's1', enabled: false })))
    // 名称：展开后编辑，blur（change）才落盘；纯 input（逐键）只更新内存不落盘
    await w.find('button.source-toggle').trigger('click')
    const nameInput = w.find('input[aria-label="源名称"]')
    await nameInput.setValue('备份盘') // setValue 附带 change → blur 落盘
    await vi.waitFor(() => expect(p.saveLocalSource).toHaveBeenLastCalledWith(expect.objectContaining({ id: 's1', name: '备份盘' })))
    const saveMock = vi.mocked(p.saveLocalSource!)
    const callsAfterChange = saveMock.mock.calls.length
    await nameInput.trigger('input') // 再键入不 blur：不落盘
    await flushPromises()
    expect(saveMock.mock.calls.length).toBe(callsAfterChange)
  })

  it('L3 添加目录：pickBackupDir 选中目录 → 以目录末段为名、uuid、keep 3、enabled 建源并刷新列表；取消（null）不建', async () => {
    const restore = stubUuid('00000000-0000-4000-8000-000000000009')
    try {
      const saved: LocalSourceView[] = []
      const p = makePlatform({
        listLocalSources: vi.fn(async () => [...saved]),
        saveLocalSource: vi.fn(async (s: LocalSourceView) => { saved.push(s) }),
        removeLocalSource: vi.fn(async () => {}),
        pickBackupDir: vi.fn(async () => 'D:\\my backups\\photos'),
      })
      const w = await mountCard(p)
      expect(w.text()).toContain('尚无备份目录')
      await w.findAll('button').find((b) => b.text() === '添加目录…')!.trigger('click')
      await vi.waitFor(() => expect(w.findAll('.source')).toHaveLength(1))
      expect(p.saveLocalSource).toHaveBeenCalledWith({
        id: '00000000-0000-4000-8000-000000000009',
        name: 'photos', // 目录末段
        dir: 'D:\\my backups\\photos',
        retention: { type: 'keep', n: 3 },
        enabled: true,
      })
      // 用户取消：null → 不调 saveLocalSource、列表不动
      vi.mocked(p.pickBackupDir!).mockResolvedValueOnce(null)
      await w.findAll('button').find((b) => b.text() === '添加目录…')!.trigger('click')
      await flushPromises()
      expect(p.saveLocalSource).toHaveBeenCalledTimes(1)
    } finally {
      restore()
    }
  })

  it('L4 移除两步确认：先出确认行，取消不删；确认调 removeLocalSource(id) 且列表移除', async () => {
    const p = makePlatform({
      listLocalSources: vi.fn(async () => [src({ id: 's1', name: '备份盘', dir: 'E:\\bk' })]),
      saveLocalSource: vi.fn(async () => {}),
      removeLocalSource: vi.fn(async () => {}),
    })
    const w = await mountCard(p)
    await w.find('button.source-remove').trigger('click')
    expect(w.find('.remove-confirm-row').text()).toContain('移除备份目录「备份盘」')
    // 取消：不删、确认行收起
    await w.find('.remove-confirm-row').findAll('button').find((b) => b.text() === '取消')!.trigger('click')
    expect(p.removeLocalSource).not.toHaveBeenCalled()
    expect(w.find('.remove-confirm-row').exists()).toBe(false)
    // 再入并确认：删源 + 列表移除
    await w.find('button.source-remove').trigger('click')
    await w.find('.remove-confirm-row').findAll('button').find((b) => b.text() === '确认移除')!.trigger('click')
    await vi.waitFor(() => expect(p.removeLocalSource).toHaveBeenCalledWith('s1'))
    expect(w.findAll('.source')).toHaveLength(0)
  })

  it('L5 聚合恢复：listBackups 多源文件各带恢复按钮；点恢复以 (sourceId, name, 会话口令) 调 restoreByName', async () => {
    const p = makePlatform({
      listLocalSources: vi.fn(async () => [src()]),
      saveLocalSource: vi.fn(async () => {}),
      removeLocalSource: vi.fn(async () => {}),
      listBackups: vi.fn(async () => [
        { sourceId: 's1', name: 'vault-20260917.totpbackup' },
        { sourceId: 's2', name: 'vault-backup.totpbackup' },
      ]),
      restoreByName: vi.fn(async () => ({ json: JSON.stringify({ version: 1, entries: [], groups: [], updatedAt: 0 }) })),
      replaceAllOp: vi.fn(async () => {}),
    })
    const w = await mountCard(p)
    await vi.waitFor(() => expect(w.findAll('.backup-list li')).toHaveLength(2))
    const btns = w.findAll('.backup-list button').filter((b) => b.text() === '恢复')
    await btns[1]!.trigger('click')
    await vi.waitFor(() => expect(p.restoreByName).toHaveBeenCalledWith('s2', 'vault-backup.totpbackup', 'pw'))
  })

  it('L6 源 op 失败走错误通道：saveLocalSource 拒绝 → msg 显示错误且不抛出', async () => {
    const p = makePlatform({
      listLocalSources: vi.fn(async () => [src({ id: 's1' })]),
      saveLocalSource: vi.fn(async () => { throw new Error('写入源失败') }),
      removeLocalSource: vi.fn(async () => {}),
    })
    const w = await mountCard(p)
    await w.find('input[aria-label="默认目录启用"]').setValue(false)
    await vi.waitFor(() => expect(w.text()).toContain('写入源失败'))
    expect(w.findAll('.source')).toHaveLength(1) // 列表保持
  })
})
