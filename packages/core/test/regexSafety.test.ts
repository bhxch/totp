import { describe, expect, it } from 'vitest'
import {
  MAX_MATCH_PATTERN_LENGTH,
  hasNestedQuantifierRisk,
  isSafeRegexPattern,
} from '../src/match/regexSafety'
import * as engine from '../src/match/engine'

// R16②：正则安全器纯拆落位守卫——实现单点在 match/regexSafety.ts，engine.ts 仅再导出。
// 行为细节由 match.test.ts 既有 F13 用例锁定（经 engine 导入面），此处锚定「同一实现」
// 与新模块可独立消费。
describe('R16②：regexSafety 纯拆落位', () => {
  it('engine 再导出与 regexSafety 实现为同一引用（无副本）', () => {
    expect(engine.isSafeRegexPattern).toBe(isSafeRegexPattern)
    expect(engine.hasNestedQuantifierRisk).toBe(hasNestedQuantifierRisk)
    expect(engine.MAX_MATCH_PATTERN_LENGTH).toBe(MAX_MATCH_PATTERN_LENGTH)
  })
  it('新模块直接消费：嵌套量词与超长 pattern 拒绝', () => {
    expect(hasNestedQuantifierRisk('(a+)+$')).toBe(true)
    expect(isSafeRegexPattern('a'.repeat(MAX_MATCH_PATTERN_LENGTH + 1))).toBe(false)
    expect(isSafeRegexPattern('^https://mail\\.example\\.com/')).toBe(true)
  })
})
