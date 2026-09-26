import {
  MERGE_CONFLICTS_MAX, loadMergeConflicts, saveMergeConflicts,
  type EntryConflict, type Seal, type StorageAdapter, type Vault,
} from '@totp/core'
import { computed, ref } from 'vue'

export interface ConflictLedgerDeps {
  adapter: StorageAdapter
  /** 本窗口锁定态（getter，延迟解析——装配序：ledger 先建、加密会话后建）：锁定态不装载不持明文 */
  isLocked(): boolean
  /** 加密会话的 DEK seal 通道（sealWithDek/unsealWithDek 两态语义：未启用加密 null 回落、锁定抛 'vault locked'） */
  sealWithDek(plain: string): Promise<string | null>
  unsealWithDek(sealed: string): Promise<string | null>
  /** 裁决写走主提交队列（自动推进 vault.rev 并触发常规同步） */
  commit(fn: (v: Vault) => Vault): Promise<void>
  /** 裁决成功后的未裁决计数回调（extension 桥到持久计数键 + action badge 即时对账；不传零行为） */
  onConflictCountChanged?: (count: number) => void
}

/** 合并冲突记录账本子工厂（R6③ 拆分；spec §3/§4）：runner 同步产出经宿主 addMergeConflictsOp 入库，
 *  裁决走 resolveMergeConflictOp。记录含整条目秘密，随 DEK seal 落盘、锁定清空、解锁重装载
 *  （与保管区同生命周期）；baseSnapshot（SourceSyncState）同保护级由宿主把加密会话的
 *  sealWithDek/unsealWithDek 接进 core loadSyncState/saveSyncState 的 Seal 参数 */
export function createConflictLedger(deps: ConflictLedgerDeps) {
  const { adapter, commit } = deps
  /** 条目级合并冲突记录（spec §3/§4）：宿主 runner onMergeConflicts 桥入库 */
  const conflicts = ref<EntryConflict[]>([])
  /** 未裁决合并冲突计数（冲突 badge/横幅源；0=全部裁决或无冲突，提示随之清除） */
  const count = computed(() => conflicts.value.length)

  /** 冲突记录通道的 Seal 装配（load/save 共用）：未启用加密 null 回落原文/明文；锁定抛
   *  'vault locked'（load 侧由 core 捕获回落空列表，save 侧整体失败交调用方按下轮重做处理） */
  function sealFor(): Seal {
    return {
      seal: async (plain) => (await deps.sealWithDek(plain)) ?? plain,
      unseal: async (sealed) => (await deps.unsealWithDek(sealed)) ?? sealed,
    }
  }

  /** 从盘装载合并冲突记录（解锁路径汇合点调用）：锁定态不装载不持明文（记录含整条目秘密）；
   *  损坏/换 DEK 回落空列表（core 内部兜底） */
  async function reload(): Promise<void> {
    if (deps.isLocked()) {
      conflicts.value = []
      return
    }
    try {
      conflicts.value = await loadMergeConflicts(adapter, sealFor())
    } catch {
      conflicts.value = []
    }
  }

  /** 追加合并冲突（宿主 runner onMergeConflicts 桥）：同 entryId 以新记录替换（最新胜），
   *  超上限裁最旧（与 core saveMergeConflicts 的上限语义一致，内存视图同步裁剪） */
  async function add(incoming: EntryConflict[]): Promise<void> {
    if (incoming.length === 0) return
    const map = new Map(conflicts.value.map((c) => [c.entryId, c]))
    for (const c of incoming) map.set(c.entryId, c)
    const list = [...map.values()]
    conflicts.value = list.length > MERGE_CONFLICTS_MAX ? list.slice(list.length - MERGE_CONFLICTS_MAX) : list
    await save()
  }

  /** 冲突记录落盘（conflicts 变更时调用；seal 语义同 syncState） */
  async function save(): Promise<void> {
    await saveMergeConflicts(adapter, conflicts.value, sealFor())
  }

  /** 冲突裁决（spec §3/§4，T11 冲突列表消费）：pick='theirs' 以 conflict.theirs 替换条目，
   *  pick='ours' 取 conflict.ours。pick 侧为 null 即确认该侧删除 → chosen=null 删除条目（两侧
   *  语义对称：本地方已删除点「取本地方」=确认删除，与云地方已删除点「取云地方」同——旧实现
   *  的 ?? base 回退会让 base 旧版本复活，与本地方已删除标注矛盾，已移除）。写经 commit（自动
   *  推进 vault.rev 并触发常规同步），随后从列表移除并落盘。无对应记录抛错（列表 UI 不会出现
   *  该入口，防御兜底） */
  async function resolve(entryId: string, pick: 'ours' | 'theirs'): Promise<void> {
    const conflict = conflicts.value.find((c) => c.entryId === entryId)
    if (!conflict) throw new Error('合并冲突记录不存在')
    // 不变量（vaultMerge 产出侧保证）：ours 与 theirs 永不同时为 null——删/改对撞记录恰一方 null
    // （另一侧为保留的修改方，base 必非 null）；双改对撞两侧均非 null。故 pick 侧 null 即确认删除，
    // base 仅作记录不做回退源
    const chosen = pick === 'theirs' ? conflict.theirs : conflict.ours
    await commit((v) => {
      const rest = v.entries.filter((e) => e.uuid !== entryId)
      return { ...v, entries: chosen ? [...rest, chosen] : rest }
    })
    conflicts.value = conflicts.value.filter((c) => c.entryId !== entryId)
    await save()
    deps.onConflictCountChanged?.(conflicts.value.length)
  }

  /** 锁定清空（记录含整条目秘密；盘上密文留待解锁重装载） */
  function clear(): void {
    conflicts.value = []
  }

  return { conflicts, count, reload, add, save, resolve, clear }
}

export type ConflictLedger = ReturnType<typeof createConflictLedger>
