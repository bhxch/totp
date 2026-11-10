/**
 * 扩展端网络时间校准器（时间源特性 spec §4）：background SW 承载——host_permissions 已全放行
 * （wxt.config.ts:33），SW fetch 不受 CORS 限制；popup/options 经 sendMessage 通道驱动。
 * 源序 = core HTTPS_TIME_SOURCE_IDS（毫秒 API 在前，动态生成免疫 CDN 缓存；海外 trace 兜底，
 * 无代理设备自然超时跳过）。单源 5s 超时（AbortController）为每请求硬界；总体 12s 为循环顶
 * 的快速失败阈值而非硬上界（判据见 calibrateNetworkTime，最坏 ≈7×5s=15s，终审 G3 如实声明）。
 * fetch 带 cache:'no-store' 防缓存层吃掉 Date 新鲜度（实测：淘宝 HEAD Date 滞后 43s 的教训）。
 */
import { computeOffsetMs, HTTPS_TIME_SOURCE_IDS, type HttpsTimeSourceId } from '@totp/core'
import type { CalibrateResult } from '@totp/ui'

const SOURCE_TIMEOUT_MS = 5000
/** 总体快速失败阈值（终审 G3）：判据仅在循环顶——已开始的最后一源可再跑满单源 5s 硬界，
 *  全部源均超时时最坏 ≈7×5s=15s。它是「尽快放弃」阈值而非硬上界；硬界由每请求
 *  AbortController（SOURCE_TIMEOUT_MS）保证 */
const TOTAL_TIMEOUT_MS = 12_000

interface HttpsTimeSource {
  id: HttpsTimeSourceId
  url: string
  method: 'GET' | 'HEAD'
  parse: (res: Response) => Promise<number>
}

/** RFC7231 Date 头 → epoch ms（秒级精度，TOTP 30s 窗口足够） */
function parseDateHeader(res: Response): number {
  const v = res.headers.get('date')
  if (!v) throw new Error('time source: no date header')
  const t = new Date(v).getTime()
  if (!Number.isFinite(t)) throw new Error('time source: bad date header')
  return t
}

const SOURCES: HttpsTimeSource[] = [
  {
    id: 'taobao-api', url: 'https://acs.m.taobao.com/gw/mtop.common.getTimestamp/', method: 'GET',
    parse: async (res) => {
      const t = Number((await res.json())?.data?.t)
      if (!Number.isFinite(t)) throw new Error('time source: bad taobao payload')
      return t
    },
  },
  {
    id: 'suning-api', url: 'https://f.m.suning.com/api/ct.do', method: 'GET',
    parse: async (res) => {
      const t = Number((await res.json())?.currentTime)
      if (!Number.isFinite(t)) throw new Error('time source: bad suning payload')
      return t
    },
  },
  { id: 'baidu', url: 'https://www.baidu.com', method: 'HEAD', parse: async (res) => parseDateHeader(res) },
  { id: 'qq', url: 'https://www.qq.com', method: 'HEAD', parse: async (res) => parseDateHeader(res) },
  { id: 'gitee', url: 'https://gitee.com', method: 'HEAD', parse: async (res) => parseDateHeader(res) },
  { id: 'jd', url: 'https://www.jd.com', method: 'HEAD', parse: async (res) => parseDateHeader(res) },
  {
    id: 'cloudflare-trace', url: 'https://www.cloudflare.com/cdn-cgi/trace', method: 'GET',
    parse: async (res) => {
      const m = /ts=(\d+(?:\.\d+)?)/.exec(await res.text())
      if (!m) throw new Error('time source: bad trace payload')
      return Number(m[1]) * 1000
    },
  },
]

/** 源序校准：preferred 置顶（非法 id 跳过按内置序兜底），前源失败继续，全败 reject */
export async function calibrateNetworkTime(preferredSourceId: string | null): Promise<CalibrateResult> {
  const order: string[] = preferredSourceId ? [preferredSourceId, ...HTTPS_TIME_SOURCE_IDS.filter((id) => id !== preferredSourceId)] : [...HTTPS_TIME_SOURCE_IDS]
  const startedAt = Date.now()
  for (const id of order) {
    if (Date.now() - startedAt > TOTAL_TIMEOUT_MS) break
    const src = SOURCES.find((s) => s.id === id)
    if (!src) continue
    const t0 = Date.now()
    try {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), SOURCE_TIMEOUT_MS)
      let res: Response
      try {
        res = await fetch(src.url, { method: src.method, cache: 'no-store', signal: ctrl.signal })
      } finally {
        clearTimeout(timer)
      }
      if (!res.ok) throw new Error(`time source: http ${res.status}`)
      const serverMs = await src.parse(res)
      return { offsetMs: computeOffsetMs(serverMs, t0, Date.now()), sourceId: src.id }
    } catch { /* 该源失败：按序兜底下一源 */ }
  }
  throw new Error('time source: all sources failed')
}
