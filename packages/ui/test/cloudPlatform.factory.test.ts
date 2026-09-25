import { createCloudBackend } from '../src/components/cloudPlatform'
import { describe, expect, it, vi } from 'vitest'
import type { CloudCred } from '@totp/core'

/** 工厂直测：五个 backend id 各自产出可调用后端 + 未知 id 拒绝（分支全覆盖） */

describe('createCloudBackend 工厂分发', () => {
  it('webdav / s3 / gist：switch 三分支各产出后端实例', () => {
    const webdav = createCloudBackend({ backend: 'webdav', serverUrl: 'https://dav.example.com', username: 'u', password: 'p' })
    expect(typeof (webdav as { put: unknown }).put).toBe('function')
    const s3 = createCloudBackend({ backend: 's3', region: 'us-east-1', bucket: 'b', accessKeyId: 'a', secretAccessKey: 's' })
    expect(typeof (s3 as { put: unknown }).put).toBe('function')
    const gist = createCloudBackend({ backend: 'gist', token: 't', gistId: 'g' })
    expect(typeof (gist as { put: unknown }).put).toBe('function')
  })

  it('gdrive / onedrive：无 onCredChange 走空 opts 分支', () => {
    const gd = createCloudBackend({ backend: 'gdrive', accessToken: 'tok' })
    expect(typeof (gd as { put: unknown }).put).toBe('function')
    const od = createCloudBackend({ backend: 'onedrive', accessToken: 'tok' })
    expect(typeof (od as { put: unknown }).put).toBe('function')
  })

  it('gdrive / onedrive：有 onCredChange 走注入分支（OAuth 轮转回存回调可达）', () => {
    const onCredChange = vi.fn()
    const gd = createCloudBackend({ backend: 'gdrive', accessToken: 'tok' }, onCredChange)
    expect(typeof (gd as { put: unknown }).put).toBe('function')
    const od = createCloudBackend({ backend: 'onedrive', accessToken: 'tok' }, onCredChange)
    expect(typeof (od as { put: unknown }).put).toBe('function')
  })

  it('未知 backend id：拒绝创建（fail-closed）', () => {
    expect(() => createCloudBackend({ backend: 'nope' } as unknown as CloudCred)).toThrow('未知的云后端类型')
  })
})
