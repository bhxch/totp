import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { computed, ref } from 'vue'
import SecurityCard from '../src/components/SecurityCard.vue'
import type { DpapiUnlockOps, SecurityOps, SecurityPlatform } from '../src/components/securityPlatform'

function makeSecurity(over: Partial<SecurityOps> = {}): SecurityOps {
  return {
    locked: ref(false),
    hasEncryption: computed(() => false),
    enableEncryption: vi.fn().mockResolvedValue(undefined),
    disableEncryption: vi.fn().mockResolvedValue(undefined),
    changePassphrase: vi.fn().mockResolvedValue(undefined),
    kdfProfile: computed(() => 'balanced'),
    passwordChangedAt: computed(() => null),
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

/** 已启用且解锁的 security */
function unlockedSecurity(over: Partial<SecurityOps> = {}): SecurityOps {
  return makeSecurity({ hasEncryption: computed(() => true), ...over })
}

/** DPAPI(Windows) 解锁能力 mock（默认未绑定来源；label 回退「Windows 自动解锁」保既有文案断言） */
function makeDpapi(over: Partial<DpapiUnlockOps> = {}): DpapiUnlockOps {
  return {
    source: computed(() => null),
    getCurrentDek: vi.fn(() => new Uint8Array(32).fill(7)),
    protect: vi.fn().mockResolvedValue('WRAPPED-DEK'),
    unprotect: vi.fn().mockResolvedValue(new Uint8Array(32)),
    add: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    label: 'Windows 自动解锁',
    ...over,
  }
}

describe('SecurityCard', () => {
  beforeEach(() => vi.clearAllMocks())

  it('platform 为 null 不渲染', () => {
    const w = mount(SecurityCard, { props: { platform: null } })
    expect(w.find('section.security').exists()).toBe(false)
  })

  it('未启用：两次口令不一致不调用 enableEncryption', async () => {
    const p = makePlatform()
    const w = mount(SecurityCard, { props: { platform: p } })
    const inputs = w.findAll('input[type="password"]')
    await inputs[0]!.setValue('a')
    await inputs[1]!.setValue('b')
    await w.find('button.enable-enc').trigger('click')
    expect(p.security!.enableEncryption).not.toHaveBeenCalled()
    expect(w.text()).toContain('不一致')
  })

  it('未启用：口令一致调用 enableEncryption', async () => {
    const p = makePlatform()
    const w = mount(SecurityCard, { props: { platform: p } })
    const inputs = w.findAll('input[type="password"]')
    await inputs[0]!.setValue('a')
    await inputs[1]!.setValue('a')
    await w.find('button.enable-enc').trigger('click')
    await vi.waitFor(() => expect(p.security!.enableEncryption).toHaveBeenCalledWith('a'))
  })

  it('未启用：提示浏览器同步数据在启用加密后也将是密文；已启用态不显示该说明', () => {
    const disabled = mount(SecurityCard, { props: { platform: makePlatform() } })
    expect(disabled.text()).toContain('启用后浏览器同步的数据也将是密文')
    const enabled = mount(SecurityCard, { props: { platform: makePlatform({ security: unlockedSecurity() }) } })
    expect(enabled.text()).not.toContain('浏览器同步的数据也将是密文')
  })

  it('未启用态：口令说明含「与备份口令相互独立」（§7.2 定稿）；已启用态不显示', () => {
    const disabled = mount(SecurityCard, { props: { platform: makePlatform() } })
    expect(disabled.text()).toContain('此口令用于加密本机存储的验证库数据，与备份口令相互独立')
    const enabled = mount(SecurityCard, { props: { platform: makePlatform({ security: unlockedSecurity() }) } })
    expect(enabled.text()).not.toContain('与备份口令相互独立')
  })

  it('已启用解锁态：渲染换口令与关闭加密按钮；换口令一致后调用 changePassphrase（plan16 裁定 rotateDek:true）', async () => {
    const p = makePlatform({ security: unlockedSecurity() })
    const w = mount(SecurityCard, { props: { platform: p } })
    expect(w.find('button.change-pw').exists()).toBe(true)
    expect(w.find('button.disable-enc').exists()).toBe(true)
    const inputs = w.findAll('input[type="password"]')
    await inputs[0]!.setValue('n1')
    await inputs[1]!.setValue('n1')
    await w.find('button.change-pw').trigger('click')
    await vi.waitFor(() => expect(p.security!.changePassphrase).toHaveBeenCalledWith('n1', { rotateDek: true }))
  })

  it('C18：解锁方式区显示"口令 默认解锁方式，不可移除"明示文案', async () => {
    // 注入 passkey ops 让「解锁方式」区渲染；不解锁 passkey 探测以聚焦口令行
    const passkey = { sources: computed(() => []), prfSupported: vi.fn().mockResolvedValue(true), add: vi.fn(), remove: vi.fn() }
    const p = makePlatform({ security: makeSecurity({ hasEncryption: computed(() => true), locked: ref(false), passkey }) })
    const w = mount(SecurityCard, { props: { platform: p } })
    expect(w.text()).toContain('解锁方式')
    expect(w.text()).toContain('口令')
    expect(w.text()).toContain('默认解锁方式，不可移除')
  })

  it('关闭加密：先显示明文警示，确认后才调用 disableEncryption', async () => {
    const p = makePlatform({ security: unlockedSecurity() })
    const w = mount(SecurityCard, { props: { platform: p } })
    await w.find('button.disable-enc').trigger('click')
    expect(p.security!.disableEncryption).not.toHaveBeenCalled()
    expect(w.text()).toContain('明文存储')
    const confirm = w.findAll('button').find((b) => b.text() === '确认关闭')!
    await confirm.trigger('click')
    await vi.waitFor(() => expect(p.security!.disableEncryption).toHaveBeenCalled())
  })

  it('锁定态：显示已锁定提示且不渲染加密操作入口', () => {
    const p = makePlatform({ security: unlockedSecurity({ locked: ref(true) }) })
    const w = mount(SecurityCard, { props: { platform: p } })
    expect(w.text()).toContain('已锁定')
    expect(w.find('button.enable-enc').exists()).toBe(false)
    expect(w.find('button.change-pw').exists()).toBe(false)
    expect(w.find('button.disable-enc').exists()).toBe(false)
  })

  it('剪贴板 checkbox 触发 setClipboardClear', async () => {
    const p = makePlatform()
    const w = mount(SecurityCard, { props: { platform: p } })
    await w.find('.clipboard-clear input').setValue(false)
    expect(p.setClipboardClear).toHaveBeenCalledWith(false)
  })

  it('popupCloseDelayMs：platform 提供时渲染数字输入并触发 setPopupCloseDelay；未提供时不渲染', async () => {
    const without = mount(SecurityCard, { props: { platform: makePlatform() } })
    expect(without.find('.delay-ms input').exists()).toBe(false)

    const setPopupCloseDelay = vi.fn().mockResolvedValue(undefined)
    const p = makePlatform({ popupCloseDelayMs: computed(() => 2000), setPopupCloseDelay })
    const w = mount(SecurityCard, { props: { platform: p } })
    const input = w.find('.delay-ms input')
    expect(input.exists()).toBe(true)
    expect((input.element as HTMLInputElement).value).toBe('2000')
    await input.setValue(3500)
    expect(setPopupCloseDelay).toHaveBeenCalledWith(3500)
  })

  it('platform 无 dpapi 能力：不渲染 DPAPI 行与启用按钮', () => {
    const w = mount(SecurityCard, { props: { platform: makePlatform({ security: unlockedSecurity() }) } })
    expect(w.find('button.enable-dpapi').exists()).toBe(false)
    expect(w.find('.dpapi-row').exists()).toBe(false)
  })

  it('dpapi 未绑定：显示启用按钮；点击走 getCurrentDek→protect→add 并提示成功', async () => {
    const dek = new Uint8Array(32).fill(7)
    const dpapi = makeDpapi({ getCurrentDek: vi.fn(() => dek) })
    const w = mount(SecurityCard, {
      props: { platform: makePlatform({ security: unlockedSecurity(), dpapi }) },
    })
    expect(w.text()).toContain('解锁方式')
    const btn = w.find('button.enable-dpapi')
    expect(btn.exists()).toBe(true)
    expect(w.find('.dpapi-row').exists()).toBe(false)
    await btn.trigger('click')
    await vi.waitFor(() => expect(dpapi.add).toHaveBeenCalledWith('WRAPPED-DEK'))
    expect(dpapi.protect).toHaveBeenCalledWith(dek)
    expect(w.text()).toContain('Windows 自动解锁已启用')
  })

  it('dpapi 已绑定：显示 DPAPI 行与移除按钮，点击调用 remove', async () => {
    const dpapi = makeDpapi({ source: computed(() => ({ wrappedDekD: 'WRAPPED-DEK' })) })
    const w = mount(SecurityCard, {
      props: { platform: makePlatform({ security: unlockedSecurity(), dpapi }) },
    })
    expect(w.find('button.enable-dpapi').exists()).toBe(false)
    expect(w.find('.dpapi-row').exists()).toBe(true)
    expect(w.text()).toContain('Windows 自动解锁（DPAPI）')
    await w.find('button.remove-dpapi').trigger('click')
    await vi.waitFor(() => expect(dpapi.remove).toHaveBeenCalled())
    expect(w.text()).toContain('Windows 自动解锁已移除')
  })

  it('dpapi 启用时无可用 DEK（锁定态残留）：提示错误且不调用 protect', async () => {
    const dpapi = makeDpapi({ getCurrentDek: vi.fn(() => null) })
    const w = mount(SecurityCard, {
      props: { platform: makePlatform({ security: unlockedSecurity(), dpapi }) },
    })
    await w.find('button.enable-dpapi').trigger('click')
    await vi.waitFor(() => expect(w.text()).toContain('需先解锁'))
    expect(dpapi.protect).not.toHaveBeenCalled()
    expect(dpapi.add).not.toHaveBeenCalled()
  })

  it('dpapi protect 失败：展示错误消息且不调用 add', async () => {
    const dpapi = makeDpapi({ protect: vi.fn().mockRejectedValue(new Error('仅 Windows 支持')) })
    const w = mount(SecurityCard, {
      props: { platform: makePlatform({ security: unlockedSecurity(), dpapi }) },
    })
    await w.find('button.enable-dpapi').trigger('click')
    await vi.waitFor(() => expect(w.text()).toContain('仅 Windows 支持'))
    expect(dpapi.add).not.toHaveBeenCalled()
  })

  it('plan16：换口令成功且存在 Passkey 绑定 → 提示含「Passkey/Windows 自动解锁已因密钥轮换失效，请重新绑定」（回退形态）', async () => {
    const passkey = { sources: computed(() => [{ credentialId: 'Y3JlZC0x' }]), prfSupported: vi.fn().mockResolvedValue(true), add: vi.fn(), remove: vi.fn() }
    // 无 naming 注入 + dpapi.label 默认回退「Windows 自动解锁」→ 文案与旧实现口径动态化
    const p = makePlatform({ security: unlockedSecurity({ passkey }), dpapi: makeDpapi() })
    const w = mount(SecurityCard, { props: { platform: p } })
    const inputs = w.findAll('input[type="password"]')
    await inputs[0]!.setValue('new')
    await inputs[1]!.setValue('new')
    await w.find('button.change-pw').trigger('click')
    await vi.waitFor(() => expect(w.text()).toContain('Passkey/Windows 自动解锁已因密钥轮换失效，请重新绑定'))
  })

  it('plan16：换口令成功仅 Passkey 绑定且无 dpapi ops（extension）→ 提示仅含「Passkey已因密钥轮换失效，请重新绑定」', async () => {
    const passkey = { sources: computed(() => [{ credentialId: 'Y3JlZC0x' }]), prfSupported: vi.fn().mockResolvedValue(true), add: vi.fn(), remove: vi.fn() }
    const p = makePlatform({ security: unlockedSecurity({ passkey }) })
    const w = mount(SecurityCard, { props: { platform: p } })
    const inputs = w.findAll('input[type="password"]')
    await inputs[0]!.setValue('new')
    await inputs[1]!.setValue('new')
    await w.find('button.change-pw').trigger('click')
    await vi.waitFor(() => expect(w.text()).toContain('Passkey已因密钥轮换失效，请重新绑定'))
    expect(w.text()).not.toContain('Windows')
  })

  it('plan16：换口令成功且无其他解锁方式 → 提示中不包含重绑失效文案', async () => {
    const p = makePlatform({ security: unlockedSecurity() })
    const w = mount(SecurityCard, { props: { platform: p } })
    const inputs = w.findAll('input[type="password"]')
    await inputs[0]!.setValue('new')
    await inputs[1]!.setValue('new')
    await w.find('button.change-pw').trigger('click')
    await vi.waitFor(() => expect(w.text()).toContain('口令已更换'))
    expect(w.text()).not.toContain('重新绑定')
  })

  it('I54：仅口令解锁时显示「跨设备需用同一口令」；存在 passkey 或 dpapi 时不显示', () => {
    // 仅口令
    const onlyPw = mount(SecurityCard, { props: { platform: makePlatform({ security: unlockedSecurity() }) } })
    expect(onlyPw.text()).toContain('当前为口令解锁')
    expect(onlyPw.text()).toContain('跨设备需用同一口令')

    // 已绑定 passkey
    const passkey = { sources: computed(() => [{ credentialId: 'Y3JlZC0x' }]), prfSupported: vi.fn().mockResolvedValue(true), add: vi.fn(), remove: vi.fn() }
    const withPasskey = mount(SecurityCard, { props: { platform: makePlatform({ security: unlockedSecurity({ passkey }) }) } })
    expect(withPasskey.text()).not.toContain('跨设备需用同一口令')

    // 已绑定 dpapi
    const dpapi = makeDpapi({ source: computed(() => ({ wrappedDekD: 'W' })) })
    const withDpapi = mount(SecurityCard, { props: { platform: makePlatform({ security: unlockedSecurity(), dpapi }) } })
    expect(withDpapi.text()).not.toContain('跨设备需用同一口令')
  })

  it('I65：锁定态下剪贴板自动清空/弹窗延迟控件禁用 + 提示「解锁后可调整」', () => {
    const p = makePlatform({
      security: unlockedSecurity({ locked: ref(true) }),
      popupCloseDelayMs: computed(() => 2000),
      setPopupCloseDelay: vi.fn(),
    })
    const w = mount(SecurityCard, { props: { platform: p } })
    const clipboard = w.find('.clipboard-clear input')
    expect(clipboard.attributes('disabled')).toBeDefined()
    expect(w.find('.delay-ms input').attributes('disabled')).toBeDefined()
    expect(w.text()).toContain('解锁后可调整')
  })

  it('I71：关闭加密失败后 confirmDisable 仍复位（不依赖 run 副作用）', async () => {
    const p = makePlatform({
      security: unlockedSecurity({ disableEncryption: vi.fn().mockRejectedValue(new Error('boom')) }),
    })
    const w = mount(SecurityCard, { props: { platform: p } })
    await w.find('button.disable-enc').trigger('click')
    expect(w.find('.confirm-row').exists()).toBe(true)
    const confirm = w.findAll('button').find((b) => b.text() === '确认关闭')!
    await confirm.trigger('click')
    await vi.waitFor(() => expect(p.security!.disableEncryption).toHaveBeenCalled())
    expect(w.text()).toContain('boom')
    // 关键：confirmDisable 已复位（不再显示确认行）
    expect(w.find('.confirm-row').exists()).toBe(false)
  })

  // ---- D5：按端解锁命名（unlockNaming 注入与回退） ----

  it('D5：未启用态提示注入 prfLabel 与 osAutoLabel（「 或 」拼接，替换旧首行提示）', () => {
    const p = makePlatform({ unlockNaming: { prfLabel: 'Windows Hello (Passkey)', osAutoLabel: 'Windows 自动解锁' } })
    const w = mount(SecurityCard, { props: { platform: p } })
    expect(w.text()).toContain('启用后可绑定Windows Hello (Passkey) 或 Windows 自动解锁，免输口令解锁')
    expect(w.text()).not.toContain('每次打开需输入口令解锁')
    // 原第二行密文说明保留
    expect(w.text()).toContain('启用后浏览器同步的数据也将是密文')
  })

  it('D5：未注入 unlockNaming 回退 Passkey 且不含「或」', () => {
    const w = mount(SecurityCard, { props: { platform: makePlatform() } })
    expect(w.text()).toContain('启用后可绑定Passkey，免输口令解锁')
    expect(w.text()).not.toContain('或')
  })

  it('D5：osAutoLabel=null 不拼接「或」', () => {
    const p = makePlatform({ unlockNaming: { prfLabel: 'Windows Hello (Passkey)', osAutoLabel: null } })
    const w = mount(SecurityCard, { props: { platform: p } })
    expect(w.text()).toContain('启用后可绑定Windows Hello (Passkey)，免输口令解锁')
    expect(w.text()).not.toContain('或')
  })

  it('D5：添加解锁按钮含注入的 prfLabel；未注入回退「添加 Passkey 解锁」', () => {
    const passkey = { sources: computed(() => []), prfSupported: vi.fn().mockResolvedValue(true), add: vi.fn(), remove: vi.fn() }
    const injected = mount(SecurityCard, {
      props: {
        platform: makePlatform({
          security: unlockedSecurity({ passkey }),
          unlockNaming: { prfLabel: 'Windows Hello (Passkey)', osAutoLabel: null },
        }),
      },
    })
    expect(injected.find('button.add-passkey').text()).toBe('添加 Windows Hello (Passkey) 解锁')
    const fallback = mount(SecurityCard, { props: { platform: makePlatform({ security: unlockedSecurity({ passkey }) }) } })
    expect(fallback.find('button.add-passkey').text()).toBe('添加 Passkey 解锁')
  })

  it('D5：prf 不支持提示含注入的 prfLabel', async () => {
    const passkey = { sources: computed(() => []), prfSupported: vi.fn().mockResolvedValue(false), add: vi.fn(), remove: vi.fn() }
    const p = makePlatform({
      security: unlockedSecurity({ passkey }),
      unlockNaming: { prfLabel: 'Windows Hello (Passkey)', osAutoLabel: null },
    })
    const w = mount(SecurityCard, { props: { platform: p } })
    await vi.waitFor(() => expect(w.text()).toContain('当前浏览器不支持 Windows Hello (Passkey) 解锁（PRF）'))
  })

  it('D5：dpapi 行使用注入的 osAutoLabel（未注入回退 Windows 自动解锁由既有用例覆盖）', () => {
    const dpapi = makeDpapi({ source: computed(() => ({ wrappedDekD: 'W' })), label: 'Touch ID 自动解锁' })
    const p = makePlatform({
      security: unlockedSecurity(),
      dpapi,
      unlockNaming: { prfLabel: 'Passkey', osAutoLabel: 'Touch ID 自动解锁' },
    })
    const w = mount(SecurityCard, { props: { platform: p } })
    expect(w.text()).toContain('Touch ID 自动解锁（DPAPI）')
    expect(w.text()).not.toContain('Windows 自动解锁（DPAPI）')
  })

  // ---- D14：dpapi.label 宿主注入 + msg 按端动态化（§7.3 挂账收口） ----

  it('D14：mac 形态注入（dpapi.label=钥匙串自动解锁）→ 启用按钮/成功消息用注入 label 且不含 Windows', async () => {
    const dpapi = makeDpapi({ label: '钥匙串自动解锁' })
    const p = makePlatform({
      security: unlockedSecurity(),
      dpapi,
      unlockNaming: { prfLabel: 'Touch ID (Passkey)', osAutoLabel: '钥匙串自动解锁' },
    })
    const w = mount(SecurityCard, { props: { platform: p } })
    const btn = w.find('button.enable-dpapi')
    expect(btn.text()).toBe('启用 钥匙串自动解锁')
    await btn.trigger('click')
    await vi.waitFor(() => expect(dpapi.add).toHaveBeenCalledWith('WRAPPED-DEK'))
    expect(w.text()).toContain('钥匙串自动解锁已启用')
    expect(w.text()).not.toContain('Windows')
  })

  it('D14：mac 形态注入已绑定行显示 dpapi.label+techSuffix（钥匙串自动解锁（Keychain））', () => {
    const dpapi = makeDpapi({ source: computed(() => ({ wrappedDekD: 'W' })), label: '钥匙串自动解锁', techSuffix: '（Keychain）' })
    const p = makePlatform({
      security: unlockedSecurity(),
      dpapi,
      unlockNaming: { prfLabel: 'Touch ID (Passkey)', osAutoLabel: '钥匙串自动解锁' },
    })
    const w = mount(SecurityCard, { props: { platform: p } })
    expect(w.text()).toContain('钥匙串自动解锁（Keychain）')
    expect(w.text()).not.toContain('（DPAPI）')
    expect(w.text()).not.toContain('Windows')
  })

  it('D14：换口令成功且 dpapi 注入 mac label → 提示 Passkey/钥匙串自动解锁已因密钥轮换失效（不含 Windows）', async () => {
    // 绑定 source 使 rebindHint 条件（存在非口令来源）触发
    const dpapi = makeDpapi({ label: '钥匙串自动解锁', source: computed(() => ({ wrappedDekD: 'W' })) })
    const p = makePlatform({
      security: unlockedSecurity(),
      dpapi,
      unlockNaming: { prfLabel: 'Touch ID (Passkey)', osAutoLabel: '钥匙串自动解锁' },
    })
    const w = mount(SecurityCard, { props: { platform: p } })
    const inputs = w.findAll('input[type="password"]')
    await inputs[0]!.setValue('new')
    await inputs[1]!.setValue('new')
    await w.find('button.change-pw').trigger('click')
    await vi.waitFor(() => expect(w.text()).toContain('口令已更换'))
    expect(w.text()).toContain('Passkey/钥匙串自动解锁已因密钥轮换失效，请重新绑定')
    expect(w.text()).not.toContain('Windows')
  })

  it('D14：移除成功消息用注入 label（钥匙串自动解锁已移除）', async () => {
    const dpapi = makeDpapi({ source: computed(() => ({ wrappedDekD: 'W' })), label: '钥匙串自动解锁' })
    const w = mount(SecurityCard, {
      props: { platform: makePlatform({ security: unlockedSecurity(), dpapi }) },
    })
    await w.find('button.remove-dpapi').trigger('click')
    await vi.waitFor(() => expect(dpapi.remove).toHaveBeenCalled())
    expect(w.text()).toContain('钥匙串自动解锁已移除')
    expect(w.text()).not.toContain('Windows')
  })

  it('D14：添加 Passkey 成功/失败消息用注入的 prfLabel（Touch ID (Passkey)）', async () => {
    const passkey = { sources: computed(() => []), prfSupported: vi.fn().mockResolvedValue(true), add: vi.fn().mockResolvedValue(true), remove: vi.fn() }
    const p = makePlatform({
      security: unlockedSecurity({ passkey }),
      unlockNaming: { prfLabel: 'Touch ID (Passkey)', osAutoLabel: null },
    })
    const w = mount(SecurityCard, { props: { platform: p } })
    // 按钮在 prfCap 探测完成（异步 resolve true）前 disabled
    const btn = w.find('button.add-passkey')
    await vi.waitFor(() => expect(btn.attributes('disabled')).toBeUndefined())
    await btn.trigger('click')
    await vi.waitFor(() => expect(passkey.add).toHaveBeenCalled())
    expect(w.text()).toContain('Touch ID (Passkey) 已绑定，下次锁定后可使用 Touch ID (Passkey) 解锁')

    const failPk = { sources: computed(() => []), prfSupported: vi.fn().mockResolvedValue(true), add: vi.fn().mockResolvedValue(false), remove: vi.fn() }
    const p2 = makePlatform({
      security: unlockedSecurity({ passkey: failPk }),
      unlockNaming: { prfLabel: 'Touch ID (Passkey)', osAutoLabel: null },
    })
    const w2 = mount(SecurityCard, { props: { platform: p2 } })
    const btn2 = w2.find('button.add-passkey')
    await vi.waitFor(() => expect(btn2.attributes('disabled')).toBeUndefined())
    await btn2.trigger('click')
    await vi.waitFor(() => expect(w2.text()).toContain('Touch ID (Passkey) 创建未完成（已取消或认证器不支持 PRF）'))
  })
})
