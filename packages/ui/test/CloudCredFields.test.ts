import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
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
    expect(w.text()).toContain('实际目标：dav/sub/my.totpbackup')
  })
  it('overwrite + 空 objectPath：展示将使用的缺省路径', () => {
    const w = mountFields(WEBDAV)
    expect(w.text()).toContain('实际目标：totp-backup.totpbackup')
  })
  it('keep 源：展示目录 + 自动文件名占位与仅目录生效说明；仅文件名时目录显示（根目录）', () => {
    const w = mountFields({ ...WEBDAV, objectPath: 'docs/sub/my.totpbackup' }, KEEP3)
    expect(w.text()).toContain('实际目标：docs/sub/vault-YYYYMMDD-HHMMSS.totpbackup')
    expect(w.text()).toContain('保留最近模式下仅目录生效')

    const root = mountFields({ ...WEBDAV, objectPath: 'onlyname.totpbackup' }, KEEP3)
    expect(root.text()).toContain('实际目标：（根目录）/vault-YYYYMMDD-HHMMSS.totpbackup')
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
