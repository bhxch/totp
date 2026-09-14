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
  /** 读 'icons' 键填充内存映射；幂等 */
  init(): Promise<void>
  put(id: string, dataUrl: string): Promise<void>
  /** 批量合并写入：内存一次 Object.assign 后单次落盘（避免逐条 put 的 O(n²) 全量序列化） */
  putMany(entries: Record<string, string>): Promise<void>
  /** I58：仅删除 id=图标 id 的键，不触碰 urlcache: 命名空间（URL 缓存独立管理） */
  remove(id: string): Promise<void>
  /** undefined→undefined；builtin→undefined（组件直接用 path 渲染）；stored→icons[id]；url→icons['urlcache:'+id] */
  resolve(ref: IconRef | undefined): string | undefined
  /** I59：fetch(url)→blob（>200KB 判失败）→FileReader dataURL→put('urlcache:'+id)→返回 ok/失败细分 */
  fetchAndCache(ref: { kind: 'url'; id: string; url: string }): Promise<FetchResult>
}

const ICONS_KEY = 'icons'
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
  let inited = false

  async function persist(): Promise<void> {
    await adapter.set(ICONS_KEY, JSON.stringify(icons))
  }

  async function init(): Promise<void> {
    if (inited) return
    inited = true
    const raw = await adapter.get(ICONS_KEY)
    if (raw === null) return
    try {
      Object.assign(icons, JSON.parse(raw) as Record<string, string>)
    } catch {
      // 盘上数据损坏时按空存储处理，不阻断启动
    }
  }

  async function put(id: string, dataUrl: string): Promise<void> {
    icons[id] = dataUrl
    await persist()
  }

  async function putMany(entries: Record<string, string>): Promise<void> {
    Object.assign(icons, entries)
    await persist()
  }

  async function remove(id: string): Promise<void> {
    // I58：URL 缓存键以 urlcache: 前缀，remove(id) 只删图标 id 本身，不触碰 url 缓存命名空间
    delete icons[id]
    await persist()
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

  return { icons, init, put, putMany, remove, resolve, fetchAndCache }
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
