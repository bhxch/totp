import type { IconRef, StorageAdapter } from '@totp/core'
import { getBuiltinIcons } from '@totp/core'
import { reactive } from 'vue'

/** 列表条目图标视图：OtpListItem icon prop（html=builtin path 片段；src=dataUrl；missing=URL 缓存丢失需重试）；无图标/解析失败 → undefined（回退首字母） */
export interface IconView {
  html?: string
  src?: string
  /** I69：URL 引用但缓存丢失（清空存储/换设备）→ UI 显示「URL 缓存丢失，点此重试」 */
  missing?: boolean
}

/** I59：URL 拉取失败细分原因，供调用方选择对应 UI 文案 */
export type FetchFailureKind = 'cors' | 'notfound' | 'toolarge' | 'other'
export type FetchResult = { ok: true; dataUrl: string } | { ok: false; kind: FetchFailureKind; message: string }

export interface IconStore {
  /** id→dataUrl 映射（含 'urlcache:'+id 拉取缓存键），reactive */
  icons: Readonly<Record<string, string>>
  /** 包注册表（normKey → { 显示名, 图标 id 清单 }），reactive；来源筛选/替换/删除的单一事实源 */
  packs: Readonly<Record<string, IconPackInfo>>
  /** 读 per-icon 数据键（icon:<id>，经 iconindex 索引）填充内存映射；旧单键 icons 首次 init 幂等迁移；幂等 */
  init(): Promise<void>
  put(id: string, dataUrl: string): Promise<void>
  /** 批量合并写入：内存一次 Object.assign 后单次落盘（避免逐条 put 的 O(n²) 全量序列化） */
  putMany(entries: Record<string, string>): Promise<void>
  /** I58：仅删除 id=图标 id 的键，不触碰 urlcache: 命名空间（URL 缓存独立管理） */
  remove(id: string): Promise<void>
  /** 批量删除图标 id（不含 urlcache: 命名空间），单次落盘 */
  removeMany(ids: string[]): Promise<void>
  upsertPack(normKey: string, info: IconPackInfo): Promise<void>
  /** 删除整包：移除该包全部图标 + 注册表条目；引用悬空由 UI 层回退（首字母） */
  removePack(normKey: string): Promise<void>
  /** undefined→undefined；builtin→undefined（组件直接用 path 渲染）；stored→icons[id]；url→icons['urlcache:'+id] */
  resolve(ref: IconRef | undefined): string | undefined
  /** I59：fetch(url)→blob（>200KB 判失败）→FileReader dataURL→put('urlcache:'+id)→返回 ok/失败细分 */
  fetchAndCache(ref: { kind: 'url'; id: string; url: string }): Promise<FetchResult>
}

export interface IconPackInfo {
  /** 显示名（保留用户输入原名） */
  name: string
  /** 归属该包的图标 id 清单 */
  iconIds: string[]
}

/** P2 per-icon 布局：数据键 icon:<id>（id 含 urlcache: 前缀同理），索引键 iconindex 存全部内存键名。
 *  一致性顺序＝先数据键后索引：崩溃窗口的孤儿数据键对 init 无害（init 只按索引枚举）。 */
const ICON_DATA_PREFIX = 'icon:'
const INDEX_KEY = 'iconindex'
const PACKS_KEY = 'iconpacks'
/** I58：URL 拉取缓存的独立命名空间前缀——与图标 id 物理隔离（避免图标 id 与 url 缓存键互相覆盖） */
const URL_CACHE_PREFIX = 'urlcache:'
/** URL 拉取缓存的单文件上限：超过直接判失败（防大文件撑爆存储） */
const MAX_FETCH_BYTES = 200 * 1024

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'))
    reader.readAsDataURL(blob)
  })
}

export function createIconStore(adapter: StorageAdapter): IconStore {
  const icons = reactive<Record<string, string>>({})
  const packs = reactive<Record<string, IconPackInfo>>({})
  let inited = false

  async function persistPacks(): Promise<void> {
    await adapter.set(PACKS_KEY, JSON.stringify(packs))
  }

  /** 只负责数据键写入/删除；索引由调用方在集合变化时显式重写（先数据后索引顺序不变，崩溃窗口孤儿键对 init 无害） */
  async function persistKeys(changed: Array<{ id: string; value: string | null }>): Promise<void> {
    for (const { id, value } of changed) {
      const key = `${ICON_DATA_PREFIX}${id}`
      if (value === null) await adapter.delete(key)
      else await adapter.set(key, value)
    }
  }

  async function init(): Promise<void> {
    if (inited) return
    inited = true
    // 旧单键迁移（幂等）：拆写数据键 → 写索引 → 删旧键
    const legacy = await adapter.get('icons')
    if (legacy !== null) {
      let legacyMap: Record<string, string> = {}
      try {
        const parsed = JSON.parse(legacy) as unknown
        // 形状校验：'null'/数组/原始值等不合法 legacy 一律按空处理，不阻断启动（与下方容错口径一致）
        legacyMap = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
          ? (parsed as Record<string, string>)
          : {}
      } catch {
        legacyMap = {} // 损坏按空处理，不阻断启动
      }
      const ids = Object.keys(legacyMap)
      for (const id of ids) await adapter.set(`${ICON_DATA_PREFIX}${id}`, legacyMap[id]!)
      await adapter.set(INDEX_KEY, JSON.stringify(ids))
      await adapter.delete('icons')
    }
    const rawIndex = await adapter.get(INDEX_KEY)
    if (rawIndex !== null) {
      let ids: string[] = []
      try {
        ids = JSON.parse(rawIndex) as string[]
      } catch {
        ids = []
      }
      // 读路径按索引批量并行回读：扩展端每次 get 是一次 IPC 往返，串行 await 会放大为 O(n) 次往返
      // （2000 图标全量包场景 popup 启动可感知变慢），Promise.all 单轮并行消解；非 null 才填 icons 语义不变
      await Promise.all(
        ids.map(async (id) => {
          const v = await adapter.get(`${ICON_DATA_PREFIX}${id}`)
          if (v !== null) icons[id] = v
        }),
      )
    }
    const rawPacks = await adapter.get(PACKS_KEY)
    if (rawPacks !== null) {
      try {
        Object.assign(packs, JSON.parse(rawPacks) as Record<string, IconPackInfo>)
      } catch {
        // 损坏按空注册表处理，不阻断启动
      }
    }
  }

  async function put(id: string, dataUrl: string): Promise<void> {
    const isNew = !(id in icons)
    icons[id] = dataUrl
    await persistKeys([{ id, value: dataUrl }])
    if (isNew) await adapter.set(INDEX_KEY, JSON.stringify(Object.keys(icons)))
  }

  async function putMany(entries: Record<string, string>): Promise<void> {
    const known = new Set(Object.keys(icons))
    Object.assign(icons, entries)
    await persistKeys(Object.keys(entries).map((id) => ({ id, value: entries[id]! })))
    if (Object.keys(entries).some((id) => !known.has(id))) await adapter.set(INDEX_KEY, JSON.stringify(Object.keys(icons)))
  }

  async function remove(id: string): Promise<void> {
    // I58：URL 缓存键以 urlcache: 前缀，remove(id) 只删图标 id 本身，不触碰 url 缓存命名空间
    const existed = id in icons
    delete icons[id]
    await adapter.delete(`${ICON_DATA_PREFIX}${id}`)
    if (existed) await adapter.set(INDEX_KEY, JSON.stringify(Object.keys(icons)))
  }

  async function removeMany(ids: string[]): Promise<void> {
    let removed = false
    for (const id of ids) {
      if (id in icons) removed = true
      delete icons[id]
      await adapter.delete(`${ICON_DATA_PREFIX}${id}`)
    }
    if (removed) await adapter.set(INDEX_KEY, JSON.stringify(Object.keys(icons)))
  }

  async function upsertPack(normKey: string, info: IconPackInfo): Promise<void> {
    packs[normKey] = info
    await persistPacks()
  }

  async function removePack(normKey: string): Promise<void> {
    const info = packs[normKey]
    if (!info) return
    let removed = false
    for (const id of info.iconIds) {
      if (id in icons) removed = true
      delete icons[id]
      await adapter.delete(`${ICON_DATA_PREFIX}${id}`)
    }
    delete packs[normKey]
    if (removed) await adapter.set(INDEX_KEY, JSON.stringify(Object.keys(icons)))
    await persistPacks()
  }

  function resolve(ref: IconRef | undefined): string | undefined {
    if (!ref || ref.kind === 'builtin') return undefined
    const key = ref.kind === 'url' ? `${URL_CACHE_PREFIX}${ref.id}` : ref.id
    return icons[key]
  }

  async function fetchAndCache(ref: { kind: 'url'; id: string; url: string }): Promise<FetchResult> {
    let res: Response
    try {
      res = await fetch(ref.url)
    } catch (e) {
      // fetch 抛错通常 = CORS/网络/混合内容拦截；统一归类为 cors 类别
      return { ok: false, kind: 'cors', message: e instanceof Error ? e.message : String(e) }
    }
    if (!res.ok) {
      return { ok: false, kind: 'notfound', message: `HTTP ${res.status}` }
    }
    let blob: Blob
    try {
      blob = await res.blob()
    } catch (e) {
      return { ok: false, kind: 'other', message: e instanceof Error ? e.message : String(e) }
    }
    if (blob.size > MAX_FETCH_BYTES) {
      return { ok: false, kind: 'toolarge', message: `文件超过 ${MAX_FETCH_BYTES} 字节上限` }
    }
    try {
      const dataUrl = await blobToDataUrl(blob)
      await put(`${URL_CACHE_PREFIX}${ref.id}`, dataUrl)
      return { ok: true, dataUrl }
    } catch (e) {
      return { ok: false, kind: 'other', message: e instanceof Error ? e.message : String(e) }
    }
  }

  return { icons, packs, init, put, putMany, remove, removeMany, removePack, upsertPack, resolve, fetchAndCache }
}

/**
 * IconRef → IconView：builtin 用内置 path 构 `<path>` 片段（由 OtpListItem 包 `<svg viewBox="0 0 24 24" v-html>`，
 * fill currentColor）；stored/url 经 store.resolve 取 dataUrl（url 走 'urlcache:'+id 缓存键）。
 * I69：URL 引用但缓存丢失 → 返回 { missing: true }，组件据此显示「URL 缓存丢失，点此重试」。
 * store 缺省时 builtin 仍可渲染，stored/url 不可解析 → undefined。
 */
export function iconView(ref: IconRef | undefined, icons?: IconStore): IconView | undefined {
  if (!ref) return undefined
  if (ref.kind === 'builtin') {
    const bi = getBuiltinIcons()[ref.id]
    return bi ? { html: `<path d="${bi.path}"></path>` } : undefined
  }
  const src = icons?.resolve(ref)
  if (src) return { src }
  // I69：URL 引用解析失败（缓存丢失/未拉取）→ 显式标记 missing
  if (ref.kind === 'url') return { missing: true }
  return undefined
}
