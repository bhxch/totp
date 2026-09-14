import type { CloudBackend, OneDriveCred } from './backend'
import { cloudFetch, ensureHttpOk } from './backend'

const LABEL = 'OneDrive'
const GRAPH = 'https://graph.microsoft.com/v1.0'

/** Graph driveItem 路径语法编码：逐段 encodeURIComponent，保留分隔符 '/'。 */
export function encodeDrivePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/')
}

/** OneDrive（Microsoft Graph）后端：root:/path:/content PUT upsert 单文件存加密 envelope。 */
export function createOneDriveBackend(cred: OneDriveCred): CloudBackend {
  const auth = { Authorization: `Bearer ${cred.accessToken}` }
  const contentUrl = (path: string) => `${GRAPH}/me/drive/root:/${encodeDrivePath(path)}:/content`
  const itemUrl = (path: string) => `${GRAPH}/me/drive/root:/${encodeDrivePath(path)}:`
  return {
    id: 'onedrive',
    async put(path, data) {
      const res = await cloudFetch(LABEL, contentUrl(path), {
        method: 'PUT',
        headers: { ...auth, 'Content-Type': 'application/octet-stream' },
        body: new Uint8Array(data),
      })
      ensureHttpOk(LABEL, res)
    },
    async get(path) {
      const res = await cloudFetch(LABEL, contentUrl(path), { method: 'GET', headers: auth })
      if (res.status === 404) return null
      ensureHttpOk(LABEL, res)
      return new Uint8Array(await res.arrayBuffer())
    },
    async delete(path) {
      const res = await cloudFetch(LABEL, itemUrl(path), { method: 'DELETE', headers: auth })
      ensureHttpOk(LABEL, res)
    },
    async exists(path) {
      const res = await cloudFetch(LABEL, itemUrl(path), { method: 'GET', headers: auth })
      if (res.status === 404) return false
      ensureHttpOk(LABEL, res)
      return res.ok
    },
  }
}
