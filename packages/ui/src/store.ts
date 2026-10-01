import {
  DEFAULT_SETTINGS, SECURITY_KEY, VAULT_KEY, VAULT_REV_WATERMARK_KEY, VaultRollbackError, addEntry,
  addTag, base64ToBytes, createVault, dekFingerprint, decryptVaultWithDekDetailed, encryptVaultWithDek,
  isEncryptedVault, loadSettings, removeEntry, removeEntries, removeTag, renameTag, reorderEntries, saveSettings, saveVault,
  updateEntry, validateVaultObject,
  type AppSettings, type EncryptedVault, type OtpEntry, type SecuritySettings, type StorageAdapter, type Vault,
  type VaultRevWatermark,
} from '@totp/core'
import { reactive, toRaw } from 'vue'
import { createConflictLedger } from './store/conflictLedger'
import { createEncryptionSession } from './store/encryptionSession'
import { createSecretBagStore } from './store/secretBagStore'

/** 组合根（R6③）：createVueStore 只做「vault 明文账本 + 主提交队列 + 三个子工厂」的组合与
 *  initStore/commit/lock 编排——加密会话（store/encryptionSession）、保管区（store/secretBagStore）、
 *  合并冲突账本（store/conflictLedger）各持其态。装配序与回指：bag/conflicts 先建，其 deps 内
 *  方法经闭包延迟回指后建的 encryption；applyDekAndUnlock/lock 跨子工厂的编排各自收口。
 *  硬约束：返回对象形状不变（两端宿主零改动，test/store.shape.test.ts 守卫） */
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
    /** DEK 前进回调（① mini 跟随主窗解锁）：解锁路径（applyDekAndUnlock 成功完成）与
     *  enableEncryption / changePassphrase(rotateDek=true) 提交三个 DEK 前进点触发一次 */
    onUnlocked?: () => void
    /** 冲突裁决成功后的未裁决计数回调：extension 桥到持久计数键 + action badge 即时对账
     *  （与 runner onConflicts 同口径，消除「自动同步关闭时 badge 等下轮同步才清」的滞后）；
     *  desktop 不传则零行为 */
    onConflictCountChanged?: (count: number) => void
    /** lock() 完成后的宿主回调（与 onCommitted 同为可选宿主挂钩，不传零行为）：desktop 注入
     *  invoke('clear_stashed_dek')——手动/空闲/系统锁库走纯前端 lock() 不通知 Rust，须同步清
     *  Rust 侧 DEK 暂存槽，防「stash 后 destroy 失败回滚→锁库→销毁重建回注旧 DEK 绕过锁定」 */
    onLocked?: () => void
    /** vault 持久化失败上报（R16⑤）：commit 落盘失败不再仅 console.error 吞掉——宿主传入后
     *  收到原始错误（内存态已前进、盘上落后，宿主可提示用户「数据未保存」）；不传保持仅日志 */
    onPersistError?: (e: unknown) => void
  } = {},
) {
  const suppressMs = opts.selfWriteSuppressMs ?? 500
  const windowId = opts.windowId ?? 'main'
  const vault = reactive<Vault>({ version: 2, entries: [], tags: [], updatedAt: 0 })
  const settings = reactive<AppSettings>({ ...DEFAULT_SETTINGS })
  let inited = false
  const lastSelfWrite = { vault: 0, settings: 0, bag: 0 }
  let queue: Promise<void> = Promise.resolve()

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

  // ---- 子工厂装配（R6③）----
  /** 合并冲突账本：seal 通道与锁定态经 getter 延迟回指下方 encryption */
  const conflicts = createConflictLedger({
    adapter,
    isLocked: () => encryption.isLocked(),
    sealWithDek: (plain) => encryption.sealWithDek(plain),
    unsealWithDek: (sealed) => encryption.unsealWithDek(sealed),
    commit,
    onConflictCountChanged: opts.onConflictCountChanged,
  })
  /** 保管区：会话侧（锁定态/DEK/会话口令）经 getter 延迟回指 encryption */
  const bagStore = createSecretBagStore({
    adapter,
    enqueue,
    selfWrite: lastSelfWrite,
    session: {
      hasEncryption: () => encryption.security.value !== null,
      isLocked: () => encryption.isLocked(),
      currentDek: () => encryption.getCurrentDek(),
      setSessionBackupSecret: (secret) => encryption.setSessionBackupSecret(secret),
    },
    readRawVault,
    commit,
  })
  /** 加密会话：security 缓存 + 按 windowId 会话 + KEK 写协议 + 启停/改口令/解锁流程 */
  const encryption = createEncryptionSession({
    adapter,
    windowId,
    dekPersist: opts.dekPersist,
    onUnlock: opts.onUnlocked,
    enqueue,
    selfWrite: lastSelfWrite,
    bag: bagStore,
    conflicts,
    vaultIo: {
      readRaw: readRawVault,
      replace: replaceVault,
      json: () => JSON.stringify(vault),
      savePlain: async () => saveVault(adapter, toRaw(vault) as Vault),
    },
    decryptGuardedVault,
    advanceVaultRevWatermark,
    readSecurity,
  })

  async function initStore(): Promise<void> {
    if (inited) return
    const gen = encryption.generation // F7：入口捕获代数，供自动恢复解锁续延在 await 后复查
    const [parsed, s, sec] = await Promise.all([readRawVault(), loadSettings(adapter), readSecurity()])
    Object.assign(settings, s)
    encryption.security.value = sec
    if (isEncryptedVault(parsed)) {
      if (encryption.hasDek()) {
        // 同进程本窗口已持有 DEK（如 unlock 后重建 store / 刷新场景）：先完成可能失败的副步骤（保管区装载），
        // 再一次性前进内存态（replaceVault+退出锁定）——与 applyDekAndUnlock 同序，消除「锁定但持明文+DEK」瞬态
        const dek = encryption.getCurrentDek()!
        const loaded = await decryptGuardedVault(dek, parsed) // F8：回滚密文在此拒绝（抛 VaultRollbackError）
        bagStore.advance(await bagStore.loadFromDisk(dek)) // 解锁恢复同步装载保管区（口令+凭据）
        replaceVault(loaded)
        await advanceVaultRevWatermark(dek, loaded)
        encryption.setWindowLocked(false)
      } else {
        // 会话内 DEK 持久化自动恢复（设计 §1 重启即锁的附带收益）：宿主会话存储仍有 DEK
        // （如 extension chrome.storage.session 在 options/popup 间共享解锁态），直接进解锁态
        const persisted = opts.dekPersist ? await opts.dekPersist.get().catch(() => null) : null
        if (persisted) {
          try {
            await encryption.applyDekAndUnlock(base64ToBytes(persisted), gen)
          } catch {
            lock() // 持久化 DEK 失效（换库/损坏/init 期间被锁定中断）：lock 清持久化残留，保持锁定等口令输入
          }
        } else {
          // 密文在手但本窗口无 DEK：本窗口锁定，vault 保持为空防内存残留读取
          encryption.setWindowLocked(true)
        }
      }
    } else if (parsed && encryption.security.value) {
      // 不变量：『明文 vault 与 SECURITY_KEY 共存 = 需认证的恢复态』——enable/disable 加密两步写
      // 非原子的半失败窗口盘态。写路径有防降级核对（commit/saveVaultToAdapter），读路径同样不得
      // 无认证采纳为已解锁（否则锁定屏被静默跳过）：本窗口保持锁定、vault 不装载（防内存残留读取）；
      // 口令解锁经 applyDekAndUnlock 的宽容明文路径采纳盘上明文，其后写 op 走加密分支重写密文自愈
      lock()
    } else if (parsed) {
      replaceVault(parsed as Vault)
      encryption.setWindowLocked(false)
    } else {
      replaceVault(createVault())
    }
    // 合并冲突记录装载（解锁态读盘；锁定态清空不持明文——各分支锁定判定在 reload 内统一处理）
    await conflicts.reload()
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
      if (encryption.isLocked()) throw new Error('vault locked')
      // 捕获锁定代数（F1）：saveVaultToAdapter 在每次 await 后复查，lock() 发生在途即中止写盘
      const gen = encryption.generation
      // 防加密降级：本端 security 缓存为空时核对盘上 security（远端已启用而本端陈旧→转锁定并拒绝本次明文写，
      // 避免明文覆盖密文造成降级与「security 在但 vault 明文」的不一致态）。代价：未加密用户每次写多一次 adapter.get
      if (!encryption.security.value) {
        const disk = await readSecurity()
        if (disk) {
          encryption.security.value = disk
          lock()
          throw new Error('vault locked')
        }
      }
      replaceVault(fn(vault))
      try {
        lastSelfWrite.vault = Date.now()
        await saveVaultToAdapter(gen)
      } catch (e) {
        // R16⑤：内存态已前进而盘上落后，失败须可被宿主感知（提示「数据未保存」）——
        // 注入 onPersistError 上报；未注入保持仅日志（队列语义不变：失败不传染后续任务）
        if (opts.onPersistError) opts.onPersistError(e)
        else console.error('[store] saveVault failed:', e)
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
    if (encryption.generation !== gen) return // 锁定发生在途（含 commit 防降级 await 期间）：任务被取代，中止
    if (encryption.security.value && encryption.getCurrentDek()) {
      let disk: SecuritySettings | null
      try {
        disk = await readSecurity()
      } catch {
        disk = encryption.security.value // 瞬态 IO 失败：保守视为存在
      }
      if (encryption.generation !== gen) return // await 窗口内 lock() 已清 DEK/内存 vault：不得续延分支判定
      if (disk === null) {
        // 远端已 disableEncryption：丢弃本窗口加密态（丢 DEK 必清 persist、保管区缓存/会话口令一并丢弃——
        // 保管区键已被远端删除，密文不可解），保持解锁改写明文跟随远端
        encryption.forgetEncryption()
      } else {
        encryption.security.value = disk
      }
    }
    if (encryption.generation !== gen) return
    if (encryption.security.value && encryption.getCurrentDek()) {
      // F8：加密写推进单调 rev（进密文明文）且必须越过本地水位——覆盖「恢复旧备份（replaceAllOp 换入低/无 rev
      // 内容）后继续写」场景：新记录 rev 若低于水位会被采纳守卫误拒。记录写成功后再推进水位键（先记录后水位：
      // 中途失败只会让水位暂时落后——宁可漏检一次，不可误拒未回放的合法记录）
      const dek = encryption.getCurrentDek()!
      const fp = await dekFingerprint(dek)
      const wm = await readVaultRevWatermark()
      if (encryption.generation !== gen) return // await 窗口内 lock() 发生：任务被取代，中止
      const floor = wm && wm.dek === fp ? wm.rev : 0
      const cur = typeof vault.rev === 'number' && Number.isInteger(vault.rev) && vault.rev >= 0 ? vault.rev : 0
      vault.rev = Math.max(cur, floor) + 1
      const encrypted = await encryptVaultWithDek(dek, JSON.stringify(vault))
      if (encryption.generation !== gen) return // 加密 await 后、写盘前复查：lock 已清 DEK/内存 vault，不得以旧 gen 写盘
      await adapter.set(VAULT_KEY, JSON.stringify(encrypted))
      await adapter.set(VAULT_REV_WATERMARK_KEY, JSON.stringify({ v: 1, dek: fp, rev: vault.rev } satisfies VaultRevWatermark))
    } else {
      await saveVault(adapter, toRaw(vault) as Vault)
    }
  }

  /** settings 落盘（R6①：改走 enqueue，消除与 commit 并存的第二套手写入队——
   *  串行/单任务失败不传染/onCommitted 触发语义由 enqueue 单点保证）。任务内吞掉
   *  saveSettings 的 IO 错误（落盘失败不 reject 调用方，仅记日志） */
  function commitSettings(): Promise<void> {
    return enqueue(async () => {
      try {
        lastSelfWrite.settings = Date.now()
        await saveSettings(adapter, toRaw(settings) as AppSettings)
      } catch (e) {
        console.error('[store] saveSettings failed:', e)
      }
    })
  }

  function registerStorageSync(): void {
    opts.registerSync?.((payload) => {
      if (payload.vault && Date.now() - lastSelfWrite.vault >= suppressMs) {
        adapter.get(VAULT_KEY)
          .then(async (raw) => {
            if (raw === null) return
            const parsed: unknown = JSON.parse(raw)
            // 本窗口锁定不消费任何远端 vault 内容（防本窗口锁定态下明文/密文混入内存）
            if (encryption.isLocked()) return
            if (isEncryptedVault(parsed)) {
              if (!encryption.hasDek()) {
                // 远端已启用加密而本窗口未持有 DEK：本窗口转锁定并从盘刷新 security 缓存，
                // 与远端状态对齐；否则本窗口后续明文写会降级覆盖密文
                lock()
                encryption.security.value = await readSecurity().catch(() => null)
                return
              }
              // 双端独立加密防线（浏览器同步）：本窗口 DEK 解不开远端密文 → 远端 rev 高者胜，
              // 采用远端状态：丢弃本窗口 DEK、转锁定、security 缓存刷新为盘上（远端）值，等待输入远端口令。
              // 不拦截则本窗口后续写 op 会以本端 DEK 加密 + 远端 security 落盘 → 无人可解的幽灵密文
              let remoteVault: Vault
              try {
                remoteVault = await decryptGuardedVault(encryption.getCurrentDek()!, parsed)
              } catch (e) {
                // F8：同谱系回滚密文（rev 低于水位）→ 拒绝采纳且不上锁，保留本地较新内存态
                // （本地 rev ≥ 水位，下次自愈写会覆盖盘上旧密文）；其余按不可解处理（转锁定等远端口令）
                if (e instanceof VaultRollbackError) return
                lock()
                encryption.security.value = await readSecurity().catch(() => null)
                return
              }
              // 持有 DEK 才解密填充（远端未轮换时旧 DEK 仍可解；默认轮换后旧 DEK 解不开 → 上方 catch 转锁定）
              replaceVault(remoteVault)
              await advanceVaultRevWatermark(encryption.getCurrentDek()!, remoteVault)
              // 远端覆盖后必须强制锁定：注释承诺了「丢弃本端 DEK、转锁定」但未执行，
              // 否则下次 commit 会以本端 DEK 加密 + 远端 security 落盘（仍属幽灵密文）。
              // security 缓存同步重读为盘上值，与下次 unlock 的口令入口对齐
              lock()
              encryption.security.value = await readSecurity().catch(() => null)
              return
            }
            if (encryption.security.value) {
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
        void bagStore.reloadFromDisk().catch(() => {})
      }
    })
  }

  /** 锁定：本窗口丢弃 DEK、清空内存 vault（防内存残留读取）；保管区缓存/持久化 DEK 同步清空
   *  注意：security.value 不在此清空 — 锁定态下 LockScreen 仍需枚举 kekSources 渲染
   *  解锁按钮（passkey/DPAPI 静默解锁），security 本身不包含敏感运行时数据。
   *  R6②：清理账目收敛为「encryption.lockWindow() 复位一个会话对象 + bag/mergeConflicts
   *  两类单例清空」——bag.clear() 内含会话口令清空（与保管区同生命周期） */
  function lock(): void {
    encryption.lockWindow()
    bagStore.clear() // 保管区缓存与 DEK 同生命周期：锁定即清（密文仍留盘，解锁后重装载）
    conflicts.clear() // 冲突记录含整条目秘密：与保管区同生命周期，锁定清空（盘上密文留待解锁重装载）
    void opts.dekPersist?.clear() // 持久化 DEK 必清（设计 §1：锁=丢弃 DEK，含宿主会话存储）
    replaceVault(createVault())
    opts.onLocked?.() // 宿主锁定联动（desktop：清 Rust DEK 暂存槽；末尾调用=内存态已全部清毕）
  }

  return {
    vault, settings, initStore, registerStorageSync, commit, commitSettings,
    locked: encryption.locked, hasEncryption: encryption.hasEncryption,
    unlock: encryption.unlock, lock,
    enableEncryption: encryption.enableEncryption, disableEncryption: encryption.disableEncryption,
    changePassphrase: encryption.changePassphrase,
    /** security settings 只读缓存（锁定态非 null；宿主/组件读 kekSources 判定解锁方式） */
    securitySettings: encryption.security,
    /** 已绑定 prf 来源（credentialId+salt） */
    prfSources: encryption.prfSources,
    /** 已绑定 dpapi 来源（wrappedDekD） */
    dpapiSource: encryption.dpapiSource,
    /** 会话备份口令只读视图（随保管区密文落盘；锁定清空、解锁自动装载） */
    backupSecret: encryption.backupSecret,
    /** 保管区是否已存备份口令（bag.backupPassword 非空；与 backupSecret 组合出三态：未设置/会话内已启用/已存入保管区） */
    bagStored: bagStore.bagStored,
    /** 保管区凭据只读镜像（sourceId → CloudCred；锁定清空，解锁自动装载；写走 saveSourceCredOp/removeSourceCredOp） */
    credsCache: bagStore.credsCache,
    /** 条目级合并冲突记录（spec §3/§4；解锁自动装载、锁定清空；追加走 addMergeConflictsOp，
     *  裁决走 resolveMergeConflictOp） */
    mergeConflicts: conflicts.conflicts,
    /** 未裁决合并冲突计数（badge/横幅源） */
    conflictCount: conflicts.count,
    /** DEK seal 助手（spec §1.2 静态保护：syncState.baseSnapshot/mergeConflicts 等秘密载体落盘）：
     *  未启用加密返回 null（宿主按明文回落）；加密启用但锁定抛 'vault locked'（在途锁定不得明文
     *  落盘，宿主让落盘整体失败按下轮重做处理） */
    sealWithDek: encryption.sealWithDek, unsealWithDek: encryption.unsealWithDek,
    /** 合并冲突追加（runner onMergeConflicts 桥）/落盘/裁决（T11 冲突列表消费） */
    addMergeConflictsOp: conflicts.add, saveMergeConflictsOp: conflicts.save,
    resolveMergeConflictOp: conflicts.resolve,
    /** 远端保管区变更重读（审查 I7）：解锁态从盘重读前进内存视图；锁定/无 DEK 忽略。宿主 registerSync 透传 secretBag 键时由 registerStorageSync 自动调用 */
    reloadBagFromDisk: bagStore.reloadFromDisk,
    setBackupSecret: bagStore.setBackupSecret, forgetBackupSecret: bagStore.forgetBackupSecret,
    /** 保存/移除源云凭据入保管区（解锁+加密守护，密封写盘） */
    saveSourceCredOp: bagStore.saveSourceCredOp, removeSourceCredOp: bagStore.removeSourceCredOp,
    /** 遗留迁移：旧 vault.backupSecret → 保管区并从密文剥除（幂等；解锁态宿主调一次） */
    migrateLegacySecrets: bagStore.migrateLegacySecrets,
    /** 当前解锁态持有的 DEK（DPAPI 启用包装用；锁定/未启用为 null） */
    getCurrentDek: encryption.getCurrentDek,
    unlockWithDek: encryption.unlockWithDek,
    addPrfSourceOp: encryption.addPrfSourceOp, removePrfSourceOp: encryption.removePrfSourceOp,
    addDpapiSourceOp: encryption.addDpapiSourceOp, removeDpapiSourceOp: encryption.removeDpapiSourceOp,
    addEntryOp: (entry: OtpEntry) => commit((v) => addEntry(v, entry)),
    updateEntryOp: (uuid: string, patch: Partial<Omit<OtpEntry, 'uuid'>>) => commit((v) => updateEntry(v, uuid, patch)),
    removeEntryOp: (uuid: string) => commit((v) => removeEntry(v, uuid)),
    /** ④B 批量删除：单 commit 原子落盘（多选删除不走循环 removeEntryOp） */
    removeEntriesOp: (uuids: string[]) => commit((v) => removeEntries(v, uuids)),
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
