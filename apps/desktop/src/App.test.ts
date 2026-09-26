/**
 * App.vue 挂载冒烟（P4，盘点 B1/B2/B8/B12 壳层缺口）：启动全链到 NavigationShell 渲染
 * （platform 装配探针——backup 18 成员/security/cloud/mcp/devtools/release 逐成员存在性，
 * 宿主侧 .vue 无编译期覆盖，此处即回归网）、initStore 失败 → loadError 兜底（tr 回 key）、
 * force-lock → 锁定渲染 LockScreen、审批对话框联动（事件→队首→三键回执）、卸载清算。
 * LockScreen/NavigationShell 以保留 props 声明的桩替换；MCP 对话框真实渲染（Md* 桩）。
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent } from 'vue'
import { tauriMock } from '../test/mocks/tauri'
import App from './App.vue'
import McpConsentDialog from './McpConsentDialog.vue'

vi.mock('@tauri-apps/api/core', async () => (await import('../test/mocks/tauri')).invokeModule())
vi.mock('@tauri-apps/api/event', async () => (await import('../test/mocks/tauri')).eventModule())
vi.mock('@tauri-apps/api/window', async () => (await import('../test/mocks/tauri')).windowModule())
vi.mock('@tauri-apps/plugin-fs', async () => (await import('../test/mocks/tauri')).fsModule())

/** 桩保留 props/emits 声明：装配好的 platform 经 props 取出直测（同 extension optionsApp 口径） */
const NavStub = defineComponent({
  props: {
    store: { type: Object, default: null }, platform: { type: Object, default: null },
    securityPlatform: { type: Object, default: null }, cloudPlatform: { type: Object, default: null },
    icons: { type: Object, default: null }, schemesApi: { type: Object, default: null },
    railActions: { type: Array, default: () => [] }, mcpPlatform: { type: Object, default: null },
    devtoolsPlatform: { type: Object, default: null }, releasePlatform: { type: Object, default: null },
  },
  emits: ['copy'],
  template: '<div data-test="shell" />',
})
const LockScreenStub = defineComponent({
  props: { store: { type: Object, default: null }, dpapi: { type: Object, default: null } },
  emits: ['unlocked'],
  template: '<div data-test="lockscreen" />',
})
const files = new Map<string, string>()
function seedFs() {
  ;(tauriMock.fs.exists as Mock).mockImplementation(async (p: string) => files.has(p))
  ;(tauriMock.fs.readTextFile as Mock).mockImplementation(async (p: string) => files.get(p) ?? '')
  ;(tauriMock.fs.writeTextFile as Mock).mockImplementation(async (p: string, c: string) => { files.set(p, c) })
}

beforeEach(() => {
  tauriMock.reset() // 跨用例清监听/handler：各 App 实例的装配与清算相互独立
  files.clear()
  seedFs()
})

async function mountApp() {
  const wrapper = mount(App, {
    // McpConsentDialog 不注册不桩：验证 App.vue 模板经 script setup 绑定真实解析组件
    // （回归守护——若导入丢失，此处退化为未知元素，审批对话框联动用例即失败）
    global: { stubs: { NavigationShell: NavStub, LockScreen: LockScreenStub } },
  })
  await flushPromises()
  return wrapper
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('B1.1 启动全链 → NavigationShell 渲染', () => {
  it('解锁态渲染 Shell；六平台装配探针（成员逐个存在，漏接即测试失败）', async () => {
    const wrapper = await mountApp()
    const shell = wrapper.findComponent(NavStub)
    expect(shell.exists()).toBe(true)
    const p = shell.props()
    expect(p.store).not.toBeNull()
    // backupPlatform 18 成员
    for (const m of ['createBackup', 'listLocalSources', 'saveLocalSource', 'removeLocalSource', 'exportToFile', 'saveTextFile', 'saveImageFile', 'restoreFromPicker', 'listBackups', 'restoreByName', 'getAutoPrefs', 'setAutoPrefs', 'getAutoStatus', 'pickBackupDir', 'replaceAllOp', 'backupKdfProfile', 'readImportFile', 'readImportFileBytes', 'decryptDpapi']) {
      expect(p.platform, `backupPlatform.${m}`).toHaveProperty(m)
    }
    // securityPlatform 成员 + dpapi 通道
    expect(Object.keys(p.securityPlatform!)).toEqual(expect.arrayContaining(['security', 'dpapi', 'unlockNaming', 'clipboardClearEnabled', 'setClipboardClear', 'lockPrefs']))
    expect(p.securityPlatform!.dpapi).toHaveProperty('protect')
    // cloudPlatform 成员
    for (const m of ['loadSources', 'saveSources', 'saveCred', 'removeCred', 'creds', 'readVaultJson', 'persistDownloaded', 'saveConflictBackup', 'loadSourceState', 'saveSourceState', 'deviceId', 'autoPrefs', 'loadAutoStatus']) {
      expect(p.cloudPlatform, `cloudPlatform.${m}`).toHaveProperty(m)
    }
    // mcp/devtools/release 平台与 schemesApi/railActions
    expect(Object.keys(p.mcpPlatform!).sort()).toEqual(['copyText', 'getConfig', 'regenerateToken', 'revokeApprovals', 'setConfig'])
    expect(Object.keys(p.devtoolsPlatform!).sort()).toEqual(['getConfig', 'setConfig'])
    expect(Object.keys(p.releasePlatform!).sort()).toEqual(['getConfig', 'setConfig'])
    expect(p.schemesApi).toHaveProperty('load')
    expect(p.schemesApi).toHaveProperty('save')
    expect(p.railActions).toHaveLength(1)
    // 图标仓与主题就绪（icons 注入 Shell）
    expect(p.icons).not.toBeNull()
  })
})

describe('B1.2 initStore 失败 → loadError 兜底', () => {
  it('adapter 创建失败 → loadError 原始消息、Shell 不渲染；MCP 装配照常降级', async () => {
    tauriMock.fs.mkdir.mockRejectedValue(new Error('disk full'))
    const wrapper = await mountApp()
    expect(wrapper.find('[data-test="shell"]').exists()).toBe(false)
    expect(wrapper.find('.error').text()).toContain('desktop.loadFailed') // i18n 未装入：tr 兜底回 key
    expect(wrapper.text()).not.toContain('disk full') // 原始消息经模板 tr 参数展示于 i18n 装入后；失败态只回 key
    expect(tauriMock.listenerCount('mcp://req')).toBe(1) // 主流程失败不放大到 MCP 装配
  })
})

describe('B2.6 force-lock → 锁定渲染 LockScreen', () => {
  it('事件锁库 → v-if 链切到 LockScreen（dpapi 通道注入，供静默解锁）', async () => {
    const wrapper = await mountApp()
    expect(wrapper.findComponent(LockScreenStub).exists()).toBe(false)
    tauriMock.emit('force-lock', null)
    await flushPromises()
    const lock = wrapper.findComponent(LockScreenStub)
    expect(lock.exists()).toBe(true)
    expect(lock.props('dpapi')).toHaveProperty('protect') // dpapiOps 注入
    expect(lock.props('store')).not.toBeNull()
  })
})

describe('B8.29 审批对话框联动（独立于锁定 v-if 链）', () => {
  it('审批事件 → 对话框打开（锁定态也弹）→ resolve 上抛回执 mcp_approval_response', async () => {
    const wrapper = await mountApp()
    tauriMock.emit('force-lock', null) // 先锁库：审批窗独立于锁定态
    await flushPromises()
    tauriMock.emit('mcp://approval', { ident: 'conn-1', tool: 'read_x' })
    await flushPromises()
    const consent = wrapper.findComponent(McpConsentDialog)
    expect(consent.exists()).toBe(true)
    expect(consent.props('open')).toBe(true) // 队首非空 → 打开
    expect(consent.props('request')).toMatchObject({ ident: 'conn-1' })
    // 对话框按钮组→emit 链归 McpConsentDialog.test；此处断言宿主接线：resolve → 三键回执
    consent.vm.$emit('resolve', 'deny')
    await flushPromises()
    expect(tauriMock.calls('mcp_approval_response')).toHaveLength(1)
    expect(tauriMock.calls('mcp_approval_response')[0]?.args).toEqual({ ident: 'conn-1', action: 'deny' })
  })

  it('空队列 → 对话框不打开', async () => {
    const wrapper = await mountApp()
    expect(wrapper.findComponent(McpConsentDialog).props('open')).toBe(false)
  })
})

describe('B1.4 卸载清算', () => {
  it('unmount → 7 类监听全移除、未决工具确认回 false', async () => {
    const wrapper = await mountApp()
    tauriMock.emit('mcp://tool-approval', { id: 5, ident: 'conn-5', tool: 't' }) // 留未决
    wrapper.unmount()
    for (const e of ['system-lock', 'force-lock', 'stash-dek-request', 'mcp://req', 'mcp://approval', 'mcp://tool-approval']) {
      expect(tauriMock.listenerCount(e)).toBe(0)
    }
    expect(tauriMock.calls('mcp_respond')).toHaveLength(1) // dispose → 未决回 result:false
    expect(tauriMock.calls('mcp_respond')[0]?.args).toMatchObject({ id: 5, ok: true, result: false, error: null })
  })
})
