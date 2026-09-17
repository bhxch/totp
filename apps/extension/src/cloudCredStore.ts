/**
 * 云多目标凭据/基线存取（extension 宿主实现，纯逻辑可测）：作用于 StorageAdapter
 * （storage.local JSON 键），语义与 desktop App.vue 的 *Impl 一致（Task 8 迁移约定，
 * 见 ui cloudPlatform.ts 注释块）：
 * - 新键 cloudCreds（JSON CloudTarget[]）/ cloudRevs（JSON Record<backend,string>）；
 *   旧键 cloudCred / cloudRev 只在读取时回退、保存后删除，绝不把旧值写入新键。
 * - 坏 JSON 一律安全默认（凭据→[]、基线→无）。
 * - 与 desktop 的差异：不维护 cloudRevs 进程内缓存——storage.local 读取廉价，且
 *   options/popup 双上下文并发写（CloudCard 手动同步与自动 runner）下直读更不易陈旧。
 */
import { conflictBackupFileName, type CloudCred, type StorageAdapter } from '@totp/core'
import type { CloudTarget } from '@totp/ui'

const CLOUD_CRED_KEY = 'cloudCred'
const CLOUD_CREDS_KEY = 'cloudCreds'
const CLOUD_REV_KEY = 'cloudRev'
const CLOUD_REVS_KEY = 'cloudRevs'

/** 多目标冲突副本名：conflict-{backendKey}-{yyyyMMdd-HHmmss}.totpbackup——与 desktop backupService
 *  同构（core conflictBackupFileName 取 conflict- 后缀段拼接），匹配 READABLE_BACKUP_RE 的可选
 *  backend 段，跨宿主备份列表均可恢复；backendKey 缺省保持旧名格式 */
export function conflictBackupName(backendKey: string | undefined, now: Date): string {
  const base = conflictBackupFileName(now)
  return backendKey ? `conflict-${backendKey}-${base.slice('conflict-'.length)}` : base
}

/** 自动状态 JSON → 卡片展示文本（design §4.1）：「YYYY-MM-DD HH:mm 成功/失败/跳过：summary」；
 *  缺字段/坏 JSON/undefined → null（卡片显示「暂无」）。ok=null 渲染「跳过」（写侧 summary 仅存原因，
 *  前缀由本函数拼装）；旧 JSON 的 ok 恒为 true/false，照常渲染成功/失败。
 *  与 desktop autoBackup.formatAutoStatusText 同款语义：options App.vue formatAutoStatus 委托本实现，
 *  抽出供三态单测（审查 Minor-2，放 cloudCredStore 因同属 cloud 存储域纯逻辑可测模块） */
export function formatAutoStatusText(raw: string | undefined): string | null {
  if (!raw) return null
  try {
    const s = JSON.parse(raw) as { at?: unknown; ok?: unknown; summary?: unknown }
    if (typeof s.at !== 'number' || typeof s.summary !== 'string' || s.summary === '') return null
    const d = new Date(s.at)
    const p = (n: number) => String(n).padStart(2, '0')
    const label = s.ok === null ? '跳过' : s.ok === true ? '成功' : '失败'
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())} ${label}：${s.summary}`
  } catch {
    return null
  }
}

export function createCloudCredStore(adapter: StorageAdapter): {
  loadCreds(): Promise<CloudTarget[]>
  saveCreds(t: CloudTarget[]): Promise<void>
  loadTargetHash(backend: string): Promise<string | null>
  saveTargetHash(backend: string, hash: string | null): Promise<void>
} {
  /** cloudCreds 缺失而旧 cloudCred 存在 → 视为唯一启用目标（只读回退，不回写新键） */
  async function loadCreds(): Promise<CloudTarget[]> {
    try {
      const raw = await adapter.get(CLOUD_CREDS_KEY)
      if (raw) return JSON.parse(raw) as CloudTarget[]
      const legacy = await adapter.get(CLOUD_CRED_KEY)
      return legacy ? [{ cred: JSON.parse(legacy) as CloudCred, enabled: true }] : []
    } catch {
      return [] // 坏 JSON/读取失败 → 安全默认（与 desktop 同口径：新键损坏不回退旧键）
    }
  }

  /** 只写新键并删除旧键（旧键已无时删除幂等） */
  async function saveCreds(targets: CloudTarget[]): Promise<void> {
    await adapter.set(CLOUD_CREDS_KEY, JSON.stringify(targets))
    await adapter.delete(CLOUD_CRED_KEY)
  }

  async function loadTargetHash(backend: string): Promise<string | null> {
    let revs: Record<string, string> | null
    try {
      const raw = await adapter.get(CLOUD_REVS_KEY)
      revs = raw ? (JSON.parse(raw) as Record<string, string>) : null
    } catch {
      revs = null // 坏 JSON 按无新键处理
    }
    if (revs && revs[backend] !== undefined) return revs[backend] ?? null
    if (revs !== null) return null // 新键存在但无该 backend → 无基线（不吃旧键）
    // 迁移回退：cloudRevs 缺失且旧 cloudRev 存在 → 仅首个目标（targets[0]）继承旧基线；不回写新键
    try {
      const legacy = await adapter.get(CLOUD_REV_KEY)
      if (!legacy) return null
      const targets = await loadCreds()
      return targets[0]?.cred.backend === backend ? legacy : null
    } catch {
      return null
    }
  }

  async function saveTargetHash(backend: string, hash: string | null): Promise<void> {
    let revs: Record<string, string> = {}
    try {
      const raw = await adapter.get(CLOUD_REVS_KEY)
      if (raw) revs = JSON.parse(raw) as Record<string, string>
    } catch {
      revs = {} // 坏 JSON → 视为空基线重建
    }
    if (hash === null) delete revs[backend] // null 语义=删除该 backend 的基线键（非写入 null 值）
    else revs[backend] = hash
    await adapter.set(CLOUD_REVS_KEY, JSON.stringify(revs))
    await adapter.delete(CLOUD_REV_KEY) // 迁移约定：保存只写新键并删除旧键（幂等）
  }

  return { loadCreds, saveCreds, loadTargetHash, saveTargetHash }
}
