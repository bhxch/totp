import type { CloudBackend, WebdavCred } from './backend'
import { cloudFetch, ensureHttpOk } from './backend'

const LABEL = 'WebDAV'

/** serverUrl 尾斜杠归一 + path 去开头斜杠后拼接。 */
export function joinDavUrl(serverUrl: string, path: string): string {
  const base = serverUrl.replace(/\/+$/, '')
  const rel = path.replace(/^\/+/, '')
  return `${base}/${rel}`
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
  }
}
