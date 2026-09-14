import { describe, expect, it } from 'vitest'
import { strToU8, zipSync } from 'fflate'
import { createMemoryStorage } from '@totp/core'
import { createIconStore } from '../src/iconStore'
import { fileToScaledDataUrl, importIconPackZip } from '../src/iconImport'

/** 最小合法 PNG 头（签名+IHDR+IEND）；iconStore.put 不校验内容，非空即可 */
const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG 签名
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // IHDR 长度+类型
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, // 1x1 RGBA
  0x1f, 0x15, 0xc4, 0x89, // IHDR CRC
  0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82, // IEND
])

function toDataUrl(bytes: Uint8Array): string {
  let bin = ''
  bytes.forEach((b) => (bin += String.fromCharCode(b)))
  return `data:image/png;base64,${btoa(bin)}`
}

describe('importIconPackZip', () => {
  it('任意层级收 png；非 png 忽略、超 maxBytes 计 skipped；一律 stored id=normalizeIssuer', async () => {
    const icons = createIconStore(createMemoryStorage())
    await icons.init()
    const zip = zipSync({
      'icons/github.png': PNG_BYTES,
      'sub/google.png': PNG_BYTES,
      'readme.txt': strToU8('not an icon'),
      'huge.png': new Uint8Array(50 * 1024 + 1),
    })
    const result = await importIconPackZip(zip, icons)
    expect(result.imported).toBe(2)
    expect(result.skipped).toBe(1)
    expect(result.names).toEqual(['github', 'google'])
    // github 能 recommend 到 builtin，但 zip 导入一律 stored id，不自动映射 builtin
    expect(icons.resolve({ kind: 'stored', id: 'github' })).toBe(toDataUrl(PNG_BYTES))
    expect(icons.icons['google']!).toBe(toDataUrl(PNG_BYTES))
    expect(icons.icons['huge']).toBeUndefined()
    expect(icons.icons['readme.txt']).toBeUndefined()
  })

  it('同名（normalize 后）后者覆盖前者并计 skipped，names 去重', async () => {
    const icons = createIconStore(createMemoryStorage())
    await icons.init()
    const later = PNG_BYTES.slice()
    const last = later.length - 1
    later[last] = later[last]! ^ 0xff // 与前者字节不同，验证覆盖生效
    const zip = zipSync({ 'GitHub.png': PNG_BYTES, 'github.png': later })
    const result = await importIconPackZip(zip, icons)
    expect(result.imported).toBe(1)
    expect(result.skipped).toBe(1)
    expect(result.names).toEqual(['github'])
    expect(icons.icons['github']).toBe(toDataUrl(later))
  })

  it('导入数达 max 停止，后续 png 不再写入', async () => {
    const icons = createIconStore(createMemoryStorage())
    await icons.init()
    const zip = zipSync({ 'a.png': PNG_BYTES, 'b.png': PNG_BYTES, 'c.png': PNG_BYTES })
    const result = await importIconPackZip(zip, icons, { max: 2 })
    expect(result.imported).toBe(2)
    expect(result.names).toEqual(['a', 'b'])
    expect(icons.icons['c']).toBeUndefined()
  })
})

describe('fileToScaledDataUrl', () => {
  it('jsdom 无 canvas：getContext 为 null 抛 Error(canvas 不可用)', async () => {
    const file = new Blob([new Uint8Array(1024)], { type: 'image/png' })
    await expect(fileToScaledDataUrl(file)).rejects.toThrow('canvas 不可用')
  })
})
