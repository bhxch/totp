import { computed, ref, type ComputedRef, type Ref } from 'vue'

/**
 * 行内两步确认挂起态组（R7，原 CloudCard pendingAdopt/pendingReset/pendingRemove 三套同型
 * ask/cancel/confirm 收编）：每槽 pending 非空 = 该确认行展开，载荷为源 id 或待采纳 vault JSON。
 * ask 互斥：进入一个挂起前清空同组其余槽——同时至多一个行内确认展开（原「三态互斥」语义；
 * 可达面内各入口按钮在其余槽挂起时已禁用，清空余槽是防御兜底）。槽也可绕过 ask 直接赋值：
 * 「采用云端」挂起由同步结果发起（pendingAdopt = vault JSON），不经用户 ask。
 */
export interface ConfirmPattern<K extends string> {
  /** 各挂起槽（组件顶层解构后模板自动解包，沿用 pendingXxx 命名） */
  readonly slots: Readonly<Record<K, Ref<string | null>>>
  /** 进入挂起（先清空同组其余槽再置载荷） */
  ask(key: K, value: string): void
  /** 收起指定槽 */
  cancel(key: K): void
  /** 任一槽挂起中（同步等主操作按钮据此禁用，替代逐槽罗列） */
  readonly anyPending: ComputedRef<boolean>
}

export function useConfirmPattern<const K extends string>(keys: readonly K[]): ConfirmPattern<K> {
  const slots = {} as Record<K, Ref<string | null>>
  for (const k of keys) slots[k] = ref(null)

  function ask(key: K, value: string): void {
    for (const k of keys) slots[k].value = null
    slots[key].value = value
  }

  function cancel(key: K): void {
    slots[key].value = null
  }

  return {
    slots,
    ask,
    cancel,
    anyPending: computed(() => keys.some((k) => slots[k].value !== null)),
  }
}
