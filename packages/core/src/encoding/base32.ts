export const RFC4648_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
export const STEAM_ALPHABET = '23456789BCDFGHJKMNPQRTVWXY'

export function base32Encode(bytes: Uint8Array, alphabet: string = RFC4648_ALPHABET): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31]
  while (out.length % 8 !== 0) out += '='
  return out
}

export function base32Decode(input: string, alphabet: string = RFC4648_ALPHABET): Uint8Array {
  const map = new Map<string, number>()
  for (let i = 0; i < alphabet.length; i++) map.set(alphabet[i]!, i)
  const cleaned = input.toUpperCase().replace(/[=\s-]/g, '')
  const out: number[] = []
  let bits = 0
  let value = 0
  for (const ch of cleaned) {
    const idx = map.get(ch)
    if (idx === undefined) throw new Error('invalid base32')
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return new Uint8Array(out)
}
