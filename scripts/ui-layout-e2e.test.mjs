import { describe, expect, it } from 'vitest'
import { parseJson, resolveCli } from './ui-layout-e2e.mjs'

describe('scripts/ui-layout-e2e.mjs', () => {
  it('parseJson：裸 JSON 对象原样解析', () => {
    expect(parseJson('{"connected":true,"identifier":"com.totp.desktop"}')).toEqual({ connected: true, identifier: 'com.totp.desktop' })
  })

  it('parseJson：剥掉 CLI 告警前缀与收尾说明', () => {
    const out = '⚠️ Multiple windows detected (2 total). Defaulting to \'main\' window.\n\n{"ok":1}\n\n[Executed in window: main]'
    expect(parseJson(out)).toEqual({ ok: 1 })
  })

  it('parseJson：剥掉 --json 信封层，取信封 text 里的真载荷', () => {
    const envelope = JSON.stringify({ text: '{"fields":[{"id":"a"}]}', markdown: null, content: [] })
    expect(parseJson(envelope)).toEqual({ fields: [{ id: 'a' }] })
  })

  it('parseJson：信封 text 非 JSON 时按原样返回', () => {
    expect(parseJson(JSON.stringify({ text: 'not json' }))).toEqual({ text: 'not json' })
  })

  it('parseJson：数组载荷（量测结果列表）整体解析', () => {
    expect(parseJson('[{"id":"x","labelLines":1}]')).toEqual([{ id: 'x', labelLines: 1 }])
  })

  it('parseJson：无 JSON 时抛错（不静默通过）', () => {
    expect(() => parseJson('no json here')).toThrow(/未找到 JSON/)
  })

  it('resolveCli：能在 PATH 上定位 tauri-mcp（本机装了才返回非 null；未装返回 null）', () => {
    const cli = resolveCli()
    // 断言形状而非存在性：CI 上可能没装 CLI
    if (cli !== null) {
      expect(typeof cli.cmd).toBe('string')
      expect(Array.isArray(cli.prefix)).toBe(true)
    } else {
      expect(cli).toBeNull()
    }
  })
})
