import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDesktopAutoRunner, type AutoBackupDeps } from './autoBackup'

const JSON1 = '{"vault":1}'
const HASH1 = `hash(${JSON1})`

/** 基线 deps：解锁、有 secret、onChange=true、无 lastHash（可逐项覆写）。
 *  同时返回关键 mock 引用；over 未覆盖时二者同引用，覆盖后以 deps 上的为准 */
function makeDeps(over: Partial<AutoBackupDeps> = {}) {
  const doBackup = vi.fn(async () => null)
  const doCloudSync = vi.fn(async () => null)
  const setLastBackupHash = vi.fn()
  const onError = vi.fn()
  const deps: AutoBackupDeps = {
    isLocked: () => false,
    getSecret: () => 'sec',
    getVaultJson: () => JSON1,
    backupPrefs: () => ({ onChange: true, onInterval: false, intervalMinutes: 15 }),
    cloudPrefs: () => null,
    getLastBackupHash: () => null,
    setLastBackupHash,
    doBackup,
    doCloudSync,
    sha256Hex: async (s) => `hash(${s})`,
    onError,
    ...over,
  }
  return { deps, doBackup, doCloudSync, setLastBackupHash, onError }
}

// core 调度器消费 Date.now()/setTimeout/setInterval：连 Date 一并 fake 保证 tick 判定确定性
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
})
afterEach(() => {
  vi.useRealTimers()
})

describe('createDesktopAutoRunner（backup 通道）', () => {
  it('变更触发：解锁+有 secret+onChange=true+无 lastHash → doBackup 并记新 hash', async () => {
    const { deps, doBackup, setLastBackupHash } = makeDeps()
    createDesktopAutoRunner(deps).notifyChanged()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(doBackup).toHaveBeenCalledTimes(1)
    expect(doBackup).toHaveBeenCalledWith(JSON1, 'sec')
    expect(setLastBackupHash).toHaveBeenCalledWith(HASH1)
  })

  it('内容未变：lastHash===currentHash → 不调 doBackup', async () => {
    const { deps, doBackup, setLastBackupHash } = makeDeps({ getLastBackupHash: () => HASH1 })
    createDesktopAutoRunner(deps).notifyChanged()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(doBackup).not.toHaveBeenCalled()
    expect(setLastBackupHash).not.toHaveBeenCalled()
  })

  it('锁定 → 不调 doBackup（decideAutoRun locked 守护）', async () => {
    const { deps, doBackup } = makeDeps({ isLocked: () => true })
    createDesktopAutoRunner(deps).notifyChanged()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(doBackup).not.toHaveBeenCalled()
  })

  it('无 secret → 不调 doBackup（decideAutoRun no-secret 守护）', async () => {
    const { deps, doBackup } = makeDeps({ getSecret: () => null })
    createDesktopAutoRunner(deps).notifyChanged()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(doBackup).not.toHaveBeenCalled()
  })

  it('onChange=false 时 notifyChanged → 不调 doBackup', async () => {
    const { deps, doBackup } = makeDeps({ backupPrefs: () => ({ onChange: false, onInterval: false, intervalMinutes: 15 }) })
    createDesktopAutoRunner(deps).notifyChanged()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(doBackup).not.toHaveBeenCalled()
  })

  it('onInterval=true 到点 → doBackup；onInterval=false → 不调', async () => {
    const on = makeDeps({ backupPrefs: () => ({ onChange: false, onInterval: true, intervalMinutes: 15 }) })
    createDesktopAutoRunner(on.deps).start()
    await vi.advanceTimersByTimeAsync(15 * 60_000 + 30_000)
    expect(on.doBackup).toHaveBeenCalledTimes(1)
    expect(on.setLastBackupHash).toHaveBeenCalledWith(HASH1)

    const off = makeDeps({ backupPrefs: () => ({ onChange: false, onInterval: false, intervalMinutes: 15 }) })
    createDesktopAutoRunner(off.deps).start()
    await vi.advanceTimersByTimeAsync(15 * 60_000 + 30_000)
    expect(off.doBackup).not.toHaveBeenCalled()
  })

  it('doBackup 抛错：不向上抛，onError 收到 (err, "backup")', async () => {
    const boom = new Error('disk full')
    const { deps, onError } = makeDeps({ doBackup: vi.fn(async () => { throw boom }) })
    const runner = createDesktopAutoRunner(deps)
    runner.notifyChanged()
    // 调度器 onError 兜底后 run 的拒绝不外泄：此处 await 不 reject 即「不向上抛」
    await vi.advanceTimersByTimeAsync(10_000)
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledWith(boom, 'backup')
  })

  it('recordStatus：备份成功写 ok=true（summary 中文，如 已创建备份）', async () => {
    const recordStatus = vi.fn()
    const { deps } = makeDeps({ doBackup: vi.fn(async () => 'created'), recordStatus })
    createDesktopAutoRunner(deps).notifyChanged()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(recordStatus).toHaveBeenCalledTimes(1)
    expect(recordStatus).toHaveBeenCalledWith(true, '已创建备份')
  })

  it('recordStatus：覆盖模式成功写「已覆盖备份」', async () => {
    const recordStatus = vi.fn()
    const { deps } = makeDeps({ doBackup: vi.fn(async () => 'overwritten'), recordStatus })
    createDesktopAutoRunner(deps).notifyChanged()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(recordStatus).toHaveBeenCalledWith(true, '已覆盖备份')
  })

  it('recordStatus：备份失败写 ok=false（错误消息截断 100 字符），onError 仍收到', async () => {
    const recordStatus = vi.fn()
    const boom = new Error('x'.repeat(150))
    const { deps, onError } = makeDeps({ doBackup: vi.fn(async () => { throw boom }), recordStatus })
    createDesktopAutoRunner(deps).notifyChanged()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(recordStatus).toHaveBeenCalledWith(false, 'x'.repeat(100))
    expect(onError).toHaveBeenCalledWith(boom, 'backup')
  })
})

describe('createDesktopAutoRunner（cloud 通道）', () => {
  it('cloudPrefs 非 null + onInterval=true 到点 → doCloudSync（无 lastHash 门）', async () => {
    // lastHash===currentHash 也照样调用：云侧去重由多目标编排负责（Task 4 in-sync）
    const { deps, doBackup, doCloudSync } = makeDeps({
      cloudPrefs: () => ({ onChange: false, onInterval: true, intervalMinutes: 15 }),
      getLastBackupHash: () => HASH1,
    })
    createDesktopAutoRunner(deps).start()
    await vi.advanceTimersByTimeAsync(15 * 60_000 + 30_000)
    expect(doCloudSync).toHaveBeenCalledTimes(1)
    expect(doBackup).not.toHaveBeenCalled()
  })

  it('cloudPrefs()===null → 不调 doCloudSync', async () => {
    const { deps, doCloudSync } = makeDeps({ cloudPrefs: () => null, backupPrefs: () => ({ onChange: false, onInterval: true, intervalMinutes: 15 }) })
    createDesktopAutoRunner(deps).start()
    await vi.advanceTimersByTimeAsync(15 * 60_000 + 30_000)
    expect(doCloudSync).not.toHaveBeenCalled()
  })

  it('doCloudSync 抛错：onError 收到 (err, "cloud")，backup 通道不受影响', async () => {
    const boom = new Error('net down')
    const { deps, onError } = makeDeps({
      cloudPrefs: () => ({ onChange: false, onInterval: true, intervalMinutes: 15 }),
      doCloudSync: vi.fn(async () => { throw boom }),
    })
    createDesktopAutoRunner(deps).start()
    await vi.advanceTimersByTimeAsync(15 * 60_000 + 30_000)
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledWith(boom, 'cloud')
  })
})
