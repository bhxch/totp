import {
  SECRET_BAG_KEY, decryptVaultWithDek, emptyBag, isEncryptedVault, openSecretBag, sealSecretBag,
  type CloudCred, type SecretBagContent, type StorageAdapter, type Vault,
} from '@totp/core'
import { computed, ref } from 'vue'

export interface SecretBagDeps {
  adapter: StorageAdapter
  /** 保管区写 op 与 vault/settings/KEK op 同一提交队列串行 */
  enqueue: <T>(task: () => Promise<T>) => Promise<T>
  /** 自写抑制窗口（与主层三通道共享对象）：bag 写盘/删除前开自写窗口，storage 回声不重读 */
  selfWrite: { vault: number; settings: number; bag: number }
  /** 加密会话侧（getter/方法，延迟解析——装配序 bag 先于加密会话创建） */
  session: {
    /** 加密是否启用（security 缓存非 null） */
    hasEncryption(): boolean
    /** 本窗口是否锁定 */
    isLocked(): boolean
    /** 本窗口当前持有的 DEK；调用方在守卫通过后取用 */
    currentDek(): Uint8Array | null
    /** 置/清会话备份口令（会话字段+视图 ref 双写） */
    setSessionBackupSecret(secret: string | null): void
  }
  /** 从盘读 vault 原始内容（遗留迁移读旧密文） */
  readRawVault(): Promise<unknown>
  /** 主提交队列（遗留迁移尾部剥除旧字段重写密文） */
  commit(fn: (v: Vault) => Vault): Promise<void>
}

/** DEK 保管区子工厂（R6③ 拆分；设计 §1）：备份口令 + 各源云凭据随 DEK 密封落设备侧独立键，
 *  仅解锁态有效、锁定清空、解锁自动装载（与 DEK 同生命周期）。bag 明文缓存非响应式，
 *  凭据/口令两枚镜像 ref 驱动视图；写路径全部经 sealToDisk 统一出口 */
export function createSecretBagStore(deps: SecretBagDeps) {
  const { adapter, enqueue, session, selfWrite } = deps
  // 保管区当前明文缓存：备份口令 + 各源云凭据，仅解锁态有效；lock 清空
  let bag: SecretBagContent = emptyBag()
  /** bag.creds 的响应式只读镜像（组件渲染源列表凭据态用；写走 saveSourceCredOp/removeSourceCredOp） */
  const credsCache = ref<Record<string, CloudCred>>({})
  /** 保管区是否存有备份口令（bag.backupPassword 非空）：bag 本身非响应式，用镜像 ref 驱动视图 */
  const bagStoredRef = ref(false)
  const bagStored = computed(() => bagStoredRef.value)

  /** 从盘上装载保管区明文（设计 §1）：DEK 不匹配/密文损坏/IO 失败一律按空保管区回落（不阻断解锁），
   *  与新库首启（盘上尚无 secretBag 键）同语义 */
  async function loadFromDisk(dek: Uint8Array): Promise<SecretBagContent> {
    try {
      return await openSecretBag(dek, await adapter.get(SECRET_BAG_KEY))
    } catch {
      return emptyBag()
    }
  }

  /** 保管区明文前进到内存态（bag 缓存 + 会话口令 + 凭据镜像 + bagStored 视图） */
  function advance(next: SecretBagContent): void {
    bag = next
    session.setSessionBackupSecret(bag.backupPassword || null)
    credsCache.value = { ...bag.creds }
    bagStoredRef.value = bag.backupPassword !== ''
  }

  /** 保管区密封写盘统一出口（审查 I7）：记录自写窗口——本端写盘触发的 storage 回声
   *  不应触发 reloadFromDisk 重读自己刚写的内容（对齐 vault 的 lastSelfWrite 模式）。
   *  content 缺省密封当前缓存；changePassphrase 传入口捕获的快照——写序 await 期间 lock() 清空缓存
   *  也不至于把空保管区密文盖到盘上真实内容（F7 残余防护） */
  async function sealToDisk(dek: Uint8Array, content: SecretBagContent = bag): Promise<void> {
    selfWrite.bag = Date.now()
    await adapter.set(SECRET_BAG_KEY, await sealSecretBag(dek, content))
  }

  /** 远端保管区变更重读（审查 I7）：解锁态从盘重读 bag 并前进内存视图（复用 advance 路径）；
   *  锁定态忽略——bag 缓存与 DEK 同生命周期（锁定即清空），远端变更等下次解锁经
   *  applyDekAndUnlock 重装载，锁定态下消费远端 bag 会混入本窗口 DEK 解不开的密文（即使可解
   *  也是无 DEK 态持明文秘密，违背锁定语义）。无 DEK（未启用加密）同忽略 */
  async function reloadFromDisk(): Promise<void> {
    const dek = session.currentDek()
    if (session.isLocked() || !dek) return
    advance(await loadFromDisk(dek))
  }

  /** 保管区缓存与会话口令一并丢弃（lock()/disableEncryption/远端已禁加密对称路径共用）：
   *  会话口令与 bag 同生命周期（锁定即清；明文库语义下保管区退役同清） */
  function clear(): void {
    session.setSessionBackupSecret(null)
    bag = emptyBag()
    credsCache.value = {}
    bagStoredRef.value = false
  }

  /** 当前明文快照（changePassphrase staged 提交在盘写序起点捕获，防锁定清空后封空保管区） */
  function snapshot(): SecretBagContent {
    return bag
  }

  /** 设置备份口令（设计 §1）：trim 后先置会话（无论 remember）；
   *  remember=true（存入保管区）守护：未启用加密/锁定均给中文错误且不写盘（会话已置）；
   *  通过则写入保管区并随 DEK 密文落设备侧独立键（不再写 vault） */
  async function setBackupSecret(secret: string, remember: boolean): Promise<void> {
    const trimmed = secret.trim()
    if (!trimmed) throw new Error('备份口令不能为空')
    session.setSessionBackupSecret(trimmed)
    if (remember) {
      if (!session.hasEncryption()) throw new Error('需先启用加密才能记住备份口令')
      if (session.isLocked()) throw new Error('解锁后才能记住备份口令')
      bag.backupPassword = trimmed
      await sealToDisk(session.currentDek()!)
      bagStoredRef.value = true
    }
  }

  /** 清除备份口令：会话必清；解锁+加密态时同步清保管区口令字段并重封写盘（凭据保留）；
   *  未启用/锁定态保管区密文本就不可用，只清会话不报错 */
  async function forgetBackupSecret(): Promise<void> {
    session.setSessionBackupSecret(null)
    if (session.hasEncryption() && !session.isLocked()) {
      bag.backupPassword = ''
      await sealToDisk(session.currentDek()!)
      bagStoredRef.value = false
    }
  }

  /** 保存/更新指定源的云凭据入保管区（设计 §1：凭据是秘密，随 DEK 密文存放）。解锁+加密守护 */
  function saveSourceCredOp(id: string, cred: CloudCred): Promise<void> {
    return enqueue(async () => {
      if (session.isLocked()) throw new Error('vault locked')
      if (!session.hasEncryption() || !session.currentDek()) throw new Error('需先启用加密才能保存云凭据')
      bag.creds[id] = cred
      await sealToDisk(session.currentDek()!)
      credsCache.value = { ...bag.creds }
    })
  }

  /** 移除指定源的云凭据（保管区重封写盘；源元数据在 settings，不由本 op 处理）。解锁+加密守护 */
  function removeSourceCredOp(id: string): Promise<void> {
    return enqueue(async () => {
      if (session.isLocked()) throw new Error('vault locked')
      if (!session.hasEncryption() || !session.currentDek()) throw new Error('需先启用加密才能保存云凭据')
      delete bag.creds[id]
      await sealToDisk(session.currentDek()!)
      credsCache.value = { ...bag.creds }
    })
  }

  /** 遗留迁移（设计 §1）：旧 vault 密文内的 backupSecret → 写入保管区（先写新），随后剥除字段重写密文（后删旧）。
   *  幂等：盘上已无字段（或 bag 已有口令）时不重复搬运；bag 已有口令时仅剥除。
   *  遗留口令从盘上密文读（replaceVault 已不拷该字段，内存 vault 无残留）。解锁态调用（applyDekAndUnlock 后宿主调一次） */
  async function migrateLegacySecrets(): Promise<void> {
    if (!session.hasEncryption() || session.isLocked()) return
    const parsed = await deps.readRawVault()
    let legacy: unknown
    if (isEncryptedVault(parsed)) {
      legacy = (JSON.parse(await decryptVaultWithDek(session.currentDek()!, parsed)) as Record<string, unknown>).backupSecret
    } else if (parsed !== null) {
      // 「security 在但 vault 明文」半失败态的自愈路径同样剥除
      legacy = (parsed as Record<string, unknown>).backupSecret
    }
    if (typeof legacy === 'string' && legacy && !bag.backupPassword) {
      bag.backupPassword = legacy
      await sealToDisk(session.currentDek()!)
      session.setSessionBackupSecret(legacy)
      bagStoredRef.value = true
    }
    if (legacy !== undefined) {
      // 剥除落盘：浅拷贝删字段（内存 vault 本就无此字段，实质是重写盘上密文冲掉残留）
      await deps.commit((v) => {
        const n = { ...v } as Vault & { backupSecret?: string }
        delete n.backupSecret
        return n
      })
    }
  }

  return {
    credsCache, bagStored,
    loadFromDisk, advance, sealToDisk, reloadFromDisk, clear, snapshot,
    setBackupSecret, forgetBackupSecret, saveSourceCredOp, removeSourceCredOp, migrateLegacySecrets,
  }
}

export type SecretBagStore = ReturnType<typeof createSecretBagStore>
