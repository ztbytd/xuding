import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { basename, join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { SubscriptionRepository } from '../src/main/database'
import { BackupService } from '../src/main/backups'
import { decodeBackup, encodeBackup, parseBackupFile } from '../src/main/backup-crypto'
import { CredentialVault } from '../src/main/credentials'
import { RecoveryService } from '../src/main/recovery'
import { Diagnostics } from '../src/main/diagnostics'
import { subscription } from './fixtures'

describe('encrypted backups and recoverable desktop data', () => {
  let directory: string, repo: SubscriptionRepository, service: BackupService
  const password = '一份只有我知道的长密码 2026'
  const { id: _id, createdAt: _created, updatedAt: _updated, ...input } = subscription()
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'xuding-security-'))
    repo = new SubscriptionRepository(join(directory, 'xuding.db'))
    const vault = new CredentialVault(
      join(directory, 'credentials'),
      async (value) => Buffer.from('protected:' + value),
      async (value) => value.toString().slice(10)
    )
    service = new BackupService(repo, join(directory, 'backups'), () => new Date(), vault)
    repo.save(input)
  })
  afterEach(async () => {
    await service.flush().catch(() => {})
    repo.close()
    const target = resolve(directory)
    if (
      !target.startsWith(resolve(tmpdir()) + sep) ||
      !basename(target).startsWith('xuding-security-')
    )
      throw new Error('Unexpected cleanup target')
    await rm(target, { recursive: true, force: true })
  })
  it('encrypts authenticated files with independent random salts and restores without a machine credential', async () => {
    const backup = repo.export(),
      first = await encodeBackup(backup, password),
      second = await encodeBackup(backup, password)
    expect(first.equals(second)).toBe(false)
    expect(first.toString()).not.toContain(input.name)
    expect(first.toString()).not.toContain(password)
    expect(await decodeBackup(parseBackupFile(first), password)).toEqual(backup)
    const independent = new BackupService(repo, join(directory, 'other-backups'))
    const path = join(directory, 'transfer.xudingbackup')
    await writeFile(path, first)
    const preview = await independent.prepareFile(path, undefined, password)
    expect(preview.count).toBe(1)
  })
  it('rejects a wrong password, tampered ciphertext and expensive KDF parameters before writing', async () => {
    const before = repo.export(),
      data = JSON.parse((await encodeBackup(before, password)).toString())
    await expect(decodeBackup(data, 'wrong-password-long')).rejects.toThrow('密码错误')
    const modified = structuredClone(data)
    modified.ciphertext =
      (modified.ciphertext[0] === 'A' ? 'B' : 'A') + modified.ciphertext.slice(1)
    await expect(decodeBackup(modified, password)).rejects.toThrow('已损坏')
    data.kdf.N = 2 ** 30
    await expect(decodeBackup(data, password)).rejects.toThrow('格式不受支持')
    expect({ ...repo.export(), exportedAt: before.exportedAt }).toEqual(before)
  })
  it('enables protection only after creating a verified backup, rotates passwords, and labels import snapshots', async () => {
    await service.configure({ enabled: true, password, remember: true })
    expect(service.status().encrypted).toBe(true)
    expect((await service.history())[0]).toMatchObject({
      state: 'locked',
      encrypted: true,
      count: null
    })
    const old = (await service.history())[0].id
    await service.configure({ enabled: true, password: 'another long password', remember: true })
    expect(await decodeBackup(parseBackupFile(await service.bytes(old)), password)).toMatchObject({
      version: 4
    })
    const imported = await service.beforeImport()
    expect(imported).toMatch(/^before-import-.*\.xudingbackup$/)
    const selected = await service.select(imported)
    await expect(service.unlock(selected.token, password)).rejects.toThrow()
    expect((await service.unlock(selected.token, 'another long password')).count).toBe(1)
    await expect(service.unlock(selected.token, 'another long password')).rejects.toThrow('已过期')
  })
  it('pauses when credentials disappear and never falls back to plain text', async () => {
    await service.configure({ enabled: true, password, remember: true })
    const credentials = await readdir(join(directory, 'credentials'))
    await rm(join(directory, 'credentials', credentials[0]))
    expect(await service.protectionStatus()).toEqual({ enabled: true, credentialAvailable: false })
    const before = await readdir(service.status().directory)
    await expect(service.nowBackup()).rejects.toThrow('凭据')
    expect(await readdir(service.status().directory)).toEqual(before)
    await expect(
      service.restore(
        (
          await service.prepareFile(
            join(service.status().directory, before[0]),
            undefined,
            password
          )
        ).token
      )
    ).rejects.toThrow('凭据')
  })
  it('retains old manual snapshots, surfaces corrupt files and prevents traversal', async () => {
    await service.nowBackup()
    const manual = (await service.history())[0].id
    await writeFile(join(service.status().directory, 'daily-2000-01-01.json'), 'broken')
    expect((await service.history()).find((v) => v.id.startsWith('daily-2000'))).toMatchObject({
      state: 'invalid'
    })
    await service.nowBackup()
    expect((await service.history()).some((v) => v.id === manual)).toBe(true)
    expect((await service.history()).some((v) => v.id.startsWith('daily-2000'))).toBe(false)
    await expect(service.bytes('../xuding.db')).rejects.toThrow('无效')
    await service.remove(manual)
    expect((await service.history()).some((v) => v.id === manual)).toBe(false)
  })
  it('preserves the failed database and its sidecars when restoring a verified checkpoint', async () => {
    await service.flush()
    const original = repo.list()
    repo.close()
    const recovery = new RecoveryService(directory, '0.5.0')
    await recovery.beforeOpen()
    const checkpoint = (await recovery.entries())[0]
    expect(checkpoint).toMatchObject({ valid: true, version: 5 })
    await writeFile(join(directory, 'xuding.db'), 'corrupt database')
    await writeFile(join(directory, 'xuding.db-wal'), 'failed wal')
    await expect(recovery.beforeOpen()).rejects.toThrow()
    await recovery.restore(checkpoint.id)
    const files = await readdir(directory)
    expect(files.some((v) => v.startsWith('xuding.db.fault-'))).toBe(true)
    expect(files.some((v) => v.startsWith('xuding.db-wal.fault-'))).toBe(true)
    repo = new SubscriptionRepository(join(directory, 'xuding.db'))
    expect(repo.list()).toEqual(original)
    service = new BackupService(repo, join(directory, 'backups'))
  })
  it('exports diagnostic identifiers without raw exception messages, paths, names or passwords', async () => {
    const log = new Diagnostics(join(directory, 'logs'), '0.5.0')
    log.record(
      'backup.failed',
      Object.assign(new Error(`C:\\Users\\Private\\${input.name} ${password}`), { code: 'EACCES' })
    )
    const result = (await log.export()).toString()
    expect(result).toContain('EACCES')
    expect(result).toContain('backup.failed')
    expect(result).not.toContain('Private')
    expect(result).not.toContain(input.name)
    expect(result).not.toContain(password)
  })
})
