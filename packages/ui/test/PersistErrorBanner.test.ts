import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import PersistErrorBanner from '../src/components/PersistErrorBanner.vue'

/** R16⑤ 宿主接线（评审 A2 方案 a）：落盘失败常驻告警条的渲染契约。
 *  文案经 text prop 注入（desktop 壳层无 i18n 插件，组件零 i18n 依赖），测试断言注入原文 */
describe('PersistErrorBanner', () => {
  const TEXT = '数据保存失败：最近的更改可能未写入'

  it('show=false 不渲染', () => {
    const w = mount(PersistErrorBanner, { props: { show: false, text: TEXT } })
    expect(w.find('.persist-error').exists()).toBe(false)
  })

  it('show=true 渲染 role=alert 告警条与注入文案', () => {
    const w = mount(PersistErrorBanner, { props: { show: true, text: TEXT } })
    expect(w.find('.persist-error').attributes('role')).toBe('alert')
    expect(w.text()).toContain(TEXT)
  })
})
