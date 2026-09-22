/** 迁移默认源名 i18n 回落（显示层）：旧迁移落盘的默认中文名按当前语言显示，自定义名原样 */
import { describe, expect, it } from 'vitest'
import { displaySourceName } from '../src/components/sourceDisplayNames'

const t = (key: string): string =>
  ({ 'backupCard.localBackup': 'Local backup', 'backupCard.localDir': 'Local directory' })[key] ?? `<${key}>`

describe('displaySourceName 源名显示回落', () => {
  it('迁移默认名映射 i18n 词条', () => {
    expect(displaySourceName('本地备份', t)).toBe('Local backup')
    expect(displaySourceName('本地目录', t)).toBe('Local directory')
  })

  it('自定义名/空名原样返回（不命中映射）', () => {
    expect(displaySourceName('my dir', t)).toBe('my dir')
    expect(displaySourceName('', t)).toBe('')
  })
})
