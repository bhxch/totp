export type AutoRunDecision = { action: 'run' } | { action: 'skip'; cause: 'unchanged' | 'locked' | 'no-secret' }

/** 自动备份/同步执行前判定（手动操作不经此函数，始终执行） */
export function decideAutoRun(input: {
  currentHash: string | null
  lastHash: string | null
  locked: boolean
  hasSecret: boolean
}): AutoRunDecision {
  if (input.locked) return { action: 'skip', cause: 'locked' }
  if (!input.hasSecret) return { action: 'skip', cause: 'no-secret' }
  if (input.lastHash !== null && input.lastHash === input.currentHash) return { action: 'skip', cause: 'unchanged' }
  return { action: 'run' }
}
