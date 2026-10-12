import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import { nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import MdMenu from '../src/components/md/MdMenu.vue'

// 视口钳制（2026-10-12 真机缺陷回归）：估算钳制按 EST 200px 首帧落位，nextTick 实测
// offsetHeight 后重钳——CodesPage 六项菜单实际 ~304px，估小会漏钳（最下一条右键菜单
// 底部越出窗口）。jsdom 无布局，尺寸经 defineProperty 注入实测值。
function mockSize(el: Element, width: number, height: number): void {
  Object.defineProperty(el, 'offsetWidth', { value: width, configurable: true })
  Object.defineProperty(el, 'offsetHeight', { value: height, configurable: true })
}

function mountMenu(x: number, y: number) {
  return mount(MdMenu, {
    props: { x, y, open: true },
    slots: { default: '<button class="mi">a</button><button class="mi">b</button>' },
    attachTo: document.body,
  })
}

describe('MdMenu 视口钳制', () => {
  let originalInner: { width: number; height: number }
  beforeEach(() => {
    originalInner = { width: window.innerWidth, height: window.innerHeight }
    Object.defineProperty(window, 'innerWidth', { value: 400, configurable: true })
    Object.defineProperty(window, 'innerHeight', { value: 400, configurable: true })
  })
  afterEach(() => {
    Object.defineProperty(window, 'innerWidth', { value: originalInner.width, configurable: true })
    Object.defineProperty(window, 'innerHeight', { value: originalInner.height, configurable: true })
  })

  it('右/下越界：首帧估算钳制落位，nextTick 实测尺寸重钳（估小漏钳回归）', async () => {
    const w = mountMenu(10, 380)
    // 首帧（EST 200）：380+200 越界 → top = 400-200-8 = 192
    expect(w.attributes('style')).toContain('top: 192px')
    // 渲染后实测 304：380+304 越界更深 → top = 400-304-8 = 88
    mockSize(w.element, 140, 304)
    await nextTick()
    expect(w.attributes('style')).toContain('top: 88px')
    w.unmount()
  })

  it('横向越界同口径重钳；未越界保持指针坐标', async () => {
    const w = mountMenu(380, 50)
    mockSize(w.element, 140, 304)
    await nextTick()
    // left：380+140 越界 → 400-140-8 = 252；top：50+304 = 354 未越界 → 保持 50
    expect(w.attributes('style')).toContain('left: 252px')
    expect(w.attributes('style')).toContain('top: 50px')
    w.unmount()
  })

  it('实测尺寸钳到内边距仍超出视口（超小视口）时收敛到 GAP 下限', async () => {
    // 304+2*8 > 400：clamp 下限 GAP=8 生效，不出现负坐标
    Object.defineProperty(window, 'innerHeight', { value: 400, configurable: true })
    const w = mountMenu(10, 390)
    mockSize(w.element, 140, 500)
    await nextTick()
    expect(w.attributes('style')).toContain('top: 8px')
    w.unmount()
  })

  it('jsdom 无布局（offsetWidth/Height=0）回退估算值，不产生异常位置', async () => {
    const w = mountMenu(10, 380)
    // 不注入 mock：offsetHeight 实读 0 → || 回落 EST 200，位置维持首帧估算钳制
    await nextTick()
    expect(w.attributes('style')).toContain('top: 192px')
    w.unmount()
  })
})
