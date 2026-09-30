import { beforeEach, describe, expect, it, vi } from 'vitest'
import { bytesToBase64 } from '@totp/core'

// vi.mock 工厂被提升至文件顶，sendMessage 须同经 vi.hoisted 提前初始化（否则 TDZ：Cannot access before initialization）
const sendMessage = vi.hoisted(() => vi.fn())
vi.mock('./extApi', () => ({ ext: { runtime: { sendMessage } } }))

import { backgroundProxiedFetch } from './cloudFetchProxy'

describe('页面端 background 代理 fetch（③）', () => {
  beforeEach(() => sendMessage.mockReset())

  it('组消息形状（method 默认 GET、Uint8Array→b64）；应答重建真 Response', async () => {
    sendMessage.mockResolvedValue({ status: 201, statusText: 'Made', headers: { 'x-k': 'v' }, bodyB64: bytesToBase64(new Uint8Array([4, 5])) })
    const res = await backgroundProxiedFetch('WebDAV', 'https://dav/f', { method: 'PUT', body: new Uint8Array([4, 5]) })
    expect(sendMessage).toHaveBeenCalledWith({ type: 'cloud-fetch', url: 'https://dav/f', method: 'PUT', headers: {}, bodyB64: bytesToBase64(new Uint8Array([4, 5])) })
    expect(res.status).toBe(201)
    expect(res.ok).toBe(true)
    expect(res.headers.get('x-k')).toBe('v')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([4, 5]))
  })
  it('error 应答转 throw（交 cloudFetch 包装中文错误）', async () => {
    sendMessage.mockResolvedValue({ error: 'boom' })
    await expect(backgroundProxiedFetch('L', 'https://x')).rejects.toThrow('boom')
  })
})
