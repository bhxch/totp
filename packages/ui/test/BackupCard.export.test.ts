import { mount } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import BackupCard from '../src/components/BackupCard.vue'
import type { BackupPlatform } from '../src/components/backupPlatform'

const basePlatform = (over: Partial<BackupPlatform> = {}): BackupPlatform => ({
  createBackup: vi.fn(async () => 'ok'),
  restoreFromPicker: vi.fn(async () => null),
  replaceAllOp: vi.fn(),
  ...over,
}) as BackupPlatform

const mountCard = (platform: BackupPlatform) =>
  mount(BackupCard, { props: { platform, vaultJson: '{"version":2,"entries":[],"tags":[],"updatedAt":0}', sessionSecret: 'pw' } })

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
    await w.find('[data-test="export-run"]').trigger('click')
    await w.find('[data-test="export-confirm"]').trigger('click')
    await vi.waitFor(() => expect(saveTextFile).toHaveBeenCalledOnce())
    expect(w.emitted('remember-secret')?.[0]).toEqual(['pw2'])
  })
})
