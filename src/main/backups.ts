import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, lstat, unlink } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { z } from 'zod'
import { backupSchema } from '../shared/model'
import type { Backup, BackupEntry, BackupStatus, RestorePreview } from '../shared/model'
import { addDays, localDate } from '../shared/billing'
import type { SubscriptionRepository } from './database'
import { atomicWrite } from './files'
import {
  decodeBackup,
  encodeBackup,
  isEncryptedBackup,
  MAX_BACKUP_FILE_BYTES,
  parseBackupFile
} from './backup-crypto'
import type { BackupVault } from './credentials'
import { backupProtectionSchema } from '../shared/operations-model'
import type {
  BackupProtection,
  BackupSelection,
  ExportBackupOptions,
  ProtectionStatus
} from '../shared/operations-model'

const stateSchema = z.object({
  directory: z.string(),
  lastSuccess: z.string().nullable(),
  lastError: z.string().nullable(),
  revision: z.number().int(),
  day: z.string()
})
const filename =
  /^(daily-\d{4}-\d{2}-\d{2}|(manual|before-restore|before-import|before-sync)-\d{4}-\d{2}-\d{2}-[a-f0-9-]{36})\.(json|xudingbackup)$/
export class BackupService {
  private state: z.infer<typeof stateSchema>
  private timer: ReturnType<typeof setTimeout> | undefined
  private queue: Promise<unknown> = Promise.resolve()
  private previews = new Map<string, { backup: Backup; revision: number; expires: number }>()
  private selections = new Map<string, { bytes: Buffer; source: string; expires: number }>()
  private protection: { credential: string } | null = null
  suspended = false
  requireEncryption = false
  constructor(
    private repo: SubscriptionRepository,
    defaultDirectory: string,
    private now = () => new Date(),
    private vault?: BackupVault,
    private log: (event: string, error?: unknown) => void = () => {}
  ) {
    const stored = stateSchema.safeParse(repo.metadata('backup-state'))
    this.state = stored.success
      ? stored.data
      : { directory: defaultDirectory, lastSuccess: null, lastError: null, revision: -1, day: '' }
    const protection = z
      .object({ credential: z.string().uuid() })
      .safeParse(repo.metadata('backup-protection'))
    this.protection = protection.success ? protection.data : null
  }
  status(): BackupStatus {
    return {
      directory: this.state.directory,
      lastSuccess: this.state.lastSuccess,
      lastError: this.state.lastError,
      pending: !!this.timer,
      encrypted: !!this.protection
    }
  }
  private persist() {
    this.repo.saveMetadata('backup-state', this.state)
  }
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work)
    this.queue = next.catch(() => {})
    return next
  }
  changed(): void {
    if (this.suspended) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    if (!this.repo.settings().autoBackupEnabled) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.automatic().catch(() => {})
    }, 1500)
    this.timer.unref()
  }
  async flush(): Promise<void> {
    if (this.suspended) {
      await this.queue
      return
    }
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    if (this.repo.settings().autoBackupEnabled) await this.automatic()
    await this.queue
  }
  automatic(): Promise<void> {
    return this.serialize(async () => {
      if (this.suspended) return
      if (!this.repo.settings().autoBackupEnabled || !this.repo.revision()) return
      if (this.state.revision === this.repo.revision() && this.state.day === localDate(this.now()))
        return
      await this.write('daily')
    })
  }
  nowBackup(): Promise<BackupStatus> {
    return this.serialize(async () => {
      await this.write('manual')
      return this.status()
    })
  }
  setDirectory(directory: string): Promise<BackupStatus> {
    return this.serialize(async () => {
      const target = resolve(directory, 'xuding-backups')
      await mkdir(target, { recursive: true })
      this.state = {
        ...this.state,
        directory: target,
        lastSuccess: null,
        lastError: null,
        revision: -1,
        day: ''
      }
      this.persist()
      this.changed()
      return this.status()
    })
  }
  private async write(
    kind: BackupEntry['kind'],
    credential = this.protection?.credential
  ): Promise<string> {
    if (this.suspended) throw new Error('账本已锁定。')
    if (this.requireEncryption && !credential)
      throw new Error('加密账本需要先配置加密备份，无法改为明文保存。')
    const revision = this.repo.revision()
    const now = this.now(),
      day = localDate(now)
    const extension = credential ? 'xudingbackup' : 'json'
    const id =
      kind === 'daily' ? `daily-${day}.${extension}` : `${kind}-${day}-${randomUUID()}.${extension}`
    const destination = join(this.state.directory, id)
    this.log('backup.started')
    try {
      await mkdir(this.state.directory, { recursive: true })
      const password = credential ? await this.vault?.read(credential) : undefined
      if (credential && !password) throw new Error('本机备份凭据不可用，请重新设置备份密码。')
      const data = await encodeBackup(
        backupSchema.parse({ ...this.repo.export(), exportedAt: now.toISOString() }),
        password
      )
      if (password) await decodeBackup(parseBackupFile(data), password)
      await atomicWrite(destination, data)
      this.state = {
        ...this.state,
        lastSuccess: now.toISOString(),
        lastError: null,
        ...(!kind.startsWith('before-') ? { revision, day } : {})
      }
      this.persist()
      await this.cleanup()
      this.log('backup.saved')
      return id
    } catch (error) {
      this.log('backup.failed', error)
      this.state.lastError =
        error instanceof Error ? error.message : '备份失败，请检查目录权限与剩余空间。'
      this.persist()
      throw new Error(this.state.lastError)
    }
  }
  private async safePath(id: string): Promise<string> {
    if (!filename.test(id) || basename(id) !== id) throw new Error('备份文件名无效。')
    const target = join(this.state.directory, id)
    const info = await lstat(target)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('备份必须是普通文件。')
    return target
  }
  private async cleanup(): Promise<void> {
    const ids = (await readdir(this.state.directory)).filter((id) => filename.test(id))
    const safety = await Promise.all(
      ids
        .filter((id) => id.startsWith('before-'))
        .map(async (id) => ({ id, time: (await lstat(await this.safePath(id))).mtimeMs }))
    )
    const keepSafety = new Set(
      safety
        .sort((a, b) => b.time - a.time || b.id.localeCompare(a.id))
        .slice(0, 10)
        .map((item) => item.id)
    )
    const cutoff = addDays(localDate(this.now()), 1 - this.repo.settings().backupRetentionDays)
    for (const id of ids) {
      const remove = id.startsWith('before-')
        ? !keepSafety.has(id)
        : id.startsWith('daily-') && id.slice(6, 16) < cutoff
      if (remove) {
        const target = await this.safePath(id)
        await unlink(target)
      }
    }
  }
  async history(): Promise<BackupEntry[]> {
    let ids: string[]
    try {
      ids = await readdir(this.state.directory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const entries: BackupEntry[] = []
    for (const id of ids.filter((id) => filename.test(id))) {
      let entry: BackupEntry | undefined
      try {
        const target = await this.safePath(id),
          info = await lstat(target)
        entry = {
          id,
          createdAt: info.mtime.toISOString(),
          count: null,
          size: info.size,
          kind: id.startsWith('daily-')
            ? 'daily'
            : id.startsWith('manual-')
              ? 'manual'
              : id.startsWith('before-import-')
                ? 'before-import'
                : id.startsWith('before-sync-')
                  ? 'before-sync'
                  : 'before-restore',
          encrypted: id.endsWith('.xudingbackup'),
          state: 'invalid'
        }
        if (info.size > MAX_BACKUP_FILE_BYTES) throw new Error('文件超过大小限制。')
        const value = parseBackupFile(await readFile(target))
        entry.encrypted = isEncryptedBackup(value)
        if (entry.encrypted) entry.state = 'locked'
        else {
          const backup = await decodeBackup(value)
          Object.assign(entry, {
            state: 'valid',
            createdAt: backup.exportedAt,
            count: backup.subscriptions.length,
            bills: backup.version !== 1 ? backup.bills.length : 0,
            budgets: backup.version === 3 || backup.version === 4 ? backup.budgets.length : 0
          })
        }
      } catch {
        if (entry) {
          entry.state = 'invalid'
          entry.error = '文件损坏、格式不受支持或无法读取。'
        }
      }
      if (entry) entries.push(entry)
    }
    return entries.sort(
      (a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)
    )
  }
  async selectFile(path: string, source = basename(path)): Promise<BackupSelection> {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('请选择普通备份文件。')
    if (info.size > MAX_BACKUP_FILE_BYTES) throw new Error('备份文件超过大小限制。')
    const bytes = await readFile(path),
      value = parseBackupFile(bytes),
      token = randomUUID()
    this.selections.clear()
    this.selections.set(token, { bytes, source, expires: Date.now() + 10 * 60_000 })
    return { token, source, encrypted: isEncryptedBackup(value) }
  }
  async unlock(token: string, password?: string): Promise<RestorePreview> {
    const selected = this.selections.get(token)
    if (!selected || selected.expires < Date.now())
      throw new Error('文件选择已过期，请重新选择备份。')
    const backup = await decodeBackup(parseBackupFile(selected.bytes), password)
    this.selections.delete(token)
    return this.prepare(backup, selected.source)
  }
  async prepareFile(
    path: string,
    source = basename(path),
    password?: string
  ): Promise<RestorePreview> {
    const selection = await this.selectFile(path, source)
    return this.unlock(selection.token, password)
  }
  private prepare(backup: Backup, source: string): RestorePreview {
    const current = new Set(this.repo.list().map((s) => s.id))
    const overwritten = backup.subscriptions.filter((s) => current.has(s.id)).length
    const token = randomUUID()
    this.previews.clear()
    this.previews.set(token, {
      backup,
      revision: this.repo.revision(),
      expires: Date.now() + 10 * 60_000
    })
    return {
      token,
      bills: backup.version >= 2 ? (backup as Exclude<Backup, { version: 1 }>).bills.length : 0,
      prices: backup.version >= 2 ? (backup as Exclude<Backup, { version: 1 }>).prices.length : 0,
      legacy: backup.version === 1,
      fullRestoreSupported: backup.version === 3 || backup.version === 4,
      budgets: backup.version === 3 || backup.version === 4 ? backup.budgets.length : 0,
      source,
      exportedAt: backup.exportedAt,
      count: backup.subscriptions.length,
      added: backup.subscriptions.length - overwritten,
      overwritten,
      retained: current.size - overwritten
    }
  }
  async preview(id: string): Promise<RestorePreview> {
    return this.prepareFile(await this.safePath(id))
  }
  beforeSync(): Promise<string> {
    return this.serialize(() => this.write('before-sync'))
  }
  beforeImport(): Promise<string> {
    return this.serialize(() => this.write('before-import'))
  }
  async select(id: string): Promise<BackupSelection> {
    return this.selectFile(await this.safePath(id))
  }
  async protectionStatus(): Promise<ProtectionStatus> {
    if (!this.protection) return { enabled: false, credentialAvailable: !!this.vault }
    try {
      await this.vault?.read(this.protection.credential)
      return { enabled: true, credentialAvailable: !!this.vault }
    } catch {
      return { enabled: true, credentialAvailable: false }
    }
  }
  configure(raw: BackupProtection): Promise<ProtectionStatus> {
    return this.serialize(async () => {
      const input = backupProtectionSchema.parse(raw),
        previous = this.protection
      if (this.requireEncryption && !input.enabled)
        throw new Error('本地账本已加密，请保持新备份加密。')
      if (input.enabled) {
        if (!this.vault) throw new Error('系统凭据保护不可用，无法启用自动加密备份。')
        const credential = await this.vault.create(input.password)
        try {
          await this.write('manual', credential)
        } catch (error) {
          await this.vault.remove(credential)
          throw error
        }
        this.protection = { credential }
      } else this.protection = null
      this.repo.saveMetadata('backup-protection', this.protection)
      if (previous && previous.credential !== this.protection?.credential)
        await this.vault?.remove(previous.credential)
      this.state.revision = -1
      this.persist()
      this.changed()
      return this.protectionStatus()
    })
  }
  async export(options: ExportBackupOptions): Promise<Buffer> {
    return encodeBackup(this.repo.export(), options.encrypted ? options.password : undefined)
  }
  remove(id: string): Promise<void> {
    return this.serialize(async () => {
      await unlink(await this.safePath(id))
    })
  }
  async bytes(id: string): Promise<Buffer> {
    const path = await this.safePath(id)
    if ((await lstat(path)).size > MAX_BACKUP_FILE_BYTES) throw new Error('文件超过大小限制。')
    return readFile(path)
  }
  async suspend(): Promise<void> {
    try {
      await this.flush()
    } finally {
      if (this.timer) clearTimeout(this.timer)
      this.timer = undefined
      this.suspended = true
      this.previews.clear()
      for (const v of this.selections.values()) v.bytes.fill(0)
      this.selections.clear()
    }
  }
  async protectionPassword(): Promise<string | undefined> {
    return this.protection ? this.vault?.read(this.protection.credential) : undefined
  }
  restore(token: string, mode: 'merge' | 'replace' = 'merge'): Promise<number> {
    return this.serialize(async () => {
      const preview = this.previews.get(token)
      if (!preview || preview.expires < Date.now())
        throw new Error('恢复预览已过期，请重新选择备份。')
      if (preview.revision !== this.repo.revision())
        throw new Error('账本已发生变化，请重新预览后恢复。')
      await this.write('before-restore')
      if (preview.revision !== this.repo.revision())
        throw new Error('账本已发生变化，请重新预览后恢复。')
      const count = this.repo.import(preview.backup, mode === 'replace')
      this.log('backup.restored')
      this.previews.delete(token)
      this.changed()
      return count
    })
  }
}
