import type { CloudCred, CloudProxy, GDriveCred, GistCred, OneDriveCred, S3Cred, WebdavCred } from '@totp/core'
import { isPlaintextHttpUrl } from './cloudPlatform'

/**
 * 卡片基建共享层（R7）：六卡逐字重复的纯函数与常量单点化——
 * 源 id 工厂、云凭据草稿守卫/空白判定、非本机 http 明文判定、保留策略与定时间隔选项。
 * 只收「逐字同构」的基建；各卡分支差异（如 onKeepN 的落盘时机、Cloud/Backup 的 i18n 键域）留在卡内。
 */

/** 翻译函数口（vue-i18n Composer t 的最小结构子集，同 sourceDisplayNames 惯例） */
export type Translate = (key: string) => string

/** 源 id 工厂：优先 crypto.randomUUID（宿主安全上下文），jsdom 等缺失环境回落时间戳+随机段 */
export function newSourceId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `src-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/** 空白凭据工厂：字符串字段（含可选）一律空串，避免 undefined 传 MdTextField 触发 prop 警告；
 * 布尔可选字段不设键——isBlankCred 依赖「可选字段 undefined」判空白，置 false 会破坏空白直删语义。
 * 入参为 CloudCred['backend']（云源联合）：调用方（CloudCard）仅渲染云源，不会把 local 源传进来。 */
export function blankCred(b: CloudCred['backend']): CloudCred {
  switch (b) {
    case 'webdav': return { backend: 'webdav', serverUrl: '', username: '', password: '', objectPath: '' }
    case 's3': return { backend: 's3', region: '', bucket: '', accessKeyId: '', secretAccessKey: '', endpoint: '', prefix: '', sessionToken: '', objectPath: '' }
    case 'gist': return { backend: 'gist', token: '', gistId: '', objectPath: '' }
    case 'gdrive': return { backend: 'gdrive', accessToken: '', objectPath: '' }
    case 'onedrive': return { backend: 'onedrive', accessToken: '', objectPath: '' }
  }
}

/** 凭据是否空白（除 backend 外所有字段均为空串/undefined）：空白行从未持久化过 */
export function isBlankCred(cred: CloudCred): boolean {
  return Object.entries(cred).every(([k, v]) => k === 'backend' || v === undefined || v === '')
}

/** 按 backend 判别的凭据守卫：模板各类型字段区经局部变量 + 守卫窄化联合（草稿 kind 与源
 *  kind 恒一致——blankCred/addTarget/loadSources 均按源 kind 造副本），替代 v-if 对联合
 *  类型无法传递的 kind 判定（credDrafts[s.id] 每次索引独立求值，模板条件不参与窄化） */
export function isWebdavDraft(d: CloudCred | undefined): d is WebdavCred {
  return d?.backend === 'webdav'
}
export function isS3Draft(d: CloudCred | undefined): d is S3Cred {
  return d?.backend === 's3'
}
export function isGistDraft(d: CloudCred | undefined): d is GistCred {
  return d?.backend === 'gist'
}
export function isGDriveDraft(d: CloudCred | undefined): d is GDriveCred {
  return d?.backend === 'gdrive'
}
export function isOneDriveDraft(d: CloudCred | undefined): d is OneDriveCred {
  return d?.backend === 'onedrive'
}

/** gdrive/onedrive 草稿合并守卫（CloudCredFields 合并字段区/OAuth 模式切换共用；其余后端无 OAuth 模式） */
export function isOAuthCapableDraft(d: CloudCred | undefined): d is GDriveCred | OneDriveCred {
  return d?.backend === 'gdrive' || d?.backend === 'onedrive'
}

/** 草稿是否含非本机 http 明文地址（WebDAV serverUrl / S3 endpoint，其余后端无自定服务地址）：
 *  输入时即显示行内警告（可见性），保存时作为拦截条件（F11） */
export function hasPlaintextUrl(d: CloudCred): boolean {
  if (isWebdavDraft(d)) return isPlaintextHttpUrl(d.serverUrl)
  if (isS3Draft(d)) return isPlaintextHttpUrl(d.endpoint ?? '')
  return false
}

/**
 * 自定义代理地址校验（云-I2）：custom 模式保存前拦截空地址与非法格式——两者落库后该源每个
 * 请求都会在桌面 reqwest 侧失败（「custom 代理缺 url」/「代理地址无效」），此处前端即拦。
 * scheme 与 UI placeholder/桌面 Proxy::all 支持一致：http/https/socks5/socks5h；host 为空
 * （如 `http:/x`）同样判非法（reqwest 解析亦会失败）。返回错误码（映射 i18n 文案），
 * null=通过或非 custom 模式（none/system 无地址语义恒通过）。
 */
export function customProxyUrlError(proxy: CloudProxy | undefined): 'empty' | 'invalid' | null {
  if (proxy?.mode !== 'custom') return null
  const url = (proxy.url ?? '').trim()
  if (url === '') return 'empty'
  try {
    const u = new URL(url)
    if (!['http:', 'https:', 'socks5:', 'socks5h:'].includes(u.protocol) || u.hostname === '') return 'invalid'
  } catch {
    return 'invalid'
  }
  return null
}

/** 定时（自动同步/备份）间隔档位，value=分钟数（MdSelect number 直传回写，不经字符串转换）。
 *  label 键按卡片 i18n 域拼接（cloudCard/backupCard 两域现有文案逐字一致，键域归属不变） */
export function intervalOptions(t: Translate, domain: string): Array<{ value: number; label: string }> {
  return [
    { value: 15, label: t(`${domain}.interval15m`) },
    { value: 60, label: t(`${domain}.interval1h`) },
    { value: 360, label: t(`${domain}.interval6h`) },
    { value: 1440, label: t(`${domain}.intervalDaily`) },
  ]
}

/** 保留策略二选（MdSegmentedButton 选项，label 键按卡片 i18n 域拼接） */
export function retentionOptions(t: Translate, domain: string): Array<{ value: string; label: string }> {
  return [
    { value: 'overwrite', label: t(`${domain}.retentionOverwrite`) },
    { value: 'keep', label: t(`${domain}.retentionKeep`) },
  ]
}
