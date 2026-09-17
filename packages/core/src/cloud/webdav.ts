import type { CloudBackend, WebdavCred } from './backend'
import { cloudFetch, ensureHttpOk } from './backend'
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
  return {
    id: 'webdav',
    async put(path, data) {
      const res = await cloudFetch(LABEL, urlOf(path), {
        method: 'PUT',
        headers: { Authorization: auth },
        body: new Uint8Array(data),
      })
      ensureHttpOk(LABEL, res)
    },
    async get(path) {
      const res = await cloudFetch(LABEL, urlOf(path), { method: 'GET', headers: { Authorization: auth } })
      if (res.status === 404) return null
      ensureHttpOk(LABEL, res)
      return new Uint8Array(await res.arrayBuffer())
    },
    async delete(path) {
      const res = await cloudFetch(LABEL, urlOf(path), { method: 'DELETE', headers: { Authorization: auth } })
      ensureHttpOk(LABEL, res)
    },
    async exists(path) {
      const res = await cloudFetch(LABEL, urlOf(path), { method: 'GET', headers: { Authorization: auth } })
      if (res.status === 404) return false
      ensureHttpOk(LABEL, res)
      return res.ok
    },
    async listBackups() {
      // keep-n（设计 §3）：PROPFIND 对象父目录 Depth:1，列同目录 vault-{ts} 名（207 Multi-Status 属 2xx）。
      // 返回与 put/get/delete 同域的完整路径（dir/name）——子目录 cred 下裸名会删错层 404。
      const dir = resolveDirPath(cred)
      const res = await cloudFetch(LABEL, urlOf(dir ? `${dir}/` : ''), {
        method: 'PROPFIND',
        headers: { Authorization: auth, Depth: '1' },
      })
      ensureHttpOk(LABEL, res)
      return hrefNames(await res.text())
        .filter((n) => BACKUP_NAME_RE.test(n))
        .map((n) => (dir ? `${dir}/${n}` : n))
    },
  }
}
