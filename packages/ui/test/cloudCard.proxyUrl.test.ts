/** 云-I2：自定义代理地址保存前校验——custom 模式空地址/非法 scheme 落库后该源每个请求才在
 *  桌面 reqwest 侧失败（「custom 代理缺 url」/「代理地址无效」），前端在字段区就地标错
 *  （warn role=alert，同路径预览错误模式）并整体拦截保存；合法地址（http/https/socks5/socks5h）
 *  与 none/system 模式不受影响。 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import type { BackupSource, CloudCred } from '@totp/core'
import { customProxyUrlError } from '../src/components/cardShared'
import type { CloudPlatform } from '../src/components/cloudPlatform'
import CloudCard from '../src/components/CloudCard.vue'
import CloudCredFields from '../src/components/CloudCredFields.vue'
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

const PROXY_URL_INPUT = 'input[aria-label="代理地址"]'

describe('customProxyUrlError（云-I2 scheme/空值校验）', () => {
  it('非 custom 模式恒通过（含 undefined 与空串 url）', () => {
    expect(customProxyUrlError(undefined)).toBeNull()
    expect(customProxyUrlError({ mode: 'none' })).toBeNull()
    expect(customProxyUrlError({ mode: 'system', url: '' })).toBeNull()
  })
  it('custom 空地址（空串/undefined/纯空白）→ empty', () => {
    expect(customProxyUrlError({ mode: 'custom' })).toBe('empty')
    expect(customProxyUrlError({ mode: 'custom', url: '' })).toBe('empty')
    expect(customProxyUrlError({ mode: 'custom', url: '   ' })).toBe('empty')
  })
  it('custom 非法 scheme 或无 host → invalid', () => {
    expect(customProxyUrlError({ mode: 'custom', url: 'ftp://127.0.0.1:7890' })).toBe('invalid')
    expect(customProxyUrlError({ mode: 'custom', url: 'socks4://127.0.0.1:7890' })).toBe('invalid')
    // 非特殊 scheme（socks5）单斜杠无 host：new URL 可解析但 hostname 为空，reqwest 解析必失败
    expect(customProxyUrlError({ mode: 'custom', url: 'socks5:/x' })).toBe('invalid')
    expect(customProxyUrlError({ mode: 'custom', url: 'not a url' })).toBe('invalid')
  })
  it('custom 合法地址（四种 scheme、含带端口/路径）→ null', () => {
    expect(customProxyUrlError({ mode: 'custom', url: 'http://127.0.0.1:7890' })).toBeNull()
    expect(customProxyUrlError({ mode: 'custom', url: 'https://proxy.example.com' })).toBeNull()
    expect(customProxyUrlError({ mode: 'custom', url: 'socks5://127.0.0.1:7890' })).toBeNull()
    expect(customProxyUrlError({ mode: 'custom', url: 'socks5h://user:p@127.0.0.1:1080' })).toBeNull()
  })
})

describe('CloudCredFields 代理地址就地标错（云-I2）', () => {
  const mountP = (draft: CloudCred | undefined, proxySupport: boolean) =>
    mount(CloudCredFields, { global: { plugins: [createTestI18n()] }, props: { draft, busy: false, retention: { type: 'overwrite' }, proxySupport } })

  it('切 custom 且无已存 url：暂存空串判据（url 为空串），显示空地址错误行', async () => {
    const draft: CloudCred = { ...WEBDAV_CRED }
    const w = mountP(draft, true)
    await w.find('.proxy-mode button:nth-child(3)').trigger('click')
    await flushPromises()
    expect(draft.proxy).toEqual({ mode: 'custom', url: '' })
    expect(w.find('.proxy-url-error[role="alert"]').exists()).toBe(true)
    expect(w.text()).toContain('代理地址为空')
  })
  it('填非法 scheme 显示格式错误；改合法地址后错误行消失', async () => {
    const draft: CloudCred = { ...WEBDAV_CRED }
    const w = mountP(draft, true)
    await w.find('.proxy-mode button:nth-child(3)').trigger('click')
    await w.find(PROXY_URL_INPUT).setValue('ftp://127.0.0.1:7890')
    expect(w.find('.proxy-url-error[role="alert"]').exists()).toBe(true)
    expect(w.text()).toContain('代理地址格式无效')
    await w.find(PROXY_URL_INPUT).setValue('socks5h://127.0.0.1:7890')
    expect(w.find('.proxy-url-error').exists()).toBe(false)
    expect(draft.proxy).toEqual({ mode: 'custom', url: 'socks5h://127.0.0.1:7890' })
  })
  it('none/system 模式无错误行', async () => {
    const draft: CloudCred = { ...WEBDAV_CRED }
    const w = mountP(draft, true)
    await w.find('.proxy-mode button:nth-child(2)').trigger('click') // 系统代理
    await flushPromises()
    expect(w.find('.proxy-url-error').exists()).toBe(false)
  })
})

describe('CloudCard 自定义代理地址保存拦截（云-I2）', () => {
  beforeEach(() => vi.clearAllMocks())

  it('custom 空 url：保存整体拦截（不落盘任何内容），错误走既有 msg 通道；修正后保存通过', async () => {
    const p = makePlatform({
      proxySupport: true,
      loadSources: vi.fn().mockResolvedValue([src({ id: 'a1' })]),
      creds: { a1: WEBDAV_CRED },
    })
    const w = await mountCard(p)
    await w.find('button.target-toggle').trigger('click')
    await w.find('.proxy-mode button:nth-child(3)').trigger('click') // 切自定义（无已存 url → 空串）
    await flushPromises()
    expect(w.find('.proxy-url-error[role="alert"]').exists()).toBe(true)
    await w.find('button.creds-save').trigger('click')
    await flushPromises()
    expect(p.saveSources).not.toHaveBeenCalled()
    expect(p.saveCred).not.toHaveBeenCalled()
    expect(w.find('[role="status"]').text()).toContain('自定义代理地址')
    // 修正为合法地址：错误行消失，保存放行且 proxy 随凭据落库
    await w.find(PROXY_URL_INPUT).setValue('socks5h://127.0.0.1:7890')
    expect(w.find('.proxy-url-error').exists()).toBe(false)
    await w.find('button.creds-save').trigger('click')
    await flushPromises()
    expect(p.saveCred).toHaveBeenCalledWith('a1', expect.objectContaining({ proxy: { mode: 'custom', url: 'socks5h://127.0.0.1:7890' } }))
    expect(w.text()).toContain('凭据已保存')
  })
})
