/** F11：非本机 http 明文凭据保存防护——WebDAV serverUrl / S3 endpoint 输入即显示行内警告，
 *  保存被拦截直至显式勾选「我了解凭据将以明文传输」；确认按保存会话独立（保存成功即复位）。
 *  本机回环 http（localhost/127.0.0.1/[::1]/*.localhost）与 https 不拦截：自建局域网服务是合法场景。 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import type { BackupSource, CloudCred } from '@totp/core'
import { isPlaintextHttpUrl } from '../src/components/cloudPlatform'
import type { CloudPlatform } from '../src/components/cloudPlatform'
import CloudCard from '../src/components/CloudCard.vue'
import { createTestI18n } from './helpers/i18n'

const WEBDAV_CRED: CloudCred = { backend: 'webdav', serverUrl: 'https://dav.example.com', username: 'alice', password: 'davpw' }

const src = (over: Partial<BackupSource> = {}): BackupSource => ({
  id: 's1', kind: 'webdav', name: 'WebDAV', retention: { type: 'overwrite' }, enabled: true, role: 'replica', ...over,
})

function makePlatform(over: Partial<CloudPlatform> = {}): CloudPlatform {
  const base: CloudPlatform = {
    loadSources: vi.fn().mockResolvedValue([]),
    saveSources: vi.fn().mockResolvedValue(undefined),
    saveCred: vi.fn().mockResolvedValue(undefined),
    removeCred: vi.fn().mockResolvedValue(undefined),
    creds: {},
    readVaultJson: vi.fn().mockReturnValue('{"version":2,"entries":[],"tags":[],"updatedAt":0}'),
    persistDownloaded: vi.fn().mockResolvedValue(undefined),
    loadSourceState: vi.fn(async () => ({ lastKnownRemoteRev: null, baseSnapshot: null })),
    saveSourceState: vi.fn(async () => undefined),
    deviceId: vi.fn(async () => 'dev-test'),
    autoPrefs: { get: () => ({ onChange: false, onInterval: false, intervalMinutes: 60 }), set: () => {} },
  }
  return { ...base, ...over }
}

async function mountCard(p: CloudPlatform) {
  const w = mount(CloudCard, { global: { plugins: [createTestI18n()] }, props: { platform: p, sessionSecret: 'pw' } })
  await flushPromises() // onMounted 异步回填 sources/credDrafts
  return w
}

const SERVER_URL = 'input[placeholder="服务器地址（https://dav.example.com）"]'
const ENDPOINT = 'input[placeholder="Endpoint（可选，如 http://localhost:9000）"]'
const ACK = 'input[aria-label="我了解凭据将以明文传输"]'

describe('isPlaintextHttpUrl（F11 scheme 校验）', () => {
  it('仅「http + 非本机主机」为 true；https/本机回环/解析失败均为 false', () => {
    expect(isPlaintextHttpUrl('http://dav.example.com')).toBe(true)
    expect(isPlaintextHttpUrl('http://192.168.1.10:5005/dav')).toBe(true) // 局域网 IP：警告+确认，不静默拒收
    expect(isPlaintextHttpUrl('https://dav.example.com')).toBe(false)
    expect(isPlaintextHttpUrl('http://localhost')).toBe(false)
    expect(isPlaintextHttpUrl('http://LOCALHOST:8080')).toBe(false)
    expect(isPlaintextHttpUrl('http://127.0.0.1:9000')).toBe(false)
    expect(isPlaintextHttpUrl('http://[::1]:9000')).toBe(false)
    expect(isPlaintextHttpUrl('http://nas.localhost')).toBe(false)
    expect(isPlaintextHttpUrl('ftp://dav.example.com')).toBe(false)
    expect(isPlaintextHttpUrl('not a url')).toBe(false)
    expect(isPlaintextHttpUrl('')).toBe(false)
  })
})

describe('CloudCard 非本机 http 明文凭据保存防护（F11）', () => {
  beforeEach(() => vi.clearAllMocks())

  it('P1 WebDAV http 非本机：输入即显示行内警告；未勾选保存被整体拦截，勾选后保存成功且确认复位（再次保存需重新勾选）', async () => {
    const p = makePlatform({ loadSources: vi.fn().mockResolvedValue([src({ id: 'a1' })]), creds: { a1: WEBDAV_CRED } })
    const w = await mountCard(p)
    await w.find('button.target-toggle').trigger('click')
    await w.find(SERVER_URL).setValue('http://dav.example.com')
    expect(w.find('p.warn[role="alert"]').exists()).toBe(true)
    expect(w.text()).toContain('明文传输')
    expect(w.find(ACK).exists()).toBe(true)
    // 未勾选确认：整体拦截（源列表也不落盘），错误走既有 msg 通道
    await w.find('button.creds-save').trigger('click')
    await flushPromises()
    expect(p.saveSources).not.toHaveBeenCalled()
    expect(p.saveCred).not.toHaveBeenCalled()
    expect(w.find('[role="status"]').text()).toContain('明文传输')
    // 勾选确认后保存成功
    await w.find(ACK).setValue(true)
    await w.find('button.creds-save').trigger('click')
    await flushPromises()
    expect(p.saveSources).toHaveBeenCalledTimes(1)
    expect(p.saveCred).toHaveBeenCalledWith('a1', { ...WEBDAV_CRED, serverUrl: 'http://dav.example.com' })
    expect(w.text()).toContain('凭据已保存')
    // per-save-session：确认已复位，再次保存需重新勾选
    expect((w.find(ACK).element as HTMLInputElement).checked).toBe(false)
    await w.find('button.creds-save').trigger('click')
    await flushPromises()
    expect(p.saveSources).toHaveBeenCalledTimes(1)
    expect(p.saveCred).toHaveBeenCalledTimes(1)
  })

  it('P2 本机回环 http 直接保存：localhost/127.0.0.1/[::1]/*.localhost 无警告、无勾选框、不拦截', async () => {
    for (const serverUrl of ['http://localhost:8080/dav', 'http://127.0.0.1:9000', 'http://[::1]:5005', 'http://dav.lan.localhost']) {
      const p = makePlatform({ loadSources: vi.fn().mockResolvedValue([src({ id: 'a1' })]), creds: { a1: { ...WEBDAV_CRED, serverUrl } } })
      const w = await mountCard(p)
      await w.find('button.target-toggle').trigger('click')
      expect(w.find('p.warn[role="alert"]').exists()).toBe(false)
      expect(w.find(ACK).exists()).toBe(false)
      await w.find('button.creds-save').trigger('click')
      await flushPromises()
      expect(p.saveCred).toHaveBeenCalledWith('a1', { ...WEBDAV_CRED, serverUrl })
      w.unmount()
    }
  })

  it('P3 https 直接保存：无警告、无勾选框', async () => {
    const p = makePlatform({ loadSources: vi.fn().mockResolvedValue([src({ id: 'a1' })]), creds: { a1: WEBDAV_CRED } })
    const w = await mountCard(p)
    await w.find('button.target-toggle').trigger('click')
    expect(w.find('p.warn[role="alert"]').exists()).toBe(false)
    expect(w.find(ACK).exists()).toBe(false)
    await w.find('button.creds-save').trigger('click')
    await flushPromises()
    expect(p.saveCred).toHaveBeenCalledWith('a1', WEBDAV_CRED)
    expect(w.text()).toContain('凭据已保存')
  })

  it('P4 S3 endpoint 同口径：非本机 http 拦截至确认后放行；改回本机 http 后直接保存', async () => {
    const p = makePlatform({ loadSources: vi.fn().mockResolvedValue([src({ id: 'a1', kind: 's3', name: 'S3' })]) })
    const w = await mountCard(p)
    await w.find('button.target-toggle').trigger('click')
    await w.find(ENDPOINT).setValue('http://minio.example.com:9000')
    expect(w.find('p.warn[role="alert"]').exists()).toBe(true)
    expect(w.find(ACK).exists()).toBe(true)
    await w.find('button.creds-save').trigger('click')
    await flushPromises()
    expect(p.saveSources).not.toHaveBeenCalled()
    expect(p.saveCred).not.toHaveBeenCalled()
    await w.find(ACK).setValue(true)
    await w.find('button.creds-save').trigger('click')
    await flushPromises()
    expect(p.saveCred).toHaveBeenCalledWith('a1', expect.objectContaining({ backend: 's3', endpoint: 'http://minio.example.com:9000' }))
    // 改回本机 http：警告与确认框消失，可直接保存
    await w.find(ENDPOINT).setValue('http://localhost:9000')
    expect(w.find('p.warn[role="alert"]').exists()).toBe(false)
    expect(w.find(ACK).exists()).toBe(false)
    await w.find('button.creds-save').trigger('click')
    await flushPromises()
    expect(p.saveCred).toHaveBeenCalledWith('a1', expect.objectContaining({ endpoint: 'http://localhost:9000' }))
  })
})
