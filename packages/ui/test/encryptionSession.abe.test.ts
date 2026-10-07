import { describe, expect, it } from 'vitest'
import {
  createMemoryStorage, kekSourcesOf, newEntryFromUri, SECURITY_KEY,
  type SecuritySettings,
} from '@totp/core'
import { createVueStore } from '../src/store'

/** ABE 提权服务解锁来源（plan p6 §0.3/T5）：标记源 {kind:'abe'} 恒单份（无载荷——密文在服务
 *  HKLM），照 DPAPI 解锁来源三兄弟同款走 mutateSecurityOp 安全写协议。abe 源存在与否即
 *  「已启用 ABE」；绑定动作由 Task 6 UI 在 abe.bind() 成功后编排，本套件只验数据面 ops */
describe('ABE 解锁来源（plan p6 T5）', () => {
  async function setupEncrypted(): Promise<{ adapter: ReturnType<typeof createMemoryStorage>; s: ReturnType<typeof createVueStore> }> {
    const adapter = createMemoryStorage()
    const s = createVueStore(adapter)
    await s.initStore()
    await s.addEntryOp(newEntryFromUri('otpauth://totp/A:b?secret=JBSWY3DPEHPK3PXP', 1700000000000))
    await s.enableEncryption('pw')
    return { adapter, s }
  }

  const diskSecurity = async (adapter: ReturnType<typeof createMemoryStorage>): Promise<SecuritySettings> =>
    JSON.parse((await adapter.get(SECURITY_KEY))!) as SecuritySettings

  it('addAbeSourceOp：kekSources 写盘（password+abe），abeSource 视图反映绑定', async () => {
    const { adapter, s } = await setupEncrypted()
    expect(s.abeSource.value).toBeNull()
    await s.addAbeSourceOp()
    const srcs = kekSourcesOf(await diskSecurity(adapter))
    expect(srcs).toHaveLength(2)
    expect(srcs[1]).toEqual({ kind: 'abe' })
    expect(s.abeSource.value).toEqual({ kind: 'abe' })
  })

  it('abe 源恒单份：重复绑定替换而非追加（withAbeSource 语义）', async () => {
    const { adapter, s } = await setupEncrypted()
    await s.addAbeSourceOp()
    await s.addAbeSourceOp()
    const srcs = kekSourcesOf(await diskSecurity(adapter)).filter((x) => x.kind === 'abe')
    expect(srcs).toHaveLength(1)
    expect(s.abeSource.value).toEqual({ kind: 'abe' })
  })

  it('与 dpapi 源并存：互不挤占，移除 abe 后 dpapi 保留', async () => {
    const { adapter, s } = await setupEncrypted()
    await s.addDpapiSourceOp('WRAPPED-DEK')
    await s.addAbeSourceOp()
    const srcs = kekSourcesOf(await diskSecurity(adapter))
    expect(srcs).toHaveLength(3)
    expect(srcs.map((x) => x.kind)).toEqual(['password', 'dpapi', 'abe'])
    expect(s.abeSource.value).toEqual({ kind: 'abe' })
    expect(s.dpapiSource.value).toEqual({ wrappedDekD: 'WRAPPED-DEK' })
    await s.removeAbeSourceOp()
    expect(kekSourcesOf(await diskSecurity(adapter))).toEqual([
      { kind: 'password' },
      { kind: 'dpapi', wrappedDekD: 'WRAPPED-DEK' },
    ])
    expect(s.abeSource.value).toBeNull()
    expect(s.dpapiSource.value).toEqual({ wrappedDekD: 'WRAPPED-DEK' })
  })

  it('锁定态 abeSource 视图仍可见（LockScreen 渲染判定）；写 op 拒绝', async () => {
    const { s } = await setupEncrypted()
    await s.addAbeSourceOp()
    s.lock()
    expect(s.abeSource.value).toEqual({ kind: 'abe' })
    await expect(s.addAbeSourceOp()).rejects.toThrow('vault locked')
    await expect(s.removeAbeSourceOp()).rejects.toThrow('vault locked')
  })

  it('removeAbeSourceOp：盘上 kekSources 回落 password，视图清空', async () => {
    const { adapter, s } = await setupEncrypted()
    await s.addAbeSourceOp()
    await s.removeAbeSourceOp()
    expect(kekSourcesOf(await diskSecurity(adapter))).toEqual([{ kind: 'password' }])
    expect(s.abeSource.value).toBeNull()
  })
})
