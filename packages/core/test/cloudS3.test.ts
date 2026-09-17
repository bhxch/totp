import { createHash, createHmac } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  awsUriEncode,
  buildCanonicalQueryString,
  createS3Backend,
  sigV4CanonicalRequest,
  sigV4Signature,
  sigV4SigningKey,
  sigV4StringToSign,
} from '../src/cloud/s3'

const PATH = 'totp-backup.totpbackup'
const AKID = 'AKIDEXAMPLE'
const SECRET = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY'
// SHA-256("")——AWS 官方测试向量中的空 payload 哈希
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
// 官方套件上下文：date=20150830 region=us-east-1 service=service（占位符字面量）
const SCOPE = '20150830/us-east-1/service/aws4_request'

afterEach(() => {
  vi.unstubAllGlobals()
})

/**
 * 用 node:crypto 按 AWS SigV4 官方步骤独立复算 Authorization 头，
 * 与被测实现完全独立，用于端到端逐字锚定。
 */
function expectedS3Authorization(
  method: string,
  url: string,
  body: Uint8Array | undefined,
  cred: { accessKeyId: string; secretAccessKey: string; region: string },
  canonicalQuery = '',
): string {
  const payloadHash = createHash('sha256').update(body ?? new Uint8Array()).digest('hex')
  const u = new URL(url)
  const amzDate = '20150830T123600Z'
  const canonical = [
    method,
    u.pathname,
    canonicalQuery,
    `host:${u.host}`,
    `x-amz-content-sha256:${payloadHash}`,
    `x-amz-date:${amzDate}`,
    '',
    'host;x-amz-content-sha256;x-amz-date',
    payloadHash,
  ].join('\n')
  const scope = `20150830/${cred.region}/s3/aws4_request`
  const sts = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${createHash('sha256').update(canonical).digest('hex')}`
  let key = createHmac('sha256', `AWS4${cred.secretAccessKey}`).update('20150830').digest()
  key = createHmac('sha256', key).update(cred.region).digest()
  key = createHmac('sha256', key).update('s3').digest()
  key = createHmac('sha256', key).update('aws4_request').digest()
  const signature = createHmac('sha256', key).update(sts).digest('hex')
  return `AWS4-HMAC-SHA256 Credential=${cred.accessKeyId}/${scope}, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=${signature}`
}

describe('SigV4 核心步骤（AWS aws-sig-v4-test-suite 官方向量锚定）', () => {
  it('get-vanilla：canonical request 与官方向量逐字一致', () => {
    const creq = sigV4CanonicalRequest(
      'GET',
      '/',
      '',
      [
        ['host', 'example.amazonaws.com'],
        ['x-amz-date', '20150830T123600Z'],
      ],
      EMPTY_SHA256,
    )
    expect(creq).toBe(
      [
        'GET',
        '/',
        '',
        'host:example.amazonaws.com',
        'x-amz-date:20150830T123600Z',
        '',
        'host;x-amz-date',
        EMPTY_SHA256,
      ].join('\n'),
    )
  })

  it('get-vanilla：string to sign 与 signature 匹配官方值 5fa00fa3…', async () => {
    const creq = sigV4CanonicalRequest(
      'GET',
      '/',
      '',
      [
        ['host', 'example.amazonaws.com'],
        ['x-amz-date', '20150830T123600Z'],
      ],
      EMPTY_SHA256,
    )
    const sts = await sigV4StringToSign('20150830T123600Z', SCOPE, creq)
    expect(sts).toBe(
      `AWS4-HMAC-SHA256\n20150830T123600Z\n${SCOPE}\nbb579772317eb040ac9ed261061d46c1f17a8133879d6129b6e1c25292927e63`,
    )
    const key = await sigV4SigningKey(SECRET, '20150830', 'us-east-1', 'service')
    expect(await sigV4Signature(key, sts)).toBe(
      '5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
    )
  })

  it('get-header-key-duplicate：重复头保持出现顺序合并，signature 匹配官方值 c9d5ea9f…', async () => {
    const creq = sigV4CanonicalRequest(
      'GET',
      '/',
      '',
      [
        ['host', 'example.amazonaws.com'],
        ['my-header1', 'value2'],
        ['my-header1', 'value2'],
        ['my-header1', 'value1'],
        ['x-amz-date', '20150830T123600Z'],
      ],
      EMPTY_SHA256,
    )
    expect(creq).toBe(
      [
        'GET',
        '/',
        '',
        'host:example.amazonaws.com',
        'my-header1:value2,value2,value1',
        'x-amz-date:20150830T123600Z',
        '',
        'host;my-header1;x-amz-date',
        EMPTY_SHA256,
      ].join('\n'),
    )
    const sts = await sigV4StringToSign('20150830T123600Z', SCOPE, creq)
    expect(sts).toBe(
      `AWS4-HMAC-SHA256\n20150830T123600Z\n${SCOPE}\ndc7f04a3abfde8d472b0ab1a418b741b7c67174dad1551b4117b15527fbe966c`,
    )
    const key = await sigV4SigningKey(SECRET, '20150830', 'us-east-1', 'service')
    expect(await sigV4Signature(key, sts)).toBe(
      'c9d5ea9f3f72853aea855b47ea873832890dbdd183b4468f858259531a5138ea',
    )
  })

  it('awsUriEncode：保留 unreserved 字符与路径斜杠，其余 UTF-8 百分号大写编码', () => {
    expect(awsUriEncode('a b/c+d~e-f_g.h', false)).toBe('a%20b/c%2Bd~e-f_g.h')
    expect(awsUriEncode('a/b', true)).toBe('a%2Fb')
  })
  it('M15：awsUriEncode 多字节 UTF-8（中文/Emoji）按字节百分号大写编码；+/space/斜杠按 RFC 3986 编码', () => {
    // 中文 '中文' UTF-8: E4 B8 AD E6 96 87
    expect(awsUriEncode('中文', true)).toBe('%E4%B8%AD%E6%96%87')
    // Emoji '🚀' (U+1F680) UTF-8: F0 9F 9A 80
    expect(awsUriEncode('🚀', true)).toBe('%F0%9F%9A%80')
    // 混合：中文/斜杠/Emoji → 中文 + %2F + Emoji
    expect(awsUriEncode('中文/🚀', true)).toBe('%E4%B8%AD%E6%96%87%2F%F0%9F%9A%80')
    expect(awsUriEncode('中文/🚀', false)).toBe('%E4%B8%AD%E6%96%87/%F0%9F%9A%80') // 保留斜杠
    // '+' 必须编码为 %2B（不能解为空格——S3 query string 语义）
    expect(awsUriEncode('+', true)).toBe('%2B')
    expect(awsUriEncode('a+b', true)).toBe('a%2Bb')
    // 空格编码为 %20（不是 +，那是 application/x-www-form-urlencoded 语义）
    expect(awsUriEncode(' ', true)).toBe('%20')
    expect(awsUriEncode('a b', true)).toBe('a%20b')
    // '/' 默认编码为 %2F；encodeSlash=false 时保留
    expect(awsUriEncode('/', true)).toBe('%2F')
    expect(awsUriEncode('/', false)).toBe('/')
    expect(awsUriEncode('a/b/c', true)).toBe('a%2Fb%2Fc')
    expect(awsUriEncode('a/b/c', false)).toBe('a/b/c')
    // unreserved 字符原样保留
    expect(awsUriEncode('A-Za-z0-9-_.~', true)).toBe('A-Za-z0-9-_.~')
    // 复合：中文 + 保留字符 + 特殊字符
    expect(awsUriEncode('备份-2026/backups_中文+🚀.json', false))
      .toBe('%E5%A4%87%E4%BB%BD-2026/backups_%E4%B8%AD%E6%96%87%2B%F0%9F%9A%80.json')
  })
  it('buildCanonicalQueryString：键值各自 AWS uri-encode，按编码键名升序连接；空对象/缺省 → 空串', () => {
    expect(buildCanonicalQueryString()).toBe('')
    expect(buildCanonicalQueryString({})).toBe('')
    // 单参数：encoding + raw value
    expect(buildCanonicalQueryString({ 'versionId': 'v1' })).toBe('versionId=v1')
    // 排序：编码后 b 在 a 前（百分号 < 字母），实测按编码键名升序
    expect(buildCanonicalQueryString({ 'a': '1', 'b': '2' })).toBe('a=1&b=2')
    // 值也需编码：空格、空值都参与
    expect(buildCanonicalQueryString({ 'a': 'a b', 'c': '' })).toBe('a=a%20b&c=')
  })
})

describe('S3 后端（默认 AWS endpoint，virtual-host style）', () => {
  const CRED = {
    backend: 's3' as const,
    region: 'us-east-1',
    bucket: 'mybucket',
    accessKeyId: AKID,
    secretAccessKey: SECRET,
  }
  const URL_OF = (p: string) => `https://mybucket.s3.us-east-1.amazonaws.com/${p}`
  // 时钟注入：固定到官方套件同一时刻，签名可确定性复算
  const OPTS = { now: () => new Date('2015-08-30T12:36:00Z') }

  it('put：SigV4 Authorization 头与独立复算值逐字一致，含 x-amz-date/x-amz-content-sha256', async () => {
    const fetchMock = vi.fn(async (_u: RequestInfo | URL, _i?: RequestInit) => new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const backend = createS3Backend(CRED, OPTS)
    const body = new TextEncoder().encode('hello')
    await backend.put(PATH, body)
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe(URL_OF(PATH))
    expect(init!.method).toBe('PUT')
    const headers = init!.headers as Record<string, string>
    expect(headers['x-amz-date']).toBe('20150830T123600Z')
    expect(headers['x-amz-content-sha256']).toBe(createHash('sha256').update(body).digest('hex'))
    expect(headers.Authorization).toBe(expectedS3Authorization('PUT', URL_OF(PATH), body, CRED))
  })

  it('put：时间注入生效——两次调用签名确定一致', async () => {
    const backend = createS3Backend(CRED, OPTS)
    const bodies: RequestInit[] = []
    const fetchMock = vi.fn(async (_u: RequestInfo | URL, i?: RequestInit) => {
      bodies.push(i!)
      return new Response(null, { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const body = new TextEncoder().encode('data')
    await backend.put(PATH, body)
    await backend.put(PATH, body)
    const authOf = (i: RequestInit) => (i.headers as Record<string, string>).Authorization
    expect(authOf(bodies[0]!)).toBe(authOf(bodies[1]!))
  })

  it('get：200 返回字节（GET 请求签名正确），404 返回 null', async () => {
    const bytes = new Uint8Array([1, 2, 3])
    const fetchMock = vi.fn(async (_u: RequestInfo | URL, _i?: RequestInit) => new Response(bytes, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const backend = createS3Backend(CRED, OPTS)
    expect(await backend.get(PATH)).toEqual(bytes)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe(URL_OF(PATH))
    expect(init!.method).toBe('GET')
    expect((init!.headers as Record<string, string>).Authorization).toBe(expectedS3Authorization('GET', URL_OF(PATH), undefined, CRED))

    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 404 })))
    expect(await backend.get(PATH)).toBeNull()
  })

  it('delete：DELETE 请求签名正确，非 2xx 抛中文错误', async () => {
    const fetchMock = vi.fn(async (_u: RequestInfo | URL, _i?: RequestInit) => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)
    const backend = createS3Backend(CRED, OPTS)
    await backend.delete(PATH)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe(URL_OF(PATH))
    expect(init!.method).toBe('DELETE')
    expect((init!.headers as Record<string, string>).Authorization).toBe(expectedS3Authorization('DELETE', URL_OF(PATH), undefined, CRED))

    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 403 })))
    await expect(backend.delete(PATH)).rejects.toThrow('S3 请求失败（HTTP 403）')
  })

  it('exists：HEAD 200 → true，404 → false', async () => {
    const backend = createS3Backend(CRED, OPTS)
    const fetchMock = vi.fn(async (_u: RequestInfo | URL, i?: RequestInit) => {
      expect(i!.method).toBe('HEAD')
      return new Response(null, { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    expect(await backend.exists(PATH)).toBe(true)
    expect((fetchMock.mock.calls[0]![1]!.headers as Record<string, string>).Authorization).toBe(
      expectedS3Authorization('HEAD', URL_OF(PATH), undefined, CRED),
    )
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 404 })))
    expect(await backend.exists(PATH)).toBe(false)
  })

  it('get：网络失败抛中文错误', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed') }))
    const backend = createS3Backend(CRED, OPTS)
    await expect(backend.get(PATH)).rejects.toThrow('S3 网络请求失败：fetch failed')
  })

  it('listBackups：ListObjectsV2 prefix=对象目录/，Key 末段过滤 BACKUP_NAME_RE；query 参与签名', async () => {
    const cred = { ...CRED, objectPath: 'dir/sub/totp-backup.totpbackup' }
    const xml = `<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
<Contents><Key>dir/sub/vault-20260101-000000.totpbackup</Key></Contents>
<Contents><Key>dir/sub/vault-20260202-000000.totpbackup</Key></Contents>
<Contents><Key>dir/sub/vault-backup.totpbackup</Key></Contents>
<Contents><Key>dir/sub/conflict-webdav-20260101-000000.totpbackup</Key></Contents>
<Contents><Key>dir/sub/notes.txt</Key></Contents>
</ListBucketResult>`
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = new URL(String(url))
      expect(u.origin + u.pathname).toBe('https://mybucket.s3.us-east-1.amazonaws.com/')
      expect(u.searchParams.get('list-type')).toBe('2')
      expect(u.searchParams.get('prefix')).toBe('dir/sub/')
      expect(init!.method).toBe('GET')
      return new Response(xml, { status: 200, headers: { 'Content-Type': 'application/xml' } })
    })
    vi.stubGlobal('fetch', fetchMock)
    const backend = createS3Backend(cred, OPTS)
    // 返回与 put/get/delete 同 key 域的完整 key（prefix+dir+name）——子目录 cred 下裸名会删 404
    expect(await backend.listBackups!()).toEqual(['dir/sub/vault-20260101-000000.totpbackup', 'dir/sub/vault-20260202-000000.totpbackup'])
    // canonical query（编码后按键名排序）必须参与签名，否则 AWS 会以 SignatureDoesNotMatch 拒绝
    const canonicalQuery = 'list-type=2&prefix=dir%2Fsub%2F'
    const listUrl = `https://mybucket.s3.us-east-1.amazonaws.com/?${canonicalQuery}`
    expect((fetchMock.mock.calls[0]![1]!.headers as Record<string, string>).Authorization).toBe(
      expectedS3Authorization('GET', listUrl, undefined, cred, canonicalQuery),
    )
  })

  it('listBackups：cred.prefix 仅作服务端 list 前缀，返回值为 dir/name（prefix 由 delete 的 keyOf 拼回）', async () => {
    const cred = { ...CRED, prefix: 'backups', objectPath: 'dir/totp-backup.totpbackup' }
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      const u = new URL(String(url))
      expect(u.searchParams.get('prefix')).toBe('backups/dir/')
      return new Response('<ListBucketResult><Contents><Key>backups/dir/vault-20260101-000000.totpbackup</Key></Contents></ListBucketResult>', { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const backend = createS3Backend(cred, OPTS)
    expect(await backend.listBackups!()).toEqual(['dir/vault-20260101-000000.totpbackup'])
  })

  it('listBackups：非 2xx 抛中文错误', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 403 })))
    const backend = createS3Backend(CRED, OPTS)
    await expect(backend.listBackups!()).rejects.toThrow('S3 请求失败（HTTP 403）')
  })
  it('网络层 TypeError 命中 CORS 模式时追加「请检查服务端 CORS 配置」中文提示（自建 WebDAV/MinIO 场景）', async () => {
    const cases: Array<[string, string]> = [
      ['fetch failed', '请检查服务端 CORS 配置'],
      ['NetworkError when attempting to fetch resource.', '请检查服务端 CORS 配置'],
    ]
    for (const [reason, expected] of cases) {
      vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError(reason) }))
      const backend = createS3Backend(CRED, OPTS)
      await expect(backend.get(PATH)).rejects.toThrow(expected)
    }
    // 其他 TypeError 不应误加提示
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('其他错误') }))
    const ok = createS3Backend(CRED, OPTS)
    await expect(ok.get(PATH)).rejects.toThrow('S3 网络请求失败：其他错误')
    await expect(ok.get(PATH)).rejects.not.toThrow('CORS')
  })

  it('M18：网络失败错误附 host+pathname，不附 query（防 token 泄漏）', async () => {
    // 通过 cloudFetch 直接测试错误信息形态，避免依赖后端具体 URL 拼接
    const { cloudFetch } = await import('../src/cloud/backend')
    const url = 'https://s3.example.com/mybucket/totp-backup.totpbackup?X-Amz-Signature=secret&X-Amz-Credential=AKID'
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed') }))
    let caught: Error | null = null
    try {
      await cloudFetch('S3', url)
    } catch (e) {
      caught = e as Error
    }
    expect(caught).not.toBeNull()
    expect(caught!.message).toContain('s3.example.com')
    expect(caught!.message).toContain('/mybucket/totp-backup.totpbackup')
    // 关键：query string（含签名/凭据）不得出现在错误信息中
    expect(caught!.message).not.toContain('X-Amz-Signature')
    expect(caught!.message).not.toContain('X-Amz-Credential')
    expect(caught!.message).not.toContain('secret')
  })
})

describe('S3 后端（自定义 endpoint 兼容 MinIO，path-style）', () => {
  const CRED = {
    backend: 's3' as const,
    region: 'us-east-1',
    bucket: 'mybucket',
    accessKeyId: AKID,
    secretAccessKey: SECRET,
    endpoint: 'http://localhost:9000/',
  }
  const OPTS = { now: () => new Date('2015-08-30T12:36:00Z') }

  it('put：URL 为 {endpoint}/{bucket}/{key}，签名 host 含端口', async () => {
    const fetchMock = vi.fn(async (_u: RequestInfo | URL, _i?: RequestInit) => new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const backend = createS3Backend(CRED, OPTS)
    const body = new TextEncoder().encode('hello')
    await backend.put(PATH, body)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe(`http://localhost:9000/mybucket/${PATH}`)
    const headers = init!.headers as Record<string, string>
    expect(headers.Authorization).toBe(expectedS3Authorization('PUT', `http://localhost:9000/mybucket/${PATH}`, body, CRED))
  })

  it('prefix：key 前缀拼接为 {prefix}/{path}，首尾斜杠归一', async () => {
    const fetchMock = vi.fn(async (_u: RequestInfo | URL, _i?: RequestInit) => new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const backend = createS3Backend({ ...CRED, prefix: '/backups/sub/' }, OPTS)
    await backend.put(PATH, new TextEncoder().encode('x'))
    expect(fetchMock.mock.calls[0]![0]).toBe(`http://localhost:9000/mybucket/backups/sub/${PATH}`)
  })
})

describe('S3 后端（AWS 老 bucket forcePathStyle；STS sessionToken）', () => {
  const CRED = {
    backend: 's3' as const,
    region: 'us-east-1',
    bucket: 'mybucket',
    accessKeyId: AKID,
    secretAccessKey: SECRET,
  }
  const URL_OF = (p: string) => `https://mybucket.s3.us-east-1.amazonaws.com/${p}`
  const OPTS = { now: () => new Date('2015-08-30T12:36:00Z') }

  it('forcePathStyle=true：URL 改为 path-style 且签名 host 为 bucket.s3.region.amazonaws.com', async () => {
    const fetchMock = vi.fn(async (_u: RequestInfo | URL, _i?: RequestInit) => new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const backend = createS3Backend({ ...CRED, forcePathStyle: true }, OPTS)
    const body = new TextEncoder().encode('x')
    await backend.put(PATH, body)
    const [url, init] = fetchMock.mock.calls[0]!
    // AWS 默认 endpoint：https://{bucket}.s3.{region}.amazonaws.com  + 路径前缀 /{bucket}/
    const expectedUrl = `https://mybucket.s3.us-east-1.amazonaws.com/mybucket/${PATH}`
    expect(url).toBe(expectedUrl)
    expect((init!.headers as Record<string, string>).Authorization).toBe(expectedS3Authorization('PUT', expectedUrl, body, CRED))
  })

  it('sessionToken：x-amz-security-token 加入 canonical/signed headers 与 Authorization', async () => {
    const fetchMock = vi.fn(async (_u: RequestInfo | URL, _i?: RequestInit) => new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const sessionToken = 'FQoGZXIvYXdzEPL//////////wEaDExampleToken'
    const backend = createS3Backend({ ...CRED, sessionToken }, OPTS)
    const body = new TextEncoder().encode('hello')
    await backend.put(PATH, body)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe(URL_OF(PATH))
    const headers = init!.headers as Record<string, string>
    expect(headers['x-amz-security-token']).toBe(sessionToken)
    // 独立复算含 token 的 Authorization
    expect(headers.Authorization).toBe(expectedS3AuthorizationWithToken('PUT', URL_OF(PATH), body, CRED, sessionToken))
  })
})

/** SigV4 独立复算 helper（带 x-amz-security-token） */
function expectedS3AuthorizationWithToken(
  method: string,
  url: string,
  body: Uint8Array | undefined,
  cred: { accessKeyId: string; secretAccessKey: string; region: string },
  sessionToken: string,
): string {
  const payloadHash = createHash('sha256').update(body ?? new Uint8Array()).digest('hex')
  const u = new URL(url)
  const amzDate = '20150830T123600Z'
  const canonical = [
    method,
    u.pathname,
    '',
    `host:${u.host}`,
    `x-amz-content-sha256:${payloadHash}`,
    `x-amz-date:${amzDate}`,
    `x-amz-security-token:${sessionToken}`,
    '',
    'host;x-amz-content-sha256;x-amz-date;x-amz-security-token',
    payloadHash,
  ].join('\n')
  const scope = `20150830/${cred.region}/s3/aws4_request`
  const sts = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${createHash('sha256').update(canonical).digest('hex')}`
  let key = createHmac('sha256', `AWS4${cred.secretAccessKey}`).update('20150830').digest()
  key = createHmac('sha256', key).update(cred.region).digest()
  key = createHmac('sha256', key).update('s3').digest()
  key = createHmac('sha256', key).update('aws4_request').digest()
  const signature = createHmac('sha256', key).update(sts).digest('hex')
  return `AWS4-HMAC-SHA256 Credential=${cred.accessKeyId}/${scope}, SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token, Signature=${signature}`
}
