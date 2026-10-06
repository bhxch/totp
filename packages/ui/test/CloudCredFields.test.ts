import { describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import type { CloudCred, Retention } from '@totp/core'
import CloudCredFields from '../src/components/CloudCredFields.vue'
import { createTestI18n } from './helpers/i18n'

const WEBDAV: CloudCred = { backend: 'webdav', serverUrl: 'https://dav.example.com', username: 'u', password: 'p' }
const OVERWRITE: Retention = { type: 'overwrite' }
const KEEP3: Retention = { type: 'keep', n: 3 }

function mountFields(draft: CloudCred | undefined, retention: Retention = OVERWRITE) {
  return mount(CloudCredFields, { global: { plugins: [createTestI18n()] }, props: { draft, busy: false, retention } })
}

describe('CloudCredFields 目标路径实时预览（bounded ②）', () => {
  it('overwrite 源：预览行展示实际完整目标（自定义值归一展示）', () => {
    const w = mountFields({ ...WEBDAV, objectPath: 'dav/sub/my.totpbackup' })
    expect(w.text()).toContain('实际目标：https://dav.example.com/dav/sub/my.totpbackup')
  })
  it('overwrite + 空 objectPath：展示将使用的缺省路径', () => {
    const w = mountFields(WEBDAV)
    expect(w.text()).toContain('实际目标：https://dav.example.com/totp-backup.totpbackup')
  })
  it('keep 源：展示目录 + 自动文件名占位与仅目录生效说明；仅文件名时目录显示（根目录）', () => {
    const w = mountFields({ ...WEBDAV, objectPath: 'docs/sub/my.totpbackup' }, KEEP3)
    expect(w.text()).toContain('实际目标：https://dav.example.com/docs/sub/vault-YYYYMMDD-HHMMSS.totpbackup')
    expect(w.text()).toContain('保留最近模式下仅目录生效')

    const root = mountFields({ ...WEBDAV, objectPath: 'onlyname.totpbackup' }, KEEP3)
    expect(root.text()).toContain('实际目标：https://dav.example.com/vault-YYYYMMDD-HHMMSS.totpbackup')
  })
  it('非法路径：警示行 role=alert，不再展示目标预览', () => {
    const w = mountFields({ ...WEBDAV, objectPath: 'a/../b' })
    expect(w.find('.path-preview[role="alert"]').exists()).toBe(true)
    expect(w.text()).not.toContain('实际目标')
  })
  it('gdrive/gist：追加按文件名寻址提示；webdav 不出现', () => {
    const gdrive = mountFields({ backend: 'gdrive', accessToken: 't', objectPath: 'bk.totpbackup' })
    expect(gdrive.text()).toContain('该服务按文件名寻址')
    const webdav = mountFields({ ...WEBDAV, objectPath: 'bk.totpbackup' })
    expect(webdav.text()).not.toContain('该服务按文件名寻址')
  })
  it('draft 为 undefined（未配置源）时不渲染预览', () => {
    const w = mountFields(undefined)
    expect(w.find('.path-preview').exists()).toBe(false)
  })
})

describe('CloudCredFields 实际目标完整显示与目录语义（spec §4.5）', () => {
  it('webdav overwrite：预览拼 serverUrl 完整 URL', () => {
    const w = mountFields({ ...WEBDAV, objectPath: 'dav/sub/my.totpbackup' })
    expect(w.text()).toContain('实际目标：https://dav.example.com/dav/sub/my.totpbackup')
  })
  it('webdav keep + 目录意向：完整 URL + 自动命名占位，无忽略警示', () => {
    const w = mountFields({ ...WEBDAV, objectPath: '/totpbackup/' }, KEEP3)
    expect(w.text()).toContain('实际目标：https://dav.example.com/totpbackup/vault-YYYYMMDD-HHMMSS.totpbackup')
    expect(w.text()).not.toContain('不生效')
  })
  it('webdav keep + 文件名输入：警示行回显被忽略的文件名；仅文件名时提示整体不参与', () => {
    const w = mountFields({ ...WEBDAV, objectPath: 'docs/sub/my.totpbackup' }, KEEP3)
    expect(w.text()).toContain('不生效')
    const noDir = mountFields({ ...WEBDAV, objectPath: 'onlyname.totpbackup' }, KEEP3)
    expect(noDir.text()).toContain('整体不参与')
  })
  it('s3：bucket 已填显示 s3:// URI；bucket 空回落裸路径', () => {
    const s3 = mountFields({ backend: 's3', region: 'r', bucket: 'bk', accessKeyId: 'a', secretAccessKey: 's', objectPath: 'p/x.totpbackup' })
    expect(s3.text()).toContain('s3://bk/p/x.totpbackup')
    const noBucket = mountFields({ backend: 's3', region: 'r', bucket: '', accessKeyId: 'a', secretAccessKey: 's', objectPath: 'p/x.totpbackup' })
    expect(noBucket.text()).toContain('实际目标：p/x.totpbackup')
  })
  it('keep 模式 label 切换为目标目录；overwrite 维持目标文件路径', () => {
    const keep = mountFields({ ...WEBDAV, objectPath: 'dir/' }, KEEP3)
    expect(keep.text()).toContain('目标目录')
    const ow = mountFields({ ...WEBDAV })
    expect(ow.text()).toContain('目标文件路径')
  })
  it('serverUrl 为空/非法时回落裸路径显示（不出错）', () => {
    const w = mountFields({ backend: 'webdav', serverUrl: '', username: 'u', password: 'p', objectPath: 'a/b.totpbackup' })
    expect(w.text()).toContain('实际目标：a/b.totpbackup')
  })
})

describe('CloudCredFields 每源代理（③）', () => {
  const mountP = (draft: CloudCred | undefined, proxySupport: boolean) =>
    mount(CloudCredFields, { global: { plugins: [createTestI18n()] }, props: { draft, busy: false, retention: OVERWRITE, proxySupport } })

  it('proxySupport=false：不渲染代理控件，显示扩展端提示', () => {
    const w = mountP(WEBDAV, false)
    expect(w.text()).toContain('扩展端不支持每源代理')
    expect(w.find('.proxy-mode').exists()).toBe(false)
  })
  it('三段切换与 url 输入：custom 出地址框，none 清 proxy 字段', async () => {
    const draft: CloudCred = { ...WEBDAV }
    const w = mountP(draft, true)
    await w.find('.proxy-mode button:nth-child(3)').trigger('click') // 第 3 段=自定义（MdSegmentedButton button 即 emit 先例）
    await flushPromises()
    expect(draft.proxy?.mode).toBe('custom')
    await w.find('input[aria-label="代理地址"]').setValue('socks5h://127.0.0.1:7890')
    expect(draft.proxy).toEqual({ mode: 'custom', url: 'socks5h://127.0.0.1:7890' })
    // 切回直连（none）：清 proxy 字段
    await w.find('.proxy-mode button:nth-child(1)').trigger('click')
    expect(draft.proxy).toBeUndefined()
  })
  it('draft 为 undefined 时代理控件与提示均不渲染', () => {
    const w = mountP(undefined, true)
    expect(w.find('.proxy-mode').exists()).toBe(false)
    expect(w.text()).not.toContain('扩展端不支持每源代理')
  })
})
