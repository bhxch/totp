/** R7：卡片基建共享层（cardShared）用例——源 id 工厂/空白凭据/草稿守卫/明文地址判定/选项常量工厂 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  blankCred, hasPlaintextUrl, intervalOptions, isBlankCred, isGDriveDraft, isGistDraft,
  isOAuthCapableDraft, isOneDriveDraft, isS3Draft, isWebdavDraft, newSourceId, retentionOptions,
} from '../src/components/cardShared'
import type { CloudCred } from '@totp/core'

const t = (key: string): string => `[${key}]`

/** jsdom 的 crypto.randomUUID 存在性不定：注入固定值/移除后按还原函数恢复 */
function stubRandomUUID(v: (() => string) | undefined): () => void {
  const desc = Object.getOwnPropertyDescriptor(globalThis.crypto, 'randomUUID')
  Object.defineProperty(globalThis.crypto, 'randomUUID', { value: v, configurable: true })
  return () => {
    if (desc) Object.defineProperty(globalThis.crypto, 'randomUUID', desc)
    else Reflect.deleteProperty(globalThis.crypto, 'randomUUID')
  }
}

afterEach(() => {
  // 防御：个别用例的 stub 未还原时不串扰后续文件
  Reflect.deleteProperty(globalThis.crypto as Record<string, unknown>, 'randomUUID')
})

describe('cardShared', () => {
  it('newSourceId：randomUUID 存在时直用其值；缺失时回落 src- 前缀时间戳+随机段', () => {
    const restore = stubRandomUUID(() => 'uuid-fixed')
    expect(newSourceId()).toBe('uuid-fixed')
    restore()

    const restore2 = stubRandomUUID(undefined)
    const id = newSourceId()
    expect(id.startsWith('src-')).toBe(true)
    expect(id.length).toBeGreaterThan('src-'.length)
    restore2()
  })

  it('blankCred：五种后端字符串字段全空串、布尔/oauth 可选字段不设键（isBlankCred 判空白）', () => {
    expect(blankCred('webdav')).toEqual({ backend: 'webdav', serverUrl: '', username: '', password: '', objectPath: '' })
    expect(blankCred('s3')).toEqual({
      backend: 's3', region: '', bucket: '', accessKeyId: '', secretAccessKey: '', endpoint: '', prefix: '', sessionToken: '', objectPath: '',
    })
    const gist = blankCred('gist')
    expect('public' in gist).toBe(false)
    const s3 = blankCred('s3')
    expect('forcePathStyle' in s3).toBe(false)
    const gdrive = blankCred('gdrive')
    expect('oauth' in gdrive).toBe(false)

    for (const b of ['webdav', 's3', 'gist', 'gdrive', 'onedrive'] as const) {
      expect(blankCred(b).backend).toBe(b)
      expect(isBlankCred(blankCred(b))).toBe(true)
    }
  })

  it('isBlankCred：任一字段非空串即非空白（undefined 与空串同判空白）', () => {
    expect(isBlankCred({ backend: 'webdav', serverUrl: '', username: '', password: 'pw', objectPath: '' })).toBe(false)
    expect(isBlankCred({ backend: 'gdrive', accessToken: 'tok', objectPath: undefined })).toBe(false)
  })

  it('草稿守卫：按 backend 窄化，undefined 安全返回 false', () => {
    const cred = (backend: CloudCred['backend']): CloudCred => blankCred(backend)
    expect(isWebdavDraft(cred('webdav'))).toBe(true)
    expect(isS3Draft(cred('s3'))).toBe(true)
    expect(isGistDraft(cred('gist'))).toBe(true)
    expect(isGDriveDraft(cred('gdrive'))).toBe(true)
    expect(isOneDriveDraft(cred('onedrive'))).toBe(true)
    expect(isWebdavDraft(undefined)).toBe(false)
    expect(isGDriveDraft(cred('webdav'))).toBe(false)
  })

  it('isOAuthCapableDraft：仅 gdrive/onedrive 为 OAuth 可合并草稿', () => {
    expect(isOAuthCapableDraft(blankCred('gdrive'))).toBe(true)
    expect(isOAuthCapableDraft(blankCred('onedrive'))).toBe(true)
    expect(isOAuthCapableDraft(blankCred('webdav'))).toBe(false)
    expect(isOAuthCapableDraft(undefined)).toBe(false)
  })

  it('hasPlaintextUrl：webdav serverUrl / s3 endpoint 非本机 http 命中；本机回环、https、其余后端不命中', () => {
    expect(hasPlaintextUrl({ backend: 'webdav', serverUrl: 'http://dav.example.com', username: '', password: '', objectPath: '' })).toBe(true)
    expect(hasPlaintextUrl({ backend: 'webdav', serverUrl: 'http://localhost:8080', username: '', password: '', objectPath: '' })).toBe(false)
    expect(hasPlaintextUrl({ backend: 'webdav', serverUrl: 'https://dav.example.com', username: '', password: '', objectPath: '' })).toBe(false)
    expect(hasPlaintextUrl({ backend: 's3', region: '', bucket: '', accessKeyId: '', secretAccessKey: '', endpoint: 'http://s3.example.com', prefix: '', sessionToken: '', objectPath: '' })).toBe(true)
    expect(hasPlaintextUrl(blankCred('gist'))).toBe(false)
    expect(hasPlaintextUrl(blankCred('gdrive'))).toBe(false)
  })

  it('intervalOptions/retentionOptions：档位值固定，label 键按卡片 i18n 域拼接', () => {
    expect(intervalOptions(t, 'cloudCard')).toEqual([
      { value: 15, label: '[cloudCard.interval15m]' },
      { value: 60, label: '[cloudCard.interval1h]' },
      { value: 360, label: '[cloudCard.interval6h]' },
      { value: 1440, label: '[cloudCard.intervalDaily]' },
    ])
    expect(retentionOptions(t, 'backupCard')).toEqual([
      { value: 'overwrite', label: '[backupCard.retentionOverwrite]' },
      { value: 'keep', label: '[backupCard.retentionKeep]' },
    ])
  })
})
