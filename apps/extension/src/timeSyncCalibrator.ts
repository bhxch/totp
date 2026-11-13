/**
 * 扩展端网络时间校准器（时间源特性 spec §4）：background SW 承载——host_permissions 已全放行
 * （wxt.config.ts:33），SW fetch 不受 CORS 限制；popup/options 经 sendMessage 通道驱动。
 *
 * 两条源链（2026-11-13 全球链补齐）：源序按**界面语言**决定的剖面取 core 的
 * httpsTimeSourceIds(profile)——'cn' 大陆链（毫秒 API 在前，动态生成免疫 CDN 缓存）、
 * 'global' 国际链（毫秒 API timeapi → Cloudflare trace → 无缓存 204/microsoft Date 头）。
 * 单源 5s 超时（AbortController）为每请求硬界；总体 12s 为循环顶的快速失败阈值而非硬上界
 * （判据见 calibrateNetworkTime，最坏 = 3×5s=15s（12s 阈值前最多启动 3 个慢源，终审 G3 如实声明））。
 * fetch 带 cache:'no-store' 防缓存层吃掉 Date 新鲜度（实测：淘宝 HEAD Date 滞后 43s 的教训；
 * 2026-11-13 追加教训：apple.com Date 滞后 542s——Date 头源只作末位兜底，动态源在前）。
 */
import {
  computeOffsetMs, httpsTimeSourceIds, type HttpsTimeSourceId, type TimeSourceProfile,
} from '@totp/core'
import type { CalibrateResult } from '@totp/ui'

const SOURCE_TIMEOUT_MS = 5000
/** 总体快速失败阈值（终审 G3）：判据仅在循环顶——已开始的最后一源可再跑满单源 5s 硬界，
 *  全部源均超时时最坏 = 3×5s=15s（12s 阈值前最多启动 3 个慢源）。它是「尽快放弃」阈值而非硬上界；硬界由每请求
 *  AbortController（SOURCE_TIMEOUT_MS）保证 */
const TOTAL_TIMEOUT_MS = 12_000
/** 服务器时刻合理下界（2023-11-14）：schema 级垃圾值防线（终审 G5 同源，与 Rust 侧
 *  SERVER_MS_FLOOR 一致）——合法历史偏移不受影响，只挡解析错误/边缘缓存产出的明显
 *  不可能时间戳（如 Number(null|'')=0 穿透 isFinite 的形态，终审 Task3-①） */
const SERVER_MS_FLOOR = 1_700_000_000_000

interface HttpsTimeSource {
  id: HttpsTimeSourceId
  url: string
  method: 'GET' | 'HEAD'
  parse: (res: Response) => Promise<number>
}

/** 服务器时刻下界统一校验：各 parse 产出后调用，垃圾值抛错走源兜底 */
function assertServerMs(serverMs: number): number {
  if (serverMs < SERVER_MS_FLOOR) throw new Error('time source: server time below floor')
  return serverMs
}

/** RFC7231 Date 头 → epoch ms（秒级精度，TOTP 30s 窗口足够） */
function parseDateHeader(res: Response): number {
  const v = res.headers.get('date')
  if (!v) throw new Error('time source: no date header')
  const t = new Date(v).getTime()
  if (!Number.isFinite(t)) throw new Error('time source: bad date header')
  return assertServerMs(t)
}

/** timeapi.io 组件 → epoch ms（请求 timeZone=UTC，组件即 UTC；毫秒精度，动态生成） */
async function parseTimeApiComponents(res: Response): Promise<number> {
  const b = (await res.json()) as Record<string, unknown> | null
  if (!b) throw new Error('time source: bad timeapi payload')
  const num = (v: unknown): number => {
    const n = Number(v)
    if (!Number.isFinite(n)) throw new Error('time source: bad timeapi payload')
    return n
  }
  const ms = Date.UTC(
    num(b['year']), num(b['month']) - 1, num(b['day']),
    num(b['hour']), num(b['minute']), num(b['seconds']), num(b['milliSeconds']),
  )
  if (!Number.isFinite(ms)) throw new Error('time source: bad timeapi payload')
  return assertServerMs(ms)
}

/** Cloudflare trace 源（两链共用：anycast 全球可达，ts= 秒浮点，动态生成免疫缓存） */
const TRACE_SOURCE: HttpsTimeSource = {
  id: 'cloudflare-trace', url: 'https://www.cloudflare.com/cdn-cgi/trace', method: 'GET',
  parse: async (res) => {
    const m = /ts=(\d+(?:\.\d+)?)/.exec(await res.text())
    if (!m) throw new Error('time source: bad trace payload')
    return assertServerMs(Number(m[1]) * 1000)
  },
}

/** 大陆链源表（2026-11-10 家庭宽带实测序）：毫秒 API 在前（动态生成免疫 CDN 缓存） */
const SOURCES_CN: HttpsTimeSource[] = [
  {
    id: 'taobao-api', url: 'https://acs.m.taobao.com/gw/mtop.common.getTimestamp/', method: 'GET',
    parse: async (res) => {
      const t = Number((await res.json())?.data?.t)
      if (!Number.isFinite(t)) throw new Error('time source: bad taobao payload')
      return assertServerMs(t)
    },
  },
  {
    id: 'suning-api', url: 'https://f.m.suning.com/api/ct.do', method: 'GET',
    parse: async (res) => {
      const t = Number((await res.json())?.currentTime)
      if (!Number.isFinite(t)) throw new Error('time source: bad suning payload')
      return assertServerMs(t)
    },
  },
  { id: 'baidu', url: 'https://www.baidu.com', method: 'HEAD', parse: async (res) => parseDateHeader(res) },
  { id: 'qq', url: 'https://www.qq.com', method: 'HEAD', parse: async (res) => parseDateHeader(res) },
  { id: 'gitee', url: 'https://gitee.com', method: 'HEAD', parse: async (res) => parseDateHeader(res) },
  { id: 'jd', url: 'https://www.jd.com', method: 'HEAD', parse: async (res) => parseDateHeader(res) },
  TRACE_SOURCE,
]

/** 国际链源表（2026-11-13 实测）：动态源在前（毫秒 API → trace），Date 头源末位兜底
 *  （Date 头可能被 CDN 缓存致滞后——实测 apple.com 滞后 542s，故不作首选） */
const SOURCES_GLOBAL: HttpsTimeSource[] = [
  {
    id: 'timeapi', url: 'https://timeapi.io/api/time/current/zone?timeZone=UTC', method: 'GET',
    parse: async (res) => parseTimeApiComponents(res),
  },
  TRACE_SOURCE,
  { id: 'cloudflare-204', url: 'https://cp.cloudflare.com/generate_204', method: 'HEAD', parse: async (res) => parseDateHeader(res) },
  { id: 'microsoft', url: 'https://www.microsoft.com', method: 'HEAD', parse: async (res) => parseDateHeader(res) },
]

/** 剖面 → 源表 */
function sourcesFor(profile: TimeSourceProfile): HttpsTimeSource[] {
  return profile === 'global' ? SOURCES_GLOBAL : SOURCES_CN
}

/** 源序校准：preferred 置顶（非法 id 跳过按内置序兜底），前源失败继续，全败 reject。
 * profile 决定内置源链（'cn' 大陆链 / 'global' 国际链）；非本链的 preferred id 视为非法 */
export async function calibrateNetworkTime(preferredSourceId: string | null, profile: TimeSourceProfile = 'cn'): Promise<CalibrateResult> {
  const sources = sourcesFor(profile)
  const chain = httpsTimeSourceIds(profile)
  const order: string[] = preferredSourceId ? [preferredSourceId, ...chain.filter((id) => id !== preferredSourceId)] : [...chain]
  const startedAt = Date.now()
  for (const id of order) {
    if (Date.now() - startedAt > TOTAL_TIMEOUT_MS) break
    const src = sources.find((s) => s.id === id)
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
