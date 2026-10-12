// extract-changelog.mjs 自动化测试：release 发布说明截取此前零测试，小节头匹配、版本前缀
// 串扰（1.0.1 vs 1.0.11）、小节边界（后续标题截断/文件尾）、缺失回退（::warning:: + 空输出 +
// 退出码 0）与 CHANGELOG 缺失（退出码 2）全靠人工验证。此处以 mkdtemp 临时 fixture +
// 真实子进程（exit code / stdout/stderr 全走真实路径）覆盖。
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'

const EXTRACT = fileURLToPath(new URL('./extract-changelog.mjs', import.meta.url))

const CHANGELOG = `# 更新日志

引言段。

## [未发布]

### 修复
- 未发布内容

## [1.0.1] - 2026-10-12
### 修复
- 1.0.1 首行
- 1.0.1 末行

## [1.0.11] - 2026-10-13
### 修复
- 1.0.11 内容

## 0.9.0 - 2026-09-01
无方括号旧写法
`

let dir
afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})

/** 以 CHANGELOG_ROOT 注入 fixture 运行脚本，返回 { code, stdout, stderr } */
function run(version, changelogFile = 'CHANGELOG.md', root) {
  const r = root ?? dir
  return spawnSync(process.execPath, [EXTRACT, version], {
    encoding: 'utf8',
    env: { ...process.env, CHANGELOG_ROOT: r },
  })
}

describe('extract-changelog（release 说明截取）', () => {
  it('截取 1.0.1 小节：标题到下一标题之间，尾空行收敛', () => {
    dir = mkdtempSync(join(tmpdir(), 'extract-changelog-'))
    writeFileSync(join(dir, 'CHANGELOG.md'), CHANGELOG)
    const r = run('1.0.1')
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('### 修复\n- 1.0.1 首行\n- 1.0.1 末行\n')
  })

  it('容忍 v 前缀与无方括号小节头', () => {
    expect(run('v1.0.1').stdout).toContain('1.0.1 首行')
    const r = run('0.9.0')
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('无方括号旧写法\n')
  })

  it('版本精确匹配：1.0.1 不得命中 1.0.11', () => {
    const r = run('1.0.11')
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('1.0.11 内容')
    // 1.0.1 的精确匹配不应混入 1.0.11 内容（小节边界由后续标题行截断）
    expect(run('1.0.1').stdout).not.toContain('1.0.11')
  })

  it('文件尾小节（无后续标题）与标题后引导空行剥离', () => {
    const text = CHANGELOG + '\n## [2.0.0]\n\n### 新增\n- 尾部小节\n'
    writeFileSync(join(dir, 'CHANGELOG.md'), text)
    const r = run('2.0.0')
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('### 新增\n- 尾部小节\n')
  })

  it('小节缺失：退出码 0 + 空输出 + ::warning:: 注解（release 回退自动说明）', () => {
    const r = run('9.9.9')
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('')
    expect(r.stderr).toContain('::warning::')
  })

  it('CHANGELOG.md 缺失：退出码 2（仓库配置错误，发布中断）', () => {
    const empty = mkdtempSync(join(tmpdir(), 'extract-changelog-empty-'))
    try {
      const r = run('1.0.1', 'CHANGELOG.md', empty)
      expect(r.status).toBe(2)
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })

  it('非法版本参数：退出码 2', () => {
    const r = spawnSync(process.execPath, [EXTRACT, '1.0.1-beta'], {
      encoding: 'utf8',
      env: { ...process.env, CHANGELOG_ROOT: dir },
    })
    expect(r.status).toBe(2)
  })

  it('仓库真实 CHANGELOG.md：1.0.1 与 1.0.0 小节均可截取（脚本对真实产物可用）', () => {
    const repoRoot = fileURLToPath(new URL('..', import.meta.url))
    const r101 = spawnSync(process.execPath, [EXTRACT, '1.0.1'], {
      encoding: 'utf8',
      env: { ...process.env, CHANGELOG_ROOT: repoRoot },
    })
    expect(r101.status).toBe(0)
    expect(r101.stdout).toContain('MV3 CSP')
    const r100 = spawnSync(process.execPath, [EXTRACT, '1.0.0'], {
      encoding: 'utf8',
      env: { ...process.env, CHANGELOG_ROOT: repoRoot },
    })
    expect(r100.status).toBe(0)
    expect(r100.stdout).toContain('首个正式版')
  })
})
