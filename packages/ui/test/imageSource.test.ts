import { imagesFromClipboard } from '../src/qr/imageSource'
import { describe, expect, it } from 'vitest'

function clipboardEventWith(items: Array<{ kind: string; type: string; file?: File }>): ClipboardEvent {
  const dt = { items: items.map((it) => ({ kind: it.kind, type: it.type, getAsFile: () => it.file ?? null })) }
  return { clipboardData: dt } as unknown as ClipboardEvent
}

describe('imagesFromClipboard', () => {
  it('只收集图片文件，忽略文本项', () => {
    const png = new File(['x'], 'a.png', { type: 'image/png' })
    const e = clipboardEventWith([
      { kind: 'string', type: 'text/plain' },
      { kind: 'file', type: 'image/png', file: png },
      { kind: 'file', type: 'application/pdf' },
    ])
    expect(imagesFromClipboard(e)).toEqual([png])
  })
  it('无剪贴板数据返回空数组', () => {
    expect(imagesFromClipboard({} as ClipboardEvent)).toEqual([])
  })
})
