import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { computed, ref } from 'vue'
import BackupSecretCard from '../src/components/BackupSecretCard.vue'
import type { VueStore } from '../src/store'

/** 最小 store 假对象：按 VueStore 消费形态构造（backupSecret/bagStored/hasEncryption 为 ComputedRef 形态的 ref，
 *  setBackupSecret/forgetBackupSecret 为 vi.fn() 且模拟真实语义：会话必置、remember 存入保管区） */
function makeStore(init: { backupSecret?: string | null; inBag?: boolean; hasEncryption?: boolean } = {}) {
  const backupSecret = ref<string | null>(init.backupSecret ?? null)
  const bagStored = ref(init.inBag ?? false)
  const hasEncryption = ref(init.hasEncryption ?? true)
  const setBackupSecret = vi.fn(async (secret: string, remember: boolean) => {
    backupSecret.value = secret.trim()
    if (remember) bagStored.value = true
  })
  const forgetBackupSecret = vi.fn(async () => {
    backupSecret.value = null
    bagStored.value = false
  })
  return {
    hasEncryption: computed(() => hasEncryption.value),
    backupSecret: computed(() => backupSecret.value),
    bagStored: computed(() => bagStored.value),
    setBackupSecret,
    forgetBackupSecret,
  } as unknown as VueStore
}

function mountCard(store: VueStore) {
  return mount(BackupSecretCard, { props: { store } })
}

describe('BackupSecretCard', () => {
  beforeEach(() => vi.clearAllMocks())

  it('未设置态：显示「未设置」，清除按钮不渲染', () => {
    const w = mountCard(makeStore())
    expect(w.text()).toContain('未设置')
    expect(w.find('button.secret-clear').exists()).toBe(false)
  })

  it('说明文案按保管区语义定稿：desc/remember-hint 不再说「随库存放」，记住开关为「记住（存入保管区）」', () => {
    const w = mountCard(makeStore())
    expect(w.find('.hint.desc').text()).toBe('用于加密本地备份文件与云端同步对象，两者共用；开启记住后存入库旁的加密保管区（受本地主口令保护），解锁库即可用；未记住则锁定或关闭页面后需重新输入。')
    expect(w.find('.remember-hint').text()).toBe('开启后以密文存入保管区（需已启用加密），解锁库即可用，系统原生解锁方式同样生效。')
    expect(w.text()).toContain('记住（存入保管区）')
  })

  it('输入不一致点启用：不调用 setBackupSecret，显示错误', async () => {
    const s = makeStore()
    const w = mountCard(s)
    const inputs = w.findAll('input[type="password"]')
    await inputs[0]!.setValue('a')
    await inputs[1]!.setValue('b')
    await w.find('button.secret-save').trigger('click')
    expect(s.setBackupSecret).not.toHaveBeenCalled()
    expect(w.text()).toContain('两次输入的口令不一致')
  })

  it('空口令点启用：不调用，显示错误', async () => {
    const s = makeStore()
    const w = mountCard(s)
    await w.find('button.secret-save').trigger('click')
    expect(s.setBackupSecret).not.toHaveBeenCalled()
    expect(w.text()).toContain('请输入口令')
  })

  it('一致点启用：以 (trim 后口令, remember) 调用；成功后输入清空 + ok 消息', async () => {
    const s = makeStore()
    const w = mountCard(s)
    const inputs = w.findAll('input[type="password"]')
    await inputs[0]!.setValue('  pw  ')
    await inputs[1]!.setValue('  pw  ')
    await w.find('button.secret-save').trigger('click')
    await vi.waitFor(() => expect(s.setBackupSecret).toHaveBeenCalledWith('pw', false))
    expect(w.text()).toContain('备份口令已启用')
    expect((w.findAll('input[type="password"]')[0]!.element as HTMLInputElement).value).toBe('')
    expect((w.findAll('input[type="password"]')[1]!.element as HTMLInputElement).value).toBe('')
  })

  it('setBackupSecret 抛错：err 消息含错误信息，不崩溃且输入保留', async () => {
    const s = makeStore()
    s.setBackupSecret = vi.fn(async () => {
      throw new Error('需先启用加密才能记住备份口令')
    })
    const w = mountCard(s)
    const inputs = w.findAll('input[type="password"]')
    await inputs[0]!.setValue('pw')
    await inputs[1]!.setValue('pw')
    await w.find('button.secret-save').trigger('click')
    await vi.waitFor(() => expect(w.text()).toContain('需先启用加密才能记住备份口令'))
    // 错误后输入不清空，便于修改重试
    expect((w.findAll('input[type="password"]')[0]!.element as HTMLInputElement).value).toBe('pw')
  })

  it('hasEncryption=false：记住开关 disabled 且 hint 可见', () => {
    const w = mountCard(makeStore({ hasEncryption: false }))
    const sw = w.find('input[role="switch"]')
    expect(sw.exists()).toBe(true)
    expect(sw.attributes('disabled')).toBeDefined()
    expect(w.find('.remember-hint').isVisible()).toBe(true)
    expect(w.find('.remember-hint').text()).toContain('需已启用加密')
  })

  it('会话有值（保管区无口令）：状态行「会话内已启用」；点清除调用 forgetBackupSecret + ok 消息', async () => {
    const s = makeStore({ backupSecret: 'pw' })
    const w = mountCard(s)
    expect(w.text()).toContain('会话内已启用')
    expect(w.find('button.secret-clear').exists()).toBe(true)
    await w.find('button.secret-clear').trigger('click')
    await vi.waitFor(() => expect(s.forgetBackupSecret).toHaveBeenCalled())
    expect(w.text()).toContain('已清除')
  })

  it('保管区已存口令：状态行「已存入保管区，解锁即用」', () => {
    const w = mountCard(makeStore({ backupSecret: 'pw', inBag: true }))
    expect(w.text()).toContain('已存入保管区，解锁即用')
  })

  it('remember 开关切换值透传（false→true 两次调用参数不同）', async () => {
    const s = makeStore()
    const w = mountCard(s)
    const pw = w.findAll('input[type="password"]')[0]!
    const confirm = w.findAll('input[type="password"]')[1]!
    await pw.setValue('a')
    await confirm.setValue('a')
    await w.find('button.secret-save').trigger('click')
    await vi.waitFor(() => expect(s.setBackupSecret).toHaveBeenCalledWith('a', false))
    // 切换记住开关为开
    await w.find('input[role="switch"]').setValue(true)
    await pw.setValue('b')
    await confirm.setValue('b')
    await w.find('button.secret-save').trigger('click')
    await vi.waitFor(() => expect(s.setBackupSecret).toHaveBeenLastCalledWith('b', true))
  })
})
