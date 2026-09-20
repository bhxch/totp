import { decodeImageBytesToUri } from '../src/qrDecode'
import { describe, expect, it } from 'vitest'

describe('decodeImageBytesToUri', () => {
  it('非图片字节返回 null 而非抛错', async () => {
    await expect(decodeImageBytesToUri(new Uint8Array([1, 2, 3]))).resolves.toBeNull()
  })
})
