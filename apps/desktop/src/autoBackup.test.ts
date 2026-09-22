import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDesktopAutoRunner, formatAutoStatusText, type AutoBackupDeps } from './autoBackup'

const JSON1 = '{"vault":1}'
const HASH1 = `hash(${JSON1})`

/** doBackup 全部成功结果（I8 结构化返回形态；可逐字段覆写构造 partial/failed/empty）。
 *  vaultJson=JSON1：M3 后基线以实际落盘内容计 hash → sha256Hex(JSON1)=HASH1 */
const OK_RESULT = { outcome: 'ok' as const, okCount: 1, failed: [], vaultJson: JSON1, summary: '已备份到 1 个目录（家里）' }

/** 基线 deps：解锁、有 secret、onChange=true、无 lastHash（可逐项覆写）。
 *  同时返回关键 mock 引用；over 未覆盖时二者同引用，覆盖后以 deps 上的为准 */
function makeDeps(over: Partial<AutoBackupDeps> = {}) {
  const doBackup = vi.fn(async () => OK_RESULT)
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
    expect(doBackup).toHaveBeenCalledWith('sec') // M3：vault 快照由 doBackup 内部单次取得，只传 secret
    expect(setLastBackupHash).toHaveBeenCalledWith(HASH1)
  })

  it('M3 基线以实际落盘内容计 hash：doBackup 期间 vault 再变不误标新基线', async () => {
    const JSON2 = '{"vault":2}'
    const HASH2 = `hash(${JSON2})`
    const { deps, setLastBackupHash } = makeDeps({
      // doBackup 内部取到的是变化后的 JSON2（decisionHash 快照 JSON1 与落盘内容错位的场景）
      doBackup: vi.fn(async () => ({ ...OK_RESULT, vaultJson: JSON2 })),
    })
    createDesktopAutoRunner(deps).notifyChanged()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(setLastBackupHash).toHaveBeenCalledWith(HASH2)
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

  it('recordStatus：全部源成功（outcome=ok）写 ok=true，summary 原样透传，基线推进', async () => {
    const recordStatus = vi.fn()
    const { deps, setLastBackupHash } = makeDeps({ doBackup: vi.fn(async () => ({ ...OK_RESULT, summary: '已创建备份' })), recordStatus })
    createDesktopAutoRunner(deps).notifyChanged()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(recordStatus).toHaveBeenCalledTimes(1)
    expect(recordStatus).toHaveBeenCalledWith(true, '已创建备份')
    expect(setLastBackupHash).toHaveBeenCalledWith(HASH1)
  })

  it('recordStatus：多源中文摘要（createBackupToSources summary）原样透传', async () => {
    const recordStatus = vi.fn()
    const summary = '已备份到 2 个目录（家里、办公室）'
    const { deps } = makeDeps({ doBackup: vi.fn(async () => ({ ...OK_RESULT, okCount: 2, summary })), recordStatus })
    createDesktopAutoRunner(deps).notifyChanged()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(recordStatus).toHaveBeenCalledWith(true, summary)
  })

  it('I8 部分失败（outcome=partial）：基线不动 + recordStatus(false, 失败明细)', async () => {
    const recordStatus = vi.fn()
    const { deps, setLastBackupHash } = makeDeps({
      doBackup: vi.fn(async () => ({ outcome: 'partial' as const, okCount: 1, failed: [{ source: '家里', error: 'disk full' }], vaultJson: JSON1, summary: '已备份到 1 个目录（办公室）；失败：家里' })),
      recordStatus,
    })
    createDesktopAutoRunner(deps).notifyChanged()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(setLastBackupHash).not.toHaveBeenCalled()
    expect(recordStatus).toHaveBeenCalledTimes(1)
    expect(recordStatus).toHaveBeenCalledWith(false, '已备份到 1 个目录（办公室）；失败：家里')
  })

  it('I8 全部失败（outcome=failed）：基线不动 + recordStatus(false, 失败名单)', async () => {
    const recordStatus = vi.fn()
    const { deps, setLastBackupHash } = makeDeps({
      doBackup: vi.fn(async () => ({ outcome: 'failed' as const, okCount: 0, failed: [{ source: '家里', error: 'disk full' }], vaultJson: JSON1, summary: '备份失败：家里' })),
      recordStatus,
    })
    createDesktopAutoRunner(deps).notifyChanged()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(setLastBackupHash).not.toHaveBeenCalled()
    expect(recordStatus).toHaveBeenCalledWith(false, '备份失败：家里')
  })

  it('I8 无启用源（outcome=empty）：基线不动 + recordStatus(null, 提示)', async () => {
    const recordStatus = vi.fn()
    const { deps, setLastBackupHash } = makeDeps({
      doBackup: vi.fn(async () => ({ outcome: 'empty' as const, okCount: 0, failed: [], vaultJson: JSON1, summary: '未配置启用的备份目录' })),
      recordStatus,
    })
    createDesktopAutoRunner(deps).notifyChanged()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(setLastBackupHash).not.toHaveBeenCalled()
    expect(recordStatus).toHaveBeenCalledWith(null, '未配置启用的备份目录')
  })

  it('I8 基线不动后同内容下轮仍重试（不被 unchanged 跳过，自愈通道）', async () => {
    const doBackup = vi.fn(async () => ({ outcome: 'failed' as const, okCount: 0, failed: [{ source: '家里', error: 'disk full' }], vaultJson: JSON1, summary: '备份失败：家里' }))
    const { deps, setLastBackupHash } = makeDeps({ doBackup })
    const runner = createDesktopAutoRunner(deps)
    runner.notifyChanged()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(doBackup).toHaveBeenCalledTimes(1)
    expect(setLastBackupHash).not.toHaveBeenCalled()
    runner.notifyChanged() // lastHash 仍为 null → decideAutoRun 不判 unchanged，照常重试
    await vi.advanceTimersByTimeAsync(10_000)
    expect(doBackup).toHaveBeenCalledTimes(2)
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

  it('recordStatus：locked skip 记 null 跳过态（库已锁定），不备份', async () => {
    const recordStatus = vi.fn()
    const { deps, doBackup } = makeDeps({ isLocked: () => true, recordStatus })
    createDesktopAutoRunner(deps).notifyChanged()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(doBackup).not.toHaveBeenCalled()
    expect(recordStatus).toHaveBeenCalledTimes(1)
    expect(recordStatus).toHaveBeenCalledWith(null, '库已锁定')
  })

  it('recordStatus：no-secret skip 记 null 跳过态（未设置备份口令）', async () => {
    const recordStatus = vi.fn()
    const { deps, doBackup } = makeDeps({ getSecret: () => null, recordStatus })
    createDesktopAutoRunner(deps).notifyChanged()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(doBackup).not.toHaveBeenCalled()
    expect(recordStatus).toHaveBeenCalledTimes(1)
    expect(recordStatus).toHaveBeenCalledWith(null, '未设置备份口令')
  })

  it('recordStatus：unchanged skip 维持静默（不记状态）', async () => {
    const recordStatus = vi.fn()
    const { deps } = makeDeps({ getLastBackupHash: () => HASH1, recordStatus })
    createDesktopAutoRunner(deps).notifyChanged()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(recordStatus).not.toHaveBeenCalled()
  })
})

describe('createDesktopAutoRunner.runBackupNow（spec §6.1 trigger_backup 执行体，T6）', () => {
  it('绕过偏好门：onChange=false 也执行 doBackup 并推进基线', async () => {
    const { deps, doBackup, setLastBackupHash } = makeDeps({
      backupPrefs: () => ({ onChange: false, onInterval: false, intervalMinutes: 15 }),
    })
    await createDesktopAutoRunner(deps).runBackupNow()
    expect(doBackup).toHaveBeenCalledTimes(1)
    expect(doBackup).toHaveBeenCalledWith('sec')
    expect(setLastBackupHash).toHaveBeenCalledWith(HASH1)
  })

  it('decideAutoRun 守护照常：锁定静默跳过（不调 doBackup、记 null 跳过态）', async () => {
    const recordStatus = vi.fn()
    const { deps, doBackup } = makeDeps({ isLocked: () => true, recordStatus })
    await createDesktopAutoRunner(deps).runBackupNow()
    expect(doBackup).not.toHaveBeenCalled()
    expect(recordStatus).toHaveBeenCalledWith(null, '库已锁定')
  })

  it('unchanged 静默跳过：不调 doBackup、不记状态（与自动通道同口径）', async () => {
    const recordStatus = vi.fn()
    const { deps, doBackup } = makeDeps({ getLastBackupHash: () => HASH1, recordStatus })
    await createDesktopAutoRunner(deps).runBackupNow()
    expect(doBackup).not.toHaveBeenCalled()
    expect(recordStatus).not.toHaveBeenCalled()
  })

  it('并发调用排队串行（审查 Important 1 single-flight 链）：首轮在跑时第二轮等待，不并发 doBackup', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const doBackup = vi.fn(() => gate.then(() => ({ ...OK_RESULT })))
    const { deps } = makeDeps({ doBackup })
    const runner = createDesktopAutoRunner(deps)
    const p1 = runner.runBackupNow()
    const p2 = runner.runBackupNow()
    await vi.advanceTimersByTimeAsync(0)
    expect(doBackup).toHaveBeenCalledTimes(1) // 第二轮已排队，未并发执行
    release()
    await Promise.all([p1, p2])
    expect(doBackup).toHaveBeenCalledTimes(2)
  })

  it('前轮失败不毒化队列：后轮照常执行（链不断）', async () => {
    const doBackup = vi
      .fn()
      .mockImplementationOnce(async () => {
        throw new Error('disk full')
      })
      .mockImplementationOnce(async () => OK_RESULT)
    const { deps, setLastBackupHash } = makeDeps({ doBackup })
    const runner = createDesktopAutoRunner(deps)
    const p1 = runner.runBackupNow()
    const p2 = runner.runBackupNow()
    await expect(p1).rejects.toThrow('disk full')
    await p2
    expect(doBackup).toHaveBeenCalledTimes(2)
    expect(setLastBackupHash).toHaveBeenCalledWith(HASH1)
  })
})

describe('formatAutoStatusText（宿主状态行格式化，App.vue readAutoStatusText 委托）', () => {
  // 本地时区构造 + 本地时区格式化，断言与运行环境时区无关
  const AT = new Date(2026, 8, 17, 14, 30).getTime()

  it('ok=true → 「YYYY-MM-DD HH:mm 成功：summary」', () => {
    expect(formatAutoStatusText(JSON.stringify({ at: AT, ok: true, summary: '已创建备份' }))).toBe('2026-09-17 14:30 成功：已创建备份')
  })
  it('ok=false → 失败：summary', () => {
    expect(formatAutoStatusText(JSON.stringify({ at: AT, ok: false, summary: 'disk full' }))).toBe('2026-09-17 14:30 失败：disk full')
  })
  it('ok=null → 跳过：summary（写侧 summary 仅存原因，前缀由格式化拼装）', () => {
    expect(formatAutoStatusText(JSON.stringify({ at: AT, ok: null, summary: '库已锁定' }))).toBe('2026-09-17 14:30 跳过：库已锁定')
  })
  it('向后兼容：旧 JSON 无 ok 字段 → 按失败渲染（现状语义不变）', () => {
    expect(formatAutoStatusText(JSON.stringify({ at: AT, summary: '旧数据' }))).toBe('2026-09-17 14:30 失败：旧数据')
  })
  it('缺字段/空 summary/坏 JSON/null → null（卡片显示「暂无」）', () => {
    expect(formatAutoStatusText(JSON.stringify({ ok: true, summary: 'x' }))).toBeNull() // 缺 at
    expect(formatAutoStatusText(JSON.stringify({ at: AT, ok: true, summary: '' }))).toBeNull() // 空 summary
    expect(formatAutoStatusText('{bad json')).toBeNull()
    expect(formatAutoStatusText(null)).toBeNull()
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
