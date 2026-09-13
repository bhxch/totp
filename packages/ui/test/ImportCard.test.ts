import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createMemoryStorage, newEntryFromUri } from '@totp/core'
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
  it('无法识别格式显示错误', async () => {
    const store = await readyStore()
    const w = mount(ImportCard, { props: { platform: { readImportFile: vi.fn().mockResolvedValue({ text: 'hello', name: 'x' }), store } } })
    await w.find('button.import-start').trigger('click')
    await vi.waitFor(() => expect(w.text()).toContain('无法识别'))
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
})
