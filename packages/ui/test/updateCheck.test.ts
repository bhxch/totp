import { afterEach, describe, expect, it, vi } from 'vitest'
import { CloudHttpError, __resetCloudFetchForTest, setCloudFetch, type CloudFetchImpl } from '@totp/core'
import { compareVersions, fetchLatestRelease, normalizeVersionTag } from '../src/updateCheck'

afterEach(() => {
  __resetCloudFetchForTest()
})

describe('normalizeVersionTag', () => {
  it('剥前导 v/V；无前缀原样返回', () => {
    expect(normalizeVersionTag('v1.0.2')).toBe('1.0.2')
    expect(normalizeVersionTag('V2.0.0')).toBe('2.0.0')
    expect(normalizeVersionTag('1.0.2')).toBe('1.0.2')
  })
})

describe('compareVersions', () => {
  it('相等/大于/小于', () => {
    expect(compareVersions('1.0.2', '1.0.2')).toBe(0)
    expect(compareVersions('1.1.0', '1.0.9')).toBe(1)
    expect(compareVersions('0.9.9', '1.0.0')).toBe(-1)
  })

  it('段数不齐按 0 补齐；非数字段按 0 处理', () => {
    expect(compareVersions('1.0', '1.0.0')).toBe(0)
    expect(compareVersions('1', '0.9')).toBe(1)
    expect(compareVersions('1.0.x', '1.0.0')).toBe(0)
  })
})

describe('fetchLatestRelease', () => {
  const jsonBody = (obj: unknown): CloudFetchImpl => async (_label, _url, init) => {
    return new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json' } })
  }

  it('GET api.github.com releases/latest，请求头带 Accept 与 User-Agent（桌面 reqwest 无默认 UA，GitHub 缺失返 403）', async () => {
    const impl = vi.fn(jsonBody({ tag_name: 'v1.0.3', html_url: 'https://github.com/bhxch/totp/releases/tag/v1.0.3' }))
    setCloudFetch(impl)
    await fetchLatestRelease()
    expect(impl).toHaveBeenCalledTimes(1)
    const [label, url, init] = impl.mock.calls[0] as [string, string, RequestInit]
    expect(label).toBe('UpdateCheck')
    expect(url).toBe('https://api.github.com/repos/bhxch/totp/releases/latest')
    expect(init.method).toBe('GET')
    expect((init.headers as Record<string, string>)['User-Agent']).toBe('totp-app')
    expect((init.headers as Record<string, string>).Accept).toContain('application/vnd.github+json')
  })

  it('解析 tag 去 v 前缀；html_url 作外链', async () => {
    setCloudFetch(jsonBody({ tag_name: 'v1.1.0', html_url: 'https://github.com/bhxch/totp/releases/tag/v1.1.0' }))
    expect(await fetchLatestRelease()).toEqual({
      version: '1.1.0',
      url: 'https://github.com/bhxch/totp/releases/tag/v1.1.0',
    })
  })

  it('html_url 缺失兜底 releases 列表页', async () => {
    setCloudFetch(jsonBody({ tag_name: 'v1.1.0' }))
    const r = await fetchLatestRelease()
    expect(r.url).toBe('https://github.com/bhxch/totp/releases')
  })

  it('非 2xx 抛 CloudHttpError（携带 status 供结构化判定，如 403 限额）', async () => {
    setCloudFetch(async () => new Response('rate limited', { status: 403 }))
    const err = await fetchLatestRelease().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(CloudHttpError)
    expect((err as CloudHttpError).status).toBe(403)
  })

  it('响应缺 tag_name 抛错', async () => {
    setCloudFetch(jsonBody({}))
    await expect(fetchLatestRelease()).rejects.toThrow('tag_name')
  })
})
