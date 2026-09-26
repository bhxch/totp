/**
 * unlockNaming 直测（P4，盘点 B6.24 UA 判定缺口）：UA 平台标识矩阵与按端命名/技术标注。
 * tr 以可断言替身注入，验证请求的 i18n 键（desktop.unlockWindows/unlockKeychain/unlockKeyring）。
 */
import { describe, expect, it } from 'vitest'
import { desktopUaFlags, techSuffixFor, unlockNamingFor } from '../src/unlockNaming'
import { echoTr } from '../test/helpers/fakes'

const UA_WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0'
const UA_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Safari/605.1.15'
const UA_LINUX = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
const UA_IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
const UA_IPAD = 'Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1'

describe('desktopUaFlags（isMac/isWin 相互独立判定）', () => {
  it('Windows WebView2 → isWin', () => {
    expect(desktopUaFlags(UA_WIN)).toEqual({ isMac: false, isWin: true })
  })
  it('macOS WKWebView → isMac', () => {
    expect(desktopUaFlags(UA_MAC)).toEqual({ isMac: true, isWin: false })
  })
  it('Linux 桌面 → 双 false（按 keyring 分支）', () => {
    expect(desktopUaFlags(UA_LINUX)).toEqual({ isMac: false, isWin: false })
  })
  it('iPhone/iPad 形态排除（防御 UA 伪造/异常）：含 Mac OS X 但被 iPhone/iPad 排除', () => {
    expect(desktopUaFlags(UA_IPHONE).isMac).toBe(false)
    expect(desktopUaFlags(UA_IPAD).isMac).toBe(false)
  })
})

describe('unlockNamingFor（调用时经 tr 取词）', () => {
  it('Windows → Windows Hello (Passkey) + desktop.unlockWindows', () => {
    expect(unlockNamingFor(desktopUaFlags(UA_WIN), echoTr)).toEqual({
      prfLabel: 'Windows Hello (Passkey)',
      osAutoLabel: 'desktop.unlockWindows',
    })
  })
  it('macOS → Touch ID (Passkey) + desktop.unlockKeychain', () => {
    expect(unlockNamingFor(desktopUaFlags(UA_MAC), echoTr)).toEqual({
      prfLabel: 'Touch ID (Passkey)',
      osAutoLabel: 'desktop.unlockKeychain',
    })
  })
  it('其余（Linux/排除形态）→ Passkey + desktop.unlockKeyring', () => {
    expect(unlockNamingFor(desktopUaFlags(UA_LINUX), echoTr).prfLabel).toBe('Passkey')
    expect(unlockNamingFor(desktopUaFlags(UA_LINUX), echoTr).osAutoLabel).toBe('desktop.unlockKeyring')
    expect(unlockNamingFor(desktopUaFlags(UA_IPHONE), echoTr).osAutoLabel).toBe('desktop.unlockKeyring')
  })
  it('每次调用现取词（注入 tr 换实现即换结果——宿主 locale 联动的机制基础）', () => {
    const flags = desktopUaFlags(UA_WIN)
    let calls = 0
    const counting = () => {
      calls++
      return `t${calls}`
    }
    expect(unlockNamingFor(flags, counting).osAutoLabel).toBe('t1')
    expect(unlockNamingFor(flags, counting).osAutoLabel).toBe('t2')
    expect(calls).toBe(2)
  })
})

describe('techSuffixFor（与 naming 平台判定独立：已绑定行技术标注）', () => {
  it('Windows=（DPAPI）/ mac=（Keychain）/ 其余=（Secret Service）', () => {
    expect(techSuffixFor(desktopUaFlags(UA_WIN))).toBe('（DPAPI）')
    expect(techSuffixFor(desktopUaFlags(UA_MAC))).toBe('（Keychain）')
    expect(techSuffixFor(desktopUaFlags(UA_LINUX))).toBe('（Secret Service）')
    expect(techSuffixFor(desktopUaFlags(UA_IPHONE))).toBe('（Secret Service）')
  })
})
