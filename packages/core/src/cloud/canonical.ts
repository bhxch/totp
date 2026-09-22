/** 规范化 JSON 与内容 hash（spec §1.3 内容门）：对解密后 vault JSON 做稳定序列化再 sha256，
 *  消除键序抖动——「内容未变」判定与字节形态解耦。 */

export function canonicalJson(x: unknown): string {
  if (x === null || typeof x !== 'object') return JSON.stringify(x) ?? 'null'
  if (Array.isArray(x)) return `[${x.map(canonicalJson).join(',')}]`
  const keys = Object.keys(x as Record<string, unknown>)
    .filter((k) => (x as Record<string, unknown>)[k] !== undefined)
    .sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((x as Record<string, unknown>)[k])}`).join(',')}}`
}

export async function contentHash(vaultJson: string): Promise<string> {
  const stable = canonicalJson(JSON.parse(vaultJson))
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(stable) as BufferSource)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
