import { randomBytes, randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { SubscriptionRepository } from './database'
import type { CredentialVault } from './credentials'
import type {
  SyncConnection,
  SyncConflict,
  SyncDocument,
  SyncRecords,
  SyncStatus
} from '../shared/sync-model'
import { syncConnectionSchema, syncDocumentSchema } from '../shared/sync-model'
import {
  backupFromRecords,
  localRecords,
  mergeRecords,
  recordsFromBackup,
  stable
} from '../shared/sync'
import { ConcurrentWrite, WebDavTransport } from './webdav'
import { localDate } from '../shared/billing'
import { sealedSchema, seal, unseal, wrappedSchema, wrap, unwrap } from './secret-crypto'
import type { Wrapped } from './secret-crypto'

const envelopeSchema = z
  .object({
    format: z.literal('xuding-sync-encrypted'),
    version: z.literal(1),
    ledgerId: z.string().uuid(),
    key: wrappedSchema,
    recovery: wrappedSchema,
    body: sealedSchema
  })
  .strict()
type Envelope = z.infer<typeof envelopeSchema>
type Stored = {
  credential: string
  ledgerId: string
  base: SyncRecords
  revision: string | null
  paused: boolean
  conflicts: SyncConflict[]
  lastSuccess: string | null
  devices: SyncDocument['devices']
}
type Secret = { connection: SyncConnection; key: string; wrap: Wrapped; recovery: Wrapped }
export class SyncEngine {
  private state: Stored | null
  private phase: SyncStatus['phase'] = 'off'
  private error: string | null = null
  private running: Promise<SyncStatus> | null = null
  private preview: {
    token: string
    expires: number
    revision: number
    connection: SyncConnection
    key: Buffer
    keyWrap: Wrapped
    recovery: Wrapped
    remote: SyncDocument | null
    recoveryKey?: string
  } | null = null
  readonly deviceId: string
  constructor(
    private repo: SubscriptionRepository,
    private secrets: Pick<CredentialVault, 'createSecret' | 'readSecret' | 'remove'>,
    private beforeReplace: () => Promise<unknown>,
    private fetcher: typeof fetch = fetch,
    private allowLoopback = false
  ) {
    this.state = repo.syncMetadata('state') as Stored | null
    this.deviceId = (repo.syncMetadata('device-id') as string) || randomUUID()
    repo.saveSyncMetadata('device-id', this.deviceId)
    this.phase = this.state
      ? this.state.paused
        ? 'paused'
        : this.state.conflicts.length
          ? 'conflict'
          : 'idle'
      : 'off'
  }
  status(): SyncStatus {
    return {
      connected: !!this.state,
      phase: this.phase,
      error: this.error,
      lastSuccess: this.state?.lastSuccess ?? null,
      pending: this.repo.pendingSync(),
      conflicts: this.state?.conflicts ?? [],
      devices: this.state?.devices ?? [],
      revision: this.state?.revision ?? undefined
    }
  }
  private save(): void {
    this.repo.saveSyncMetadata('state', this.state)
  }
  private transport(connection: SyncConnection) {
    return new WebDavTransport(connection, this.fetcher, this.allowLoopback)
  }
  async test(connection: SyncConnection): Promise<SyncStatus> {
    await this.transport(syncConnectionSchema.parse(connection)).test()
    return this.status()
  }
  private decrypt(
    bytes: Buffer,
    key: Buffer,
    ledgerId?: string
  ): { document: SyncDocument; envelope: Envelope } {
    const envelope = envelopeSchema.parse(JSON.parse(bytes.toString('utf8')))
    if (ledgerId && envelope.ledgerId !== ledgerId)
      throw new Error('远端账本身份已改变，请通过连接向导重新确认。')
    const plain = unseal(
      envelope.body,
      key,
      'sync:' + envelope.ledgerId + ':' + stable(envelope.key) + ':' + stable(envelope.recovery)
    )
    try {
      const document = syncDocumentSchema.parse(JSON.parse(plain.toString('utf8')))
      if (document.ledgerId !== envelope.ledgerId) throw new Error('同步账本身份无效。')
      backupFromRecords(document.records)
      return { document, envelope }
    } finally {
      plain.fill(0)
    }
  }
  private encode(
    document: SyncDocument,
    secret: Pick<Secret, 'wrap' | 'recovery'>,
    key: Buffer
  ): Buffer {
    const plain = Buffer.from(JSON.stringify(syncDocumentSchema.parse(document)))
    if (plain.length > 50 * 1024 * 1024) throw new Error('账本超过同步大小限制。')
    try {
      return Buffer.from(
        JSON.stringify({
          format: 'xuding-sync-encrypted',
          version: 1,
          ledgerId: document.ledgerId,
          key: secret.wrap,
          recovery: secret.recovery,
          body: seal(
            plain,
            key,
            'sync:' + document.ledgerId + ':' + stable(secret.wrap) + ':' + stable(secret.recovery)
          )
        })
      )
    } finally {
      plain.fill(0)
    }
  }
  async prepare(connection: SyncConnection, passphrase: string): Promise<SyncStatus> {
    if (this.state) throw new Error('请先断开当前连接，再加入其他同步空间。')
    await this.transport(connection).test()
    const remote = await this.transport(connection).read()
    let key: Buffer,
      keyWrap: Wrapped,
      recovery: Wrapped,
      document: SyncDocument | null = null,
      recoveryKey: string | undefined
    if (remote) {
      const e = envelopeSchema.parse(JSON.parse(remote.bytes.toString('utf8')))
      try {
        key = await unwrap(e.key, passphrase, 'sync-key:' + e.ledgerId)
      } catch {
        key = await unwrap(
          e.recovery,
          passphrase.replaceAll(/\s/g, '').toUpperCase(),
          'sync-recovery:' + e.ledgerId
        )
      }
      try {
        document = this.decrypt(remote.bytes, key).document
      } catch (error) {
        key.fill(0)
        throw error
      }
      keyWrap = e.key
      recovery = e.recovery
    } else {
      key = randomBytes(32)
      const ledgerId = randomUUID()
      recoveryKey = randomBytes(32).toString('hex').toUpperCase()
      keyWrap = await wrap(key, passphrase, 'sync-key:' + ledgerId)
      recovery = await wrap(key, recoveryKey, 'sync-recovery:' + ledgerId)
      document = {
        format: 'xuding-sync',
        version: 1,
        ledgerId,
        revision: randomUUID(),
        ancestors: [],
        records: {},
        devices: []
      }
    }
    this.preview?.key.fill(0)
    this.preview = {
      token: randomUUID(),
      expires: Date.now() + 600000,
      revision: this.repo.revision(),
      connection,
      key,
      keyWrap,
      recovery,
      remote: document,
      recoveryKey
    }
    const token = this.preview.token
    setTimeout(() => {
      if (this.preview?.token === token) this.clearPreview()
    }, 600000).unref()
    const local = recordsFromBackup(this.repo.export()),
      merged = mergeRecords({}, local, document.records)
    return {
      ...this.status(),
      preview: {
        token: this.preview.token,
        remote: !!remote,
        localSubscriptions: this.repo.list().length,
        remoteSubscriptions: Object.keys(document.records).filter(
          (k) => k.startsWith('subscriptions:') && document!.records[k]
        ).length,
        conflicts: merged.conflicts.length,
        expiresAt: new Date(this.preview.expires).toISOString()
      },
      recoveryKey
    }
  }
  async connect(token: string, mode: 'merge' | 'replace'): Promise<SyncStatus> {
    const p = this.preview
    if (!p || p.token !== token || p.expires < Date.now())
      throw new Error('连接预览已过期，请重新测试。')
    if (this.repo.revision() !== p.revision) throw new Error('本地账本已变化，请重新预览。')
    const remote = p.remote!,
      key = p.key,
      secret: Secret = {
        connection: p.connection,
        key: key.toString('base64'),
        wrap: p.keyWrap,
        recovery: p.recovery
      }
    const credential = await this.secrets.createSecret(JSON.stringify(secret))
    try {
      await this.beforeReplace()
      if (this.repo.revision() !== p.revision) throw new Error('本地账本已变化，请重新预览。')
      const base = mode === 'replace' ? remote.records : {}
      if (mode === 'replace') this.apply(remote.records)
      this.state = {
        credential,
        ledgerId: remote.ledgerId,
        base,
        revision: null,
        paused: false,
        conflicts: [],
        lastSuccess: null,
        devices: remote.devices
      }
      this.save()
      this.preview = null
      key.fill(0)
      const result = await this.synchronize()
      return { ...result, recoveryKey: p.recoveryKey }
    } catch (e) {
      if (!this.state) await this.secrets.remove(credential)
      throw e
    }
  }
  synchronize(): Promise<SyncStatus> {
    if (this.running) return this.running
    this.running = this.run().finally(() => {
      this.running = null
    })
    return this.running
  }
  private async run(): Promise<SyncStatus> {
    const state = this.state
    if (!state) return this.status()
    if (state.paused) {
      this.phase = 'paused'
      return this.status()
    }
    this.phase = 'syncing'
    this.error = null
    let key: Buffer | undefined
    try {
      const secret = JSON.parse(await this.secrets.readSecret(state.credential)) as Secret
      syncConnectionSchema.parse(secret.connection)
      key = Buffer.from(secret.key, 'base64')
      if (key.length !== 32) throw new Error('同步密钥无效。')
      const transport = this.transport(secret.connection)
      for (let attempt = 0; attempt < 4; attempt++) {
        const remoteFile = await transport.read()
        if (!remoteFile && state.revision) throw new Error('远端账本已移除，请重新连接后确认。')
        const decoded = remoteFile ? this.decrypt(remoteFile.bytes, key, state.ledgerId) : null
        const remote = decoded?.document ?? null
        if (decoded) {
          secret.wrap = decoded.envelope.key
          secret.recovery = decoded.envelope.recovery
        }
        if (
          remote &&
          state.revision &&
          remote.revision !== state.revision &&
          !remote.ancestors.includes(state.revision)
        )
          throw new Error('远端账本可能回退，已暂停应用该版本。请保留本地账本并检查存储历史。')
        const revision = this.repo.revision(),
          local = localRecords(this.repo.export(), state.base)
        const merged = mergeRecords(state.base, local, remote?.records ?? {})
        const conflicts: SyncConflict[] = [
          ...state.conflicts.map((c) => ({
            ...c,
            local: local[c.key] ?? null,
            remote: remote?.records[c.key] ?? c.remote
          }))
        ]
        for (const c of merged.conflicts)
          if (!conflicts.some((v) => v.key === c.key))
            conflicts.push({
              ...c,
              id: randomUUID(),
              label: this.label(c.key, local, remote?.records ?? {})
            })
        for (const c of conflicts.filter((c) => c.key.startsWith('subscriptions:'))) {
          const id = c.key.slice(14),
            keys = new Set(
              [...Object.keys(local), ...Object.keys(remote?.records ?? {})].filter(
                (k) => local[k]?.subscriptionId === id || remote?.records[k]?.subscriptionId === id
              )
            )
          c.localRelated = Object.fromEntries([...keys].map((k) => [k, local[k] ?? null]))
          c.remoteRelated = Object.fromEntries(
            [...keys].map((k) => [k, remote?.records[k] ?? null])
          )
        }
        const parents = new Set(
          conflicts.filter((c) => c.key.startsWith('subscriptions:')).map((c) => c.key.slice(14))
        )
        for (let i = conflicts.length - 1; i >= 0; i--) {
          const c = conflicts[i],
            item = (c.local ?? c.remote) as Record<string, unknown> | null
          if (
            !c.key.startsWith('subscriptions:') &&
            item?.subscriptionId &&
            parents.has(String(item.subscriptionId))
          )
            conflicts.splice(i, 1)
        }
        if (
          remote &&
          !conflicts.length &&
          stable(local) === stable(remote.records) &&
          remote.devices.some((d) => d.id === this.deviceId)
        ) {
          state.base = remote.records
          state.revision = remote.revision
          state.devices = remote.devices
          state.lastSuccess = new Date().toISOString()
          this.save()
          this.repo.acknowledgeSync()
          this.phase = 'idle'
          return this.status()
        }
        const published = { ...merged.records }
        for (const c of conflicts) published[c.key] = remote?.records[c.key] ?? null
        // Relational conflicts are held together; preserve remote children when parent is unresolved/deleted.
        for (const c of conflicts.filter((c) => c.key.startsWith('subscriptions:'))) {
          const id = c.key.slice(14)
          for (const [k, v] of Object.entries(published))
            if (v?.subscriptionId === id || remote?.records[k]?.subscriptionId === id)
              published[k] = remote?.records[k] ?? null
        }
        backupFromRecords(published)
        const ancestors = [
          ...new Set([...(remote?.ancestors ?? []), ...(remote ? [remote.revision] : [])])
        ]
        if (ancestors.length > 20000) throw new Error('同步历史达到限制，请重建同步空间。')
        const writeNeeded =
          !remote ||
          stable(published) !== stable(remote.records) ||
          !remote.devices.some((d) => d.id === this.deviceId)
        const document: SyncDocument =
          !writeNeeded && remote
            ? remote
            : {
                format: 'xuding-sync',
                version: 1,
                ledgerId: state.ledgerId,
                revision: randomUUID(),
                ancestors,
                records: published,
                devices: [
                  ...(remote?.devices ?? []).filter((d) => d.id !== this.deviceId),
                  {
                    id: this.deviceId,
                    name: secret.connection.deviceName,
                    seenAt: new Date().toISOString()
                  }
                ]
              }
        // Do not upload/apply if a local edit completed during a network operation.
        if (this.repo.revision() !== revision) continue
        if (writeNeeded || stable(merged.records) !== stable(local)) await this.beforeReplace()
        if (this.repo.revision() !== revision) continue
        try {
          if (writeNeeded)
            await transport.write(this.encode(document, secret, key), remoteFile?.etag ?? null)
        } catch (e) {
          if (e instanceof ConcurrentWrite) continue
          throw e
        }
        // If local writes happened while uploading, keep them on top of this acknowledged version.
        const fresh = localRecords(this.repo.export(), state.base)
        const visible = { ...published }
        for (const c of conflicts) visible[c.key] = fresh[c.key] ?? null
        for (const c of conflicts.filter((c) => c.key.startsWith('subscriptions:'))) {
          const id = c.key.slice(14)
          for (const [k, v] of Object.entries(fresh)) if (v?.subscriptionId === id) visible[k] = v
        }
        const after = mergeRecords(local, fresh, visible)
        if (after.conflicts.length)
          throw new Error('同步期间本地数据持续变化，请稍后重试。已保留本地修改。')
        this.repo.atomic(() => {
          if (stable(after.records) !== stable(fresh)) this.apply(after.records)
          state.base = published
          state.revision = document.revision
          state.conflicts = conflicts
          state.devices = document.devices
          state.lastSuccess = new Date().toISOString()
          this.save()
          this.repo.acknowledgeSync()
          if (stable(after.records) !== stable(published)) this.repo.markPendingSync()
        })
        this.phase = conflicts.length ? 'conflict' : 'idle'
        return this.status()
      }
      throw new Error('其他设备正在修改，请稍后再同步。')
    } catch (e) {
      this.phase = 'error'
      this.error =
        e instanceof z.ZodError
          ? '同步数据格式不兼容，请升级应用或检查远端文件。'
          : e instanceof Error
            ? e.message
            : '同步失败，请重试。'
      return this.status()
    } finally {
      key?.fill(0)
    }
  }
  private label(key: string, local: SyncRecords, remote: SyncRecords): string {
    const item = local[key] ?? remote[key],
      sub = item?.subscriptionId ?? (key.startsWith('subscriptions:') ? key.slice(14) : '')
    const name = local['subscriptions:' + sub]?.name ?? remote['subscriptions:' + sub]?.name
    const names: Record<string, string> = {
      subscriptions: '订阅信息',
      prices: '价格安排',
      bills: '账单',
      tracking: '账单跟踪',
      budgets: '预算',
      decisions: '续费决策',
      usage: '使用记录',
      importBatches: '导入记录',
      changes: '操作历史'
    }
    return (
      String(name ?? (key.startsWith('budgets:') ? '预算 ' + key.slice(8) : '账本记录')) +
      ' · ' +
      (names[key.split(':')[0]] ?? '变更')
    )
  }
  async pause(paused: boolean): Promise<SyncStatus> {
    if (this.running) throw new Error('请等待当前同步完成。')
    if (this.state) {
      this.state.paused = paused
      this.save()
      this.phase = paused ? 'paused' : 'idle'
    }
    return this.status()
  }
  async disconnect(): Promise<SyncStatus> {
    if (this.running) throw new Error('请等待当前同步完成。')
    const credential = this.state?.credential
    this.state = null
    this.save()
    this.phase = 'off'
    this.error = null
    if (credential) await this.secrets.remove(credential)
    return this.status()
  }
  async resolve(
    id: string,
    choice: 'local' | 'remote' | 'manual',
    value?: string
  ): Promise<SyncStatus> {
    if (this.running) throw new Error('请等待当前同步完成。')
    const c = this.state?.conflicts.find((c) => c.id === id)
    if (!c || !this.state) throw new Error('冲突已经变化，请刷新。')
    const records = recordsFromBackup(this.repo.export())
    if (c.key.startsWith('subscriptions:')) {
      const related = choice === 'remote' ? c.remoteRelated : undefined
      if (related) Object.assign(records, related)
    }
    records[c.key] = (
      choice === 'manual'
        ? JSON.parse(value ?? 'null')
        : choice === 'remote'
          ? c.remote
          : (records[c.key] ?? null)
    ) as Record<string, unknown> | null
    if (choice === 'manual' && c.key.startsWith('subscriptions:') && records[c.key]) {
      const item = records[c.key]!,
        today = localDate()
      const latestPrice = Object.entries(records)
        .filter(
          ([k, v]) =>
            k.startsWith('prices:') &&
            v?.subscriptionId === item.id &&
            String(v?.effectiveOn) <= today
        )
        .sort((a, b) => String(b[1]?.effectiveOn).localeCompare(String(a[1]?.effectiveOn)))[0]
      if (latestPrice && latestPrice[1])
        records[latestPrice[0]] = {
          ...latestPrice[1],
          amountMinor: item.amountMinor,
          currency: item.currency
        }
    }
    const revision = this.repo.revision()
    backupFromRecords(records)
    await this.beforeReplace()
    if (this.repo.revision() !== revision) throw new Error('账本已变化，请刷新冲突后重试。')
    this.apply(records)
    this.state.conflicts = this.state.conflicts.filter((v) => v.id !== id)
    this.save()
    this.phase = this.state.conflicts.length ? 'conflict' : 'idle'
    return this.status()
  }
  async recovery(passphrase: string): Promise<SyncStatus> {
    if (!this.state || this.running) throw new Error('请先连接并等待同步完成。')
    const state = this.state,
      secret = JSON.parse(await this.secrets.readSecret(state.credential)) as Secret,
      transport = this.transport(secret.connection),
      remote = await transport.read()
    if (!remote) throw new Error('同步账本不存在。')
    const key = Buffer.from(secret.key, 'base64'),
      recoveryKey = randomBytes(32).toString('hex').toUpperCase()
    try {
      const { document } = this.decrypt(remote.bytes, key, state.ledgerId)
      secret.wrap = await wrap(key, passphrase, 'sync-key:' + state.ledgerId)
      secret.recovery = await wrap(key, recoveryKey, 'sync-recovery:' + state.ledgerId)
      const credential = await this.secrets.createSecret(JSON.stringify(secret))
      try {
        await transport.write(this.encode(document, secret, key), remote.etag)
        state.credential = credential
        this.save()
      } catch (e) {
        await this.secrets.remove(credential)
        throw e
      }
      return { ...this.status(), recoveryKey }
    } finally {
      key.fill(0)
    }
  }
  async rotate(passphrase: string): Promise<SyncStatus> {
    if (!this.state || this.running) throw new Error('请先连接并等待同步完成。')
    const checked = await this.synchronize()
    if (checked.error || checked.conflicts.length || this.repo.pendingSync())
      throw new Error('请先完成同步并处理冲突，再重建同步空间。')
    const state = this.state,
      secret = JSON.parse(await this.secrets.readSecret(state.credential)) as Secret
    const old = Buffer.from(secret.key, 'base64'),
      key = randomBytes(32),
      ledgerId = randomUUID(),
      recoveryKey = randomBytes(32).toString('hex').toUpperCase(),
      transport = this.transport(secret.connection)
    try {
      const remote = await transport.read()
      if (!remote) throw new Error('同步账本不存在。')
      const document = this.decrypt(remote.bytes, old, state.ledgerId).document
      if (document.revision !== state.revision)
        throw new Error('其他设备已修改账本，请重新同步后重建。')
      document.ledgerId = ledgerId
      document.ancestors = []
      document.revision = randomUUID()
      secret.key = key.toString('base64')
      secret.wrap = await wrap(key, passphrase, 'sync-key:' + ledgerId)
      secret.recovery = await wrap(key, recoveryKey, 'sync-recovery:' + ledgerId)
      const credential = await this.secrets.createSecret(JSON.stringify(secret))
      try {
        await transport.write(this.encode(document, secret, key), remote.etag)
      } catch (e) {
        await this.secrets.remove(credential)
        throw e
      }
      state.credential = credential
      state.ledgerId = ledgerId
      state.revision = document.revision
      state.base = document.records
      this.save()
      return { ...this.status(), recoveryKey }
    } finally {
      key.fill(0)
      old.fill(0)
    }
  }
  clearPreview(): void {
    this.preview?.key.fill(0)
    this.preview = null
  }
  clearForLock(): void {
    this.clearPreview()
    this.state = null
    this.error = null
    this.phase = 'locked'
  }
  private apply(records: SyncRecords): void {
    const backup = backupFromRecords(records)
    backup.budgetReminders = this.repo.finance.reminders()
    this.repo.import(backup, true)
  }
  get busy(): boolean {
    return !!this.running
  }
}
