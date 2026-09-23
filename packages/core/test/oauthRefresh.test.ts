import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CloudHttpError, isAuthError } from '../src/cloud/backend'
import { __resetOAuthCacheForTest, refreshAccessToken } from '../src/cloud/oauthRefresh'

const GDRIVE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const MS_TOKEN_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token'
const OAUTH = { clientId: 'cid-1', clientSecret: 'sec-1', refreshToken: 'rtok-1' }

function tokenStub(accessToken: string, expiresIn = 3600): ReturnType<typeof vi.fn> {
  return vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    expect(String(url)).toBe(GDRIVE_TOKEN_URL)
    expect(init!.method).toBe('POST')
    expect((init!.headers as Record<string, string>)['Content-Type']).toBe('application/x-www-form-urlencoded')
    const body = new URLSearchParams(String(init!.body))
    expect(body.get('grant_type')).toBe('refresh_token')
    expect(body.get('client_id')).toBe('cid-1')
    expect(body.get('client_secret')).toBe('sec-1')
    expect(body.get('refresh_token')).toBe('rtok-1')
    return new Response(JSON.stringify({ access_token: accessToken, expires_in: expiresIn }), { status: 200 })
  })
}

beforeEach(() => {
  __resetOAuthCacheForTest()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('oauthRefresh：refreshAccessToken', () => {
  it('刷新成功返回 access_token 并写会话缓存：同 credKey 二次调用不再请求 token 端点', async () => {
    const fetchMock = tokenStub('tokA')
    vi.stubGlobal('fetch', fetchMock)
    const cred = { backend: 'gdrive' as const, accessToken: '', oauth: OAUTH }
    expect(await refreshAccessToken(cred)).toBe('tokA')
    expect(await refreshAccessToken(cred)).toBe('tokA')
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('缓存过期边界：expires_in ≤ 60s 视为过期重新刷新；> 60s 复用缓存', async () => {
    // 首刷 expires_in=30（剩余寿命落在 60s 提前量内）→ 缓存即刻视为临期
    const stubA = tokenStub('tokA', 30)
    vi.stubGlobal('fetch', stubA)
    const cred = { backend: 'gdrive' as const, accessToken: '', oauth: OAUTH }
    expect(await refreshAccessToken(cred)).toBe('tokA')
    const stubB = tokenStub('tokB', 3600)
    vi.stubGlobal('fetch', stubB)
    expect(await refreshAccessToken(cred)).toBe('tokB') // 临期 → 重新刷新
    expect(await refreshAccessToken(cred)).toBe('tokB') // 充足寿命 → 复用
    expect(stubA).toHaveBeenCalledOnce() // 首刷
    expect(stubB).toHaveBeenCalledOnce() // 仅临期重刷一次，第三次走缓存
  })

  it('刷新失败：token 端点非 200（invalid_grant）→ 抛结构化 401 语义错误（isAuthError 判真）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })))
    const cred = { backend: 'gdrive' as const, accessToken: '', oauth: OAUTH }
    const err = await refreshAccessToken(cred).then(() => null, (e: unknown) => e)
    expect(err).toBeInstanceOf(CloudHttpError)
    expect((err as CloudHttpError).status).toBe(401)
    expect(isAuthError(err)).toBe(true)
    expect((err as Error).message).toContain('（HTTP 401）')
  })

  it('刷新失败：token 端点 5xx（服务端瞬时故障）→ 抛普通 Error（isAuthError 判假，不触发凭据失效语义）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('upstream error', { status: 503 })))
    const cred = { backend: 'gdrive' as const, accessToken: '', oauth: OAUTH }
    const err = await refreshAccessToken(cred).then(() => null, (e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(CloudHttpError)
    expect(isAuthError(err)).toBe(false)
    expect((err as Error).message).toContain('HTTP 503')
    expect((err as Error).message).not.toContain('（HTTP 401）')
    // 失败不污染缓存：同凭据重刷会再次发起请求
    const fetchMock = tokenStub('tok5xx')
    vi.stubGlobal('fetch', fetchMock)
    expect(await refreshAccessToken(cred)).toBe('tok5xx')
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('刷新失败：200 但响应无 access_token → 同 401 语义（不缓存空 token）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ expires_in: 3600 }), { status: 200 })))
    const cred = { backend: 'gdrive' as const, accessToken: '', oauth: OAUTH }
    const err = await refreshAccessToken(cred).then(() => null, (e: unknown) => e)
    expect(isAuthError(err)).toBe(true)
    // 失败不污染缓存：修复后同凭据重刷会再次发起请求
    const fetchMock = tokenStub('tokC')
    vi.stubGlobal('fetch', fetchMock)
    expect(await refreshAccessToken(cred)).toBe('tokC')
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('token 端点网络失败 → 独立中文错误：非 CloudHttpError（不判凭据失效），文案不附 host/path', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed') }))
    const cred = { backend: 'gdrive' as const, accessToken: '', oauth: OAUTH }
    const err = await refreshAccessToken(cred).then(() => null, (e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect(isAuthError(err)).toBe(false)
    expect((err as Error).message).toContain('OAuth 刷新请求网络失败')
    expect((err as Error).message).not.toContain('oauth2.googleapis.com')
  })

  it('onedrive：token 端点为 login.microsoftonline.com/common/oauth2/v2.0/token，参数同 gdrive', async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe(MS_TOKEN_URL)
      const body = new URLSearchParams(String(init!.body))
      expect(body.get('grant_type')).toBe('refresh_token')
      expect(body.get('client_id')).toBe('cid-1')
      expect(body.get('client_secret')).toBe('sec-1')
      expect(body.get('refresh_token')).toBe('rtok-1')
      return new Response(JSON.stringify({ access_token: 'ms-tok', expires_in: 3600 }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const cred = { backend: 'onedrive' as const, accessToken: '', oauth: OAUTH }
    expect(await refreshAccessToken(cred)).toBe('ms-tok')
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('缺 oauth 配置（编程错误防御）→ 抛普通 Error，不发请求', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const cred = { backend: 'gdrive' as const, accessToken: 'tok' }
    await expect(refreshAccessToken(cred)).rejects.toThrow('OAuth')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('轮转（审查 Important 2）：响应含新 refresh_token → onCredChange 收到合并 cred（新值、不含旧值），原 cred 对象不被改写', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ access_token: 'tokR', refresh_token: 'rtok-2', expires_in: 3600 }),
      { status: 200 },
    )))
    const cred = { backend: 'gdrive' as const, accessToken: 'stale', oauth: { ...OAUTH } }
    const onCredChange = vi.fn()
    expect(await refreshAccessToken(cred, { onCredChange })).toBe('tokR')
    expect(onCredChange).toHaveBeenCalledOnce()
    expect(onCredChange).toHaveBeenCalledWith({
      backend: 'gdrive', accessToken: 'stale',
      oauth: { clientId: 'cid-1', clientSecret: 'sec-1', refreshToken: 'rtok-2' },
    })
    // 上抛凭据不含旧 refresh_token；入参 cred 原对象不被原地改写
    expect(JSON.stringify(onCredChange.mock.calls[0]![0])).not.toContain('rtok-1')
    expect(cred.oauth?.refreshToken).toBe('rtok-1')
  })

  it('轮转：响应 refresh_token 与旧值相同/缺失 → 不触发 onCredChange（Google 不轮转零副作用）', async () => {
    const onCredChange = vi.fn()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ access_token: 'tokR', refresh_token: 'rtok-1', expires_in: 3600 }),
      { status: 200 },
    )))
    await refreshAccessToken({ backend: 'gdrive', accessToken: '', oauth: { ...OAUTH } }, { onCredChange })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ access_token: 'tokS', expires_in: 3600 }),
      { status: 200 },
    )))
    await refreshAccessToken({ backend: 'onedrive', accessToken: '', oauth: { ...OAUTH } }, { onCredChange })
    expect(onCredChange).not.toHaveBeenCalled()
  })

  it('轮转：无 onCredChange 消费方 → 安全丢弃不抛（降级=下轮 401 再刷新）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ access_token: 'tokR', refresh_token: 'rtok-2', expires_in: 3600 }),
      { status: 200 },
    )))
    const cred = { backend: 'onedrive' as const, accessToken: '', oauth: { ...OAUTH } }
    await expect(refreshAccessToken(cred)).resolves.toBe('tokR')
  })

  it('单飞行（审查 Minor 1）：同凭据并发刷新只发一次请求，共享同一结果', async () => {
    let hits = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      hits++
      await new Promise((r) => setTimeout(r, 5)) // 拉开窗口确保第二调用落在首刷在途期
      return new Response(JSON.stringify({ access_token: 'tokF', expires_in: 3600 }), { status: 200 })
    }))
    const cred = { backend: 'gdrive' as const, accessToken: '', oauth: { ...OAUTH } }
    const [a, b] = await Promise.all([refreshAccessToken(cred), refreshAccessToken(cred)])
    expect(a).toBe('tokF')
    expect(b).toBe('tokF')
    expect(hits).toBe(1)
    // 在途完成后，并发窗口关闭：再次调用走缓存仍零请求
    await refreshAccessToken(cred)
    expect(hits).toBe(1)
  })
})
