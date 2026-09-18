import { describe, expect, it } from 'vitest'
import { DEFAULT_OBJECT_PATH, resolveDirPath, resolveObjectPath, resolveTimestampPath } from '../src/cloud/targetPath'

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
})
