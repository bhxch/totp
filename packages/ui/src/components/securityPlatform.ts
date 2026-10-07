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

/** ABE 提权服务状态（Rust abe_status 返回体四字段，serde camelCase；desktop 宿主经 invoke 包装透传）：
 *  matchesCaller=false 时 boundPath/version 恒 undefined——失配者收到的是连接级错误 Resp 拿不到
 *  Status JSON，版本/绑定路径信息仅匹配者可见（服务侧审查裁定，前端失配态展示「需要重新绑定」即可）。
 *  注：Rust AbeStatusResult 另含 supported 字段，本层经 AbeOps.supported 表达，不在状态体重复 */
export interface AbeStatus {
  installed: boolean
  matchesCaller: boolean
  boundPath?: string
  version?: string
}

/** ABE 操作结果（remove）：ok=false 时 message 附服务侧原因 */
export interface AbeResult {
  ok: boolean
  message?: string
}

/** ABE 提权服务宿主操作集（plan p6 §0.3；desktop 宿主实现=Rust abe_* 命令 invoke 包装 +
 *  store 源 op 包装，extension 无此能力 → 不注入；SecurityCard 仅 supported=true 渲染） */
export interface AbeOps {
  supported: boolean
  /** 已绑定的 abe 标记源视图（R7-I2：null=源不在场。SecurityCard「已启用」态判定用——
   *  服务在（matchesCaller）但源不在（换口令轮换降级/半绑定态）≠ 已启用，须引导重绑；
   *  desktop 宿主映射 store.abeSource，形态同 DpapiUnlockOps.source（无载荷标记源） */
  source: ComputedRef<{ kind: 'abe' } | null>
  status(): Promise<AbeStatus | null>
  bind(): Promise<boolean>
  /** 服务侧 Wrap（C1 终审：绑定编排 bind→wrap→addSource 的 wrap 步）：当前 DEK →
   *  服务 HKLM WrappedDek——无此步锁屏 unwrap 恒 NoWrappedDek（ABE 通道端到端断裂）。
   *  失败折叠 false，折叠语义同 unwrap（任何管道/服务侧失败均非异常路径，调用方据
   *  false 中止绑定序列于 addSource 之前） */
  wrap(dek: Uint8Array): Promise<boolean>
  remove(): Promise<AbeResult>
  /** 绑定成功后 security.json abe 标记源落盘（宿主包装 store addAbeSourceOp；T6 UI 编排
   *  bind→wrap→addSource→刷新 status）。无载荷——密文由服务侧重包裹存 HKLM，源仅标记存在
   *  （对照 dpapi add 携带 wrappedDekD 载荷的差异是刻意收窄泄露面） */
  addSource(): Promise<void>
  /** 移除 security.json abe 标记源（宿主包装 store removeAbeSourceOp；core 守卫：移除后
   *  无任何解锁方式时抛错）。T6 移除序列 removeSource→remove：先清标记再删服务侧密文 */
  removeSource(): Promise<void>
  /** 锁屏静默解锁（plan p6 §0.3/T7）：服务侧 Unwrap 返回明文 DEK。任何失败（服务未装/
   *  调用者失配被拒/管道不可达）折叠为 null——LockScreen 无声回退 dpapi 通道，失败细节
   *  仅宿主 console.warn 留痕；supported=false 宿主短路返回 null */
  unwrap(): Promise<Uint8Array | null>
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
  /** [可选] 当前解锁态持有的 DEK（锁定/未启用 null；C1 终审：ABE 绑定编排 wrap 入参取用——
   *  encryptionSession.getCurrentDek 的宿主面板透出，宿主工厂统一注入；未注入时 ABE 绑定
   *  序列按无 DEK 处理中止于 wrap 前） */
  getCurrentDek?(): Uint8Array | null
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
  /** [可选] ABE 提权服务解锁通道（plan p6 §0.3）；仅 desktop 提供，supported=false 不渲染不调用（extension 无） */
  abe?: AbeOps
  /** 解锁方式按端命名（宿主注入；缺省 Passkey，osAutoLabel null=该端无原生自动解锁） */
  unlockNaming?: { prfLabel: string; osAutoLabel: string | null }
  /** 复制后 30s 自动清空剪贴板开关（当前值） */
  clipboardClearEnabled: ComputedRef<boolean>
  /** 切换剪贴板清空开关（宿主写 settings + 持久化） */
  setClipboardClear(v: boolean): Promise<void>
  /** [可选] 剪贴板自动清空说明覆写哨兵(F5):'firefox'=该端无 offscreen API,清空承诺不可用——
   *  SecurityCard 据此切换为降级说明键(securityCard.clipboardHintFirefox);缺省走默认 hint 键 */
  readonly clipboardNote?: string
  /** [可选] popup「已复制」后自动关闭延迟毫秒数（仅 extension 提供；desktop 无 popup 不渲染该输入） */
  popupCloseDelayMs?: ComputedRef<number>
  /** [可选] 修改弹窗关闭延迟（宿主写 settings + 持久化） */
  setPopupCloseDelay?(ms: number): Promise<void>
  /** [可选] 锁定策略偏好（设计 §1；宿主映射 AppSettings 三字段读写）。未提供时 SecurityCard 锁定策略区不渲染 */
  lockPrefs?: {
    get(): LockPrefs | Promise<LockPrefs>
    /** 任一控件变更即以完整对象覆写（避免宿主端部分更新歧义） */
    set(p: LockPrefs): void | Promise<void>
    /** [可选] 该端不支持的偏好键（审查 Minor：如 extension 的 lockOnRestart 无实现支撑）——
     *  SecurityCard 隐藏对应控件防无效设置；缺省=三控件全渲染（desktop 现状，按端降级由 T6 调整） */
    unsupported?: ReadonlyArray<keyof LockPrefs>
  }
}
