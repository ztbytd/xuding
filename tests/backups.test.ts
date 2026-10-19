import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { SubscriptionRepository } from '../src/main/database'
import { DatabaseSync } from 'node:sqlite'
import { readdirSync } from 'node:fs'
import { localDate } from '../src/shared/billing'
import { BackupService } from '../src/main/backups'
import { subscription } from './fixtures'

describe('automatic backups and guarded restoration', () => {
  let directory: string, repo: SubscriptionRepository, service: BackupService
  let clock = new Date('2026-10-19T10:00:00Z')
  const { id: _id, createdAt: _created, updatedAt: _updated, ...input } = subscription()
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'xuding-backup-test-'))
    repo = new SubscriptionRepository(join(directory, 'ledger.db'))
    clock = new Date('2026-10-19T10:00:00Z')
    service = new BackupService(repo, join(directory, 'backups'), () => clock)
  })
  afterEach(async () => {
    await service.flush().catch(() => {})
    repo.close()
    const target = resolve(directory)
    if (
      !target.startsWith(resolve(tmpdir()) + sep) ||
      !basename(target).startsWith('xuding-backup-test-')
    )
      throw new Error('Unexpected test cleanup path')
    await rm(target, { recursive: true, force: true })
  })
  it('coalesces same-day changes and preserves icon and entitlement dates', async () => {
    const item = repo.save({
      ...input,
      autoRenew: false,
      accessEndsOn: '2026-11-30',
      icon: 'data:image/png;base64,iVBORw0KGgo='
    })
    await service.automatic()
    repo.save(
      {
        ...input,
        amountMinor: 777,
        autoRenew: false,
        accessEndsOn: item.accessEndsOn,
        icon: item.icon
      },
      item.id
    )
    service.changed()
    await service.flush()
    const history = await service.history()
    expect(history).toHaveLength(1)
    expect(history[0]).toMatchObject({ kind: 'daily', count: 1 })
    expect(
      JSON.parse(await readFile(join(service.status().directory, history[0].id), 'utf8'))
        .subscriptions[0]
    ).toMatchObject({ amountMinor: 777, accessEndsOn: '2026-11-30', icon: item.icon })
    expect((await readdir(service.status().directory)).some((name) => name.endsWith('.tmp'))).toBe(
      false
    )
    expect(service.status()).toMatchObject({ pending: false, lastError: null })
  })
  it('applies retention only to recognized files and preserves a manual JSON', async () => {
    repo.save(input)
    await service.automatic()
    const manualFile = join(service.status().directory, 'personal-backup.json')
    await writeFile(manualFile, 'personal')
    clock = new Date('2026-11-10T10:00:00Z')
    await service.automatic()
    expect((await service.history()).map((item) => item.id)).toEqual(['daily-2026-11-10.json'])
    expect(await readFile(manualFile, 'utf8')).toBe('personal')
  })
  it('previews merge counts and creates a recovery snapshot before changing records', async () => {
    const first = repo.save(input)
    await service.nowBackup()
    const backup = (await service.history())[0]
    repo.save({ ...input, amountMinor: 9000 }, first.id)
    repo.save({ ...input, name: '保留项目' })
    const preview = await service.preview(backup.id)
    expect(preview).toMatchObject({ added: 0, overwritten: 1, retained: 1, count: 1 })
    expect(await service.restore(preview.token)).toBe(1)
    expect(repo.list()).toHaveLength(2)
    expect(repo.list().find((s) => s.id === first.id)?.amountMinor).toBe(input.amountMinor)
    const safety = (await service.history()).find((entry) => entry.kind === 'before-restore')!
    const original = JSON.parse(await readFile(join(service.status().directory, safety.id), 'utf8'))
    expect(original.subscriptions.find((s: { id: string }) => s.id === first.id).amountMinor).toBe(
      9000
    )
    await expect(service.restore(preview.token)).rejects.toThrow('预览已过期')
    await expect(service.preview('../ledger.db')).rejects.toThrow('文件名无效')
  })
  it('refuses stale previews and cancels restoration if the safety snapshot fails', async () => {
    const first = repo.save(input)
    await service.nowBackup()
    const entry = (await service.history())[0]
    const preview = await service.preview(entry.id)
    repo.save({ ...input, amountMinor: 123 }, first.id)
    await expect(service.restore(preview.token)).rejects.toThrow('账本已发生变化')
    const blocked = join(directory, 'not-a-folder')
    await writeFile(blocked, 'blocked')
    repo.saveMetadata('backup-state', {
      ...(repo.metadata('backup-state') as Record<string, unknown>),
      directory: blocked
    })
    const failing = new BackupService(repo, blocked, () => clock)
    const toRestore = await failing.prepareFile(join(service.status().directory, entry.id))
    await expect(failing.restore(toRestore.token)).rejects.toThrow()
    expect(repo.list()[0].amountMinor).toBe(123)
    expect(failing.status().lastError).toBeTruthy()
  })
  it('honors disabling automatic backups and reloads preferences and status on restart', async () => {
    repo.save(input)
    repo.saveSettings({ autoBackupEnabled: false, closeBehavior: 'tray' })
    service.changed()
    await service.flush()
    expect(await service.history()).toEqual([])
    await service.nowBackup()
    repo.close()
    repo = new SubscriptionRepository(join(directory, 'ledger.db'))
    service = new BackupService(repo, join(directory, 'backups'), () => clock)
    expect(repo.settings()).toMatchObject({
      autoBackupEnabled: false,
      closeBehavior: 'tray',
      launchAtLogin: false
    })
    expect(service.status().lastSuccess).toBe(clock.toISOString())
    expect(await service.history()).toHaveLength(1)
  })
  it('invalidates a restore preview after changing a bill or price', async () => {
    const item = repo.save({ ...input, anchorDate: localDate() })
    await service.nowBackup()
    const entry = (await service.history())[0]
    const first = await service.preview(entry.id),
      bill = repo.ledger.bills()[0]
    repo.ledger.updateBill(
      { id: bill.id, expectedUpdatedAt: bill.updatedAt, status: 'skipped' },
      null
    )
    await expect(service.restore(first.token)).rejects.toThrow('账本已发生变化')
    const second = await service.preview(entry.id)
    repo.ledger.changePrice({
      subscriptionId: item.id,
      effectiveOn: localDate(),
      amountMinor: 777,
      currency: 'CNY'
    })
    await expect(service.restore(second.token)).rejects.toThrow('账本已发生变化')
  })
  it.each([1, 2, 3])(
    'upgrades database version %i with an intact SQLite recovery copy',
    (version) => {
      const file = join(directory, 'legacy.db')
      const legacy = new DatabaseSync(file)
      legacy.exec(
        'CREATE TABLE subscriptions (id TEXT PRIMARY KEY, document TEXT NOT NULL, updated_at TEXT NOT NULL); CREATE TABLE subscription_changes (id INTEGER PRIMARY KEY, subscription_id TEXT NOT NULL, document TEXT NOT NULL, changed_at TEXT NOT NULL); CREATE TABLE settings (key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE reminders (key TEXT PRIMARY KEY,sent_at TEXT NOT NULL); PRAGMA user_version=1;'
      )
      if (version === 3)
        legacy.exec(
          `CREATE TABLE bills(id TEXT PRIMARY KEY,subscription_id TEXT,due TEXT,manual INTEGER,document TEXT);CREATE TABLE prices(id TEXT PRIMARY KEY,subscription_id TEXT,effective_on TEXT,document TEXT,UNIQUE(subscription_id,effective_on));CREATE TABLE ledger_changes(id TEXT PRIMARY KEY,subscription_id TEXT,document TEXT);CREATE TABLE billing_tracking(subscription_id TEXT PRIMARY KEY,document TEXT);CREATE TABLE ledger_events(id INTEGER PRIMARY KEY AUTOINCREMENT);`
        )
      legacy.exec(`PRAGMA user_version=${version}`)
      const item = subscription({ anchorDate: '2025-01-31' })
      legacy
        .prepare('INSERT INTO subscriptions VALUES(?,?,?)')
        .run(item.id, JSON.stringify(item), item.updatedAt)
      legacy
        .prepare('INSERT INTO settings VALUES(?,?)')
        .run('preferences', JSON.stringify({ notificationsEnabled: true }))
      if (version === 3) {
        const price = {
          id: '00000000-0000-4000-8000-000000000009',
          subscriptionId: item.id,
          amountMinor: item.amountMinor,
          currency: item.currency,
          effectiveOn: '1970-01-01',
          createdAt: item.createdAt
        }
        legacy
          .prepare('INSERT INTO prices VALUES(?,?,?,?)')
          .run(price.id, item.id, price.effectiveOn, JSON.stringify(price))
        legacy.prepare('INSERT INTO billing_tracking VALUES(?,?)').run(
          item.id,
          JSON.stringify({
            subscriptionId: item.id,
            startedOn: '2026-01-31',
            through: '2026-01-30'
          })
        )
      }
      legacy.close()
      const migrated = new SubscriptionRepository(file, () => new Date('2026-01-31T12:00:00+08:00'))
      try {
        expect(migrated.list()).toEqual([item])
        expect(migrated.settings()).toMatchObject({
          notificationsEnabled: true,
          closeBehavior: 'ask',
          autoBackupEnabled: true,
          launchAtLogin: false
        })
        expect(migrated.export().subscriptions[0].accessEndsOn).toBeUndefined()
        expect(migrated.ledger.bills()).toHaveLength(0)
        migrated.ledger.sync()
        expect(migrated.ledger.bills().map((b) => b.due)).toEqual(['2026-01-31'])
      } finally {
        migrated.close()
      }
      const check = new DatabaseSync(file)
      try {
        expect(check.prepare('PRAGMA user_version').get()!.user_version).toBe(4)
      } finally {
        check.close()
      }
      const snapshot = readdirSync(directory).find((name) => name.startsWith('legacy.db.pre-v4-'))!
      expect(snapshot).toBeTruthy()
      const before = new DatabaseSync(join(directory, snapshot), { readOnly: true })
      try {
        expect(before.prepare('PRAGMA user_version').get()!.user_version).toBe(version)
        expect(
          JSON.parse(String(before.prepare('SELECT document FROM subscriptions').get()!.document))
        ).toEqual(item)
      } finally {
        before.close()
      }
    }
  )
})
