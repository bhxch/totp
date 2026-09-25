import { deflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { decryptZipEntryAes } from '../src/import/zipAes'
import { inflateEntry, listZipEntries, readZipEntryData } from '../src/import/zipRead'

// zipRead 直接单测（纯函数零障碍）：程序化构造 zip 字节流 fixture（手拼 header，
// 字段偏移对齐 src/import/zipRead.ts 头部偏移表与 WinZip/zip 规范）。
// 覆盖盘点 B9 #34：EOCD 缺失/注释区、CEN 损坏、zip64 拒绝、数据越界、不支持 method、
// extra field 边角（size<7 忽略、多个 extra）、LOC 与 CEN extraLen 不一致。

// ---------- little-endian 字节构造 helpers ----------

function u16(v: number): Uint8Array {
  const b = new Uint8Array(2)
  new DataView(b.buffer).setUint16(0, v, true)
  return b
}
function u32(v: number): Uint8Array {
  const b = new Uint8Array(4)
  new DataView(b.buffer).setUint32(0, v, true)
  return b
}
function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}
const bytes = (s: string): Uint8Array => new TextEncoder().encode(s)

interface ZipEntrySpec {
  name: string
  data: Uint8Array
  method?: number
  /** CEN extra field 原始字节（覆盖 LOC extra，见 locExtra） */
  cenExtra?: Uint8Array
  /** LOC extra field 原始字节；缺省与 CEN 相同（构造 LOC extraLen ≠ CEN 的场景用） */
  locExtra?: Uint8Array
  /** CEN 条目注释（走 p += commentLen 的推进分支） */
  comment?: Uint8Array
  /** 覆盖 CEN 里的 csize（zip64 模拟：0xFFFFFFFF） */
  csizeOverride?: number
  /** 覆盖 EOCD 的 cdOffset（CEN 签名错模拟） */
  cdOffsetOverride?: number
}

/** 最小合法 zip：每条目 LOC+数据 → CEN 表 → EOCD（无压缩 method=0 stored） */
function buildZip(specs: ZipEntrySpec[]): Uint8Array {
  const locs: Uint8Array[] = []
  const cens: Uint8Array[] = []
  let offset = 0
  for (const s of specs) {
    const method = s.method ?? 0
    const nameB = bytes(s.name)
    const cenExtra = s.cenExtra ?? new Uint8Array(0)
    const locExtra = s.locExtra ?? cenExtra
    const comment = s.comment ?? new Uint8Array(0)
    const loc = concat(
      u32(0x04034b50), // LOC 签名
      u16(51), u16(0), // 提取版本 / flags
      u16(method), u16(0), u16(0), // method / time / date
      u32(0), // crc
      u32(s.data.length), u32(s.data.length), // csize / usize
      u16(nameB.length), u16(locExtra.length), // nameLen / extraLen
      nameB, locExtra, s.data,
    )
    locs.push(loc)
    const cen = concat(
      u32(0x02014b50), // CEN 签名
      u16(51), u16(51), u16(0), // 制作版本 / 提取版本 / flags
      u16(method), u16(0), u16(0), // method / time / date
      u32(0), // crc
      u32(s.csizeOverride ?? s.data.length), u32(s.data.length), // csize（zip64/越界模拟改写点）/ usize
      u16(nameB.length), u16(cenExtra.length), u16(comment.length), // nameLen / extraLen / commentLen
      u16(0), u16(0), u32(0), // diskStart / intAttr / extAttr
      u32(offset), // localOffset
      nameB, cenExtra, comment,
    )
    cens.push(cen)
    offset += loc.length
  }
  const cenBlob = concat(...cens)
  const cdOffset = (specs[0] as { cdOffsetOverride?: number }).cdOffsetOverride ?? offset
  const eocd = concat(
    u32(0x06054b50), // EOCD 签名
    u16(0), u16(0), u16(specs.length), u16(specs.length), // disk / cdDisk / diskEntries / count@10
    u32(cenBlob.length), u32(cdOffset), // cdSize@12 / cdOffset@16
    u16(0), // commentLen
  )
  return concat(...locs, cenBlob, eocd)
}

/** 在 zip 尾部追加 EOCD 注释（EOCD 藏进注释区：扫描起点落在注释内部） */
function withEocdComment(zip: Uint8Array, comment: string): Uint8Array {
  const commentB = bytes(comment)
  // 原 EOCD 无注释（末 22 字节），替换其 commentLen@20 与追加注释体
  const head = zip.slice(0, zip.length - 2) // 去掉原 commentLen(2B)
  return concat(head, u16(commentB.length), commentB)
}

// ---------- EOCD 定位 ----------

describe('listZipEntries：EOCD 尾部扫描', () => {
  it('截断文件（无 EOCD）→ throw「不是合法 zip（未找到 EOCD）」', () => {
    const zip = buildZip([{ name: 'a.txt', data: bytes('hello') }])
    const truncated = zip.slice(0, zip.length - 22) // 恰好裁掉整个 EOCD
    expect(() => listZipEntries(truncated)).toThrow('未找到 EOCD')
  })

  it('EOCD 藏在注释区（commentLen>0，扫描起点落入注释内部仍可找到）', () => {
    const zip = withEocdComment(
      buildZip([{ name: 'a.txt', data: bytes('hello') }]),
      'zip comment created by some tool —— EOCD 前有 44 字节注释',
    )
    const entries = listZipEntries(zip)
    expect(entries).toHaveLength(1)
    expect(entries[0]!.name).toBe('a.txt')
    expect(entries[0]!.method).toBe(0)
  })

  it('多条目 + CEN 条目注释：推进按 46+name+extra+comment，顺序与数据偏移正确', () => {
    const zip = buildZip([
      { name: 'Accounts.txt', data: bytes('line1\nline2'), comment: bytes('entry comment') },
      { name: 'meta.json', data: bytes('{}') },
    ])
    const entries = listZipEntries(zip)
    expect(entries.map((e) => e.name)).toEqual(['Accounts.txt', 'meta.json'])
    const raw0 = readZipEntryData(zip, entries[0]!)
    const raw1 = readZipEntryData(zip, entries[1]!)
    expect(new TextDecoder().decode(raw0)).toBe('line1\nline2')
    expect(new TextDecoder().decode(raw1)).toBe('{}')
  })
})

// ---------- CEN / 数据区 ----------

describe('listZipEntries：central directory', () => {
  it('CEN 签名错（cdOffset 指向 LOC 区）→ throw「zip central directory 损坏」', () => {
    const zip = buildZip([{ name: 'a.txt', data: bytes('x'), cdOffsetOverride: 0 }])
    expect(() => listZipEntries(zip)).toThrow('central directory 损坏')
  })
})

describe('readZipEntryData', () => {
  it('zip64（CEN.csize=0xFFFFFFFF）→ throw「不支持 zip64」', () => {
    const zip = buildZip([{ name: 'a.txt', data: bytes('x'), csizeOverride: 0xffffffff }])
    const entries = listZipEntries(zip)
    expect(() => readZipEntryData(zip, entries[0]!)).toThrow('不支持 zip64')
  })

  it('数据越界（CEN.csize 超出文件尾）→ throw「zip 条目数据越界（文件损坏）」', () => {
    // csize 声明远超实际数据（真实损坏文件的典型形态），篡改值经解析路径自然透出
    const zip = buildZip([{ name: 'a.txt', data: bytes('x'), csizeOverride: 0xffffff }])
    const [entry] = listZipEntries(zip)
    expect(entry!.csize).toBe(0xffffff)
    expect(() => readZipEntryData(zip, entry!)).toThrow('数据越界')
  })

  it('LOC extraLen ≠ CEN extraLen：数据偏移按 LOC 自己的 name/extraLen 计算', () => {
    const cenExtra = new Uint8Array(0)
    const locExtra = concat(u16(0x7075), u16(2), new Uint8Array([0x01, 0x02])) // LOC 独有的 8 字节 extra
    const zip = buildZip([{ name: 'a.txt', data: bytes('payload-data'), cenExtra, locExtra }])
    const entries = listZipEntries(zip)
    expect(entries[0]!.dataOffset).toBeGreaterThan(30 + 'a.txt'.length) // LOC extra 被计入
    expect(new TextDecoder().decode(readZipEntryData(zip, entries[0]!))).toBe('payload-data')
  })
})

// ---------- extra field 0x9901（WinZip AES）与 method ----------

/** AES extra field 0x9901：formatVersion(2B) vendor(2B) strength(1B) realMethod(2B) */
const aesExtra = (version: 1 | 2, strength: 1 | 2 | 3, realMethod: 0 | 8): Uint8Array =>
  concat(u16(0x9901), u16(7), u16(version), bytes('AE'), new Uint8Array([strength]), u16(realMethod))

describe('extra field 扫描（0x9901）', () => {
  it('常规解析：version/strength/realMethod 透出，dataOffset 越过 LOC 的同名 extra', () => {
    const extra = aesExtra(2, 3, 0)
    const zip = buildZip([{ name: 'Accounts.txt', data: bytes('ciphertext-bytes'), method: 99, cenExtra: extra }])
    const entries = listZipEntries(zip)
    expect(entries[0]!.aes).toEqual({ version: 2, strength: 3, realMethod: 0 })
    expect(entries[0]!.method).toBe(99)
    expect(new TextDecoder().decode(readZipEntryData(zip, entries[0]!))).toBe('ciphertext-bytes')
  })

  it('边角：size<7 的 0x9901 被忽略，继续扫描，第二个合法 0x9901 才被采纳', () => {
    const tiny = concat(u16(0x9901), u16(4), new Uint8Array([1, 2, 3, 4])) // size 4 < 7 → 非法忽略
    const benign = concat(u16(0x7075), u16(1), new Uint8Array([0x00])) // 非 AES extra，推进用
    const good = aesExtra(1, 1, 8)
    const extra = concat(tiny, benign, good)
    const zip = buildZip([{ name: 'Accounts.txt', data: bytes('x'), cenExtra: extra }])
    const entries = listZipEntries(zip)
    expect(entries[0]!.aes).toEqual({ version: 1, strength: 1, realMethod: 8 })
  })
})

describe('inflateEntry：method 分派', () => {
  it('method 99（AES 条目）：realMethod=0 stored 原样返回', () => {
    const raw = bytes('stored-plain')
    const out = inflateEntry({ name: 'a', csize: raw.length, method: 99, dataOffset: 0, aes: { version: 2, strength: 3, realMethod: 0 } }, raw)
    expect(new TextDecoder().decode(out)).toBe('stored-plain')
  })

  it('method 99：realMethod=8 deflate raw 二次展开', () => {
    const plain = bytes('deflated-content')
    const raw = deflateRawSync(plain)
    const out = inflateEntry({ name: 'a', csize: raw.length, method: 99, dataOffset: 0, aes: { version: 2, strength: 3, realMethod: 8 } }, raw)
    expect(new TextDecoder().decode(out)).toBe('deflated-content')
  })

  it('method 8（普通 deflate）展开；method 0 原样', () => {
    const plain = bytes('plain-deflate')
    expect(new TextDecoder().decode(inflateEntry({ name: 'a', csize: 1, method: 8, dataOffset: 0 }, deflateRawSync(plain)))).toBe('plain-deflate')
    expect(new TextDecoder().decode(inflateEntry({ name: 'a', csize: 1, method: 0, dataOffset: 0 }, plain))).toBe('plain-deflate')
  })

  it('不支持的压缩方法（非 0/8/99）→ throw「不支持的 zip 压缩方法」', () => {
    expect(() => inflateEntry({ name: 'a', csize: 1, method: 12, dataOffset: 0 }, bytes('x'))).toThrow('不支持的 zip 压缩方法：12')
  })
})

// ---------- zipAes 边角（盘点 B9 #35：条目过短 throw，AP 集成测试全为良构条目触不到） ----------

describe('decryptZipEntryAes：条目过短', () => {
  it('salt(16)+verifier(2)+authCode(10) 都放不下 → throw「AP 加密条目过短」', async () => {
    await expect(decryptZipEntryAes('pw', new Uint8Array(20), 3, 2)).rejects.toThrow('AP 加密条目过短')
  })
})
