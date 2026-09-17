import type { CloudBackend, GistCred } from './backend'
import { cloudFetch, ensureHttpOk } from './backend'
import { BACKUP_NAME_RE } from '../backup/policy'

const LABEL = 'Gist'
const GIST_URL = 'https://api.github.com/gists'

interface GistFileMeta {
  content?: string
  truncated?: boolean
}

interface GistApiResponse {
  files?: Record<string, GistFileMeta | undefined>
}

/**
 * Gist 后端：文件内容是文本，path 即 gist 内文件名。
 * Gist API 无法删除文件——delete 将 content 置空串（语义近似）；
 * 单文件超过 1MB 时 GitHub 返回 truncated，get 视为「文件过大」拒绝。
 * opts.onCredChange：fetchGist 时若发现 public 状态变化,回调上层持久化以便 UI 给一次性警示。
 */
export function createGistBackend(cred: GistCred, opts: { onCredChange?: (cred: GistCred) => void } = {}): CloudBackend {
  const url = `${GIST_URL}/${cred.gistId}`
  const headers = (extra: Record<string, string> = {}) => ({ Authorization: `Bearer ${cred.token}`, ...extra })

  const fetchGist = async (): Promise<{ public?: boolean } & GistApiResponse> => {
    const res = await cloudFetch(LABEL, url, { method: 'GET', headers: headers() })
    if (res.status === 404) return {}
    ensureHttpOk(LABEL, res)
    const json = (await res.json()) as ({ public?: boolean } & GistApiResponse)
    if (typeof json.public === 'boolean' && json.public !== cred.public) {
      opts.onCredChange?.({ ...cred, public: json.public })
    }
    return json
  }

  const patchFile = async (path: string, content: string): Promise<void> => {
    const res = await cloudFetch(LABEL, url, {
      method: 'PATCH',
      headers: headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ files: { [path]: { content } } }),
    })
    ensureHttpOk(LABEL, res)
  }

  return {
    id: 'gist',
    async put(path, data) {
      await patchFile(path, new TextDecoder().decode(data))
    },
    async get(path) {
      const json = await fetchGist()
      const file = json.files?.[path]
      if (!file?.content) return null
      if (file.truncated === true) throw new Error('Gist 文件过大（超过 1MB 被截断），无法读取完整内容')
      return new TextEncoder().encode(file.content)
    },
    async delete(path) {
      // TODO: UI 暂不暴露 delete 入口（PATCH content='' 不是真删）；保留实现以备未来"清理云端备份"功能
      await patchFile(path, '')
    },
    async exists(path) {
      const json = await fetchGist()
      return !!json.files?.[path]?.content
    },
    async listBackups() {
      // keep-n（设计 §3）：gist 是天然多文件容器，文件名不允许 '/'（无目录层级），列全量后按备份名过滤。
      // content=='' 是 delete 的置空残留（gist API 无法真删），不可再参与滚动删除。
      const json = await fetchGist()
      return Object.entries(json.files ?? {})
        .filter(([n, f]) => BACKUP_NAME_RE.test(n) && !!f?.content)
        .map(([n]) => n)
    },
  }
}
