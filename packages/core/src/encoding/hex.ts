/**
 * Hex 字符串 → 字节（大小写兼容）。
 * 奇数长度或含非 hex 字符返回 null（与原 aegis/miscApps 行为一致；winauth 旧实现抛 '非法 hex'，
 * 调用方 catch 后归类为口令错，语义无差异——M9 统一为返回 null，由调用方按业务决定如何提示）。
 */
export function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) return null
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}
