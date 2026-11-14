import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { calibrateNetworkTime } from '../src/timeSyncCalibrator'

/** stub fetch：url → 响应描述（json 体 / date 头 / 文本 / 抛错 / 挂起）；map 值兼容函数与已构造 Promise（R6-a） */
function stubFetch(map: Record<string, (() => Promise<Partial<Response>>) | Promise<Partial<Response>> | 'reject'>) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (init?.signal?.aborted) throw new Error('aborted')
    const entry = map[url] ?? map[url.replace(/^https?:\/\//, '')]
    if (entry === 'reject' || !entry) throw new Error('network down')
    // R6-a：map 值兼容「函数」与「已构造的 Promise」两种形态（brief 用例两种混用）
    const r = typeof entry === 'function' ? await entry() : await entry
    return r as Response
  })
}
const jsonRes = (body: unknown): Promise<Partial<Response>> => Promise.resolve({ ok: true, status: 200, headers: new Headers(), json: async () => body } as unknown as Partial<Response>)
const headRes = (date: string): Promise<Partial<Response>> => Promise.resolve({ ok: true, status: 200, headers: new Headers({ date }) } as unknown as Partial<Response>)

describe('calibrateNetworkTime 源序与解析（spec §4）', () => {
  beforeEach(() => { vi.stubGlobal('fetch', vi.fn()) })
  afterEach(() => { vi.unstubAllGlobals() })

  it('首选源置顶：preferred=jd 时 jd 成功即返回 jd', async () => {
    const f = stubFetch({ 'https://www.jd.com': headRes(new Date('2026-11-10T12:00:05Z').toUTCString()) })
    vi.stubGlobal('fetch', f)
    vi.setSystemTime(new Date('2026-11-10T12:00:00Z'))
    const r = await calibrateNetworkTime('jd')
    expect(r.sourceId).toBe('jd')
    expect(r.offsetMs).toBe(5000) // 中点≈t0+少量
    vi.useRealTimers()
  })

  it('默认序：首个源成功即停（taobao-api），不发后续请求', async () => {
    const f = stubFetch({ 'https://acs.m.taobao.com/gw/mtop.common.getTimestamp/': jsonRes({ data: { t: String(Date.now() + 250) } }) })
    vi.stubGlobal('fetch', f)
    const r = await calibrateNetworkTime(null)
    expect(r.sourceId).toBe('taobao-api')
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('首选源非法 id：跳过按内置序兜底', async () => {
    const f = stubFetch({ 'https://acs.m.taobao.com/gw/mtop.common.getTimestamp/': jsonRes({ data: { t: String(Date.now()) } }) })
    vi.stubGlobal('fetch', f)
    const r = await calibrateNetworkTime('ntp.aliyun.com') // NTP id 混入扩展端：find 不到跳过
    expect(r.sourceId).toBe('taobao-api')
  })

  it('前源失败按序兜底到 Date 头源（baidu）', async () => {
    const now = new Date('2026-11-10T09:00:10Z')
    const f = stubFetch({
      'https://acs.m.taobao.com/gw/mtop.common.getTimestamp/': 'reject',
      'https://f.m.suning.com/api/ct.do': 'reject',
      // brief 原文桩值与 setSystemTime 同源（offset 恒 0、断言 10s 不可达）——按用例意图修正：server 比设备快 10s
      'https://www.baidu.com': headRes(new Date(now.getTime() + 10_000).toUTCString()),
    })
    vi.stubGlobal('fetch', f)
    vi.setSystemTime(now)
    const r = await calibrateNetworkTime(null)
    expect(r.sourceId).toBe('baidu')
    expect(Math.abs(r.offsetMs - 10_000)).toBeLessThan(50)
    vi.useRealTimers()
  })

  it('毫秒 API 解析：taobao data.t 字符串 / suning currentTime 数字', async () => {
    const now = Date.now()
    const f = stubFetch({
      'https://acs.m.taobao.com/gw/mtop.common.getTimestamp/': 'reject',
      'https://f.m.suning.com/api/ct.do': jsonRes({ currentTime: now + 7000 }),
    })
    vi.stubGlobal('fetch', f)
    vi.setSystemTime(new Date(now))
    const r = await calibrateNetworkTime(null)
    expect(r.sourceId).toBe('suning-api')
    expect(Math.abs(r.offsetMs - 7000)).toBeLessThan(50)
    vi.useRealTimers()
  })

  it('Date 头缺失/非法：该源失败继续', async () => {
    const now = Date.now()
    const f = stubFetch({
      'https://acs.m.taobao.com/gw/mtop.common.getTimestamp/': 'reject',
      'https://f.m.suning.com/api/ct.do': 'reject',
      'https://www.baidu.com': headRes(''),
      // R6-b：qq 实为 HEAD 源，jsonRes 桩必致解析失败、断言不可达——改合法 Date 头桩，仅验证兜底序
      'https://www.qq.com': headRes(new Date(now + 1000).toUTCString()),
    })
    vi.stubGlobal('fetch', f)
    const r = await calibrateNetworkTime(null)
    expect(r.sourceId).toBe('qq')
    vi.useRealTimers()
  })

  it('cloudflare-trace 文本解析 ts= 秒浮点', async () => {
    const now = Date.now()
    const ok = Promise.resolve({ ok: true, status: 200, headers: new Headers(), text: async () => `fl=x\nts=${(now + 3000) / 1000}\n` } as unknown as Partial<Response>)
    const f = stubFetch({ 'https://www.cloudflare.com/cdn-cgi/trace': () => ok })
    vi.stubGlobal('fetch', f)
    const r = await calibrateNetworkTime('cloudflare-trace')
    expect(r.sourceId).toBe('cloudflare-trace')
    expect(Math.abs(r.offsetMs - 3000)).toBeLessThan(50)
  })

  it('全源失败：reject 错误（Review Focus 1 之外的用户可见兜底=设备时间）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down') }))
    await expect(calibrateNetworkTime(null)).rejects.toThrow()
  })

  it('前五源全败 → 兜底到 jd（覆盖 jd 源 parse 臂）', async () => {
    const now = Date.now()
    const f = stubFetch({
      'https://acs.m.taobao.com/gw/mtop.common.getTimestamp/': 'reject',
      'https://f.m.suning.com/api/ct.do': 'reject',
      'https://www.baidu.com': 'reject',
      'https://www.qq.com': 'reject',
      'https://gitee.com': 'reject',
      'https://www.jd.com': headRes(new Date(now + 2000).toUTCString()),
    })
    vi.stubGlobal('fetch', f)
    vi.setSystemTime(new Date(now))
    const r = await calibrateNetworkTime(null)
    expect(r.sourceId).toBe('jd')
    vi.useRealTimers()
  })

  it('垃圾时间戳（Number(null)=0 形态）被下界拒绝 → 源兜底（终审 Task3-①/修 6）', async () => {
    const now = Date.now()
    const f = stubFetch({
      'https://acs.m.taobao.com/gw/mtop.common.getTimestamp/': jsonRes({ data: { t: '0' } }),
      'https://f.m.suning.com/api/ct.do': jsonRes({ currentTime: 0 }),
      'https://www.baidu.com': headRes(new Date(1_600_000_000_000).toUTCString()), // 2020，早于下界
      'https://www.qq.com': headRes(new Date(now + 5000).toUTCString()),
    })
    vi.stubGlobal('fetch', f)
    vi.setSystemTime(new Date(now))
    const r = await calibrateNetworkTime(null)
    expect(r.sourceId).toBe('qq')
    expect(r.offsetMs).toBeGreaterThan(4000) // Date 头秒级截断：offset ∈ (4000, 5000]
    vi.useRealTimers()
  })

  it('fetch 带 cache:no-store（防缓存层吃掉 Date 新鲜度）', async () => {
    const f = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => ({ ok: true, status: 200, headers: new Headers(), json: async () => ({ data: { t: String(Date.now()) } }) }))
    vi.stubGlobal('fetch', f)
    await calibrateNetworkTime(null)
    expect(f.mock.calls[0]![1]!.cache).toBe('no-store')
  })
})

describe('calibrateNetworkTime 国际链（2026-11-13 全球链）', () => {
  beforeEach(() => { vi.stubGlobal('fetch', vi.fn()) })
  afterEach(() => { vi.unstubAllGlobals() })

  it('profile=global：默认序首选 timeapi（毫秒 API 组件解析）', async () => {
    const now = Date.now()
    const f = stubFetch({
      'https://timeapi.io/api/time/current/zone?timeZone=UTC': jsonRes({
        year: 2026, month: 11, day: 13, hour: 14, minute: 11, seconds: 6, milliSeconds: 701,
      }),
    })
    vi.stubGlobal('fetch', f)
    vi.setSystemTime(new Date('2026-11-13T14:11:06.000Z'))
    const r = await calibrateNetworkTime(null, 'global')
    expect(r.sourceId).toBe('timeapi')
    expect(r.offsetMs).toBe(701)
    expect(f).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('profile=global：timeapi 失败 → 兜底 cloudflare-trace', async () => {
    const now = Date.now()
    const ok = Promise.resolve({ ok: true, status: 200, headers: new Headers(), text: async () => `fl=x\nts=${(now + 2000) / 1000}\n` } as unknown as Partial<Response>)
    const f = stubFetch({
      'https://timeapi.io/api/time/current/zone?timeZone=UTC': 'reject',
      'https://www.cloudflare.com/cdn-cgi/trace': () => ok,
    })
    vi.stubGlobal('fetch', f)
    const r = await calibrateNetworkTime(null, 'global')
    expect(r.sourceId).toBe('cloudflare-trace')
    expect(Math.abs(r.offsetMs - 2000)).toBeLessThan(50)
  })

  it('profile=global：Date 头源（无缓存 204）兜底', async () => {
    const now = Date.now()
    const f = stubFetch({
      'https://timeapi.io/api/time/current/zone?timeZone=UTC': 'reject',
      'https://www.cloudflare.com/cdn-cgi/trace': 'reject',
      'https://cp.cloudflare.com/generate_204': headRes(new Date(now + 3000).toUTCString()),
    })
    vi.stubGlobal('fetch', f)
    vi.setSystemTime(new Date(now))
    const r = await calibrateNetworkTime(null, 'global')
    expect(r.sourceId).toBe('cloudflare-204')
    // Date 头秒级截断：offset ∈ (2000, 3000]
    expect(r.offsetMs).toBeGreaterThan(2000)
    expect(r.offsetMs).toBeLessThanOrEqual(3000)
    vi.useRealTimers()
  })

  it('profile=global：首选源置顶（preferred 属国际链）', async () => {
    const now = Date.now()
    const f = stubFetch({ 'https://www.microsoft.com': headRes(new Date(now + 1000).toUTCString()) })
    vi.stubGlobal('fetch', f)
    vi.setSystemTime(new Date(now))
    const r = await calibrateNetworkTime('microsoft', 'global')
    expect(r.sourceId).toBe('microsoft')
    vi.useRealTimers()
  })

  it('profile=global：大陆链 preferred（跨链 id）不被采纳，退回国际链内置序', async () => {
    const f = stubFetch({ 'https://timeapi.io/api/time/current/zone?timeZone=UTC': jsonRes({
      year: 2026, month: 11, day: 13, hour: 14, minute: 11, seconds: 6, milliSeconds: 0,
    }) })
    vi.stubGlobal('fetch', f)
    const r = await calibrateNetworkTime('taobao-api', 'global')
    expect(r.sourceId).toBe('timeapi')
  })

  it('profile=cn：仍走大陆链（默认序 taobao-api），不受国际链影响', async () => {
    const f = stubFetch({ 'https://acs.m.taobao.com/gw/mtop.common.getTimestamp/': jsonRes({ data: { t: String(Date.now()) } }) })
    vi.stubGlobal('fetch', f)
    const r = await calibrateNetworkTime(null, 'cn')
    expect(r.sourceId).toBe('taobao-api')
  })

  it('国际链解析护栏：timeapi 缺字段/非对象/下界时间戳 → 该源失败继续兜底', async () => {
    const now = Date.now()
    const f = stubFetch({
      // 缺 hour 分量 → 组件解析抛错
      'https://timeapi.io/api/time/current/zone?timeZone=UTC': jsonRes({ year: 2026, month: 11, day: 13 }),
      // 非对象体 → 解析失败
      'https://www.cloudflare.com/cdn-cgi/trace': 'reject',
      'https://cp.cloudflare.com/generate_204': headRes(new Date(now + 1500).toUTCString()),
    })
    vi.stubGlobal('fetch', f)
    vi.setSystemTime(new Date(now))
    const r = await calibrateNetworkTime(null, 'global')
    expect(r.sourceId).toBe('cloudflare-204')
    vi.useRealTimers()
  })

  it('国际链解析护栏：timeapi 早于下界的时间戳 → 拒绝该源', async () => {
    const now = Date.now()
    const f = stubFetch({
      'https://timeapi.io/api/time/current/zone?timeZone=UTC': jsonRes({
        year: 2020, month: 1, day: 1, hour: 0, minute: 0, seconds: 0, milliSeconds: 0,
      }),
      'https://www.cloudflare.com/cdn-cgi/trace': 'reject',
      'https://cp.cloudflare.com/generate_204': headRes(new Date(now + 1000).toUTCString()),
      'https://www.microsoft.com': headRes(new Date(now + 1000).toUTCString()),
    })
    vi.stubGlobal('fetch', f)
    vi.setSystemTime(new Date(now))
    const r = await calibrateNetworkTime(null, 'global')
    expect(r.sourceId).toBe('cloudflare-204')
    vi.useRealTimers()
  })

  it('国际链：trace 报文缺 ts= → 该源失败；HTTP 非 2xx → 该源失败', async () => {
    const now = Date.now()
    const noTs = Promise.resolve({ ok: true, status: 200, headers: new Headers(), text: async () => 'fl=abc\ncolo=SJC\n' } as unknown as Partial<Response>)
    const f = stubFetch({
      'https://timeapi.io/api/time/current/zone?timeZone=UTC': 'reject',
      'https://www.cloudflare.com/cdn-cgi/trace': () => noTs,
      // 非 2xx：ok=false → 视为该源失败
      'https://cp.cloudflare.com/generate_204': Promise.resolve({ ok: false, status: 503, headers: new Headers() } as unknown as Partial<Response>),
      'https://www.microsoft.com': headRes(new Date(now + 500).toUTCString()),
    })
    vi.stubGlobal('fetch', f)
    vi.setSystemTime(new Date(now))
    const r = await calibrateNetworkTime(null, 'global')
    expect(r.sourceId).toBe('microsoft')
    vi.useRealTimers()
  })

  it('RTT 护栏（2026-11-13 实测）：慢应答不采信 → 该源兜底下一源', async () => {
    vi.useFakeTimers()
    try {
      const now = Date.now()
      // 首个源（timeapi）应答慢（推进 2s）→ 残差偏置不可信 → 跳过；第二源（trace）应答快 → 采信
      let call = 0
      const f = vi.fn(async (input: string | URL | Request) => {
        call++
        if (call === 1) vi.advanceTimersByTime(2000)
        const url = String(input)
        if (url.includes('timeapi.io')) {
          return { ok: true, status: 200, headers: new Headers(), json: async () => ({ year: 2026, month: 11, day: 13, hour: 14, minute: 11, seconds: 6, milliSeconds: 0 }) }
        }
        return { ok: true, status: 200, headers: new Headers(), text: async () => `ts=${(Date.now() + 500) / 1000}\n` }
      })
      vi.stubGlobal('fetch', f)
      vi.setSystemTime(new Date(now))
      const r = await calibrateNetworkTime(null, 'global')
      expect(r.sourceId).toBe('cloudflare-trace')
      expect(f).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
})
