import { describe, expect, it } from 'vitest'

describe('workspace', () => {
  it('node 20+ 提供 webcrypto', () => {
    expect(crypto.subtle).toBeDefined()
  })
})
