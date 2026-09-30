import { computed } from 'vue'
import { randomBytes } from '@totp/core'
import type { DpapiUnlockOps, LockPrefs, SecurityPlatform } from '../components/securityPlatform'
import type { VueStore } from '../store'
// WebAuthn 交互原语经包名自引用导入(Node/TS 支持包名自引用):宿主测试对 '@totp/ui' 的
// vi.mock 是唯一拦截点(securityPlatform.test 以桩替换 createPrfCredential/prfSupported——
// passkey 断言经桩捕获;host 首载走 '@totp/ui/host' 子路径、晚于 mock 就绪,拦截有效)。
// 生产经 exports "." 回到 index.ts(纯 re-export,无 host 反向导出)——无循环。
import { createPrfCredential, prfSupported } from '@totp/ui'

/**
 * overrides 差异点清单(R4 纪律:仅已核实差异进 overrides):
 * 同型成员(内置)= security 8 成员(locked/hasEncryption/enableEncryption/disableEncryption/
 * changePassphrase/kdfProfile/passwordChangedAt/passkey{sources,prfSupported,add,remove},
 * 两端逐字)+ clipboardClearEnabled/setClipboardClear + lockPrefs 三字段整读整写。
 * 注入差异(全部可选,4 键):
 * - dpapi / unlockNaming:desktop 独有(OS 自动解锁通道与按端命名);
 * - popup:extension 独有(popup「已复制」关窗延迟,desktop 无 popup 不渲染该输入);
 * - lockPrefsUnsupported:ext=['lockOnRestart'](D2 裁定置灰+角标,不再隐藏;
 *   lockOnSystemLock 仍隐藏)/ desktop=lockPrefsUnsupportedKeys(ua)(系统锁事件源仅 Windows)。
 * overrides 键数 4 ≪ 同型成员 11 → 该工厂可抽。
 */

export interface SecurityOpsOverrides {
  /** OS 自动解锁通道(desktop 独有):SecurityCard「启用/移除」与 LockScreen「挂载静默解锁」共用同一对象 */
  dpapi?: DpapiUnlockOps
  /** 解锁方式按端命名(desktop 独有):调用时求值——保持 locale 响应式(unlockNaming 时序约束) */
  unlockNaming?: { prfLabel: string; osAutoLabel: string | null }
  /** popup 关窗延迟通道(extension 独有):提供时 SecurityCard 渲染延迟输入;
   *  closeDelayMs 读 settings.popupCloseDelayMs 由工厂内置,宿主仅注入写路径 */
  popup?: {
    setCloseDelay(ms: number): Promise<void>
  }
  /** 该端不支持的锁定偏好键(SecurityCard 置灰禁用对应控件(lockOnRestart)或隐藏(lockOnSystemLock)防无效设置);缺省三控件全渲染 */
  lockPrefsUnsupported?: ReadonlyArray<keyof LockPrefs>
  /** 剪贴板自动清空说明覆写哨兵(F5):'firefox'=Firefox 无 offscreen API,清空承诺不可用——
   *  宿主探测后注入哨兵,SecurityCard 据此选降级说明键;缺省用 securityCard.clipboardHint 默认键 */
  clipboardNote?: string
}

/**
 * store 直驱 SecurityPlatform 装配(R4 自两端收敛;返回 SecurityPlatform 形状不变):
 * security 闭包绑 store,WebAuthn 交互(创建/求值)经 ui prf.ts,绑定落盘走 store 的 prf 源 op。
 * plan16 T11 审查四项全量接线:changePassphrase opts 透传(漏接=档位切换误触发全库轮换)、
 * kdfProfile、passwordChangedAt、lockPrefs——.vue 无 typecheck 对 platform 成员的覆盖,
 * 漏接无编译信号,工厂内置即唯一实现。
 */
export function createSecurityOpsFromStore(store: VueStore, overrides: SecurityOpsOverrides = {}): SecurityPlatform {
  const o = overrides
  return {
    security: {
      locked: store.locked,
      hasEncryption: store.hasEncryption,
      enableEncryption: (pw) => store.enableEncryption(pw),
      disableEncryption: () => store.disableEncryption(),
      // opts 透传:档位切换走 { rotateDek: false, profile }(重 wrap 立即生效,不误触发全库轮换)
      changePassphrase: (pw, opts) => store.changePassphrase(pw, opts),
      kdfProfile: computed(() => store.securitySettings.value?.profile ?? 'balanced'),
      passwordChangedAt: computed(() => store.securitySettings.value?.passwordChangedAt ?? null),
      passkey: {
        sources: computed(() => store.prfSources.value.map((p) => ({ credentialId: p.credentialId }))),
        prfSupported: () => prfSupported(),
        async add() {
          // 绑定盐：create 优先取值、无输出时 get 静默兜底，均以该盐求值，解锁期用同一盐复现（同认证器+同盐→同输出）
          const salt = randomBytes(32)
          const created = await createPrfCredential('TOTP 验证码工具', salt, {
            excludeCredentialIds: store.prfSources.value.map((p) => p.credentialId),
          })
          if (!created) return false
          await store.addPrfSourceOp(created.credentialId, created.prfOutput, salt)
          return true
        },
        remove: (credentialId) => store.removePrfSourceOp(credentialId),
      },
    },
    ...(o.dpapi ? { dpapi: o.dpapi } : {}),
    ...(o.unlockNaming ? { unlockNaming: o.unlockNaming } : {}),
    clipboardClearEnabled: computed(() => store.settings.clipboardClearEnabled),
    async setClipboardClear(v) {
      store.settings.clipboardClearEnabled = v
      await store.commitSettings()
    },
    ...(o.popup
      ? {
          popupCloseDelayMs: computed(() => store.settings.popupCloseDelayMs),
          setPopupCloseDelay: o.popup.setCloseDelay,
        }
      : {}),
    ...(o.clipboardNote ? { clipboardNote: o.clipboardNote } : {}),
    lockPrefs: {
      // 锁定策略(plan16 T11):三字段整体覆写进 settings 后持久化(core loadSettings 已归一化)
      get: () => ({ lockOnRestart: store.settings.lockOnRestart, lockIdleMinutes: store.settings.lockIdleMinutes, lockOnSystemLock: store.settings.lockOnSystemLock }),
      set: (p) => {
        Object.assign(store.settings, p)
        void store.commitSettings()
      },
      unsupported: o.lockPrefsUnsupported,
    },
  }
}
