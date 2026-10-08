import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import EmptyState from '../src/components/EmptyState.vue'
import { close } from '../src/components/iconPaths'

/** Task 6 统一空态：text 必选、icon 可选（iconPaths 注册名，未知名优雅降级不渲染 svg）。
 *  统一视觉（padding 32px 0 / body-medium / on-surface-variant / 居中）是 CSS 契约，
 *  jsdom 不算样式，由组件内唯一 .empty-state 规则承载（对照 Phase 1 审查记录） */
describe('EmptyState', () => {
  it('渲染 text 文案（根 .empty-state）', () => {
    const w = mount(EmptyState, { props: { text: '暂无条目' } })
    expect(w.find('.empty-state').exists()).toBe(true)
    expect(w.find('.empty-state').text()).toBe('暂无条目')
  })

  it('icon 缺省：不渲染 svg（四处接入均未传 icon 的现状语义）', () => {
    const w = mount(EmptyState, { props: { text: '暂无条目' } })
    expect(w.find('svg').exists()).toBe(false)
  })

  it('icon 传 iconPaths 注册名 → 渲染同源 path（viewBox/d 与注册表一致，aria-hidden）', () => {
    const w = mount(EmptyState, { props: { text: 'x', icon: 'close' } })
    const svg = w.find('svg')
    expect(svg.exists()).toBe(true)
    expect(svg.attributes('viewBox')).toBe(close.viewBox)
    expect(svg.attributes('aria-hidden')).toBe('true')
    expect(w.find('path').attributes('d')).toBe(close.d)
  })

  it('未知 icon 名 → 优雅降级不渲染 svg，文案照常', () => {
    const w = mount(EmptyState, { props: { text: '暂无条目', icon: 'nope' } })
    expect(w.find('svg').exists()).toBe(false)
    expect(w.text()).toContain('暂无条目')
  })
})
