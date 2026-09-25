import { describe, expect, it } from 'vitest'
import { base64ToBytes, bytesToBase64 } from '../src/crypto/aesgcm'
import { chunkKey, chunksToMeta, DEFAULT_MAX_DATA_BYTES, mergeChunks, splitIntoChunks, staleChunkKeys } from '../src/sync/chunks'
import type { SyncChunk } from '../src/sync/chunks'

describe('chunkKey', () => {
  it('生成 sync:v1:${part}/${total} 格式键名', () => {
    expect(chunkKey(0, 3)).toBe('sync:v1:0/3')
    expect(chunkKey(2, 3)).toBe('sync:v1:2/3')
    expect(chunkKey(0, 1)).toBe('sync:v1:0/1')
  })
})

describe('splitIntoChunks', () => {
  it('空 payload → 单个 data="" 片，total=1', () => {
    const chunks = splitIntoChunks('', 7, 1000)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toEqual({ rev: 7, updatedAt: 1000, part: 0, total: 1, data: '' })
  })

  it('短 payload → 单片，data 为 UTF-8 字节的 base64', () => {
    const chunks = splitIntoChunks('hello', 1, 2000)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]!.part).toBe(0)
    expect(chunks[0]!.total).toBe(1)
    expect(base64ToBytes(chunks[0]!.data)).toEqual(new TextEncoder().encode('hello'))
  })

  it('跨多片：按 maxDataBytes 字节切分，rev/updatedAt 贯穿每片', () => {
    // 'a' 是 1 字节 → DEFAULT_MAX_DATA_BYTES + 1 字节 → 2 片
    const chunks = splitIntoChunks('a'.repeat(DEFAULT_MAX_DATA_BYTES + 1), 42, 5000)
    expect(chunks).toHaveLength(2)
    expect(chunks.map((c) => c.part)).toEqual([0, 1])
    expect(chunks.every((c) => c.total === 2)).toBe(true)
    expect(chunks.every((c) => c.rev === 42 && c.updatedAt === 5000)).toBe(true)
    expect(base64ToBytes(chunks[0]!.data).length).toBe(DEFAULT_MAX_DATA_BYTES)
    expect(base64ToBytes(chunks[1]!.data).length).toBe(1)
  })

  it('自定义 maxDataBytes 生效', () => {
    const chunks = splitIntoChunks('abcdef', 1, 1, 2)
    expect(chunks).toHaveLength(3)
    expect(chunks.map((c) => c.part)).toEqual([0, 1, 2])
    expect(chunks.every((c) => c.total === 3)).toBe(true)
    expect(chunks.map((c) => new TextDecoder().decode(base64ToBytes(c.data)))).toEqual(['ab', 'cd', 'ef'])
  })
  it('maxDataBytes 非法（0/负数/非整数）→ 抛错（防除零与死循环切片）', () => {
    for (const bad of [0, -10, 2.5]) {
      expect(() => splitIntoChunks('abc', 1, 1, bad)).toThrow('maxDataBytes must be a positive integer')
    }
  })

  it('多字节 UTF-8（中文/emoji）：按字节切，单片 ≤ maxDataBytes，不丢字节', () => {
    // 中文 3 字节、emoji 4 字节，混合后超 7000 字节，切割点会落在多字节字符中间
    const unit = '中'.repeat(1000) + '😀'.repeat(500) // 3000 + 2000 = 5000 字节/单元
    const payload = unit + unit + '中文😀tail'
    const maxDataBytes = 7000
    const chunks = splitIntoChunks(payload, 3, 3000, maxDataBytes)
    const totalBytes = new TextEncoder().encode(payload).length
    expect(totalBytes).toBeGreaterThan(maxDataBytes)
    expect(chunks.length).toBe(Math.ceil(totalBytes / maxDataBytes))
    for (const c of chunks) {
      const bytes = base64ToBytes(c.data)
      expect(bytes.length).toBeGreaterThan(0)
      expect(bytes.length).toBeLessThanOrEqual(maxDataBytes)
    }
    // 字节总量守恒
    const sum = chunks.reduce((n, c) => n + base64ToBytes(c.data).length, 0)
    expect(sum).toBe(totalBytes)
  })

  it('DEFAULT 分片：每片 data 的 base64 长度 ≤ 7400（加 JSON 包装后仍低于 sync 单键配额 8192）', () => {
    // 大 payload 触发多片：DEFAULT=5500 → base64 ≈7336 字符 + 包装 ≈70 ≈ 7.4KB < 8192
    const chunks = splitIntoChunks('x'.repeat(100_000), 1, 1)
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) {
      expect(c.data.length).toBeLessThanOrEqual(7400)
      expect(c.data.length).toBeLessThanOrEqual(8192 - 90) // 90 字节预留 JSON 包装（含大 rev/updatedAt）
    }
  })
  it('JSON.stringify 后整片长度 ≤ 8192-50（含包装），严格断言 chrome.storage.sync 单键配额', () => {
    // 极限 payload：拉满每片到接近边界，且用大 rev/updatedAt 让包装体积达上限
    const chunks = splitIntoChunks('y'.repeat(100_000), 1_000_000_000, 1_700_000_000_000)
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) {
      const json = JSON.stringify(c)
      expect(json.length).toBeLessThanOrEqual(8192 - 50)
    }
  })
})

describe('mergeChunks', () => {
  it('空串/短串/多字节 payload 均可往返还原', () => {
    const payloads = ['', 'hello', '中'.repeat(1000) + '😀'.repeat(500) + '😀中文 tail', 'a'.repeat(DEFAULT_MAX_DATA_BYTES + 1)]
    for (const payload of payloads) {
      const chunks = splitIntoChunks(payload, 9, 1234)
      expect(mergeChunks(chunks)).toBe(payload)
    }
  })

  it('乱序传入仍按 part 序合并', () => {
    const payload = 'b'.repeat(DEFAULT_MAX_DATA_BYTES + 1)
    const chunks = splitIntoChunks(payload, 5, 100)
    expect(mergeChunks([...chunks].reverse())).toBe(payload)
  })

  it('缺片 → null', () => {
    const chunks = splitIntoChunks('c'.repeat(DEFAULT_MAX_DATA_BYTES + 1), 1, 1)
    expect(mergeChunks(chunks.slice(1))).toBeNull()
  })

  it('rev 不一致 → null', () => {
    const chunks = splitIntoChunks('d'.repeat(DEFAULT_MAX_DATA_BYTES + 1), 1, 1)
    const bad: SyncChunk[] = chunks.map((c, i) => (i === 1 ? { ...c, rev: 2 } : c))
    expect(mergeChunks(bad)).toBeNull()
  })

  it('updatedAt 不一致 → null', () => {
    const chunks = splitIntoChunks('e'.repeat(DEFAULT_MAX_DATA_BYTES + 1), 1, 1)
    const bad: SyncChunk[] = chunks.map((c, i) => (i === 1 ? { ...c, updatedAt: 999 } : c))
    expect(mergeChunks(bad)).toBeNull()
  })

  it('total 不一致 → null', () => {
    const chunks = splitIntoChunks('f'.repeat(DEFAULT_MAX_DATA_BYTES + 1), 1, 1)
    const bad: SyncChunk[] = chunks.map((c, i) => (i === 1 ? { ...c, total: 3 } : c))
    expect(mergeChunks(bad)).toBeNull()
  })

  it('part 越界/重复 → null', () => {
    const chunks = splitIntoChunks('g'.repeat(DEFAULT_MAX_DATA_BYTES + 1), 1, 1)
    expect(mergeChunks([{ ...chunks[0]!, part: 2 }])).toBeNull()
    expect(mergeChunks([chunks[0]!, chunks[0]!, chunks[1]!])).toBeNull()
  })

  it('data 非 string → null', () => {
    const chunks = splitIntoChunks('h'.repeat(DEFAULT_MAX_DATA_BYTES + 1), 1, 1)
    const bad = [{ ...chunks[1]!, data: 123 }] as unknown as SyncChunk[]
    expect(mergeChunks(bad)).toBeNull()
  })

  it('data 非法 base64 → null', () => {
    const chunks = splitIntoChunks('hello', 1, 1)
    const [c] = chunks
    // 非字母表字符
    expect(mergeChunks([{ ...c!, data: 'aGVsbG8!' }])).toBeNull()
    // padding 位置非法（中间 '='）
    expect(mergeChunks([{ ...c!, data: 'aG=sbG8' }])).toBeNull()
    // 长度非 4 倍数（截断）
    expect(mergeChunks([{ ...c!, data: 'aGVsbG' }])).toBeNull()
  })

  it('data 含空白（atob 会静默剥离产生截断 payload）→ null', () => {
    const chunks = splitIntoChunks('hello', 1, 1)
    const [c] = chunks
    expect(mergeChunks([{ ...c!, data: ` ${c!.data}` }])).toBeNull()
    expect(mergeChunks([{ ...c!, data: c!.data.replace('aGV', 'aGV\n') }])).toBeNull()
  })

  it('合法 base64 但解码后非合法 UTF-8（fatal 解码抛错）→ null（catch 兜底，不产出乱码 payload）', () => {
    // 0xFF 0xFE 是合法字节的 base64（'/w=='→[0xFF]、'3/4'→[0xDF,0xFE] 截断代理），TextDecoder fatal 抛 TypeError
    const bad = mergeChunks([{ rev: 1, updatedAt: 1, part: 0, total: 1, data: bytesToBase64(new Uint8Array([0xff, 0xfe])) }])
    expect(bad).toBeNull()
  })

  it('空数组 → null', () => {
    expect(mergeChunks([])).toBeNull()
  })

  it('首片缺失（数组含 undefined 槽位）→ null；total<1 → null', () => {
    expect(mergeChunks([undefined as unknown as SyncChunk])).toBeNull()
    expect(mergeChunks([{ rev: 1, updatedAt: 1, part: 0, total: 0, data: '' }])).toBeNull()
    expect(mergeChunks([{ rev: 1, updatedAt: 1, part: 0, total: -3, data: '' }])).toBeNull()
    expect(mergeChunks([{ rev: 1, updatedAt: 1, part: 0, total: 1.5, data: '' }])).toBeNull()
  })
})

describe('chunksToMeta', () => {
  it('空数组 → 抛错（meta 必须来自非空分片集）', () => {
    expect(() => chunksToMeta([])).toThrow('chunks must not be empty')
  })
  it('从任一片提取 rev/updatedAt/total', () => {
    const chunks = splitIntoChunks('i'.repeat(DEFAULT_MAX_DATA_BYTES + 1), 77, 8888)
    expect(chunksToMeta(chunks)).toEqual({ rev: 77, updatedAt: 8888, total: 2 })
    expect(chunksToMeta(chunks.slice(1))).toEqual({ rev: 77, updatedAt: 8888, total: 2 })
  })
})

describe('staleChunkKeys', () => {
  it('旧 total=3 → 新 total=2：全部旧键都应删除', () => {
    const old = splitIntoChunks('j'.repeat(15000), 1, 1) // 3 片
    const fresh = splitIntoChunks('k'.repeat(9000), 2, 2) // 2 片
    expect(old).toHaveLength(3)
    expect(fresh).toHaveLength(2)
    // 新键 sync:v1:0/2、sync:v1:1/2 与旧键 sync:v1:0/3、sync:v1:1/3、sync:v1:2/3 完全不同名
    expect(staleChunkKeys(old, fresh)).toEqual(['sync:v1:0/3', 'sync:v1:1/3', 'sync:v1:2/3'])
  })

  it('total 相同且键同名（fresh 覆盖）→ 无多余旧键', () => {
    const old = splitIntoChunks('l'.repeat(DEFAULT_MAX_DATA_BYTES + 1), 1, 1) // 2 片
    const fresh = splitIntoChunks('m'.repeat(DEFAULT_MAX_DATA_BYTES + 1), 2, 2) // 2 片，键同名
    expect(staleChunkKeys(old, fresh)).toEqual([])
  })

  it('total 收缩且部分同名：只返回未被覆盖的多余键', () => {
    const old = splitIntoChunks('n'.repeat(15000), 1, 1) // 3 片：0/3,1/3,2/3
    const fresh = splitIntoChunks('o'.repeat(DEFAULT_MAX_DATA_BYTES + 1), 2, 2) // 2 片，total 不同 → 键全不同名
    // 构造部分同名：旧 fresh 前两片与新 total 同名的情况不存在（total 进键名），
    // 因此用旧 total=2 → 新 total=2 但旧片更多时不成立；改为旧 3 片 total=2 的手工构造
    const manualOld: SyncChunk[] = [
      { rev: 1, updatedAt: 1, part: 0, total: 2, data: '' },
      { rev: 1, updatedAt: 1, part: 1, total: 2, data: '' },
      { rev: 1, updatedAt: 1, part: 2, total: 2, data: '' }, // 脏数据残留
    ]
    expect(staleChunkKeys(manualOld, fresh)).toEqual(['sync:v1:2/2'])
    expect(staleChunkKeys(old, fresh)).toEqual(['sync:v1:0/3', 'sync:v1:1/3', 'sync:v1:2/3'])
  })

  it('fresh 为空 → 全部旧键都删除', () => {
    const old = splitIntoChunks('p'.repeat(DEFAULT_MAX_DATA_BYTES + 1), 1, 1)
    expect(staleChunkKeys(old, [])).toEqual(['sync:v1:0/2', 'sync:v1:1/2'])
  })
})
