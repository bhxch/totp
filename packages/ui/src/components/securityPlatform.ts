import type { ComputedRef, Ref } from 'vue'

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
  /** 更换口令（仅重包裹 DEK，数据无需重加密） */
  changePassphrase(newPassword: string): Promise<void>
}

/**
 * 安全卡平台能力（由宿主注入）。SecurityCard 只依赖此接口，
 * platform 为 null 时整卡不渲染（popup 零影响）；
 * security 为 null 时仅渲染通用设置区（剪贴板/弹窗延迟）。
 */
export interface SecurityPlatform {
  /** 加密状态与操作；popup 等不暴露安全管理的端传 null */
  security: SecurityOps | null
  /** 复制后 30s 自动清空剪贴板开关（当前值） */
  clipboardClearEnabled: ComputedRef<boolean>
  /** 切换剪贴板清空开关（宿主写 settings + 持久化） */
  setClipboardClear(v: boolean): Promise<void>
  /** [可选] popup「已复制」后自动关闭延迟毫秒数（仅 extension 提供；desktop 无 popup 不渲染该输入） */
  popupCloseDelayMs?: ComputedRef<number>
  /** [可选] 修改弹窗关闭延迟（宿主写 settings + 持久化） */
  setPopupCloseDelay?(ms: number): Promise<void>
}
