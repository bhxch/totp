import type { AppSettings, KdfProfile } from '@totp/core'
import type { ComputedRef, Ref } from 'vue'

/** 锁定策略偏好（设计 §1 锁定策略四触发器中用户可配置的三项；宿主从 AppSettings 映射） */
export type LockPrefs = Pick<AppSettings, 'lockOnRestart' | 'lockIdleMinutes' | 'lockOnSystemLock'>

/** Passkey(PRF) 解锁管理（宿主从 store 闭包绑定；WebAuthn 交互由宿主侧 prf.ts 承载） */
export interface PasskeyUnlockOps {
  /** 已绑定凭据列表（渲染与移除参数；credentialId 为 base64url(rawId)） */
  sources: ComputedRef<{ credentialId: string }[]>
  /** 当前浏览器是否支持 PRF（SecurityCard 用于渲染判定与提示） */
  prfSupported(): Promise<boolean>
  /** 创建 passkey 并绑定到 DEK（含 WebAuthn 创建弹窗）；用户取消/认证器不支持 PRF → false */
  add(): Promise<boolean>
  /** 移除指定绑定（core 守卫：移除后无任何解锁方式时抛错） */
  remove(credentialId: string): Promise<void>
}

/** OS 自动解锁（计划 15 T14 三平台统一通道，Windows=DPAPI / macOS=Keychain / Linux=Secret Service；
 *  仅 desktop 宿主提供；extension 无此能力 → 相关 UI 隐藏）。
 *  wrappedDekD 语义（计划 11 T1 裁定）：OS 保护直接包裹 DEK 本体，base64 进出；
 *  kekSources kind 仍为 'dpapi'（存储兼容） */
export interface DpapiUnlockOps {
  /** 本通道按端显示名（宿主注入：「Windows 自动解锁」/「钥匙串自动解锁」/「密钥环自动解锁」）；
   *  SecurityCard 行/按钮/成功消息与 LockScreen 重试按钮统一取用，UI 内不再硬编码平台名 */
  label: string
  /** [可选] 已绑定行的技术标注（宿主按端注入：Windows「（DPAPI）」/mac「（Keychain）」/linux「（Secret Service）」）；
   *  未注入时 SecurityCard 回退「（DPAPI）」与 Windows 现状逐字一致 */
  techSuffix?: string
  /** 当前已绑定的 DPAPI 来源（null=未启用；LockScreen 静默解锁与 SecurityCard 渲染判定用） */
  source: ComputedRef<{ wrappedDekD: string } | null>
  /** 当前解锁态持有的 DEK（启用包装用；锁定/未启用返回 null） */
  getCurrentDek(): Uint8Array | null
  /** OS 包裹：DEK 字节 → base64(wrappedDekD)（desktop 经 Rust os_auto_protect，Windows 下即 DPAPI） */
  protect(dek: Uint8Array): Promise<string>
  /** OS 解包：base64(wrappedDekD) → DEK 字节（desktop 经 Rust os_auto_unprotect；跨机器/跨用户失败由调用方静默处理） */
  unprotect(wrapped: string): Promise<Uint8Array>
  /** 绑定来源（store addDpapiSourceOp：withDpapiSource + security 落盘） */
  add(wrappedDekD: string): Promise<void>
  /** 移除来源（core 守卫：移除后无任何解锁方式时抛错） */
  remove(): Promise<void>
}

/** 加密状态与操作（宿主从 store 闭包绑定；desktop/options 各自组装） */
export interface SecurityOps {
  /** 是否处于锁定态（真值时卡片只提示，解锁入口由主 LockScreen 承担） */
  locked: Ref<boolean>
  /** 是否已启用落盘加密 */
  hasEncryption: ComputedRef<boolean>
  /** 启用加密（以当前 vault 建立口令 KEK） */
  enableEncryption(password: string): Promise<void>
  /** 关闭加密（回明文存储） */
  disableEncryption(): Promise<void>
  /** 更换口令/调整 KDF 档位（plan16 T11）：opts 缺省 rotateDek=true（改口令即被动轮换，prf/dpapi 来源失效待重绑）；
   *  档位切换走 { rotateDek: false, profile }（重 wrap 立即生效，数据无需重加密，口令不变） */
  changePassphrase(newPassword: string, opts?: { rotateDek?: boolean; profile?: KdfProfile }): Promise<void>
  /** 当前 KDF 档位（宿主从 store.securitySettings 映射，缺省 'balanced'；SecurityCard 档位行展示用） */
  kdfProfile: Readonly<Ref<KdfProfile>>
  /** 主口令最近更换时间（宿主从 store.securitySettings 映射；null=未记录，SecurityCard 天数提示用） */
  passwordChangedAt: Readonly<Ref<number | null>>
  /** [可选] Passkey(PRF) 解锁管理；未提供时 SecurityCard 隐藏 prf 相关渲染 */
  passkey?: PasskeyUnlockOps
}

/**
 * 安全卡平台能力（由宿主注入）。SecurityCard 只依赖此接口，
 * platform 为 null 时整卡不渲染（popup 零影响）；
 * security 为 null 时仅渲染通用设置区（剪贴板/弹窗延迟）。
 */
export interface SecurityPlatform {
  /** 加密状态与操作；popup 等不暴露安全管理的端传 null */
  security: SecurityOps | null
  /** [可选] OS 自动解锁（Windows=DPAPI / macOS=Keychain / Linux=Secret Service）；仅 desktop 提供，未提供时 SecurityCard/LockScreen 隐藏该能力（extension 无） */
  dpapi?: DpapiUnlockOps
  /** 解锁方式按端命名（宿主注入；缺省 Passkey，osAutoLabel null=该端无原生自动解锁） */
  unlockNaming?: { prfLabel: string; osAutoLabel: string | null }
  /** 复制后 30s 自动清空剪贴板开关（当前值） */
  clipboardClearEnabled: ComputedRef<boolean>
  /** 切换剪贴板清空开关（宿主写 settings + 持久化） */
  setClipboardClear(v: boolean): Promise<void>
  /** [可选] popup「已复制」后自动关闭延迟毫秒数（仅 extension 提供；desktop 无 popup 不渲染该输入） */
  popupCloseDelayMs?: ComputedRef<number>
  /** [可选] 修改弹窗关闭延迟（宿主写 settings + 持久化） */
  setPopupCloseDelay?(ms: number): Promise<void>
  /** [可选] 锁定策略偏好（设计 §1；宿主映射 AppSettings 三字段读写）。未提供时 SecurityCard 锁定策略区不渲染 */
  lockPrefs?: {
    get(): LockPrefs | Promise<LockPrefs>
    /** 任一控件变更即以完整对象覆写（避免宿主端部分更新歧义） */
    set(p: LockPrefs): void | Promise<void>
  }
}
