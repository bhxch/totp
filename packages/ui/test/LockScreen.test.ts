import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import LockScreen from '../src/components/LockScreen.vue'
import type { VueStore } from '../src/store'

function mockStore(unlock: (pw: string) => Promise<void>): VueStore {
  return { unlock } as unknown as VueStore
}

describe('LockScreen', () => {
  it('解锁成功：调用 unlock、清空口令与错误、emit unlocked', async () => {
    const store = mockStore(vi.fn().mockResolvedValue(undefined))
    const w = mount(LockScreen, { props: { store } })
    await w.find('input[type="password"]').setValue('pw')
    await w.find('form').trigger('submit')
    await vi.waitFor(() => expect(store.unlock).toHaveBeenCalledWith('pw'))
    expect((w.get('input[type="password"]').element as HTMLInputElement).value).toBe('')
    expect(w.text()).not.toContain('口令错误')
    expect(w.emitted('unlocked')).toHaveLength(1)
  })

  it('口令错误：显示错误消息、不清 busy、不 emit unlocked', async () => {
    const store = mockStore(vi.fn().mockRejectedValue(new Error('口令错误或数据已损坏')))
    const w = mount(LockScreen, { props: { store } })
    await w.find('input[type="password"]').setValue('bad')
    await w.find('form').trigger('submit')
    await vi.waitFor(() => expect(w.text()).toContain('口令错误或数据已损坏'))
    expect(w.emitted('unlocked')).toBeUndefined()
  })
})
