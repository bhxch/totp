import { createI18n, type I18n, type Locale } from 'vue-i18n'
import { watch } from 'vue'
import type { VueStore } from '../store'
import zh from './locales/zh/common.json'
import en from './locales/en/common.json'

/** vue-i18n v11 的 I18n 泛型为 <Messages, DateTimeFormats, NumberFormats, OptionLocale, Legacy>——
 *  第 5 位才是 Legacy。此处取 composition（legacy=false）模式的实例类型；
 *  brief 契约写作 I18n<false>（意图 legacy=false），v11 类型下按参数位展开为本别名 */
type AppI18n = I18n<Record<string, unknown>, {}, {}, Locale, false>

/** D1：i18n 机制。locale 源 = settings.locale（auto → navigator.language 判定，zh 兜底回退） */
export function createAppI18n(store: VueStore): AppI18n {
  const resolve = (l: string): 'zh' | 'en' =>
    l === 'en' ? 'en' : l === 'zh' ? 'zh' : (typeof navigator !== 'undefined' && /^en/i.test(navigator.language) ? 'en' : 'zh')
  const i18n = createI18n({
    legacy: false,
    locale: resolve(store.settings.locale),
    fallbackLocale: 'zh',
    messages: { zh, en },
  }) as AppI18n // 具体资源形状（"zh"|"en" locale）断言到宽接口：WritableComputedRef 严格型变下不兼容，运行时同构
  watch(() => store.settings.locale, (l) => { i18n.global.locale.value = resolve(l) })
  return i18n
}
