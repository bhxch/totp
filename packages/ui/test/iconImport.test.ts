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
    expect(result.skippedLarge).toBe(1)
    expect(result.names).toEqual(['github', 'google'])
    // github 能 recommend 到 builtin，但 zip 导入一律 stored id，不自动映射 builtin
    expect(icons.resolve({ kind: 'stored', id: 'github' })).toBe(toDataUrl(PNG_BYTES))
    expect(icons.icons['google']!).toBe(toDataUrl(PNG_BYTES))
    expect(icons.icons['huge']).toBeUndefined()
    expect(icons.icons['readme.txt']).toBeUndefined()
  })

  it('I60+I63：同名（normalize 后）按字典序后者覆盖前者；overwritten 而非 skipped', async () => {
    const icons = createIconStore(createMemoryStorage())
    await icons.init()
    const later = PNG_BYTES.slice()
    const last = later.length - 1
    later[last] = later[last]! ^ 0xff // 与前者字节不同，验证覆盖生效
    // 文件名 normalize 后都是 'github'；用路径前缀 'a/' 'z/' 控制字典序
    const zip = zipSync({ 'a/github.png': PNG_BYTES, 'z/github.png': later })
    const result = await importIconPackZip(zip, icons)
    expect(result.imported).toBe(1)
    expect(result.overwritten).toBe(1)
    expect(result.skipped).toBe(0)
    expect(result.names).toEqual(['github'])
    expect(icons.icons['github']).toBe(toDataUrl(later))
  })

  it('I60：字典序排序后处理——同名时按字典序后者覆盖前者', async () => {
    const icons = createIconStore(createMemoryStorage())
    await icons.init()
    const earlier = PNG_BYTES.slice()
    const later = PNG_BYTES.slice()
    earlier[0] = 0x00
    later[0] = 0xff
    // a.png 在前，b.png 在后 → a 后于 b 字典序前，但 normalize 后都是 'a'/'b'
    const zip = zipSync({ 'b.png': earlier, 'a.png': later })
    const result = await importIconPackZip(zip, icons)
    expect(result.imported).toBe(2)
    expect(result.overwritten).toBe(0)
    expect(icons.icons['a']).toBe(toDataUrl(later))
    expect(icons.icons['b']).toBe(toDataUrl(earlier))
  })

  it('I63：超过 max 上限的条目计入 skipped（不写入 store），但 imported 仍按全部唯一 id 统计', async () => {
    const icons = createIconStore(createMemoryStorage())
    await icons.init()
    const zip = zipSync({ 'a.png': PNG_BYTES, 'b.png': PNG_BYTES, 'c.png': PNG_BYTES })
    const result = await importIconPackZip(zip, icons, { max: 2 })
    // 唯一 id 有 3 个，但 max=2 → 第三个计入 skipped
    expect(result.imported).toBe(3)
    expect(result.skipped).toBe(1)
    expect(result.names).toEqual(['a', 'b', 'c'])
    // 实际只写入前两个
    expect(icons.icons['a']).toBeDefined()
    expect(icons.icons['b']).toBeDefined()
    expect(icons.icons['c']).toBeUndefined()
  })
})

describe('fileToScaledDataUrl', () => {
  it('jsdom 无 canvas：getContext 为 null 抛 Error(canvas 不可用)', async () => {
    const file = new Blob([new Uint8Array(1024)], { type: 'image/png' })
    await expect(fileToScaledDataUrl(file)).rejects.toThrow('canvas 不可用')
  })
})
