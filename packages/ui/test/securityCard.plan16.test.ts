import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { computed, ref } from 'vue'
import SecurityCard from '../src/components/SecurityCard.vue'
import type { LockPrefs, SecurityOps, SecurityPlatform } from '../src/components/securityPlatform'

const DAY = 86_400_000

function makeSecurity(over: Partial<SecurityOps> = {}): SecurityOps {
  return {
    locked: ref(false),
    hasEncryption: computed(() => true),
    enableEncryption: vi.fn().mockResolvedValue(undefined),
    disableEncryption: vi.fn().mockResolvedValue(undefined),
    changePassphrase: vi.fn().mockResolvedValue(undefined),
    kdfProfile: computed(() => 'balanced'),
    passwordChangedAt: computed(() => Date.now() - 90 * DAY),
    ...over,
  }
}

function makePlatform(over: Partial<SecurityPlatform> = {}): SecurityPlatform {
  return {
    security: makeSecurity(),
    clipboardClearEnabled: computed(() => true),
    setClipboardClear: vi.fn().mockResolvedValue(undefined),
    ...over,
  }
}

const DEFAULT_PREFS: LockPrefs = { lockOnRestart: true, lockIdleMinutes: 0, lockOnSystemLock: true }

function makeLockPrefs(over: Partial<LockPrefs> = {}): {
  prefs: LockPrefs
  api: NonNullable<SecurityPlatform['lockPrefs']>
} {
  const prefs: LockPrefs = { ...DEFAULT_PREFS, ...over }
  return {
    prefs,
    api: { get: vi.fn(async () => ({ ...prefs })), set: vi.fn(async (p: LockPrefs) => { Object.assign(prefs, p) }) },
  }
}

/** 打开加密强度下拉并点选指定 label 的选项 */
async function selectOption(w: ReturnType<typeof mount>, label: string): Promise<void> {
  await w.find('button.md-select__trigger').trigger('click')
  const opt = w.findAll('[role="option"]').find((o) => o.text() === label)
  expect(opt, `选项「${label}」应存在`).toBeDefined()
  await opt!.trigger('click')
}

describe('SecurityCard plan16：加密强度档位', () => {
  beforeEach(() => vi.clearAllMocks())

  it('已启用解锁态渲染加密强度三档；触发框显示当前档位 label', async () => {
    const w = mount(SecurityCard, { props: { platform: makePlatform() } })
    const trigger = w.find('button.md-select__trigger')
    expect(trigger.exists()).toBe(true)
    expect(trigger.text()).toContain('平衡（默认）')
    await trigger.trigger('click')
    const opts = w.findAll('[role="option"]')
    expect(opts.map((o) => o.text())).toEqual(['更快（低端机友好）', '平衡（默认）', '更慢更耐暴力破解'])
  })

  it('选择新档位展开当前口令确认行；确认调 changePassphrase(当前口令, { rotateDek: false, profile }) 并提示立即生效', async () => {
    const p = makePlatform()
    const w = mount(SecurityCard, { props: { platform: p } })
    expect(w.find('.kdf-confirm').exists()).toBe(false)
    await selectOption(w, '更慢更耐暴力破解')
    expect(w.find('.kdf-confirm').exists()).toBe(true)
    await w.find('.kdf-confirm input[type="password"]').setValue('cur-pw')
    await w.find('button.confirm-kdf').trigger('click')
    await vi.waitFor(() =>
      expect(p.security!.changePassphrase).toHaveBeenCalledWith('cur-pw', { rotateDek: false, profile: 'paranoid' }),
    )
    expect(w.text()).toContain('加密强度已更新（立即生效，数据无需重新加密）')
    // 成功后确认行收起、口令清空
    expect(w.find('.kdf-confirm').exists()).toBe(false)
  })

  it('选当前档位视作取消（不展开确认行）；取消按钮收起确认行且不调用 changePassphrase', async () => {
    const p = makePlatform()
    const w = mount(SecurityCard, { props: { platform: p } })
    await selectOption(w, '平衡（默认）')
    expect(w.find('.kdf-confirm').exists()).toBe(false)
    await selectOption(w, '更快（低端机友好）')
    expect(w.find('.kdf-confirm').exists()).toBe(true)
    await w.findAll('button').find((b) => b.text() === '取消')!.trigger('click')
    expect(w.find('.kdf-confirm').exists()).toBe(false)
    expect(p.security!.changePassphrase).not.toHaveBeenCalled()
  })

  it('确认行为空口令报中文错误且不调用 changePassphrase', async () => {
    const p = makePlatform()
    const w = mount(SecurityCard, { props: { platform: p } })
    await selectOption(w, '更快（低端机友好）')
    await w.find('button.confirm-kdf').trigger('click')
    expect(w.text()).toContain('请输入当前口令')
    expect(p.security!.changePassphrase).not.toHaveBeenCalled()
  })
})

describe('SecurityCard plan16：换口令轮换与重绑提示', () => {
  beforeEach(() => vi.clearAllMocks())

  it('换口令调 changePassphrase(newPw, { rotateDek: true })', async () => {
    const p = makePlatform()
    const w = mount(SecurityCard, { props: { platform: p } })
    const inputs = w.findAll('input[type="password"]')
    await inputs[0]!.setValue('n1')
    await inputs[1]!.setValue('n1')
    await w.find('button.change-pw').trigger('click')
    await vi.waitFor(() => expect(p.security!.changePassphrase).toHaveBeenCalledWith('n1', { rotateDek: true }))
  })

  it('换前存在 Passkey 源 → 成功消息追加重绑提示；无源 → 不提示', async () => {
    const passkey = { sources: computed(() => [{ credentialId: 'Y3JlZC0x' }]), prfSupported: vi.fn().mockResolvedValue(true), add: vi.fn(), remove: vi.fn() }
    const withPk = mount(SecurityCard, { props: { platform: makePlatform({ security: makeSecurity({ passkey }) }) } })
    let inputs = withPk.findAll('input[type="password"]')
    await inputs[0]!.setValue('n')
    await inputs[1]!.setValue('n')
    await withPk.find('button.change-pw').trigger('click')
    await vi.waitFor(() => expect(withPk.text()).toContain('已因密钥轮换失效，请重新绑定'))

    const withoutPk = mount(SecurityCard, { props: { platform: makePlatform() } })
    inputs = withoutPk.findAll('input[type="password"]')
    await inputs[0]!.setValue('n')
    await inputs[1]!.setValue('n')
    await withoutPk.find('button.change-pw').trigger('click')
    await vi.waitFor(() => expect(withoutPk.text()).toContain('口令已更换'))
    expect(withoutPk.text()).not.toContain('重新绑定')
  })
})

describe('SecurityCard plan16：主口令天数提示', () => {
  beforeEach(() => vi.clearAllMocks())

  it('passwordChangedAt=null 显示「未记录更换时间」', () => {
    const w = mount(SecurityCard, { props: { platform: makePlatform({ security: makeSecurity({ passwordChangedAt: computed(() => null) }) }) } })
    expect(w.text()).toContain('本地主口令未记录更换时间')
    expect(w.find('.pw-age-warn').exists()).toBe(false)
  })

  it('90 天 → 「已 90 天未更换」无强调色', () => {
    const w = mount(SecurityCard, { props: { platform: makePlatform({ security: makeSecurity({ passwordChangedAt: computed(() => Date.now() - 90 * DAY) }) }) } })
    expect(w.text()).toContain('本地主口令已 90 天未更换')
    expect(w.find('.pw-age-warn').exists()).toBe(false)
  })

  it('200 天 → 「已 200 天未更换」且 pw-age-warn 强调色', () => {
    const w = mount(SecurityCard, { props: { platform: makePlatform({ security: makeSecurity({ passwordChangedAt: computed(() => Date.now() - 200 * DAY) }) }) } })
    expect(w.text()).toContain('本地主口令已 200 天未更换')
    expect(w.find('.pw-age-warn').exists()).toBe(true)
  })
})

describe('SecurityCard plan16：锁定策略偏好', () => {
  beforeEach(() => vi.clearAllMocks())

  it('platform 未提供 lockPrefs → 锁定策略区不渲染', () => {
    const w = mount(SecurityCard, { props: { platform: makePlatform() } })
    expect(w.find('.lock-prefs').exists()).toBe(false)
  })

  it('已启用加密且提供 lockPrefs → 渲染三控件并按 get 值回显', async () => {
    const lp = makeLockPrefs({ lockIdleMinutes: 15, lockOnSystemLock: false })
    const w = mount(SecurityCard, { props: { platform: makePlatform({ lockPrefs: lp.api }) } })
    await vi.waitFor(() => expect(w.find('.lock-prefs').exists()).toBe(true))
    expect((w.find('.lock-restart input').element as HTMLInputElement).checked).toBe(true) // lockOnRestart=true
    expect((w.find('.idle-min input').element as HTMLInputElement).value).toBe('15')
    expect((w.find('.lock-syslock input').element as HTMLInputElement).checked).toBe(false) // lockOnSystemLock=false
    expect(w.find('.lock-prefs').text()).toContain('重启后保持锁定')
    expect(w.find('.lock-prefs').text()).toContain('空闲 N 分钟后锁定')
    expect(w.find('.lock-prefs').text()).toContain('系统锁屏时锁定')
  })

  it('切换「重启后保持锁定」→ set 收到完整对象（含未变更字段）', async () => {
    const lp = makeLockPrefs()
    const w = mount(SecurityCard, { props: { platform: makePlatform({ lockPrefs: lp.api }) } })
    await vi.waitFor(() => expect(w.find('.lock-prefs').exists()).toBe(true))
    await w.find('.lock-restart input').setValue(false)
    await vi.waitFor(() => expect(lp.api.set).toHaveBeenCalledWith({ lockOnRestart: false, lockIdleMinutes: 0, lockOnSystemLock: true }))
  })

  it('空闲分钟输入钳制 ≥0 整数（-5→0、12.9→12）并回写完整对象', async () => {
    const lp = makeLockPrefs()
    const w = mount(SecurityCard, { props: { platform: makePlatform({ lockPrefs: lp.api }) } })
    await vi.waitFor(() => expect(w.find('.lock-prefs').exists()).toBe(true))
    await w.find('.idle-min input').setValue('-5')
    await vi.waitFor(() => expect(lp.api.set).toHaveBeenCalledWith({ lockOnRestart: true, lockIdleMinutes: 0, lockOnSystemLock: true }))
    await w.find('.idle-min input').setValue('12.9')
    await vi.waitFor(() => expect(lp.api.set).toHaveBeenCalledWith({ lockOnRestart: true, lockIdleMinutes: 12, lockOnSystemLock: true }))
  })

  it('切换「系统锁屏时锁定」→ set 收到完整对象', async () => {
    const lp = makeLockPrefs({ lockOnSystemLock: false })
    const w = mount(SecurityCard, { props: { platform: makePlatform({ lockPrefs: lp.api }) } })
    await vi.waitFor(() => expect(w.find('.lock-prefs').exists()).toBe(true))
    await w.find('.lock-syslock input').setValue(true)
    await vi.waitFor(() => expect(lp.api.set).toHaveBeenCalledWith({ lockOnRestart: true, lockIdleMinutes: 0, lockOnSystemLock: true }))
  })

  it('锁定态：hasEnc 为真 → 锁定策略区仍渲染（settings 写入不依赖 DEK）', async () => {
    const lp = makeLockPrefs()
    const w = mount(SecurityCard, {
      props: { platform: makePlatform({ security: makeSecurity({ locked: ref(true) }), lockPrefs: lp.api }) },
    })
    await vi.waitFor(() => expect(w.find('.lock-prefs').exists()).toBe(true))
  })

  it('set 持久化拒绝 → 错误进 msg 通道（role=status）而非静默+未处理 rejection', async () => {
    const lp = {
      get: vi.fn(async (): Promise<LockPrefs> => ({ ...DEFAULT_PREFS })),
      set: vi.fn(async (): Promise<void> => { throw new Error('偏好写入失败') }),
    }
    const w = mount(SecurityCard, { props: { platform: makePlatform({ lockPrefs: lp }) } })
    await vi.waitFor(() => expect(w.find('.lock-prefs').exists()).toBe(true))
    await w.find('.lock-restart input').setValue(false)
    await flushPromises()
    expect(w.find('[role="status"]').text()).toContain('偏好写入失败')
  })

  it('unsupported 声明 lockOnRestart（审查 Minor：ext 无效果开关）→ 隐藏该控件，其余两控件照常渲染与写回', async () => {
    const lp = makeLockPrefs()
    const w = mount(SecurityCard, {
      props: { platform: makePlatform({ lockPrefs: { ...lp.api, unsupported: ['lockOnRestart'] } }) },
    })
    await vi.waitFor(() => expect(w.find('.lock-prefs').exists()).toBe(true))
    expect(w.find('.lock-restart').exists()).toBe(false) // 重启开关隐藏
    expect(w.find('.lock-prefs').text()).not.toContain('重启后保持锁定')
    expect(w.find('.idle-min').exists()).toBe(true) // 其余两控件照常
    expect(w.find('.lock-syslock').exists()).toBe(true)
    // 其余控件写回仍是完整对象（lockOnRestart 保持 get 原值，宿主 set 语义不变）
    await w.find('.lock-syslock input').setValue(false)
    await vi.waitFor(() => expect(lp.api.set).toHaveBeenCalledWith({ lockOnRestart: true, lockIdleMinutes: 0, lockOnSystemLock: false }))
  })

  it('unsupported 未声明（desktop 现状）→ 三控件全渲染不回归', async () => {
    const lp = makeLockPrefs()
    const w = mount(SecurityCard, { props: { platform: makePlatform({ lockPrefs: lp.api }) } })
    await vi.waitFor(() => expect(w.find('.lock-prefs').exists()).toBe(true))
    expect(w.find('.lock-restart').exists()).toBe(true)
    expect(w.find('.idle-min').exists()).toBe(true)
    expect(w.find('.lock-syslock').exists()).toBe(true)
  })

  it('unsupported 声明 lockOnSystemLock（审查 I10：desktop mac/Linux 无系统锁屏事件源）→ 隐藏该开关，其余两控件照常渲染与写回', async () => {
    const lp = makeLockPrefs()
    const w = mount(SecurityCard, {
      props: { platform: makePlatform({ lockPrefs: { ...lp.api, unsupported: ['lockOnRestart', 'lockOnSystemLock'] } }) },
    })
    await vi.waitFor(() => expect(w.find('.lock-prefs').exists()).toBe(true))
    expect(w.find('.lock-restart').exists()).toBe(false)
    expect(w.find('.lock-syslock').exists()).toBe(false) // 系统锁屏开关隐藏
    expect(w.find('.lock-prefs').text()).not.toContain('系统锁屏时锁定')
    expect(w.find('.idle-min').exists()).toBe(true) // 空闲控件照常
    await w.find('.idle-min input').setValue('30')
    await vi.waitFor(() => expect(lp.api.set).toHaveBeenCalledWith({ lockOnRestart: true, lockIdleMinutes: 30, lockOnSystemLock: true }))
  })
})
