import { describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { zipSync } from 'fflate'
import { createMemoryStorage, getBuiltinIcons, type OtpEntry } from '@totp/core'
import EntryForm from '../src/components/EntryForm.vue'
import { type EntryFormData, validateRegex } from '../src/components/entryForm'
import { createIconStore } from '../src/iconStore'

const entry: OtpEntry = {
  uuid: 'u1', type: 'totp', issuer: 'GitHub', label: 'me@ex.com', secret: 'JBSWY3DPEHPK3PXP',
  algorithm: 'SHA1', digits: 6, period: 30, groupIds: [], order: 0, createdAt: 0,
}

// jsdom 25 的 Blob 未实现 arrayBuffer()，用 FileReader polyfill（仅测试环境生效）
if (typeof Blob.prototype.arrayBuffer !== 'function') {
  Blob.prototype.arrayBuffer = function (this: Blob): Promise<ArrayBuffer> {
    return new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as ArrayBuffer)
      reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'))
      reader.readAsArrayBuffer(this)
    })
  }
}

describe('EntryForm', () => {
  it('编辑模式回填字段，save 携带全部数据', async () => {
    const w = mount(EntryForm, { props: { initial: entry, groups: [] } })
    await w.find('form').trigger('submit')
    const payload = w.emitted('save')![0]![0]
    expect(payload).toMatchObject({ type: 'totp', issuer: 'GitHub', label: 'me@ex.com', secret: 'JBSWY3DPEHPK3PXP', note: '', groupIds: [], matchRules: [] })
  })
  it('非法 secret 显示错误且不 emit save', async () => {
    const w = mount(EntryForm, { props: { initial: null, groups: [] } })
    await w.find('input[placeholder="密钥 base32"]').setValue('AB01') // 0/1 非法
    await w.find('form').trigger('submit')
    expect(w.emitted('save')).toBeUndefined()
    expect(w.text()).toContain('base32')
  })
  it('分组 checkbox 勾选写入 groupIds', async () => {
    const w = mount(EntryForm, { props: { initial: null, groups: [{ id: 'g1', name: '工作', order: 0 }] } })
    await w.find('input[type="checkbox"]').setValue(true)
    await w.find('form').trigger('submit')
    expect(w.emitted('save')![0]![0]).toMatchObject({ groupIds: ['g1'] })
  })
  it('编辑既有条目：type 下拉始终含 totp/hotp/steam 三选项（C15 解除 type 锁定）', async () => {
    const w = mount(EntryForm, { props: { initial: { ...entry, type: 'hotp' }, groups: [] } })
    const select = w.find('select')
    // 取消 :disabled：type 现在可自由切换（type 变更时 digits 会自动重算）
    expect(select.attributes('disabled')).toBeUndefined()
    expect(select.html()).toContain('totp')
    expect(select.html()).toContain('hotp')
    expect(select.html()).toContain('steam')
  })
  it('表单编辑既有 hotp：算法/位数/计数器编辑控件可见且 save 携带', async () => {
    const hotpEntry = { ...entry, type: 'hotp' as const, counter: 3, digits: 6, algorithm: 'SHA256' as const }
    const w = mount(EntryForm, { props: { initial: hotpEntry, groups: [] } })
    expect(w.find('select.algorithm').exists()).toBe(true)
    expect(w.find('input.digits').exists()).toBe(true)
    // hotp 类型显示计数器；不显示周期
    expect(w.find('input.counter').exists()).toBe(true)
    expect(w.find('input.period').exists()).toBe(false)
    await w.find('form').trigger('submit')
    const payload = w.emitted('save')![0]![0]
    expect(payload).toMatchObject({ algorithm: 'SHA256', digits: 6, counter: 3, type: 'hotp' })
  })
  it('表单 totp：周期输入可见且默认 30；save 携带 period 与 algorithm，不带 counter', async () => {
    const w = mount(EntryForm, { props: { initial: entry, groups: [] } })
    expect(w.find('input.period').exists()).toBe(true)
    expect(w.find('input.counter').exists()).toBe(false) // 非 hotp 不显示 counter
    await w.find('form').trigger('submit')
    const payload = w.emitted('save')![0]![0]
    expect(payload).toMatchObject({ algorithm: 'SHA1', digits: 6, period: 30 })
    expect(payload.counter).toBeUndefined()
  })
  it('steam 类型：digits 改 6 提交时报错；counter 编辑器不显示', async () => {
    const w = mount(EntryForm, { props: { initial: null, groups: [] } })
    await w.find('select').setValue('steam')
    await w.find('input[placeholder="密钥 base32"]').setValue('JBSWY3DPEHPK3PXP')
    // steam 显示周期与位数；不显示 counter
    expect(w.find('input.period').exists()).toBe(true)
    expect(w.find('input.counter').exists()).toBe(false)
    expect(w.text()).toContain('Steam 类型位数固定为 5')
    await w.find('input.digits').setValue(6)
    await w.find('form').trigger('submit')
    expect(w.emitted('save')).toBeUndefined()
    expect(w.text()).toContain('Steam')
  })
  it('添加/编辑/删除 matchRule 并随 save 提交', async () => {
    const w = mount(EntryForm, { props: { initial: entry, groups: [] } })
    await w.find('button.add-rule').trigger('click')
    const selects = w.findAll('select.rule-strategy')
    expect(selects).toHaveLength(1)
    await selects[0]!.setValue('baseDomain')
    await w.find('input.rule-pattern').setValue('github.com')
    await w.find('form').trigger('submit')
    expect(w.emitted('save')![0]![0]).toMatchObject({ matchRules: [{ strategy: 'baseDomain', pattern: 'github.com' }] })
    await w.find('button.rm-rule').trigger('click')
    await w.find('form').trigger('submit')
    expect(w.emitted('save')!.at(-1)![0]).toMatchObject({ matchRules: [] })
  })

  it('I51：matchRules strategy=regex 非法 pattern 阻止 save + 行内错误 + class.invalid', async () => {
    const w = mount(EntryForm, { props: { initial: entry, groups: [] } })
    await w.find('button.add-rule').trigger('click')
    await w.findAll('select.rule-strategy')[0]!.setValue('regex')
    await w.find('input.rule-pattern').setValue('[unbalanced') // 非法正则
    // 行内错误展示 + class.invalid
    expect(w.find('.rule-pattern.invalid').exists()).toBe(true)
    expect(w.find('.rule-error').exists()).toBe(true)
    expect(w.text()).toMatch(/正则/)
    // 提交应被阻止，不 emit save
    await w.find('form').trigger('submit')
    expect(w.emitted('save')).toBeUndefined()
    expect(w.find('.error').text()).toMatch(/匹配规则正则非法/)
    // 修正为合法正则后可提交
    await w.find('input.rule-pattern').setValue('^https://github\\.com/.*')
    await w.find('form').trigger('submit')
    expect(w.emitted('save')![0]![0]).toMatchObject({ matchRules: [{ strategy: 'regex', pattern: '^https://github\\.com/.*' }] })
  })

  it('I51：validateRegex 纯函数空串合法；非法返回错误；合法返回 null', () => {
    expect(validateRegex('')).toBeNull()
    expect(validateRegex('   ')).toBeNull()
    expect(validateRegex('^foo.*$')).toBeNull()
    expect(validateRegex('[abc')).not.toBeNull()
    expect(validateRegex('*star')).not.toBeNull()
  })
  it('secret 默认遮蔽（type=password），toggle 切换显示/隐藏', async () => {
    const w = mount(EntryForm, { props: { initial: null, groups: [] } })
    const secret = () => w.find('input[placeholder="密钥 base32"]')
    expect(secret().attributes('type')).toBe('password')
    await w.find('button.secret-toggle').trigger('click')
    expect(secret().attributes('type')).toBe('text')
    await w.find('button.secret-toggle').trigger('click')
    expect(secret().attributes('type')).toBe('password')
  })

  it('I68：base32 实时校验——输入非法字符立即触发 class.invalid 与 inline hint（不阻塞输入）', async () => {
    const w = mount(EntryForm, { props: { initial: null, groups: [] } })
    const secret = () => w.find('input[placeholder="密钥 base32"]')
    // 初始空串 → 合法（无错误）
    expect(secret().classes()).not.toContain('invalid')
    expect(w.find('.base32-hint').exists()).toBe(false)
    // 输入含 0/1 等非法字符 → 标记 invalid + 显示 hint
    await secret().setValue('AB01')
    expect(secret().classes()).toContain('invalid')
    expect(w.text()).toContain('密钥字符仅允许 A–Z 与 2–7')
    // 修正为合法 base32 → 错误消失
    await secret().setValue('JBSWY3DPEHPK3PXP')
    expect(secret().classes()).not.toContain('invalid')
    expect(w.find('.base32-hint').exists()).toBe(false)
  })

  it('I67：recommendTimer 在组件卸载时清理（防 setTimeout 在 unmount 后写 ref）', async () => {
    const w = mount(EntryForm, { props: { initial: null, groups: [], icons: { builtin: getBuiltinIcons(), stored: {} } } })
    await w.find('input[placeholder="服务名（如 GitHub）"]').setValue('github')
    // 立即 unmount（防抖 300ms 还未触发）
    w.unmount()
    // 等若干 tick 让原 setTimeout 触发；不应抛出（onScopeDispose 已清理）
    await new Promise((r) => setTimeout(r, 400))
  })
  it('遮蔽下 secret 值仍可输入并随 save 提交', async () => {
    const w = mount(EntryForm, { props: { initial: null, groups: [] } })
    await w.find('input[placeholder="密钥 base32"]').setValue('jbswy3dpehpk3pxp')
    await w.find('form').trigger('submit')
    expect(w.emitted('save')![0]![0]).toMatchObject({ secret: 'JBSWY3DPEHPK3PXP' })
  })
})

describe('EntryForm 图标推荐与选择', () => {
  const icons = () => ({ builtin: getBuiltinIcons(), stored: {} as Readonly<Record<string, string>> })
  const issuerInput = (w: VueWrapper) => w.find('input[placeholder="服务名（如 GitHub）"]')

  it('issuer 输入 github 防抖后出现推荐气泡，点「使用」后 save 携带 builtin icon', async () => {
    const w = mount(EntryForm, { props: { initial: null, groups: [], icons: icons() } })
    expect(w.text()).not.toContain('检测到图标')
    await issuerInput(w).setValue('github')
    // 300ms 防抖后才显示推荐
    await vi.waitFor(() => expect(w.text()).toContain('检测到图标'))
    expect(w.find('.icon-recommend svg.icon-preview').exists()).toBe(true)
    await w.find('button.use-recommend-icon').trigger('click')
    expect(w.text()).not.toContain('检测到图标')
    await w.find('form').trigger('submit')
    expect(w.emitted('save')![0]![0]).toMatchObject({ icon: { kind: 'builtin', id: 'github' } })
  })

  it('issuer 无匹配时不显示推荐气泡', async () => {
    const w = mount(EntryForm, { props: { initial: null, groups: [], icons: icons() } })
    await issuerInput(w).setValue('zzz-不存在的服务')
    await new Promise((r) => setTimeout(r, 400)) // 越过 300ms 防抖
    expect(w.text()).not.toContain('检测到图标')
  })

  it('图标选择区默认收起，展示当前图标（builtin→svg），清除后 save 不携带 icon', async () => {
    const w = mount(EntryForm, {
      props: { initial: { ...entry, icon: { kind: 'builtin', id: 'github' } }, groups: [], icons: icons() },
    })
    const picker = w.find('details.icon-picker')
    expect(picker.exists()).toBe(true)
    expect((picker.element as HTMLDetailsElement).open).toBe(false)
    // 已有图标不弹推荐
    await issuerInput(w).setValue('github')
    await new Promise((r) => setTimeout(r, 400))
    expect(w.text()).not.toContain('检测到图标')
    await picker.find('summary').trigger('click')
    expect(picker.find('svg.icon-preview').exists()).toBe(true)
    await w.find('button.clear-icon').trigger('click')
    await w.find('form').trigger('submit')
    expect((w.emitted('save')![0]![0] as EntryFormData).icon).toBeUndefined()
  })

  it('URL 拉取成功后预览并随 save 携带 {kind:url}；清除按钮收起已设图标', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, blob: async () => new Blob(['png-bytes'], { type: 'image/png' }) })))
    try {
      const store = createIconStore(createMemoryStorage())
      const w = mount(EntryForm, { props: { initial: null, groups: [], icons: { builtin: getBuiltinIcons(), stored: store.icons }, iconStore: store } })
      await w.find('details.icon-picker summary').trigger('click')
      await w.find('input.icon-url').setValue('https://example.com/a.png')
      await w.find('button.fetch-icon').trigger('click')
      await vi.waitFor(() => expect(w.find('img.icon-current-img').attributes('src')).toMatch(/^data:image\/png;base64,/))
      await w.find('form').trigger('submit')
      expect(w.emitted('save')![0]![0]).toMatchObject({ icon: { kind: 'url', url: 'https://example.com/a.png' } })
      // store 内以 urlcache:<id> 缓存（I58：独立命名空间）
      expect(Object.keys(store.icons).some((k) => k.startsWith('urlcache:'))).toBe(true)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('URL 拉取失败显示错误提示且不设置 icon', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, blob: async () => new Blob([]) })))
    try {
      const store = createIconStore(createMemoryStorage())
      const w = mount(EntryForm, { props: { initial: null, groups: [], icons: { builtin: getBuiltinIcons(), stored: store.icons }, iconStore: store } })
      await w.find('details.icon-picker summary').trigger('click')
      await w.find('input.icon-url').setValue('https://example.com/a.png')
      await w.find('button.fetch-icon').trigger('click')
      await vi.waitFor(() => expect(w.text()).toContain('图标拉取失败'))
      await w.find('form').trigger('submit')
      expect((w.emitted('save')![0]![0] as EntryFormData).icon).toBeUndefined()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('导入图标包（zip）：busy 态期间按钮禁用，完成批量入库并提示已导入/跳过数；非法 zip 显示错误', async () => {
    const store = createIconStore(createMemoryStorage())
    const w = mount(EntryForm, { props: { initial: null, groups: [], icons: { builtin: getBuiltinIcons(), stored: store.icons }, iconStore: store } })
    await w.find('details.icon-picker summary').trigger('click')
    expect(w.find('button.import-pack').exists()).toBe(true)
    const setFiles = (el: HTMLInputElement, file: File) => {
      Object.defineProperty(el, 'files', { value: [file], configurable: true })
    }
    // 合法 zip：任意字节当 png 内容即可（导入不校验图片内容）；实例上覆写 arrayBuffer 加闸门观察 busy 态
    const zip = zipSync({ 'a/github.png': new Uint8Array([1]), 'b/google.png': new Uint8Array([2]) })
    const file = new File([zip], 'pack.zip')
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    ;(file as File & { arrayBuffer: () => Promise<ArrayBuffer> }).arrayBuffer = async () => {
      await gate
      return zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength) as ArrayBuffer
    }
    const packInputEl = () => w.find('input.pack-file').element as HTMLInputElement
    setFiles(packInputEl(), file)
    await w.find('input.pack-file').trigger('change')
    expect(w.find('button.import-pack').attributes('disabled')).toBeDefined()
    release()
    await vi.waitFor(() => expect(w.find('.pack-message').text()).toBe('已导入 2 个图标（跳过 0 个）'))
    expect(w.find('button.import-pack').attributes('disabled')).toBeUndefined()
    expect(store.icons['github']).toMatch(/^data:image\/png;base64,/)
    expect(store.icons['google']).toMatch(/^data:image\/png;base64,/)
    // 非法 zip：unzipSync 抛错 → 图标区错误提示，成功提示清空
    setFiles(packInputEl(), new File([new Uint8Array([1, 2, 3])], 'bad.zip'))
    await w.find('input.pack-file').trigger('change')
    await vi.waitFor(() => expect(w.find('.icon-picker .error').exists()).toBe(true))
    expect(w.find('.pack-message').exists()).toBe(false)
  })
})

describe('EntryForm 预填哑值 uuid（URI 导入）边界', () => {
  it('uuid 为空串的预填对象按新建处理：提交按钮显示「添加」', () => {
    const w = mount(EntryForm, { props: { initial: { ...entry, uuid: '' }, groups: [] } })
    expect(w.find('button[type="submit"]').text()).toBe('添加')
  })

  it('uuid 非空的编辑对象提交按钮显示「保存」', () => {
    const w = mount(EntryForm, { props: { initial: entry, groups: [] } })
    expect(w.find('button[type="submit"]').text()).toBe('保存')
  })

  it('预填对象拉取图标不以空串为存储键（?? 对 falsy 空串不兜底的回归）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, blob: async () => new Blob(['png-bytes'], { type: 'image/png' }) })))
    try {
      const store = createIconStore(createMemoryStorage())
      const w = mount(EntryForm, {
        props: { initial: { ...entry, uuid: '' }, groups: [], icons: { builtin: getBuiltinIcons(), stored: store.icons }, iconStore: store },
      })
      await w.find('details.icon-picker summary').trigger('click')
      await w.find('input.icon-url').setValue('https://example.com/a.png')
      await w.find('button.fetch-icon').trigger('click')
      await vi.waitFor(() => expect(w.find('img.icon-current-img').attributes('src')).toMatch(/^data:image\/png;base64,/))
      const keys = Object.keys(store.icons)
      expect(keys).toHaveLength(1)
      expect(keys[0]).toMatch(/^urlcache:.+/) // urlcache: 后必须跟非空 id，否则连续预填共享空串键互相覆盖
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
