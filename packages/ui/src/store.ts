import {
  DEFAULT_SETTINGS, SECRET_BAG_KEY, SECURITY_KEY, SECURITY_PENDING_KEY, VAULT_KEY, VAULT_REV_WATERMARK_KEY, VaultRollbackError, addEntry, addPrfSource,
  addTag, base64ToBytes, bytesToBase64, changeVaultPassphrase, createVault, decryptVaultWithDek, decryptVaultWithDekDetailed,
  dekFingerprint, emptyBag, encryptVaultWithDek, isEncryptedVault, isSecuritySettings, kekSourcesOf, loadMergeConflicts, loadSettings, openSecretBag, removeEntry,
  removeKekSource, removeTag, renameTag, reorderEntries, saveMergeConflicts, saveSettings, saveVault, sealSecretBag, setupVaultEncryption,
  unlockVaultEncryption, updateEntry, validateVaultObject, withDpapiSource, MERGE_CONFLICTS_MAX,
  type AppSettings, type CloudCred, type EncryptedVault, type EntryConflict, type KekSource, type KdfProfile, type OtpEntry, type Seal, type SecretBagContent,
  type SecuritySettings, type StorageAdapter, type Vault, type VaultRevWatermark,
} from '@totp/core'
import { computed, reactive, ref, toRaw, type Ref } from 'vue'

export function createVueStore(
  adapter: StorageAdapter,
  opts: {
    registerSync?: (cb: (payload: { vault?: boolean; settings?: boolean; secretBag?: boolean }) => void) => void
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
  const vault = reactive<Vault>({ version: 2, entries: [], tags: [], updatedAt: 0 })
  const settings = reactive<AppSettings>({ ...DEFAULT_SETTINGS })
  let inited = false
  const lastSelfWrite = { vault: 0, settings: 0, bag: 0 }
  let queue: Promise<void> = Promise.resolve()
  // 锁定代数（F1+F7）：lock() 同步执行、不入写队列（清 DEK/内存 vault），可能与在途 commit
  // 及加密/解锁续延交叉。commit 与各长耗时流程在入口捕获代数，关键 await 后经
  // ensureNotLockedSince / 内联复查——代数已变即锁定发生在途：在途写盘中止（否则 DEK 已清的续延
  // 会把被清空的空库明文覆盖写到盘上密文位置）；进行中的续延中止（否则会把 DEK 重挂回内存/
  // 宿主会话存储并翻回解锁态，锁定被窗口击穿）
  let lockGeneration = 0
  // 加密态按 windowId 隔离：spec §7 末尾「窗口独立解锁」——一个窗口 unlock 不应让另一个窗口同时解锁
  // security 是数据（盘上唯一真相），所有窗口共享；dek/locked 是解锁态，按 windowId 索引
  const dekByWin = new Map<string, Uint8Array | null>()
  const lockedByWin = new Map<string, boolean>()
  // 显式标注 Ref<boolean>：不可写 ReturnType<typeof ref<boolean>>——ref 的无参重载使该类型
  // 解析为 Ref<boolean | undefined>，污染 locked/backupSecret 联合（宿主 SecurityPlatform 等接口
  // 要求非 undefined，vue-tsc 接入后连爆 6 处）
  const lockedByWinRef = new Map<string, Ref<boolean>>()
  // 会话备份口令（设计 D1）：与 dek 同级、同生命周期——按 windowId 隔离，lock 清空、解锁自动装载
  const backupSecretByWin = new Map<string, string | null>()
  const backupSecretRefByWin = new Map<string, Ref<string | null>>()
  // DEK 保管区（设计 §1）当前明文缓存：备份口令 + 各源云凭据，仅解锁态有效；lock 清空
  let bag: SecretBagContent = emptyBag()
  /** bag.creds 的响应式只读镜像（组件渲染源列表凭据态用；写走 saveSourceCredOp/removeSourceCredOp） */
  const credsCache = ref<Record<string, CloudCred>>({})
  /** 保管区是否存有备份口令（bag.backupPassword 非空）：bag 本身非响应式，用镜像 ref 驱动视图 */
  const bagStoredRef = ref(false)
  /** 条目级合并冲突记录（spec §3/§4）：runner 同步产出经宿主 addMergeConflictsOp 入库，裁决走
   *  resolveMergeConflictOp；含整条目秘密，随 DEK seal 落盘、锁定清空、解锁重装载（同保管区生命周期） */
  const mergeConflicts = ref<EntryConflict[]>([])
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
  /** F7 不变量复查：传入流程入口捕获的 lockGeneration，当前代数已前进（期间 lock() 已发生）即抛错，
   *  令加密/解锁续延在前进任何内存/盘上状态前中止；调用方（SecurityCard/LockScreen 的 catch）原样展示 */
  function ensureNotLockedSince(gen: number): void {
    if (lockGeneration !== gen) throw new Error('vault locked during operation')
  }
  const security = ref<SecuritySettings | null>(null)
  const locked = computed(() => currentLockedRef().value)
  const hasEncryption = computed(() => security.value !== null)
  /** 会话备份口令只读视图（存取走 setBackupSecret/forgetBackupSecret） */
  const backupSecret = computed(() => currentBackupSecretRef().value)
  /** 保管区已存备份口令只读视图（bag.backupPassword 非空即 true；lock/forget/关加密清空）——组件三态判定用 */
  const bagStored = computed(() => bagStoredRef.value)
  /** 未裁决合并冲突计数（冲突 badge/横幅源；0=全部裁决或无冲突，提示随之清除） */
  const conflictCount = computed(() => mergeConflicts.value.length)

  function replaceVault(v: Vault): void {
    // F6：唯一采用收口——所有采纳点（initStore/解锁/同步回调/恢复/commit op 结果）经此校验，
    // 结构非法整记录拒绝（fail-closed），杜绝畸形结构入库。锁定清空路径（createVault）恒合法。
    validateVaultObject(v)
    vault.version = v.version
    vault.updatedAt = v.updatedAt
    // F8：rev 随内容前进（恢复旧备份换入低/无 rev 时由 saveVaultToAdapter 的「越水位推进」兜底，不会误拒）
    vault.rev = v.rev
    vault.entries.splice(0, vault.entries.length, ...v.entries)
    vault.tags.splice(0, vault.tags.length, ...v.tags)
    // backupSecret 字段已随 T2 从 Vault 模型删除（保管区接管）：源 JSON 里的遗留字段在此自然丢弃
  }

  /** 置/清会话备份口令（Map + ref 双写，两条解锁/锁定路径共用的唯一入口） */
  function setSessionBackupSecret(secret: string | null): void {
    backupSecretByWin.set(windowId, secret)
    currentBackupSecretRef().value = secret
  }

  /** 从盘上装载保管区明文（设计 §1）：DEK 不匹配/密文损坏/IO 失败一律按空保管区回落（不阻断解锁），
   *  与新库首启（盘上尚无 secretBag 键）同语义 */
  async function loadBagFromDisk(dek: Uint8Array): Promise<SecretBagContent> {
    try {
      return await openSecretBag(dek, await adapter.get(SECRET_BAG_KEY))
    } catch {
      return emptyBag()
    }
  }

  /** 保管区明文前进到内存态（bag 缓存 + 会话口令 + 凭据镜像 + bagStored 视图） */
  function advanceBag(next: SecretBagContent): void {
    bag = next
    setSessionBackupSecret(bag.backupPassword || null)
    credsCache.value = { ...bag.creds }
    bagStoredRef.value = bag.backupPassword !== ''
  }

  /** 保管区密封写盘统一出口（审查 I7）：记录自写窗口——本端写盘触发的 storage 回声
   *  不应触发 reloadBagFromDisk 重读自己刚写的内容（对齐 vault 的 lastSelfWrite 模式）。
   *  content 缺省密封当前缓存；changePassphrase 传入口捕获的快照——写序 await 期间 lock() 清空缓存
   *  也不至于把空保管区密文盖到盘上真实内容（F7 残余防护） */
  async function sealBagToDisk(dek: Uint8Array, content: SecretBagContent = bag): Promise<void> {
    lastSelfWrite.bag = Date.now()
    await adapter.set(SECRET_BAG_KEY, await sealSecretBag(dek, content))
  }

  /** 远端保管区变更重读（审查 I7）：解锁态从盘重读 bag 并前进内存视图（复用 advanceBag 路径）；
   *  锁定态忽略——bag 缓存与 DEK 同生命周期（锁定即清空），远端变更等下次解锁经
   *  applyDekAndUnlock 重装载，锁定态下消费远端 bag 会混入本窗口 DEK 解不开的密文（即使可解
   *  也是无 DEK 态持明文秘密，违背锁定语义）。无 DEK（未启用加密）同忽略 */
  async function reloadBagFromDisk(): Promise<void> {
    const dek = dekByWin.get(windowId)
    if (lockedByWin.get(windowId) || !dek) return
    advanceBag(await loadBagFromDisk(dek))
  }

  // ---- DEK seal 助手与合并冲突记录（Task 9/10：spec §1.2 静态保护 + §3 冲突记录 + §4 裁决）----
  // baseSnapshot（SourceSyncState）与 mergeConflicts 均为 vault 明文/整条目秘密：启用加密时必须以
  // DEK 加密落盘（与 vault 密文同保护级）。宿主 runner 装配把 sealWithDek/unsealWithDek 接进
  // core loadSyncState/saveSyncState/loadMergeConflicts/saveMergeConflicts 的 Seal 参数。

  /** 明文 → DEK 密封 JSON（EncryptedVault 形态字符串）。两态显式区分（在途锁定竞态裁定）：
   *  - 未启用加密（security 为空）→ null：明文库场景明文落盘，宿主按 null 回落原文；
   *  - 加密已启用但本窗口无 DEK（锁定）→ 抛 'vault locked'：baseSnapshot/冲突记录含明文秘密，
   *    锁定后绝不明文回落落盘——宿主 seal 让 saveSyncState/saveMergeConflicts 整体失败，
   *    runner/裁决路径按「下轮重做」处理（与 persistAdopted 失败同语义） */
  async function sealWithDekOp(plain: string): Promise<string | null> {
    if (!security.value) return null // 未启用加密：无 DEK 可密封也不需要
    const dek = dekByWin.get(windowId)
    if (!dek) throw new Error('vault locked') // 加密启用但窗口锁定：拒绝明文回落
    return JSON.stringify(await encryptVaultWithDek(dek, plain))
  }

  /** sealWithDekOp 逆操作，两态对称：
   *  - 未启用加密 → null：宿主回落原文（记录本就是明文形态，可解析读取）；
   *  - 锁定 → 抛 'vault locked'：core loadSyncState/loadMergeConflicts 捕获后回落空态（锁定窗口
   *    不解密不持明文），宿主不得吞成明文回落；
   *  - 密文不可解（换 DEK/损坏）→ null：宿主回落原文，core 解析失败自然回落空态 */
  async function unsealWithDekOp(sealed: string): Promise<string | null> {
    if (!security.value) return null
    const dek = dekByWin.get(windowId)
    if (!dek) throw new Error('vault locked')
    try {
      return await decryptVaultWithDek(dek, JSON.parse(sealed) as EncryptedVault)
    } catch {
      return null
    }
  }

  /** 冲突记录通道的 Seal 装配（load/save 共用）：未启用加密 null 回落原文/明文；锁定抛
   *  'vault locked'（load 侧由 core 捕获回落空列表，save 侧整体失败交调用方按下轮重做处理） */
  function mergeConflictSeal(): Seal {
    return {
      seal: async (plain) => (await sealWithDekOp(plain)) ?? plain,
      unseal: async (sealed) => (await unsealWithDekOp(sealed)) ?? sealed,
    }
  }

  /** 从盘装载合并冲突记录（解锁路径汇合点调用）：锁定态不装载不持明文（记录含整条目秘密）；
   *  损坏/换 DEK 回落空列表（core 内部兜底） */
  async function reloadMergeConflicts(): Promise<void> {
    if (lockedByWin.get(windowId)) {
      mergeConflicts.value = []
      return
    }
    try {
      mergeConflicts.value = await loadMergeConflicts(adapter, mergeConflictSeal())
    } catch {
      mergeConflicts.value = []
    }
  }

  /** 追加合并冲突（宿主 runner onMergeConflicts 桥）：同 entryId 以新记录替换（最新胜），
   *  超上限裁最旧（与 core saveMergeConflicts 的上限语义一致，内存视图同步裁剪） */
  async function addMergeConflictsOp(incoming: EntryConflict[]): Promise<void> {
    if (incoming.length === 0) return
    const map = new Map(mergeConflicts.value.map((c) => [c.entryId, c]))
    for (const c of incoming) map.set(c.entryId, c)
    const list = [...map.values()]
    mergeConflicts.value = list.length > MERGE_CONFLICTS_MAX ? list.slice(list.length - MERGE_CONFLICTS_MAX) : list
    await saveMergeConflictsOp()
  }

  /** 冲突记录落盘（mergeConflicts 变更时调用；seal 语义同 syncState） */
  async function saveMergeConflictsOp(): Promise<void> {
    await saveMergeConflicts(adapter, mergeConflicts.value, mergeConflictSeal())
  }

  /** 冲突裁决（spec §3/§4，T11 冲突列表消费）：pick='theirs' 以 conflict.theirs 替换/恢复条目
   *  （theirs=null → 删除条目）；pick='ours' 取 conflict.ours（ours=null → 恢复 base，base 也无 →
   *  删除条目）。写经 commit（自动推进 vault.rev 并触发常规同步），随后从列表移除并落盘。
   *  无对应记录抛错（列表 UI 不会出现该入口，防御兜底） */
  async function resolveMergeConflictOp(entryId: string, pick: 'ours' | 'theirs'): Promise<void> {
    const conflict = mergeConflicts.value.find((c) => c.entryId === entryId)
    if (!conflict) throw new Error('合并冲突记录不存在')
    const chosen = pick === 'theirs' ? conflict.theirs : (conflict.ours ?? conflict.base)
    await commit((v) => {
      const rest = v.entries.filter((e) => e.uuid !== entryId)
      return { ...v, entries: chosen ? [...rest, chosen] : rest }
    })
    mergeConflicts.value = mergeConflicts.value.filter((c) => c.entryId !== entryId)
    await saveMergeConflictsOp()
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

  // ---- F8 vault 新鲜性水位（防密文回滚）----
  // 诚实边界：水位键与 vault 同存于同一 adapter，能整体回卷存储的攻击者同样能回卷水位——本防线只覆盖
  // 「部分状态回放」（如仅回放 VAULT_KEY 密文而水位键留存）与朴素重放；完整新鲜性需 adapter 之外的带外状态。
  async function readVaultRevWatermark(): Promise<VaultRevWatermark | null> {
    const raw = await adapter.get(VAULT_REV_WATERMARK_KEY)
    if (raw === null) return null
    try {
      const p = JSON.parse(raw) as Record<string, unknown>
      if (p['v'] !== 1 || typeof p['dek'] !== 'string') return null
      const rev = p['rev']
      if (typeof rev !== 'number' || !Number.isInteger(rev) || rev < 0) return null
      return { v: 1, dek: p['dek'], rev }
    } catch {
      return null
    }
  }

  /** 采纳前守卫：同 DEK 谱系下密文 rev 低于本地水位 → 抛 VaultRollbackError（拒绝静默采纳）。
   *  谱系不同（双端独立加密/换口令轮换后的新 DEK）rev 不可比，跳过守卫以维持既有「远端者胜」语义。
   *  rev 缺失/非法按 0 计（旧格式密文重放同样受检）。
   *  合法恢复路径：应用内恢复/导入走 replaceAllOp→commit，写入 rev 恒超水位（见 saveVaultToAdapter），无需降水位；
   *  仅 adapter 层整库回灌旧密文这类显式外部操作需同时删除 vault_rev_watermark 键（或整库清空重置）解除拒绝 */
  async function guardVaultRev(dek: Uint8Array, loaded: Vault): Promise<void> {
    const wm = await readVaultRevWatermark()
    if (!wm || wm.dek !== (await dekFingerprint(dek))) return
    const rev = typeof loaded.rev === 'number' && Number.isInteger(loaded.rev) && loaded.rev >= 0 ? loaded.rev : 0
    if (rev < wm.rev) throw new VaultRollbackError()
  }

  /** 解密 + 回滚守卫 + 解析（三处采纳点共用）：守卫通过才返回，回滚时抛 VaultRollbackError 且不产出可采纳内容 */
  async function decryptGuardedVault(dek: Uint8Array, enc: EncryptedVault): Promise<Vault> {
    const { json } = await decryptVaultWithDekDetailed(dek, enc)
    const loaded = JSON.parse(json) as Vault
    await guardVaultRev(dek, loaded)
    return loaded
  }

  /** 采纳/保存成功后推进水位（只进不退；谱系不同则整条覆盖为新谱系起点） */
  async function advanceVaultRevWatermark(dek: Uint8Array, loaded: Vault): Promise<void> {
    const rev = typeof loaded.rev === 'number' && Number.isInteger(loaded.rev) && loaded.rev >= 0 ? loaded.rev : 0
    const fp = await dekFingerprint(dek)
    const wm = await readVaultRevWatermark()
    if (wm && wm.dek === fp && wm.rev >= rev) return
    await adapter.set(VAULT_REV_WATERMARK_KEY, JSON.stringify({ v: 1, dek: fp, rev } satisfies VaultRevWatermark))
  }

  async function initStore(): Promise<void> {
    if (inited) return
    const gen = lockGeneration // F7：入口捕获代数，供自动恢复解锁续延在 await 后复查
    const [parsed, s, sec] = await Promise.all([readRawVault(), loadSettings(adapter), readSecurity()])
    Object.assign(settings, s)
    security.value = sec
    if (isEncryptedVault(parsed)) {
      if (dekByWin.get(windowId)) {
        // 同进程本窗口已持有 DEK（如 unlock 后重建 store / 刷新场景）：先完成可能失败的副步骤（保管区装载），
        // 再一次性前进内存态（replaceVault+退出锁定）——与 applyDekAndUnlock 同序，消除「锁定但持明文+DEK」瞬态
        const dek = dekByWin.get(windowId)!
        const loaded = await decryptGuardedVault(dek, parsed) // F8：回滚密文在此拒绝（抛 VaultRollbackError）
        advanceBag(await loadBagFromDisk(dek)) // 解锁恢复同步装载保管区（口令+凭据）
        replaceVault(loaded)
        await advanceVaultRevWatermark(dek, loaded)
        lockedByWin.set(windowId, false)
        currentLockedRef().value = false
      } else {
        // 会话内 DEK 持久化自动恢复（设计 §1 重启即锁的附带收益）：宿主会话存储仍有 DEK
        // （如 extension chrome.storage.session 在 options/popup 间共享解锁态），直接进解锁态
        const persisted = opts.dekPersist ? await opts.dekPersist.get().catch(() => null) : null
        if (persisted) {
          try {
            await applyDekAndUnlock(base64ToBytes(persisted), gen)
          } catch {
            lock() // 持久化 DEK 失效（换库/损坏/init 期间被锁定中断）：lock 清持久化残留，保持锁定等口令输入
          }
        } else {
          // 密文在手但本窗口无 DEK：本窗口锁定，vault 保持为空防内存残留读取
          lockedByWin.set(windowId, true)
          currentLockedRef().value = true
        }
      }
    } else if (parsed && security.value) {
      // 不变量：『明文 vault 与 SECURITY_KEY 共存 = 需认证的恢复态』——enable/disable 加密两步写
      // 非原子的半失败窗口盘态。写路径有防降级核对（commit/saveVaultToAdapter），读路径同样不得
      // 无认证采纳为已解锁（否则锁定屏被静默跳过）：本窗口保持锁定、vault 不装载（防内存残留读取）；
      // 口令解锁经 applyDekAndUnlock 的宽容明文路径采纳盘上明文，其后写 op 走加密分支重写密文自愈
      lock()
    } else if (parsed) {
      replaceVault(parsed as Vault)
      lockedByWin.set(windowId, false)
      currentLockedRef().value = false
    } else {
      replaceVault(createVault())
    }
    // 合并冲突记录装载（解锁态读盘；锁定态清空不持明文——各分支锁定判定在 reload 内统一处理）
    await reloadMergeConflicts()
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
      // 捕获锁定代数（F1）：saveVaultToAdapter 在每次 await 后复查，lock() 发生在途即中止写盘
      const gen = lockGeneration
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
        await saveVaultToAdapter(gen)
      } catch (e) {
        console.error('[store] saveVault failed:', e)
      }
    })
  }

  /** 落盘：已启用加密且持有本窗口 DEK → 写 EncryptedVault 密文；否则明文 Vault。
   *  gen=commit 起点的锁定代数：任一 await 后复查，代数已变（lock() 发生在途）即静默中止写盘
   *  （任务被锁定取代）——尤其不得落入明文分支把已被 lock 清空的空库覆盖写到盘上密文位置。
   *  加密分支写盘前对称核对盘上 security（与未加密分支的防降级核对对称）：
   *  - 读不到（远端已 disableEncryption）→ 本窗口丢弃加密态、保持解锁、改写明文，跟随远端；
   *    否则「security 缓存非 null 但盘上已删」时密文写回会造成 EncryptedVault 无 security 键的不可恢复死锁
   *  - 存在但与本端缓存不同（远端已换口令）→ 刷新缓存后照常加密写（DEK 是内容密钥不受换口令影响，
   *    wrappedDek 与本端 dek 无关）
   *  - 核对读瞬态失败 → 保守视为存在，照常加密写 */
  async function saveVaultToAdapter(gen: number): Promise<void> {
    if (lockGeneration !== gen) return // 锁定发生在途（含 commit 防降级 await 期间）：任务被取代，中止
    if (security.value && dekByWin.get(windowId)) {
      let disk: SecuritySettings | null
      try {
        disk = await readSecurity()
      } catch {
        disk = security.value // 瞬态 IO 失败：保守视为存在
      }
      if (lockGeneration !== gen) return // await 窗口内 lock() 已清 DEK/内存 vault：不得续延分支判定
      if (disk === null) {
        // 远端已 disableEncryption：丢 DEK 必清 persist（T7 审查 R2 对称语义），
        // 保管区缓存/会话口令一并丢弃（保管区键已被远端删除，密文不可解）
        security.value = null
        dekByWin.set(windowId, null)
        bag = emptyBag()
        credsCache.value = {}
        bagStoredRef.value = false
        setSessionBackupSecret(null)
        void opts.dekPersist?.clear()
        lockedByWin.set(windowId, false)
        currentLockedRef().value = false
      } else {
        security.value = disk
      }
    }
  if (lockGeneration !== gen) return
  if (security.value && dekByWin.get(windowId)) {
    // F8：加密写推进单调 rev（进密文明文）且必须越过本地水位——覆盖「恢复旧备份（replaceAllOp 换入低/无 rev
    // 内容）后继续写」场景：新记录 rev 若低于水位会被采纳守卫误拒。记录写成功后再推进水位键（先记录后水位：
    // 中途失败只会让水位暂时落后——宁可漏检一次，不可误拒未回放的合法记录）
    const dek = dekByWin.get(windowId)!
    const fp = await dekFingerprint(dek)
    const wm = await readVaultRevWatermark()
    if (lockGeneration !== gen) return // await 窗口内 lock() 发生：任务被取代，中止
    const floor = wm && wm.dek === fp ? wm.rev : 0
    const cur = typeof vault.rev === 'number' && Number.isInteger(vault.rev) && vault.rev >= 0 ? vault.rev : 0
    vault.rev = Math.max(cur, floor) + 1
    const encrypted = await encryptVaultWithDek(dek, JSON.stringify(vault))
    if (lockGeneration !== gen) return // 加密 await 后、写盘前复查：lock 已清 DEK/内存 vault，不得以旧 gen 写盘
    await adapter.set(VAULT_KEY, JSON.stringify(encrypted))
    await adapter.set(VAULT_REV_WATERMARK_KEY, JSON.stringify({ v: 1, dek: fp, rev: vault.rev } satisfies VaultRevWatermark))
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
              let remoteVault: Vault
              try {
                remoteVault = await decryptGuardedVault(dekByWin.get(windowId)!, parsed)
              } catch (e) {
                // F8：同谱系回滚密文（rev 低于水位）→ 拒绝采纳且不上锁，保留本地较新内存态
                // （本地 rev ≥ 水位，下次自愈写会覆盖盘上旧密文）；其余按不可解处理（转锁定等远端口令）
                if (e instanceof VaultRollbackError) return
                lock()
                security.value = await readSecurity().catch(() => null)
                return
              }
              // 持有 DEK 才解密填充（远端未轮换时旧 DEK 仍可解；默认轮换后旧 DEK 解不开 → 上方 catch 转锁定）
              replaceVault(remoteVault)
              await advanceVaultRevWatermark(dekByWin.get(windowId)!, remoteVault)
              // 远端覆盖后必须强制锁定：注释承诺了「丢弃本端 DEK、转锁定」但未执行，
              // 否则下次 commit 会以本端 DEK 加密 + 远端 security 落盘（仍属幽灵密文）。
              // security 缓存同步重读为盘上值，与下次 unlock 的口令入口对齐
              lock()
              security.value = await readSecurity().catch(() => null)
              return
            }
            if (security.value) {
              // 不变量：『明文 vault 与 SECURITY_KEY 共存 = 需认证的恢复态』——security 存在时
              // 拒绝消费远端明文 vault 载荷：不 replaceVault（防无认证内容混入内存）、不动盘上
              // SECURITY_KEY；后续写 op 的盘上 security 对称核对保持与远端最终一致
              return
            }
            replaceVault(parsed as Vault)
          })
          .catch(() => {})
      }
      if (payload.settings && Date.now() - lastSelfWrite.settings >= suppressMs) {
        loadSettings(adapter).then((s) => Object.assign(settings, s)).catch(() => {})
      }
      // 保管区远端变更（审查 I7）：自写窗口内的通知视为自身回声跳过；否则解锁态重读前进内存视图
      if (payload.secretBag && Date.now() - lastSelfWrite.bag >= suppressMs) {
        void reloadBagFromDisk().catch(() => {})
      }
    })
  }

  /** 启用加密：以当前内存 vault 明文建 KEK/wrap DEK → 写 security + 密文 vault → 本窗口缓存 DEK。
   *  经 commit 队列执行：Argon2 派生耗时数百 ms，期间的并发写 op 必须排队，
   *  否则会以 enable 前的旧快照落盘覆盖新写（真实竞态）。
   *  F7：派生/盘写每个 await 后复查锁定代数，期间 lock() 已发生即中止——内存态（security/dek/解锁标记）
   *  统一延到全部盘写成功后前进，故中止点零内存污染，也无需失败回滚误清 lock() 特意保留的
   *  security 缓存（锁定态 LockScreen 枚举解锁方式依赖）；残余：锁定恰插入两次盘写 await 之间时
   *  盘上至多留下「security 在但 vault 仍明文」半失败态（unlock 宽容接受，与既有崩溃语义同类） */
  function enableEncryption(password: string): Promise<void> {
    return enqueue(async () => {
      if (lockedByWin.get(windowId)) throw new Error('vault locked')
      const gen = lockGeneration
      // 不用 toRaw：直接序列化响应式对象（P5 裁定，避免 raw target 与 reactive 视图不一致）
      const r = await setupVaultEncryption(JSON.stringify(vault), password)
      ensureNotLockedSince(gen)
      // 先写 security 后写密文：中途崩溃最多出现「security 在但 vault 仍明文」，数据不丢
      lastSelfWrite.vault = Date.now() // security 键写入复用 vault 自写窗口抑制（onChanged 无 security 通道）
      await adapter.set(SECURITY_KEY, JSON.stringify(r.security))
      ensureNotLockedSince(gen)
      lastSelfWrite.vault = Date.now()
      await adapter.set(VAULT_KEY, JSON.stringify(r.encrypted))
      ensureNotLockedSince(gen)
      security.value = r.security
      dekByWin.set(windowId, r.dek)
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
      lastSelfWrite.bag = Date.now() // 删除路径对称开自写窗口（审查修复）：本端删除的 storage 回声不触发 reloadBagFromDisk
      await adapter.delete(SECRET_BAG_KEY)
      bag = emptyBag()
      credsCache.value = {}
      bagStoredRef.value = false
      setSessionBackupSecret(null)
      lastSelfWrite.vault = Date.now()
      await saveVault(adapter, toRaw(vault) as Vault)
      await adapter.delete(SECURITY_KEY)
      // F12：staged 轮换的 PENDING 暂存随加密一并退役（残留为死数据：明文库语义下 unlock 恢复路径
      // 的 GCM 证明使其永远无法被转正或误解锁）。删除尽力而为，不阻断关闭——失败时残留 PENDING
      // 由成功口令解锁的孤儿清理或下次 staged 轮换的覆写收尾
      await adapter.delete(SECURITY_PENDING_KEY).catch(() => {})
      security.value = null
      dekByWin.set(windowId, null)
      void opts.dekPersist?.clear() // 丢 DEK 必清 persist（T7 审查 R2 对称语义）
      lockedByWin.set(windowId, false)
      currentLockedRef().value = false
    })
  }

  /** 更换口令（需已解锁）：默认 rotateDek=true（设计 §2 裁定改口令即被动轮换）——重生成 DEK、全库重加密写盘、
   *  保管区重封、kekSources 重置为 password 源（prf/dpapi 死凭证数据层丢弃，宿主 UI 引导重绑）；
   *  rotateDek=false 仅重包裹（DEK 不变，多绑来源保留）。经 commit 队列，与写 op 串行。
   *  轮换路径为 staged 提交（F12）：新 wrappedDek 先写 SECURITY_PENDING_KEY 暂存，vault 重写成功后才
   *  重封保管区并转正 SECURITY_KEY。不变量：任一失败点盘上要么是完整旧态（旧 SECURITY_KEY + 旧 DEK vault，
   *  PENDING 已清/为孤儿），要么 PENDING 在场且 vault 可能已换新 DEK（unlock 恢复路径以新口令补完）——
   *  杜绝「旧 SECURITY_KEY + 新 DEK vault + 无 PENDING」的永久锁死。
   *  F7：changeVaultPassphrase 派生后、首个盘写前复查锁定代数（此点中止零盘写零内存前进）；盘写一旦开始
   *  不再因锁定中止（中途弃写会留下不可解盘态），写序全部完成后按代数统一裁决内存前进：期间被锁即保持
   *  锁定、不重挂 DEK、不写持久化，盘上为完整一致的新口令态，用户以新口令重新解锁即可 */
  function changePassphrase(newPassword: string, changeOpts: { rotateDek?: boolean; profile?: KdfProfile } = {}): Promise<void> {
    return enqueue(async () => {
      if (lockedByWin.get(windowId)) throw new Error('vault locked')
      if (!security.value || !dekByWin.get(windowId)) throw new Error('encryption not enabled')
      // rotateDek 缺省 true（设计 §2 裁定改口令即被动轮换）；显式传 undefined 也不得静默关闭轮换
      // （审查 Minor：{ rotateDek: true, ...changeOpts } 展开顺序会让显式 undefined 覆盖默认值）
      const gen = lockGeneration
      const r = await changeVaultPassphrase(security.value, dekByWin.get(windowId)!, newPassword, { ...changeOpts, rotateDek: changeOpts.rotateDek ?? true })
      ensureNotLockedSince(gen)
      if (r.dek) {
        // F7：盘写序起点同步捕获保管区快照（至盘写序内各调用显式传入，杜绝锁定清空 bag 后把空保管区封盘）
        const bagSnapshot = bag
        // staged ① 暂存：新 wrappedDek 先落 PENDING。失败则盘上未动，完整旧态，重试自愈
        await adapter.set(SECURITY_PENDING_KEY, JSON.stringify(r.security))
        try {
          // staged ② 全库重加密（新 DEK）。仅此步失败才清 PENDING：vault 未被改写，旧 SECURITY_KEY
          // 完整有效，PENDING 已成孤儿（其新 DEK 与盘上旧 DEK vault 过不了 GCM 证明），清除即完整回滚
          lastSelfWrite.vault = Date.now()
          await adapter.set(VAULT_KEY, JSON.stringify(await encryptVaultWithDek(r.dek, JSON.stringify(vault))))
        } catch (e) {
          await adapter.delete(SECURITY_PENDING_KEY).catch(() => {})
          throw e
        }
        // staged ③ 自此盘上 vault 已是新 DEK 密文：其后任何失败都必须保留 PENDING（它是新口令经
        // unlock 恢复路径补完轮换的唯一依据），清了即成 F12 锁死态。保管区重封须在转正前——
        // 否则转正后旧 DEK 内存态的后续 commit 会以旧 DEK 重写 vault + 新 SECURITY_KEY，再造锁死
        await sealBagToDisk(r.dek, bagSnapshot) // 保管区重封（新 DEK 写盘前 dekByWin 尚未前进，显式传入快照防锁定清空）
        // staged ④ 转正（提交点）：SECURITY_KEY ← 新 wrappedDek。此写失败 PENDING 自然保留
        // （中间态可达恢复路径）；成功后 PENDING 残留与 SECURITY_KEY 同内容已无害，删除尽力而为，
        // 失败由下次成功口令解锁的孤儿清理兜底
        lastSelfWrite.vault = Date.now()
        await adapter.set(SECURITY_KEY, JSON.stringify(r.security))
        await adapter.delete(SECURITY_PENDING_KEY).catch(() => {})
        // staged ⑤（F7 裁决）全部盘写成功后才按代数前进内存：期间 lock() 已发生（代数前进）→
        // 保持锁定，不重挂 DEK、不写持久化、security 缓存保持旧值（旧口令主路径解锁仍成立，
        // 新口令经 PENDING 恢复路径补完）
        if (lockGeneration === gen) {
          dekByWin.set(windowId, r.dek)
          void opts.dekPersist?.set(r.dek)
          security.value = r.security
        }
      } else {
        // rotateDek=false 仅重包裹（DEK 不变，vault/bag 无需重写），security 落盘作唯一提交点（原语义不变）
        security.value = r.security
        lastSelfWrite.vault = Date.now()
        await adapter.set(SECURITY_KEY, JSON.stringify(r.security))
      }
    })
  }

  /** 解锁：口令解出 DEK → 本窗口读盘解密/明文填充 → 退出锁定；口令错时原样抛出供组件展示。
   *  盘上 vault 非密文（缺失或明文）时宽容接受：这是「security 在但 vault 明文」的
   *  enableEncryption 半失败不一致态，直接加载并恢复持有 DEK，后续写 op 经加密分支自愈回密文。
   *  F7：入口捕获锁定代数下传，Argon2 派生等 await 窗口内的 lock() 由 applyDekAndUnlock 复查中止。
   *  F12：主路径失败后尝试 PENDING 恢复（staged 轮换第二步由新口令补完）；主路径成功（vault 已被
   *  本口令 DEK 成功解开）则盘上 PENDING 必为孤儿/转正残留，尽力清理——失败无碍，下次解锁再清 */
  async function unlock(password: string): Promise<void> {
    if (!security.value) throw new Error('encryption not enabled')
    const gen = lockGeneration
    try {
      await applyDekAndUnlock(await unlockVaultEncryption(security.value, password), gen)
    } catch (e) {
      await unlockViaPending(password, e)
      return
    }
    await adapter.delete(SECURITY_PENDING_KEY).catch(() => {})
  }

  /** F12 PENDING 恢复：staged changePassphrase 中断的中间盘态（旧 SECURITY_KEY + 可能已换新 DEK 的
   *  vault + PENDING）由新口令补完轮换。仅当 ①该口令能解开 PENDING 的 wrappedDek，且 ②PENDING 的 DEK
   *  能解开盘上现有 vault 密文（GCM 证明 vault 确属本次轮换的新 DEK，同时排除 vault 明文/缺失的完整旧态
   *  与陈旧/异体 PENDING）才转正：SECURITY_KEY ← PENDING → 清 PENDING → 以新 DEK 走 applyDekAndUnlock。
   *  其余任何失败一律原样重抛主路径错误且绝不删除 PENDING（它是中间态下新口令的唯一恢复通道）；
   *  转正写盘失败 PENDING 仍在场，恢复路径可重试（同一不变量）。
   *  F7：转正提交点捕获新锁定代数下传 applyDekAndUnlock——恢复解锁自身的 await 窗口同样受复查保护 */
  async function unlockViaPending(password: string, primaryErr: unknown): Promise<void> {
    const raw = await adapter.get(SECURITY_PENDING_KEY).catch(() => null)
    if (typeof raw !== 'string') throw primaryErr
    let pending: SecuritySettings
    try {
      pending = JSON.parse(raw) as SecuritySettings
      if (!isSecuritySettings(pending)) throw new Error('invalid pending security')
    } catch {
      // 结构损坏的 PENDING 永远过不了证明，也无法被任何口令解开：按孤儿尽力清理后原错误照抛
      await adapter.delete(SECURITY_PENDING_KEY).catch(() => {})
      throw primaryErr
    }
    let dek: Uint8Array
    try {
      dek = await unlockVaultEncryption(pending, password)
    } catch {
      throw primaryErr // 该口令不解 PENDING：维持主路径错误（如「口令错误或数据已损坏」）
    }
    const parsed = await readRawVault()
    if (!isEncryptedVault(parsed)) throw primaryErr // vault 明文/缺失：旧态完整，无需也不得转正
    try {
      await decryptVaultWithDek(dek, parsed) // GCM 证明：PENDING 的 DEK 确能解开现有 vault
    } catch {
      throw primaryErr // 证明失败（陈旧/异体 PENDING）：拒绝转正，防植入 PENDING 借机夺权
    }
    lastSelfWrite.vault = Date.now() // security 键写入复用 vault 自写窗口抑制（onChanged 无 security 通道）
    await adapter.set(SECURITY_KEY, JSON.stringify(pending))
    security.value = pending
    await adapter.delete(SECURITY_PENDING_KEY).catch(() => {})
    await applyDekAndUnlock(dek, lockGeneration)
  }

  /** unlock(password) 共享的后置逻辑：本窗口读盘解密/明文填充 → 本窗口持有 DEK → 退出锁定。
   *  gen 为调用方入口捕获的锁定代数（F7 不变量）：每个 await 后复查，期间 lock() 已发生即中止——
   *  丢弃解出的 DEK 与明文，不重挂、不写持久化、不翻回解锁态（password/unlockWithDek/initStore 三路汇此） */
  async function applyDekAndUnlock(key: Uint8Array, gen: number): Promise<void> {
    ensureNotLockedSince(gen)
    const parsed = await readRawVault()
    ensureNotLockedSince(gen)
    let loaded: Vault
    if (isEncryptedVault(parsed)) {
      loaded = await decryptGuardedVault(key, parsed) // F8：回滚密文在此拒绝（抛 VaultRollbackError，锁定态不前进）
      ensureNotLockedSince(gen) // F7：解密 await 窗口内 lock() 已发生即中止（不装填旧内容、不前进）
    } else {
      loaded = parsed !== null ? (parsed as Vault) : createVault()
    }
    // 可能失败的副步骤（保管区装载，失败按空保管区回落）先完成，再一次性前进全部内存态
    // （bag/会话口令 → vault → 持 DEK → 退出锁定）：消除「locked=true 但内存持明文+DEK」瞬态窗口（T7 审查 R1）
    const loadedBag = await loadBagFromDisk(key)
    ensureNotLockedSince(gen)
    advanceBag(loadedBag) // 解锁自动装载保管区（password 与 unlockWithDek/PRF 两条路径均汇于此）
    replaceVault(loaded)
    await advanceVaultRevWatermark(key, loaded)
    dekByWin.set(windowId, key)
    lockedByWin.set(windowId, false)
    currentLockedRef().value = false
    // DEK 持久化（设计 §1 重启即锁）：解锁成功即写宿主会话存储（extension=chrome.storage.session base64）
    void opts.dekPersist?.set(key)
    // 合并冲突记录随解锁重装载（记录含整条目秘密，锁定已清）
    await reloadMergeConflicts()
  }

  /** passkey 解锁第二跳：外部经 core unlockWithPrf 解出 DEK 后注入。
   *  security 缓存缺失（跨窗口陈旧/未 initStore）时从盘补读，保证后续加密写路径可用。
   *  F7：代数在入口捕获（readSecurity 补读 await 之前），补读窗口内的 lock() 同样被复查拦截 */
  async function unlockWithDek(key: Uint8Array): Promise<void> {
    const gen = lockGeneration
    if (!security.value) security.value = await readSecurity()
    if (!security.value) throw new Error('encryption not enabled')
    // C1：调用方应保证 DEK 长度 32B；core unlockWithPrf 已加校验，此处再校验一次防 caller 跳过 core 直接注入
    if (key.length !== 32) throw new Error('invalid DEK length from PRF unwrap')
    await applyDekAndUnlock(key, gen)
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
      await sealBagToDisk(dekByWin.get(windowId)!)
      bagStoredRef.value = true
    }
  }

  /** 清除备份口令：会话必清；解锁+加密态时同步清保管区口令字段并重封写盘（凭据保留）；
   *  未启用/锁定态保管区密文本就不可用，只清会话不报错 */
  async function forgetBackupSecret(): Promise<void> {
    setSessionBackupSecret(null)
    if (security.value && !lockedByWin.get(windowId)) {
      bag.backupPassword = ''
      await sealBagToDisk(dekByWin.get(windowId)!)
      bagStoredRef.value = false
    }
  }

  /** 保存/更新指定源的云凭据入保管区（设计 §1：凭据是秘密，随 DEK 密文存放）。解锁+加密守护 */
  function saveSourceCredOp(id: string, cred: CloudCred): Promise<void> {
    return enqueue(async () => {
      if (lockedByWin.get(windowId)) throw new Error('vault locked')
      if (!security.value || !dekByWin.get(windowId)) throw new Error('需先启用加密才能保存云凭据')
      bag.creds[id] = cred
      await sealBagToDisk(dekByWin.get(windowId)!)
      credsCache.value = { ...bag.creds }
    })
  }

  /** 移除指定源的云凭据（保管区重封写盘；源元数据在 settings，不由本 op 处理）。解锁+加密守护 */
  function removeSourceCredOp(id: string): Promise<void> {
    return enqueue(async () => {
      if (lockedByWin.get(windowId)) throw new Error('vault locked')
      if (!security.value || !dekByWin.get(windowId)) throw new Error('需先启用加密才能保存云凭据')
      delete bag.creds[id]
      await sealBagToDisk(dekByWin.get(windowId)!)
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
      await sealBagToDisk(dekByWin.get(windowId)!)
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
    lockGeneration++ // F1+F7：代数单调前进——在途 commit 落盘写与加密/解锁续延在下一复查点即中止
    dekByWin.set(windowId, null)
    lockedByWin.set(windowId, true)
    currentLockedRef().value = true
    setSessionBackupSecret(null) // 会话口令与 DEK 同生命周期：锁定即清
    bag = emptyBag() // 保管区缓存与 DEK 同生命周期：锁定即清（密文仍留盘，解锁后重装载）
    credsCache.value = {}
    bagStoredRef.value = false
    mergeConflicts.value = [] // 冲突记录含整条目秘密：与保管区同生命周期，锁定清空（盘上密文留待解锁重装载）
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
    /** 条目级合并冲突记录（spec §3/§4；解锁自动装载、锁定清空；追加走 addMergeConflictsOp，
     *  裁决走 resolveMergeConflictOp） */
    mergeConflicts,
    /** 未裁决合并冲突计数（badge/横幅源） */
    conflictCount,
    /** DEK seal 助手（spec §1.2 静态保护：syncState.baseSnapshot/mergeConflicts 等秘密载体落盘）：
     *  未启用加密返回 null（宿主按明文回落）；加密启用但锁定抛 'vault locked'（在途锁定不得明文
     *  落盘，宿主让落盘整体失败按下轮重做处理） */
    sealWithDek: sealWithDekOp, unsealWithDek: unsealWithDekOp,
    /** 合并冲突追加（runner onMergeConflicts 桥）/落盘/裁决（T11 冲突列表消费） */
    addMergeConflictsOp, saveMergeConflictsOp, resolveMergeConflictOp,
    /** 远端保管区变更重读（审查 I7）：解锁态从盘重读前进内存视图；锁定/无 DEK 忽略。宿主 registerSync 透传 secretBag 键时由 registerStorageSync 自动调用 */
    reloadBagFromDisk,
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
    /** 建 tag 并回传 id（同名幂等复用）：EntryForm 内联建 tag 自动勾选依赖此返回值 */
    addTagOp: (name: string): Promise<string> => {
      let tagId = ''
      return commit((v) => {
        const r = addTag(v, name)
        tagId = r.tagId
        return r.vault
      }).then(() => tagId)
    },
    renameTagOp: (id: string, name: string) => commit((v) => renameTag(v, id, name)),
    removeTagOp: (id: string) => commit((v) => removeTag(v, id)),
    reorderOp: (uuids: string[]) => commit((v) => reorderEntries(v, uuids)),
    // 整体替换（恢复备份/导入）：replaceVault 用 splice 逐项拷入，保证响应式与深拷贝语义
    replaceAllOp: (v: Vault) => commit(() => v),
  }
}

export type VueStore = ReturnType<typeof createVueStore>