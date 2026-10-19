import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SubscriptionRepository } from '../src/main/database'
import { subscription } from './fixtures'

describe('local storage', () => {
  let repo: SubscriptionRepository
  beforeEach(() => {
    repo = new SubscriptionRepository(':memory:')
  })
  afterEach(() => repo.close())
  const { id, createdAt, updatedAt, ...input } = subscription()
  it('creates, edits, and archives real records', () => {
    const item = repo.save(input)
    expect(repo.list()).toHaveLength(1)
    expect(repo.save({ ...input, amountMinor: 1999 }, item.id).createdAt).toBe(item.createdAt)
    repo.archive(item.id)
    expect(repo.list()[0]).toMatchObject({
      amountMinor: 1999,
      status: 'archived',
      autoRenew: false
    })
  })
  it('round-trips backups and merges without erasing unrelated subscriptions', () => {
    const first = repo.save(input),
      backup = repo.export()
    repo.save({ ...input, name: '第二项' })
    repo.save({ ...input, amountMinor: 7777 }, first.id)
    expect(repo.import(backup)).toBe(1)
    expect(repo.list()).toHaveLength(2)
    expect(repo.list().find((s) => s.id === first.id)?.amountMinor).toBe(input.amountMinor)
  })
  it('rejects the entire invalid backup before writing any records', () => {
    const item = repo.save(input)
    const invalid = {
      format: 'xuding',
      version: 1,
      exportedAt: new Date().toISOString(),
      subscriptions: [subscription(), { ...subscription(), id: 'invalid' }]
    }
    expect(() => repo.import(invalid)).toThrow()
    expect(repo.list().map((s) => s.id)).toEqual([item.id])
  })
  it('rejects duplicate IDs and records notification deduplication', () => {
    const item = repo.save(input),
      backup = repo.export()
    expect(() => repo.import({ ...backup, subscriptions: [item, item] })).toThrow()
    expect(repo.hasReminder('test')).toBe(false)
    repo.markReminder('test')
    repo.markReminder('test')
    expect(repo.hasReminder('test')).toBe(true)
  })
  it('starts with notifications disabled and persists explicit preference', () => {
    expect(repo.settings().notificationsEnabled).toBe(false)
    repo.saveSettings({ notificationsEnabled: true })
    expect(repo.settings().notificationsEnabled).toBe(true)
  })
  it('keeps embedded icons in edits, backups, and archives while accepting older records', () => {
    const icon =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=='
    const old = repo.save(input)
    expect(old.icon).toBeUndefined()
    repo.save({ ...input, icon }, old.id)
    const backup = repo.export()
    repo.save(input, old.id)
    expect(repo.list()[0].icon).toBeUndefined()
    repo.import(backup)
    expect(repo.list()[0].icon).toBe(icon)
    repo.archive(old.id)
    expect(repo.list()[0].icon).toBe(icon)
    expect(() => repo.save({ ...input, icon: 'https://example.com/icon.png' })).toThrow()
    expect(() => repo.save({ ...input, icon: 'data:image/svg+xml;base64,PHN2Zz4=' })).toThrow()
    expect(() => repo.save({ ...input, icon: icon + 'A'.repeat(100_000) })).toThrow()
  })
})
