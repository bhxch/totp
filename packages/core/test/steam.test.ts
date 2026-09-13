import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { steamCode } from '../src/otp/steam'
import { base32Decode, STEAM_ALPHABET } from '../src/encoding/base32'

const vec = JSON.parse(
  readFileSync(fileURLToPath(new URL('./vectors/steam.json', import.meta.url)), 'utf8'),
) as { secretBase32: string; vectors: Array<{ tMs: number; code: string }> }

describe('steamCode 对拍 steam-totp 参考实现', () => {
  it.each(vec.vectors.map((v) => [v.tMs, v.code]))('tMs=%i → %s', async (tMs, code) => {
    const out = await steamCode(base32Decode(vec.secretBase32), tMs)
    expect(out).toBe(code)
  })
})

it('输出恒为 5 字符且属于 Steam 字母表', async () => {
  const out = await steamCode(base32Decode(vec.secretBase32), Date.now())
  expect(out).toHaveLength(5)
  for (const ch of out) expect(STEAM_ALPHABET).toContain(ch)
})
