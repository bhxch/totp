import { describe, expect, it } from 'vitest'
import * as core from '../src/index'

describe('@totp/core 桶导出面（防漏导出/改名破坏消费方）', () => {
  it('导出键集合快照：新增导出或改名时快照 diff 显式暴露，需有意更新', () => {
    const keys = Object.keys(core).sort()
    // 关键业务 API 语义锚（快照全量比对之外的可读锚点）
    for (const k of [
      'parseOtpUri', 'buildOtpUri', 'normalizeExtOtpauth', 'computeEntryCode',
      'createVault', 'loadVault', 'loadSettings', 'urlMatches', 'mergeVaults',
      'loadMergeConflicts', 'sealSecretBag', 'setupVaultEncryption', 'unlockVaultEncryption',
      'kekSourcesOf', 'createMemoryStorage', 'deriveKek', 'aesGcmEncrypt',
    ]) {
      expect(keys).toContain(k)
    }
    expect(keys).toMatchSnapshot()
  })
  it('关键导出为可调用值、版本常量可读（冒烟）', () => {
    expect(typeof core.parseOtpUri).toBe('function')
    expect(typeof core.createMemoryStorage).toBe('function')
    expect(typeof core.validateVaultObject).toBe('function')
    expect(core.CORE_VERSION).toBe('0.1.0')
  })
})
