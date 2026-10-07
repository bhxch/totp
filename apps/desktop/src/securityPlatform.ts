/**
 * desktop 安全平台工厂(R4 改造:security 闭包/剪贴板/锁定策略等两端同型装配下沉 @totp/ui host
 * ——createSecurityOpsFromStore,overrides 差异清单见其文件头;本模块保留 desktop 独有差异通道,
 * 导出面 createSecurityPlatform 与 SecurityPlatformDeps 不变,App.vue 零改动):
 * - dpapi=OS 自动解锁通道(已核准 desktop 独有差异,三平台统一,见 lib.rs os_auto_protect/unprotect);
 * - unlockNaming:解锁方式按端命名(naming 调用时求值——保持 locale 响应式);
 * - lockPrefsUnsupported:lockPrefsUnsupportedKeys(ua)——系统锁屏事件源仅 Windows(lock_events
 *   WTS),非 Windows 追加声明 lockOnSystemLock,SecurityCard 隐藏无效开关(审查 I10);
 * - 剪贴板开关走 settings+commitSettings(host 内置);desktop 无 popup,不提供 popup 通道;
 * - passkey(PRF):WebAuthn 交互(创建/求值)经 ui prf.ts,绑定落盘走 store 的 prf 源 op(host 内置)。
 * plan16 T11 审查四项(changePassphrase opts 透传/kdfProfile/passwordChangedAt/lockPrefs)由
 * host 工厂全量接线(漏接无编译信号,工厂内置即唯一实现)。
 * F3 迁移:历史 wrappedDekD(无应用附加熵的旧格式)在下一次成功解锁后重包为 v2 应用熵绑定
 * 格式(TOTPDEK1 前缀 + DPAPI(DEK, 熵),见 tauriSecurity 与 lib.rs dek 通道)。幂等(已是 v2 跳过);
 * best-effort:失败仅告警——Rust 端旧格式 32B 兜底仍可解锁,下次成功解锁重试。
 */
import { computed, type ComputedRef } from 'vue'
import { invoke } from '@tauri-apps/api/core'
// AbeStatus/AbeResult/AbeOps 正本在 @totp/ui（T5 起，防两处类型漂移——Rust abe_status 返回体
// camelCase 字段与 ui AbeStatus 对齐，单测 abe_status_result_serializes_camel_case 守护）
import type { AbeOps, AbeResult, AbeStatus, DpapiUnlockOps, SecurityOps, SecurityPlatform, VueStore } from '@totp/ui'
// host 工厂经 '@totp/ui/host' 子出口导入(理由同 host/index.ts 头注释:宿主 mock 拦截点唯一)
import { createSecurityOpsFromStore } from '@totp/ui/host'
import { lockPrefsUnsupportedKeys } from './lockPrefs'
import { requireStore } from './storeAccess'
import { isEntropyBoundDekWrap, osAutoForgetOs, osAutoProtectOs, osAutoUnprotectOs } from './tauriSecurity'
import { techSuffixFor, type DesktopUaFlags, type UnlockNaming } from './unlockNaming'

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

/** platform 工厂与迁移共用的就绪断言收敛至 storeAccess（未就绪统一中文报错） */

// ---------- ABE 服务宿主通道类型（P6 §0.3/T4；AbeStatus/AbeResult/AbeOps 正本在 @totp/ui，实现见 createSecurityPlatform 内 abeOps） ----------

export interface DesktopSecurityPlatform {
  /** 安全平台（computed：store 未就绪 null，SecurityCard 整卡不渲染） */
  platform: ComputedRef<SecurityPlatform | null>
  /** OS 自动解锁通道（SecurityCard「启用/移除」与 LockScreen「挂载静默解锁」共用同一对象） */
  dpapi: DpapiUnlockOps
  /** ABE 服务通道（supported=false 不渲染不调用；T5 接线 SecurityCard :abe） */
  abe: AbeOps
  /** F3 迁移：历史 wrappedDekD(无应用附加熵的旧格式)在下一次成功解锁后重包为 v2 应用熵绑定格式 */
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
    techSuffix: techSuffixFor(flags),
    source: computed(() => deps.getStore()?.dpapiSource.value ?? null),
    getCurrentDek: () => deps.getStore()?.getCurrentDek() ?? null,
    protect: (dek) => osAutoProtectOs(dek),
    unprotect: (wrapped) => osAutoUnprotectOs(wrapped),
    async add(wrappedDekD) {
      const s = requireStore(deps.getStore)
      await s.addDpapiSourceOp(wrappedDekD)
    },
    async remove() {
      const s = requireStore(deps.getStore)
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

  // ABE 服务通道（P6 §0.3）：supported 按 UA 判定（与 lockPrefs/naming 同源 flags）——
  // abe_* 命令虽全平台注册（非 Windows supported:false 桩），前端短路可省无效 IPC；
  // 失败一律收敛 null/false/{ok:false}（UAC 取消、服务不可达均非异常路径，不打断 UI）
  const abeSupported = deps.flags.isWin
  const abeOps: AbeOps = {
    supported: abeSupported,
    // R7-I2：abe 标记源视图（SecurityCard「已启用」态判定 = matchesCaller && 源在场；
    // LockScreen 静默解锁入口读同一 store.abeSource）
    source: computed(() => deps.getStore()?.abeSource.value ?? null),
    async status() {
      if (!abeSupported) return null
      try {
        return (await invoke<AbeStatus>('abe_status')) ?? null
      } catch (e) {
        console.warn('[desktop] abe_status 查询失败', e)
        return null
      }
    },
    async bind() {
      if (!abeSupported) return false
      try {
        await invoke('abe_bind')
        return true
      } catch (e) {
        console.warn('[desktop] abe_bind 失败（UAC 取消或安装未达可用态）', e)
        return false
      }
    },
    // 服务侧 Wrap（C1 终审：绑定编排 bind→wrap→addSource 的 wrap 步）：当前 DEK →
    // abe_wrap（服务 HKLM WrappedDek）。失败折叠 false（语义同 unwrap：任何管道/服务侧
    // 失败均非异常路径，SecurityCard 据此中止绑定序列于 addSource 之前）
    async wrap(dek) {
      if (!abeSupported) return false
      try {
        await invoke('abe_wrap', { dek: Array.from(dek) })
        return true
      } catch (e) {
        console.warn('[desktop] abe_wrap 失败（服务不可达/被拒），绑定序列中止', e)
        return false
      }
    },
    async remove() {
      if (!abeSupported) return { ok: false, message: '当前平台不支持 ABE 服务' }
      try {
        return (await invoke<AbeResult>('abe_remove')) ?? { ok: false }
      } catch (e) {
        return { ok: false, message: String(e) }
      }
    },
    // security.json abe 标记源落盘/移除（store 源 op；T6 UI 编排 bind→addSource→刷新 status、
    // 移除 removeSource→remove）。密文在服务侧 HKLM，源仅标记存在（plan p6 §0.3 刻意收窄泄露面）
    async addSource() {
      const s = requireStore(deps.getStore)
      await s.addAbeSourceOp()
    },
    async removeSource() {
      const s = requireStore(deps.getStore)
      await s.removeAbeSourceOp()
    },
    // 锁屏静默解锁（§0.3/T7）：abe_unwrap（服务 Unwrap 代理）→ DEK 字节。任何失败
    // （未装/失配被拒/管道不可达——Rust 侧已折叠为 Err(String)）一律收敛 null 供
    // LockScreen 无声回退 dpapi；失败细节 warn 留痕不弹 UI
    async unwrap() {
      if (!abeSupported) return null
      try {
        const dek = await invoke<number[]>('abe_unwrap')
        return new Uint8Array(dek)
      } catch (e) {
        console.warn('[desktop] abe_unwrap 失败（服务未装/失配/不可达），锁屏将回退 OS 通道', e)
        return null
      }
    },
  }

  /** I2 终审：ABE 服务侧密文与 DEK 生命周期联动（dpapi migrateDekWrapToEntropyBound 同域的
   *  宿主编排点——DEK 前进/退役的既有 SecurityOps 通道完成后接服务侧动作）。
   *  轮换（rotateDek=true 换新 DEK）：服务在线重 Wrap + 恢复标记源，离线/失败清密文降级
   *  （restoreAbeAfterRotation）；档位切换 rotateDek=false DEK 不变，HKLM 密文仍有效无需重包；
   *  关加密清密文（abe 标记源随 SECURITY_KEY 整体删除消失，无需 removeAbeSourceOp——此时调用
   *  必抛 'encryption not enabled'，仅清服务侧 HKLM）。失败均仅 warn 不阻断主流程 */
  /** R7-I2：轮换后 ABE 恢复/降级。core changeVaultPassphrase(rotateDek=true) 把 kekSources
   *  重置为 password-only（旧 prf/dpapi/abe 死凭证数据层丢弃），故换口令后 abe 源必不在——
   *  须主动二选一：服务在线（status matchesCaller，触发一次查询）→ 新 DEK 重 Wrap + addAbeSourceOp
   *  恢复标记源（mutateSecurityOp 守卫止步 security 不需 DEK；换口令需旧解锁会话，此处会话仍
   *  解锁，落盘生效）保持 ABE 继续工作；服务离线/失配/查询失败/重 Wrap 失败/恢复落盘失败 →
   *  removeAbeCiphertext 清 HKLM 密文降级退出（标记源与密文必须成对，避免残留旧 DEK 无主密文），
   *  用户可后续在 SecurityCard 重装绑定。全程仅 warn 不阻断换口令主流程（换口令已生效） */
  async function restoreAbeAfterRotation(): Promise<void> {
    const s = deps.getStore()
    const dek = s?.getCurrentDek()
    if (!s || !dek) return
    let restored = false
    if ((await abeOps.status().catch(() => null))?.matchesCaller === true) {
      if (await abeOps.wrap(dek).catch(() => false)) {
        try {
          await s.addAbeSourceOp()
          restored = true
        } catch (e) {
          console.warn('[desktop] ABE 标记源恢复失败（换口令已生效；标记源与 HKLM 密文须成对，清密文降级）', e)
        }
      } else {
        console.warn('[desktop] ABE 重 Wrap 失败（换口令已生效；清服务密文降级，重装可恢复）')
      }
    } else {
      console.warn('[desktop] ABE 服务离线/失配（换口令已生效；清服务密文降级，重装可恢复）')
    }
    if (!restored) await removeAbeCiphertext()
  }

  async function removeAbeCiphertext(): Promise<void> {
    const r = await abeOps.remove().catch(() => null)
    if (!r?.ok) console.warn('[desktop] ABE 服务密文清理失败（安全操作已生效；卸载/重装可清）', r?.message)
  }

  const securityPlatform = computed<SecurityPlatform | null>(() => {
    const s = deps.getStore()
    if (!s) return null
    const base = createSecurityOpsFromStore(s, {
      dpapi: dpapiOps,
      abe: abeOps,
      unlockNaming: deps.naming(),
      // 审查 I10：desktop 无会话级 DEK 存储 → lockOnRestart 全平台无实现支撑（重启必锁）；
      // 系统锁屏事件源仅 Windows（lock_events WTS），非 Windows 追加声明 lockOnSystemLock——
      // SecurityCard 按 unsupported 隐藏对应开关防无效设置
      lockPrefsUnsupported: lockPrefsUnsupportedKeys(deps.ua),
    })
    // I2 终审：security 通道包装（工厂内置实现之上叠加服务侧密文联动；其余成员浅拷贝透传）。
    // 工厂 store 已就绪路径下 security 恒非空（类型层 null 仅服务 popup 整体缺卡形态），守卫只为收窄
    const baseSecurity = base.security
    if (!baseSecurity) return base
    const security: SecurityOps = {
      ...baseSecurity,
      async changePassphrase(pw, opts) {
        // R7-I2：轮换前先记 abe 源在场（disableEncryption 同手法）——core 轮换把 kekSources
        // 重置为 password-only，轮换后再读 abeSource 恒 null（旧实现即因此成死代码，HKLM
        // 残留旧 DEK 密文且 UI 假「已启用」）
        const hadAbe = s.abeSource.value !== null
        await baseSecurity.changePassphrase(pw, opts)
        // 轮换（rotateDek 缺省 true）后新 DEK 已在会话（提交点同步前进）：abe 源在场即走
        // 恢复/降级；档位切换（rotateDek=false）DEK 不变，HKLM 密文仍有效，跳过
        if ((opts?.rotateDek ?? true) && hadAbe) await restoreAbeAfterRotation()
      },
      async disableEncryption() {
        // 先记 abe 源在场（disable 后 security 缓存清空，abeSource 恒 null 不可再判）
        const hadAbe = s.abeSource.value !== null
        await baseSecurity.disableEncryption()
        if (hadAbe) await removeAbeCiphertext()
      },
    }
    return { ...base, security }
  })

  return { platform: securityPlatform, dpapi: dpapiOps, abe: abeOps, migrateDekWrapToEntropyBound }
}
