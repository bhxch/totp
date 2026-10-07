import {
  SECRET_BAG_KEY, SECURITY_KEY, SECURITY_PENDING_KEY, VAULT_KEY, addPrfSource, bytesToBase64,
  changeVaultPassphrase, createVault, decryptVaultWithDek, encryptVaultWithDek, isEncryptedVault,
  isSecuritySettings, kekSourcesOf, removeKekSource, setupVaultEncryption, unlockVaultEncryption, withAbeSource, withDpapiSource,
  type EncryptedVault, type KdfProfile, type KekSource, type SecuritySettings, type StorageAdapter, type Vault,
} from '@totp/core'
import { computed, ref, type Ref } from 'vue'
import type { ConflictLedger } from './conflictLedger'
import type { SecretBagStore } from './secretBagStore'

export interface EncryptionSessionDeps {
  adapter: StorageAdapter
  /** 窗口标识：spec §7 末尾要求窗口独立解锁——DEK/locked 按 windowId 索引 */
  windowId: string
  /** DEK 持久化（设计 §1 锁定策略·重启即锁）：宿主提供会话级存取；缺省=不持久化（desktop 内存级） */
  dekPersist?: { get(): Promise<string | null>; set(dek: Uint8Array): Promise<void>; clear(): Promise<void> }
  /** DEK 前进回调（① mini 跟随主窗解锁）：applyDekAndUnlock 成功、enableEncryption 成功、
   *  changePassphrase(rotateDek=true) 提交三个 DEK 前进点在确认未被锁定代数中止后触发 */
  onUnlock?: () => void
  /** 提交队列：enable/disable/改口令/KEK 来源 op 与 vault/settings 写同队列串行 */
  enqueue: <T>(task: () => Promise<T>) => Promise<T>
  /** 自写抑制窗口（与主层三通道共享对象）：security 键写入复用 vault 通道自写窗口
   *  （storage onChanged 无 security 通道） */
  selfWrite: { vault: number; settings: number; bag: number }
  /** 保管区：解锁自动装载/前进，关加密与远端禁加密丢弃，轮换改口令重封 */
  bag: SecretBagStore
  /** 合并冲突账本：解锁后重装载（记录含整条目秘密，锁定已清） */
  conflicts: ConflictLedger
  /** vault 明文 I/O 侧（主层）：读盘原文/替换内存态/序列化内存态/明文直写 */
  vaultIo: {
    readRaw(): Promise<unknown>
    replace(v: Vault): void
    /** 序列化内存 vault（P5 裁定：直接序列化响应式对象，避免 raw target 与 reactive 视图不一致） */
    json(): string
    /** 明文直写（disableEncryption 回明文路径；加密分支写盘在主层 saveVaultToAdapter） */
    savePlain(): Promise<void>
  }
  /** 解密 + 回滚守卫 + 解析（F8 水位语义主层单点） */
  decryptGuardedVault(dek: Uint8Array, enc: EncryptedVault): Promise<Vault>
  /** 采纳/保存成功后推进 rev 水位（F8） */
  advanceVaultRevWatermark(dek: Uint8Array, loaded: Vault): Promise<void>
  /** 从盘读 SECURITY_KEY（unlockWithDek 缓存缺失补读/远端对齐） */
  readSecurity(): Promise<SecuritySettings | null>
}

/** 加密会话子工厂（R6③ 拆分）：security 数据缓存（盘上唯一真相，所有窗口共享）+ 按 windowId
 *  隔离的解锁态会话（DEK/locked/会话口令，spec §7「窗口独立解锁」）+ KEK 来源安全写协议
 *  （R6① mutateSecurityOp）+ 加密启用/关闭/改口令/口令与 PRF/DPAPI 解锁全流程 + DEK seal 助手。
 *  装配序注意：deps.bag/deps.conflicts 由 store.ts 先建、deps 内方法经闭包延迟回指本会话 */
export function createEncryptionSession(deps: EncryptionSessionDeps) {
  const { adapter, windowId, enqueue, selfWrite, bag, conflicts, vaultIo } = deps

  // 锁定代数（F1+F7）：lock() 同步执行、不入写队列（清 DEK/内存 vault），可能与在途 commit
  // 及加密/解锁续延交叉。commit 与各长耗时流程在入口捕获代数，关键 await 后经
  // ensureNotLockedSince / 内联复查——代数已变即锁定发生在途：在途写盘中止（否则 DEK 已清的续延
  // 会把被清空的空库明文覆盖写到盘上密文位置）；进行中的续延中止（否则会把 DEK 重挂回内存/
  // 宿主会话存储并翻回解锁态，锁定被窗口击穿）
  let lockGeneration = 0

  // 加密态按 windowId 隔离：security 是数据（盘上唯一真相），所有窗口共享；dek/locked 是解锁态，
  // 按 windowId 索引。R6②：原 5 个按 windowId 平行 Map 承载同一「窗口会话」概念，成对更新
  // 不变量全靠纪律，收敛为一格一个会话对象
  interface WindowSession {
    dek: Uint8Array | null
    locked: boolean
    /** 显式标注 Ref<boolean>：不可写 ReturnType<typeof ref<boolean>>——ref 的无参重载使该类型
     *  解析为 Ref<boolean | undefined>，污染 locked/backupSecret 联合（宿主 SecurityPlatform 等接口
     *  要求非 undefined，vue-tsc 接入后连爆 6 处） */
    lockedRef: Ref<boolean>
    /** 会话备份口令（设计 D1）：与 dek 同级、同生命周期——lock 清空、解锁自动装载 */
    backupSecret: string | null
    backupSecretRef: Ref<string | null>
  }
  /** 会话对象工厂（R6②）：解锁态三元组与驱动视图的两枚 ref 同源创建，成对更新不变量内聚 */
  function createWindowSession(): WindowSession {
    return { dek: null, locked: false, lockedRef: ref(false), backupSecret: null, backupSecretRef: ref<string | null>(null) }
  }
  const sessions = new Map<string, WindowSession>()
  /** 取本窗口会话：windowId 为闭包常量，工厂初始化时即注册（见下），仅取用 */
  function sessionOf(id: string): WindowSession {
    return sessions.get(id)!
  }
  // 初始 unlocked（与原 ref(false) 语义对齐）：明文 vault/未启用加密场景下默认解锁；
  // 加密态在 initStore 阶段根据 vault 密文判定 locked=true
  sessions.set(windowId, createWindowSession())

  const security = ref<SecuritySettings | null>(null)
  const locked = computed(() => sessionOf(windowId).lockedRef.value)
  const hasEncryption = computed(() => security.value !== null)
  /** 会话备份口令只读视图（存取走 setSessionBackupSecret/保管区 setBackupSecret） */
  const backupSecret = computed(() => sessionOf(windowId).backupSecretRef.value)

  /** F7 不变量复查：传入流程入口捕获的 lockGeneration，当前代数已前进（期间 lock() 已发生）即抛错，
   *  令加密/解锁续延在前进任何内存/盘上状态前中止；调用方（SecurityCard/LockScreen 的 catch）原样展示 */
  function ensureNotLockedSince(gen: number): void {
    if (lockGeneration !== gen) throw new Error('vault locked during operation')
  }

  /** 置/清会话备份口令（会话对象双字段同写，两条解锁/锁定路径共用的唯一入口） */
  function setSessionBackupSecret(secret: string | null): void {
    const s = sessionOf(windowId)
    s.backupSecret = secret
    s.backupSecretRef.value = secret
  }

  /** 会话锁定位翻转（locked 布尔 + 驱动视图 ref 成对同写；initStore 分支用） */
  function setWindowLocked(value: boolean): void {
    const s = sessionOf(windowId)
    s.locked = value
    s.lockedRef.value = value
  }

  /** DEK 前进汇聚点回调（① mini 跟随主窗解锁）：unlock 汇聚（applyDekAndUnlock 尾部）与
   *  enableEncryption / changePassphrase(rotateDek=true) 两个绕过 unlock 汇聚的 DEK 前进点共用——
   *  宿主（desktop 主窗）经此把最新 DEK 同步进 mini 槽。I1 审查修复（2026-10-01）：此前两前进点
   *  不触发，槽中残留旧 DEK 或无 DEK，mini 聚焦重建锁定而主窗解锁（换库场景 GCM 解密失败），
   *  击穿「主窗解锁态下 mini 聚焦可用」跟随语义。调用方须先确认未被锁定代数中止（DEK 已确实前进） */
  function notifyDekAdvanced(): void {
    deps.onUnlock?.()
  }

  /** 持有 DEK 并退出锁定（enable/口令与 PRF/DPAPI 解锁汇合点）；「解锁必写」持久化随行
   *  （设计 §1 重启即锁：解锁成功即写宿主会话存储，extension=chrome.storage.session base64） */
  function adoptDek(key: Uint8Array): void {
    const s = sessionOf(windowId)
    s.dek = key
    setWindowLocked(false)
    void deps.dekPersist?.set(key)
  }

  /** 丢弃 DEK 并保持解锁（关加密/远端已禁加密跟随路径）；丢 DEK 必清 persist
   *  （T7 审查 R2 对称语义） */
  function dropDek(): void {
    const s = sessionOf(windowId)
    s.dek = null
    void deps.dekPersist?.clear()
    setWindowLocked(false)
  }

  /** 远端已禁加密（saveVaultToAdapter 对称核对分支）：丢弃本窗口加密态——security 缓存与 DEK
   *  同清、保管区缓存/会话口令一并丢弃（保管区键已被远端删除，密文不可解）、保持解锁跟随远端 */
  function forgetEncryption(): void {
    security.value = null
    dropDek()
    bag.clear()
  }

  /** 本窗口会话复位（lock() 的会话段）：代数前进 + 丢弃 DEK + 翻锁定位。R6② 清理账目收敛——
   *  原「4 条途径清 5 Map」并为「清一个会话对象」；会话口令由 bag.clear()（与保管区同清） */
  function lockWindow(): void {
    lockGeneration++ // F1+F7：代数单调前进——在途 commit 落盘写与加密/解锁续延在下一复查点即中止
    const s = sessionOf(windowId)
    s.dek = null
    setWindowLocked(true)
  }

  function isLocked(): boolean {
    return sessionOf(windowId).locked
  }

  function hasDek(): boolean {
    return sessionOf(windowId).dek !== null
  }

  /** 当前解锁态持有的 DEK（锁定/未启用返回 null） */
  function getCurrentDek(): Uint8Array | null {
    return sessionOf(windowId).dek ?? null
  }

  // ---- DEK seal 助手（Task 9/10：spec §1.2 静态保护 + §3 冲突记录 + §4 裁决）----
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
    const dek = sessionOf(windowId).dek
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
    const dek = sessionOf(windowId).dek
    if (!dek) throw new Error('vault locked')
    try {
      return await decryptVaultWithDek(dek, JSON.parse(sealed) as EncryptedVault)
    } catch {
      return null
    }
  }

  /** KEK 来源 op 统一安全写协议（R6①）：队列串行 → 锁定/未启用双守卫 → transform 求新
   *  security → 内存缓存前进 → 自写窗口 → SECURITY_KEY 落盘。原 4 个 op（prf/dpapi 各
   *  增/删）逐行近同、仅 transform 一行不同，收敛后新增来源类型只写 transform。
   *  needDek：绑定类 op 的 transform 需解包用 DEK（core 重包裹 DEK 本体），守卫要求
   *  「security 与 DEK 双在」；移除类 op 不触碰 DEK，守卫止步于 security（与原实现一致，
   *  锁定态由前一条 'vault locked' 守卫先行拒绝） */
  function mutateSecurityOp(
    needDek: boolean,
    transform: (s: SecuritySettings, dek: Uint8Array) => SecuritySettings | Promise<SecuritySettings>,
  ): Promise<void> {
    return enqueue(async () => {
      if (isLocked()) throw new Error('vault locked')
      if (!security.value || (needDek && !getCurrentDek())) throw new Error('encryption not enabled')
      security.value = await transform(security.value, getCurrentDek()!)
      // security 键写入复用 vault 自写窗口抑制（onChanged 无 security 通道，与 changePassphrase 一致）
      selfWrite.vault = Date.now()
      await adapter.set(SECURITY_KEY, JSON.stringify(security.value))
    })
  }

  /** 绑定 passkey 解锁（已解锁态）：salt 由调用方生成并在创建凭据时用于 PRF 求值，
   *  prfOutput 为该盐的权威求值输出——同盐可复现，构成绑定语义。
   *  core addPrfSource 重包裹 DEK（同 credentialId 替换语义）→ security 经队列写盘 */
  function addPrfSourceOp(credentialId: string, prfOutput: Uint8Array, salt: Uint8Array): Promise<void> {
    return mutateSecurityOp(true, (s, dek) => addPrfSource(s, dek, credentialId, prfOutput, bytesToBase64(salt)))
  }

  /** 移除指定 passkey 解锁来源（core 守卫：移除后无任何来源时抛「至少保留一种解锁方式」） */
  function removePrfSourceOp(credentialId: string): Promise<void> {
    return mutateSecurityOp(false, (s) => removeKekSource(s, 'prf', { credentialId }))
  }

  /** 绑定 DPAPI 解锁来源（已解锁态）：wrappedDekD 为宿主 DPAPI 包装的 DEK（base64；T1 裁定直接包裹 DEK 本体） */
  function addDpapiSourceOp(wrappedDekD: string): Promise<void> {
    return mutateSecurityOp(true, (s) => withDpapiSource(s, wrappedDekD))
  }

  /** 移除 DPAPI 解锁来源（core 守卫：移除后无任何来源时抛「至少保留一种解锁方式」） */
  function removeDpapiSourceOp(): Promise<void> {
    return mutateSecurityOp(false, (s) => removeKekSource(s, 'dpapi'))
  }

  /** 绑定 ABE 提权服务解锁来源（恒单份标记源，无 DEK 参与——密文由服务侧重包裹存 HKLM，
   *  security.json 只记录来源存在，故守卫止步 security；绑定动作由 Task 6 UI 在 abe.bind()
   *  成功后编排调用） */
  function addAbeSourceOp(): Promise<void> {
    return mutateSecurityOp(false, (s) => withAbeSource(s))
  }

  /** 移除 ABE 解锁来源（core 守卫：移除后无任何来源时抛「至少保留一种解锁方式」） */
  function removeAbeSourceOp(): Promise<void> {
    return mutateSecurityOp(false, (s) => removeKekSource(s, 'abe'))
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
      if (isLocked()) throw new Error('vault locked')
      const gen = lockGeneration
      // 不用 toRaw：直接序列化响应式对象（P5 裁定，避免 raw target 与 reactive 视图不一致）
      const r = await setupVaultEncryption(vaultIo.json(), password)
      ensureNotLockedSince(gen)
      // 先写 security 后写密文：中途崩溃最多出现「security 在但 vault 仍明文」，数据不丢
      selfWrite.vault = Date.now() // security 键写入复用 vault 自写窗口抑制（onChanged 无 security 通道）
      await adapter.set(SECURITY_KEY, JSON.stringify(r.security))
      ensureNotLockedSince(gen)
      selfWrite.vault = Date.now()
      await adapter.set(VAULT_KEY, JSON.stringify(r.encrypted))
      ensureNotLockedSince(gen)
      security.value = r.security
      adoptDek(r.dek)
      notifyDekAdvanced() // ① DEK 前进同步 mini 槽（I1）：末次 ensureNotLockedSince 已过，此后同步段无中止点
    })
  }

  /** 关闭加密：需已解锁 → 内存明文写回 vault → 删 security 与保管区键 → 本窗口丢弃 DEK（经 commit 队列，与写 op 串行） */
  function disableEncryption(): Promise<void> {
    return enqueue(async () => {
      if (isLocked()) throw new Error('vault locked')
      if (!security.value || !getCurrentDek()) throw new Error('encryption not enabled')
      // 保管区随加密一起退役（设计 §1：明文库无 DEK 可解）：删设备侧键 + 清缓存；会话口令同清（D1 语义反转后口令只存保管区）
      selfWrite.bag = Date.now() // 删除路径对称开自写窗口（审查修复）：本端删除的 storage 回声不触发 reloadFromDisk
      await adapter.delete(SECRET_BAG_KEY)
      bag.clear()
      selfWrite.vault = Date.now()
      await vaultIo.savePlain()
      await adapter.delete(SECURITY_KEY)
      // F12：staged 轮换的 PENDING 暂存随加密一并退役（残留为死数据：明文库语义下 unlock 恢复路径
      // 的 GCM 证明使其永远无法被转正或误解锁）。删除尽力而为，不阻断关闭——失败时残留 PENDING
      // 由成功口令解锁的孤儿清理或下次 staged 轮换的覆写收尾
      await adapter.delete(SECURITY_PENDING_KEY).catch(() => {})
      security.value = null
      dropDek()
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
      if (isLocked()) throw new Error('vault locked')
      if (!security.value || !getCurrentDek()) throw new Error('encryption not enabled')
      // rotateDek 缺省 true（设计 §2 裁定改口令即被动轮换）；显式传 undefined 也不得静默关闭轮换
      // （审查 Minor：{ rotateDek: true, ...changeOpts } 展开顺序会让显式 undefined 覆盖默认值）
      const gen = lockGeneration
      const r = await changeVaultPassphrase(security.value, getCurrentDek()!, newPassword, { ...changeOpts, rotateDek: changeOpts.rotateDek ?? true })
      ensureNotLockedSince(gen)
      if (r.dek) {
        // F7：盘写序起点同步捕获保管区快照（至盘写序内各调用显式传入，杜绝锁定清空 bag 后把空保管区封盘）
        const bagSnapshot = bag.snapshot()
        // staged ① 暂存：新 wrappedDek 先落 PENDING。失败则盘上未动，完整旧态，重试自愈
        await adapter.set(SECURITY_PENDING_KEY, JSON.stringify(r.security))
        try {
          // staged ② 全库重加密（新 DEK）。仅此步失败才清 PENDING：vault 未被改写，旧 SECURITY_KEY
          // 完整有效，PENDING 已成孤儿（其新 DEK 与盘上旧 DEK vault 过不了 GCM 证明），清除即完整回滚
          selfWrite.vault = Date.now()
          await adapter.set(VAULT_KEY, JSON.stringify(await encryptVaultWithDek(r.dek, vaultIo.json())))
        } catch (e) {
          await adapter.delete(SECURITY_PENDING_KEY).catch(() => {})
          throw e
        }
        // staged ③ 自此盘上 vault 已是新 DEK 密文：其后任何失败都必须保留 PENDING（它是新口令经
        // unlock 恢复路径补完轮换的唯一依据），清了即成 F12 锁死态。保管区重封须在转正前——
        // 否则转正后旧 DEK 内存态的后续 commit 会以旧 DEK 重写 vault + 新 SECURITY_KEY，再造锁死
        await bag.sealToDisk(r.dek, bagSnapshot) // 保管区重封（新 DEK 写盘前会话 dek 尚未前进，显式传入快照防锁定清空）
        // staged ④ 转正（提交点）：SECURITY_KEY ← 新 wrappedDek。此写失败 PENDING 自然保留
        // （中间态可达恢复路径）；成功后 PENDING 残留与 SECURITY_KEY 同内容已无害，删除尽力而为，
        // 失败由下次成功口令解锁的孤儿清理兜底
        selfWrite.vault = Date.now()
        await adapter.set(SECURITY_KEY, JSON.stringify(r.security))
        await adapter.delete(SECURITY_PENDING_KEY).catch(() => {})
        // staged ⑤（F7 裁决）全部盘写成功后才按代数前进内存：期间 lock() 已发生（代数前进）→
        // 保持锁定，不重挂 DEK、不写持久化、security 缓存保持旧值（旧口令主路径解锁仍成立，
        // 新口令经 PENDING 恢复路径补完）
        if (lockGeneration === gen) {
          sessionOf(windowId).dek = r.dek
          void deps.dekPersist?.set(r.dek)
          security.value = r.security
          notifyDekAdvanced() // ① DEK 轮换前进同步 mini 槽（I1）：槽中旧 DEK 已失效，mini 聚焦重建会 GCM 解密失败
        }
      } else {
        // rotateDek=false 仅重包裹（DEK 不变，vault/bag 无需重写），security 落盘作唯一提交点（原语义不变）
        security.value = r.security
        selfWrite.vault = Date.now()
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
    const parsed = await vaultIo.readRaw()
    if (!isEncryptedVault(parsed)) throw primaryErr // vault 明文/缺失：旧态完整，无需也不得转正
    try {
      await decryptVaultWithDek(dek, parsed) // GCM 证明：PENDING 的 DEK 确能解开现有 vault
    } catch {
      throw primaryErr // 证明失败（陈旧/异体 PENDING）：拒绝转正，防植入 PENDING 借机夺权
    }
    selfWrite.vault = Date.now() // security 键写入复用 vault 自写窗口抑制（onChanged 无 security 通道）
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
    const parsed = await vaultIo.readRaw()
    ensureNotLockedSince(gen)
    let loaded: Vault
    if (isEncryptedVault(parsed)) {
      loaded = await deps.decryptGuardedVault(key, parsed) // F8：回滚密文在此拒绝（抛 VaultRollbackError，锁定态不前进）
      ensureNotLockedSince(gen) // F7：解密 await 窗口内 lock() 已发生即中止（不装填旧内容、不前进）
    } else {
      loaded = parsed !== null ? (parsed as Vault) : createVault()
    }
    // 可能失败的副步骤（保管区装载，失败按空保管区回落）先完成，再一次性前进全部内存态
    // （bag/会话口令 → vault → 持 DEK → 退出锁定）：消除「locked=true 但内存持明文+DEK」瞬态窗口（T7 审查 R1）
    const loadedBag = await bag.loadFromDisk(key)
    ensureNotLockedSince(gen)
    bag.advance(loadedBag) // 解锁自动装载保管区（password 与 unlockWithDek/PRF 两条路径均汇于此）
    vaultIo.replace(loaded)
    await deps.advanceVaultRevWatermark(key, loaded)
    adoptDek(key)
    // ① 解锁汇聚点回调（口令/unlockWithDek/initStore 恢复三路均经此；desktop 宿主经此同步 mini 窗）。
    // M4 审查修复（2026-10-01）：置于 conflicts.reload 之前——adoptDek 完成即解锁态确立，
    // reload 抛错不得吞掉回调（否则 mini 槽不同步，且失败方向为「主窗解锁 mini 锁定」的滞留态）
    notifyDekAdvanced()
    // 合并冲突记录随解锁重装载（记录含整条目秘密，锁定已清）
    await conflicts.reload()
  }

  /** passkey 解锁第二跳：外部经 core unlockWithPrf 解出 DEK 后注入。
   *  security 缓存缺失（跨窗口陈旧/未 initStore）时从盘补读，保证后续加密写路径可用。
   *  F7：代数在入口捕获（readSecurity 补读 await 之前），补读窗口内的 lock() 同样被复查拦截 */
  async function unlockWithDek(key: Uint8Array): Promise<void> {
    const gen = lockGeneration
    if (!security.value) security.value = await deps.readSecurity()
    if (!security.value) throw new Error('encryption not enabled')
    // C1：调用方应保证 DEK 长度 32B；core unlockWithPrf 已加校验，此处再校验一次防 caller 跳过 core 直接注入
    if (key.length !== 32) throw new Error('invalid DEK length from PRF unwrap')
    await applyDekAndUnlock(key, gen)
  }

  /** 已绑定的 passkey(PRF) 解锁来源视图（LockScreen 渲染按钮 / SecurityCard 列表用） */
  const prfSources = computed(() => {
    const s = security.value
    if (!s) return []
    return kekSourcesOf(s)
      .filter((src): src is Extract<KekSource, { kind: 'prf' }> => src.kind === 'prf')
      .map((src) => ({ credentialId: src.credentialId, salt: src.salt }))
  })

  /** 已绑定的 DPAPI 解锁来源视图（至多一个；锁定态仍可见——LockScreen 静默解锁判定用；
   *  App.vue dpapiOps.source 消费。曾有 boolean 别名 hasDpapiSource，全仓零引用已删除） */
  const dpapiSource = computed(() => {
    const s = security.value
    if (!s) return null
    const src = kekSourcesOf(s).find((x): x is Extract<KekSource, { kind: 'dpapi' }> => x.kind === 'dpapi')
    return src ? { wrappedDekD: src.wrappedDekD } : null
  })

  /** 已绑定的 ABE 提权服务解锁来源视图（至多一个标记源，无载荷——密文在服务 HKLM；null=未启用。
   *  锁定态仍可见——Task 7 LockScreen 静默解锁判定用；abe 源存在与否即「已启用 ABE」（plan p6 §0.3） */
  const abeSource = computed(() => {
    const s = security.value
    if (!s) return null
    return kekSourcesOf(s).some((x) => x.kind === 'abe') ? { kind: 'abe' as const } : null
  })

  return {
    security, locked, hasEncryption, backupSecret, prfSources, dpapiSource, abeSource,
    /** F1+F7：主层 commit/saveVaultToAdapter 每次落盘 await 后读取代数复查 */
    get generation() {
      return lockGeneration
    },
    ensureNotLockedSince, setSessionBackupSecret, setWindowLocked,
    isLocked, hasDek, getCurrentDek,
    adoptDek, dropDek, forgetEncryption, lockWindow,
    sealWithDek: sealWithDekOp, unsealWithDek: unsealWithDekOp,
    enableEncryption, disableEncryption, changePassphrase,
    unlock, unlockWithDek, applyDekAndUnlock,
    addPrfSourceOp, removePrfSourceOp, addDpapiSourceOp, removeDpapiSourceOp,
    addAbeSourceOp, removeAbeSourceOp,
  }
}

export type EncryptionSession = ReturnType<typeof createEncryptionSession>
