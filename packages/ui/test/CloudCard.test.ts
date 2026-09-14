import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'

vi.mock('@totp/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@totp/core')>()
  return { ...actual, syncWithCloud: vi.fn() }
})

import { syncWithCloud } from '@totp/core'
import CloudCard from '../src/components/CloudCard.vue'
import type { CloudPlatform } from '../src/components/cloudPlatform'

const mockedSync = vi.mocked(syncWithCloud)

const VALID_VAULT = JSON.stringify({ version: 1, entries: [], groups: [], updatedAt: 0 })

function makePlatform(over: Partial<CloudPlatform> = {}): CloudPlatform {
  return {
    loadCred: vi.fn().mockResolvedValue(null),
    saveCred: vi.fn().mockResolvedValue(undefined),
    readVaultJson: vi.fn().mockReturnValue(VALID_VAULT),
    persistDownloaded: vi.fn().mockResolvedValue(undefined),
    loadHash: vi.fn().mockResolvedValue(null),
    saveHash: vi.fn().mockResolvedValue(undefined),
    ...over,
  }
}

function inputByPh(w: VueWrapper, placeholder: string) {
  return w.findAll('input').find((i) => i.attributes('placeholder') === placeholder)
}

async function fillWebdav(w: VueWrapper): Promise<void> {
  await inputByPh(w, '服务器地址（https://dav.example.com）')!.setValue('https://dav.example.com')
  await inputByPh(w, '用户名')!.setValue('alice')
  await inputByPh(w, '应用密码')!.setValue('davpw')
}

async function clickSync(w: VueWrapper): Promise<void> {
  await w.find('button.sync-now').trigger('click')
  await flushPromises()
}

describe('CloudCard', () => {
  beforeEach(() => vi.clearAllMocks())

  it('敏感凭据字段以密码形态遮蔽，非敏感字段保持文本；回填后仍遮蔽', async () => {
    const w = mount(CloudCard, { props: { platform: makePlatform() } })
    const type = (ph: string) => inputByPh(w, ph)!.attributes('type')
    expect(type('应用密码')).toBe('password')
    expect(type('用户名')).not.toBe('password')
    await w.find('select.cloud-backend').setValue('s3')
    expect(type('SecretAccessKey')).toBe('password')
    expect(type('Region（如 us-east-1）')).not.toBe('password')
    expect(type('Bucket')).not.toBe('password')
    await w.find('select.cloud-backend').setValue('gdrive')
    expect(type('Access Token（Google OAuth）')).toBe('password')
    await w.find('select.cloud-backend').setValue('onedrive')
    expect(type('Access Token（Microsoft Graph）')).toBe('password')
    await w.find('select.cloud-backend').setValue('gist')
    expect(type('GitHub Token')).toBe('password')
    expect(type('Gist ID')).not.toBe('password')
    // loadCred 回填后仍以遮蔽形态显示
    const p2 = makePlatform({ loadCred: vi.fn().mockResolvedValue({ backend: 'gist', token: 'tok', gistId: 'gid' }) })
    const w2 = mount(CloudCard, { props: { platform: p2 } })
    await flushPromises()
    expect((inputByPh(w2, 'GitHub Token')!.element as HTMLInputElement).value).toBe('tok')
    expect(inputByPh(w2, 'GitHub Token')!.attributes('type')).toBe('password')
  })

  it('保存凭据：表单字段组装成 CloudCred 调 saveCred', async () => {
    const p = makePlatform()
    const w = mount(CloudCard, { props: { platform: p } })
    await fillWebdav(w)
    await w.find('button.save-cred').trigger('click')
    await flushPromises()
    expect(p.saveCred).toHaveBeenCalledWith({ backend: 'webdav', serverUrl: 'https://dav.example.com', username: 'alice', password: 'davpw' })
    expect(w.text()).toContain('凭据已保存')
  })

  it('loadCred 回填：已存凭据填充后端下拉与动态字段', async () => {
    const p = makePlatform({
      loadCred: vi.fn().mockResolvedValue({ backend: 's3', region: 'us-east-1', bucket: 'my-bucket', accessKeyId: 'AKIA', secretAccessKey: 'sk' }),
    })
    const w = mount(CloudCard, { props: { platform: p } })
    await flushPromises()
    expect((w.find('select.cloud-backend').element as HTMLSelectElement).value).toBe('s3')
    expect((inputByPh(w, 'Region（如 us-east-1）')!.element as HTMLInputElement).value).toBe('us-east-1')
    expect((inputByPh(w, 'Bucket')!.element as HTMLInputElement).value).toBe('my-bucket')
    expect((inputByPh(w, 'AccessKeyId')!.element as HTMLInputElement).value).toBe('AKIA')
  })

  it('口令缺失：不调用同步编排也不读 vault', async () => {
    const p = makePlatform()
    const w = mount(CloudCard, { props: { platform: p } })
    await fillWebdav(w)
    await clickSync(w)
    expect(mockedSync).not.toHaveBeenCalled()
    expect(p.readVaultJson).not.toHaveBeenCalled()
    expect(w.text()).toContain('请输入口令')
  })

  it('downloaded 分支：进入确认流程，确认后 persistDownloaded+saveHash 并提示已应用', async () => {
    mockedSync.mockResolvedValue({ action: 'downloaded', hash: 'h1', envelopeJson: VALID_VAULT })
    const p = makePlatform()
    const w = mount(CloudCard, { props: { platform: p } })
    await fillWebdav(w)
    await inputByPh(w, '同步口令')!.setValue('pw')
    await clickSync(w)
    expect(mockedSync).toHaveBeenCalledTimes(1)
    expect(mockedSync.mock.calls[0]![0]).toMatchObject({ path: 'totp-backup.totpbackup', password: 'pw', localHash: null, vaultJson: VALID_VAULT })
    expect(w.find('.confirm-row').exists()).toBe(true)
    expect(w.text()).toContain('已保留本地冲突副本')
    // 确认行挂起期间禁用立即同步（防二次同步覆盖 lastHash 错写 cloudRev），确认完成后恢复
    expect(w.find('button.sync-now').attributes('disabled')).toBeDefined()
    expect(p.persistDownloaded).not.toHaveBeenCalled()
    await w.findAll('button').find((b) => b.text() === '确认覆盖')!.trigger('click')
    await flushPromises()
    expect(w.find('button.sync-now').attributes('disabled')).toBeUndefined()
    expect(p.persistDownloaded).toHaveBeenCalledWith(VALID_VAULT)
    expect(p.saveHash).toHaveBeenCalledWith('h1')
    expect(w.text()).toContain('已应用云端备份')
    expect(w.find('.confirm-row').exists()).toBe(false)
  })

  it('conflict-resolved 分支：提示保留副本并采用云端（含副本名），localHash 来自 loadHash', async () => {
    mockedSync.mockResolvedValue({ action: 'conflict-resolved', conflictBackup: 'conflict-20260913-150405.totpbackup', hash: 'h2', envelopeJson: VALID_VAULT })
    const p = makePlatform({ loadHash: vi.fn().mockResolvedValue('oldhash') })
    const w = mount(CloudCard, { props: { platform: p } })
    await fillWebdav(w)
    await inputByPh(w, '同步口令')!.setValue('pw')
    await clickSync(w)
    expect(mockedSync.mock.calls[0]![0]).toMatchObject({ localHash: 'oldhash' })
    await w.findAll('button').find((b) => b.text() === '确认覆盖')!.trigger('click')
    await flushPromises()
    expect(w.text()).toContain('检测到冲突：已保留本地副本并采用云端（副本：conflict-20260913-150405.totpbackup）')
  })

  it('uploaded 分支：直接提示已上传并保存 cloudRev，无确认流程', async () => {
    mockedSync.mockResolvedValue({ action: 'uploaded', hash: 'h0', envelopeJson: '{"v":1}' })
    const p = makePlatform()
    const w = mount(CloudCard, { props: { platform: p } })
    await fillWebdav(w)
    await inputByPh(w, '同步口令')!.setValue('pw')
    await clickSync(w)
    expect(w.find('.confirm-row').exists()).toBe(false)
    expect(w.text()).toContain('已上传')
    expect(p.saveHash).toHaveBeenCalledWith('h0')
    expect(p.persistDownloaded).not.toHaveBeenCalled()
  })

  it('同步失败（口令不匹配）：展示错误且不覆盖本地', async () => {
    mockedSync.mockRejectedValue(new Error('云端备份口令不匹配，无法合并——请确认口令或手动下载处理'))
    const p = makePlatform()
    const w = mount(CloudCard, { props: { platform: p } })
    await fillWebdav(w)
    await inputByPh(w, '同步口令')!.setValue('badpw')
    await clickSync(w)
    expect(w.text()).toContain('云端备份口令不匹配')
    expect(p.persistDownloaded).not.toHaveBeenCalled()
    expect(w.find('.confirm-row').exists()).toBe(false)
  })
})
