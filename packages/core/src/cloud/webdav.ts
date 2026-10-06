import type { CloudBackend, WebdavCred } from './backend'
import { cloudFetch, ensureHttpOk, proxyOf } from './backend'
import { BACKUP_NAME_RE } from '../backup/policy'
import { resolveDirPath } from './targetPath'

const LABEL = 'WebDAV'

/** serverUrl 尾斜杠归一 + path 去开头斜杠后拼接。 */
export function joinDavUrl(serverUrl: string, path: string): string {
  const base = serverUrl.replace(/\/+$/, '')
  const rel = path.replace(/^\/+/, '')
  return `${base}/${rel}`
}

/** href 可能是百分号编码（空格等），解码失败（非法 % 序列）按原文匹配 */
function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

/** 解 multistatus 中任意命名空间前缀的 <href>，取路径末段非空段 */
function hrefNames(xml: string): string[] {
  const out: string[] = []
  for (const m of xml.matchAll(/<(?:[\w.-]+:)?href(?:\s[^>]*)?>([^<]*)<\/(?:[\w.-]+:)?href\s*>/gi)) {
    const segments = safeDecode(m[1]!).split('/').filter((s) => s !== '')
    if (segments.length > 0) out.push(segments[segments.length - 1]!)
  }
  return out
}

export function createWebdavBackend(cred: WebdavCred): CloudBackend {
  const auth = `Basic ${btoa(`${cred.username}:${cred.password}`)}`
  const urlOf = (path: string) => joinDavUrl(cred.serverUrl, path)

  /** push 前逐级确保父目录存在（spec §4.2 404 根修）：按段累积 MKCOL；2xx 成功、
   *  405=集合已存在容忍（RFC 4918），其余状态经 ensureHttpOk 抛错（401/403 凭据问题
   *  原地暴露不做目录重试）。每次 put 全量执行无缓存：push 低频开销可忽略换无状态幂等。
   *  dir 为空（根目录对象）直接返回。 */
  async function ensureDavDir(dir: string): Promise<void> {
    if (dir === '') return
    const proxy = proxyOf(cred)
    let acc = ''
    for (const seg of dir.split('/')) {
      acc = acc ? `${acc}/${seg}` : seg
      const res = await cloudFetch(LABEL, urlOf(acc), { method: 'MKCOL', headers: { Authorization: auth } }, proxy)
      if (res.status === 405) continue
      await ensureHttpOk(LABEL, res, 'MKCOL')
    }
  }

  return {
    id: 'webdav',
    async put(path, data) {
      await ensureDavDir(resolveDirPath(cred))
      const res = await cloudFetch(LABEL, urlOf(path), {
        method: 'PUT',
        headers: { Authorization: auth },
        body: new Uint8Array(data),
      }, proxyOf(cred))
      await ensureHttpOk(LABEL, res, 'PUT')
    },
    async get(path) {
      const res = await cloudFetch(LABEL, urlOf(path), { method: 'GET', headers: { Authorization: auth } }, proxyOf(cred))
      if (res.status === 404) return null
      await ensureHttpOk(LABEL, res, 'GET')
      return new Uint8Array(await res.arrayBuffer())
    },
    async delete(path) {
      const res = await cloudFetch(LABEL, urlOf(path), { method: 'DELETE', headers: { Authorization: auth } }, proxyOf(cred))
      await ensureHttpOk(LABEL, res, 'DELETE')
    },
    async exists(path) {
      const res = await cloudFetch(LABEL, urlOf(path), { method: 'GET', headers: { Authorization: auth } }, proxyOf(cred))
      if (res.status === 404) return false
      await ensureHttpOk(LABEL, res, 'GET')
      return res.ok
    },
    async listBackups() {
      // keep-n（设计 §3）：PROPFIND 对象父目录 Depth:1，列同目录 vault-{ts} 名（207 Multi-Status 属 2xx）。
      // 返回与 put/get/delete 同域的完整路径（dir/name）——子目录 cred 下裸名会删错层 404。
      const dir = resolveDirPath(cred)
      const res = await cloudFetch(LABEL, urlOf(dir ? `${dir}/` : ''), {
        method: 'PROPFIND',
        headers: { Authorization: auth, Depth: '1' },
      }, proxyOf(cred))
      await ensureHttpOk(LABEL, res, 'PROPFIND')
      return hrefNames(await res.text())
        .filter((n) => BACKUP_NAME_RE.test(n))
        .map((n) => (dir ? `${dir}/${n}` : n))
    },
  }
}
