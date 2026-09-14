import {
  DEFAULT_SETTINGS, SECURITY_KEY, VAULT_KEY, addEntry, addGroup, changeVaultPassphrase, createVault,
  decryptVaultWithDek, encryptVaultWithDek, isEncryptedVault, loadSettings, loadVault, removeEntry,
  removeGroup, renameGroup, reorderEntries, saveSettings, saveVault, setupVaultEncryption,
  unlockVaultEncryption, updateEntry,
  type AppSettings, type OtpEntry, type SecuritySettings, type StorageAdapter, type Vault,
} from '@totp/core'
import { computed, reactive, ref, toRaw } from 'vue'

export function createVueStore(
  adapter: StorageAdapter,
  opts: {
    registerSync?: (cb: (payload: { vault?: boolean; settings?: boolean }) => void) => void
    /** 队列内写操作（commit/commitSettings/enable/disable/changePassphrase 等 op）成功后的统一回调：
     *  extension 场景用于触发浏览器同步推送调度，保证所有写路径无遗漏（desktop 不传则零行为） */
    onCommitted?: () => void
  } = {},
) {
  const vault = reactive<Vault>({ version: 1, entries: [], groups: [], updatedAt: 0 })
  const settings = reactive<AppSettings>({ ...DEFAULT_SETTINGS })
  let inited = false
  const lastSelfWrite = { vault: 0, settings: 0 }
  let queue: Promise<void> = Promise.resolve()
  // 加密态（工厂闭包级：同进程多 store 实例各持各的 DEK，互不泄漏）
  let dek: Uint8Array | null = null
  const security = ref<SecuritySettings | null>(null)
  const locked = ref(false)
  const hasEncryption = computed(() => security.value !== null)

  function replaceVault(v: Vault): void {
    vault.version = v.version
    vault.updatedAt = v.updatedAt
    vault.entries.splice(0, vault.entries.length, ...v.entries)
    vault.groups.splice(0, vault.groups.length, ...v.groups)
  }

  function readRawVault(): Promise<unknown> {
    return adapter.get(VAULT_KEY).then((raw) => {
      if (raw === null) return null
      try {
        return JSON.parse(raw) as unknown
      } catch {
        throw new Error('vault corrupted')
      }
    })
  }

  async function readSecurity(): Promise<SecuritySettings | null> {
    const raw = await adapter.get(SECURITY_KEY)
    if (raw === null) return null
    try {
      return JSON.parse(raw) as SecuritySettings
    } catch {
      return null
    }
  }

  async function initStore(): Promise<void> {
    if (inited) return
    const [parsed, s, sec] = await Promise.all([readRawVault(), loadSettings(adapter), readSecurity()])
    Object.assign(settings, s)
    security.value = sec
    if (isEncryptedVault(parsed)) {
      if (dek) {
        // 同进程已有 DEK（如 unlock 后重建 store / 刷新场景）：直接解密填充
        replaceVault(JSON.parse(await decryptVaultWithDek(dek, parsed)) as Vault)
        locked.value = false
      } else {
        // 密文在手但无 DEK：锁定，vault 保持为空防内存残留读取
        locked.value = true
      }
    } else if (parsed) {
      replaceVault(parsed as Vault)
    } else {
      replaceVault(createVault())
    }
    inited = true
  }

  /** 串行入队原语：任务依次执行，单任务失败不传染后续任务（与原 commit 队列语义一致）。
   *  任务 resolve（成功）后触发 opts.onCommitted——覆盖全部经队列的写路径（含 enable/disable 加密等 op） */
  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const p = queue.then(async () => {
      const result = await task()
      opts.onCommitted?.()
      return result
    })
    queue = p.then(() => {}, () => {})
    return p
  }

  async function commit(fn: (v: Vault) => Vault): Promise<void> {
    return enqueue(async () => {
      // 锁定时拒绝写操作：在 fn 执行前抛出，本次 commit reject 但队列继续
      if (locked.value) throw new Error('vault locked')
      // 防加密降级：本端 security 缓存为空时核对盘上 security（远端已启用而本端陈旧→转锁定并拒绝本次明文写，
      // 避免明文覆盖密文造成降级与「security 在但 vault 明文」的不一致态）。代价：未加密用户每次写多一次 adapter.get
      if (!security.value) {
        const disk = await readSecurity()
        if (disk) {
          security.value = disk
          lock()
          throw new Error('vault locked')
        }
      }
      replaceVault(fn(vault))
      try {
        lastSelfWrite.vault = Date.now()
        await saveVaultToAdapter()
      } catch (e) {
        console.error('[store] saveVault failed:', e)
      }
    })
  }

  /** 落盘：已启用加密且持有 DEK → 写 EncryptedVault 密文；否则明文 Vault。
   *  加密分支写盘前对称核对盘上 security（与未加密分支的防降级核对对称）：
   *  - 读不到（远端已 disableEncryption）→ 丢弃本端加密态、保持解锁、改写明文，跟随远端；
   *    否则「security 缓存非 null 但盘上已删」时密文写回会造成 EncryptedVault 无 security 键的不可恢复死锁
   *  - 存在但与本端缓存不同（远端已换口令）→ 刷新缓存后照常加密写（DEK 是内容密钥不受换口令影响，
   *    wrappedDek 与本端 dek 无关）
   *  - 核对读瞬态失败 → 保守视为存在，照常加密写 */
  async function saveVaultToAdapter(): Promise<void> {
    if (security.value && dek) {
      let disk: SecuritySettings | null
      try {
        disk = await readSecurity()
      } catch {
        disk = security.value // 瞬态 IO 失败：保守视为存在
      }
      if (disk === null) {
        security.value = null
        dek = null
        locked.value = false
      } else {
        security.value = disk
      }
    }
    if (security.value && dek) {
      const encrypted = await encryptVaultWithDek(dek, JSON.stringify(vault))
      await adapter.set(VAULT_KEY, JSON.stringify(encrypted))
    } else {
      await saveVault(adapter, toRaw(vault) as Vault)
    }
  }

  async function commitSettings(): Promise<void> {
    queue = queue.then(async () => {
      try {
        lastSelfWrite.settings = Date.now()
        await saveSettings(adapter, toRaw(settings) as AppSettings)
      } catch (e) {
        console.error('[store] saveSettings failed:', e)
      }
      // 与 enqueue 的 onCommitted 语义对齐：commitSettings 未走 enqueue，需单独触发
      opts.onCommitted?.()
    })
    return queue
  }

  function registerStorageSync(): void {
    opts.registerSync?.((payload) => {
      if (payload.vault && Date.now() - lastSelfWrite.vault >= 500) {
        adapter.get(VAULT_KEY)
          .then(async (raw) => {
            if (raw === null) return
            const parsed: unknown = JSON.parse(raw)
            // 锁定窗口不消费任何远端 vault 内容（防锁定态下明文/密文混入内存）
            if (locked.value) return
            if (isEncryptedVault(parsed)) {
              if (!dek) {
                // 远端已启用加密而本端未持有 DEK：转锁定并从盘刷新 security 缓存，
                // 与远端状态对齐；否则本端后续明文写会降级覆盖密文
                lock()
                security.value = await readSecurity().catch(() => null)
                return
              }
              // 双端独立加密防线（浏览器同步）：本端 DEK 解不开远端密文 → 远端 rev 高者胜，
              // 采用远端状态：丢弃本端 DEK、转锁定、security 缓存刷新为盘上（远端）值，等待输入远端口令。
              // 不拦截则本端后续写 op 会以本端 DEK 加密 + 远端 security 落盘 → 无人可解的幽灵密文
              let remoteJson: string
              try {
                remoteJson = await decryptVaultWithDek(dek, parsed)
              } catch {
                lock()
                security.value = await readSecurity().catch(() => null)
                return
              }
              // 持有 DEK 才解密填充（changePassphrase 只重包裹、DEK 不变，旧 DEK 仍可解）
              replaceVault(JSON.parse(remoteJson) as Vault)
              return
            }
            replaceVault(parsed as Vault)
          })
          .catch(() => {})
      }
      if (payload.settings && Date.now() - lastSelfWrite.settings >= 500) {
        loadSettings(adapter).then((s) => Object.assign(settings, s)).catch(() => {})
      }
    })
  }

  /** 启用加密：以当前内存 vault 明文建 KEK/wrap DEK → 写 security + 密文 vault → 缓存 DEK。
   *  经 commit 队列执行：Argon2 派生耗时数百 ms，期间的并发写 op 必须排队，
   *  否则会以 enable 前的旧快照落盘覆盖新写（真实竞态） */
  function enableEncryption(password: string): Promise<void> {
    return enqueue(async () => {
      if (locked.value) throw new Error('vault locked')
      // 不用 toRaw：直接序列化响应式对象（P5 裁定，避免 raw target 与 reactive 视图不一致）
      const r = await setupVaultEncryption(JSON.stringify(vault), password)
      security.value = r.security
      dek = r.dek
      try {
        // 先写 security 后写密文：中途崩溃最多出现「security 在但 vault 仍明文」，数据不丢
        lastSelfWrite.vault = Date.now() // security 键写入复用 vault 自写窗口抑制（onChanged 无 security 通道）
        await adapter.set(SECURITY_KEY, JSON.stringify(r.security))
        lastSelfWrite.vault = Date.now()
        await adapter.set(VAULT_KEY, JSON.stringify(r.encrypted))
      } catch (e) {
        security.value = null
        dek = null
        throw e
      }
      locked.value = false
    })
  }

  /** 关闭加密：需已解锁 → 内存明文写回 vault → 删 security → 丢弃 DEK（经 commit 队列，与写 op 串行） */
  function disableEncryption(): Promise<void> {
    return enqueue(async () => {
      if (locked.value) throw new Error('vault locked')
      if (!security.value || !dek) throw new Error('encryption not enabled')
      lastSelfWrite.vault = Date.now()
      await saveVault(adapter, toRaw(vault) as Vault)
      await adapter.delete(SECURITY_KEY)
      security.value = null
      dek = null
      locked.value = false
    })
  }

  /** 更换口令：需已解锁 → 仅重包裹 DEK → 写 security（数据无需重加密；经 commit 队列，与写 op 串行） */
  function changePassphrase(newPassword: string): Promise<void> {
    return enqueue(async () => {
      if (locked.value) throw new Error('vault locked')
      if (!security.value || !dek) throw new Error('encryption not enabled')
      const next = await changeVaultPassphrase(security.value, dek, newPassword)
      security.value = next
      lastSelfWrite.vault = Date.now()
      await adapter.set(SECURITY_KEY, JSON.stringify(next))
    })
  }

  /** 解锁：口令解出 DEK → 读盘解密/明文填充 → 退出锁定；口令错时原样抛出供组件展示。
   *  盘上 vault 非密文（缺失或明文）时宽容接受：这是「security 在但 vault 明文」的
   *  enableEncryption 半失败不一致态，直接加载并恢复持有 DEK，后续写 op 经加密分支自愈回密文 */
  async function unlock(password: string): Promise<void> {
    if (!security.value) throw new Error('encryption not enabled')
    const key = await unlockVaultEncryption(security.value, password)
    const parsed = await readRawVault()
    if (isEncryptedVault(parsed)) {
      replaceVault(JSON.parse(await decryptVaultWithDek(key, parsed)) as Vault)
    } else {
      replaceVault(parsed !== null ? (parsed as Vault) : createVault())
    }
    dek = key
    locked.value = false
  }

  /** 锁定：丢弃 DEK、清空内存 vault（防内存残留读取） */
  function lock(): void {
    dek = null
    locked.value = true
    replaceVault(createVault())
  }

  return {
    vault, settings, initStore, registerStorageSync, commit, commitSettings,
    locked, hasEncryption, unlock, lock, enableEncryption, disableEncryption, changePassphrase,
    addEntryOp: (entry: OtpEntry) => commit((v) => addEntry(v, entry)),
    updateEntryOp: (uuid: string, patch: Partial<Omit<OtpEntry, 'uuid'>>) => commit((v) => updateEntry(v, uuid, patch)),
    removeEntryOp: (uuid: string) => commit((v) => removeEntry(v, uuid)),
    addGroupOp: (name: string) => commit((v) => addGroup(v, name)),
    renameGroupOp: (id: string, name: string) => commit((v) => renameGroup(v, id, name)),
    removeGroupOp: (id: string) => commit((v) => removeGroup(v, id)),
    reorderOp: (uuids: string[]) => commit((v) => reorderEntries(v, uuids)),
    // 整体替换（恢复备份/导入）：replaceVault 用 splice 逐项拷入，保证响应式与深拷贝语义
    replaceAllOp: (v: Vault) => commit(() => v),
  }
}

export type VueStore = ReturnType<typeof createVueStore>
