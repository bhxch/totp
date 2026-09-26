/**
 * host 工厂共用引用协议(R4 宿主装配层内部件)。
 * HostRef:两端宿主持有 store/adapter 的形态不同——
 * - desktop:装配期(App.vue setup)store/adapter 未就绪(shallowRef null / fsAdapter 待 createTauriFs),
 *   经 getter 实时读取,未就绪 null;
 * - extension:store 自建即持值,adapter 为模块单例。
 * 工厂统一按 getter 归一:成员调用时实时解析,值形态恒非空,行为与两端原装配逐点等价。
 */

/** 宿主引用:值或延迟解析 getter(desktop 形态;null=未就绪) */
export type HostRef<T> = T | (() => T | null)

/** 归一为 getter(对象非函数形态恒返回常量值;T 均为对象类型,函数形态即 getter) */
export function toGetter<T>(ref: HostRef<T>): () => T | null {
  if (typeof ref !== 'function') return () => ref
  return ref as () => T | null
}

/** 就绪断言(装配工厂共用):未就绪统一中文报错(desktop 原语义收敛点,卡片展示) */
export function requireRef<T>(get: () => T | null, what = '数据尚未就绪'): T {
  const v = get()
  if (!v) throw new Error(what)
  return v
}
