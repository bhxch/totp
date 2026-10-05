// gen-builtin-icons 自动化测试：产物形状/数量/幂等此前零测试。真实子进程跑脚本，
// 断言 builtin.json（精选 218+58 别名）与 icons-full.json（全量，含精选）形状，
// 并重跑一次断言字节级幂等。
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const GEN = fileURLToPath(new URL('./gen-builtin-icons.mjs', import.meta.url))
const CORE_JSON = fileURLToPath(new URL('../packages/core/src/icons/builtin.json', import.meta.url))
const FULL_JSON = fileURLToPath(new URL('../packages/ui/src/assets/icons-full.json', import.meta.url))

const run = () => execFileSync('node', [GEN], { encoding: 'utf8' })

describe('gen-builtin-icons', () => {
  it('builtin.json：218 项精选 + 58 条别名，形状 {id,title,path}', () => {
    run()
    const data = JSON.parse(readFileSync(CORE_JSON, 'utf8'))
    expect(Object.keys(data.icons)).toHaveLength(218)
    expect(Object.keys(data.aliases)).toHaveLength(58)
    for (const icon of Object.values(data.icons)) {
      expect(Object.keys(icon).sort()).toEqual(['id', 'path', 'title'])
      expect(icon.path).toMatch(/^[Mm]/)
    }
  })

  it('icons-full.json：全量（≥3400 项）且包含全部精选 id', () => {
    run()
    const full = JSON.parse(readFileSync(FULL_JSON, 'utf8'))
    const curated = JSON.parse(readFileSync(CORE_JSON, 'utf8'))
    const ids = Object.keys(full.icons)
    expect(ids.length).toBeGreaterThanOrEqual(3400)
    for (const id of Object.keys(curated.icons)) expect(full.icons[id]).toBeDefined()
    for (const icon of Object.values(full.icons)) {
      expect(Object.keys(icon).sort()).toEqual(['id', 'path', 'title'])
    }
  })

  it('幂等：连续两次运行产物字节一致', () => {
    run()
    const coreA = readFileSync(CORE_JSON)
    const fullA = readFileSync(FULL_JSON)
    run()
    expect(readFileSync(CORE_JSON).equals(coreA)).toBe(true)
    expect(readFileSync(FULL_JSON).equals(fullA)).toBe(true)
  })
})
