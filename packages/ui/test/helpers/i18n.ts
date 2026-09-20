import { createI18n } from 'vue-i18n'
import zh from '../../src/i18n/locales/zh/common.json'
import en from '../../src/i18n/locales/en/common.json'

/** 组件测试用 i18n 小工厂：mount 时 `global: { plugins: [createTestI18n()] }`。
 *  每次调用新建实例（避免用例间 locale/消息状态串扰）；locale 固定 zh，与中文断言文案一致 */
export function createTestI18n() {
  return createI18n({ legacy: false, locale: 'zh', messages: { zh, en } })
}
