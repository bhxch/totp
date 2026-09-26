import { describe, expect, it } from 'vitest'
import { IMPORT_FORMATS, needsPasswordFor } from '../src/import/sniff'

/**
 * needsPasswordFor 内容谓词两态守卫（R5，方案 §5.2 行为契约项）：
 * 「哪些输入走口令页」是文本内容函数而非格式静态属性——加密 aegis、foxauth 加密态、
 * 密文 totpAuthenticator 三种既有两态行为；静态布尔禁用（方案 §6）。
 * 本文件锁定谓词的文本两态路由；经 sniff 单点导入同时验证注册表 re-export 出包链。
 */

const SECRET = 'JBSWY3DPEHPK3PXP'

describe('needsPasswordFor 内容谓词（两端口令判定派生源，R5）', () => {
  it('aegis 两态：db 为密文 Base64 串 → true（口令页）；明文 vault → false（直解）', () => {
    const encrypted = JSON.stringify({
      version: 1,
      header: { slots: [{ type: 1, uuid: 's', key: 'ab', key_params: { nonce: 'cd', tag: 'ef' }, salt: '01', n: 16384, r: 8, p: 1 }], params: { nonce: 'aa'.repeat(12), tag: 'bb'.repeat(16) } },
      db: 'aGVsbG8=',
    })
    expect(needsPasswordFor('aegis', encrypted)).toBe(true)
    expect(needsPasswordFor('aegis', '{"version":1,"header":{"slots":[],"params":{}},"db":{"entries":[]}}')).toBe(false)
    // 非 aegis JSON（谓词不误伤，交由后续流程按格式处理）
    expect(needsPasswordFor('aegis', '{"foo":1}')).toBe(false)
    expect(needsPasswordFor('aegis', 'not json')).toBe(false)
  })
  it('foxauth 两态：isEncrypted:true → true；明文 → false', () => {
    expect(needsPasswordFor('foxauth', JSON.stringify({ accountInfos: 'CIPHER', isEncrypted: true, passwordInfo: {} }))).toBe(true)
    expect(needsPasswordFor('foxauth', JSON.stringify({ accountInfos: [], isEncrypted: false }))).toBe(false)
    expect(needsPasswordFor('foxauth', 'not json')).toBe(false)
  })
  it('totpAuthenticator 两态：非 "[" 开头（Base64 密文分享）→ true；明文数组 → false', () => {
    expect(needsPasswordFor('totpAuthenticator', 'UEsDBBQAAAAI')).toBe(true)
    expect(needsPasswordFor('totpAuthenticator', `[{"base":32,"key":"${SECRET}"}]`)).toBe(false)
  })
  it('未登记谓词的格式恒 false（winauth 恒口令页由导入页显式分支表达，不经谓词）', () => {
    for (const f of ['winauth', 'generic', 'uriBatch', 'twoFas', 'bitwarden'] as const) {
      expect(needsPasswordFor(f, '任意文本'), f).toBe(false)
    }
  })
})

describe('注册表键序结构快照（R5）', () => {
  it('IMPORT_FORMATS 键序 = 嗅探优先序：行为契约的静态面，与 importSniffOrder 行为探针互证', () => {
    expect([...IMPORT_FORMATS]).toMatchSnapshot()
  })
})
