import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { afterEach, describe, expect, it } from 'vitest'
import ToastHost from '../src/components/ToastHost.vue'
import { useToast } from '../src/composables/useToast'

describe('ToastHost', () => {
  afterEach(() => {
    // 模块级单例状态复位（ToastHost 直读该状态）
    const { toasts, dismiss } = useToast()
    for (const t of [...toasts.value]) dismiss(t.key)
  })

  it('空态：success 组容器 role=status + aria-live=polite，无 toast 项', () => {
    const w = mount(ToastHost)
    expect(w.find('[role="status"]').attributes('aria-live')).toBe('polite')
    expect(w.findAll('.toast')).toHaveLength(0)
    w.unmount()
  })

  it('渲染 message 与 kind class（error 态加 toast--error）', () => {
    const { show } = useToast()
    show('已复制')
    show('复制失败', 'error')
    const w = mount(ToastHost)
    const items = w.findAll('.toast')
    expect(items).toHaveLength(2)
    expect(items[0]?.text()).toBe('已复制')
    expect(items[0]?.classes()).not.toContain('toast--error')
    expect(items[1]?.text()).toBe('复制失败')
    expect(items[1]?.classes()).toContain('toast--error')
    w.unmount()
  })

  it('R3-M9：error toast 走 assertive 播报（role=alert + aria-live=assertive），success 保持 polite', () => {
    const { show } = useToast()
    show('已复制')
    show('复制失败', 'error')
    const w = mount(ToastHost)
    const polite = w.find('[role="status"]')
    const assertive = w.find('[role="alert"]')
    expect(polite.attributes('aria-live')).toBe('polite')
    expect(assertive.attributes('aria-live')).toBe('assertive')
    // 分流断言：success 只在 polite 区、error 只在 assertive 区（live region 常驻分区，非动态改属性）
    expect(polite.text()).toContain('已复制')
    expect(polite.text()).not.toContain('复制失败')
    expect(assertive.text()).toContain('复制失败')
    expect(assertive.find('.toast--error').exists()).toBe(true)
    w.unmount()
  })

  it('show 后响应式渲染（宿主任意处 show，ToastHost 直读模块态）', async () => {
    const { show } = useToast()
    const w = mount(ToastHost)
    expect(w.findAll('.toast')).toHaveLength(0)
    show('挂载后入队')
    await nextTick() // DOM 更新为异步微任务
    expect(w.findAll('.toast')).toHaveLength(1)
    expect(w.find('.toast').text()).toBe('挂载后入队')
    w.unmount()
  })

  it('点击单条即 dismiss（对应项移除，其余保留）', async () => {
    const { show, toasts } = useToast()
    show('A')
    show('B')
    const w = mount(ToastHost)
    await w.findAll('.toast')[0]?.trigger('click') // 点最旧一条（A）
    expect(toasts.value.map((t) => t.message)).toEqual(['B'])
    expect(w.findAll('.toast')).toHaveLength(1)
    expect(w.findAll('.toast')[0]?.text()).toBe('B')
    w.unmount()
  })
})
