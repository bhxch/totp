import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import McpServerCard from '../src/components/McpServerCard.vue'
import type { McpConfigDto, McpConfigWithStatusDto } from '../src/components/mcpCard'
import { createTestI18n } from './helpers/i18n'

/** 基线配置（含运行态 DTO）：exposedTools 齐全，运行中 */
function baseCfg(over: Partial<McpConfigWithStatusDto> = {}): McpConfigWithStatusDto {
  return {
    enabled: true, mode: 'wildcard', port: 47215, token: 'tok-123', whitelist: ['Claude*'],
    exposedTools: ['list_accounts', 'get_code'], running: true, lastError: null, ...over,
  }
}

type MockPlatform = {
  getConfig: ReturnType<typeof vi.fn>
  setConfig: ReturnType<typeof vi.fn>
  regenerateToken: ReturnType<typeof vi.fn>
  revokeApprovals: ReturnType<typeof vi.fn>
  copyText: ReturnType<typeof vi.fn>
}

function mkPlatform(cfg: McpConfigWithStatusDto = baseCfg(), over: Partial<MockPlatform> = {}): MockPlatform {
  return {
    getConfig: vi.fn().mockResolvedValue(cfg),
    setConfig: vi.fn().mockResolvedValue(undefined),
    regenerateToken: vi.fn().mockResolvedValue('new-token'),
    revokeApprovals: vi.fn().mockResolvedValue(3),
    copyText: vi.fn().mockResolvedValue(undefined),
    ...over,
  }
}

async function mountCard(platform: MockPlatform): Promise<VueWrapper> {
  const w = mount(McpServerCard, { global: { plugins: [createTestI18n()] }, props: { platform } })
  await flushPromises()
  return w
}

function payloadOf(platform: MockPlatform, call = 0): McpConfigDto {
  return platform.setConfig.mock.calls[call]![0] as McpConfigDto
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('McpServerCard persist 全链（乐观前进→对账→双失败回滚）', () => {
  it('开关乐观前进：cfg 立即变更，setConfig 后经 getConfig 对账刷新运行态', async () => {
    const cfg = baseCfg({ enabled: true })
    const platform = mkPlatform(cfg)
    // setConfig 成功后服务端配置翻转（对账依据）
    platform.setConfig.mockImplementation(async () => {
      platform.getConfig.mockResolvedValue({ ...cfg, enabled: false, running: false })
    })
    const w = await mountCard(platform)
    await w.find('.mcp-enable input').setValue(false)
    // 乐观前进：setConfig 尚未被调用前 cfg.enabled 已置 false（busy 期 disabled 断言顺带覆盖）
    expect((w.find('.mcp-enable input').element as HTMLInputElement).checked).toBe(false)
    await vi.runAllTimersAsync()
    await flushPromises()
    expect(platform.setConfig).toHaveBeenCalledTimes(1)
    expect(payloadOf(platform).enabled).toBe(false)
    expect(platform.getConfig).toHaveBeenCalledTimes(2) // 挂载 1 次 + persist 后对账 1 次
    expect(w.text()).toContain('已停止') // 对账后的运行态渲染
  })

  it('setConfig 失败但重查成功：以服务端返回为准对账（Rust 侧可能已落盘/停服）', async () => {
    const cfg = baseCfg({ enabled: true })
    const platform = mkPlatform(cfg)
    platform.setConfig.mockRejectedValue('port in use')
    platform.getConfig.mockResolvedValueOnce(cfg).mockResolvedValue({ ...cfg, enabled: false, running: false })
    const w = await mountCard(platform)
    await w.find('.mcp-enable input').setValue(false)
    await vi.runAllTimersAsync()
    await flushPromises()
    expect(w.find('p[role="alert"]').text()).toContain('操作失败') // 错误横幅可见
    expect(w.text()).toContain('已停止') // 但对账结果被采纳，不回滚
    expect((w.find('.mcp-enable input').element as HTMLInputElement).checked).toBe(false)
  })

  it('setConfig 与重查双失败：回滚 prev（mode 与端口输入均回基线）', async () => {
    const cfg = baseCfg({ port: 47215 })
    const platform = mkPlatform(cfg)
    platform.setConfig.mockRejectedValue(new Error('boom'))
    platform.getConfig.mockResolvedValueOnce(cfg).mockRejectedValue(new Error('refetch boom'))
    const w = await mountCard(platform)
    await w.find('button[aria-label="客户端授权档位"]').trigger('click')
    await w.findAll('[role="option"]').find((o) => o.text().includes('每次连接'))!.trigger('click')
    await vi.runAllTimersAsync()
    await flushPromises()
    // 双失败：cfg 回滚 prev（mode 恢复 wildcard），错误横幅保留首笔错误（重查失败不覆写已有错误）
    expect(w.find('button[aria-label="客户端授权档位"]').text()).toContain('白名单通配符')
    expect((w.find('.port-field input').element as HTMLInputElement).value).toBe('47215')
    expect(w.find('p[role="alert"]').text()).toContain('操作失败：boom')
  })

  it('端口：逐键只改显示（input 不提交），change（失焦）提交合法值，同值不提交', async () => {
    const platform = mkPlatform(baseCfg())
    const w = await mountCard(platform)
    const port = w.find('.port-field input')
    ;(port.element as HTMLInputElement).value = '4799'
    await port.trigger('input')
    expect(platform.setConfig).not.toHaveBeenCalled() // 输入过程不提交
    await port.trigger('change')
    await flushPromises()
    expect(platform.setConfig).toHaveBeenCalledTimes(1)
    expect(payloadOf(platform).port).toBe(4799)
    // 对账后同值 change：不提交
    await port.trigger('change')
    expect(platform.setConfig).toHaveBeenCalledTimes(1)
  })

  it('端口非法（空/非整数/越界）：回显基线并提示，不提交', async () => {
    const platform = mkPlatform(baseCfg({ port: 47215 }))
    const w = await mountCard(platform)
    for (const bad of ['', '80', '65536', '12.5']) {
      const input = w.find('.port-field input')
      ;(input.element as HTMLInputElement).value = bad
      await input.trigger('input')
      await input.trigger('change')
      await nextTick()
      expect(w.text()).toContain('端口须为 1024–65535 的整数')
      expect((w.find('.port-field input').element as HTMLInputElement).value).toBe('47215')
    }
    expect(platform.setConfig).not.toHaveBeenCalled()
  })

  it('随机端口按钮：走 change 同路径提交，值落在 IANA 动态段', async () => {
    const platform = mkPlatform(baseCfg())
    const w = await mountCard(platform)
    await w.find('button.random-port').trigger('click')
    await flushPromises()
    expect(platform.setConfig).toHaveBeenCalledTimes(1)
    const p = payloadOf(platform).port
    expect(p).toBeGreaterThanOrEqual(49152)
    expect(p).toBeLessThanOrEqual(65535)
  })

  it('busy 防重入：persist 进行中再次触发不叠发 setConfig', async () => {
    const cfg = baseCfg()
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const platform = mkPlatform(cfg, { setConfig: vi.fn().mockReturnValue(gate) })
    const w = await mountCard(platform)
    await w.find('.mcp-enable input').setValue(false) // 第一笔在途
    await w.find('button.random-port').trigger('click') // 第二笔应被 busy 拒绝
    release()
    await vi.runAllTimersAsync()
    await flushPromises()
    expect(platform.setConfig).toHaveBeenCalledTimes(1)
  })
})

describe('McpServerCard 白名单增删', () => {
  it('添加：trim 非空入列并整体回写；空白/大小写重复不入列不提交', async () => {
    const platform = mkPlatform(baseCfg({ whitelist: ['Claude*'] }))
    const w = await mountCard(platform)
    const input = w.find('.pattern-input input')
    // 大小写不敏感重复：不加不提交
    await input.setValue(' claude* ')
    await w.findAll('.pattern-add button').find((b) => b.text() === '添加')!.trigger('click')
    expect(platform.setConfig).not.toHaveBeenCalled()
    // 新增：入列、输入框清空、回写载荷携带新白名单
    await input.setValue('Cursor*')
    await w.findAll('.pattern-add button').find((b) => b.text() === '添加')!.trigger('click')
    await flushPromises()
    expect(platform.setConfig).toHaveBeenCalledTimes(1)
    expect(payloadOf(platform).whitelist).toEqual(['Claude*', 'Cursor*'])
    expect((input.element as HTMLInputElement).value).toBe('')
  })

  it('删除：逐条移除并整体回写', async () => {
    const platform = mkPlatform(baseCfg({ whitelist: ['Claude*', 'Cursor*'] }))
    const w = await mountCard(platform)
    await w.findAll('.pattern-row button').find((b) => b.text() === '移除')!.trigger('click')
    await flushPromises()
    expect(payloadOf(platform).whitelist).toEqual(['Cursor*'])
  })
})

describe('McpServerCard token 与一次性授权', () => {
  it('token 显隐切换；复制走宿主 copyText 并闪现「已复制」2s 后消失', async () => {
    const platform = mkPlatform(baseCfg({ token: 'plain-tok' }))
    const w = await mountCard(platform)
    expect(w.find('.token-value').text()).toBe('••••')
    const showBtn = w.findAll('.token-block button').find((b) => b.text() === '显示')!
    await showBtn.trigger('click')
    expect(w.find('.token-value').text()).toBe('plain-tok')
    const copyBtn = w.findAll('.token-block button').find((b) => b.text() === '复制 Token')!
    await copyBtn.trigger('click')
    await flushPromises()
    expect(platform.copyText).toHaveBeenCalledWith('plain-tok')
    expect(w.text()).toContain('已复制')
    await vi.advanceTimersByTimeAsync(2000)
    expect(w.text()).not.toContain('已复制')
  })

  it('复制连接片段：copyText 收到 JSON 片段（含端口与 Bearer token）', async () => {
    const platform = mkPlatform(baseCfg())
    const w = await mountCard(platform)
    await w.findAll('button').find((b) => b.text() === '复制配置')!.trigger('click')
    await flushPromises()
    const arg = String(platform.copyText.mock.calls[0]![0])
    expect(arg).toContain('127.0.0.1:47215/mcp')
    expect(arg).toContain('Bearer tok-123')
  })

  it('copyText 失败：错误横幅（fail 通道）', async () => {
    const platform = mkPlatform(baseCfg(), { copyText: vi.fn().mockRejectedValue(new Error('clipboard busy')) })
    const w = await mountCard(platform)
    await w.findAll('button').find((b) => b.text() === '复制配置')!.trigger('click')
    await flushPromises()
    expect(w.text()).toContain('操作失败')
    expect(w.text()).toContain('clipboard busy')
  })

  it('重新生成两步：取消不调用；确认后重查刷新 token 掩码与运行态', async () => {
    const cfg = baseCfg()
    const platform = mkPlatform(cfg)
    platform.regenerateToken.mockImplementation(async () => {
      platform.getConfig.mockResolvedValue({ ...cfg, token: 'brand-new' })
      return 'brand-new'
    })
    const w = await mountCard(platform)
    await w.findAll('.token-block button').find((b) => b.text() === '重新生成')!.trigger('click')
    expect(w.text()).toContain('重新生成会使现有客户端连接失效')
    await w.findAll('.confirm-row button').find((b) => b.text() === '取消')!.trigger('click')
    expect(platform.regenerateToken).not.toHaveBeenCalled()
    await w.findAll('.token-block button').find((b) => b.text() === '重新生成')!.trigger('click')
    await w.findAll('.confirm-row button').find((b) => b.text() === '确认重新生成')!.trigger('click')
    await flushPromises()
    expect(platform.regenerateToken).toHaveBeenCalledTimes(1)
    expect(platform.getConfig).toHaveBeenCalledTimes(2) // 对账刷新
    const showBtn = w.findAll('.token-block button').find((b) => b.text() === '显示')!
    await showBtn.trigger('click')
    expect(w.find('.token-value').text()).toBe('brand-new')
  })

  it('清除一次性授权两步：确认后返回清除条数并闪现「已清除 3 项」', async () => {
    const platform = mkPlatform(baseCfg())
    const w = await mountCard(platform)
    await w.findAll('.revoke-block button').find((b) => b.text() === '清除一次性授权')!.trigger('click')
    expect(w.text()).toContain('将清空全部「仅本次」批准')
    await w.findAll('.confirm-row button').find((b) => b.text() === '确认清除')!.trigger('click')
    await flushPromises()
    expect(platform.revokeApprovals).toHaveBeenCalledTimes(1)
    expect(w.text()).toContain('已清除 3 项')
  })

  it('revokeApprovals 失败：错误横幅且 busy 复位（可再次点击）', async () => {
    const platform = mkPlatform(baseCfg(), { revokeApprovals: vi.fn().mockRejectedValue(new Error('rpc lost')) })
    const w = await mountCard(platform)
    await w.findAll('.revoke-block button').find((b) => b.text() === '清除一次性授权')!.trigger('click')
    await w.findAll('.confirm-row button').find((b) => b.text() === '确认清除')!.trigger('click')
    await flushPromises()
    expect(w.text()).toContain('rpc lost')
    // busy 已复位：再点仍可发起（两步行再现）
    await w.findAll('.revoke-block button').find((b) => b.text() === '清除一次性授权')!.trigger('click')
    expect(w.text()).toContain('将清空全部「仅本次」批准')
  })
})

describe('McpServerCard 复制闪现与守卫补遗', () => {
  it('copyText 拒绝非 Error 值（字符串 reject）：fail 兜底 String 展示', async () => {
    const platform = mkPlatform(baseCfg(), { copyText: vi.fn().mockRejectedValue('clipboard locked') })
    const w = await mountCard(platform)
    await w.findAll('button').find((b) => b.text() === '复制 Token')!.trigger('click')
    await flushPromises()
    expect(w.find('p[role="alert"]').text()).toContain('clipboard locked')
  })

  it('2s 内连续闪现不同 copied：新闪现重置旧计时器，到期一并归位 none', async () => {
    const platform = mkPlatform(baseCfg())
    const w = await mountCard(platform)
    await w.findAll('.token-block button').find((b) => b.text() === '复制 Token')!.trigger('click')
    await flushPromises()
    await w.findAll('button').find((b) => b.text() === '复制配置')!.trigger('click')
    await flushPromises()
    expect(platform.copyText).toHaveBeenCalledTimes(2)
    expect(w.text()).toContain('已复制')
    await vi.advanceTimersByTimeAsync(2000)
    expect(w.text()).not.toContain('已复制')
  })

  it('重新生成确认后行内两步面板即收起（pendingRegen 复位），完成后 token 刷新', async () => {
    const cfg = baseCfg()
    let release!: () => void
    const gate = new Promise<string>((r) => { release = () => r('new-token') })
    const platform = mkPlatform(cfg, { regenerateToken: vi.fn().mockReturnValue(gate) })
    const w = await mountCard(platform)
    await w.findAll('.token-block button').find((b) => b.text() === '重新生成')!.trigger('click')
    await w.findAll('.confirm-row button').find((b) => b.text() === '确认重新生成')!.trigger('click')
    expect(w.find('.confirm-row').exists()).toBe(false) // 受理即收起，防重复确认
    release()
    await vi.runAllTimersAsync()
    await flushPromises()
    expect(platform.regenerateToken).toHaveBeenCalledTimes(1)
  })

  it('busy 期间工具勾选不触发回写（防重入）', async () => {
    const cfg = baseCfg()
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const platform = mkPlatform(cfg, { setConfig: vi.fn().mockReturnValue(gate) })
    const w = await mountCard(platform)
    const boxes = w.findAll('.tool-check input')
    await boxes[2]!.setValue(true) // 第一笔：进入在途（gate 挂起）
    expect(platform.setConfig).toHaveBeenCalledTimes(1)
    await boxes[3]!.setValue(true) // 在途期间再勾选 → persist 守卫拒绝
    expect(platform.setConfig).toHaveBeenCalledTimes(1) // 不叠发
    release()
    await vi.runAllTimersAsync()
    await flushPromises()
    expect(platform.setConfig).toHaveBeenCalledTimes(1)
  })
})

describe('McpServerCard 挂载失败', () => {
  it('getConfig 失败：错误横幅 + 空卡（无任何配置区）', async () => {
    const platform = mkPlatform()
    platform.getConfig.mockRejectedValue(new Error('ipc down'))
    const w = await mountCard(platform)
    expect(w.find('p[role="alert"]').text()).toContain('ipc down')
    expect(w.find('.exposed-tools').exists()).toBe(false)
    expect(w.find('.mcp-enable').exists()).toBe(false)
  })
})
