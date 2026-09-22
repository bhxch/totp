/**
 * 云同步 UI 桥（T11）：宿主 runner 回调（onManualConfirm/onProgress）→ CloudCard UI 的进程内
 * 通道。宿主（desktop App.vue / extension cloudRunnerFactory）与 CloudCard 分属组件树两端且
 * CloudCard 经 SyncPage 深层挂载，provide/inject 链路长；按简报取简：模块级 reactive 槽位 +
 * pending resolver 模式——runner 侧 request 挂起 Promise，CloudCard 侧组件事件 settle 结清。
 * 单页运行时内单 runner 单 CloudCard，模块级单槽即天然互斥（并发征询由 request 防御结清）。
 */
import { ref } from 'vue'
import type { Ref } from 'vue'
import type { ManualMergePreview } from './cloudRunner'

/** 一次挂起的合并预览征询：preview 供对话框渲染，resolve 结清 runner 侧 Promise */
export interface PendingMergeConfirm {
  preview: ManualMergePreview
  resolve(ok: boolean): void
}

const pendingConfirm = ref<PendingMergeConfirm | null>(null)
const progress = ref<{ done: number; total: number } | null>(null)

/**
 * manual 合并预览征询（宿主 runner onManualConfirm 实现）：挂起等待 CloudCard 对话框裁定。
 * resolve(true)=确认执行 apply；resolve(false)=取消（runner 记跳过态）。防御：已有挂起（理论
 * 不出现——runner single-flight 串行）按取消先结清，避免旧 Promise 永悬挂。
 */
export function requestMergeConfirm(preview: ManualMergePreview): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    pendingConfirm.value?.resolve(false)
    pendingConfirm.value = { preview, resolve }
  })
}

/** CloudCard 订阅的挂起征询（null=无；非空=对话框应打开） */
export function pendingMergeConfirm(): Readonly<Ref<PendingMergeConfirm | null>> {
  return pendingConfirm
}

/** 裁决结清（CloudCard 确认/取消/卸载共用）：清槽先行防双击双结，无挂起时幂等 no-op */
export function settleMergeConfirm(ok: boolean): void {
  const p = pendingConfirm.value
  pendingConfirm.value = null
  p?.resolve(ok)
}

/** 逐源进度（宿主 runner onProgress 实现）：done=已完成目标数，total=参与目标数。
 *  轮末 (total,total) 后由 CloudCard 按 done<total 条件自然隐藏；preview 轮同样推进 */
export function setSyncProgress(done: number, total: number): void {
  progress.value = { done, total }
}

/** CloudCard 订阅的进度状态（null=本会话尚无进度事件） */
export function syncProgressState(): Readonly<Ref<{ done: number; total: number } | null>> {
  return progress
}

/** 清空进度（测试与轮间隙复位用；UI 展示不依赖显式清空） */
export function clearSyncProgress(): void {
  progress.value = null
}
