import type { CloudBackend, OneDriveCred } from './backend'
import { cloudFetch, ensureHttpOk } from './backend'
import { BACKUP_NAME_RE } from '../backup/policy'
import { resolveDirPath, resolveObjectPath } from './targetPath'

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
    async listBackups() {
      // keep-n（设计 §3）：按对象路径（含文件名）取 item 的 parentReference，再列同父 children 过滤备份名；
      // item 不存在（404）或父引用缺失 → 空数组（宁可不删不可误删）。
      // 返回与 put/get/delete 同域的完整路径（dir/name）——子目录 cred 下裸名会删错层。
      const dir = resolveDirPath(cred)
      const res = await cloudFetch(LABEL, `${itemUrl(resolveObjectPath(cred))}?select=parentReference`, { method: 'GET', headers: auth })
      if (res.status === 404) return []
      ensureHttpOk(LABEL, res)
      const item = (await res.json()) as { parentReference?: { id?: string } }
      const parentId = item.parentReference?.id
      if (!parentId) return []
      // 分页续传（审查 M2）：Graph children 单页有限，响应含 @odata.nextLink 时按链接续拉聚合
      // （nextLink 为绝对 URL 原样透传）；上限 10 页防服务端异常失控。
      const out: string[] = []
      let url: string | null = `${GRAPH}/me/drive/items/${encodeURIComponent(parentId)}/children`
      for (let page = 0; url !== null && page < 10; page++) {
        const children = await cloudFetch(LABEL, url, { method: 'GET', headers: auth })
        ensureHttpOk(LABEL, children)
        const json = (await children.json()) as { value?: Array<{ name?: string }>; '@odata.nextLink'?: string }
        for (const f of json.value ?? []) {
          const n = f.name ?? ''
          if (BACKUP_NAME_RE.test(n)) out.push(dir ? `${dir}/${n}` : n)
        }
        url = json['@odata.nextLink'] ?? null
      }
      return out
    },
  }
}
