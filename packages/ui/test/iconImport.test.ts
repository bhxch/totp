import { describe, expect, it } from 'vitest'
import { deflateSync, strToU8, zipSync } from 'fflate'
import { createMemoryStorage } from '@totp/core'
import { createIconStore } from '../src/iconStore'
import { MAX_ICON_PACK_ZIP_BYTES, fileToScaledDataUrl, importIconPackZip } from '../src/iconImport'

/** 最小合法 PNG 头（签名+IHDR+IEND）；iconStore.put 不校验内容，非空即可 */
const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG 签名
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // IHDR 长度+类型
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, // 1x1 RGBA
  0x1f, 0x15, 0xc4, 0x89, // IHDR CRC
  0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82, // IEND
])

/** 标准 CRC-32（IEEE 802.3，zip 规范）：测试内自算，fflate 不导出 */
function crc32(bytes: Uint8Array): number {
  let c = ~0
  for (let i = 0; i < bytes.length; i++) {
    c ^= bytes[i]
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c >>> 0
}

function toDataUrl(bytes: Uint8Array): string {
  let bin = ''
  bytes.forEach((b) => (bin += String.fromCharCode(b)))
  return `data:image/png;base64,${btoa(bin)}`
}

describe('importIconPackZip', () => {
  it('F15：高膨胀炸弹按真实产出预算中止（谎言头不可穿透——预算只认 inflate 真实产出）', async () => {
    const icons = createIconStore(createMemoryStorage())
    await icons.init()
    // 20MiB 零字节 deflate 后极小（远小于 10MB 输入门），但解压产出 20MiB > 8MiB 预算
    const zip = zipSync({ 'bomb.png': new Uint8Array(20 * 1024 * 1024) })
    await expect(importIconPackZip(zip, icons)).rejects.toThrow('超过总量上限')
    expect(icons.icons['bomb']).toBeUndefined()
  })

  it('F15：data-descriptor 流式 zip（本地头无 sizes）与普通 zip 走同一有界路径，正常导入', async () => {
    const icons = createIconStore(createMemoryStorage())
    await icons.init()
    // 手工构造结构自洽的 DD zip：LFH(bit3|sizes=0) + deflate 数据 + DD + CD(尺寸正确) + EOCD
    // ——模拟 Java ZipOutputStream / Go streaming 等工具的真实产物
    const name = new TextEncoder().encode('dd/github.png')
    const data = deflateSync(PNG_BYTES)
    const crc = crc32(PNG_BYTES)
    const lfh = new Uint8Array(30 + name.length)
    const lv = new DataView(lfh.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(4, 20, true)
    lv.setUint16(6, 0x08, true) // GPB bit3：sizes 在 DD 中
    lv.setUint16(8, 8, true) // deflate
    lv.setUint32(14, 0, true)
    lv.setUint32(18, 0, true)
    lv.setUint32(22, 0, true)
    lv.setUint16(26, name.length, true)
    lfh.set(name, 30)
    const dd = new Uint8Array(16)
    const dv = new DataView(dd.buffer)
    dv.setUint32(0, 0x08074b50, true)
    dv.setUint32(4, crc, true)
    dv.setUint32(8, data.length, true)
    dv.setUint32(12, PNG_BYTES.length, true)
    const cdOffset = lfh.length + data.length + dd.length
    const cd = new Uint8Array(46 + name.length)
    const cv = new DataView(cd.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(4, 20, true)
    cv.setUint16(6, 20, true)
    cv.setUint16(8, 0x08, true)
    cv.setUint16(10, 8, true)
    cv.setUint32(16, crc, true)
    cv.setUint32(20, data.length, true)
    cv.setUint32(24, PNG_BYTES.length, true)
    cv.setUint16(28, name.length, true)
    cv.setUint32(42, lfh.length, true) // 本地头偏移
    cd.set(name, 46)
    const eocd = new Uint8Array(22)
    const ev = new DataView(eocd.buffer)
    ev.setUint32(0, 0x06054b50, true)
    ev.setUint16(8, 1, true)
    ev.setUint16(10, 1, true)
    ev.setUint32(12, cd.length, true)
    ev.setUint32(16, cdOffset, true)

    const zip = new Uint8Array(cdOffset + cd.length + eocd.length)
    zip.set(lfh, 0)
    zip.set(data, lfh.length)
    zip.set(dd, lfh.length + data.length)
    zip.set(cd, cdOffset)
    zip.set(eocd, cdOffset + cd.length)

    const result = await importIconPackZip(zip, icons)
    expect(result.imported).toBe(1)
    expect(icons.resolve({ kind: 'stored', id: 'github' })).toBe(toDataUrl(PNG_BYTES))
  })

  it('F15：成员数超过 500 整体拒绝；输入超过 10MB 解压前拒绝', async () => {
    const icons = createIconStore(createMemoryStorage())
    await icons.init()
    const many: Record<string, Uint8Array> = {}
    for (let i = 0; i < 501; i++) many[`p/${String(i).padStart(4, '0')}.png`] = PNG_BYTES
    await expect(importIconPackZip(zipSync(many), icons)).rejects.toThrow('超过 500 个条目')

    const big = new Uint8Array(MAX_ICON_PACK_ZIP_BYTES + 1)
    await expect(importIconPackZip(big, icons)).rejects.toThrow('大小上限')
  })

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

  it('M13：over-quota 时 overwrite 也正确计数（不与 imported/skipped 错算）', async () => {
    // 字典序：a-copy.png (0x2D) < a.png (0x2E) < b.png
    // normalize 后：a-copy → 'acopy'；a → 'a'；b → 'b'
    // 三个 id 均不重复，全部走 imported 分支（overwritten=0）；seen.size=3 > max=2
    // → 遍历 seen（插入序：acopy, a, b）→ keep={acopy, a}，b 计入 skipped
    const icons = createIconStore(createMemoryStorage())
    await icons.init()
    const zip = zipSync({ 'a.png': PNG_BYTES, 'a-copy.png': PNG_BYTES, 'b.png': PNG_BYTES })
    const result = await importIconPackZip(zip, icons, { max: 2 })
    expect(result.imported).toBe(3)
    expect(result.overwritten).toBe(0)
    expect(result.skipped).toBe(1) // b 超出 max
    expect(result.names).toEqual(['acopy', 'a', 'b'])
    expect(icons.icons['acopy']).toBeDefined() // 插入序靠前，保留
    expect(icons.icons['a']).toBeDefined()
    expect(icons.icons['b']).toBeUndefined() // 超出 max 被踢出 pending
  })

  it('M13：同 id 在 max 内 overwrite 不影响 max 计数（overwrite 不增加 seen.size）', async () => {
    // 验证 seen 大小只由「唯一 id 数」决定，overwrite 不递增。
    // a.png + a-copy.png → normalize 后是不同 id('a'/'acopy') 都各自 imported；overwrite=0
    // 用真正同名 normalize 后同 id 的场景：a.png + a_.png（同 id='a'），后者覆盖前者。
    const icons = createIconStore(createMemoryStorage())
    await icons.init()
    const later = PNG_BYTES.slice()
    later[0] = later[0]! ^ 0xff
    // 文件名：a.png normalize 后是 'a'；a_.png normalize 后是 'a'（normalizeIssuer 去下划线）
    const zip = zipSync({ 'a.png': PNG_BYTES, 'a_.png': later })
    const result = await importIconPackZip(zip, icons, { max: 1 })
    expect(result.imported).toBe(1)
    expect(result.overwritten).toBe(1) // 同 id overwrite
    expect(result.skipped).toBe(0) // seen.size=1 = max，未触发 skip
    expect(result.names).toEqual(['a'])
    expect(icons.icons['a']).toBeDefined()
  })

  it('M13：所有唯一 id 都超 max 时——imported 全量计、全部 skipped、pending 为空', async () => {
    const icons = createIconStore(createMemoryStorage())
    await icons.init()
    const zip = zipSync({ 'a.png': PNG_BYTES, 'b.png': PNG_BYTES, 'c.png': PNG_BYTES })
    const result = await importIconPackZip(zip, icons, { max: 0 })
    expect(result.imported).toBe(3)
    expect(result.overwritten).toBe(0)
    expect(result.skipped).toBe(3)
    expect(result.names).toEqual(['a', 'b', 'c'])
    expect(icons.icons['a']).toBeUndefined()
    expect(icons.icons['b']).toBeUndefined()
    expect(icons.icons['c']).toBeUndefined()
  })
})

describe('fileToScaledDataUrl', () => {
  it('jsdom 无 canvas：getContext 为 null 抛 Error(canvas 不可用)', async () => {
    const file = new Blob([new Uint8Array(1024)], { type: 'image/png' })
    await expect(fileToScaledDataUrl(file)).rejects.toThrow('canvas 不可用')
  })
})
