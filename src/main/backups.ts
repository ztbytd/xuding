import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, lstat, stat, open, rename, unlink } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { z } from 'zod'
import { backupSchema } from '../shared/model'
import type { Backup, BackupEntry, BackupStatus, RestorePreview } from '../shared/model'
import { addDays, localDate } from '../shared/billing'
import type { SubscriptionRepository } from './database'

const stateSchema = z.object({
  directory: z.string(),
  lastSuccess: z.string().nullable(),
  lastError: z.string().nullable(),
  revision: z.number().int(),
  day: z.string()
})
const filename =
  /^(daily-\d{4}-\d{2}-\d{2}|(manual|before-restore)-\d{4}-\d{2}-\d{2}-[a-f0-9-]{36})\.json$/
const MAX_BYTES = 50 * 1024 * 1024
export class BackupService {
  private state: z.infer<typeof stateSchema>
  private timer: ReturnType<typeof setTimeout> | undefined
  private queue: Promise<unknown> = Promise.resolve()
  private previews = new Map<string, { backup: Backup; revision: number; expires: number }>()
  constructor(
    private repo: SubscriptionRepository,
    defaultDirectory: string,
    private now = () => new Date()
  ) {
    const stored = stateSchema.safeParse(repo.metadata('backup-state'))
    this.state = stored.success
      ? stored.data
      : { directory: defaultDirectory, lastSuccess: null, lastError: null, revision: -1, day: '' }
  }
  status(): BackupStatus {
    return {
      directory: this.state.directory,
      lastSuccess: this.state.lastSuccess,
      lastError: this.state.lastError,
      pending: !!this.timer
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
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    if (this.repo.settings().autoBackupEnabled) await this.automatic()
    await this.queue
  }
  automatic(): Promise<void> {
    return this.serialize(async () => {
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
  private async write(kind: BackupEntry['kind']): Promise<string> {
    const revision = this.repo.revision()
    const now = this.now(),
      day = localDate(now)
    const id = kind === 'daily' ? `daily-${day}.json` : `${kind}-${day}-${randomUUID()}.json`
    const destination = join(this.state.directory, id)
    const temporary = destination + `.${randomUUID()}.tmp`
    try {
      await mkdir(this.state.directory, { recursive: true })
      const data = JSON.stringify(
        backupSchema.parse({ ...this.repo.export(), exportedAt: now.toISOString() }),
        null,
        2
      )
      if (Buffer.byteLength(data) > MAX_BYTES)
        throw new Error('账本超过 50 MB，请减少图标大小后重试。')
      const handle = await open(temporary, 'wx', 0o600)
      try {
        await handle.writeFile(data, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(temporary, destination)
      this.state = {
        ...this.state,
        lastSuccess: now.toISOString(),
        lastError: null,
        ...(kind !== 'before-restore' ? { revision, day } : {})
      }
      this.persist()
      await this.cleanup()
      return id
    } catch (error) {
      this.state.lastError =
        error instanceof Error ? error.message : '备份失败，请检查目录权限与剩余空间。'
      this.persist()
      throw new Error(this.state.lastError)
    } finally {
      await unlink(temporary).catch(() => {})
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
        .filter((id) => id.startsWith('before-restore-'))
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
      const remove = id.startsWith('before-restore-')
        ? !keepSafety.has(id)
        : id.slice(id.indexOf('-') + 1, id.indexOf('-') + 11) < cutoff
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
      try {
        const target = await this.safePath(id),
          size = (await lstat(target)).size
        if (size > MAX_BYTES) continue
        const backup = backupSchema.parse(JSON.parse(await readFile(target, 'utf8')))
        entries.push({
          id,
          createdAt: backup.exportedAt,
          count: backup.subscriptions.length,
          size,
          kind: id.startsWith('daily-')
            ? 'daily'
            : id.startsWith('manual-')
              ? 'manual'
              : 'before-restore'
        })
      } catch {
        /* Damaged or externally replaced files are never offered for restoration. */
      }
    }
    return entries.sort(
      (a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)
    )
  }
  async prepareFile(path: string, source = basename(path)): Promise<RestorePreview> {
    const info = await stat(path)
    if (!info.isFile()) throw new Error('请选择 JSON 备份文件。')
    if (info.size > MAX_BYTES) throw new Error('备份文件不能超过 50 MB。')
    const backup = backupSchema.parse(JSON.parse(await readFile(path, 'utf8')))
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
      fullRestoreSupported: backup.version === 3,
      budgets: backup.version === 3 ? backup.budgets.length : 0,
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
  beforeImport(): Promise<string> {
    return this.serialize(() => this.write('before-restore'))
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
      this.previews.delete(token)
      this.changed()
      return count
    })
  }
}
