import { describe, expect, it } from 'vitest'
import { createMemoryStorage } from '@totp/core'
import { createVueStore } from '../src/store'

/** R6 硬约束守卫（refactor-plan §5.3）：createVueStore 返回对象形状不变——两端宿主
 *  （extension/desktop 装配）按结构类型消费这些成员，内部收敛/拆子工厂期间任何
 *  成员增删、改名、类别变化都应在此失败，而不是等宿主 typecheck 爆炸 */
const EXPECTED_KEYS = [
  'vault', 'settings', 'initStore', 'registerStorageSync', 'commit', 'commitSettings',
  'locked', 'hasEncryption', 'unlock', 'lock', 'enableEncryption', 'disableEncryption', 'changePassphrase',
  'securitySettings', 'prfSources', 'dpapiSource',
  'backupSecret', 'bagStored', 'credsCache',
  'mergeConflicts', 'conflictCount',
  'sealWithDek', 'unsealWithDek',
  'addMergeConflictsOp', 'saveMergeConflictsOp', 'resolveMergeConflictOp',
  'reloadBagFromDisk', 'setBackupSecret', 'forgetBackupSecret',
  'saveSourceCredOp', 'removeSourceCredOp', 'migrateLegacySecrets',
  'getCurrentDek',
  'unlockWithDek', 'addPrfSourceOp', 'removePrfSourceOp', 'addDpapiSourceOp', 'removeDpapiSourceOp',
  'addEntryOp', 'updateEntryOp', 'removeEntryOp', 'addTagOp', 'renameTagOp', 'removeTagOp', 'reorderOp', 'replaceAllOp',
].sort()

/** 只读/缓存视图成员（computed 或 ref，读 .value）；store.ts:55-58 注释：类型须为非 undefined 的
 *  Ref/ComputedRef——宿主 SecurityPlatform 等接口要求非 undefined */
const VIEW_KEYS = ['locked', 'hasEncryption', 'prfSources', 'dpapiSource', 'backupSecret', 'bagStored', 'conflictCount', 'securitySettings']
/** reactive/ref 数据成员（非函数，供组件渲染/直接读写） */
const DATA_KEYS = ['vault', 'settings', 'credsCache', 'mergeConflicts']

describe('createVueStore 返回对象形状（R6 硬约束守卫）', () => {
  it('成员集合精确不变（键名快照）', () => {
    const s = createVueStore(createMemoryStorage())
    expect(Object.keys(s).sort()).toEqual(EXPECTED_KEYS)
  })

  it('成员类别不变：computed 视图 / reactive 数据 / 函数', () => {
    const s = createVueStore(createMemoryStorage())
    for (const k of VIEW_KEYS) expect(s[k], k).toHaveProperty('value')
    for (const k of DATA_KEYS) expect(typeof s[k], k).not.toBe('function')
    for (const k of EXPECTED_KEYS) {
      if (VIEW_KEYS.includes(k) || DATA_KEYS.includes(k)) continue
      expect(typeof s[k], k).toBe('function')
    }
  })
})
