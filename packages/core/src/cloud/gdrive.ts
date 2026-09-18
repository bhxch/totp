import type { CloudBackend, GDriveCred } from './backend'
import { cloudFetch, ensureHttpOk } from './backend'
import { BACKUP_NAME_RE } from '../backup/policy'
import { resolveObjectPath } from './targetPath'

const LABEL = 'Google Drive'
const DRIVE_API = 'https://www.googleapis.com/drive/v3'
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3'

export interface GDriveBackendOptions {
  /** 首推自动创建文件后回存新凭据（含 fileId），由调用方持久化。 */
  onCredChange?: (cred: GDriveCred) => void
}

/**
 * Google Drive 后端：单文件存加密 envelope。
 * put：无 fileId 时先 POST /drive/v3/files（{name} JSON）创建并经 onCredChange 回存 id，再 PATCH upload media；
 * get/exists/delete：有 fileId 直接用（校验仍在），否则按 name 查询 files.list（trashed=false）。
 */
export function createGDriveBackend(cred: GDriveCred, opts: GDriveBackendOptions = {}): CloudBackend {
  const auth = { Authorization: `Bearer ${cred.accessToken}` }
  let fileId = cred.fileId
  // objectPath 的 basename：delete 判定「目标与主对象同名」用（objectPath 实例生命周期内不变，算一次）
  const objectBasename = resolveObjectPath(cred).split('/').pop()!
  const basenameOf = (p: string) => p.split('/').filter((s) => s !== '').pop() ?? p

  const createFile = async (name: string): Promise<string> => {
    const res = await cloudFetch(LABEL, `${DRIVE_API}/files`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      // 显式 mimeType=application/json:让 queryIdByName 的 mimeType 限定只匹配加密 envelope 文件,
      // 防止用户同名文档(如 txt/json)被误当作备份命中而覆盖上传内容
      body: JSON.stringify({ name, mimeType: 'application/json' }),
    })
    ensureHttpOk(LABEL, res) // HTTP 层错误（如 401/403/5xx）由 ensureHttpOk 抛 "Google Drive xxx"，前缀与业务字段缺失错误区分
    const json = (await res.json()) as { id?: string }
    if (!json.id) throw new Error('Google Drive 业务字段缺失：files.create 响应缺少文件 id')
    fileId = json.id
    opts.onCredChange?.({ ...cred, fileId })
    return fileId
  }

  /** 按 name + mimeType 查询文件 id（排除回收站），取首个匹配。
   *  单引号按 Drive 查询语法转义为 \'，防 name 含 ' 时破坏 q 字符串（注入风险）。
   *  writeBack=false：纯查询（滚动删除异名目标用），命中结果不回写 fileId——防主对象指针被时间戳文件劫持。 */
  const queryIdByName = async (name: string, writeBack = true): Promise<string | null> => {
    const safe = name.replace(/'/g, "\\'")
    const q = `name='${safe}' and mimeType='application/json' and trashed=false`
    const res = await cloudFetch(LABEL, `${DRIVE_API}/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType)`, {
      method: 'GET',
      headers: auth,
    })
    ensureHttpOk(LABEL, res) // 同上：HTTP 错误 vs 业务字段缺失错误文案区分
    const json = (await res.json()) as { files?: Array<{ id?: string }> }
    const found = json.files?.[0]?.id ?? null
    if (writeBack && found && found !== fileId) {
      // 首次按 name 解析到 fileId 时回存凭据,避免后续每次都重复查询
      fileId = found
      opts.onCredChange?.({ ...cred, fileId: found })
    }
    return found
  }

  /** fileId 已知时校验文件仍在（被删→null）；未知时按 name 查询。 */
  const resolveId = async (name: string): Promise<string | null> => {
    if (!fileId) return queryIdByName(name)
    const res = await cloudFetch(LABEL, `${DRIVE_API}/files/${fileId}?fields=id`, { method: 'GET', headers: auth })
    if (res.status === 404) return null
    ensureHttpOk(LABEL, res)
    return fileId
  }

  const uploadMedia = async (id: string, data: Uint8Array): Promise<void> => {
    const res = await cloudFetch(LABEL, `${DRIVE_UPLOAD}/files/${id}?uploadType=media`, {
      method: 'PATCH',
      headers: { ...auth, 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array(data),
    })
    ensureHttpOk(LABEL, res)
  }

  return {
    id: 'gdrive',
    async put(path, data) {
      await uploadMedia(fileId ?? (await createFile(path)), data)
    },
    async get(path) {
      const id = fileId ?? (await queryIdByName(path))
      if (!id) return null
      const res = await cloudFetch(LABEL, `${DRIVE_API}/files/${id}?alt=media`, { method: 'GET', headers: auth })
      if (res.status === 404) return null
      ensureHttpOk(LABEL, res)
      return new Uint8Array(await res.arrayBuffer())
    },
    async delete(path) {
      // 主对象保护（keep-n 滚动删除激活了本路径）：cred.fileId 指向云端主 vault 对象，仅当删除目标与
      // objectPath 同 basename 时才可删 fileId；时间戳等异名目标改按名查询删除同名文件（writeBack=false），
      // 查不到（404/空）静默返回——宁可不删不可误删主对象。
      const sameTarget = basenameOf(path) === objectBasename
      const id = sameTarget ? (fileId ?? (await queryIdByName(path))) : (await queryIdByName(path, false))
      if (!id) return
      const res = await cloudFetch(LABEL, `${DRIVE_API}/files/${id}`, { method: 'DELETE', headers: auth })
      ensureHttpOk(LABEL, res)
    },
    async exists(path) {
      return (await resolveId(path)) != null
    },
    async listBackups() {
      // keep-n（设计 §3）：cred.fileId 是文件非目录——先取其 parents，再列同父下 vault-*；
      // 无 fileId（首推未发生）按 Drive 根目录别名 'root' 列；目标文件已删（404）父目录未知，返回空（宁可不删不可误删）。
      let parent = 'root'
      if (fileId) {
        const res = await cloudFetch(LABEL, `${DRIVE_API}/files/${fileId}?fields=parents`, { method: 'GET', headers: auth })
        if (res.status === 404) return []
        ensureHttpOk(LABEL, res)
        const json = (await res.json()) as { parents?: string[] }
        parent = json.parents?.[0] ?? 'root'
      }
      // 单引号按 Drive 查询语法转义，防注入（与 queryIdByName 同款）
      const safe = parent.replace(/'/g, "\\'")
      const q = `'${safe}' in parents and name contains 'vault-' and trashed=false`
      // 分页续传（审查 M2）：响应含 nextPageToken 时带 pageToken 续拉聚合；fields 需显式含
      // nextPageToken（Drive 带 fields 时只返回所列字段）；上限 10 页防服务端异常失控。
      const out: string[] = []
      let pageToken: string | undefined
      for (let page = 0; page < 10; page++) {
        const tokenQs = pageToken === undefined ? '' : `&pageToken=${encodeURIComponent(pageToken)}`
        const list = await cloudFetch(LABEL, `${DRIVE_API}/files?q=${encodeURIComponent(q)}&fields=files(name,nextPageToken)${tokenQs}`, {
          method: 'GET',
          headers: auth,
        })
        ensureHttpOk(LABEL, list)
        const json = (await list.json()) as { files?: Array<{ name?: string }>; nextPageToken?: string }
        for (const f of json.files ?? []) {
          const n = f.name ?? ''
          if (BACKUP_NAME_RE.test(n)) out.push(n)
        }
        pageToken = json.nextPageToken
        if (pageToken === undefined) break
      }
      return out
    },
  }
}
