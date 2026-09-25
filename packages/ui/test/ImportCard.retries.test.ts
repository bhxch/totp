import { describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { base32Decode, buildWinauthSequence, newEntryFromUri, type ImportScheme } from '@totp/core'
import { zipSync, strToU8 } from 'fflate'
import { createVueStore } from '../src/store'
import ImportCard from '../src/components/ImportCard.vue'
import { createTestI18n } from './helpers/i18n'

async function pickOption(w: VueWrapper, ariaLabel: string, label: string): Promise<void> {
  await w.find(`button[aria-label="${ariaLabel}"]`).trigger('click')
  await w.findAll('[role="option"]').find((o) => o.text() === label)!.trigger('click')
}

async function readyStore() {
  const s = createVueStore(createMemoryStorageShim())
  await s.initStore()
  await s.addEntryOp(newEntryFromUri('otpauth://totp/GitHub:me@x.com?secret=JBSWY3DPEHPK3PXP', 0))
  return s
}

// createMemoryStorage 直接自 @totp/core 取（避免与本文件其他导入混淆，独立 shim 包装）
import { createMemoryStorage } from '@totp/core'
function createMemoryStorageShim() {
  return createMemoryStorage()
}

// ---------- WinAuth 口令加密 fixture（与 core test/winauthImport.test.ts 同构，零盐/零填充位保证确定性） ----------
const hex = (bytes: Uint8Array): string => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s)
const SECRET_HEX = hex(base32Decode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'))
const ENTRY_XML = '<authenticatordata><servertimediff>0</servertimediff><lastservertime>0</lastservertime>' +
  `<secretdata>${SECRET_HEX}\t6\tSHA1\t30</secretdata></authenticatordata>`

async function winauthPasswordXml(): Promise<string> {
  const payloadHex = hex(utf8(ENTRY_XML))
  const seq = await buildWinauthSequence(payloadHex, 'y', 'right-pass')
  return `<WinAuth version="3.2.0.0"><WinAuthAuthenticator type="WinAuth.GoogleAuthenticator"><name>WinAuthSvc:w@x.com</name><authenticatordata encrypted="y">${seq}</authenticatordata></WinAuthAuthenticator></WinAuth>`
}

describe('ImportCard 口令重试链（retryPasswordOnNeed）', () => {
  it('winauth 空口令解析出「需要口令」失败 → 回口令页提示；输入口令重试成功', async () => {
    const store = await readyStore()
    const xml = await winauthPasswordXml()
    const w = mount(ImportCard, { global: { plugins: [createTestI18n()] },
      props: { platform: { readImportFile: vi.fn().mockResolvedValue({ text: xml, name: 'x.wauth' }), store } } })
    await w.find('button.import-start').trigger('click')
    await vi.waitFor(() => expect(w.text()).toContain('winauth'))
    await w.find('button.import-next').trigger('click') // → 口令页
    await vi.waitFor(() => expect(w.text()).toContain('WinAuth 文件可能受口令保护'))
    await w.find('button.import-next').trigger('click') // 空口令 → 结构可解但逐条「需要口令」→ 回口令页
    await vi.waitFor(() => expect(w.text()).toContain('该文件包含口令保护条目'))
    expect(w.find('button.import-commit').exists()).toBe(false) // 未误进确认页
    await w.find('.import-password input').setValue('right-pass')
    await w.find('button.import-next').trigger('click')
    await vi.waitFor(() => expect(w.text()).toContain('冲突')) // 口令正确 → 确认页
    await w.find('button.import-commit').trigger('click')
    await vi.waitFor(() => expect(w.text()).toContain('成功落库 1 条'))
  })
})

describe('ImportCard Authenticator Plus 字节通道', () => {
  function apPlatform(store: Awaited<ReturnType<typeof readyStore>>) {
    const uri = 'otpauth://totp/APSvc:ap@x.com?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
    const bytes = new Uint8Array(zipSync({ 'Accounts.txt': strToU8(uri) }, { level: 0 }))
    return {
      // 文本管道读失败（二进制 zip）：start() 走字节兜底通道缓存 bytes
      readImportFile: vi.fn(async () => { throw new TypeError('文本解码失败') }),
      readImportFileBytes: vi.fn(async () => ({ bytes, name: 'ap.zip' })),
      store,
    }
  }
  it('文本读取失败 → 字节通道落 picked 页 → 手选 AP → 口令页（留空）→ 解析落库', async () => {
    const store = await readyStore()
    const platform = apPlatform(store)
    const w = mount(ImportCard, { global: { plugins: [createTestI18n()] }, props: { platform } })
    await w.find('button.import-start').trigger('click')
    await vi.waitFor(() => expect(w.text()).toContain('ap.zip')) // 字节兜底落到 picked 页
    expect(w.text()).toContain('手动指定') // zip 无文本嗅探特征 → 待手动
    await pickOption(w, '手动指定格式', 'Authenticator Plus（加密 zip）')
    await w.find('button.import-next').trigger('click')
    await vi.waitFor(() => expect(w.text()).toContain('Authenticator Plus 导出 zip 受口令保护'))
    await w.find('button.import-next').trigger('click') // 未加密导出留空口令，fileBytes 已缓存免二次弹窗
    await vi.waitFor(() => expect(w.text()).toContain('冲突'))
    // start() 两次读取：自动 SQLite 头探测 1 次 + 文本失败后字节兜底 1 次（宿主约定复用同一文件）
    expect(platform.readImportFileBytes).toHaveBeenCalledTimes(2)
    await w.find('button.import-commit').trigger('click')
    await vi.waitFor(() => expect(w.text()).toContain('成功落库 1 条'))
    expect(store.vault.entries.some((e) => e.issuer === 'APSvc')).toBe(true)
  })
  it('既无缓存字节又无字节能力 → 显式报错不崩溃', async () => {
    const store = await readyStore()
    const w = mount(ImportCard, { global: { plugins: [createTestI18n()] },
      props: { platform: { readImportFile: vi.fn().mockResolvedValue({ text: 'hello', name: 'x' }), store } } })
    await w.find('button.import-start').trigger('click')
    await vi.waitFor(() => expect(w.text()).toContain('手动指定'))
    await pickOption(w, '手动指定格式', 'Authenticator Plus（加密 zip）')
    await w.find('button.import-next').trigger('click')
    await vi.waitFor(() => expect(w.text()).toContain('Authenticator Plus 导出 zip 受口令保护'))
    await w.find('button.import-next').trigger('click')
    await vi.waitFor(() => expect(w.text()).toContain('当前端不支持 Authenticator Plus 导入'))
  })
})

describe('ImportCard 字节兜底 picked（非 SQLite 二进制）', () => {
  it('文本读取失败 + 自动 SQLite 复查头不匹配 → 静默回退到字节 picked 页', async () => {
    const store = await readyStore()
    const w = mount(ImportCard, { global: { plugins: [createTestI18n()] },
      props: {
        platform: {
          readImportFile: vi.fn(async () => { throw new TypeError('binary') }),
          readImportFileBytes: vi.fn().mockResolvedValue({ bytes: new Uint8Array([9, 9, 9]), name: 'blob.bin' }),
          store,
        },
      } })
    await w.find('button.import-start').trigger('click')
    await vi.waitFor(() => expect(w.text()).toContain('blob.bin'))
    expect(w.text()).toContain('手动指定') // 无报错横幅（自动复查静默）
    expect(w.find('div[role="status"].err, .err').exists()).toBe(false)
  })
})

describe('ImportCard 映射空结果与报告行号', () => {
  it('emptyGoesBack：映射后 0 条且有失败 → 报错留映射页不进确认', async () => {
    const store = await readyStore()
    const text = JSON.stringify([{ name: 'Svc', key: 'JBSWY3DPEHPK3PXP' }])
    const w = mount(ImportCard, { global: { plugins: [createTestI18n()] },
      props: { platform: { readImportFile: vi.fn().mockResolvedValue({ text, name: 'g.json' }), store } } })
    await w.find('button.import-start').trigger('click')
    await vi.waitFor(() => expect(w.text()).toContain('generic'))
    await w.find('button.import-next').trigger('click')
    await vi.waitFor(() => expect(w.text()).toContain('字段映射'))
    await w.find('input[data-field="secret"]').setValue('nope') // 全行密钥路径错 → 全部失败
    await w.find('button.import-next').trigger('click')
    await vi.waitFor(() => expect(w.text()).toContain('解析结果为空'))
    expect(w.text()).toContain('请检查字段映射')
    expect(w.find('button.import-commit').exists()).toBe(false)
  })

  it('报告失败逐条：uriBatch 附原始行号与行文本', async () => {
    const store = await readyStore()
    const text = 'otpauth://totp/A:a?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ\nbadline\notpauth://totp/B:b?secret=JBSWY3DPEHPK3PXQ'
    const w = mount(ImportCard, { global: { plugins: [createTestI18n()] },
      props: { platform: { readImportFile: vi.fn().mockResolvedValue({ text, name: 'u.txt' }), store } } })
    await w.find('button.import-start').trigger('click')
    await vi.waitFor(() => expect(w.text()).toContain('uriBatch'))
    await w.find('button.import-next').trigger('click')
    await vi.waitFor(() => expect(w.text()).toContain('冲突'))
    await w.find('button.import-commit').trigger('click')
    await vi.waitFor(() => expect(w.text()).toContain('成功落库 2 条'))
    expect(w.find('.failures').text()).toContain('第 2 行')
    expect(w.find('.failures').text()).toContain('badline')
  })
})

describe('ImportCard 其余分派与守卫分支（盘点补遗）', () => {
  it('aegis 加密（db 为密文串）：进口令页；空口令提交 → 「口令不能为空」不崩溃', async () => {
    const store = await readyStore()
    const encryptedAegis = JSON.stringify({ db: 'AAAA', header: { slots: [] } })
    const w = mount(ImportCard, { global: { plugins: [createTestI18n()] },
      props: { platform: { readImportFile: vi.fn().mockResolvedValue({ text: encryptedAegis, name: 'a.json' }), store } } })
    await w.find('button.import-start').trigger('click')
    await vi.waitFor(() => expect(w.text()).toContain('aegis'))
    await w.find('button.import-next').trigger('click')
    await vi.waitFor(() => expect(w.text()).toContain('该 Aegis 备份已加密'))
    await w.find('button.import-next').trigger('click') // 空口令
    await vi.waitFor(() => expect(w.text()).toContain('请输入口令'))
  })

  it('start()：文本读取失败且无字节能力 → 原始错误透传到横幅', async () => {
    const store = await readyStore()
    const w = mount(ImportCard, { global: { plugins: [createTestI18n()] },
      props: { platform: { readImportFile: vi.fn(async () => { throw new Error('disk ejected') }), store } } })
    await w.find('button.import-start').trigger('click')
    await vi.waitFor(() => expect(w.text()).toContain('disk ejected'))
  })

  it('映射页键名无候选命中：不预填（留空待手填）', async () => {
    const store = await readyStore()
    const text = JSON.stringify([{ xyz: 'a', zz: 'b', key: 'JBSWY3DPEHPK3PXP' }]) // 仅 key 命中 secret 候选
    const w = mount(ImportCard, { global: { plugins: [createTestI18n()] },
      props: { platform: { readImportFile: vi.fn().mockResolvedValue({ text, name: 'g.json' }), store } } })
    await w.find('button.import-start').trigger('click')
    await vi.waitFor(() => expect(w.text()).toContain('generic'))
    await w.find('button.import-next').trigger('click')
    await vi.waitFor(() => expect(w.text()).toContain('字段映射'))
    expect((w.find('input[data-field="issuer"]').element as HTMLInputElement).value).toBe('') // xyz/zz 不命中 issuer 候选
    expect((w.find('input[data-field="secret"]').element as HTMLInputElement).value).toBe('key')
  })

  it('方案保存：仅 secret 必填时 mapping 只含 secret（可选字段不携带）', async () => {
    const store = await readyStore()
    const text = JSON.stringify([{ name: 'Svc', key: 'JBSWY3DPEHPK3PXP' }])
    const schemesApi = { load: vi.fn().mockResolvedValue([]), save: vi.fn().mockResolvedValue(undefined) }
    const w = mount(ImportCard, { global: { plugins: [createTestI18n()] },
      props: { platform: { readImportFile: vi.fn().mockResolvedValue({ text, name: 'g.json' }), store }, schemesApi } })
    await w.find('button.import-start').trigger('click')
    await vi.waitFor(() => expect(w.text()).toContain('generic'))
    await w.find('button.import-next').trigger('click')
    await vi.waitFor(() => expect(w.text()).toContain('字段映射'))
    // 清空预填的 issuer/label，仅留 secret
    await w.find('input[data-field="issuer"]').setValue('')
    await w.find('input[data-field="label"]').setValue('')
    await w.find('.scheme-name input').setValue('极简方案')
    await w.find('button.scheme-save').trigger('click')
    await vi.waitFor(() => expect(schemesApi.save).toHaveBeenCalledTimes(1))
    const saved = schemesApi.save.mock.calls[0]![0] as ImportScheme[]
    expect(saved[0]!.mapping).toEqual({ secret: { path: 'key' } })
  })

  it('报告失败逐条：非 uriBatch 格式（2FAS）→ 「第 N 项」形态', async () => {
    const store = await readyStore()
    const text = JSON.stringify({
      schemaVersion: 4,
      services: [
        { secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', name: 'Good', otp: { account: 'a@x.com' } },
        { name: 'NoSecret', otp: { account: 'b@x.com' } }, // 缺 secret → 单条失败
      ],
    })
    const w = mount(ImportCard, { global: { plugins: [createTestI18n()] },
      props: { platform: { readImportFile: vi.fn().mockResolvedValue({ text, name: '2fas.json' }), store } } })
    await w.find('button.import-start').trigger('click')
    await vi.waitFor(() => expect(w.text()).toContain('twoFas'))
    await w.find('button.import-next').trigger('click')
    await vi.waitFor(() => expect(w.text()).toContain('冲突'))
    await w.find('button.import-commit').trigger('click')
    await vi.waitFor(() => expect(w.text()).toContain('成功落库 1 条'))
    expect(w.find('.failures').text()).toContain('第 2 项')
  })
})

describe('ImportCard 映射方案删除与失败路径', () => {
  const premade: ImportScheme = {
    id: 's1', name: '旧方案', createdAt: 1,
    mapping: { secret: { path: 'key' }, issuer: { path: 'name' } },
  }
  async function toMappingWithSchemes() {
    const store = await readyStore()
    const text = JSON.stringify([{ name: 'Svc', key: 'JBSWY3DPEHPK3PXP' }])
    const schemesApi = { load: vi.fn().mockResolvedValue([premade]), save: vi.fn().mockResolvedValue(undefined) }
    const w = mount(ImportCard, { global: { plugins: [createTestI18n()] },
      props: { platform: { readImportFile: vi.fn().mockResolvedValue({ text, name: 'g.json' }), store }, schemesApi } })
    await w.find('button.import-start').trigger('click')
    await vi.waitFor(() => expect(w.text()).toContain('generic'))
    await w.find('button.import-next').trigger('click')
    await vi.waitFor(() => expect(w.find('button[aria-label="映射方案"]').exists()).toBe(true))
    return { w, schemesApi }
  }

  it('删除方案：removeScheme 后整体落盘且选中清空', async () => {
    const { w, schemesApi } = await toMappingWithSchemes()
    await pickOption(w, '映射方案', '旧方案')
    await w.find('button.scheme-delete').trigger('click')
    await vi.waitFor(() => expect(schemesApi.save).toHaveBeenCalledTimes(1))
    expect(schemesApi.save.mock.calls[0]![0]).toEqual([]) // 删后为空表
    // 方案表空 → 下拉整行（含触发按钮）随之消失
    expect(w.find('button[aria-label="映射方案"]').exists()).toBe(false)
  })

  it('保存方案：secret 未填 → 「secret 字段的映射路径必填」不入库', async () => {
    const { w, schemesApi } = await toMappingWithSchemes()
    await w.find('input[data-field="secret"]').setValue('')
    await w.find('.scheme-name input').setValue('半截方案')
    await w.find('button.scheme-save').trigger('click')
    await vi.waitFor(() => expect(w.text()).toContain('secret 字段的映射路径必填'))
    expect(schemesApi.save).not.toHaveBeenCalled()
  })

  it('保存方案：名称为空 → 提示必填；落盘失败 → 错误横幅', async () => {
    const { w, schemesApi } = await toMappingWithSchemes()
    await w.find('button.scheme-save').trigger('click')
    await vi.waitFor(() => expect(w.text()).toContain('请先输入方案名称'))
    await w.find('.scheme-name input').setValue('会失败的方案')
    schemesApi.save.mockRejectedValue(new Error('disk full'))
    await w.find('button.scheme-save').trigger('click')
    await vi.waitFor(() => expect(w.text()).toContain('disk full'))
    expect(schemesApi.load).toHaveBeenCalledTimes(1) // 未追加成功
  })

  it('删除方案失败：错误横幅且方案仍在', async () => {
    const { w, schemesApi } = await toMappingWithSchemes()
    schemesApi.save.mockRejectedValue(new Error('read-only'))
    await pickOption(w, '映射方案', '旧方案')
    await w.find('button.scheme-delete').trigger('click')
    await vi.waitFor(() => expect(w.text()).toContain('read-only'))
    expect(w.find('button[aria-label="映射方案"]').text()).toContain('旧方案') // 列表未变
  })
})
