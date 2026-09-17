import {
  DEFAULT_SETTINGS, SECRET_BAG_KEY, SECURITY_KEY, VAULT_KEY, addEntry, addGroup, addPrfSource, base64ToBytes, bytesToBase64,
  changeVaultPassphrase, createVault, decryptVaultWithDek, emptyBag, encryptVaultWithDek, isEncryptedVault, kekSourcesOf,
  loadSettings, openSecretBag, removeEntry, removeGroup, removeKekSource, renameGroup, reorderEntries, saveSettings, saveVault,
  sealSecretBag, setupVaultEncryption, unlockVaultEncryption, updateEntry, withDpapiSource,
  type AppSettings, type CloudCred, type KekSource, type KdfProfile, type OtpEntry, type SecretBagContent,
  type SecuritySettings, type StorageAdapter, type Vault,
} from '@totp/core'
import { computed, reactive, ref, toRaw } from 'vue'

export function createVueStore(
  adapter: StorageAdapter,
  opts: {
    registerSync?: (cb: (payload: { vault?: boolean; settings?: boolean }) => void) => void
    /** 队列内写操作（commit/commitSettings/enable/disable/changePassphrase 等 op）成功后的统一回调：
     *  extension 场景用于触发浏览器同步推送调度，保证所有写路径无遗漏（desktop 不传则零行为） */
    onCommitted?: () => void
    /** 自写抑制窗口（毫秒）：本端写盘后该时长内的 storage 通知视为自身回声不重读，默认 500。
     *  测试注入 0（远端通知立即生效，消除真实时间依赖）或大值（确定性验证抑制行为） */
    selfWriteSuppressMs?: number
    /** 窗口标识：spec §7 末尾要求窗口独立解锁——DEK/locked 按 windowId 索引；
     *  popup/options/desktop mini 必须传不同 id，否则会跨窗口泄漏 DEK */
    windowId?: string
    /** DEK 持久化（设计 §1 锁定策略·重启即锁）：宿主提供会话级存取（extension=chrome.storage.session base64）；
     *  缺省=不持久化（desktop 内存级，重启天然锁定）。lock() 必清；解锁/自动恢复必写。 */
    dekPersist?: { get(): Promise<string | null>; set(dek: Uint8Array): Promise<void>; clear(): Promise<void> }
  } = {},
) {
  const suppressMs = opts.selfWriteSuppressMs ?? 500
  const windowId = opts.windowId ?? 'main'
  const vault = reactive<Vault>({ version: 1, entries: [], groups: [], updatedAt: 0 })
  const settings = reactive<AppSettings>({ ...DEFAULT_SETTINGS })
  let inited = false
  const lastSelfWrite = { vault: 0, settings: 0 }
  let queue: Promise<void> = Promise.resolve()
  // 加密态按 windowId 隔离：spec §7 末尾「窗口独立解锁」——一个窗口 unlock 不应让另一个窗口同时解锁
  // security 是数据（盘上唯一真相），所有窗口共享；dek/locked 是解锁态，按 windowId 索引
  const dekByWin = new Map<string, Uint8Array | null>()
  const lockedByWin = new Map<string, boolean>()
  const lockedByWinRef = new Map<string, ReturnType<typeof ref<boolean>>>()
  // 会话备份口令（设计 D1）：与 dek 同级、同生命周期——按 windowId 隔离，lock 清空、解锁自动装载
  const backupSecretByWin = new Map<string, string | null>()
  const backupSecretRefByWin = new Map<string, ReturnType<typeof ref<string | null>>>()
  // DEK 保管区（设计 §1）当前明文缓存：备份口令 + 各源云凭据，仅解锁态有效；lock 清空
  let bag: SecretBagContent = emptyBag()
  /** bag.creds 的响应式只读镜像（组件渲染源列表凭据态用；写走 saveSourceCredOp/removeSourceCredOp） */
  const credsCache = ref<Record<string, CloudCred>>({})
  /** 保管区是否存有备份口令（bag.backupPassword 非空）：bag 本身非响应式，用镜像 ref 驱动视图 */
  const bagStoredRef = ref(false)
  // 初始 unlocked（与原 ref(false) 语义对齐）：明文 vault/未启用加密场景下默认解锁；
  // 加密态在 initStore 阶段根据 vault 密文判定 locked=true
  dekByWin.set(windowId, null)
  lockedByWin.set(windowId, false)
  lockedByWinRef.set(windowId, ref(false))
  backupSecretByWin.set(windowId, null)
  backupSecretRefByWin.set(windowId, ref<string | null>(null))
  function currentLockedRef() {
    let r = lockedByWinRef.get(windowId)
    if (!r) {
      r = ref(lockedByWin.get(windowId) ?? true)
      lockedByWinRef.set(windowId, r)
    }
    return r
  }
  function currentBackupSecretRef() {
    let r = backupSecretRefByWin.get(windowId)
    if (!r) {
      r = ref(backupSecretByWin.get(windowId) ?? null)
      backupSecretRefByWin.set(windowId, r)
    }
    return r
  }
  const security = ref<SecuritySettings | null>(null)
  const locked = computed(() => currentLockedRef().value)
  const hasEncryption = computed(() => security.value !== null)
  /** 会话备份口令只读视图（存取走 setBackupSecret/forgetBackupSecret） */
  const backupSecret = computed(() => currentBackupSecretRef().value)
  /** 保管区已存备份口令只读视图（bag.backupPassword 非空即 true；lock/forget/关加密清空）——组件三态判定用 */
  const bagStored = computed(() => bagStoredRef.value)

  function replaceVault(v: Vault): void {
    vault.version = v.version
    vault.updatedAt = v.updatedAt
    vault.entries.splice(0, vault.entries.length, ...v.entries)
    vault.groups.splice(0, vault.groups.length, ...v.groups)
    // backupSecret 字段已随 T2 从 Vault 模型删除（保管区接管）：源 JSON 里的遗留字段在此自然丢弃
  }

  /** 置/清会话备份口令（Map + ref 双写，两条解锁/锁定路径共用的唯一入口） */
  function setSessionBackupSecret(secret: string | null): void {
    backupSecretByWin.set(windowId, secret)
    currentBackupSecretRef().value = secret
  }

  /** 解锁后从保管区装载（设计 §1）：口令入会话、凭据入缓存。
   *  DEK 不匹配/密文损坏时按空保管区回落（不阻断解锁），与新库首启（盘上尚无 secretBag 键）同语义 */
  async function loadBagIntoSession(): Promise<void> {
    bag = await openSecretBag(dekByWin.get(windowId)!, await adapter.get(SECRET_BAG_KEY)).catch(() => emptyBag())
    setSessionBackupSecret(bag.backupPassword || null)
    credsCache.value = { ...bag.creds }
    bagStoredRef.value = bag.backupPassword !== ''
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
      if (dekByWin.get(windowId)) {
        // 同进程本窗口已持有 DEK（如 unlock 后重建 store / 刷新场景）：直接解密填充
        const loaded = JSON.parse(await decryptVaultWithDek(dekByWin.get(windowId)!, parsed)) as Vault
        replaceVault(loaded)
        await loadBagIntoSession() // 解锁恢复同步装载保管区（口令+凭据）
        lockedByWin.set(windowId, false)
        currentLockedRef().value = false
      } else {
        // 会话内 DEK 持久化自动恢复（设计 §1 重启即锁的附带收益）：宿主会话存储仍有 DEK
        // （如 extension chrome.storage.session 在 options/popup 间共享解锁态），直接进解锁态
        const persisted = opts.dekPersist ? await opts.dekPersist.get().catch(() => null) : null
        if (persisted) {
          try {
            await applyDekAndUnlock(base64ToBytes(persisted))
          } catch {
            lock() // 持久化 DEK 失效（换库/损坏）：lock 清持久化残留，保持锁定等口令输入
          }
        } else {
          // 密文在手但本窗口无 DEK：本窗口锁定，vault 保持为空防内存残留读取
          lockedByWin.set(windowId, true)
          currentLockedRef().value = true
        }
      }
    } else if (parsed) {
      replaceVault(parsed as Vault)
      lockedByWin.set(windowId, false)
      currentLockedRef().value = false
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
      if (lockedByWin.get(windowId)) throw new Error('vault locked')
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

  /** 落盘：已启用加密且持有本窗口 DEK → 写 EncryptedVault 密文；否则明文 Vault。
   *  加密分支写盘前对称核对盘上 security（与未加密分支的防降级核对对称）：
   *  - 读不到（远端已 disableEncryption）→ 本窗口丢弃加密态、保持解锁、改写明文，跟随远端；
   *    否则「security 缓存非 null 但盘上已删」时密文写回会造成 EncryptedVault 无 security 键的不可恢复死锁
   *  - 存在但与本端缓存不同（远端已换口令）→ 刷新缓存后照常加密写（DEK 是内容密钥不受换口令影响，
   *    wrappedDek 与本端 dek 无关）
   *  - 核对读瞬态失败 → 保守视为存在，照常加密写 */
  async function saveVaultToAdapter(): Promise<void> {
    if (security.value && dekByWin.get(windowId)) {
      let disk: SecuritySettings | null
      try {
        disk = await readSecurity()
      } catch {
        disk = security.value // 瞬态 IO 失败：保守视为存在
      }
      if (disk === null) {
        security.value = null
        dekByWin.set(windowId, null)
        lockedByWin.set(windowId, false)
        currentLockedRef().value = false
      } else {
        security.value = disk
      }
    }
    if (security.value && dekByWin.get(windowId)) {
      const encrypted = await encryptVaultWithDek(dekByWin.get(windowId)!, JSON.stringify(vault))
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
      if (payload.vault && Date.now() - lastSelfWrite.vault >= suppressMs) {
        adapter.get(VAULT_KEY)
          .then(async (raw) => {
            if (raw === null) return
            const parsed: unknown = JSON.parse(raw)
            // 本窗口锁定不消费任何远端 vault 内容（防本窗口锁定态下明文/密文混入内存）
            if (lockedByWin.get(windowId)) return
            if (isEncryptedVault(parsed)) {
              if (!dekByWin.get(windowId)) {
                // 远端已启用加密而本窗口未持有 DEK：本窗口转锁定并从盘刷新 security 缓存，
                // 与远端状态对齐；否则本窗口后续明文写会降级覆盖密文
                lock()
                security.value = await readSecurity().catch(() => null)
                return
              }
              // 双端独立加密防线（浏览器同步）：本窗口 DEK 解不开远端密文 → 远端 rev 高者胜，
              // 采用远端状态：丢弃本窗口 DEK、转锁定、security 缓存刷新为盘上（远端）值，等待输入远端口令。
              // 不拦截则本窗口后续写 op 会以本端 DEK 加密 + 远端 security 落盘 → 无人可解的幽灵密文
              let remoteJson: string
              try {
                remoteJson = await decryptVaultWithDek(dekByWin.get(windowId)!, parsed)
              } catch {
                lock()
                security.value = await readSecurity().catch(() => null)
                return
              }
              // 持有 DEK 才解密填充（远端未轮换时旧 DEK 仍可解；默认轮换后旧 DEK 解不开 → 上方 catch 转锁定）
              replaceVault(JSON.parse(remoteJson) as Vault)
              // 远端覆盖后必须强制锁定：注释承诺了「丢弃本端 DEK、转锁定」但未执行，
              // 否则下次 commit 会以本端 DEK 加密 + 远端 security 落盘（仍属幽灵密文）。
              // security 缓存同步重读为盘上值，与下次 unlock 的口令入口对齐
              lock()
              security.value = await readSecurity().catch(() => null)
              return
            }
            replaceVault(parsed as Vault)
          })
          .catch(() => {})
      }
      if (payload.settings && Date.now() - lastSelfWrite.settings >= suppressMs) {
        loadSettings(adapter).then((s) => Object.assign(settings, s)).catch(() => {})
      }
    })
  }

  /** 启用加密：以当前内存 vault 明文建 KEK/wrap DEK → 写 security + 密文 vault → 本窗口缓存 DEK。
   *  经 commit 队列执行：Argon2 派生耗时数百 ms，期间的并发写 op 必须排队，
   *  否则会以 enable 前的旧快照落盘覆盖新写（真实竞态） */
  function enableEncryption(password: string): Promise<void> {
    return enqueue(async () => {
      if (lockedByWin.get(windowId)) throw new Error('vault locked')
      // 不用 toRaw：直接序列化响应式对象（P5 裁定，避免 raw target 与 reactive 视图不一致）
      const r = await setupVaultEncryption(JSON.stringify(vault), password)
      security.value = r.security
      dekByWin.set(windowId, r.dek)
      try {
        // 先写 security 后写密文：中途崩溃最多出现「security 在但 vault 仍明文」，数据不丢
        lastSelfWrite.vault = Date.now() // security 键写入复用 vault 自写窗口抑制（onChanged 无 security 通道）
        await adapter.set(SECURITY_KEY, JSON.stringify(r.security))
        lastSelfWrite.vault = Date.now()
        await adapter.set(VAULT_KEY, JSON.stringify(r.encrypted))
      } catch (e) {
        security.value = null
        dekByWin.set(windowId, null)
        throw e
      }
      lockedByWin.set(windowId, false)
      currentLockedRef().value = false
      // DEK 持久化不变量「解锁必写」：enable 同样产出解锁态，宿主会话存储同步持有 DEK
      void opts.dekPersist?.set(r.dek)
    })
  }

  /** 关闭加密：需已解锁 → 内存明文写回 vault → 删 security 与保管区键 → 本窗口丢弃 DEK（经 commit 队列，与写 op 串行） */
  function disableEncryption(): Promise<void> {
    return enqueue(async () => {
      if (lockedByWin.get(windowId)) throw new Error('vault locked')
      if (!security.value || !dekByWin.get(windowId)) throw new Error('encryption not enabled')
      // 保管区随加密一起退役（设计 §1：明文库无 DEK 可解）：删设备侧键 + 清缓存；会话口令同清（D1 语义反转后口令只存保管区）
      await adapter.delete(SECRET_BAG_KEY)
      bag = emptyBag()
      credsCache.value = {}
      bagStoredRef.value = false
      setSessionBackupSecret(null)
      lastSelfWrite.vault = Date.now()
      await saveVault(adapter, toRaw(vault) as Vault)
      await adapter.delete(SECURITY_KEY)
      security.value = null
      dekByWin.set(windowId, null)
      lockedByWin.set(windowId, false)
      currentLockedRef().value = false
    })
  }

  /** 更换口令（需已解锁）：默认 rotateDek=true（设计 §2 裁定改口令即被动轮换）——重生成 DEK、全库重加密写盘、
   *  保管区重封、kekSources 重置为 password 源（prf/dpapi 死凭证数据层丢弃，宿主 UI 引导重绑）；
   *  rotateDek=false 仅重包裹（DEK 不变，多绑来源保留）。经 commit 队列，与写 op 串行 */
  function changePassphrase(newPassword: string, changeOpts: { rotateDek?: boolean; profile?: KdfProfile } = {}): Promise<void> {
    return enqueue(async () => {
      if (lockedByWin.get(windowId)) throw new Error('vault locked')
      if (!security.value || !dekByWin.get(windowId)) throw new Error('encryption not enabled')
      const r = await changeVaultPassphrase(security.value, dekByWin.get(windowId)!, newPassword, { rotateDek: true, ...changeOpts })
      security.value = r.security
      if (r.dek) {
        dekByWin.set(windowId, r.dek)
        // 被动轮换（设计 §2）：DEK 已换 → 全库重加密写盘 + 保管区重封；security 最后落盘作提交点
        lastSelfWrite.vault = Date.now()
        await adapter.set(VAULT_KEY, JSON.stringify(await encryptVaultWithDek(r.dek, JSON.stringify(vault))))
        await adapter.set(SECRET_BAG_KEY, await sealSecretBag(r.dek, bag))
        void opts.dekPersist?.set(r.dek)
      }
      lastSelfWrite.vault = Date.now()
      await adapter.set(SECURITY_KEY, JSON.stringify(r.security))
    })
  }

  /** 解锁：口令解出 DEK → 本窗口读盘解密/明文填充 → 退出锁定；口令错时原样抛出供组件展示。
   *  盘上 vault 非密文（缺失或明文）时宽容接受：这是「security 在但 vault 明文」的
   *  enableEncryption 半失败不一致态，直接加载并恢复持有 DEK，后续写 op 经加密分支自愈回密文 */
  async function unlock(password: string): Promise<void> {
    if (!security.value) throw new Error('encryption not enabled')
    await applyDekAndUnlock(await unlockVaultEncryption(security.value, password))
  }

  /** unlock(password) 共享的后置逻辑：本窗口读盘解密/明文填充 → 本窗口持有 DEK → 退出锁定 */
  async function applyDekAndUnlock(key: Uint8Array): Promise<void> {
    const parsed = await readRawVault()
    let loaded: Vault
    if (isEncryptedVault(parsed)) {
      loaded = JSON.parse(await decryptVaultWithDek(key, parsed)) as Vault
    } else {
      loaded = parsed !== null ? (parsed as Vault) : createVault()
    }
    replaceVault(loaded)
    dekByWin.set(windowId, key)
    // 解锁自动装载保管区（password 与 unlockWithDek/PRF 两条路径均汇于此）
    await loadBagIntoSession()
    lockedByWin.set(windowId, false)
    currentLockedRef().value = false
    // DEK 持久化（设计 §1 重启即锁）：解锁成功即写宿主会话存储（extension=chrome.storage.session base64）
    void opts.dekPersist?.set(key)
  }

  /** passkey 解锁第二跳：外部经 core unlockWithPrf 解出 DEK 后注入。
   *  security 缓存缺失（跨窗口陈旧/未 initStore）时从盘补读，保证后续加密写路径可用 */
  async function unlockWithDek(key: Uint8Array): Promise<void> {
    if (!security.value) security.value = await readSecurity()
    if (!security.value) throw new Error('encryption not enabled')
    // C1：调用方应保证 DEK 长度 32B；core unlockWithPrf 已加校验，此处再校验一次防 caller 跳过 core 直接注入
    if (key.length !== 32) throw new Error('invalid DEK length from PRF unwrap')
    await applyDekAndUnlock(key)
  }

  /** 绑定 passkey 解锁（已解锁态）：salt 由调用方生成并在创建凭据时用于 PRF 求值，
   *  prfOutput 为该盐的权威求值输出——同盐可复现，构成绑定语义。
   *  core addPrfSource 重包裹 DEK（同 credentialId 替换语义）→ security 经队列写盘 */
  function addPrfSourceOp(credentialId: string, prfOutput: Uint8Array, salt: Uint8Array): Promise<void> {
    return enqueue(async () => {
      if (lockedByWin.get(windowId)) throw new Error('vault locked')
      if (!security.value || !dekByWin.get(windowId)) throw new Error('encryption not enabled')
      const next = await addPrfSource(security.value, dekByWin.get(windowId)!, credentialId, prfOutput, bytesToBase64(salt))
      security.value = next
      // security 键写入复用 vault 自写窗口抑制（onChanged 无 security 通道，与 changePassphrase 一致）
      lastSelfWrite.vault = Date.now()
      await adapter.set(SECURITY_KEY, JSON.stringify(next))
    })
  }

  /** 移除指定 passkey 解锁来源（core 守卫：移除后无任何来源时抛「至少保留一种解锁方式」） */
  function removePrfSourceOp(credentialId: string): Promise<void> {
    return enqueue(async () => {
      if (lockedByWin.get(windowId)) throw new Error('vault locked')
      if (!security.value) throw new Error('encryption not enabled')
      const next = removeKekSource(security.value, 'prf', { credentialId })
      security.value = next
      lastSelfWrite.vault = Date.now()
      await adapter.set(SECURITY_KEY, JSON.stringify(next))
    })
  }

  /** 绑定 DPAPI 解锁来源（已解锁态）：wrappedDekD 为宿主 DPAPI 包装的 DEK（base64；T1 裁定直接包裹 DEK 本体） */
  function addDpapiSourceOp(wrappedDekD: string): Promise<void> {
    return enqueue(async () => {
      if (lockedByWin.get(windowId)) throw new Error('vault locked')
      if (!security.value || !dekByWin.get(windowId)) throw new Error('encryption not enabled')
      const next = withDpapiSource(security.value, wrappedDekD)
      security.value = next
      // security 键写入复用 vault 自写窗口抑制（onChanged 无 security 通道，与 changePassphrase 一致）
      lastSelfWrite.vault = Date.now()
      await adapter.set(SECURITY_KEY, JSON.stringify(next))
    })
  }

  /** 移除 DPAPI 解锁来源（core 守卫：移除后无任何来源时抛「至少保留一种解锁方式」） */
  function removeDpapiSourceOp(): Promise<void> {
    return enqueue(async () => {
      if (lockedByWin.get(windowId)) throw new Error('vault locked')
      if (!security.value) throw new Error('encryption not enabled')
      const next = removeKekSource(security.value, 'dpapi')
      security.value = next
      lastSelfWrite.vault = Date.now()
      await adapter.set(SECURITY_KEY, JSON.stringify(next))
    })
  }

  /** 当前解锁态持有的 DEK（DPAPI 启用包装用；锁定/未启用返回 null） */
  function getCurrentDek(): Uint8Array | null {
    return dekByWin.get(windowId) ?? null
  }

  /** 设置备份口令（设计 §1）：trim 后先置会话（无论 remember）；
   *  remember=true（存入保管区）守护：未启用加密/锁定均给中文错误且不写盘（会话已置）；
   *  通过则写入保管区并随 DEK 密文落设备侧独立键（不再写 vault） */
  async function setBackupSecret(secret: string, remember: boolean): Promise<void> {
    const trimmed = secret.trim()
    if (!trimmed) throw new Error('备份口令不能为空')
    setSessionBackupSecret(trimmed)
    if (remember) {
      if (!security.value) throw new Error('需先启用加密才能记住备份口令')
      if (lockedByWin.get(windowId)) throw new Error('解锁后才能记住备份口令')
      bag.backupPassword = trimmed
      await adapter.set(SECRET_BAG_KEY, await sealSecretBag(dekByWin.get(windowId)!, bag))
      bagStoredRef.value = true
    }
  }

  /** 清除备份口令：会话必清；解锁+加密态时同步清保管区口令字段并重封写盘（凭据保留）；
   *  未启用/锁定态保管区密文本就不可用，只清会话不报错 */
  async function forgetBackupSecret(): Promise<void> {
    setSessionBackupSecret(null)
    if (security.value && !lockedByWin.get(windowId)) {
      bag.backupPassword = ''
      await adapter.set(SECRET_BAG_KEY, await sealSecretBag(dekByWin.get(windowId)!, bag))
      bagStoredRef.value = false
    }
  }

  /** 保存/更新指定源的云凭据入保管区（设计 §1：凭据是秘密，随 DEK 密文存放）。解锁+加密守护 */
  function saveSourceCredOp(id: string, cred: CloudCred): Promise<void> {
    return enqueue(async () => {
      if (lockedByWin.get(windowId)) throw new Error('vault locked')
      if (!security.value || !dekByWin.get(windowId)) throw new Error('需先启用加密才能保存云凭据')
      bag.creds[id] = cred
      await adapter.set(SECRET_BAG_KEY, await sealSecretBag(dekByWin.get(windowId)!, bag))
      credsCache.value = { ...bag.creds }
    })
  }

  /** 移除指定源的云凭据（保管区重封写盘；源元数据在 settings，不由本 op 处理）。解锁+加密守护 */
  function removeSourceCredOp(id: string): Promise<void> {
    return enqueue(async () => {
      if (lockedByWin.get(windowId)) throw new Error('vault locked')
      if (!security.value || !dekByWin.get(windowId)) throw new Error('需先启用加密才能保存云凭据')
      delete bag.creds[id]
      await adapter.set(SECRET_BAG_KEY, await sealSecretBag(dekByWin.get(windowId)!, bag))
      credsCache.value = { ...bag.creds }
    })
  }

  /** 遗留迁移（设计 §1）：旧 vault 密文内的 backupSecret → 写入保管区（先写新），随后剥除字段重写密文（后删旧）。
   *  幂等：盘上已无字段（或 bag 已有口令）时不重复搬运；bag 已有口令时仅剥除。
   *  遗留口令从盘上密文读（replaceVault 已不拷该字段，内存 vault 无残留）。解锁态调用（applyDekAndUnlock 后宿主调一次） */
  async function migrateLegacySecrets(): Promise<void> {
    if (!security.value || lockedByWin.get(windowId)) return
    const parsed = await readRawVault()
    let legacy: unknown
    if (isEncryptedVault(parsed)) {
      legacy = (JSON.parse(await decryptVaultWithDek(dekByWin.get(windowId)!, parsed)) as Record<string, unknown>).backupSecret
    } else if (parsed !== null) {
      // 「security 在但 vault 明文」半失败态的自愈路径同样剥除
      legacy = (parsed as Record<string, unknown>).backupSecret
    }
    if (typeof legacy === 'string' && legacy && !bag.backupPassword) {
      bag.backupPassword = legacy
      await adapter.set(SECRET_BAG_KEY, await sealSecretBag(dekByWin.get(windowId)!, bag))
      setSessionBackupSecret(legacy)
      bagStoredRef.value = true
    }
    if (legacy !== undefined) {
      // 剥除落盘：浅拷贝删字段（内存 vault 本就无此字段，实质是重写盘上密文冲掉残留）
      await commit((v) => {
        const n = { ...v } as Vault & { backupSecret?: string }
        delete n.backupSecret
        return n
      })
    }
  }

  /** 锁定：本窗口丢弃 DEK、清空内存 vault（防内存残留读取）；保管区缓存/持久化 DEK 同步清空
   *  注意：security.value 不在此清空 — 锁定态下 LockScreen 仍需枚举 kekSources 渲染
   *  解锁按钮（passkey/DPAPI 静默解锁），security 本身不包含敏感运行时数据。 */
  function lock(): void {
    dekByWin.set(windowId, null)
    lockedByWin.set(windowId, true)
    currentLockedRef().value = true
    setSessionBackupSecret(null) // 会话口令与 DEK 同生命周期：锁定即清
    bag = emptyBag() // 保管区缓存与 DEK 同生命周期：锁定即清（密文仍留盘，解锁后重装载）
    credsCache.value = {}
    bagStoredRef.value = false
    void opts.dekPersist?.clear() // 持久化 DEK 必清（设计 §1：锁=丢弃 DEK，含宿主会话存储）
    replaceVault(createVault())
  }

  /** 已绑定的 passkey(PRF) 解锁来源视图（LockScreen 渲染按钮 / SecurityCard 列表用） */
  const prfSources = computed(() => {
    const s = security.value
    if (!s) return []
    return kekSourcesOf(s)
      .filter((src): src is Extract<KekSource, { kind: 'prf' }> => src.kind === 'prf')
      .map((src) => ({ credentialId: src.credentialId, salt: src.salt }))
  })

  /** 已绑定的 DPAPI 解锁来源视图（至多一个；锁定态仍可见——LockScreen 静默解锁判定用） */
  const dpapiSource = computed(() => {
    const s = security.value
    if (!s) return null
    const src = kekSourcesOf(s).find((x): x is Extract<KekSource, { kind: 'dpapi' }> => x.kind === 'dpapi')
    return src ? { wrappedDekD: src.wrappedDekD } : null
  })

  // M5：boolean 视图（命名澄清"是否绑定 DPAPI 来源"）— 取代旧 computed.value === null 的易误读比较。
  // 旧 dpapiSource 仍保留以兼容 SecurityCard/App.vue，调用方迁移后可下线。
  const hasDpapiSource = computed(() => dpapiSource.value !== null)

  return {
    vault, settings, initStore, registerStorageSync, commit, commitSettings,
    locked, hasEncryption, unlock, lock, enableEncryption, disableEncryption, changePassphrase,
    /** security settings 只读缓存（锁定态非 null；宿主/组件读 kekSources 判定解锁方式） */
    securitySettings: security,
    /** 已绑定 prf 来源（credentialId+salt） */
    prfSources,
    /** 已绑定 dpapi 来源（wrappedDekD） */
    dpapiSource,
    /** 是否已绑定 DPAPI 来源（boolean 视图，M5 提供以替代 dpapiSource.value !== null 比较） */
    hasDpapiSource,
    /** 会话备份口令只读视图（随保管区密文落盘；锁定清空、解锁自动装载） */
    backupSecret,
    /** 保管区是否已存备份口令（bag.backupPassword 非空；与 backupSecret 组合出三态：未设置/会话内已启用/已存入保管区） */
    bagStored,
    /** 保管区凭据只读镜像（sourceId → CloudCred；锁定清空，解锁自动装载；写走 saveSourceCredOp/removeSourceCredOp） */
    credsCache,
    setBackupSecret, forgetBackupSecret,
    /** 保存/移除源云凭据入保管区（解锁+加密守护，密封写盘） */
    saveSourceCredOp, removeSourceCredOp,
    /** 遗留迁移：旧 vault.backupSecret → 保管区并从密文剥除（幂等；解锁态宿主调一次） */
    migrateLegacySecrets,
    /** 当前解锁态持有的 DEK（DPAPI 启用包装用；锁定/未启用为 null） */
    getCurrentDek,
    unlockWithDek, addPrfSourceOp, removePrfSourceOp, addDpapiSourceOp, removeDpapiSourceOp,
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