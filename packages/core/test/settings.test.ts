import { describe, expect, it } from 'vitest'
import { createMemoryStorage } from '../src/storage/memory'
import { loadSettings, saveSettings, DEFAULT_SETTINGS, SETTINGS_KEY } from '../src/storage/vaultStore'

describe('settingsStore', () => {
  it('缺省返回默认设置', async () => {
    expect(await loadSettings(createMemoryStorage())).toEqual(DEFAULT_SETTINGS)
  })
  it('save/load 往返', async () => {
    const s = createMemoryStorage()
    await saveSettings(s, { urlFilterEnabled: false, blurHideEnabled: false, clipboardClearEnabled: false, popupCloseDelayMs: 5000, syncEnabled: true, themeMode: 'dark', themeColor: 'teal', lockOnRestart: false, lockIdleMinutes: 15, lockOnSystemLock: false, backupKdfProfile: 'fast' })
    expect(await loadSettings(s)).toEqual({ urlFilterEnabled: false, blurHideEnabled: false, clipboardClearEnabled: false, popupCloseDelayMs: 5000, syncEnabled: true, themeMode: 'dark', themeColor: 'teal', lockOnRestart: false, lockIdleMinutes: 15, lockOnSystemLock: false, backupKdfProfile: 'fast' })
  })
  it('损坏 JSON 回退默认值', async () => {
    const s = createMemoryStorage()
    await s.set(SETTINGS_KEY, '{oops')
    expect(await loadSettings(s)).toEqual(DEFAULT_SETTINGS)
  })
  it('未知字段被丢弃（只保留已知键）', async () => {
    const s = createMemoryStorage()
    await s.set(SETTINGS_KEY, JSON.stringify({ urlFilterEnabled: true, hacked: 1 }))
    expect(await loadSettings(s)).toEqual({ urlFilterEnabled: true, blurHideEnabled: false, clipboardClearEnabled: true, popupCloseDelayMs: 2000, syncEnabled: false, themeMode: 'auto', themeColor: 'blue', lockOnRestart: true, lockIdleMinutes: 0, lockOnSystemLock: true, backupKdfProfile: 'balanced' })
  })
  it('类型非法的值回退默认', async () => {
    const s = createMemoryStorage()
    await s.set(SETTINGS_KEY, JSON.stringify({ urlFilterEnabled: 'false' }))
    expect(await loadSettings(s)).toEqual(DEFAULT_SETTINGS)
  })
  it('blurHideEnabled 缺省 false；非法类型回退 false', async () => {
    const s = createMemoryStorage()
    expect(await loadSettings(s)).toEqual({ urlFilterEnabled: true, blurHideEnabled: false, clipboardClearEnabled: true, popupCloseDelayMs: 2000, syncEnabled: false, themeMode: 'auto', themeColor: 'blue', lockOnRestart: true, lockIdleMinutes: 0, lockOnSystemLock: true, backupKdfProfile: 'balanced' })
    await s.set(SETTINGS_KEY, JSON.stringify({ blurHideEnabled: 'yes' }))
    expect((await loadSettings(s)).blurHideEnabled).toBe(false)
  })
  it('clipboardClearEnabled 缺省 true；非法类型回退 true', async () => {
    const s = createMemoryStorage()
    expect((await loadSettings(s)).clipboardClearEnabled).toBe(true)
    await s.set(SETTINGS_KEY, JSON.stringify({ clipboardClearEnabled: 'no' }))
    expect((await loadSettings(s)).clipboardClearEnabled).toBe(true)
  })
  it('popupCloseDelayMs 缺省 2000；非法类型回退 2000', async () => {
    const s = createMemoryStorage()
    expect((await loadSettings(s)).popupCloseDelayMs).toBe(2000)
    await s.set(SETTINGS_KEY, JSON.stringify({ popupCloseDelayMs: '2000' }))
    expect((await loadSettings(s)).popupCloseDelayMs).toBe(2000)
  })
  it('syncEnabled 缺省 false；非法类型回退 false', async () => {
    const s = createMemoryStorage()
    expect((await loadSettings(s)).syncEnabled).toBe(false)
    await s.set(SETTINGS_KEY, JSON.stringify({ syncEnabled: 'yes' }))
    expect((await loadSettings(s)).syncEnabled).toBe(false)
  })
  it('锁定偏好缺省（plan16 T6）：lockOnRestart=true / lockIdleMinutes=0 / lockOnSystemLock=true', async () => {
    const loaded = await loadSettings(createMemoryStorage())
    expect(loaded.lockOnRestart).toBe(true)
    expect(loaded.lockIdleMinutes).toBe(0)
    expect(loaded.lockOnSystemLock).toBe(true)
  })
  it('lockOnRestart 非法类型回退 true', async () => {
    const s = createMemoryStorage()
    await s.set(SETTINGS_KEY, JSON.stringify({ lockOnRestart: 'yes' }))
    expect((await loadSettings(s)).lockOnRestart).toBe(true)
  })
  it('lockIdleMinutes 非法回退 0：负数/字符串/非整数均禁用', async () => {
    const s = createMemoryStorage()
    await s.set(SETTINGS_KEY, JSON.stringify({ lockIdleMinutes: -5 }))
    expect((await loadSettings(s)).lockIdleMinutes).toBe(0)
    await s.set(SETTINGS_KEY, JSON.stringify({ lockIdleMinutes: 'x' }))
    expect((await loadSettings(s)).lockIdleMinutes).toBe(0)
    await s.set(SETTINGS_KEY, JSON.stringify({ lockIdleMinutes: 2.5 }))
    expect((await loadSettings(s)).lockIdleMinutes).toBe(0)
  })
  it('lockIdleMinutes 合法值透传；lockOnSystemLock 非法类型回退 true', async () => {
    const s = createMemoryStorage()
    await s.set(SETTINGS_KEY, JSON.stringify({ lockIdleMinutes: 15 }))
    expect((await loadSettings(s)).lockIdleMinutes).toBe(15)
    await s.set(SETTINGS_KEY, JSON.stringify({ lockOnSystemLock: 0 }))
    expect((await loadSettings(s)).lockOnSystemLock).toBe(true)
  })
  it('backupKdfProfile 缺省 balanced（plan16 T11.5）', async () => {
    const loaded = await loadSettings(createMemoryStorage())
    expect(loaded.backupKdfProfile).toBe('balanced')
    expect(DEFAULT_SETTINGS.backupKdfProfile).toBe('balanced')
  })
  it('backupKdfProfile 非法值回退 balanced：未知档位/非字符串均回退', async () => {
    const s = createMemoryStorage()
    await s.set(SETTINGS_KEY, JSON.stringify({ backupKdfProfile: 'extreme' }))
    expect((await loadSettings(s)).backupKdfProfile).toBe('balanced')
    await s.set(SETTINGS_KEY, JSON.stringify({ backupKdfProfile: 42 }))
    expect((await loadSettings(s)).backupKdfProfile).toBe('balanced')
  })
  it('backupKdfProfile 合法值透传：fast/paranoid 均保留', async () => {
    const s = createMemoryStorage()
    await s.set(SETTINGS_KEY, JSON.stringify({ backupKdfProfile: 'paranoid' }))
    expect((await loadSettings(s)).backupKdfProfile).toBe('paranoid')
    await s.set(SETTINGS_KEY, JSON.stringify({ backupKdfProfile: 'fast' }))
    expect((await loadSettings(s)).backupKdfProfile).toBe('fast')
  })
  it('M4：旧 settings JSON 缺新字段 → load 走 DEFAULT_SETTINGS 兜底', async () => {
    // 模拟「settings 新增 syncEnabled 字段前」落盘的旧 JSON：仅含历史已知键
    const s = createMemoryStorage()
    await s.set(SETTINGS_KEY, JSON.stringify({
      urlFilterEnabled: false,
      blurHideEnabled: true,
      clipboardClearEnabled: false,
      popupCloseDelayMs: 5000,
    }))
    // 缺 syncEnabled 字段 → 解析后 merged 走 DEFAULT_SETTINGS.syncEnabled=false
    const loaded = await loadSettings(s)
    expect(loaded.syncEnabled).toBe(DEFAULT_SETTINGS.syncEnabled)
    // 缺锁定偏好三字段（plan16 T6）→ 同样走 DEFAULT 兜底
    expect(loaded.lockOnRestart).toBe(DEFAULT_SETTINGS.lockOnRestart)
    expect(loaded.lockIdleMinutes).toBe(DEFAULT_SETTINGS.lockIdleMinutes)
    expect(loaded.lockOnSystemLock).toBe(DEFAULT_SETTINGS.lockOnSystemLock)
    // 缺备份加密强度档位（plan16 T11.5）→ 同样走 DEFAULT 兜底
    expect(loaded.backupKdfProfile).toBe(DEFAULT_SETTINGS.backupKdfProfile)
    // 其余已存字段保留
    expect(loaded.urlFilterEnabled).toBe(false)
    expect(loaded.blurHideEnabled).toBe(true)
    expect(loaded.clipboardClearEnabled).toBe(false)
    expect(loaded.popupCloseDelayMs).toBe(5000)
  })
})

describe('theme settings 合并兜底', () => {
  it('缺省 → auto/blue', async () => {
    // memory storage 初始为空,等价于 adapter.get 返回 null
    const s = await loadSettings(createMemoryStorage())
    expect(s.themeMode).toBe('auto')
    expect(s.themeColor).toBe('blue')
  })
  it('合法值透传', async () => {
    const st = createMemoryStorage()
    await st.set(SETTINGS_KEY, JSON.stringify({ themeMode: 'dark', themeColor: 'teal' }))
    const s = await loadSettings(st)
    expect(s.themeMode).toBe('dark')
    expect(s.themeColor).toBe('teal')
  })
  it('非法值回退默认', async () => {
    const st = createMemoryStorage()
    await st.set(SETTINGS_KEY, JSON.stringify({ themeMode: 'sepia', themeColor: 42 }))
    const s = await loadSettings(st)
    expect(s.themeMode).toBe('auto')
    expect(s.themeColor).toBe('blue')
  })
})
