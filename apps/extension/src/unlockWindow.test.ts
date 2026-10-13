// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, type Ref } from 'vue'
import { mount } from '@vue/test-utils'

const { closeMock, initStoreMock, stubProps } = vi.hoisted(() => ({
  closeMock: vi.fn(),
  initStoreMock: vi.fn(),
  stubProps: {} as Record<string, unknown>,
}))
Object.defineProperty(window, 'close', { value: closeMock, writable: true, configurable: true })

// unlock 页对宿主模块的全部依赖打桩：store 工厂（locked 用真 ref 供模板响应）/ dekSession /
// @totp/ui（LockScreen 用点击 emit unlocked 的桩替代，i18n 桩带 install 防 Vue 告警）。
// __testLocked 导出供测试翻转锁定态（App 只解构 initStore/locked，多余导出无碍）
vi.mock('./store', async () => {
  const { ref } = await import('vue')
  const locked = ref(true)
  return {
    __testLocked: locked,
    createExtensionStore: vi.fn(() => ({ initStore: initStoreMock, locked })),
    persistFailed: ref(false),
    storageAdapter: {},
  }
})
vi.mock('./dekSession', () => ({
  createDekSession: () => ({ get: async () => null, set: async () => {}, clear: async () => {} }),
}))
vi.mock('@totp/ui', () => ({
  createAppI18n: () => ({ install() {}, global: { t: (k: string) => k } }),
  useTheme: vi.fn(),
  LockScreen: defineComponent({
    props: { store: { type: Object, required: true }, autoPasskey: { type: Boolean, default: false } },
    emits: ['unlocked'],
    setup(props) {
      for (const k of Object.keys(stubProps)) delete stubProps[k]
      Object.assign(stubProps, props)
    },
    template: '<button data-test="stub-unlock" @click="$emit(\'unlocked\')"></button>',
  }),
}))

import App from '../entrypoints/unlock/App.vue'
import * as store from './store'

// __testLocked 仅存在于 vi.mock 工厂（真实模块无此导出，vue-tsc 按真实导出面检查）：
// 命名空间导入 + 双层断言穿透取运行时桩句柄
const __testLocked = (store as unknown as { __testLocked: Ref<boolean> }).__testLocked

describe('unlock 解锁窗 App（spec §B）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    initStoreMock.mockResolvedValue(undefined)
    __testLocked.value = true
    window.history.replaceState(null, '', '/')
  })

  const mountApp = async () => {
    const w = mount(App)
    await new Promise((r) => setTimeout(r, 0))
    return w
  }

  it('boot 已解锁（session DEK 在）：立即自关，不渲染锁屏（Review Focus 3）', async () => {
    __testLocked.value = false
    const w = await mountApp()
    expect(closeMock).toHaveBeenCalled()
    expect(w.find('[data-test="stub-unlock"]').exists()).toBe(false)
  })

  it('锁定态：渲染 LockScreen，?unlock=passkey 时透传 autoPasskey=true', async () => {
    window.history.replaceState(null, '', '/?unlock=passkey')
    const w = await mountApp()
    expect(closeMock).not.toHaveBeenCalled()
    expect(w.find('[data-test="stub-unlock"]').exists()).toBe(true)
    expect(stubProps.autoPasskey).toBe(true)
  })

  it('解锁成功（unlocked 事件）：window.close 自关', async () => {
    const w = await mountApp()
    await w.find('[data-test="stub-unlock"]').trigger('click')
    expect(closeMock).toHaveBeenCalledTimes(1)
  })

  it('boot 异常：自关回退 popup 口令路径，不留死窗', async () => {
    initStoreMock.mockRejectedValueOnce(new Error('storage broken'))
    await mountApp()
    expect(closeMock).toHaveBeenCalled()
  })
})
