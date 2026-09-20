// 运行：node scripts/gen-yaotp-vectors.mjs   （仅 node:crypto 内置，无第三方依赖）
// 输出 6 行「secret_b32 | pin | period | timeMs | 期望 code」JSON，粘贴进 packages/core/test/yandex.test.ts 的 VECTORS 常量
import crypto from 'node:crypto'
const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
function b32(bytes) {
  let bits = 0, val = 0, out = ''
  for (const b of bytes) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += ALPHA[(val >>> (bits - 5)) & 31]; bits -= 5 } }
  if (bits > 0) out += ALPHA[(val << (5 - bits)) & 31] // 末个不足 5bit 的组补零输出（RFC4648 无填充语义），否则解码侧丢字节
  return out
}
const secret = crypto.randomBytes(16)
const cases = []
for (const pin of ['1234', '0000', 'yy9-_x']) {
  for (const [period, timeMs] of [[30, 1700000000000], [60, 1700000060000]]) {
    const pinB = Buffer.from(pin, 'utf8')
    let keyHash = crypto.createHash('sha256').update(Buffer.concat([pinB, secret])).digest()
    if (keyHash[0] === 0) keyHash = keyHash.subarray(1)
    const counter = Math.floor(timeMs / 1000 / period)
    const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(counter))
    const h = crypto.createHmac('sha256', keyHash).update(msg).digest()
    const off = h[h.length - 1] & 0xf
    h[off] &= 0x7f
    let code = h.readBigUInt64BE(off) % 26n ** 8n
    let out = ''
    for (let i = 0; i < 8; i++) { out += String.fromCharCode(97 + Number(code % 26n)); code /= 26n }
    cases.push({ secretB32: b32(secret), pin, period, timeMs, code: out })
  }
}
console.log(JSON.stringify(cases, null, 2))
