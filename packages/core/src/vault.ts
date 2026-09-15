import type { Group, OtpEntry, Vault } from './model'
import { toOtpDigits } from './import/normalize'
import { parseOtpUri } from './otp/uri'

export function createVault(): Vault {
  return { version: 1, entries: [], groups: [], updatedAt: 0 }
}

function withVault(v: Vault, patch: Partial<Vault>): Vault {
  return { ...v, ...patch, updatedAt: Date.now() }
}

export function addEntry(v: Vault, entry: OtpEntry): Vault {
  const maxOrder = v.entries.reduce((m, e) => Math.max(m, e.order), -1)
  return withVault(v, { entries: [...v.entries, { ...entry, order: maxOrder + 1 }] })
}

export function removeEntry(v: Vault, uuid: string): Vault {
  return withVault(v, { entries: v.entries.filter((e) => e.uuid !== uuid) })
}

export function updateEntry(v: Vault, uuid: string, patch: Partial<Omit<OtpEntry, 'uuid'>>): Vault {
  return withVault(v, { entries: v.entries.map((e) => (e.uuid === uuid ? { ...e, ...patch } : e)) })
}

export function addGroup(v: Vault, name: string): Vault {
  const group: Group = { id: crypto.randomUUID(), name, order: v.groups.length }
  return withVault(v, { groups: [...v.groups, group] })
}

export function renameGroup(v: Vault, id: string, name: string): Vault {
  return withVault(v, { groups: v.groups.map((g) => (g.id === id ? { ...g, name } : g)) })
}

export function removeGroup(v: Vault, id: string): Vault {
  return withVault(v, {
    groups: v.groups.filter((g) => g.id !== id),
    entries: v.entries.map((e) => (e.groupIds.includes(id) ? { ...e, groupIds: e.groupIds.filter((g) => g !== id) } : e)),
  })
}

export function reorderEntries(v: Vault, orderedUuids: string[]): Vault {
  const orderMap = new Map(orderedUuids.map((uuid, i) => [uuid, i]))
  return withVault(v, {
    entries: v.entries.map((e) => (orderMap.has(e.uuid) ? { ...e, order: orderMap.get(e.uuid)! } : e)),
  })
}

export function newEntryFromUri(uri: string, nowMs: number = Date.now()): OtpEntry {
  const p = parseOtpUri(uri)
  return {
    uuid: crypto.randomUUID(),
    type: p.type,
    issuer: p.issuer,
    label: p.label,
    secret: p.secret,
    algorithm: p.algorithm,
    digits: toOtpDigits(p.digits, p.type),
    period: p.period,
    ...(p.counter !== undefined ? { counter: p.counter } : {}),
    groupIds: [],
    order: 0,
    createdAt: nowMs,
  }
}
