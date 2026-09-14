import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createMemoryStorage, newEntryFromUri, type ImportScheme } from '@totp/core'
import { createVueStore } from '../src/store'
import ImportCard from '../src/components/ImportCard.vue'

async function readyStore() {
  const s = createVueStore(createMemoryStorage())
  await s.initStore()
  await s.addEntryOp(newEntryFromUri('otpauth://totp/GitHub:me@x.com?secret=JBSWY3DPEHPK3PXP', 0))
  return s
}

const URI_TEXT = 'otpauth://totp/NewServ:a@b.c?secret=JBSWY3DPEHPK3PXP\notpauth://totp/GitHub:me@x.com?secret=JBSWY3DPEHPK3PXP\nbadline'

function mkPlatform(store: Awaited<ReturnType<typeof readyStore>>) {
  return { readImportFile: vi.fn().mockResolvedValue({ text: URI_TEXT, name: 'u.txt' }), store }
}

describe('ImportCard', () => {
  it('URI 批量导入：识别格式→确认冲突策略 skip→报告 1 成功 1 冲突跳过 1 失败', async () => {
    const store = await readyStore()
    const w = mount(ImportCard, { props: { platform: mkPlatform(store) } })
    await w.find('button.import-start').trigger('click')
    await vi.waitFor(() => expect(w.text()).toContain('uriBatch'))
    await w.find('button.import-next').trigger('click') // URI 格式无映射页
    await vi.waitFor(() => expect(w.text()).toContain('冲突'))
    await w.find('input[value="skip"]').setValue()
    await w.find('button.import-commit').trigger('click')
    await vi.waitFor(() => {
      expect(w.text()).toContain('成功导入 1 条')
      expect(w.text()).toContain('跳过')
      expect(w.text()).toContain('badline')
    })
    expect(store.vault.entries).toHaveLength(2) // 原有 GitHub + NewServ
  })
  it('无法识别格式：picked 页手动指定；自动下一步报错；手选 sqlite 无字节能力提示不支持', async () => {
    const store = await readyStore()
    const w = mount(ImportCard, { props: { platform: { readImportFile: vi.fn().mockResolvedValue({ text: 'hello', name: 'x' }), store } } })
    await w.find('button.import-start').trigger('click')
    await vi.waitFor(() => expect(w.text()).toContain('手动指定'))
    await w.find('button.import-next').trigger('click')
    await vi.waitFor(() => expect(w.text()).toContain('无法识别的文件格式'))
    await w.find('select.format-select').setValue('sqlite')
    await w.find('button.import-next').trigger('click')
    await vi.waitFor(() => expect(w.text()).toContain('当前端不支持 SQLite 导入'))
  })
  it('2FAS 全链路：嗅探 twoFas→直接解析→确认→落库', async () => {
    const store = await readyStore()
    const text = JSON.stringify({
      schemaVersion: 4,
      services: [{ secret: 'JBSWY3DPEHPK3PXP', name: 'TwoFasSvc', otp: { account: 'me@x.com', issuer: 'TwoFasSvc', tokenType: 'TOTP' } }],
    })
    const w = mount(ImportCard, { props: { platform: { readImportFile: vi.fn().mockResolvedValue({ text, name: '2fas.json' }), store } } })
    await w.find('button.import-start').trigger('click')
    await vi.waitFor(() => expect(w.text()).toContain('twoFas'))
    await w.find('button.import-next').trigger('click') // twoFas 无映射页，直接解析
    await vi.waitFor(() => expect(w.text()).toContain('冲突'))
    await w.find('button.import-commit').trigger('click')
    await vi.waitFor(() => expect(w.text()).toContain('成功导入 1 条'))
    expect(store.vault.entries.some((e) => e.issuer === 'TwoFasSvc' && e.label === 'me@x.com')).toBe(true)
    expect(store.vault.entries).toHaveLength(2) // 原有 GitHub + TwoFasSvc
  })
  it('手动指定格式：andOtp 嗅探下手选 generic → 映射页→落库', async () => {
    const store = await readyStore()
    const text = JSON.stringify([{ type: 'totp', algorithm: 'SHA1', label: 'Svc - me', secret: 'JBSWY3DPEHPK3PXP' }])
    const w = mount(ImportCard, { props: { platform: { readImportFile: vi.fn().mockResolvedValue({ text, name: 'a.json' }), store } } })
    await w.find('button.import-start').trigger('click')
    await vi.waitFor(() => expect(w.text()).toContain('andOtp'))
    await w.find('select.format-select').setValue('generic') // 覆盖嗅探结果
    await w.find('button.import-next').trigger('click')
    await vi.waitFor(() => expect(w.text()).toContain('字段映射'))
    const secretInput = w.find('input[data-field="secret"]')
    expect((secretInput.element as HTMLInputElement).value).toBe('secret') // 预填生效
    await w.find('button.import-next').trigger('click')
    await vi.waitFor(() => expect(w.text()).toContain('冲突'))
    await w.find('button.import-commit').trigger('click')
    await vi.waitFor(() => expect(w.text()).toContain('成功导入 1 条'))
    expect(store.vault.entries.some((e) => e.label === 'Svc - me')).toBe(true) // generic 映射不拆 " - "
  })
  it('手动指定 sqlite：字节入口头校验失败报错（wasm 链路由 typecheck+build 验收）', async () => {
    const store = await readyStore()
    const w = mount(ImportCard, {
      props: {
        platform: {
          readImportFile: vi.fn().mockResolvedValue({ text: 'hello', name: 'x' }),
          readImportFileBytes: vi.fn().mockResolvedValue({ bytes: new Uint8Array([1, 2, 3]), name: 'x.db' }),
          store,
        },
      },
    })
    await w.find('button.import-start').trigger('click')
    await vi.waitFor(() => expect(w.text()).toContain('手动指定')) // 自动字节复查头不匹配 → 静默回退
    await w.find('select.format-select').setValue('sqlite')
    await w.find('button.import-next').trigger('click')
    await vi.waitFor(() => expect(w.text()).toContain('无法识别的 SQLite 数据库'))
  })
  it('generic JSON：映射页按常见键名预填 secret 路径→确认导入成功', async () => {
    const store = await readyStore()
    const text = JSON.stringify([{ name: 'Svc', userName: 'a@b.c', key: 'JBSWY3DPEHPK3PXP' }])
    const w = mount(ImportCard, { props: { platform: { readImportFile: vi.fn().mockResolvedValue({ text, name: 'g.json' }), store } } })
    await w.find('button.import-start').trigger('click')
    await vi.waitFor(() => expect(w.text()).toContain('generic'))
    await w.find('button.import-next').trigger('click') // 进入映射页
    await vi.waitFor(() => expect(w.text()).toContain('字段映射'))
    // secret 路径已按常见键名（secret|key）预填
    const secretInput = w.find('input[data-field="secret"]')
    expect((secretInput.element as HTMLInputElement).value).toBe('key')
    await w.find('button.import-next').trigger('click') // 用映射解析 → 确认页
    await vi.waitFor(() => expect(w.text()).toContain('冲突'))
    await w.find('button.import-commit').trigger('click')
    await vi.waitFor(() => expect(w.text()).toContain('成功导入 1 条'))
    expect(store.vault.entries).toHaveLength(2) // 原有 GitHub + Svc
  })
  it('方案保存：映射页命名保存当前映射→save 落盘且下拉出现该方案', async () => {
    const store = await readyStore()
    const text = JSON.stringify([{ name: 'Svc', userName: 'a@b.c', key: 'JBSWY3DPEHPK3PXP' }])
    const schemesApi = { load: vi.fn().mockResolvedValue([]), save: vi.fn().mockResolvedValue(undefined) }
    const w = mount(ImportCard, { props: { platform: { readImportFile: vi.fn().mockResolvedValue({ text, name: 'g.json' }), store }, schemesApi } })
    await w.find('button.import-start').trigger('click')
    await vi.waitFor(() => expect(w.text()).toContain('generic'))
    await w.find('button.import-next').trigger('click') // 进入映射页
    await vi.waitFor(() => expect(w.text()).toContain('字段映射'))
    expect(schemesApi.load).toHaveBeenCalledTimes(1)
    await w.find('input.scheme-name').setValue('我的方案')
    await w.find('button.scheme-save').trigger('click')
    await vi.waitFor(() => expect(schemesApi.save).toHaveBeenCalledTimes(1))
    const saved = schemesApi.save.mock.calls[0]![0] as ImportScheme[]
    expect(saved).toHaveLength(1)
    expect(saved[0]!.name).toBe('我的方案')
    expect(saved[0]!.mapping).toEqual({ secret: { path: 'key' }, issuer: { path: 'name' }, label: { path: 'userName' } })
    expect(typeof saved[0]!.id).toBe('string')
    expect(saved[0]!.createdAt).toBeGreaterThan(0)
    const sel = w.find('select.scheme-select')
    expect(sel.exists()).toBe(true)
    expect(sel.html()).toContain('我的方案')
  })
  it('方案应用：下拉选中后应用回填映射路径（覆盖预填）', async () => {
    const store = await readyStore()
    const text = JSON.stringify([{ name: 'Svc', userName: 'a@b.c', key: 'JBSWY3DPEHPK3PXP' }])
    const premade: ImportScheme = {
      id: 's9',
      name: '品牌方案',
      rowsPath: 'data.items',
      createdAt: 1,
      mapping: { secret: { path: 'secretKey' }, issuer: { path: 'brand' }, label: { path: 'account' }, period: { path: 'step' } },
    }
    const schemesApi = { load: vi.fn().mockResolvedValue([premade]), save: vi.fn().mockResolvedValue(undefined) }
    const w = mount(ImportCard, { props: { platform: { readImportFile: vi.fn().mockResolvedValue({ text, name: 'g.json' }), store }, schemesApi } })
    await w.find('button.import-start').trigger('click')
    await vi.waitFor(() => expect(w.text()).toContain('generic'))
    await w.find('button.import-next').trigger('click')
    await vi.waitFor(() => expect(w.find('select.scheme-select').exists()).toBe(true))
    const val = (f: string) => (w.find(`input[data-field="${f}"]`).element as HTMLInputElement).value
    expect(val('secret')).toBe('key') // 预填先生效
    await w.find('select.scheme-select').setValue('s9')
    await w.find('button.scheme-apply').trigger('click')
    expect(val('secret')).toBe('secretKey')
    expect(val('issuer')).toBe('brand')
    expect(val('label')).toBe('account')
    expect(val('period')).toBe('step')
    expect(val('digits')).toBe('') // 未映射字段清空
  })
})
