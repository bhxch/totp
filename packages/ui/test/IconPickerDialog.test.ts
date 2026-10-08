import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { getBuiltinIcons } from '@totp/core'
import IconPickerDialog from '../src/components/IconPickerDialog.vue'
import { createTestI18n } from './helpers/i18n'

const icons = getBuiltinIcons()
// 选择器 open 即触发 ensureFullIcons：stub fetch 返回微缩全量集，避免真实 3.5MB 资产
vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ icons: {} }), { status: 200 })))
beforeEach(() => vi.clearAllMocks())

function mountPicker(opts: { issuer?: string; open?: boolean; stored?: Record<string, string>; packs?: Record<string, { name: string; iconIds: string[] }> } = {}) {
  return mount(IconPickerDialog, {
    global: { plugins: [createTestI18n()] },
    props: { open: opts.open ?? true, builtin: icons, issuer: opts.issuer ?? '', stored: opts.stored ?? {}, packs: opts.packs ?? {} },
  })
}
const grid = (w: ReturnType<typeof mount>) => w.find('.picker-grid--all')
// chips 收口 MdChip 后一律 .md-chip；close 钮 svg 无文本，text() 即 label，仍用 includes 兜底确认/取消同帧
const chipOf = (w: ReturnType<typeof mount>, label: string) => w.findAll('.md-chip').find((c) => c.text().includes(label))!

describe('IconPickerDialog', () => {
  it('open=false 时不渲染对话框', () => {
    expect(mountPicker({ open: false }).find('.md-dialog').exists()).toBe(false)
  })

  it('窗口化：data-total 报全量数（≥200 精选），实际渲染 cell 数 < total（jsdom 回退 30）', () => {
    const w = mountPicker()
    expect(Number(grid(w).attributes('data-total'))).toBeGreaterThanOrEqual(200)
    expect(w.findAll('.picker-grid--all button').length).toBeLessThan(Number(grid(w).attributes('data-total')))
  })

  it('滚动换页：spacer 撑起 ceil(total/colCount)*96 总高，滚动后窗口前移（data-first）', async () => {
    const w = mountPicker()
    const total = Number(grid(w).attributes('data-total'))
    // colCount 初始 5：jsdom 无布局，clientWidth/Height 为 0，measure 不改写
    const spacerH = parseFloat((w.find('.picker-spacer').element as HTMLElement).style.height)
    expect(spacerH).toBe(Math.ceil(total / 5) * 96)
    const scrollerEl = w.find('.picker-scroll').element as HTMLElement
    scrollerEl.scrollTop = 96 * 10
    await w.find('.picker-scroll').trigger('scroll')
    expect(Number(grid(w).attributes('data-first'))).toBeGreaterThanOrEqual(5 * 5)
  })

  it('chips：默认 全部/内置；有上传图标出现「上传」；各包按显示名出现', () => {
    const w = mountPicker({ stored: { gh: 'data:image/png;base64,AA', orphan: 'data:image/png;base64,AA' }, packs: { mypack: { name: 'My Pack', iconIds: ['gh'] } } })
    const labels = w.findAll('.md-chip').map((c) => c.text())
    expect(labels).toContain('全部')
    expect(labels).toContain('内置')
    expect(labels).toContain('上传')
    expect(labels).toContain('My Pack')
  })

  it('chip=内置 只显 builtin；chip=包 只显该包 stored（带 id 标签与 img）', async () => {
    const w = mountPicker({ stored: { gh: 'data:image/png;base64,AA' }, packs: { mypack: { name: 'My Pack', iconIds: ['gh'] } } })
    await chipOf(w, '内置')!.trigger('click')
    expect(w.findAll('.picker-grid--all img').length).toBe(0)
    await chipOf(w, 'My Pack')!.trigger('click')
    const cells = w.findAll('.picker-grid--all button')
    expect(cells).toHaveLength(1)
    expect(cells[0]!.find('img').attributes('src')).toBe('data:image/png;base64,AA')
    expect(cells[0]!.find('.picker-cell-label').text()).toBe('gh')
  })

  it('选中 stored → select 载荷 {kind:"stored", id}；选中 builtin → {kind:"builtin"}', async () => {
    const w = mountPicker({ stored: { gh: 'data:image/png;base64,AA' }, packs: { mypack: { name: 'My Pack', iconIds: ['gh'] } } })
    await chipOf(w, 'My Pack')!.trigger('click')
    await w.find('.picker-grid--all button').trigger('click')
    expect(w.emitted('select')![0]).toEqual([{ kind: 'stored', id: 'gh', title: 'gh' }])
    await chipOf(w, '内置')!.trigger('click') // 切回 builtin 源再点任一格
    await w.find('.picker-grid--all button').trigger('click')
    const last = w.emitted('select')!.at(-1)![0] as { kind: string }
    expect(last.kind).toBe('builtin')
  })

  it('搜索跨源：stored id 命中查询（extra 管线）', async () => {
    const w = mountPicker({ stored: { githacks: 'data:image/png;base64,AA' } })
    await w.find('.picker-search input').setValue('githacks')
    const cells = w.findAll('.picker-grid--all button')
    expect(cells.some((c) => c.find('.picker-cell-label').text() === 'githacks')).toBe(true)
  })

  it('中文别名搜索保留（谷歌→Google）', async () => {
    const w = mountPicker()
    await w.find('.picker-search input').setValue('谷歌')
    expect(w.findAll('.picker-grid--all button')[0]!.attributes('title')).toBe('Google')
  })

  it('包 chip removable close 两步确认 → emit removePack(normKey)；close 为可聚焦真 button（键盘可达删包入口）', async () => {
    const w = mountPicker({ stored: { gh: 'data:image/png;base64,AA' }, packs: { mypack: { name: 'My Pack', iconIds: ['gh'] } } })
    const packChip = chipOf(w, 'My Pack')
    const remove = packChip.find('.md-chip__remove')
    expect(remove.element.tagName).toBe('BUTTON') // 交互元素不可嵌套的键盘可达性由真 button 保证
    expect((remove.element as HTMLButtonElement).disabled).toBe(false)
    await remove.trigger('click')
    // 两步确认钮同为 MdChip（语义逐一映射：选包=chip click / 删除=close / 确认 / 取消）
    const confirm = w.findAll('.md-chip').find((c) => c.text() === '删除')
    expect(confirm).toBeDefined()
    await confirm!.trigger('click')
    expect(w.emitted('removePack')![0]).toEqual(['mypack'])
  })

  it('包 chip × 取消分支：取消后确认钮收起、不 emit removePack，再点 × 可重开确认', async () => {
    const w = mountPicker({ stored: { gh: 'data:image/png;base64,AA' }, packs: { mypack: { name: 'My Pack', iconIds: ['gh'] } } })
    await chipOf(w, 'My Pack')!.find('.md-chip__remove').trigger('click')
    const cancel = w.findAll('.md-chip').find((c) => c.text() === '取消')!
    await cancel.trigger('click')
    expect(w.emitted('removePack')).toBeUndefined()
    expect(w.findAll('.md-chip').some((c) => c.text() === '删除')).toBe(false)
    await chipOf(w, 'My Pack')!.find('.md-chip__remove').trigger('click')
    expect(w.findAll('.md-chip').some((c) => c.text() === '删除')).toBe(true)
  })

  it('推荐区 mixed：builtin 出 svg、stored 出 img', () => {
    const w = mountPicker({ issuer: 'githublab', stored: { githublab: 'data:image/png;base64,AA' } })
    const rec = w.findAll('.picker-recommended button')
    expect(rec.length).toBeGreaterThan(0)
    expect(rec.some((b) => b.find('img').exists())).toBe(true)
    expect(rec.some((b) => b.find('svg').exists())).toBe(true)
  })

  // ---- 以下为旧测试保留断言（重写后语义仍成立） ----

  it('推荐区：issuer 模糊命中（githb→github）置顶显示', () => {
    const w = mountPicker({ issuer: 'githb' })
    const rec = w.findAll('.picker-recommended button')
    expect(rec.length).toBeGreaterThan(0)
    expect(rec[0]!.attributes('title')).toBe('GitHub')
  })

  it('issuer 为空或纯分隔符时不显示推荐区', () => {
    expect(mountPicker().find('.picker-recommended').exists()).toBe(false)
    expect(mountPicker({ issuer: ' .-_ ' }).find('.picker-recommended').exists()).toBe(false)
  })

  it('搜索过滤：git 命中相关项；无结果时网格为空', async () => {
    const w = mountPicker()
    const search = () => w.find('.picker-search input')
    await search().setValue('git')
    const cells = w.findAll('.picker-grid--all button')
    expect(cells.length).toBeGreaterThan(0)
    expect(cells.length).toBeLessThan(50)
    expect(cells.some((c) => c.attributes('title') === 'GitLab')).toBe(true)
    await search().setValue('zzz不存在的图标')
    expect(w.findAll('.picker-grid--all button')).toHaveLength(0)
  })

  it('打开时清空上次搜索词', async () => {
    const w = mountPicker()
    await w.find('.picker-search input').setValue('git')
    await w.setProps({ open: false })
    await w.setProps({ open: true })
    expect((w.find('.picker-search input').element as HTMLInputElement).value).toBe('')
  })

  it('点选内置图标 emit select（toMatchObject 兼容载荷）', async () => {
    const w = mountPicker()
    const cell = w.findAll('.picker-grid--all button').find((c) => c.attributes('title') === 'GitLab')!
    await cell.trigger('click')
    expect(w.emitted('select')![0]![0]).toMatchObject({ id: 'gitlab', title: 'GitLab' })
  })

  it('点遮罩 emit close（MdDialog 行为）', async () => {
    const w = mountPicker()
    await w.find('.md-dialog__scrim').trigger('click')
    expect(w.emitted('close')).toHaveLength(1)
  })
})
