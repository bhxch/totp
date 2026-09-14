import type { IconRef, StorageAdapter } from '@totp/core'
import { reactive } from 'vue'

export interface IconStore {
  /** id→dataUrl 映射（含 'url:'+id 拉取缓存键），reactive */
  icons: Readonly<Record<string, string>>
  /** 读 'icons' 键填充内存映射；幂等 */
  init(): Promise<void>
  put(id: string, dataUrl: string): Promise<void>
  remove(id: string): Promise<void>
  /** undefined→undefined；builtin→undefined（组件直接用 path 渲染）；stored→icons[id]；url→icons['url:'+id] */
  resolve(ref: IconRef | undefined): string | undefined
  /** fetch(url)→blob→FileReader dataURL→put('url:'+id)→返回 dataURL；任何失败（网络/CORS/非 2xx）→null */
  fetchAndCache(ref: { kind: 'url'; id: string; url: string }): Promise<string | null>
}

const ICONS_KEY = 'icons'

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

  async function remove(id: string): Promise<void> {
    delete icons[id]
    await persist()
  }

  function resolve(ref: IconRef | undefined): string | undefined {
    if (!ref || ref.kind === 'builtin') return undefined
    const key = ref.kind === 'url' ? `url:${ref.id}` : ref.id
    return icons[key]
  }

  async function fetchAndCache(ref: { kind: 'url'; id: string; url: string }): Promise<string | null> {
    try {
      const res = await fetch(ref.url)
      if (!res.ok) return null
      const dataUrl = await blobToDataUrl(await res.blob())
      await put(`url:${ref.id}`, dataUrl)
      return dataUrl
    } catch {
      return null // 网络/CORS 失败如实降级，由调用方回退占位
    }
  }

  return { icons, init, put, remove, resolve, fetchAndCache }
}
