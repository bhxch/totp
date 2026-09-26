/**
 * desktop 解锁方式按端命名（P4 自 App.vue 抽出，纯搬移行为不变）：UA 平台标识判定宿主端。
 * 依据（自审声明）：desktop 桌面壳 UA 形态——Windows WebView2 恒含 "Windows NT"；
 * macOS WKWebView/Safari 恒含 "Mac OS X"（"Macintosh" 平台段）；Linux 桌面浏览器 UA
 * 恒含 "X11; Linux"。桌面端不存在 iPhone/iPad 形态，排除规则仅作防御（防 UA 伪造/异常）。
 *
 * 调用时序约束（行为关键）：unlockNamingFor 以注入 tr 取词——宿主须以「函数调用时求值」
 * 形态使用（securityPlatform computed 求值与 dpapiOps.label getter 读取均发生在 i18n 装入后，
 * 且经 tr 内部 locale ref 建立响应依赖，locale 切换联动）；预求值会在 i18n 装入前固化 key 兜底文案。
 */

/** UA 平台标识（isMac/isWin 相互独立判定——与原实现一致，不归一为单值） */
export interface DesktopUaFlags {
  isMac: boolean
  isWin: boolean
}

export function desktopUaFlags(ua: string): DesktopUaFlags {
  return {
    isMac: /Mac/i.test(ua) && !/iPhone|iPad/i.test(ua),
    isWin: /Windows/i.test(ua),
  }
}

/** 解锁方式显示名（D2 抽串）：prfLabel=WebAuthn 注册按钮文案；osAutoLabel=OS 自动解锁通道显示名 */
export interface UnlockNaming {
  prfLabel: string
  osAutoLabel: string | null
}

export function unlockNamingFor(
  flags: DesktopUaFlags,
  tr: (key: string, params?: Record<string, unknown>) => string,
): UnlockNaming {
  return flags.isMac
    ? { prfLabel: 'Touch ID (Passkey)', osAutoLabel: tr('desktop.unlockKeychain') }
    : flags.isWin
      ? { prfLabel: 'Windows Hello (Passkey)', osAutoLabel: tr('desktop.unlockWindows') }
      : { prfLabel: 'Passkey', osAutoLabel: tr('desktop.unlockKeyring') }
}

/** 已绑定行的技术标注（?? 回退防未来分支 osAutoLabel 变 null 时静默 undefined 的另一面：
 *  平台判定独立于 naming，Windows=DPAPI / mac=Keychain / 其余=Secret Service） */
export function techSuffixFor(flags: DesktopUaFlags): string {
  return flags.isWin ? '（DPAPI）' : flags.isMac ? '（Keychain）' : '（Secret Service）'
}
