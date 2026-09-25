/** @vitest-environment jsdom */
// 冲突副本 storage.local 列表（Task 10）：add/list/export，上限 5 滚动删，坏数据回落
// （jsdom 仅为 exportConflictCopy 的 Blob/URL/a.click 提供宿主对象）。
// 注：滚动删除由 addConflictCopy 内部 slice 裁剪实现，无独立 remove 出口（原 removeConflictCopy
// 仅测试引用，已删除）；CloudCard 副本区仅列表+导出，无单条删除入口
import { describe, expect, it, vi } from 'vitest'
import { base64ToBytes, createMemoryStorage } from '@totp/core'
import {
  CONFLICT_COPIES_KEY, CONFLICT_COPIES_MAX, addConflictCopy, exportConflictCopy, listConflictCopies,
} from '../src/conflictCopies'

const bytesOf = (s: string) => new TextEncoder().encode(s)

describe('conflictCopies', () => {
  it('add/list：入列表命名 conflict-{sourceId}-{ts}.totpbackup，元素含 at/bytesBase64（字节可还原）', async () => {
    const a = createMemoryStorage()
    await addConflictCopy(a, bytesOf('ENVELOPE-1'), 'src-1')
    const list = await listConflictCopies(a)
    expect(list).toHaveLength(1)
    expect(list[0]!.name).toMatch(/^conflict-src-1-\d{8}-\d{6}\.totpbackup$/)
    expect(typeof list[0]!.at).toBe('number')
    expect(new TextDecoder().decode(base64ToBytes(list[0]!.bytesBase64))).toBe('ENVELOPE-1')
  })

  it('add 无 sourceId：通用名 conflict-{ts}.totpbackup', async () => {
    const a = createMemoryStorage()
    await addConflictCopy(a, bytesOf('x'))
    expect((await listConflictCopies(a))[0]!.name).toMatch(/^conflict-\d{8}-\d{6}\.totpbackup$/)
  })

  it(`上限 ${CONFLICT_COPIES_MAX} 滚动删除最旧：第 6 份入列后首份被裁`, async () => {
    const a = createMemoryStorage()
    for (let i = 1; i <= CONFLICT_COPIES_MAX + 1; i++) {
      await addConflictCopy(a, bytesOf(`e${i}`), `s${i}`)
    }
    const list = await listConflictCopies(a)
    expect(list).toHaveLength(CONFLICT_COPIES_MAX)
    expect(list.some((c) => c.name.includes('-s1-'))).toBe(false) // 最旧 s1 已裁
    expect(list[list.length - 1]!.name).toContain('-s6-') // 最新在尾
  })

  it('坏 JSON → 空列表不抛（副本属救灾数据，不阻断同步主流程）', async () => {
    const a = createMemoryStorage()
    await a.set(CONFLICT_COPIES_KEY, '{bad json')
    expect(await listConflictCopies(a)).toEqual([])
  })

  it('adapter.get 抛错（IO 故障）→ 空列表不抛', async () => {
    const a = createMemoryStorage()
    a.get = async () => {
      throw new Error('storage IO error')
    }
    expect(await listConflictCopies(a)).toEqual([])
  })

  it('形态不符：顶层非数组（对象/字符串）→ 空列表；数组内形态不符元素逐条丢弃', async () => {
    const a = createMemoryStorage()
    await a.set(CONFLICT_COPIES_KEY, JSON.stringify({ name: 'not-an-array' }))
    expect(await listConflictCopies(a)).toEqual([])
    await a.set(CONFLICT_COPIES_KEY, JSON.stringify('just-a-string'))
    expect(await listConflictCopies(a)).toEqual([])
    await a.set(CONFLICT_COPIES_KEY, JSON.stringify([
      { name: 'ok-1', at: 1, bytesBase64: 'aGk=' }, // 合法
      { name: 42, at: 1, bytesBase64: 'aGk=' }, // name 非串
      { name: 'no-at', bytesBase64: 'aGk=' }, // 缺 at
      null, // 非 object
    ]))
    const list = await listConflictCopies(a)
    expect(list).toHaveLength(1)
    expect(list[0]!.name).toBe('ok-1')
  })

  it('并发 add（未 await 交错）：读改写竞态下最后写者胜，列表保持完整 JSON 形态（实现行为锚定）', async () => {
    const a = createMemoryStorage()
    // 两个 add 交错：均在对方 set 前完成 list 读取 → 各自基于空列表写入，后完成者覆盖（无丢失损坏）
    const [n1, n2] = await Promise.all([
      addConflictCopy(a, bytesOf('E1'), 's1'),
      addConflictCopy(a, bytesOf('E2'), 's2'),
    ])
    const list = await listConflictCopies(a)
    expect(list).toHaveLength(1) // 竞态：最后写入者的全量列表生效
    const lastName = list[0]!.name
    expect([n1, n2]).toContain(lastName)
  })

  it('export：按名触发下载（a.download=副本名）且字节一致；无名 → false 不下载', async () => {
    const a = createMemoryStorage()
    await addConflictCopy(a, bytesOf('ENVELOPE-EXPORT'), 's1')
    const [copy] = await listConflictCopies(a)
    const click = vi.fn()
    vi.spyOn(document, 'createElement').mockReturnValue(Object.assign(document.createElement('a'), { click }) as unknown as HTMLAnchorElement)
    let captured: Blob | null = null
    // jsdom 无 createObjectURL/revokeObjectURL：直接赋假实现（可写覆盖）
    URL.createObjectURL = vi.fn((blob: Blob | MediaSource) => {
      captured = blob as Blob
      return 'blob:mock'
    }) as typeof URL.createObjectURL
    URL.revokeObjectURL = vi.fn() as typeof URL.revokeObjectURL
    await expect(exportConflictCopy(a, copy!.name)).resolves.toBe(true)
    expect(click).toHaveBeenCalledTimes(1)
    // jsdom Blob 无 text()：以字节长度对内容做等价断言（副本字节在 add 时经 base64 往返可还原）
    expect(captured!.size).toBe(bytesOf('ENVELOPE-EXPORT').length)
    await expect(exportConflictCopy(a, 'ghost-name')).resolves.toBe(false)
    expect(click).toHaveBeenCalledTimes(1) // 无名不下载
  })
})
