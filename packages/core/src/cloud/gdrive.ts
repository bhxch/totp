import type { CloudBackend, GDriveCred } from './backend'
import { cloudFetch, ensureHttpOk } from './backend'

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

  const createFile = async (name: string): Promise<string> => {
    const res = await cloudFetch(LABEL, `${DRIVE_API}/files`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      // 显式 mimeType=application/json:让 queryIdByName 的 mimeType 限定只匹配加密 envelope 文件,
      // 防止用户同名文档(如 txt/json)被误当作备份命中而覆盖上传内容
      body: JSON.stringify({ name, mimeType: 'application/json' }),
    })
    ensureHttpOk(LABEL, res)
    const json = (await res.json()) as { id?: string }
    if (!json.id) throw new Error('Google Drive 创建文件失败：响应缺少文件 id')
    fileId = json.id
    opts.onCredChange?.({ ...cred, fileId })
    return fileId
  }

  /** 按 name + mimeType 查询文件 id（排除回收站），取首个匹配。
   *  单引号按 Drive 查询语法转义为 \'，防 name 含 ' 时破坏 q 字符串（注入风险）。 */
  const queryIdByName = async (name: string): Promise<string | null> => {
    const safe = name.replace(/'/g, "\\'")
    const q = `name='${safe}' and mimeType='application/json' and trashed=false`
    const res = await cloudFetch(LABEL, `${DRIVE_API}/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType)`, {
      method: 'GET',
      headers: auth,
    })
    ensureHttpOk(LABEL, res)
    const json = (await res.json()) as { files?: Array<{ id?: string }> }
    const found = json.files?.[0]?.id ?? null
    if (found && found !== fileId) {
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
      const id = fileId ?? (await queryIdByName(path))
      if (!id) return
      const res = await cloudFetch(LABEL, `${DRIVE_API}/files/${id}`, { method: 'DELETE', headers: auth })
      ensureHttpOk(LABEL, res)
    },
    async exists(path) {
      return (await resolveId(path)) != null
    },
  }
}
