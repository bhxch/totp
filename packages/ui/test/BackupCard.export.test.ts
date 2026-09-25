import { mount } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import BackupCard from '../src/components/BackupCard.vue'
import { createTestI18n } from './helpers/i18n'
import type { BackupPlatform } from '../src/components/backupPlatform'

const basePlatform = (over: Partial<BackupPlatform> = {}): BackupPlatform => ({
  createBackup: vi.fn(async () => 'ok'),
  restoreFromPicker: vi.fn(async () => null),
  replaceAllOp: vi.fn(),
  ...over,
}) as BackupPlatform

const mountCard = (platform: BackupPlatform) =>
  mount(BackupCard, { global: { plugins: [createTestI18n()] }, props: { platform, vaultJson: '{"version":2,"entries":[],"tags":[],"updatedAt":0}', sessionSecret: 'pw' } })

/** MdSelect 点选（自定义弹层组件，brief 的 .setValue 不适用）：data-test 定位触发按钮 → 按显示文本点选项（F6 间隔用例同款交互） */
async function pickFormat(w: VueWrapper, label: string): Promise<void> {
  await w.find('[data-test="export-format"] button').trigger('click')
  await w.findAll('[role="option"]').find((o) => o.text() === label)!.trigger('click')
}

/** spec §2.3 固定警示文案：明文导出两步确认必显 */
const PLAINTEXT_CONFIRM = '导出为明文，任何人读取该内容即可获取全部密钥，确认继续？'

describe('BackupCard 导出格式（spec §2.3）', () => {
  it('选择 otpauth 文本：确认明文风险后调 saveTextFile 且文件名为 .txt', async () => {
    const saveTextFile = vi.fn(async (_name: string, _content: string) => true)
    const w = mountCard(basePlatform({ saveTextFile }))
    await pickFormat(w, 'otpauth 文本（.txt）')
    await w.find('[data-test="export-run"]').trigger('click')
    expect(w.text()).toContain(PLAINTEXT_CONFIRM) // 明文先两步确认再落盘
    await w.find('[data-test="export-confirm"]').trigger('click')
    await vi.waitFor(() => expect(saveTextFile).toHaveBeenCalledOnce())
    expect(saveTextFile.mock.calls[0]![0]).toMatch(/\.txt$/)
  })
  it('选择 Aegis 加密：要求口令输入，未输入时禁用导出', async () => {
    const saveTextFile = vi.fn(async (_name: string, _content: string) => true)
    const w = mountCard(basePlatform({ saveTextFile }))
    await pickFormat(w, 'Aegis 加密 JSON')
    expect((w.find('[data-test="export-run"]').element as HTMLButtonElement).disabled).toBe(true)
    await w.find('[data-test="export-password"]').setValue('pw2')
    expect((w.find('[data-test="export-run"]').element as HTMLButtonElement).disabled).toBe(false)
  })
  it('记住口令勾选且 vault 已解锁时：emit remember-secret 上抛宿主 setBackupSecret', async () => {
    const saveTextFile = vi.fn(async (_name: string, _content: string) => true)
    const w = mountCard(basePlatform({ saveTextFile }))
    await pickFormat(w, 'Aegis 加密 JSON')
    await w.find('[data-test="export-password"]').setValue('pw2')
    await w.find('[data-test="export-remember"] input').setValue(true)
    await w.find('[data-test="export-run"]').trigger('click') // 加密免二次确认，直接落盘（评审 R1）
    await vi.waitFor(() => expect(saveTextFile).toHaveBeenCalledOnce())
    expect(w.emitted('remember-secret')?.[0]).toEqual(['pw2'])
  })
  it('Aegis 加密导出免二次确认：点导出后确认行不出现，saveTextFile 直接调用（评审 R1）', async () => {
    const saveTextFile = vi.fn(async (_name: string, _content: string) => true)
    const w = mountCard(basePlatform({ saveTextFile }))
    await pickFormat(w, 'Aegis 加密 JSON')
    await w.find('[data-test="export-password"]').setValue('pw2')
    await w.find('[data-test="export-run"]').trigger('click')
    expect(w.find('[data-test="export-confirm"]').exists()).toBe(false) // 加密无明文泄密风险，不进确认行
    await vi.waitFor(() => expect(saveTextFile).toHaveBeenCalledOnce())
    expect(saveTextFile.mock.calls[0]![0]).toBe('aegis-export.json')
  })

  it('Aegis 明文：确认后落盘 aegis-export.json 并显示「已导出」', async () => {
    const saveTextFile = vi.fn(async (_name: string, _content: string) => true)
    const vault = JSON.stringify({
      version: 2, updatedAt: 0,
      tags: [{ id: 't1', name: 'Work' }, { id: 't2', name: 'Unused' }],
      entries: [{
        uuid: 'u1', type: 'totp', issuer: 'GitHub', label: 'me@x.com', secret: 'JBSWY3DPEHPK3PXP',
        algorithm: 'SHA1', digits: 6, period: 30, tagIds: ['t1'], matchRules: [], order: 0, createdAt: 0,
      }],
    })
    const w = mount(BackupCard, { global: { plugins: [createTestI18n()] }, props: { platform: basePlatform({ saveTextFile }), vaultJson: vault, sessionSecret: 'pw' } })
    await pickFormat(w, 'Aegis 明文 JSON')
    await w.find('[data-test="export-run"]').trigger('click')
    expect(w.find('.export-confirm-row').text()).toContain(PLAINTEXT_CONFIRM)
    await w.find('[data-test="export-confirm"]').trigger('click')
    await vi.waitFor(() => expect(saveTextFile).toHaveBeenCalledOnce())
    expect(saveTextFile.mock.calls[0]![0]).toBe('aegis-export.json')
    expect(w.text()).toContain('已导出')
    // 注：core exportAegisPlaintext 目前恒置 droppedTagCount=0，okWithDropped 的 >0 提示分支为防御保留
  })

  it('Aegis 明文：确认后用户取消（save=false）→ hint「已取消」', async () => {
    const saveTextFile = vi.fn(async (_name: string, _content: string) => false)
    const w = mountCard(basePlatform({ saveTextFile }))
    await pickFormat(w, 'Aegis 明文 JSON')
    await w.find('[data-test="export-run"]').trigger('click')
    await w.find('[data-test="export-confirm"]').trigger('click')
    await vi.waitFor(() => expect(saveTextFile).toHaveBeenCalledOnce())
    expect(w.text()).toContain('已取消')
  })

  it('listBackups 拒绝：聚合列表按空处理不阻断（catch 回退空数组）', async () => {
    const p = basePlatform({ listBackups: vi.fn(async () => { throw new Error('s3 down') }) })
    const w = mountCard(p)
    await vi.waitFor(() => expect(p.listBackups).toHaveBeenCalled())
    expect(w.find('.backup-list li, [class*="backup"]').exists()).toBe(true)
    expect(w.text()).not.toContain('s3 down') // 静默回退
  })
})
