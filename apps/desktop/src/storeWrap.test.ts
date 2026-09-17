/**
 * T14 审查修复探针（运行时确证 + 防回归）：desktop 宿主曾以深 `ref<VueStore|null>` 持有 store——
 * Vue 的深 ref 会对值做 reactive 深代理，代理 get 对嵌套 ref/computed 成员自动解包，闭包路径
 * `wrapper.value.<成员>.value` 与组件 prop 路径 `props.store.<成员>.value` 全部失效（探针组①-⑤实证，
 * 曾致自动备份/云同步恒跳过、creds/kdfProfile/锁定判定全族失效）。根修=shallowRef（组⑥-⑨）。
 * 注意：深 ref 的静态 TS 类型**不**模拟运行时深解包，故旧模式断言一律经 `as unknown` 动态访问，
 * 防回归要点=浅包装下成员必须保持真 ref（isRef 真 + .value 可用）。
 */
import { describe, expect, it } from 'vitest'
import { createMemoryStorage } from '@totp/core'
import { createVueStore, type VueStore } from '@totp/ui'
import { computed, isRef, ref, shallowRef } from 'vue'

function makeStore(): VueStore {
  return createVueStore(createMemoryStorage(), { windowId: 'probe' }) as VueStore
}

/** 深 ref 值的动态视图（绕开与运行时深解包相反的静态类型，访问成员真实形状） */
type DeepView = Record<string, { value?: unknown } | unknown>

describe('深 ref 包装（旧模式，仅作行为存证）：嵌套 ref/computed 成员被自动解包', () => {
  it('①闭包路径：locked 解包为 boolean，.value 得 undefined（isLocked 恒 true）', () => {
    const wrapper = ref<VueStore | null>(null)
    wrapper.value = makeStore()
    const view = wrapper.value as unknown as DeepView
    // 真实形状断言：不是 ComputedRef 而是 boolean（解包发生）
    expect(isRef(view['locked'])).toBe(false)
    expect(typeof view['locked']).toBe('boolean')
    // App.vue isLocked 闭包 `(store.value?.locked.value ?? true)` 实际求值结果
    expect((view['locked'] as { value?: unknown }).value).toBeUndefined()
    const isLocked = () => ((wrapper.value as unknown as DeepView)['locked'] as { value?: unknown }).value ?? true
    expect(isLocked()).toBe(true) // 解锁态也恒 true → 自动备份/云同步恒 locked 跳过
  })

  it('②getSecret 闭包：backupSecret 解包为裸值（锁定态 null）——null.value 直接抛 TypeError', () => {
    const wrapper = ref<VueStore | null>(null)
    wrapper.value = makeStore()
    const view = wrapper.value as unknown as DeepView
    expect(isRef(view['backupSecret'])).toBe(false)
    expect(view['backupSecret']).toBeNull() // 锁定态解包为 null（非 ComputedRef）
    const getSecret = () => (view['backupSecret'] as { value?: unknown }).value ?? null
    expect(getSecret).toThrow(TypeError) // 真机每次自动通道触发即抛（非「恒 null」）
  })

  it('③creds getter：credsCache 解包为普通对象，.value 得 undefined（CloudCard 读 creds 崩）', () => {
    const wrapper = ref<VueStore | null>(null)
    wrapper.value = makeStore()
    const view = wrapper.value as unknown as DeepView
    expect((view['credsCache'] as { value?: unknown }).value).toBeUndefined()
  })

  it('④prfSources 解包为数组：`.value.map` 抛 TypeError（SecurityCard passkey.sources 必崩）', () => {
    const wrapper = ref<VueStore | null>(null)
    wrapper.value = makeStore()
    const view = wrapper.value as unknown as DeepView
    expect(Array.isArray(view['prfSources'])).toBe(true)
    expect(() => (view['prfSources'] as { value: unknown[] }).value.map((p) => p)).toThrow(TypeError)
  })

  it('⑤prop 路径同病：组件收到的 props.store（=wrapper.value 代理）上 .value 访问同样失效', () => {
    const wrapper = ref<VueStore | null>(null)
    wrapper.value = makeStore()
    const propsStore = wrapper.value as unknown as DeepView
    // locked 初始 false（解包 boolean）→ .value=undefined
    expect((propsStore['locked'] as { value?: unknown }).value).toBeUndefined()
    // securitySettings 初始 null（ref(null) 解包）→ .value 直接抛 TypeError（组件读档位/口令天数即崩）
    expect(() => (propsStore['securitySettings'] as { value?: unknown }).value).toThrow(TypeError)
  })
})

describe('shallowRef 包装（根修模式）：成员保持原始 ref/computed，闭包与 prop 语义均正确', () => {
  it('⑥locked/backupSecret/credsCache/prfSources 均为真 ref，.value 正常', () => {
    const wrapper = shallowRef<VueStore | null>(null)
    wrapper.value = makeStore()
    expect(isRef(wrapper.value.locked)).toBe(true)
    expect(wrapper.value.locked.value).toBe(false) // 未加密默认解锁
    expect(isRef(wrapper.value.backupSecret)).toBe(true)
    expect(wrapper.value.backupSecret.value).toBeNull()
    expect(isRef(wrapper.value.credsCache)).toBe(true)
    expect(wrapper.value.credsCache.value).toEqual({})
    // SecurityCard/LockScreen 消费路径：.value.map 不再抛
    expect(() => wrapper.value!.prfSources.value.map((p) => p)).not.toThrow()
  })

  it('⑦闭包语义：isLocked()/getSecret() 反映真实解锁态（不再恒跳过/不再抛）', () => {
    const wrapper = shallowRef<VueStore | null>(null)
    wrapper.value = makeStore()
    const isLocked = () => (wrapper.value?.locked.value ?? true)
    const getSecret = () => (wrapper.value?.backupSecret.value ?? null)
    expect(isLocked()).toBe(false)
    expect(getSecret()).toBeNull()
  })

  it('⑧prop 路径：props.store（=原始对象）上 .value 正常（ui 组件既有消费形态兼容）', () => {
    const wrapper = shallowRef<VueStore | null>(null)
    wrapper.value = makeStore()
    const propsStore: unknown = wrapper.value
    expect(isRef((propsStore as { locked: unknown }).locked)).toBe(true)
    expect((propsStore as { locked: { value: boolean } }).locked.value).toBe(false)
  })

  it('⑨顶层解包不受影响：模板 setupState 的 unref 只解顶层，locked 计算属性可行', () => {
    const wrapper = shallowRef<VueStore | null>(null)
    wrapper.value = makeStore()
    // App.vue/MiniApp.vue 根修后模板改用 computed 顶层暴露：`v-else-if="store && locked"`
    const locked = computed(() => wrapper.value?.locked.value ?? false)
    expect(locked.value).toBe(false)
  })
})
