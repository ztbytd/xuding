import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { SubscriptionRepository } from '../src/main/database'
import { BackupService } from '../src/main/backups'
import { CsvService } from '../src/main/csv'
import { autoMapping, csvDate, exportCsv, parseCsv, serializeCsv } from '../src/shared/csv'
import type { CsvKind, CsvOptions, CsvOperation } from '../src/shared/csv-model'
import { subscription } from './fixtures'
import { actualTotals } from '../src/shared/ledger'

describe('CSV exchange and guarded atomic import', () => {
  let directory: string, repo: SubscriptionRepository, backup: BackupService, service: CsvService
  const clock = () => new Date('2026-10-19T12:00:00+08:00')
  const { id, createdAt, updatedAt, ...input } = subscription({
    autoRenew: false,
    anchorDate: '2026-10-19',
    currency: 'CNY'
  })
  const load = async (text: string | Buffer, kind: CsvKind = 'subscriptions') => {
    const path = join(directory, 'input.csv')
    await writeFile(path, text)
    const file = await service.choose(path)
    return {
      file,
      options: {
        fileToken: file.token,
        kind,
        mapping: autoMapping(file.headers, kind),
        dateOrder: 'YMD',
        conversion: 'none',
        defaults: {
          currency: 'CNY',
          category: '效率工具',
          cycle: 'month',
          interval: 1,
          anchorDate: '2026-10-19',
          autoRenew: false,
          status: 'active'
        },
        priceEffectiveOn: '2026-10-19',
        decisions: []
      } satisfies CsvOptions
    }
  }
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'xuding-csv-'))
    repo = new SubscriptionRepository(join(directory, 'ledger.db'), clock)
    repo.saveSettings({ autoBackupEnabled: false })
    backup = new BackupService(repo, join(directory, 'backups'), clock)
    service = new CsvService(repo, backup, clock)
  })
  afterEach(async () => {
    await backup.flush().catch(() => {})
    repo.close()
    const target = resolve(directory)
    if (!target.startsWith(resolve(tmpdir()) + sep) || !basename(target).startsWith('xuding-csv-'))
      throw new Error('Unexpected cleanup')
    await rm(target, { recursive: true, force: true })
  })
  it('parses escaped quotes, BOM, newlines and common delimiters while rejecting broken files', () => {
    expect(parseCsv('\uFEFFname,notes\r\n"会员","逗号,引号""和\n换行"\r\n').rows).toEqual([
      ['会员', '逗号,引号"和\n换行']
    ])
    expect(parseCsv('name;amount\nA;19\n').rows).toEqual([['A', '19']])
    expect(parseCsv('name\tamount\nA\t19\n').rows).toEqual([['A', '19']])
    expect(() => parseCsv('name\n"unfinished')).toThrow('未闭合')
    expect(() => parseCsv('name\nA,B')).toThrow('列数')
    expect(() => parseCsv('name\n' + 'x'.repeat(10001))).toThrow('单元格')
    expect(() => csvDate('03/04/2026', 'YMD')).toThrow('日期顺序')
    expect(csvDate('03/04/2026', 'DMY')).toBe('2026-04-03')
    expect(() => csvDate('2026-02-30', 'YMD')).toThrow('无效日期')
  })
  it('detects GB18030 and exports formula-safe text that roundtrips through the importer', async () => {
    const bytes = Buffer.concat([
      Buffer.from('name,amount,currency\n'),
      Buffer.from('d4c6c5cc', 'hex'),
      Buffer.from(',19,CNY\n')
    ])
    const first = await load(bytes)
    expect(first.file.encoding).toBe('gb18030')
    expect(first.file.rows[0][0]).toBe('云盘')
    const s = repo.save({ ...input, name: '=HYPERLINK("x")', notes: 'a,b\n"quote"' })
    const text = exportCsv({ kind: 'subscriptions', currency: 'CNY' }, repo.list(), [])
    expect(text.startsWith('\uFEFF')).toBe(true)
    expect(parseCsv(text).rows[0][1].startsWith("'=")).toBe(true)
    const { options } = await load(text)
    const preview = service.preview(options, null)
    expect(preview.rows[0].name).toBe(s.name)
    expect(preview.skipped).toBe(1)
    expect(preview.rows[0].values.notes).toBe(s.notes)
  })
  it('blocks all writes with errors, supports explicit exclusions and creates a full undo snapshot', async () => {
    const { options } = await load('name,amount,currency\n有效会员,19.99,CNY\n错误会员,-1,CNY\n')
    const invalid = service.preview(options, null)
    expect(invalid).toMatchObject({ added: 1, errors: 1 })
    await expect(service.commit(invalid.token)).rejects.toThrow('错误行')
    expect(repo.list()).toHaveLength(0)
    const valid = service.preview({ ...options, decisions: [{ row: 3, action: 'skip' }] }, null)
    const batch = await service.commit(valid.token)
    expect(batch).toMatchObject({ added: 1, skipped: 1 })
    expect(repo.list()).toHaveLength(1)
    const saved = JSON.parse(
      await readFile(join(backup.status().directory, batch.safetyBackup), 'utf8')
    )
    expect(saved.subscriptions).toHaveLength(0)
    const preview = await backup.preview(batch.safetyBackup)
    await backup.restore(preview.token, 'replace')
    expect(repo.list()).toHaveLength(0)
    expect(repo.finance.batches()).toHaveLength(0)
    await expect(service.commit(valid.token)).rejects.toThrow('预览已过期')
  })
  it('defaults to skipping duplicate subscriptions, handles row corrections and supports explicit price updates', async () => {
    const s = repo.save(input)
    const { options } = await load(
      serializeCsv([
        ['subscription_id', 'name', 'amount', 'currency'],
        [s.id, s.name, '29.99', 'USD']
      ])
    )
    expect(service.preview(options, null).skipped).toBe(1)
    const preview = service.preview(
      { ...options, priceEffectiveOn: '2026-11-01', decisions: [{ row: 2, action: 'update' }] },
      null
    )
    await service.commit(preview.token)
    expect(repo.list()[0].amountMinor).toBe(input.amountMinor)
    expect(repo.ledger.prices()[0]).toMatchObject({
      amountMinor: 2999,
      currency: 'USD',
      effectiveOn: '2026-11-01'
    })
    const repeated = service.preview(options, null)
    expect(repeated.skipped).toBe(1)
  })
  it('rejects stale previews and stops when the recovery file cannot be saved', async () => {
    const { options } = await load('name,amount\n会员,19\n')
    const preview = service.preview(options, null)
    repo.finance.save({
      month: '2026-10',
      enabled: true,
      currency: 'CNY',
      amountMinor: 50000,
      threshold: 80,
      allocations: []
    })
    await expect(service.commit(preview.token)).rejects.toThrow('账本已发生变化')
    const file = join(directory, 'blocked')
    await writeFile(file, 'not a directory')
    repo.saveMetadata('backup-state', {
      directory: file,
      lastSuccess: null,
      lastError: null,
      revision: -1,
      day: ''
    })
    const failingBackup = new BackupService(repo, file, clock),
      failing = new CsvService(repo, failingBackup, clock)
    const chosen = await failing.choose(join(directory, 'input.csv')),
      blocked = failing.preview({ ...options, fileToken: chosen.token }, null)
    await expect(failing.commit(blocked.token)).rejects.toThrow()
    expect(repo.list()).toHaveLength(0)
  })
  it('matches existing pending bills, preserves historical converted amounts and prevents repeat charges', async () => {
    const s = repo.save({ ...input, autoRenew: true }),
      pending = repo.ledger.bills()[0]
    const { options } = await load(
      serializeCsv([
        [
          'subscription_id',
          'name',
          'due',
          'amount',
          'currency',
          'status',
          'payment_amount',
          'payment_currency',
          'paid_on',
          'converted_amount',
          'converted_currency',
          'fx_date'
        ],
        [
          s.id,
          s.name,
          '2026-10-19',
          '100',
          'USD',
          'paid',
          '100',
          'USD',
          '2026-10-19',
          '720',
          'CNY',
          '2026-10-16'
        ]
      ]),
      'bills'
    )
    expect(service.preview(options, null).skipped).toBe(1)
    const preview = service.preview({ ...options, decisions: [{ row: 2, action: 'update' }] }, null)
    expect(preview.errors).toBe(0)
    await service.commit(preview.token)
    expect(repo.ledger.bills()).toHaveLength(1)
    expect(repo.ledger.bills()[0].id).toBe(pending.id)
    expect(actualTotals(repo.ledger.bills(), 'CNY', '2026-10-01', '2026-10-31').total).toBe(72000)
    expect(service.preview(options, null)).toMatchObject({ skipped: 1, added: 0 })
    const exported = parseCsv(
      exportCsv({ kind: 'bills', currency: 'CNY' }, repo.list(), repo.ledger.bills())
    )
    expect(exported.rows[0][exported.headers.indexOf('汇率参考日期')]).toBe('2026-10-16')
  })
  it('requires explicit mapping for ambiguous names and supports creating a related subscription', async () => {
    const { options } = await load(
      'name,due,payment_amount,payment_currency,paid_on\n新订阅,2026-09-01,19,CNY,2026-09-01\n新订阅,2026-10-01,19,CNY,2026-10-01\n',
      'bills'
    )
    expect(service.preview(options, null).errors).toBe(2)
    const preview = service.preview(
      {
        ...options,
        decisions: [{ row: 2, action: 'auto', createSubscription: { ...input, name: '新订阅' } }]
      },
      null
    )
    expect(preview).toMatchObject({ added: 2, errors: 0 })
    await service.commit(preview.token)
    expect(repo.list()).toHaveLength(1)
    expect(repo.ledger.bills()).toHaveLength(2)
    repo.save({ ...input, name: '新订阅' })
    const ambiguous = service.preview(options, null)
    expect(ambiguous.rows[0].message).toContain('多个订阅')
  })
  it('does not leave half a batch after a database constraint failure', () => {
    const newId = randomUUID(),
      newSubscription = subscription({ id: newId }),
      badBill = {
        id: randomUUID(),
        subscriptionId: randomUUID(),
        due: '2026-10-19',
        amountMinor: 100,
        currency: 'CNY',
        category: '效率工具',
        status: 'pending',
        manual: false,
        payment: null,
        rates: null,
        createdAt: clock().toISOString(),
        updatedAt: clock().toISOString()
      }
    const operations = [
      { kind: 'subscription', item: newSubscription, effectiveOn: '1970-01-01' },
      { kind: 'bill', item: badBill }
    ] as CsvOperation[]
    expect(() =>
      repo.commitCsv(
        operations,
        {
          id: randomUUID(),
          source: 'test.csv',
          kind: 'bills',
          createdAt: clock().toISOString(),
          added: 2,
          updated: 0,
          skipped: 0,
          safetyBackup: 'test'
        },
        repo.revision()
      )
    ).toThrow()
    expect(repo.list()).toHaveLength(0)
    expect(repo.finance.batches()).toHaveLength(0)
  })
  it('applies explicit corrections and an unambiguous selected date order', async () => {
    const { options } = await load('name,amount,anchor_date\n会员,wrong,03/04/2026\n')
    expect(service.preview(options, null).errors).toBe(1)
    const corrected = service.preview(
      {
        ...options,
        dateOrder: 'DMY',
        decisions: [{ row: 2, action: 'auto', corrections: { amount: '19.99' } }]
      },
      null
    )
    expect(corrected).toMatchObject({ errors: 0, added: 1 })
    await service.commit(corrected.token)
    expect(repo.list()[0]).toMatchObject({ amountMinor: 1999, anchorDate: '2026-04-03' })
  })
  it('recognizes duplicate payments even with a different external bill ID', async () => {
    const s = repo.save(input)
    repo.ledger.addBill(
      {
        subscriptionId: s.id,
        due: '2026-09-01',
        payment: { amountMinor: 1900, currency: 'CNY', paidOn: '2026-09-01' }
      },
      null
    )
    const { options } = await load(
      serializeCsv([
        ['bill_id', 'subscription_id', 'due', 'payment_amount', 'payment_currency', 'paid_on'],
        [randomUUID(), s.id, '2026-09-01', '19', 'CNY', '2026-09-01']
      ]),
      'bills'
    )
    expect(service.preview(options, null)).toMatchObject({ skipped: 1, added: 0 })
  })
})
