import type { CloudBackend, S3Cred } from './backend'
import { cloudFetch, ensureHttpOk } from './backend'

const LABEL = 'S3'
/** SHA-256("")——SigV4 空 payload 的规范哈希。 */
export const EMPTY_BODY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function hmacSha256(key: Uint8Array | string, data: string): Promise<Uint8Array> {
  const raw = typeof key === 'string' ? new TextEncoder().encode(key) : key
  const cryptoKey = await crypto.subtle.importKey('raw', raw as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(data))
  return new Uint8Array(mac)
}

/** Date → SigV4 amzDate（YYYYMMDDTHHMMSSZ，UTC）。 */
export function toAmzDate(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
}

/** AWS uri-encode：保留 A-Za-z0-9-_.~，其余按 UTF-8 百分号大写编码；encodeSlash=false 保留 '/'（S3 路径规则）。 */
export function awsUriEncode(str: string, encodeSlash = true): string {
  let out = ''
  for (const ch of str) {
    if (/[A-Za-z0-9_.~-]/.test(ch)) {
      out += ch
    } else if (ch === '/' && !encodeSlash) {
      out += '/'
    } else {
      for (const byte of new TextEncoder().encode(ch)) {
        out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
      }
    }
  }
  return out
}

/** SigV4 规范构造 canonical query string：键值各自 AWS uri-encode 后按编码键名排序，'key=value' 串联。
 *  未提供/空对象 → 空串；value 缺失按空串处理。用于 s3.ts 中查询串参数签名（如 versionId 等未来可选）。 */
export function buildCanonicalQueryString(params?: Record<string, string>): string {
  if (!params) return ''
  return Object.keys(params)
    .sort()
    .map((k) => `${awsUriEncode(k)}=${awsUriEncode(params[k] ?? '')}`)
    .join('&')
}

/**
 * SigV4 第 1 步：canonical request。
 * 头名小写化、按头名排序；同名头多值保持出现顺序以逗号合并（官方 get-header-key-duplicate 向量规则）。
 */
export function sigV4CanonicalRequest(
  method: string,
  canonicalUri: string,
  canonicalQueryString: string,
  headers: ReadonlyArray<readonly [string, string]>,
  payloadHash: string,
): string {
  const merged = new Map<string, string[]>()
  for (const [name, value] of headers) {
    const key = name.toLowerCase()
    const list = merged.get(key) ?? []
    list.push(value.trim().replace(/\s+/g, ' '))
    merged.set(key, list)
  }
  const canonicalHeaders = [...merged.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([name, values]) => `${name}:${values.join(',')}`)
    .join('\n')
  const signedHeaders = [...merged.keys()].sort().join(';')
  return [method, canonicalUri, canonicalQueryString, canonicalHeaders, '', signedHeaders, payloadHash].join('\n')
}

/** SigV4 第 2 步：string to sign（对 canonical request 求 SHA-256）。 */
export async function sigV4StringToSign(amzDate: string, credentialScope: string, canonicalRequest: string): Promise<string> {
  return `AWS4-HMAC-SHA256\n${amzDate}\n${credentialScope}\n${await sha256Hex(canonicalRequest)}`
}

/** SigV4 第 3 步：HMAC 链派生 signing key：kDate → kRegion → kService → kSigning。 */
export async function sigV4SigningKey(
  secretAccessKey: string,
  dateStamp: string,
  region: string,
  service: string,
  terminator = 'aws4_request',
): Promise<Uint8Array> {
  let key = await hmacSha256(`AWS4${secretAccessKey}`, dateStamp)
  key = await hmacSha256(key, region)
  key = await hmacSha256(key, service)
  return hmacSha256(key, terminator)
}

/** SigV4 第 4 步：以 signing key 对 string to sign 求 HMAC，输出小写 hex 签名。 */
export async function sigV4Signature(signingKey: Uint8Array, stringToSign: string): Promise<string> {
  return [...(await hmacSha256(signingKey, stringToSign))].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export interface S3BackendOptions {
  /** 时钟注入（测试确定性签名用）；默认系统时间。 */
  now?: () => Date
}

/**
 * S3 后端（SigV4 头签名，signed payload）。
 * 默认 AWS virtual-host style：https://{bucket}.s3.{region}.amazonaws.com/{key}；
 * 自定义 endpoint（MinIO 等）或 cred.forcePathStyle 强制 path-style：{endpoint|host}/{bucket}/{key}。
 */
export function createS3Backend(cred: S3Cred, opts: S3BackendOptions = {}): CloudBackend {
  const pathStyle = !!cred.endpoint || !!cred.forcePathStyle
  const endpoint = (cred.endpoint ?? `https://${cred.bucket}.s3.${cred.region}.amazonaws.com`).replace(/\/+$/, '')
  const prefix = cred.prefix?.replace(/^\/+|\/+$/g, '')
  const keyOf = (path: string) => {
    const rel = path.replace(/^\/+/, '')
    return prefix ? `${prefix}/${rel}` : rel
  }
  // virtual-host style：https://{bucket}.s3.{region}.amazonaws.com/{key}；path-style：{endpoint}/{bucket}/{key}
  const urlOf = (path: string) => `${endpoint}${pathStyle ? `/${cred.bucket}` : ''}/${awsUriEncode(keyOf(path), false)}`

  const signedHeadersOf = async (method: string, url: string, body: Uint8Array | undefined) => {
    const amzDate = toAmzDate((opts.now ?? (() => new Date()))())
    const payloadHash = await sha256Hex(body ?? '')
    // STS 临时凭据：x-amz-security-token 必须参与签名（SigV4 规范）。仅当 cred.sessionToken 有值时附加。
    const baseHeaders: Array<[string, string]> = [
      ['host', new URL(url).host],
      ['x-amz-content-sha256', payloadHash],
      ['x-amz-date', amzDate],
    ]
    if (cred.sessionToken) baseHeaders.push(['x-amz-security-token', cred.sessionToken])
    const canonicalRequest = sigV4CanonicalRequest(
      method,
      new URL(url).pathname,
      buildCanonicalQueryString(), // 当前无 query string，留接口位
      baseHeaders,
      payloadHash,
    )
    const dateStamp = amzDate.slice(0, 8)
    const scope = `${dateStamp}/${cred.region}/s3/aws4_request`
    const stringToSign = await sigV4StringToSign(amzDate, scope, canonicalRequest)
    const signingKey = await sigV4SigningKey(cred.secretAccessKey, dateStamp, cred.region, 's3')
    const signature = await sigV4Signature(signingKey, stringToSign)
    const signedHeaderNames = baseHeaders.map(([n]) => n.toLowerCase()).sort().join(';')
    const out: Record<string, string> = {
      Authorization: `AWS4-HMAC-SHA256 Credential=${cred.accessKeyId}/${scope}, SignedHeaders=${signedHeaderNames}, Signature=${signature}`,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
    }
    if (cred.sessionToken) out['x-amz-security-token'] = cred.sessionToken
    return out
  }

  return {
    id: 's3',
    async put(path, data) {
      const res = await cloudFetch(LABEL, urlOf(path), {
        method: 'PUT',
        headers: await signedHeadersOf('PUT', urlOf(path), new Uint8Array(data)),
        body: new Uint8Array(data),
      })
      ensureHttpOk(LABEL, res)
    },
    async get(path) {
      const res = await cloudFetch(LABEL, urlOf(path), { method: 'GET', headers: await signedHeadersOf('GET', urlOf(path), undefined) })
      if (res.status === 404) return null
      ensureHttpOk(LABEL, res)
      return new Uint8Array(await res.arrayBuffer())
    },
    async delete(path) {
      const res = await cloudFetch(LABEL, urlOf(path), { method: 'DELETE', headers: await signedHeadersOf('DELETE', urlOf(path), undefined) })
      ensureHttpOk(LABEL, res)
    },
    async exists(path) {
      const res = await cloudFetch(LABEL, urlOf(path), { method: 'HEAD', headers: await signedHeadersOf('HEAD', urlOf(path), undefined) })
      if (res.status === 404) return false
      ensureHttpOk(LABEL, res)
      return res.ok
    },
  }
}
