/**
 * desktop 装配内核（R13 样板收敛，纯合并不建新层）：5 个平台/装配模块
 * （backupPlatform/cloudPlatforms/autoBackup/securityPlatform/desktopShell）共用的
 * store/adapter 访问样板单点——
 * - requireStore/requireAdapter：就绪断言（未就绪统一「数据尚未就绪」中文报错，卡片展示契约）；
 * - storeGuards：守护闭包三件套（isLocked/getSecret/getVaultJson，store 未就绪时 locked 兜底
 *   true——decideAutoRun skip / idleLock 恒不动作，锁定态/未初始化永不自动写）；
 * - kdfProfileOf：备份加密档位读取（store 未就绪兜底 balanced）。
 * 仅类型依赖 @totp/core|ui（运行时零导入，宿主测试对 '@totp/ui' 的窄 mock 不受影响）。
 */
import type { KdfProfile, StorageAdapter } from '@totp/core'
import type { VueStore } from '@totp/ui'

/** 就绪断言消息常量：平台方法在 store/adapter 未就绪时的统一中文报错（卡片展示） */
export const NOT_READY_MESSAGE = '数据尚未就绪'

/** store 就绪断言（securityPlatform/desktopShell 等共用；未就绪抛 NOT_READY_MESSAGE） */
export function requireStore(getStore: () => VueStore | null): VueStore {
  const s = getStore()
  if (!s) throw new Error(NOT_READY_MESSAGE)
  return s
}

/** adapter 就绪断言（backupPlatform/cloudPlatforms/autoBackup/desktopShell 共用） */
export function requireAdapter(getAdapter: () => StorageAdapter | null): StorageAdapter {
  const a = getAdapter()
  if (!a) throw new Error(NOT_READY_MESSAGE)
  return a
}

/** 守护闭包三件套（decideAutoRun 守护源 / idleLock isLocked 同口径）：
 *  store 未就绪时 isLocked 兜底 true（永不自动写/永不动作）、getSecret 兜底 null、
 *  getVaultJson 兜底 'null'（JSON.stringify(null)） */
export interface StoreGuards {
  /** 锁定态（未就绪=锁定：守护侧 fail-closed） */
  isLocked(): boolean
  /** 会话备份口令（null=无） */
  getSecret(): string | null
  /** 当前 vault JSON 快照（unchanged 判定/备份本体用） */
  getVaultJson(): string
}

export function storeGuards(getStore: () => VueStore | null): StoreGuards {
  return {
    isLocked: () => getStore()?.locked.value ?? true,
    getSecret: () => getStore()?.backupSecret.value ?? null,
    getVaultJson: () => JSON.stringify(getStore()?.vault ?? null),
  }
}

/** 备份加密强度档位（plan16 T11.5）：本地备份/云上传 envelope 按此档位生成；store 未就绪兜底 balanced */
export function kdfProfileOf(getStore: () => VueStore | null): KdfProfile {
  return getStore()?.settings.backupKdfProfile ?? 'balanced'
}
