import { inflateSync } from 'fflate'

// zip 结构解析：EOCD / central directory / local header，全部 little-endian DataView。
// 偏移表（字段 → 偏移(字节宽)）：
//   EOCD(sig 0x06054b50) cdCount@10(2B) cdSize@12(4B) cdOffset@16(4B)
//   CEN (sig 0x02014b50) method@10(2B) csize@20(4B) nameLen@28(2B) extraLen@30(2B) commentLen@32(2B) localOffset@42(4B)
//   LOC (sig 0x04034b50) nameLen@26(2B) extraLen@28(2B)
//   AES extra field id 0x9901: formatVersion(2B) vendorId(2B) strength(1B: 1/2/3) realMethod(2B)
//
// 注：本仓锁定的 fflate 0.8.3 构建未导出上游的 inflateRawSync 别名；其 inflateSync 即
// raw deflate（inflt {i:2}，无 zlib 头，实测 node:zlib deflateRawSync 输出可解，见
// test/authenticatorPlus.test.ts）——语义与上游 inflateRawSync 相同。
export interface ZipEntryView {
  name: string
  csize: number
  method: number
  dataOffset: number
  aes?: { strength: 1 | 2 | 3; realMethod: number; version: 1 | 2 }
}

/** 遍历 central directory 列出全部条目（含 AES extra field 0x9901 解析与数据区偏移计算） */
export function listZipEntries(bytes: Uint8Array): ZipEntryView[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  // ① 从尾部扫 EOCD（注释区最长 65535 + 固定 22）
  let eocd = -1
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('不是合法 zip（未找到 EOCD）')
  const count = dv.getUint16(eocd + 10, true)
  // cdOffset 为 CEN 的文件绝对偏移（zip 规范：with respect to the starting disk number）；
  // brief 骨架误写为 eocd + cdOffset，任何标准 zip（含 7z 输出）都会偏出 CEN 区——以测试 fixture 修正
  let p = dv.getUint32(eocd + 16, true)
  const out: ZipEntryView[] = []
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('zip central directory 损坏')
    const method = dv.getUint16(p + 10, true)
    const csize = dv.getUint32(p + 20, true)
    const nameLen = dv.getUint16(p + 28, true)
    const extraLen = dv.getUint16(p + 30, true)
    const commentLen = dv.getUint16(p + 32, true)
    const localOffset = dv.getUint32(p + 42, true)
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen))
    // ② extra field 中找 AES(0x9901)
    let aes: ZipEntryView['aes']
    let q = p + 46 + nameLen
    const extraEnd = q + extraLen
    while (q + 4 <= extraEnd) {
      const id = dv.getUint16(q, true)
      const size = dv.getUint16(q + 2, true)
      if (id === 0x9901 && size >= 7) {
        aes = { version: dv.getUint16(q + 4, true) as 1 | 2, strength: dv.getUint8(q + 8) as 1 | 2 | 3, realMethod: dv.getUint16(q + 9, true) }
        break
      }
      q += 4 + size
    }
    // ③ 数据区 = LOC 头 + name + extra（LOC 的 extraLen 可能与 CEN 不同，须读 LOC 自己的）
    const locNameLen = dv.getUint16(localOffset + 26, true)
    const locExtraLen = dv.getUint16(localOffset + 28, true)
    out.push({ name, csize, method, dataOffset: localOffset + 30 + locNameLen + locExtraLen, aes })
    p += 46 + nameLen + extraLen + commentLen
  }
  return out
}

/** 读取条目原始数据（加密条目 = 解密前的 salt||verifier||ciphertext||authCode）；
 * zip64（csize=0xFFFFFFFF）不在支持范围——AP 导出远小于 4GB */
export function readZipEntryData(bytes: Uint8Array, e: ZipEntryView): Uint8Array {
  if (e.csize === 0xffffffff) throw new Error('不支持 zip64')
  if (e.dataOffset + e.csize > bytes.length) throw new Error('zip 条目数据越界（文件损坏）')
  return bytes.slice(e.dataOffset, e.dataOffset + e.csize)
}

/** 条目数据 → 明文：method 99（WinZip AES）按 extra field 的 real method 二次展开，0=stored、8=deflate raw */
export function inflateEntry(e: ZipEntryView, raw: Uint8Array): Uint8Array {
  if (e.aes && e.method === 99) return e.aes.realMethod === 0 ? raw : inflateSync(raw)
  if (e.method === 0) return raw
  if (e.method === 8) return inflateSync(raw)
  throw new Error('不支持的 zip 压缩方法：' + e.method)
}
