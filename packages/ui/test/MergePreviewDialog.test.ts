import { describe, expect, it } from 'vitest'
import { nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import type { EntryConflict, OtpEntry } from '@totp/core'
import type { ManualMergePreview } from '../src/components/cloudRunner'
import MergePreviewDialog from '../src/components/MergePreviewDialog.vue'
import { createTestI18n } from './helpers/i18n'

function mkEntry(secret: string): OtpEntry {
  return {
    uuid: 'u', type: 'totp', issuer: 'GitHub', label: 'me@example.com', secret,
    algorithm: 'SHA1', digits: 6, period: 30, tagIds: [], order: 0, createdAt: 0, updatedAt: 0,
  }
}

/** 三种冲突形态：仅本地方（云端无/已删）、仅云地方（本地无/已删）、双方均改 */
const PREVIEW: ManualMergePreview = {
  conflicts: [
    { entryId: 'e-local', issuer: 'LocalOnly', label: 'a@x.com', ours: mkEntry('AAAA'), theirs: null, base: null },
    { entryId: 'e-cloud', issuer: 'CloudOnly', label: 'b@x.com', ours: null, theirs: mkEntry('BBBB'), base: null },
    { entryId: 'e-both', issuer: 'Both', label: 'c@x.com', ours: mkEntry('CCCC'), theirs: mkEntry('DDDD'), base: mkEntry('EEEE') },
  ],
  mergeDegraded: true,
  sourceName: 'WebDAV; GitHub Gist',
}

function mountDialog(open = true, preview: ManualMergePreview | null = PREVIEW) {
  return mount(MergePreviewDialog, {
    global: { plugins: [createTestI18n()] },
    props: { open, preview },
  })
}

describe('MergePreviewDialog', () => {
  it('open=false：不渲染对话框', () => {
    const w = mountDialog(false)
    expect(w.find('[role="dialog"]').exists()).toBe(false)
  })

  it('三段渲染：仅本地方/仅云地方/双方均改，各行 issuer 可见', () => {
    const w = mountDialog()
    expect(w.find('[role="dialog"]').exists()).toBe(true)
    expect(w.find('.preview-only-local').exists()).toBe(true)
    expect(w.find('.preview-only-cloud').exists()).toBe(true)
    expect(w.find('.preview-both').exists()).toBe(true)
    expect(w.text()).toContain('LocalOnly')
    expect(w.text()).toContain('CloudOnly')
    expect(w.text()).toContain('Both')
  })

  it('源名与降级警示：sourceName 显示；mergeDegraded=true 显示降级提示', () => {
    const w = mountDialog()
    expect(w.text()).toContain('WebDAV; GitHub Gist')
    expect(w.find('.preview-degraded').exists()).toBe(true)
  })

  it('mergeDegraded=false：不显示降级提示；conflicts 空 → 无差异占位', () => {
    const w = mountDialog(true, { conflicts: [], mergeDegraded: false, sourceName: 'S3' })
    expect(w.find('.preview-degraded').exists()).toBe(false)
    expect(w.find('.preview-empty').exists()).toBe(true)
  })

  it('点确认 emit confirm；点取消 emit cancel', async () => {
    const w = mountDialog()
    await w.find('button.preview-confirm').trigger('click')
    await w.find('button.preview-cancel').trigger('click')
    expect(w.emitted('confirm')).toHaveLength(1)
    expect(w.emitted('cancel')).toHaveLength(1)
  })

  it('MdDialog 关闭通道（Esc/遮罩）→ 视同取消 emit cancel', async () => {
    const w = mountDialog()
    // MdDialog 在 window 上监听 keydown（focus trap 同一通道）：直发 window 事件驱动其 close 语义
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await nextTick()
    expect(w.emitted('cancel')).toHaveLength(1)
  })
})
