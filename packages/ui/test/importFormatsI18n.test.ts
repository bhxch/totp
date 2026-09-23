import zh from '../src/i18n/locales/zh/common.json'
import en from '../src/i18n/locales/en/common.json'
import { describe, expect, it } from 'vitest'

// 全部导入能力的品牌名（实现源：packages/core/src/import 下 parsers + sniff.ts 判定序 + ImportCard 手动下拉）。
// Ente Auth 明文导出走 uriBatch 通道（types.ts 注释口径），计入文本类。
const BRANDS: ReadonlyArray<{ name: string; lines: Array<'formatsEncrypted' | 'formatsApps' | 'formatsText'> }> = [
  { name: 'Aegis', lines: ['formatsEncrypted'] },
  { name: 'WinAuth', lines: ['formatsEncrypted'] },
  { name: 'Authy', lines: ['formatsEncrypted', 'formatsApps'] },
  { name: 'Authenticator Plus', lines: ['formatsEncrypted', 'formatsApps'] },
  { name: 'FoxAuth', lines: ['formatsEncrypted', 'formatsApps'] },
  { name: '2FAS', lines: ['formatsApps'] },
  { name: 'Bitwarden', lines: ['formatsApps'] },
  { name: 'Proton Authenticator', lines: ['formatsApps'] },
  { name: 'Stratum', lines: ['formatsApps'] },
  { name: 'FreeOTP+', lines: ['formatsApps'] },
  { name: 'FreeOTP', lines: ['formatsApps'] },
  { name: 'andOTP', lines: ['formatsApps'] },
  { name: 'TOTP Authenticator', lines: ['formatsApps'] },
  { name: 'Battle.net', lines: ['formatsApps'] },
  { name: 'Duo', lines: ['formatsApps'] },
  { name: 'Microsoft Authenticator', lines: ['formatsApps'] },
  { name: 'Ente Auth', lines: ['formatsText'] },
  { name: 'otpauth', lines: ['formatsText'] },
  { name: 'JSON', lines: ['formatsText'] },
]

for (const [locale, obj] of [['zh', zh], ['en', en]] as const) {
  describe(`importCard.formats* (${locale})`, () => {
    for (const brand of BRANDS) {
      it(`文案覆盖 ${brand.name}`, () => {
        for (const line of brand.lines) {
          const text = (obj.importCard as Record<string, string>)[line]
          expect(text, `${line} 缺 ${brand.name}`).toContain(brand.name)
        }
      })
    }
  })
}
