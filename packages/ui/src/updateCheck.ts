/**
 * 设置页「关于」卡的版本更新检查（settingsPage.about）：
 * 经宿主注入的 cloudFetch 通道出网（扩展=background SW 代理 fetch，桌面=Rust reqwest command），
 * 与云同步同一条网络路径，零新增权限/CSP 改动。
 */
import { cloudFetch, ensureHttpOk } from '@totp/core'

/** 本项目 GitHub 仓库（releases 由 push v* tag 的 CI 自动发布） */
export const GITHUB_REPO = 'bhxch/totp'

const LABEL = 'UpdateCheck'
const LATEST_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`

/** GitHub API 要求所有请求携带 User-Agent（缺失返回 403）：浏览器 fetch 自带默认 UA，
 *  桌面 reqwest 无默认 UA，显式补齐（headers 两端宿主通道均原样透传） */
const REQUEST_HEADERS = { Accept: 'application/vnd.github+json', 'User-Agent': 'totp-app' }

export interface LatestRelease {
  /** 语义化版本（tag 去 v 前缀，如 '1.0.3'） */
  version: string
  /** release 页面地址（外链用） */
  url: string
}

interface GithubLatestResponse {
  tag_name?: unknown
  html_url?: unknown
}

/** tag 规范化为语义化版本：剥前导 v/V（'v1.0.2' → '1.0.2'） */
export function normalizeVersionTag(tag: string): string {
  return /^[vV]/.test(tag) ? tag.slice(1) : tag
}

/** 三段式版本比较（本项目版本均为 x.y.z；缺段按 0 补齐，非数字段按 0 处理）：
 *  a>b 返回 1，a<b 返回 -1，相等返回 0 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((s) => Number.parseInt(s, 10))
  const pb = b.split('.').map((s) => Number.parseInt(s, 10))
  const seg = (arr: number[], i: number): number => (Number.isFinite(arr[i]) ? arr[i]! : 0)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const va = seg(pa, i)
    const vb = seg(pb, i)
    if (va !== vb) return va > vb ? 1 : -1
  }
  return 0
}

/** 拉取 GitHub 最新 release（匿名 GET releases/latest，不含任何用户数据；
 *  限额：未认证 60 次/小时/IP，手动按钮触发频率远低于此） */
export async function fetchLatestRelease(): Promise<LatestRelease> {
  const res = await cloudFetch(LABEL, LATEST_URL, { method: 'GET', headers: { ...REQUEST_HEADERS } })
  await ensureHttpOk(LABEL, res, 'GET')
  const json = (await res.json()) as GithubLatestResponse
  if (typeof json.tag_name !== 'string' || json.tag_name.trim() === '') {
    throw new Error('响应缺少 tag_name 字段')
  }
  const version = normalizeVersionTag(json.tag_name.trim())
  const url = typeof json.html_url === 'string' && json.html_url !== ''
    ? json.html_url
    : `https://github.com/${GITHUB_REPO}/releases`
  return { version, url }
}
