import { describe, expect, it, vi } from 'vitest'
import {
  SECURITY_KEY, VAULT_KEY, VAULT_REV_WATERMARK_KEY, VaultRollbackError, aesGcmEncrypt, bytesToBase64, createMemoryStorage,
  decryptVaultWithDekDetailed, dekFingerprint, newEntryFromUri, randomBytes, setupVaultEncryption,
  type Vault,
} from '@totp/core'
import { createVueStore } from '../src/store'

function flush(): Promise<void> { return new Promise((r) => setTimeout(r, 0)) }
const entry = (tag: string) => newEntryFromUri(`otpauth://totp/A:${tag}?secret=JBSWY3DPEHPK3PXP`, 1700000000000)

/** 建盘：解锁 + 三条目加密落盘（rev 2、水位 2），并捕获 rev-1 代密文供回放 */
async function seedWithReplaySnapshot(): Promise<{
  adapter: ReturnType<typeof createMemoryStorage>
  a: ReturnType<typeof createVueStore>
  replayCiphertext: string
  notify: (p: { vault?: boolean; settings?: boolean }) => void
}> {
  const adapter = createMemoryStorage()
  let notify: ((p: { vault?: boolean; settings?: boolean }) => void) | null = null
  const a = createVueStore(adapter, { registerSync: (cb) => { notify = cb }, selfWriteSuppressMs: 0 })
  await a.initStore()
  a.registerStorageSync()
  await a.addEntryOp(entry('A'))
  await a.enableEncryption('pw') // 记录 rev 未定义（按 0），无水位
  await a.addEntryOp(entry('B')) // rev 1，水位 {fp,1}
  const replayCiphertext = (await adapter.get(VAULT_KEY))!
  await a.addEntryOp(entry('C')) // rev 2，水位 {fp,2}
  return { adapter, a, replayCiphertext, notify: (p) => notify!(p) }
}

describe('vault 新鲜性水位与 AAD 迁移（F8）', () => {
  it('新写密文 AAD 绑定 + rev 推进 + 水位键写入；重载往返无行为变化', async () => {
    const adapter = createMemoryStorage()
    const s = createVueStore(adapter)
    await s.initStore()
    await s.addEntryOp(entry('A'))
    // 明文时代：无水位键、记录无 rev（行为不变）
    expect(await adapter.get(VAULT_REV_WATERMARK_KEY)).toBeNull()
    expect(JSON.parse((await adapter.get(VAULT_KEY))!).rev).toBeUndefined()

    await s.enableEncryption('pw')
    await s.addEntryOp(entry('B'))
    const detailed = await decryptVaultWithDekDetailed(s.getCurrentDek()!, JSON.parse((await adapter.get(VAULT_KEY))!))
    expect(detailed.legacy).toBe(false) // 新写入均 AAD 绑定
    const parsed = JSON.parse(detailed.json) as Vault
    expect(parsed.entries).toHaveLength(2)
    expect(parsed.rev).toBe(1)
    const wm = JSON.parse((await adapter.get(VAULT_REV_WATERMARK_KEY))!) as { v: number; dek: string; rev: number }
    expect(wm).toEqual({ v: 1, dek: await dekFingerprint(s.getCurrentDek()!), rev: 1 })

    // 重载往返：解锁读到全部条目
    const s2 = createVueStore(adapter)
    await s2.initStore()
    await s2.unlock('pw')
    expect(s2.vault.entries).toHaveLength(2)
  })

  it('旧格式（无 AAD）密文经回退解锁；下次保存自动迁移为 AAD 绑定并推进 rev/水位', async () => {
    const adapter = createMemoryStorage()
    const { security, dek } = await setupVaultEncryption(JSON.stringify({ version: 2, entries: [], tags: [], updatedAt: 0 }), 'pw')
    const legacyJson = JSON.stringify({ version: 2, entries: [{ uuid: 'legacy' }], tags: [], updatedAt: 5 })
    const nonce = randomBytes(12)
    await adapter.set(SECURITY_KEY, JSON.stringify(security))
    await adapter.set(VAULT_KEY, JSON.stringify({
      v: 1, enc: true, dataNonce: bytesToBase64(nonce),
      ciphertext: bytesToBase64(await aesGcmEncrypt(dek, new TextEncoder().encode(legacyJson), nonce)), // 无 AAD
    }))
    const s = createVueStore(adapter)
    await s.initStore()
    await s.unlock('pw') // 回退解密：legacy 内容正常装载
    expect(s.locked.value).toBe(false)
    expect(s.vault.entries).toHaveLength(1)
    // 下次保存：全量重加密 → AAD 绑定（legacy=false）+ rev 越水位推进 + 水位键写入
    await s.addEntryOp(entry('B'))
    const detailed = await decryptVaultWithDekDetailed(dek, JSON.parse((await adapter.get(VAULT_KEY))!))
    expect(detailed.legacy).toBe(false)
    expect((JSON.parse(detailed.json) as Vault).rev).toBe(1)
    const wm = JSON.parse((await adapter.get(VAULT_REV_WATERMARK_KEY))!) as { v: number; dek: string; rev: number }
    expect(wm).toEqual({ v: 1, dek: await dekFingerprint(dek), rev: 1 })
  })

  it('回滚检测：采纳 rev N-1（< 水位 N）→ unlock 抛 VaultRollbackError；通知路径拒绝采纳不上锁，后续自愈写覆盖旧密文', async () => {
    const { adapter, a, replayCiphertext, notify } = await seedWithReplaySnapshot()
    // 存储写入者把 VAULT_KEY 回卷到 rev-1 代密文（水位键留存 → 部分状态回放被检出）
    await adapter.set(VAULT_KEY, replayCiphertext)
    // 采纳点 1：unlock
    const b = createVueStore(adapter)
    await b.initStore()
    expect(b.locked.value).toBe(true)
    await expect(b.unlock('pw')).rejects.toThrow(VaultRollbackError)
    expect(b.locked.value).toBe(true) // 锁定态不前进，未静默采纳
    // 采纳点 2：远端通知（同窗口仍持 rev-2 内存态）→ 拒绝采纳且不上锁
    notify({ vault: true })
    await flush()
    expect(a.locked.value).toBe(false)
    expect(a.vault.entries).toHaveLength(3)
    // 自愈写：内存 rev-2 内容以 rev 3 覆盖盘上旧密文
    await a.addEntryOp(entry('D'))
    const healed = await decryptVaultWithDekDetailed(a.getCurrentDek()!, JSON.parse((await adapter.get(VAULT_KEY))!))
    expect((JSON.parse(healed.json) as Vault).rev).toBe(3)
    expect((JSON.parse(healed.json) as Vault).entries).toHaveLength(4)
    // 自愈后新窗口可正常解锁（rev 3 ≥ 水位 3）
    const c = createVueStore(adapter)
    await c.initStore()
    await c.unlock('pw')
    expect(c.vault.entries).toHaveLength(4)
  })

  it('应用内恢复（replaceAllOp 换入无 rev 旧备份）不被误拒：写入 rev 越水位，重载可解锁', async () => {
    const { adapter } = await seedWithReplaySnapshot()
    const a = createVueStore(adapter)
    await a.initStore()
    await a.unlock('pw')
    // 用户显式恢复旧备份：内容无 rev（旧格式），写入时 rev 取 max(内存, 水位)+1 = 3
    await a.replaceAllOp({ version: 2, entries: [{ uuid: 'restored' }], tags: [], updatedAt: 42 } as unknown as Vault)
    const c = createVueStore(adapter)
    await c.initStore()
    await c.unlock('pw')
    expect(c.locked.value).toBe(false)
    expect(c.vault.entries).toHaveLength(1)
    expect(c.vault.updatedAt).toBe(42)
  })

  it('合法外部恢复路径：删除水位键解除拒绝（整库回灌旧密文属显式外部操作，文档化语义）', async () => {
    const { adapter, replayCiphertext } = await seedWithReplaySnapshot()
    await adapter.set(VAULT_KEY, replayCiphertext)
    const b = createVueStore(adapter)
    await b.initStore()
    await expect(b.unlock('pw')).rejects.toThrow(VaultRollbackError)
    // 显式恢复动作：外部回灌时同步清除水位（或整库清空重置）
    await adapter.delete(VAULT_REV_WATERMARK_KEY)
    await b.unlock('pw')
    expect(b.locked.value).toBe(false)
    expect(b.vault.entries).toHaveLength(2) // rev-1 代内容（A+B；enableEncryption 序列化了明文期已存的 A）
  })

  it('双端独立加密（异 DEK 谱系）：rev 不可比不设防，维持既有「远端者胜」语义', async () => {
    const adapter = createMemoryStorage()
    let notify: ((p: { vault?: boolean; settings?: boolean }) => void) | null = null
    const b = createVueStore(adapter, { registerSync: (cb) => { notify = cb }, selfWriteSuppressMs: 0 })
    await b.initStore()
    await b.addEntryOp(entry('B'))
    await b.enableEncryption('pwB') // b 谱系：rev 1、水位 {fpB,1}
    b.registerStorageSync()
    // 设备 A 独立加密落盘（异 DEK、无 rev）：按既有语义 b 转锁定等远端口令
    const remote = await setupVaultEncryption(JSON.stringify({ version: 2, entries: [{ uuid: 'a' }], tags: [], updatedAt: 7 }), 'pwA')
    await adapter.set(SECURITY_KEY, JSON.stringify(remote.security))
    await adapter.set(VAULT_KEY, JSON.stringify(remote.encrypted))
    notify!({ vault: true })
    // 通知处理链含原生 webcrypto 异步解密，单次 flush 会与原生回调竞速（同 store.test.ts 既有裁定）：轮询等终态
    await vi.waitFor(() => expect(b.locked.value).toBe(true))
    await b.unlock('pwA') // 异谱系跳过 rev 守卫：不误报回滚
    expect(b.locked.value).toBe(false)
    expect(b.vault.entries).toHaveLength(1)
  })
})
