import { createI18n, type I18n, type Locale } from 'vue-i18n'
import { watch } from 'vue'
import type { AppSettings } from '@totp/core'
import type { VueStore } from '../store'
import zh from './locales/zh/common.json'
import en from './locales/en/common.json'

/** vue-i18n v11 的 I18n 泛型为 <Messages, DateTimeFormats, NumberFormats, OptionLocale, Legacy>——
 *  第 5 位才是 Legacy。此处取 composition（legacy=false）模式的实例类型；
 *  brief 契约写作 I18n<false>（意图 legacy=false），v11 类型下按参数位展开为本别名 */
type AppI18n = I18n<Record<string, unknown>, {}, {}, Locale, false>

/** locale 判定（单一事实源）：显式 zh/en 直取；auto → 浏览器语言以 en 开头取 en，其余（含 zh*）
 *  回落 zh。界面语言仅 zh/en 两档，故非 en 的浏览器语言一律显示中文 */
export function resolveLocale(l: AppSettings['locale']): 'zh' | 'en' {
  return l === 'en' ? 'en' : l === 'zh' ? 'zh' : (typeof navigator !== 'undefined' && /^en/i.test(navigator.language) ? 'en' : 'zh')
}

/** D1：i18n 机制。locale 源 = settings.locale（auto → navigator.language 判定，zh 兜底回退）；
 *  store=null → boot 失败兜底实例（spec §2.2：无设置可读，locale 固定 zh=fallbackLocale 口径，
 *  无 locale 跟随 watch——成功重载后由 store 版实例接管） */
export function createAppI18n(store: VueStore | null): AppI18n {
  const i18n = createI18n({
    legacy: false,
    locale: store ? resolveLocale(store.settings.locale) : 'zh',
    fallbackLocale: 'zh',
    messages: { zh, en },
  }) as AppI18n // 具体资源形状（"zh"|"en" locale）断言到宽接口：WritableComputedRef 严格型变下不兼容，运行时同构
  if (store) watch(() => store.settings.locale, (l) => { i18n.global.locale.value = resolveLocale(l) })
  return i18n
}
