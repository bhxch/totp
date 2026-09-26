/**
 * decodeImageBytesToUri 三分支（盘点 B5-27）：图片字节 → 解码 → otpauth 校验 → uri|null。
 * @totp/ui 的 blobToPixels/decodeQrToUri 以替身注入（canvas/jsQR 依赖在 node 不可用，且
 * 分支归属：本模块只负责编排与 otpauth 白名单校验，解码本体归 ui 包测试）；
 * parseOtpUri 走 @totp/core 真实实现。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { blobToPixels, decodeQrToUri } = vi.hoisted(() => ({
  blobToPixels: vi.fn(async (blob: Blob): Promise<Blob> => blob),
  decodeQrToUri: vi.fn((): { uri?: string; error?: string } => ({ error: 'no qr' })),
}))

vi.mock('@totp/ui', () => ({ blobToPixels, decodeQrToUri }))

import { decodeImageBytesToUri } from '../src/qrDecode'

const VALID_URI = 'otpauth://totp/GitHub:me?secret=JBSWY3DPEHPK3PXP'

beforeEach(() => {
  // mockReset 清 implementation：mockRejectedValue/MockImplementation 不跨用例残留
  decodeQrToUri.mockReset()
  decodeQrToUri.mockImplementation(() => ({ error: 'no qr' }))
  blobToPixels.mockReset()
  blobToPixels.mockImplementation(async (blob: Blob): Promise<Blob> => blob)
})

describe('decodeImageBytesToUri（B5-27）', () => {
  it('blobToPixels 抛错（非图片/像素化失败）→ null 不扩散', async () => {
    blobToPixels.mockRejectedValue(new Error('not an image'))
    await expect(decodeImageBytesToUri(new Uint8Array([1, 2, 3]))).resolves.toBeNull()
  })

  it('解码失败（error 形态）→ null', async () => {
    decodeQrToUri.mockImplementation(() => ({ error: '未识别到二维码' }))
    await expect(decodeImageBytesToUri(new Uint8Array(4))).resolves.toBeNull()
  })

  it('解码抛错（异常形态）→ null', async () => {
    decodeQrToUri.mockImplementation(() => {
      throw new Error('boom')
    })
    await expect(decodeImageBytesToUri(new Uint8Array(4))).resolves.toBeNull()
  })

  it('解码成功但内容非 otpauth（parseOtpUri 白名单拒绝）→ null', async () => {
    decodeQrToUri.mockImplementation(() => ({ uri: 'https://example.com/not-otpauth' }))
    await expect(decodeImageBytesToUri(new Uint8Array(4))).resolves.toBeNull()
  })

  it('合法 otpauth：返回 uri 原文', async () => {
    decodeQrToUri.mockImplementation(() => ({ uri: VALID_URI }))
    await expect(decodeImageBytesToUri(new Uint8Array(4))).resolves.toBe(VALID_URI)
    expect(blobToPixels).toHaveBeenCalledTimes(1) // 字节经 Blob 包装进入像素化
  })
})
