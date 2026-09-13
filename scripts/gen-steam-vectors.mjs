// pnpm dlx 方式运行：node scripts/gen-steam-vectors.mjs
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
// 先安装：pnpm add -D -w steam-totp（仅 devDependencies，供生成向量用）
const { generateAuthCode } = require('steam-totp')

// 固定测试 secret：标准 RFC4648 base32（此处为随机固定值，非真实账号）
const B32 = 'MZLVOVJQVEWROFJVOUQ4EJCVOFRKGADG'
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const b32decode = (s) => {
  const map = new Map([...ALPHABET].map((c, i) => [c, i]))
  const clean = s.replace(/=+$/, '')
  const out = []
  let bits = 0, value = 0
  for (const ch of clean) {
    value = (value << 5) | map.get(ch)
    bits += 5
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8 }
  }
  return Buffer.from(out)
}
const bytes = b32decode(B32)
const b64 = bytes.toString('base64') // steam-totp 接受 base64 的 shared_secret

// 取未来 60~120 秒内的三个 30s 整点，避免运行期间跨窗口
const now = Date.now()
const targets = [0, 1, 2].map((i) => (Math.floor((now + (120 + i * 30) * 1000) / 30000)) * 30000)
const vectors = []
for (const tMs of targets) {
  // ceil 保证 steam-totp 内部 floor(now/1000) + offset 恰好等于整点秒 tMs/1000（round 有约半数概率少 1 秒、跨到前一窗口）
  const offsetSec = Math.ceil((tMs - Date.now()) / 1000)
  const code = generateAuthCode(b64, offsetSec)
  vectors.push({ tMs, code })
}
console.log(JSON.stringify({ secretBase32: B32, vectors }, null, 2))
