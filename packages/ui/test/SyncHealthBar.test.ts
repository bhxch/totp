import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import SyncHealthBar from '../src/components/SyncHealthBar.vue'
import { createTestI18n } from './helpers/i18n'

function mountBar(conflicts: number, cloudText: string | null, browserText: string | null) {
  return mount(SyncHealthBar, { global: { plugins: [createTestI18n()] }, props: { conflicts, cloudText, browserText } })
}

describe('SyncHealthBar', () => {
  it('零冲突：不渲染冲突徽标；两通道摘要文本原样展示', () => {
    const w = mountBar(0, '成功：WebDAV 已上传', '正常')
    expect(w.find('.health-conflict').exists()).toBe(false)
    expect(w.find('.health-cloud').exists()).toBe(true)
    expect(w.text()).toContain('成功：WebDAV 已上传')
    expect(w.find('.health-browser').exists()).toBe(true)
    expect(w.text()).toContain('正常')
  })

  it('冲突>0：高亮徽标（role=alert）带计数，供健康条强提示', () => {
    const w = mountBar(3, null, null)
    const badge = w.find('.health-conflict')
    expect(badge.exists()).toBe(true)
    expect(badge.attributes('role')).toBe('alert')
    expect(badge.text()).toContain('3')
  })

  it('cloudText/browserText=null：对应通道不渲染（desktop 无浏览器同步 / 未配置平台）', () => {
    const w = mountBar(0, '云端摘要', null)
    expect(w.find('.health-cloud').exists()).toBe(true)
    expect(w.find('.health-browser').exists()).toBe(false)
  })
})
