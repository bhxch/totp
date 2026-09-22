import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import type { EntryConflict, OtpEntry } from '@totp/core'
import MergeConflictList from '../src/components/MergeConflictList.vue'
import { createTestI18n } from './helpers/i18n'

function mkEntry(overrides: Partial<OtpEntry> = {}): OtpEntry {
  return {
    uuid: 'u', type: 'totp', issuer: 'GitHub', label: 'me@example.com', secret: 'JBSWY3DPEHPK3PXP',
    algorithm: 'SHA1', digits: 6, period: 30, tagIds: [], order: 0, createdAt: 0, updatedAt: 0, ...overrides,
  }
}

function mkConflict(overrides: Partial<EntryConflict> = {}): EntryConflict {
  return {
    entryId: 'e1', issuer: 'GitHub', label: 'me@example.com',
    ours: mkEntry({ secret: 'AAAA' }), theirs: mkEntry({ secret: 'BBBB' }), base: mkEntry({ secret: 'CCCC' }),
    ...overrides,
  }
}

describe('MergeConflictList', () => {
  it('渲染冲突行：issuer/label 与两侧裁决按钮', () => {
    const w = mount(MergeConflictList, {
      global: { plugins: [createTestI18n()] },
      props: { conflicts: [mkConflict()] },
    })
    expect(w.findAll('.conflict-row')).toHaveLength(1)
    expect(w.text()).toContain('GitHub')
    expect(w.text()).toContain('me@example.com')
    const buttons = w.findAll('button.conflict-pick')
    expect(buttons).toHaveLength(2)
    expect(buttons[0]!.text()).toContain('取本地方')
    expect(buttons[1]!.text()).toContain('取云地方')
  })

  it('点「取本地方」emit resolve(entryId, \'ours\')；点「取云地方」emit resolve(entryId, \'theirs\')', async () => {
    const w = mount(MergeConflictList, {
      global: { plugins: [createTestI18n()] },
      props: { conflicts: [mkConflict({ entryId: 'e-42' })] },
    })
    const buttons = w.findAll('button.conflict-pick')
    await buttons[0]!.trigger('click')
    await buttons[1]!.trigger('click')
    expect(w.emitted('resolve')).toEqual([['e-42', 'ours'], ['e-42', 'theirs']])
  })

  it('theirs=null：行文案标注「云方已删除」（取云地方=确认删除语义仍可选）', () => {
    const w = mount(MergeConflictList, {
      global: { plugins: [createTestI18n()] },
      props: { conflicts: [mkConflict({ theirs: null })] },
    })
    expect(w.text()).toContain('云方已删除')
    expect(w.findAll('button.conflict-pick')).toHaveLength(2)
  })

  it('ours=null：行文案标注「本地方已删除」', () => {
    const w = mount(MergeConflictList, {
      global: { plugins: [createTestI18n()] },
      props: { conflicts: [mkConflict({ ours: null })] },
    })
    expect(w.text()).toContain('本地方已删除')
  })

  it('disabled=true：裁决按钮禁用（裁决在途防重入）；空列表不渲染行', () => {
    const w = mount(MergeConflictList, {
      global: { plugins: [createTestI18n()] },
      props: { conflicts: [mkConflict()], disabled: true },
    })
    for (const b of w.findAll('button.conflict-pick')) expect(b.attributes('disabled')).toBeDefined()
    const empty = mount(MergeConflictList, { global: { plugins: [createTestI18n()] }, props: { conflicts: [] } })
    expect(empty.findAll('.conflict-row')).toHaveLength(0)
  })
})
