import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { toRaw } from 'vue'
import type { OtpEntry, Tag } from '@totp/core'
import QuickCodesPanel from '../src/components/QuickCodesPanel.vue'
import { createTestI18n } from './helpers/i18n'

const mkEntry = (uuid: string, over: Partial<OtpEntry> = {}): OtpEntry => ({
  uuid, type: 'totp', issuer: 'GitHub', label: 'me@ex.com', secret: 'JBSWY3DPEHPK3PXP',
  algorithm: 'SHA1', digits: 6, period: 30, tagIds: [], order: 0, createdAt: 0, ...over,
})
const tags: Tag[] = [{ id: 't1', name: '工作' }, { id: 't2', name: '个人' }]
const entries = [mkEntry('u1'), mkEntry('u2', { issuer: 'GitLab' })]
const codes = new Map([['u1', { code: '123456', remaining: 12, progress: 0.6 }]])
const base = { entries, codes, query: '' }
const mountPanel = (props: Record<string, unknown> = {}) =>
  mount(QuickCodesPanel, { global: { plugins: [createTestI18n()] }, props: { ...base, ...props } })

describe('QuickCodesPanel 冻结结构（对照 CodesPage .frozen 先例）', () => {
  it('.frozen sticky 容器包裹 SearchBar；tagRow 默认关闭不渲染 TagFilterRow', () => {
    const w = mountPanel()
    expect(w.find('.frozen').exists()).toBe(true)
    expect(w.find('.frozen .search-row').exists()).toBe(true)
    expect(w.find('.tag-filter-row').exists()).toBe(false)
  })
  it('tagRow=true + tags → 渲染 TagFilterRow，且 manageable 恒 false（无管理钮）', () => {
    const w = mountPanel({ tagRow: true, tags })
    expect(w.find('.tag-filter-row').exists()).toBe(true)
    expect(w.find('button.manage-btn').exists()).toBe(false)
  })
  it('tagRow=true 但 tags 空/未传 → 不渲染（快速窗语义：无标签不露筛选行）', () => {
    expect(mountPanel({ tagRow: true, tags: [] }).find('.tag-filter-row').exists()).toBe(false)
    expect(mountPanel({ tagRow: true }).find('.tag-filter-row').exists()).toBe(false)
  })
})

describe('QuickCodesPanel 列表装配（OtpListItem 纯取码）', () => {
  it('v-for 渲染条目；codes 命中走映射值，未命中回退占位（progress 1 → 满宽）', () => {
    const w = mountPanel()
    const items = w.findAll('.otp-item')
    expect(items).toHaveLength(2)
    expect(items[0]!.find('.progress-fill').attributes('style')).toContain('width: 60%')
    expect(items[1]!.find('.progress-fill').attributes('style')).toContain('width: 100%')
  })
  it('showIndex 默认 true 渲染 1-based 序号；false 不渲染', () => {
    expect(mountPanel().findAll('.index').map((x) => x.text())).toEqual(['1', '2'])
    expect(mountPanel({ showIndex: false }).find('.index').exists()).toBe(false)
  })
  it('contextMenu 默认 false（快速窗无右键菜单）；true 透传声明 aria-haspopup', () => {
    expect(mountPanel().find('.otp-item').attributes('aria-haspopup')).toBeUndefined()
    expect(mountPanel({ contextMenu: true }).find('.otp-item').attributes('aria-haspopup')).toBe('menu')
  })
  it('行内 QR 按钮已组件级移除：.show-qr 恒不渲染（QR 入口归宿主右键菜单，面板无死入口）', () => {
    expect(mountPanel().find('.show-qr').exists()).toBe(false)
  })
  it('icons 透传 OtpListItem icon（builtin entry.icon + icons null → svg 渲染）', () => {
    const w = mountPanel({ entries: [mkEntry('u1', { icon: { kind: 'builtin', id: 'github' } })], icons: null })
    expect(w.find('.avatar svg').exists()).toBe(true)
  })
})

describe('QuickCodesPanel v-model 透传与事件上抛', () => {
  it('SearchBar 输入 → update:query；勾选搜密钥 → update:searchSecret', async () => {
    const w = mountPanel()
    await w.find('input[type="search"]').setValue('git')
    expect(w.emitted('update:query')![0]).toEqual(['git'])
    await w.find('input[type="checkbox"]').setValue(true)
    expect(w.emitted('update:searchSecret')![0]).toEqual([true])
  })
  it('TagFilterRow chip 点击 → update:selectedTagIds；≥2 选中时模式钮点击 → update:tagMode', async () => {
    const w = mountPanel({ tagRow: true, tags, selectedTagIds: ['t1', 't2'], tagMode: 'any' })
    // chips 序：全部/个人(t2)/工作(t1)（名称 zh 字母序）；点已选中的 t2 → 取消 → 剩 t1
    await w.findAll('button.md-chip')[1]!.trigger('click')
    expect(w.emitted('update:selectedTagIds')![0]).toEqual([['t1']])
    await w.find('button.mode-toggle').trigger('click')
    expect(w.emitted('update:tagMode')![0]).toEqual(['all'])
  })
  it('copy 上抛携带 entry 本体（raw 同引用，prop 值经 Vue 响应式代理）；dblclick 上抛携带 MouseEvent', async () => {
    const w = mountPanel()
    const items = w.findAll('.otp-item')
    await items[0]!.trigger('click')
    expect(toRaw(w.emitted('copy')![0]![0] as OtpEntry)).toBe(entries[0])
    await items[0]!.trigger('dblclick')
    expect(w.emitted('dblclick')![0]![0]).toBeInstanceOf(MouseEvent)
  })
})

describe('QuickCodesPanel loading 门控与两态空文案', () => {
  it('loading=true：不渲染列表与空态（冻结搜索行仍在）', () => {
    const w = mountPanel({ loading: true, emptyText: '没有条目', noMatchText: '无匹配' })
    expect(w.findAll('.otp-item')).toHaveLength(0)
    expect(w.find('.empty').exists()).toBe(false)
    expect(w.find('.frozen .search-row').exists()).toBe(true)
  })
  it('entries 空 + 无 query + 无标签选中 → emptyText', () => {
    const w = mountPanel({ entries: [], emptyText: '没有条目', noMatchText: '无匹配' })
    expect(w.find('.empty').text()).toBe('没有条目')
  })
  it('entries 空 + 有 query → noMatchText', () => {
    const w = mountPanel({ entries: [], query: 'zzz', emptyText: '没有条目', noMatchText: '无匹配' })
    expect(w.find('.empty').text()).toBe('无匹配')
  })
  it('entries 空 + 有标签选中（tagRow）→ noMatchText', () => {
    const w = mountPanel({ entries: [], tagRow: true, tags, selectedTagIds: ['t1'], emptyText: '没有条目', noMatchText: '无匹配' })
    expect(w.find('.empty').text()).toBe('无匹配')
  })
})
