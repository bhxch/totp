import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { computed, ref } from 'vue'
import SecurityCard from '../src/components/SecurityCard.vue'
import { createTestI18n } from './helpers/i18n'
import type { AbeBindResult, AbeOps, AbeResult, AbeStatus, SecurityOps, SecurityPlatform } from '../src/components/securityPlatform'

function makeSecurity(over: Partial<SecurityOps> = {}): SecurityOps {
  return {
    locked: ref(false),
    hasEncryption: computed(() => true),
    enableEncryption: vi.fn().mockResolvedValue(undefined),
    disableEncryption: vi.fn().mockResolvedValue(undefined),
    changePassphrase: vi.fn().mockResolvedValue(undefined),
    // C1 终审：ABE 绑定编排 wrap 入参（解锁态 DEK；宿主工厂注入 getCurrentDek）
    getCurrentDek: vi.fn((): Uint8Array | null => new Uint8Array(32).fill(7)),
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

/** ABE 提权服务通道 mock（默认 supported+未安装：status→null；bind 成功；wrap 成功；
 *  源 op 空实现对 spy 断言用；source 默认在场（R7-I2 判定数据口，源缺失用例单独覆写）；
 *  unwrap 为 T7 锁屏通道，SecurityCard 不消费——桩为 null 回退语义即可） */
function makeAbe(over: Partial<AbeOps> = {}): AbeOps {
  return {
    supported: true,
    source: computed(() => ({ kind: 'abe' as const })),
    status: vi.fn().mockResolvedValue(null),
    bind: vi.fn().mockResolvedValue({ ok: true }),
    wrap: vi.fn().mockResolvedValue(true),
    remove: vi.fn().mockResolvedValue({ ok: true } as AbeResult),
    addSource: vi.fn().mockResolvedValue(undefined),
    removeSource: vi.fn().mockResolvedValue(undefined),
    unwrap: vi.fn().mockResolvedValue(null),
    ...over,
  }
}

/** 已安装且调用者匹配的服务状态（desktop 副本路径 → 尾段展示 service\TotpTools.exe） */
const matchedStatus: AbeStatus = {
  installed: true,
  matchesCaller: true,
  boundPath: 'C:\\ProgramData\\TotpTools\\service\\TotpTools.exe',
  version: '1.2.3',
}

function mountCard(abe: AbeOps | null, platform?: SecurityPlatform) {
  return mount(SecurityCard, {
    global: { plugins: [createTestI18n()] },
    props: { platform: platform ?? makePlatform(), abe },
  })
}

describe('SecurityCard ABE 区块（plan p6 §0.3 三态 + R7-I2 源缺失引导态）', () => {
  beforeEach(() => vi.clearAllMocks())

  it('supported=false 不渲染区块也不调 status；abe 为 null（宿主未提供）同样不渲染', async () => {
    const unsupported = makeAbe({ supported: false })
    const w = mountCard(unsupported)
    await flushPromises()
    expect(w.find('.abe-install').exists()).toBe(false)
    expect(w.find('.remove-abe').exists()).toBe(false)
    expect(w.find('.abe-rebind').exists()).toBe(false)
    expect(w.text()).not.toContain('应用绑定解锁')
    expect(unsupported.status).not.toHaveBeenCalled()

    const w2 = mountCard(null)
    await flushPromises()
    expect(w2.find('.abe-install').exists()).toBe(false)
    expect(w2.text()).not.toContain('应用绑定解锁')
  })

  it('未安装（status→null 含查询失败）：渲染标题+安装按钮，无移除/重绑', async () => {
    const w = mountCard(makeAbe())
    await vi.waitFor(() => expect(w.find('button.abe-install').exists()).toBe(true))
    expect(w.text()).toContain('应用绑定解锁（服务）')
    expect(w.text()).toContain('安装服务')
    expect(w.find('button.remove-abe').exists()).toBe(false)
    expect(w.find('button.abe-rebind').exists()).toBe(false)
  })

  it('已安装且调用者匹配：状态行含版本与绑定路径尾段（service\\TotpTools.exe，不泄漏全路径）+移除按钮', async () => {
    const w = mountCard(makeAbe({ status: vi.fn().mockResolvedValue(matchedStatus) }))
    await vi.waitFor(() => expect(w.find('button.remove-abe').exists()).toBe(true))
    expect(w.text()).toContain('版本 1.2.3 · 绑定 service\\TotpTools.exe')
    expect(w.text()).not.toContain('C:\\ProgramData')
    expect(w.find('button.abe-install').exists()).toBe(false)
    expect(w.find('button.abe-rebind').exists()).toBe(false)
  })

  it('已安装但调用者失配：渲染失配提示+重新绑定按钮，无安装/移除', async () => {
    const w = mountCard(makeAbe({ status: vi.fn().mockResolvedValue({ installed: true, matchesCaller: false }) }))
    await vi.waitFor(() => expect(w.find('button.abe-rebind').exists()).toBe(true))
    expect(w.text()).toContain('应用已更新或路径已变，需要重新绑定')
    expect(w.find('button.abe-install').exists()).toBe(false)
    expect(w.find('button.remove-abe').exists()).toBe(false)
  })

  it('R7-I2 源缺失（服务在但 abe 标记源不在——换口令轮换降级态）：显示重绑引导而非假「已启用」状态行', async () => {
    const w = mountCard(makeAbe({ source: computed(() => null), status: vi.fn().mockResolvedValue(matchedStatus) }))
    await vi.waitFor(() => expect(w.find('button.abe-rebind').exists()).toBe(true))
    expect(w.text()).toContain('应用绑定已失效（如更换主口令后未恢复），需要重新绑定')
    // 假「已启用」防御：无状态行（版本+路径）、无移除按钮
    expect(w.text()).not.toContain('版本 1.2.3')
    expect(w.find('button.remove-abe').exists()).toBe(false)
    expect(w.find('button.abe-install').exists()).toBe(false)
    // 重绑走安装序列（bind→wrap→addSource），可恢复
    await w.find('button.abe-rebind').trigger('click')
    const abe = w.props('abe')!
    await vi.waitFor(() => expect(abe.addSource).toHaveBeenCalledTimes(1))
  })

  it('绑定调用序列（C1 终审）：点击安装 → abe.bind → wrap(当前 DEK) → addSource → status 刷新（共 2 次）→ 成功提示', async () => {
    const abe = makeAbe()
    const w = mountCard(abe)
    await vi.waitFor(() => expect(w.find('button.abe-install').exists()).toBe(true))
    await w.find('button.abe-install').trigger('click')
    await vi.waitFor(() => expect(abe.addSource).toHaveBeenCalledTimes(1))
    expect(abe.bind).toHaveBeenCalledTimes(1)
    expect(abe.wrap).toHaveBeenCalledTimes(1)
    expect(abe.wrap).toHaveBeenCalledWith(new Uint8Array(32).fill(7)) // DEK 取自 security.getCurrentDek
    // 序严格 bind→wrap→addSource：wrap 在 bind 后 addSource 前（HKLM 密文先于标记源落盘）
    const order = [abe.bind, abe.wrap, abe.addSource].map((m) => vi.mocked(m).mock.invocationCallOrder[0]!)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(abe.status).toHaveBeenCalledTimes(2) // 挂载 1 次 + 绑定成功刷新 1 次
    await vi.waitFor(() => expect(w.text()).toContain('应用绑定解锁已启用'))
  })

  // ---- I4 终审编排用例（跨项目集成必须有一条穿层测试；bind→wrap→addSource 序列与其
  //      失败分支在此以组件级穿层断言落地）----

  it('I4 编排：bind→wrap→addSource 完整穿层序列（含状态刷新与成功提示）', async () => {
    const abe = makeAbe({ status: vi.fn().mockResolvedValueOnce(null).mockResolvedValue(matchedStatus) })
    const w = mountCard(abe)
    await vi.waitFor(() => expect(w.find('button.abe-install').exists()).toBe(true))
    await w.find('button.abe-install').trigger('click')
    await vi.waitFor(() => expect(w.text()).toContain('版本 1.2.3'))
    // 全链路四步恰好各一次：绑定安装、密文落 HKLM、标记源落盘、状态刷新
    expect(abe.bind).toHaveBeenCalledTimes(1)
    expect(abe.wrap).toHaveBeenCalledTimes(1)
    expect(abe.addSource).toHaveBeenCalledTimes(1)
    expect(abe.status).toHaveBeenCalledTimes(2)
  })

  it('I4 编排：wrap 失败 → 不 addSource，内联提示绑定未完成，可重试', async () => {
    const abe = makeAbe({ wrap: vi.fn().mockResolvedValue(false) })
    const w = mountCard(abe)
    await vi.waitFor(() => expect(w.find('button.abe-install').exists()).toBe(true))
    await w.find('button.abe-install').trigger('click')
    await vi.waitFor(() => expect(abe.wrap).toHaveBeenCalledTimes(1))
    await flushPromises()
    // 标记源不得落盘：HKLM 密文未写成的半绑定态比未绑定更误导
    expect(abe.addSource).not.toHaveBeenCalled()
    // R7-M5：bind 已成功（服务可能已装），失败路径同样刷新状态反映真实服务态（挂载 1 + 刷新 1）
    expect(abe.status).toHaveBeenCalledTimes(2)
    expect(w.find('button.abe-install').exists()).toBe(true)
    expect(w.text()).toContain('服务密文写入未完成')
    w.unmount()
  })

  it('I4 编排：无 DEK（锁定态/宿主未注入 getCurrentDek）→ 不 wrap 不 addSource，同口径中止', async () => {
    const abe = makeAbe()
    const w = mountCard(abe, makePlatform({ security: makeSecurity({ getCurrentDek: vi.fn((): Uint8Array | null => null) }) }))
    await vi.waitFor(() => expect(w.find('button.abe-install').exists()).toBe(true))
    await w.find('button.abe-install').trigger('click')
    await flushPromises()
    expect(abe.bind).toHaveBeenCalledTimes(1)
    expect(abe.wrap).not.toHaveBeenCalled()
    expect(abe.addSource).not.toHaveBeenCalled()
    expect(w.text()).toContain('服务密文写入未完成')
    w.unmount()
  })

  // Task 11 三分支分类文案（Rust Err 前缀协议 → 判别联合 reason → i18n key；cancelled
  // 口径按 runas 1.2 语义折叠裁定为「取消或未完成授权」）
  const bindFailCases: Array<[AbeBindResult, string]> = [
    [{ ok: false, reason: 'cancelled', detail: 'UAC 取消' }, '已取消 UAC 授权或未完成授权，安装中止'],
    [{ ok: false, reason: 'failed', detail: '创建服务失败' }, '安装失败：创建服务失败'],
    [{ ok: false, reason: 'notready', detail: '10s 内不可达' }, '服务未就绪：若安装了第三方安全软件（如 ESET），请将 C:\\ProgramData\\TotpTools\\service\\ 加入信任后重试'],
  ]
  it.each(bindFailCases)('bind 失败 %j → 不调 addSource，保持未安装态并给分类内联文案（含「%s」）', async (ret, expected) => {
    const abe = makeAbe({ bind: vi.fn().mockResolvedValue(ret) })
    const w = mountCard(abe)
    await vi.waitFor(() => expect(w.find('button.abe-install').exists()).toBe(true))
    await w.find('button.abe-install').trigger('click')
    await vi.waitFor(() => expect(abe.bind).toHaveBeenCalledTimes(1))
    await flushPromises()
    expect(abe.addSource).not.toHaveBeenCalled()
    expect(abe.status).toHaveBeenCalledTimes(1) // 失败不刷新状态（区别于 wrap 失败路径的 R7-M5 刷新）
    expect(w.find('button.abe-install').exists()).toBe(true)
    expect(w.text()).toContain(expected)
    // 审查 M3：failed 文案须引导看安装日志（SCM 细节只在 %ProgramData%\TotpTools\service\install.log）
    if (!ret.ok && ret.reason === 'failed') expect(w.text()).toContain('install.log')
    w.unmount()
  })

  it('bind 成功但 addSource 抛错：仍刷新 status（共 2 次，服务侧已装已绑应反映真实态），错误走消息通道', async () => {
    const abe = makeAbe({ addSource: vi.fn().mockRejectedValue(new Error('锁定代数冲突')) })
    const w = mountCard(abe)
    await vi.waitFor(() => expect(w.find('button.abe-install').exists()).toBe(true))
    await w.find('button.abe-install').trigger('click')
    await vi.waitFor(() => expect(abe.addSource).toHaveBeenCalledTimes(1))
    expect(abe.status).toHaveBeenCalledTimes(2) // 挂载 1 次 + catch 内刷新 1 次
    await vi.waitFor(() => expect(w.text()).toContain('锁定代数冲突'))
  })

  it('失配态点击重新绑定：走同一绑定序列（bind→addSource→刷新）', async () => {
    const abe = makeAbe({ status: vi.fn().mockResolvedValue({ installed: true, matchesCaller: false }) })
    const w = mountCard(abe)
    await vi.waitFor(() => expect(w.find('button.abe-rebind').exists()).toBe(true))
    await w.find('button.abe-rebind').trigger('click')
    await vi.waitFor(() => expect(abe.addSource).toHaveBeenCalledTimes(1))
    expect(abe.bind).toHaveBeenCalledTimes(1)
    expect(abe.status).toHaveBeenCalledTimes(2)
  })

  it('移除两击确认：首击仅进入确认态（文案变「确认移除」），再击执行 removeSource→remove', async () => {
    const abe = makeAbe({ status: vi.fn().mockResolvedValue(matchedStatus) })
    const w = mountCard(abe)
    const btn = () => w.find('button.remove-abe')
    await vi.waitFor(() => expect(btn().exists()).toBe(true))
    await btn().trigger('click')
    expect(abe.removeSource).not.toHaveBeenCalled()
    expect(abe.remove).not.toHaveBeenCalled()
    expect(btn().text()).toBe('确认移除')
    await btn().trigger('click')
    await vi.waitFor(() => expect(abe.remove).toHaveBeenCalledTimes(1))
    expect(abe.removeSource).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(w.text()).toContain('应用绑定解锁已移除'))
    w.unmount() // 卸载兜底清确认态 3s 定时器
  })

  it('R7-M2 remove 返回 ok:false（服务拒/不可达）：不报「已移除」，走错误提示并刷新状态', async () => {
    const abe = makeAbe({
      status: vi.fn().mockResolvedValue(matchedStatus),
      remove: vi.fn().mockResolvedValue({ ok: false, message: '本进程未通过服务验证，删除被拒' } as AbeResult),
    })
    const w = mountCard(abe)
    const btn = () => w.find('button.remove-abe')
    await vi.waitFor(() => expect(btn().exists()).toBe(true))
    await btn().trigger('click')
    await btn().trigger('click')
    await vi.waitFor(() => expect(abe.remove).toHaveBeenCalledTimes(1))
    await flushPromises()
    expect(w.text()).not.toContain('应用绑定解锁已移除')
    expect(w.text()).toContain('本进程未通过服务验证，删除被拒')
    // 半移除态（标记源已清、密文仍在场）：catch 内刷新状态呈现真实服务态（挂载 1 + 刷新 1）
    expect(abe.status).toHaveBeenCalledTimes(2)
    // message 缺失兜底：走 abeRemoveFailed 文案而非静默成功
    const abe2 = makeAbe({ status: vi.fn().mockResolvedValue(matchedStatus), remove: vi.fn().mockResolvedValue({ ok: false } as AbeResult) })
    const w2 = mountCard(abe2)
    const btn2 = () => w2.find('button.remove-abe')
    await vi.waitFor(() => expect(btn2().exists()).toBe(true))
    await btn2().trigger('click')
    await btn2().trigger('click')
    await flushPromises()
    expect(w2.text()).not.toContain('应用绑定解锁已移除')
    expect(w2.text()).toContain('服务密文移除未完成')
    w.unmount()
    w2.unmount()
  })

  it('prop 直传缺省回落 platform.abe 挂载点（desktop 工厂注入路径）', async () => {
    const abe = makeAbe()
    const w = mount(SecurityCard, {
      global: { plugins: [createTestI18n()] },
      props: { platform: makePlatform({ abe }) },
    })
    await vi.waitFor(() => expect(w.find('button.abe-install').exists()).toBe(true))
    expect(abe.status).toHaveBeenCalledTimes(1)
  })
})
