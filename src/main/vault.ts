import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync, openSync, readSync, closeSync } from 'node:fs'
import { copyFile, lstat, readFile, readdir, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import CipherDatabase from 'better-sqlite3-multiple-ciphers'
import { atomicWrite } from './files'
import { openDatabase } from './sqlite'
import { wrappedSchema, sealedSchema, seal, unseal, wrap, unwrap } from './secret-crypto'
import { securityOptionsSchema } from '../shared/vault-model'
import type { SecurityOptions, SecurityStatus } from '../shared/vault-model'
import type { BackupVault } from './credentials'
import { decodeBackup, encodeBackup, parseBackupFile } from './backup-crypto'

const configSchema = z
  .object({
    v: z.literal(1),
    state: z.enum(['migrating', 'ready']),
    password: wrappedSchema,
    recovery: wrappedSchema,
    options: securityOptionsSchema,
    credential: z.string().uuid().optional(),
    previous: z.array(sealedSchema).max(8).default([])
  })
  .strict()
type Config = z.infer<typeof configSchema>
export class LocalVault {
  private config: Config | null = null
  private dataKey: Buffer | undefined
  private retainedKeys: Buffer[] = []
  private prepared: { config: Config; key: Buffer; recoveryKey: string } | null = null
  private failed = 0
  private retryAfter = 0
  constructor(
    private directory: string,
    private credentials?: BackupVault
  ) {}
  get key(): Buffer | undefined {
    return this.dataKey
  }
  get keys(): Buffer[] {
    return this.dataKey ? [this.dataKey, ...this.retainedKeys] : []
  }
  get locked(): boolean {
    return !!this.config && !this.dataKey
  }
  private get path() {
    return join(this.directory, 'vault-state.json')
  }
  private get database() {
    return join(this.directory, 'xuding.db')
  }
  async initialize(): Promise<void> {
    if (!existsSync(this.path)) return
    this.config = configSchema.parse(JSON.parse(await readFile(this.path, 'utf8')))
    if (this.config.options.remember && this.config.credential && this.credentials) {
      try {
        const password = await this.credentials.read(this.config.credential)
        await this.unlock(password)
      } catch {
        /* ask user; no plaintext fallback */
      }
    }
  }
  status(): SecurityStatus {
    return {
      enabled: !!this.config,
      locked: this.locked,
      options: this.config?.options ?? securityOptionsSchema.parse({})
    }
  }
  private async persist(config: Config): Promise<void> {
    await atomicWrite(this.path, Buffer.from(JSON.stringify(config)))
    this.config = config
  }
  async prepare(password: string, options: SecurityOptions): Promise<SecurityStatus> {
    if (this.config) throw new Error('本地加密已经启用。')
    this.prepared?.key.fill(0)
    const key = randomBytes(32),
      recoveryKey = randomBytes(32).toString('hex').toUpperCase()
    const config: Config = {
      v: 1,
      state: 'migrating',
      password: await wrap(key, password, 'local-key'),
      recovery: await wrap(key, recoveryKey, 'recovery-key'),
      options,
      previous: []
    }
    if (options.remember) {
      if (!this.credentials) throw new Error('系统凭据不可用。')
      config.credential = await this.credentials.create(password)
    }
    this.prepared = { config, key, recoveryKey }
    return { ...this.status(), prepared: true, recoveryKey }
  }
  async enable(confirmation: string): Promise<void> {
    this.checkPrepared(confirmation)
    const p = this.prepared
    if (!p || confirmation.trim().toUpperCase() !== p.recoveryKey.slice(-8))
      throw new Error('请输入恢复密钥的最后 8 位以确认保存。')
    const next = this.database + '.encrypted-next',
      original = this.database + '.encryption-original'
    if (existsSync(next) || existsSync(original))
      throw new Error('检测到未完成的加密迁移，请先重启恢复。')
    await this.persist(p.config)
    try {
      await copyFile(this.database, next)
      const db = new CipherDatabase(next)
      try {
        db.pragma("cipher='sqlcipher'")
        db.pragma('legacy=4')
        db.pragma('journal_mode=DELETE')
        db.rekey(p.key)
      } finally {
        db.close()
      }
      this.verify(next, p.key)
      await rename(this.database, original)
      await rename(next, this.database)
      this.dataKey = p.key
      this.prepared = null
      await this.persist({ ...p.config, state: 'ready' })
      if (existsSync(this.database + '.encryption-original')) await this.finishMigration()
    } catch (e) {
      // Keep the durable intent/key envelopes. Startup can finish or roll back with the password.
      throw e
    }
  }
  private verify(path: string, key: Buffer): void {
    const db = openDatabase(path, key, true)
    try {
      if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok')
        throw new Error('加密数据库验证失败。')
      db.prepare('SELECT * FROM subscriptions LIMIT 1').get()
    } finally {
      db.close()
    }
  }
  checkPrepared(confirmation: string): void {
    if (!this.prepared || confirmation.trim().toUpperCase() !== this.prepared.recoveryKey.slice(-8))
      throw new Error('请输入恢复密钥的最后 8 位以确认保存。')
  }
  async unlock(password: string, recovery = false): Promise<void> {
    if (!this.config) return
    if (Date.now() < this.retryAfter) throw new Error('尝试次数较多，请稍后重试。')
    let key: Buffer | undefined
    try {
      key = await unwrap(
        recovery ? this.config.recovery : this.config.password,
        recovery ? password.replaceAll(/\s/g, '').toUpperCase() : password,
        recovery ? 'recovery-key' : 'local-key'
      )
      if (key.length !== 32) throw new Error('密钥无效。')
      if (this.config.state === 'migrating') {
        await this.resumeMigration(key)
        await this.persist({ ...this.config, state: 'ready' })
      }
      this.verify(this.database, key)
      this.dataKey?.fill(0)
      this.dataKey = key
      key = undefined
      this.failed = 0
      for (const old of this.retainedKeys) old.fill(0)
      this.retainedKeys = this.config.previous.map((p) => unseal(p, this.dataKey!, 'previous-key'))
      if (existsSync(this.database + '.encryption-original')) await this.finishMigration()
      else if (existsSync(this.database + '.encrypted-next')) {
        const file = this.database + '.encrypted-next',
          info = await lstat(file)
        if (info.isFile() && !info.isSymbolicLink()) await unlink(file)
      }
    } catch (e) {
      key?.fill(0)
      this.failed++
      this.retryAfter = Date.now() + (this.failed >= 5 ? 3000 : 0)
      throw e
    }
  }
  private async resumeMigration(key: Buffer): Promise<void> {
    const next = this.database + '.encrypted-next',
      original = this.database + '.encryption-original'
    for (const path of [this.database, next, original])
      if (existsSync(path)) {
        const info = await lstat(path)
        if (!info.isFile() || info.isSymbolicLink()) throw new Error('迁移关联文件必须是普通文件。')
      }
    try {
      this.verify(this.database, key)
      return
    } catch {}
    let nextValid = false
    if (existsSync(next))
      try {
        this.verify(next, key)
        nextValid = true
      } catch {}
    if (!nextValid) {
      const previous = this.config!.previous.map((v) => unseal(v, key, 'previous-key'))
      let source: string | undefined, sourceKey: Buffer | undefined
      try {
        for (const path of [this.database, original].filter(existsSync)) {
          for (const candidate of [undefined, ...previous])
            try {
              const db = openDatabase(path, candidate, true)
              try {
                if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok')
                  throw new Error('check')
                db.prepare('SELECT * FROM subscriptions LIMIT 1').get()
              } finally {
                db.close()
              }
              source = path
              sourceKey = candidate
              break
            } catch {}
          if (source) break
        }
        if (!source) throw new Error('迁移源文件无法验证，请保留现有文件并从备份恢复。')
        if (existsSync(next)) await unlink(next)
        await copyFile(source, next)
        const db = new CipherDatabase(next)
        try {
          db.pragma("cipher='sqlcipher'")
          db.pragma('legacy=4')
          if (sourceKey) db.key(sourceKey)
          db.pragma('journal_mode=DELETE')
          db.rekey(key)
        } finally {
          db.close()
        }
        this.verify(next, key)
      } finally {
        for (const k of previous) k.fill(0)
      }
    }
    if (existsSync(this.database))
      await rename(
        this.database,
        existsSync(original)
          ? this.database + '.fault-' + Date.now() + '-' + randomUUID()
          : original
      )
    await rename(next, this.database)
  }
  private async finishMigration(): Promise<void> {
    if (!this.config || !this.dataKey) return
    this.verify(this.database, this.dataKey)
    for (const name of [
      'xuding.db.encryption-original',
      'xuding.db.encrypted-next',
      'xuding.db-wal',
      'xuding.db-shm'
    ]) {
      // Main database is closed here; removing only verified migration leftovers.
      const path = join(this.directory, name)
      if (existsSync(path)) {
        const info = await lstat(path)
        if (!info.isFile() || info.isSymbolicLink()) throw new Error('迁移关联文件无效。')
        await unlink(path)
      }
    }
  }
  lock(): void {
    this.dataKey?.fill(0)
    this.dataKey = undefined
    for (const k of this.retainedKeys) k.fill(0)
    this.retainedKeys = []
  }
  async changePassword(
    current: string,
    password: string,
    options?: SecurityOptions
  ): Promise<void> {
    if (!this.config || !this.dataKey) throw new Error('请先解锁账本。')
    let key: Buffer
    try {
      key = await unwrap(this.config.password, current, 'local-key')
    } catch {
      key = await unwrap(
        this.config.recovery,
        current.replaceAll(/\s/g, '').toUpperCase(),
        'recovery-key'
      )
    }
    try {
      if (!key.equals(this.dataKey)) throw new Error('密码错误。')
    } finally {
      key.fill(0)
    }
    const next = {
      ...this.config,
      password: await wrap(this.dataKey, password, 'local-key'),
      options: options ?? this.config.options,
      credential: undefined as string | undefined
    }
    if (next.options.remember) {
      if (!this.credentials) throw new Error('系统凭据不可用。')
      next.credential = await this.credentials.create(password)
    }
    const previous = this.config.credential
    await this.persist(next)
    if (previous) await this.credentials?.remove(previous)
  }
  async options(options: SecurityOptions): Promise<void> {
    if (!this.config) throw new Error('请先开启本地加密。')
    if (options.remember && !this.config.credential)
      throw new Error('请通过修改密码启用记住解锁信息。')
    const old = this.config.credential
    await this.persist({ ...this.config, options, credential: options.remember ? old : undefined })
    if (old && !options.remember) await this.credentials?.remove(old)
  }
  async rotateRecovery(password: string): Promise<string> {
    if (!this.config || !this.dataKey) throw new Error('请先解锁。')
    const key = await unwrap(this.config.password, password, 'local-key')
    key.fill(0)
    const recoveryKey = randomBytes(32).toString('hex').toUpperCase()
    await this.persist({
      ...this.config,
      recovery: await wrap(this.dataKey, recoveryKey, 'recovery-key')
    })
    return recoveryKey
  }
  async rekey(password: string): Promise<string> {
    if (!this.config || !this.dataKey) throw new Error('请先解锁。')
    const check = await unwrap(this.config.password, password, 'local-key')
    check.fill(0)
    const key = randomBytes(32),
      recoveryKey = randomBytes(32).toString('hex').toUpperCase()
    // Keep the old encrypted file as a recovery point; journal envelopes permit rollback on failure.
    const next = this.database + '.encrypted-next',
      original = this.database + '.encryption-original'
    if (existsSync(next) || existsSync(original)) throw new Error('存在未完成的密钥迁移。')
    await copyFile(this.database, next)
    const db = new CipherDatabase(next)
    try {
      db.pragma("cipher='sqlcipher'")
      db.pragma('legacy=4')
      db.key(this.dataKey)
      db.pragma('journal_mode=DELETE')
      db.rekey(key)
    } finally {
      db.close()
    }
    this.verify(next, key)
    const old = this.config
    const previousKeys = [Buffer.from(this.dataKey), ...this.retainedKeys].slice(0, 8)
    await this.persist({
      ...old,
      state: 'migrating',
      password: await wrap(key, password, 'local-key'),
      recovery: await wrap(key, recoveryKey, 'recovery-key'),
      previous: previousKeys.map((k) => seal(k, key, 'previous-key'))
    })
    await rename(this.database, original)
    await rename(next, this.database)
    this.dataKey.fill(0)
    this.dataKey = key
    this.retainedKeys = previousKeys
    await this.persist({ ...this.config!, state: 'ready' })
    await this.finishMigration()
    return recoveryKey
  }
  async legacy(
    directory: string,
    operation: 'list' | 'convert' | 'delete',
    password?: string
  ): Promise<{ id: string; size: number }[]> {
    if (!this.config || !this.dataKey) throw new Error('请先开启加密并解锁。')
    const names = (await readdir(directory)).filter((n) =>
      /^(daily-\d{4}-\d{2}-\d{2}|(manual|before-restore|before-import|before-sync)-[a-zA-Z0-9-]+)\.json$/.test(
        n
      )
    )
    const result: { id: string; size: number }[] = []
    for (const name of names) {
      const path = join(directory, name),
        info = await lstat(path)
      if (!info.isFile() || info.isSymbolicLink() || info.size > 72 * 1024 * 1024) continue
      if (operation === 'delete') await unlink(path)
      else if (operation === 'convert') {
        if (!password) throw new Error('请先配置备份加密密码。')
        const backup = await decodeBackup(parseBackupFile(await readFile(path))),
          destination = path.replace(/\.json$/, '.xudingbackup')
        if (existsSync(destination)) throw new Error('同名加密备份已存在，请先检查备份历史。')
        const bytes = await encodeBackup(backup, password)
        await atomicWrite(destination, bytes)
        await decodeBackup(parseBackupFile(await readFile(destination)), password)
        await unlink(path)
      } else result.push({ id: name, size: info.size })
    }
    const dbNames = (await readdir(this.directory)).filter((n) =>
      /^(upgrade-\d+\.\d+\.\d+-\d+-[a-f0-9-]{36}\.db|xuding\.db\.pre-v[345]-\d+\.db|xuding\.db(?:-wal|-shm)?\.fault-\d+-[a-f0-9-]{36})$/.test(
        n
      )
    )
    for (const name of dbNames) {
      const path = join(this.directory, name),
        info = await lstat(path)
      if (!info.isFile() || info.isSymbolicLink()) continue
      const fd = openSync(path, 'r'),
        header = Buffer.alloc(16)
      try {
        readSync(fd, header, 0, 16, 0)
      } finally {
        closeSync(fd)
      }
      const plain = header.toString('utf8') === 'SQLite format 3\0'
      if (!plain && !name.includes('.fault-')) continue
      if (operation === 'list') result.push({ id: '恢复文件/' + name, size: info.size })
      else if (operation === 'delete') await unlink(path)
      else {
        // A fault sidecar is not a standalone database: retain it until the user explicitly deletes it.
        if (!plain) {
          result.push({ id: '需手动删除/' + name, size: info.size })
          continue
        }
        const temporary = path + '.encrypt-' + randomUUID()
        try {
          await copyFile(path, temporary)
          const db = new CipherDatabase(temporary)
          try {
            db.pragma("cipher='sqlcipher'")
            db.pragma('legacy=4')
            db.pragma('journal_mode=DELETE')
            db.rekey(this.dataKey)
          } finally {
            db.close()
          }
          const check = openDatabase(temporary, this.dataKey, true)
          try {
            if (check.prepare('PRAGMA quick_check').get().quick_check !== 'ok')
              throw new Error('旧恢复文件校验失败。')
          } finally {
            check.close()
          }
          await rename(temporary, path)
        } finally {
          await unlink(temporary).catch(() => {})
        }
      }
    }
    return result
  }
}
