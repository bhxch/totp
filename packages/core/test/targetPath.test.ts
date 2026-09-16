import { describe, expect, it } from 'vitest'
import { DEFAULT_OBJECT_PATH, resolveObjectPath } from '../src/cloud/targetPath'

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
