/**
 * desktop 安全平台工厂（P4 自 App.vue 抽出，纯搬移行为不变）：security 闭包绑 store；
 * dpapi=OS 自动解锁通道（三平台统一，见 lib.rs os_auto_protect/unprotect）；剪贴板开关走
 * settings+commitSettings；desktop 无 popup，不提供 popupCloseDelayMs；passkey(PRF)：WebAuthn
 * 交互（创建/求值）经 ui prf.ts，绑定落盘走 store 的 prf 源 op。
 * plan16 T11 审查四项：changePassphrase opts 透传（漏接=档位切换误触发全库轮换）、kdfProfile、
 * passwordChangedAt、lockPrefs——.vue 无 typecheck 对 platform 成员的覆盖，漏接无编译信号，全量接线。
 */
import { computed, type ComputedRef } from 'vue'
import { randomBytes } from '@totp/core'
import { createPrfCredential, prfSupported, type DpapiUnlockOps, type SecurityPlatform, type VueStore } from '@totp/ui'
import { lockPrefsUnsupportedKeys } from './lockPrefs'
import { isEntropyBoundDekWrap, osAutoForgetOs, osAutoProtectOs, osAutoUnprotectOs } from './tauriSecurity'
import type { DesktopUaFlags, UnlockNaming } from './unlockNaming'

export interface SecurityPlatformDeps {
  /** store 浅包装实时读取（App.vue setup 期传入 () => store.value；未就绪 null → 卡片不渲染/报错） */
  getStore(): VueStore | null
  /** 壳层取词（i18n 装入后调用；经 locale ref 建立响应依赖） */
  tr(key: string, params?: Record<string, unknown>): string
  /** 解锁方式命名（调用时求值——保持 locale 响应式，见 unlockNaming.ts 时序约束） */
  naming(): UnlockNaming
  /** UA 平台标识（setup 期经 desktopUaFlags(navigator.userAgent) 判定一次） */
  flags: DesktopUaFlags
  /** 原始 UA（lockPrefsUnsupportedKeys 平台判定用，与 flags 同源） */
  ua: string
}

/** platform 工厂与迁移共用的就绪断言：store 未就绪时统一中文报错（卡片展示） */
function requireStore(deps: SecurityPlatformDeps): VueStore {
  const s = deps.getStore()
  if (!s) throw new Error('数据尚未就绪')
  return s
}

export interface DesktopSecurityPlatform {
  /** 安全平台（computed：store 未就绪 null，SecurityCard 整卡不渲染） */
  platform: ComputedRef<SecurityPlatform | null>
  /** OS 自动解锁通道（SecurityCard「启用/移除」与 LockScreen「挂载静默解锁」共用同一对象） */
  dpapi: DpapiUnlockOps
  /** F3 迁移：历史 wrappedDekD（无应用附加熵的旧格式）在下一次成功解锁后重包为 v2 应用熵绑定
   *  格式（TOTPDEK1 前缀 + DPAPI(DEK, 熵)，见 tauriSecurity 与 lib.rs dek 通道）。幂等（已是 v2 跳过）；
   *  best-effort：失败仅告警——Rust 端旧格式 32B 兜底仍可解锁，下次成功解锁重试 */
  migrateDekWrapToEntropyBound(): Promise<void>
}

export function createSecurityPlatform(deps: SecurityPlatformDeps): DesktopSecurityPlatform {
  const { tr, flags } = deps

  /** OS 自动解锁通道（三平台统一，见 lib.rs os_auto_protect/unprotect）：Windows 下委托同一
   *  DEK 通道（运行时行为与旧 dpapi_* 命令等价），macOS/Linux 经 keyring。Rust os_auto_* 与
   *  dpapi_* 命令并存，dpapi_* 保留供语义兼容（kekSources kind 仍 'dpapi'）。
   *  F3：Windows 侧 v2 格式 = TOTPDEK1 前缀 + DPAPI(DEK, 应用附加熵)，仅主窗口可调用，
   *  旧格式（无熵）由 Rust 32B 兜底解出并在解锁后迁移（migrateDekWrapToEntropyBound）。
   *  SecurityCard（启用/移除）与 LockScreen（挂载静默解锁）共用同一对象；label 注入按端显示名
   *  （?? 回退防未来分支 osAutoLabel 变 null 时静默 undefined），techSuffix 为已绑定行技术标注 */
  const dpapiOps: DpapiUnlockOps = {
    // getter：读取时取词（SecurityCard/LockScreen 渲染期读取，晚于 i18n 装入；?? 回退防未来分支为 null）
    get label() { return deps.naming().osAutoLabel ?? tr('desktop.unlockWindows') },
    techSuffix: flags.isWin ? '（DPAPI）' : flags.isMac ? '（Keychain）' : '（Secret Service）',
    source: computed(() => deps.getStore()?.dpapiSource.value ?? null),
    getCurrentDek: () => deps.getStore()?.getCurrentDek() ?? null,
    protect: (dek) => osAutoProtectOs(dek),
    unprotect: (wrapped) => osAutoUnprotectOs(wrapped),
    async add(wrappedDekD) {
      const s = requireStore(deps)
      await s.addDpapiSourceOp(wrappedDekD)
    },
    async remove() {
      const s = requireStore(deps)
      await s.removeDpapiSourceOp()
      // 审查 M1（C1 遗留）：移除成功后 best-effort 清 keyring DEK 条目（mac/Linux；Windows 为
      // 报错桩，静默忽略）。失败不影响移除主流程——security JSON 已更新，残留条目仅是 OS 凭据
      // 库卫生问题。mac/Linux keyring 分支未真机验证挂账不变（见 tauriSecurity.ts 头注释）。
      // 失败不吞进黑洞：warn 留痕（排查残留条目时需要失败原因），不弹 UI
      void osAutoForgetOs().catch((e: unknown) => { console.warn('[desktop] keyring 条目清理失败', e) })
    },
  }

  async function migrateDekWrapToEntropyBound(): Promise<void> {
    const s = deps.getStore()
    const src = dpapiOps.source.value
    const dek = s?.getCurrentDek()
    if (!s || s.locked.value || !src || !dek) return
    if (isEntropyBoundDekWrap(src.wrappedDekD)) return
    try {
      await dpapiOps.add(await dpapiOps.protect(dek))
    } catch (e) {
      console.warn('[migrate] DEK 包裹升级为应用熵绑定格式失败（旧格式仍可解锁，下次重试）', e)
    }
  }

  const securityPlatform = computed<SecurityPlatform | null>(() => {
    const s = deps.getStore()
    if (!s) return null
    return {
      security: {
        locked: s.locked,
        hasEncryption: s.hasEncryption,
        enableEncryption: (pw) => s.enableEncryption(pw),
        disableEncryption: () => s.disableEncryption(),
        // opts 透传：档位切换走 { rotateDek: false, profile }（重 wrap 立即生效，不误触发全库轮换）
        changePassphrase: (pw, opts) => s.changePassphrase(pw, opts),
        kdfProfile: computed(() => s.securitySettings.value?.profile ?? 'balanced'),
        passwordChangedAt: computed(() => s.securitySettings.value?.passwordChangedAt ?? null),
        passkey: {
          sources: computed(() => s.prfSources.value.map((p) => ({ credentialId: p.credentialId }))),
          prfSupported: () => prfSupported(),
          async add() {
            // 绑定盐：注册期 create 与权威 get 均以该盐求值，解锁期用同一盐复现（同认证器+同盐→同输出）
            const salt = randomBytes(32)
            const created = await createPrfCredential('TOTP 验证码工具', salt, {
              excludeCredentialIds: s.prfSources.value.map((p) => p.credentialId),
            })
            if (!created) return false
            await s.addPrfSourceOp(created.credentialId, created.prfOutput, salt)
            return true
          },
          remove: (credentialId) => s.removePrfSourceOp(credentialId),
        },
      },
      dpapi: dpapiOps,
      unlockNaming: deps.naming(),
      clipboardClearEnabled: computed(() => s.settings.clipboardClearEnabled),
      async setClipboardClear(v) {
        s.settings.clipboardClearEnabled = v
        await s.commitSettings()
      },
      // 锁定策略（plan16 T11）：三字段整体覆写进 settings 后持久化（core loadSettings 已归一化）。
      // 审查 I10：desktop 无会话级 DEK 存储 → lockOnRestart 全平台无实现支撑（重启必锁）；
      // 系统锁屏事件源仅 Windows（lock_events WTS），非 Windows 追加声明 lockOnSystemLock——
      // SecurityCard 按 unsupported 隐藏对应开关防无效设置
      lockPrefs: {
        get: () => ({ lockOnRestart: s.settings.lockOnRestart, lockIdleMinutes: s.settings.lockIdleMinutes, lockOnSystemLock: s.settings.lockOnSystemLock }),
        set: (p) => {
          Object.assign(s.settings, p)
          void s.commitSettings()
        },
        unsupported: lockPrefsUnsupportedKeys(deps.ua),
      },
    }
  })

  return { platform: securityPlatform, dpapi: dpapiOps, migrateDekWrapToEntropyBound }
}
