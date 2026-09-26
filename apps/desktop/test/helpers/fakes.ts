/**
 * desktop 测试共享 fake 工厂（P4 / P2b 审查建议的 desktop 侧落地）：平台工厂直测用的
 * store/adapter 替身收敛于此，避免逐测试文件漂移。
 * - fakeStore：形状完整的 VueStore 替身（shallowRef 约束：成员保持真 ref 语义，勿整体 reactive 包装，
 *   storeWrap 9 例实证）；sealWithDek 等安全面可按用例覆写（revSeal 三态/锁定拒落明文）。
 * - memoryAdapter：core createMemoryStorage 预置种子的 StorageAdapter（backupSources 等 AppData 键）。
 */
import { reactive, ref, computed } from 'vue'
import { vi } from 'vitest'
import { DEFAULT_SETTINGS, createMemoryStorage, type StorageAdapter } from '@totp/core'
import type { VueStore } from '@totp/ui'

/** 形状完整防 TypeError 假绿的 store 替身；overrides 深合并仅一层（用于覆写 sealWithDek 等）。
 *  返回 any：测试侧需直达 vi.fn mock 通道（mock.calls/mockReturnValue 与只读 ref 赋值），
 *  被测工厂经 deps 参数消费时仍满足 VueStore 结构（any 可赋值）。 */
export function fakeStore(overrides: Record<string, unknown> = {}): any {
  const s = {
    settings: reactive({ ...DEFAULT_SETTINGS }),
    vault: reactive({ version: 2, entries: [], tags: [], updatedAt: 0 }),
    locked: ref(false),
    hasEncryption: computed(() => false),
    backupSecret: ref<string | null>(null),
    credsCache: ref<Record<string, never>>({}),
    securitySettings: ref<{ profile?: string; passwordChangedAt?: number } | null>(null),
    prfSources: ref<Array<{ credentialId: string }>>([]),
    dpapiSource: ref<{ wrappedDekD: string } | null>(null),
    conflictCount: ref(0),
    initStore: vi.fn(async () => {}),
    commitSettings: vi.fn(async () => {}),
    lock: vi.fn(),
    enableEncryption: vi.fn(async () => {}),
    disableEncryption: vi.fn(async () => {}),
    changePassphrase: vi.fn(async () => {}),
    replaceAllOp: vi.fn(async () => {}),
    saveSourceCredOp: vi.fn(async () => {}),
    removeSourceCredOp: vi.fn(async () => {}),
    addMergeConflictsOp: vi.fn(async () => {}),
    migrateLegacySecrets: vi.fn(async () => {}),
    addDpapiSourceOp: vi.fn(async () => {}),
    removeDpapiSourceOp: vi.fn(async () => {}),
    addPrfSourceOp: vi.fn(async () => {}),
    removePrfSourceOp: vi.fn(async () => {}),
    getCurrentDek: vi.fn((): Uint8Array | null => null),
    sealWithDek: vi.fn(async (): Promise<string | null> => null),
    unsealWithDek: vi.fn(async (): Promise<string | null> => null),
    ...overrides,
  }
  return s as never
}

/** 预置键值种子的内存 adapter（种子=已序列化的 AppData JSON 键值） */
export function memoryAdapter(seed: Record<string, string> = {}): StorageAdapter {
  const adapter = createMemoryStorage()
  for (const [k, v] of Object.entries(seed)) void adapter.set(k, v)
  return adapter
}

/** 壳层 tr 的可断言替身：键名原样返回（注入 desktopXxx 工厂的 tr 形状） */
export const echoTr = (key: string, params?: Record<string, unknown>): string =>
  params && Object.keys(params).length ? `${key}?${JSON.stringify(params)}` : key
