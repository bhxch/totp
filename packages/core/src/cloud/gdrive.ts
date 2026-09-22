import type { CloudBackend, GDriveCred } from './backend'
import { cloudFetch, ensureHttpOk } from './backend'
import { BACKUP_NAME_RE } from '../backup/policy'
import { refreshAccessToken } from './oauthRefresh'
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
  // OAuth 模式（spec §5⑦）：Authorization 可变——401 刷新后原地改写，后续请求（含同调用链重试）
  // 即取新 token；手工 token 模式该值恒为 cred.accessToken，行为不变。
  const auth = { Authorization: `Bearer ${cred.accessToken}` }

  /** OAuth 自愈请求（spec §5⑦）：请求 401 且 cred.oauth 存在 → 刷新 access token（模块级会话缓存
   *  去重）后原请求重试一次。重试须重建 Authorization——调用方构造 init 时已把当时的 auth 展开/引用
   *  进 headers，原地改写 auth 不会回填旧 init。重试仍 401/403 交由调用方 ensureHttpOk 抛
   *  （凭据失效语义不变）；无 oauth 时与 cloudFetch 直连完全一致（401 照原样返回给上层判定）。 */
  const authFetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const res = await cloudFetch(LABEL, url, init)
    if (res.status !== 401 || !cred.oauth) return res
    auth.Authorization = `Bearer ${await refreshAccessToken(cred)}`
    return cloudFetch(LABEL, url, { ...init, headers: { ...(init?.headers as Record<string, string>), Authorization: auth.Authorization } })
  }

  let fileId = cred.fileId
  // objectPath 的 basename：delete 判定「目标与主对象同名」用（objectPath 实例生命周期内不变，算一次）
  const objectBasename = resolveObjectPath(cred).split('/').pop()!
  const basenameOf = (p: string) => p.split('/').filter((s) => s !== '').pop() ?? p

  /** 在 Drive 新建文件（显式 mimeType=application/json：让 queryIdByName 的 mimeType 限定只匹配加密
   *  envelope 文件，防止用户同名文档被误当作备份命中；parents 限定落点目录）。只返回新 id，
   *  不触碰 fileId——keep 时间戳文件绝不劫持主对象指针（审查 I2）。 */
  const createFileRaw = async (name: string, parents?: string[]): Promise<string> => {
    const res = await authFetch(`${DRIVE_API}/files`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      // 显式 mimeType=application/json:让 queryIdByName 的 mimeType 限定只匹配加密 envelope 文件,
      // 防止用户同名文档(如 txt/json)被误当作备份命中而覆盖上传内容
      body: JSON.stringify(parents ? { name, mimeType: 'application/json', parents } : { name, mimeType: 'application/json' }),
    })
    ensureHttpOk(LABEL, res) // HTTP 层错误（如 401/403/5xx）由 ensureHttpOk 抛 "Google Drive xxx"，前缀与业务字段缺失错误区分
    const json = (await res.json()) as { id?: string }
    if (!json.id) throw new Error('Google Drive 业务字段缺失：files.create 响应缺少文件 id')
    return json.id
  }

  /** 主对象创建并采纳（首推自动建立 vault 文件）：回写 fileId + onCredChange。仅主对象走此路径。 */
  const createFile = async (name: string): Promise<string> => {
    const id = await createFileRaw(name)
    fileId = id
    opts.onCredChange?.({ ...cred, fileId: id })
    return id
  }

  /** 主对象所在父目录——listBackups 圈列域、异名 delete 查询域、keep 新建落点三者同源，
   *  保证「删除域 ⊆ 列表域」（审查 I3）。无 fileId → 'root'（Drive 根目录别名）；
   *  主对象已删（404）→ null（域未知，调用方宁可不删不可误删）。 */
  const primaryParent = async (): Promise<string | null> => {
    if (!fileId) return 'root'
    const res = await authFetch(`${DRIVE_API}/files/${fileId}?fields=parents`, { method: 'GET', headers: auth })
    if (res.status === 404) return null
    ensureHttpOk(LABEL, res)
    const json = (await res.json()) as { parents?: string[] }
    return json.parents?.[0] ?? 'root'
  }

  /** 按 name + mimeType 查询文件 id（排除回收站），取首个匹配。
   *  单引号按 Drive 查询语法转义为 \'，防 name 含 ' 时破坏 q 字符串（注入风险）。
   *  parent 可选约束（审查 I3）：异名 delete 必传（与 listBackups 圈列域同源，防双 gdrive 源同名文件互删）；
   *  主对象解析（get/exists）不传——主对象名即 objectPath 全串，全 Drive 查询无歧义。
   *  writeBack=false：纯查询（滚动删除异名目标用），命中结果不回写 fileId——防主对象指针被时间戳文件劫持。 */
  const queryIdByName = async (name: string, writeBack = true, parent?: string): Promise<string | null> => {
    const safe = name.replace(/'/g, "\\'")
    const parentClause = parent === undefined ? '' : ` and '${parent.replace(/'/g, "\\'")}' in parents`
    const q = `name='${safe}' and mimeType='application/json'${parentClause} and trashed=false`
    const res = await authFetch(`${DRIVE_API}/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType)`, {
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
    const res = await authFetch(`${DRIVE_API}/files/${fileId}?fields=id`, { method: 'GET', headers: auth })
    if (res.status === 404) return null
    ensureHttpOk(LABEL, res)
    return fileId
  }

  const uploadMedia = async (id: string, data: Uint8Array): Promise<void> => {
    const res = await authFetch(`${DRIVE_UPLOAD}/files/${id}?uploadType=media`, {
      method: 'PATCH',
      headers: { ...auth, 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array(data),
    })
    ensureHttpOk(LABEL, res)
  }

  return {
    id: 'gdrive',
    async put(path, data) {
      const base = basenameOf(path)
      if (base === objectBasename) {
        // overwrite 目标（与主对象同名）：PATCH 主文件（无 fileId 首推先建立主对象并回存凭据）
        await uploadMedia(fileId ?? (await createFile(path)), data)
        return
      }
      // keep-n 时间戳目标（审查 I2）：绝不 PATCH 主文件——否则 keep 语义静默退化 overwrite，
      // 且会覆盖用户主 vault 文档。改在主对象同一父目录新建时间戳文件；新 id 不回写凭据
      // （fileId 只指向主对象，回写则下轮 put 又变 overwrite）。主对象尚未建立（首推即 keep）时
      // 先按既有「首推自动创建」语义建立主对象（承载 overwrite 域的 get/exists/listBackups）。
      if (!fileId) await uploadMedia(await createFile(resolveObjectPath(cred)), data)
      const parent = await primaryParent()
      // 主对象已删（审查勘误）：落点目录未知即上传会静默落 root 成孤儿（从此不被
      // listBackups/delete/恢复任何域管理、每轮累积）——明确报错中止，引导用户修复 fileId，
      // 与 overwrite 分流下 PATCH 已删 fileId 会抛 HTTP 404 的行为对齐。
      if (parent === null) {
        throw new Error('Google Drive 主文件已不存在（fileId 失效），无法确定 keep 备份落点目录：请重新授权云备份或删除该源凭据后重新配置')
      }
      const id = await createFileRaw(base, [parent])
      await uploadMedia(id, data)
    },
    async get(path) {
      const id = fileId ?? (await queryIdByName(path))
      if (!id) return null
      const res = await authFetch(`${DRIVE_API}/files/${id}?alt=media`, { method: 'GET', headers: auth })
      if (res.status === 404) return null
      ensureHttpOk(LABEL, res)
      return new Uint8Array(await res.arrayBuffer())
    },
    async delete(path) {
      // 主对象保护（keep-n 滚动删除激活了本路径）：cred.fileId 指向云端主 vault 对象，仅当删除目标与
      // objectPath 同 basename 时才可删 fileId；时间戳等异名目标改按名查询删除同名文件（writeBack=false），
      // 查不到（404/空）静默返回——宁可不删不可误删主对象。
      let id: string | null
      if (basenameOf(path) === objectBasename) {
        id = fileId ?? (await queryIdByName(path))
      } else {
        // 异名查询按 parent 圈域（审查 I3）：删除域与 listBackups 列表域同源，双源同名文件互不越界；
        // 主对象已删（parent 未知）→ 域无法圈定，静默返回（宁可不删不可误删）
        const parent = await primaryParent()
        if (parent === null) return
        id = await queryIdByName(path, false, parent)
      }
      if (!id) return
      const res = await authFetch(`${DRIVE_API}/files/${id}`, { method: 'DELETE', headers: auth })
      ensureHttpOk(LABEL, res)
    },
    async exists(path) {
      return (await resolveId(path)) != null
    },
    async listBackups() {
      // keep-n（设计 §3）：cred.fileId 是文件非目录——先取其 parents，再列同父下 vault-*；
      // 无 fileId（首推未发生）按 Drive 根目录别名 'root' 列；目标文件已删（404）父目录未知，返回空（宁可不删不可误删）。
      const parent = await primaryParent()
      if (parent === null) return []
      // 单引号按 Drive 查询语法转义，防注入（与 queryIdByName 同款）
      const safe = parent.replace(/'/g, "\\'")
      const q = `'${safe}' in parents and name contains 'vault-' and trashed=false`
      // 分页续传（审查 M2）：响应含 nextPageToken 时带 pageToken 续拉聚合；fields 需显式含
      // nextPageToken（Drive 带 fields 时只返回所列字段）——它是 FileList 顶层字段，必须放括号外
      // 逗号分隔（files(name),nextPageToken）：括号内子选择器遇未知字段真实 API 返 400
      // Invalid field selection（质量审查勘误）。上限 10 页防服务端异常失控。
      const out: string[] = []
      let pageToken: string | undefined
      for (let page = 0; page < 10; page++) {
        const tokenQs = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''
        const list = await authFetch(`${DRIVE_API}/files?q=${encodeURIComponent(q)}&fields=files(name),nextPageToken${tokenQs}`, {
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
        if (!pageToken) break // 容忍缺失/空串 nextPageToken（空串续拉会打出无效请求）
      }
      return out
    },
  }
}
