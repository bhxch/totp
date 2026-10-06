import { beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_OBJECT_PATH, KEEP_NAME_PLACEHOLDER, __resetForTest,
  previewObjectPath, resolveDirPath, resolveObjectPath, resolveTimestampPath,
} from '../src/cloud/targetPath'

describe('resolveObjectPath', () => {
  it('无 objectPath 时各后端用默认值', () => {
    expect(resolveObjectPath({ backend: 'webdav', serverUrl: 'https://x', username: 'u', password: 'p' })).toBe(DEFAULT_OBJECT_PATH)
    expect(resolveObjectPath({ backend: 'onedrive', accessToken: 't' })).toBe(DEFAULT_OBJECT_PATH)
    expect(resolveObjectPath({ backend: 'gdrive', accessToken: 't' })).toBe(DEFAULT_OBJECT_PATH)
    expect(resolveObjectPath({ backend: 'gist', token: 't', gistId: 'g' })).toBe(DEFAULT_OBJECT_PATH)
    expect(resolveObjectPath({ backend: 's3', region: 'r', bucket: 'b', accessKeyId: 'a', secretAccessKey: 's' })).toBe(DEFAULT_OBJECT_PATH)
  })
  it('自定义值生效（trim）', () => {
    expect(resolveObjectPath({ backend: 'webdav', serverUrl: 's', username: 'u', password: 'p', objectPath: ' dir/my.totpbackup ' })).toBe('dir/my.totpbackup')
  })
  it('空白串回退默认', () => {
    expect(resolveObjectPath({ backend: 'webdav', serverUrl: 's', username: 'u', password: 'p', objectPath: '   ' })).toBe(DEFAULT_OBJECT_PATH)
  })
  it('拒绝路径穿越与非法字符', () => {
    expect(() => resolveObjectPath({ backend: 'webdav', serverUrl: 's', username: 'u', password: 'p', objectPath: 'a/../b' })).toThrow()
    expect(() => resolveObjectPath({ backend: 'webdav', serverUrl: 's', username: 'u', password: 'p', objectPath: 'a\u0000b' })).toThrow()
  })
  it('反斜杠分隔正规化为正斜杠', () => {
    expect(resolveObjectPath({ backend: 'webdav', serverUrl: 's', username: 'u', password: 'p', objectPath: 'a\\b' })).toBe('a/b')
  })
  it('纯分隔符输入（split 后空段）回退默认', () => {
    expect(resolveObjectPath({ backend: 'webdav', serverUrl: 's', username: 'u', password: 'p', objectPath: '///' })).toBe(DEFAULT_OBJECT_PATH)
  })
  it('拒绝 # 与 ?（URL 截断型 404 根因，spec §4.4）', () => {
    expect(() => resolveObjectPath({ backend: 'webdav', serverUrl: 's', username: 'u', password: 'p', objectPath: 'a#b.totpbackup' })).toThrow(/#/)
    expect(() => resolveObjectPath({ backend: 'webdav', serverUrl: 's', username: 'u', password: 'p', objectPath: 'a?b.totpbackup' })).toThrow(/\?/)
  })
})

describe('keep-n 云源时间戳路径（设计 §3）', () => {
  const cred = { backend: 'webdav', serverUrl: 's', username: 'u', password: 'p', objectPath: 'dir/sub/totp-backup.totpbackup' } as const
  const NOW = new Date(2026, 8, 17, 12, 34, 56)

  it('resolveTimestampPath：overwrite 名同目录 vault-{ts}；根路径对象直接 vault-{ts}', () => {
    expect(resolveTimestampPath(cred, NOW)).toBe('dir/sub/vault-20260917-123456.totpbackup')
    expect(resolveTimestampPath({ ...cred, objectPath: undefined }, NOW)).toBe('vault-20260917-123456.totpbackup')
  })
  it('resolveDirPath：取对象路径父目录（根=\'\'）', () => {
    expect(resolveDirPath(cred)).toBe('dir/sub')
    expect(resolveDirPath({ ...cred, objectPath: undefined })).toBe('')
  })
  it('时间戳格式与本地 backupFileName 同款', () => {
    const name = resolveTimestampPath(cred, NOW).split('/').pop()!
    expect(name).toMatch(/^vault-\d{8}-\d{6}\.totpbackup$/)
  })
  it('穿越校验沿用 resolveObjectPath', () => {
    expect(() => resolveTimestampPath({ ...cred, objectPath: 'a/../b.totpbackup' }, NOW)).toThrow()
    expect(() => resolveDirPath({ ...cred, objectPath: 'a\u0000b.totpbackup' })).toThrow()
  })
  it('反斜杠分隔正规化后取父目录', () => {
    expect(resolveDirPath({ ...cred, objectPath: 'a\\b\\c.totpbackup' })).toBe('a/b')
    expect(resolveTimestampPath({ ...cred, objectPath: 'a\\b\\c.totpbackup' }, NOW)).toBe('a/b/vault-20260917-123456.totpbackup')
  })
  it('同目录同秒两次调用：第二次推进一秒不重名；不同目录互不影响（审查 M3）', () => {
    const collide = { ...cred, objectPath: 'collide/totp-backup.totpbackup' } as const
    expect(resolveTimestampPath(collide, NOW)).toBe('collide/vault-20260917-123456.totpbackup')
    expect(resolveTimestampPath(collide, NOW)).toBe('collide/vault-20260917-123457.totpbackup') // 撞名推进一秒
    expect(resolveTimestampPath(collide, NOW)).toBe('collide/vault-20260917-123458.totpbackup') // 连续三发依次错开
    // 目录独立计时：另一目录同一 NOW 仍取整秒，不被别目录推进污染
    expect(resolveTimestampPath({ ...cred, objectPath: 'other/totp-backup.totpbackup' }, NOW)).toBe('other/vault-20260917-123456.totpbackup')
    // 推进后的名字仍匹配滚动删除/恢复列表正则（格式零变更）
    const name = resolveTimestampPath(collide, NOW).split('/').pop()!
    expect(name).toMatch(/^vault-\d{8}-\d{6}\.totpbackup$/)
  })
  it('时钟回拨到已签发时刻：同样推进避让（审查 M3）', () => {
    const rewind = { ...cred, objectPath: 'rewind/totp-backup.totpbackup' } as const
    const later = new Date(NOW.getTime() + 5000)
    expect(resolveTimestampPath(rewind, later)).toBe('rewind/vault-20260917-123501.totpbackup')
    expect(resolveTimestampPath(rewind, NOW)).toBe('rewind/vault-20260917-123502.totpbackup') // 回拨 5s → 推进到上次+1s
  })
  it('同秒不同毫秒两次调用：取整秒比较后同样推进，不因原始毫秒递增而逃逸（质量审查勘误）', () => {
    const collideMs = { ...cred, objectPath: 'collidems/totp-backup.totpbackup' } as const
    // 真实场景：同轮两个 keep 源相隔几百毫秒顺序上传（.2s 与 .8s 同一秒）——毫秒级比较会漏判撞名
    expect(resolveTimestampPath(collideMs, new Date(NOW.getTime() + 200))).toBe('collidems/vault-20260917-123456.totpbackup')
    expect(resolveTimestampPath(collideMs, new Date(NOW.getTime() + 800))).toBe('collidems/vault-20260917-123457.totpbackup')
  })
})

describe('__resetForTest（模块级同秒防撞记忆清空，防跨用例污染）', () => {
  const cred = { backend: 'webdav', serverUrl: 's', username: 'u', password: 'p', objectPath: 'reset/totp-backup.totpbackup' } as const
  const NOW = new Date(2026, 8, 17, 12, 34, 56)

  beforeEach(() => {
    __resetForTest()
  })

  it('清空后同目录同一 NOW 重新从整秒签发（未被此前用例的签发记忆推进）', () => {
    // 制造记忆：该目录已签发 NOW 与 NOW+1s
    expect(resolveTimestampPath(cred, NOW)).toBe('reset/vault-20260917-123456.totpbackup')
    expect(resolveTimestampPath(cred, NOW)).toBe('reset/vault-20260917-123457.totpbackup')
    __resetForTest()
    // 记忆已清：同一 NOW 不再被判同秒撞名，重新签发整秒名
    expect(resolveTimestampPath(cred, NOW)).toBe('reset/vault-20260917-123456.totpbackup')
  })
})

describe('previewObjectPath（②路径实时预览：与上传链同语义、纯只读不签发）', () => {
  const base = { backend: 'webdav', serverUrl: 's', username: 'u', password: 'p' } as const

  it('overwrite：返回实际完整目标（缺省回落默认值、自定义值 trim 归一）', () => {
    expect(previewObjectPath(base, { type: 'overwrite' })).toEqual({ state: 'ok', path: DEFAULT_OBJECT_PATH })
    expect(previewObjectPath({ ...base, objectPath: ' dav/sub/my.totpbackup ' }, { type: 'overwrite' })).toEqual({ state: 'ok', path: 'dav/sub/my.totpbackup' })
  })
  it('keep：仅目录生效，文件名返回固定占位；仅文件名/空值时目录为根', () => {
    expect(previewObjectPath({ ...base, objectPath: 'docs/sub/my.totpbackup' }, { type: 'keep', n: 3 })).toEqual({
      state: 'ok', path: 'docs/sub', keepNamePlaceholder: KEEP_NAME_PLACEHOLDER,
    })
    expect(previewObjectPath({ ...base, objectPath: 'onlyname.totpbackup' }, { type: 'keep', n: 1 })).toEqual({
      state: 'ok', path: '', keepNamePlaceholder: KEEP_NAME_PLACEHOLDER,
    })
    expect(previewObjectPath({ ...base }, { type: 'keep', n: 1 })).toEqual({
      state: 'ok', path: '', keepNamePlaceholder: KEEP_NAME_PLACEHOLDER,
    })
  })
  it('invalid：\\0 与相对段折叠为 state:\'invalid\'（不抛出，UI 据此展示错误文案）', () => {
    expect(previewObjectPath({ ...base, objectPath: 'a/../b' }, { type: 'overwrite' })).toEqual({ state: 'invalid', path: '' })
    expect(previewObjectPath({ ...base, objectPath: 'a\u0000b' }, { type: 'keep', n: 3 })).toEqual({ state: 'invalid', path: '' })
  })
  it('invalid：# / ? 折叠为 state:\'invalid\'', () => {
    expect(previewObjectPath({ ...base, objectPath: 'a#b' }, { type: 'overwrite' })).toEqual({ state: 'invalid', path: '' })
    expect(previewObjectPath({ ...base, objectPath: 'a?b' }, { type: 'keep', n: 3 })).toEqual({ state: 'invalid', path: '' })
  })
  it('纯只读：预览不推进同秒防撞记忆（预览后 resolveTimestampPath 仍从整秒签发）', () => {
    __resetForTest()
    const cred = { ...base, objectPath: 'preview/totp-backup.totpbackup' }
    const NOW = new Date(2026, 8, 30, 22, 12, 51)
    previewObjectPath(cred, { type: 'keep', n: 3 })
    previewObjectPath(cred, { type: 'keep', n: 3 })
    expect(resolveTimestampPath(cred, NOW)).toBe('preview/vault-20260930-221251.totpbackup')
  })
})

describe('尾分隔符目录语义（spec §4.5：/xxx/ 按目录处理）', () => {
  const base = { backend: 'webdav', serverUrl: 's', username: 'u', password: 'p' } as const
  const NOW = new Date(2026, 9, 6, 10, 0, 0)

  it('overwrite：目录意向追加默认文件名（/totpbackup/ → totpbackup/totp-backup.totpbackup）', () => {
    expect(resolveObjectPath({ ...base, objectPath: '/totpbackup/' })).toBe(`totpbackup/${DEFAULT_OBJECT_PATH}`)
    expect(resolveObjectPath({ ...base, objectPath: 'a\\b\\' })).toBe(`a/b/${DEFAULT_OBJECT_PATH}`)
  })
  it('keep：目录意向全段为目录（resolveTimestampPath 落该目录；resolveDirPath 同步）', () => {
    const cred = { ...base, objectPath: '/totpbackup/' } as const
    expect(resolveDirPath(cred)).toBe('totpbackup')
    expect(resolveTimestampPath(cred, NOW)).toBe(`totpbackup/vault-20261006-100000.totpbackup`)
  })
  it('仅分隔符（/ 或 //）：overwrite 回落默认；keep 目录为根', () => {
    expect(resolveObjectPath({ ...base, objectPath: '/' })).toBe(DEFAULT_OBJECT_PATH)
    expect(resolveDirPath({ ...base, objectPath: '//' })).toBe('')
  })
  it('不以分隔符结尾的存量语义零变化（回归）', () => {
    expect(resolveObjectPath({ ...base, objectPath: 'a/b.totpbackup' })).toBe('a/b.totpbackup')
    expect(resolveDirPath({ ...base, objectPath: 'a/b.totpbackup' })).toBe('a')
    expect(resolveObjectPath({ ...base, objectPath: 'a\\b' })).toBe('a/b')
  })
  it('目录意向同样拒绝穿越与 #/?（校验先于默认名追加）', () => {
    expect(() => resolveObjectPath({ ...base, objectPath: 'a/../b/' })).toThrow()
    expect(() => resolveObjectPath({ ...base, objectPath: 'a#/' })).toThrow()
  })
  it('预览同语义：overwrite 展示追加默认名后的完整目标；keep 展示目录', () => {
    expect(previewObjectPath({ ...base, objectPath: '/totpbackup/' }, { type: 'overwrite' }))
      .toEqual({ state: 'ok', path: `totpbackup/${DEFAULT_OBJECT_PATH}` })
    expect(previewObjectPath({ ...base, objectPath: '/totpbackup/' }, { type: 'keep', n: 3 }))
      .toEqual({ state: 'ok', path: 'totpbackup', keepNamePlaceholder: KEEP_NAME_PLACEHOLDER })
  })
})
