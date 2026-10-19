import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { SubscriptionRepository } from '../src/main/database'
import { SyncEngine } from '../src/main/sync'
import { WebDavTransport } from '../src/main/webdav'
import { mergeRecords } from '../src/shared/sync'
import type { SyncConnection } from '../src/shared/sync-model'
let server: Server,
  url: string,
  files: Map<string, { bytes: Buffer; etag: string }>,
  repos: SubscriptionRepository[] = []
let secrets: Map<string, string>
const store = {
  async createSecret(s: string) {
    const id = randomUUID()
    secrets.set(id, s)
    return id
  },
  async readSecret(id: string) {
    const s = secrets.get(id)
    if (!s) throw new Error('credential missing')
    return s
  },
  async remove(id: string) {
    secrets.delete(id)
  }
}
const input = {
  name: 'SYNC-PRIVATE-SUBSCRIPTION',
  category: '效率工具' as const,
  amountMinor: 2000,
  currency: 'CNY' as const,
  cycle: 'month' as const,
  interval: 1,
  anchorDate: '2026-10-22',
  status: 'active' as const,
  autoRenew: true,
  reminderDays: 3 as const,
  website: '',
  notes: ''
}
const passphrase = '同步口令 private 2026'
function repo() {
  const r = new SubscriptionRepository(':memory:')
  repos.push(r)
  return r
}
function engine(r: SubscriptionRepository) {
  return new SyncEngine(r, store, async () => {}, fetch, true)
}
function connection(name: string): SyncConnection {
  return { url, username: 'tester', password: 'webdav-password', deviceName: name }
}
async function connect(
  e: SyncEngine,
  name: string,
  mode: 'merge' | 'replace' = 'merge',
  password = passphrase
) {
  const p = await e.prepare(connection(name), password)
  const r = await e.connect(p.preview!.token, mode)
  expect(r.error).toBeNull()
  return p
}
beforeEach(async () => {
  files = new Map()
  secrets = new Map()
  server = createServer(async (req, res) => {
    if (
      req.headers.authorization !==
      'Basic ' + Buffer.from('tester:webdav-password').toString('base64')
    ) {
      res.writeHead(401).end()
      return
    }
    const name = req.url!,
      chunks: Buffer[] = []
    for await (const c of req) chunks.push(Buffer.from(c))
    const old = files.get(name)
    if (req.method === 'GET') {
      if (!old) {
        res.writeHead(404).end()
        return
      }
      res.writeHead(200, { ETag: old.etag, 'Content-Length': old.bytes.length }).end(old.bytes)
      return
    }
    if (req.method === 'DELETE') {
      files.delete(name)
      res.writeHead(204).end()
      return
    }
    if (req.method === 'PUT') {
      if (
        (req.headers['if-none-match'] === '*' && old) ||
        (req.headers['if-match'] && req.headers['if-match'] !== old?.etag)
      ) {
        res.writeHead(412).end()
        return
      }
      const bytes = Buffer.concat(chunks),
        etag = '"' + createHash('sha256').update(bytes).digest('hex') + '"'
      files.set(name, { bytes, etag })
      res.writeHead(201, { ETag: etag }).end()
      return
    }
    res.writeHead(405).end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  url = 'http://127.0.0.1:' + (server.address() as { port: number }).port + '/ledger/'
})
afterEach(async () => {
  for (const r of repos) r.close()
  repos = []
  await new Promise<void>((resolve) => server.close(() => resolve()))
})
describe('encrypted WebDAV synchronization', () => {
  it('requires HTTPS outside isolated tests and probes real compare-and-swap', async () => {
    expect(() => new WebDavTransport(connection('a'))).toThrow('HTTPS')
    await new WebDavTransport(connection('a'), fetch, true).test()
    expect(files.size).toBe(0)
  })
  it('joins two devices, merges offline edits, and never uploads names or credentials', async () => {
    const a = repo(),
      s = a.save(input),
      ea = engine(a)
    await connect(ea, '电脑 A')
    const b = repo(),
      eb = engine(b)
    await connect(eb, '电脑 B', 'replace')
    expect(b.list()[0].id).toBe(s.id)
    a.save({ ...input, name: 'Renamed offline' }, s.id)
    b.save({ ...input, notes: 'Other offline note' }, s.id)
    expect((await ea.synchronize()).error).toBeNull()
    expect((await eb.synchronize()).error).toBeNull()
    expect((await ea.synchronize()).error).toBeNull()
    expect(a.list()[0]).toMatchObject({ name: 'Renamed offline', notes: 'Other offline note' })
    expect(b.list()[0]).toMatchObject({ name: 'Renamed offline', notes: 'Other offline note' })
    const bytes = files.get('/ledger/xuding-sync-v1.json')!.bytes.toString()
    for (const secret of [
      input.name,
      'Renamed offline',
      'Other offline note',
      'webdav-password',
      passphrase
    ])
      expect(bytes).not.toContain(secret)
    expect(ea.status().devices).toHaveLength(2)
  })
  it('keeps both versions of monetary conflicts, resolves and converges', async () => {
    const a = repo(),
      s = a.save(input),
      ea = engine(a)
    await connect(ea, 'A')
    const b = repo(),
      eb = engine(b)
    await connect(eb, 'B', 'replace')
    a.save({ ...input, amountMinor: 3000 }, s.id)
    b.save({ ...input, amountMinor: 4000 }, s.id)
    await ea.synchronize()
    const conflict = await eb.synchronize()
    expect(conflict.error).toBeNull()
    expect(conflict.conflicts.length).toBeGreaterThan(0)
    const c = conflict.conflicts.find((c) => c.key === 'subscriptions:' + s.id)!
    expect(c.local).toMatchObject({ amountMinor: 4000 })
    expect(c.remote).toMatchObject({ amountMinor: 3000 })
    for (const c of eb.status().conflicts) await eb.resolve(c.id, 'remote')
    await eb.synchronize()
    await ea.synchronize()
    expect(a.list()[0].amountMinor).toBe(3000)
    expect(b.list()[0].amountMinor).toBe(3000)
  })
  it('detects stale remote versions, wrong keys and key rotation', async () => {
    const a = repo(),
      s = a.save(input),
      ea = engine(a)
    await connect(ea, 'A')
    const b = repo(),
      eb = engine(b)
    await connect(eb, 'B', 'replace')
    const saved = { ...files.get('/ledger/xuding-sync-v1.json')! }
    a.save({ ...input, notes: 'newer' }, s.id)
    await ea.synchronize()
    const latest = files.get('/ledger/xuding-sync-v1.json')!
    files.set('/ledger/xuding-sync-v1.json', saved)
    expect((await ea.synchronize()).error).toContain('回退')
    await expect(ea.rotate('new synchronized secret 2026')).rejects.toThrow('先完成同步')
    files.set('/ledger/xuding-sync-v1.json', latest)
    const c = engine(repo())
    await expect(c.prepare(connection('C'), 'wrong password 2026')).rejects.toThrow()
    await ea.rotate('new synchronized secret 2026')
    expect((await eb.synchronize()).error).toBeTruthy()
    const p = await c.prepare(connection('C'), 'new synchronized secret 2026')
    expect(p.preview!.remoteSubscriptions).toBe(1)
  })
  it('retries concurrent writes and preserves deletion markers for offline devices', async () => {
    const a = repo(),
      ea = engine(a)
    await connect(ea, 'A')
    const b = repo(),
      eb = engine(b)
    await connect(eb, 'B', 'replace')
    a.save(input)
    b.save({ ...input, name: 'B independent' })
    const results = await Promise.all([ea.synchronize(), eb.synchronize()])
    expect(results.every((r) => !r.error)).toBe(true)
    await ea.synchronize()
    await eb.synchronize()
    expect(a.list()).toHaveLength(2)
    expect(b.list()).toHaveLength(2)
    const empty = repo().export()
    a.import(empty, true)
    await ea.synchronize()
    await eb.synchronize()
    expect(b.list()).toHaveLength(0)
  })
  it('persists pending work transactionally, pauses and keeps local data on disconnect', async () => {
    const a = repo(),
      ea = engine(a)
    await connect(ea, 'A')
    await ea.pause(true)
    a.save(input)
    expect(a.pendingSync()).toBeGreaterThan(0)
    expect((await ea.synchronize()).phase).toBe('paused')
    await ea.pause(false)
    expect((await ea.synchronize()).error).toBeNull()
    const restarted = engine(a)
    expect(restarted.status().connected).toBe(true)
    await restarted.disconnect()
    expect(a.list()).toHaveLength(1)
  })
  it('does not merge simultaneous changes within the billing group', () => {
    const b = {
      name: 'a',
      amountMinor: 2000,
      currency: 'CNY',
      cycle: 'month',
      interval: 1,
      anchorDate: '2026-10-20',
      autoRenew: true,
      status: 'active'
    }
    const merged = mergeRecords(
      { 'subscriptions:x': b },
      { 'subscriptions:x': { ...b, cycle: 'year' } },
      { 'subscriptions:x': { ...b, amountMinor: 3000 } }
    )
    expect(merged.conflicts).toHaveLength(1)
  })
  it('retains new password wrapping when an already-connected device uploads again', async () => {
    const a = repo(),
      s = a.save(input),
      ea = engine(a)
    await connect(ea, 'A')
    const b = repo(),
      eb = engine(b)
    await connect(eb, 'B', 'replace')
    const next = 'updated synchronization password 2026'
    const recovery = await ea.recovery(next)
    expect(recovery.recoveryKey).toHaveLength(64)
    b.save({ ...input, notes: 'after password change' }, s.id)
    expect((await eb.synchronize()).error).toBeNull()
    const third = engine(repo())
    await expect(third.prepare(connection('C'), passphrase)).rejects.toThrow()
    const p = await third.prepare(connection('C'), next)
    expect(p.preview!.remoteSubscriptions).toBe(1)
    const fourth = engine(repo())
    expect((await fourth.prepare(connection('D'), recovery.recoveryKey!)).preview!.remote).toBe(
      true
    )
  })
  it('authenticates password headers and refuses a modified remote snapshot without touching local data', async () => {
    const a = repo(),
      s = a.save(input),
      ea = engine(a)
    await connect(ea, 'A')
    const file = files.get('/ledger/xuding-sync-v1.json')!,
      envelope = JSON.parse(file.bytes.toString())
    envelope.key.salt = Buffer.alloc(32, 3).toString('base64')
    file.bytes = Buffer.from(JSON.stringify(envelope))
    expect((await ea.synchronize()).error).toBeTruthy()
    expect(a.list()[0].id).toBe(s.id)
  })
  it('keeps notification deduplication local during synchronization and fails closed when protection backups fail', async () => {
    const a = repo(),
      ea = engine(a)
    a.finance.markReminder('local-only')
    await connect(ea, 'A')
    expect(a.finance.hasReminder('local-only')).toBe(true)
    const b = repo(),
      eb = engine(b)
    await connect(eb, 'B', 'replace')
    expect(b.finance.hasReminder('local-only')).toBe(false)
    a.save(input)
    await ea.synchronize()
    const broken = new SyncEngine(
      b,
      store,
      async () => {
        throw new Error('backup protection failed')
      },
      fetch,
      true
    )
    expect((await broken.synchronize()).error).toContain('backup protection failed')
    expect(b.list()).toHaveLength(0)
  })
})
