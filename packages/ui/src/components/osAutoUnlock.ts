import type { AbeOps, DpapiUnlockOps } from './securityPlatform'
import type { VueStore } from '../store'

/** OS 静默自动解锁共享编排（spec 2026-10-13 §A，原 LockScreen onMounted 内联逻辑原样抽出）：
 * ABE 优先（supported 且已绑定标记源）→ 失败无声回退 DPAPI → 两者皆败静默返回 false。
 * 供 LockScreen（主窗锁定页挂载）与 MiniApp（mini 打开/聚焦 boot，2026-10-13 §A）共用；
 * 解锁完成经 store.locked 翻转观察，成功后宿主自行 emit unlocked/切换视图。
 * DPAPI 静默失败属预期（换机/换用户），不打断手动解锁路径（重试入口由宿主渲染，I44）。 */
export async function attemptOsAutoUnlock(
  store: VueStore,
  dpapi?: DpapiUnlockOps | null,
  abe?: AbeOps | null,
): Promise<boolean> {
  if (abe?.supported && store.abeSource.value) {
    try {
      const dek = await abe.unwrap()
      if (!dek) throw new Error('ABE unwrap 不可用（服务未装/失配/不可达）')
      await store.unlockWithDek(dek)
      return true
    } catch (e) {
      console.warn('[lock] ABE 静默解锁失败，回退 OS 自动解锁通道', e)
    }
  }
  const src = dpapi?.source.value
  if (!dpapi || !src) return false
  try {
    const dek = await dpapi.unprotect(src.wrappedDekD)
    await store.unlockWithDek(dek)
    return true
  } catch {
    return false
  }
}
