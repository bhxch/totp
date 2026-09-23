import { describe, expect, it, vi } from 'vitest'
import {
  clearSyncProgress, pendingMergeConfirm, requestMergeConfirm, setSyncProgress, settleMergeConfirm, syncProgressState,
} from '../src/components/cloudSyncBridge'

/** onManualConfirm 桥（宿主 runner → CloudCard 对话框）与逐源进度桥的 resolver 语义单测 */

const PREVIEW = { conflicts: [], mergeDegraded: false, sourceName: 'WebDAV' }

describe('cloudSyncBridge 合并确认（pending resolver 模式）', () => {
  it('request 后挂起非空（含 preview），settle(true) 以 true 结清并清空挂起', async () => {
    let settled: boolean | undefined
    const p = requestMergeConfirm(PREVIEW)
    void p.then((v) => { settled = v })
    expect(pendingMergeConfirm().value?.preview).toEqual(PREVIEW)
    settleMergeConfirm(true)
    await p
    expect(settled).toBe(true)
    expect(pendingMergeConfirm().value).toBeNull()
  })

  it('settle(false)=取消语义：runner 侧收到 false（记录跳过态）', async () => {
    const p = requestMergeConfirm(PREVIEW)
    settleMergeConfirm(false)
    await expect(p).resolves.toBe(false)
  })

  it('新征询到来时旧挂起按取消结清（single-flight 下的防御，不悬挂 promise）', async () => {
    const first = requestMergeConfirm(PREVIEW)
    const second = requestMergeConfirm({ ...PREVIEW, sourceName: 'S3' })
    await expect(first).resolves.toBe(false)
    expect(pendingMergeConfirm().value?.preview.sourceName).toBe('S3')
    settleMergeConfirm(true)
    await expect(second).resolves.toBe(true)
  })

  it('无挂起时 settle 幂等不抛', () => {
    expect(() => settleMergeConfirm(false)).not.toThrow()
  })

  it('60s 无裁定按取消自动结清（fail-closed）：runner 侧收 false、挂起清空，链不自悬挂死', async () => {
    vi.useFakeTimers()
    try {
      let settled: boolean | undefined
      const p = requestMergeConfirm(PREVIEW)
      void p.then((v) => { settled = v })
      await vi.advanceTimersByTimeAsync(59_999)
      expect(settled).toBeUndefined()
      await vi.advanceTimersByTimeAsync(1)
      expect(settled).toBe(false)
      expect(pendingMergeConfirm().value).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('settle 正常结清即取消超时 timer：越过阈值不误伤后续状态', async () => {
    vi.useFakeTimers()
    try {
      const p = requestMergeConfirm(PREVIEW)
      settleMergeConfirm(true)
      await expect(p).resolves.toBe(true)
      await vi.advanceTimersByTimeAsync(120_000)
      expect(pendingMergeConfirm().value).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('cloudSyncBridge 逐源进度', () => {
  it('setSyncProgress 记录 (done,total)；轮末 (total,total) 后可清空', () => {
    setSyncProgress(1, 2)
    expect(syncProgressState().value).toEqual({ done: 1, total: 2 })
    setSyncProgress(2, 2)
    expect(syncProgressState().value).toEqual({ done: 2, total: 2 })
    clearSyncProgress()
    expect(syncProgressState().value).toBeNull()
  })

  it('初始为 null（无同步在途）', () => {
    clearSyncProgress()
    expect(syncProgressState().value).toBeNull()
  })

  it('宿主回调短路：onProgress 直连 setSyncProgress 形态可用', () => {
    const onProgress = (done: number, total: number): void => setSyncProgress(done, total)
    onProgress(1, 3)
    expect(syncProgressState().value).toEqual({ done: 1, total: 3 })
  })
})
