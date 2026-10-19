import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SubscriptionRepository } from '../src/main/database'
import { LocalVault } from '../src/main/vault'
import { RecoveryService, inspectDatabase } from '../src/main/recovery'
import { openDatabase } from '../src/main/sqlite'
import { securityOptionsSchema } from '../src/shared/vault-model'
import { seal, unseal, wrap, unwrap } from '../src/main/secret-crypto'
const input = {
  name: 'PRIVATE-VAULT-TEST-SECRET',
  category: '效率工具' as const,
  amountMinor: 12345,
  currency: 'CNY' as const,
  cycle: 'month' as const,
  interval: 1,
  anchorDate: '2026-10-20',
  status: 'active' as const,
  autoRenew: true,
  reminderDays: 3 as const,
  website: '',
  notes: 'PRIVATE-NOTE-SECRET'
}
const clock = () => new Date('2026-10-20T04:00:00Z')
const options = securityOptionsSchema.parse({}),
  password = '本机加密测试密码 2026'
describe('encrypted local ledgers', { timeout: 30_000 }, () => {
  it('uses domain-separated authenticated envelopes and rejects mutation', async () => {
    const key = Buffer.alloc(32, 31),
      data = Buffer.from('secret')
    const a = seal(data, key, 'a'),
      b = seal(data, key, 'a')
    expect(a.iv).not.toBe(b.iv)
    expect(unseal(a, key, 'a').toString()).toBe('secret')
    expect(() => unseal(a, key, 'b')).toThrow()
    const wrapped = await wrap(key, password, 'key')
    expect(await unwrap(wrapped, password, 'key')).toEqual(key)
    await expect(unwrap(wrapped, 'wrong password', 'key')).rejects.toThrow()
  })
  it('migrates, encrypts WAL and checkpoints, locks/restarts and recovers independently', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'xuding-vault-test-')),
      file = join(dir, 'xuding.db')
    let repo = new SubscriptionRepository(file, clock)
    const s = repo.save(input)
    repo.checkpoint()
    repo.close()
    const vault = new LocalVault(dir),
      prepared = await vault.prepare(password, options)
    expect(prepared.recoveryKey).toHaveLength(64)
    await expect(vault.enable('wrong')).rejects.toThrow('最后')
    await vault.enable(prepared.recoveryKey!.slice(-8))
    expect(vault.status()).toMatchObject({ enabled: true, locked: false })
    expect((await readFile(file)).includes(Buffer.from(input.name))).toBe(false)
    expect(() => new SubscriptionRepository(file, clock)).toThrow()
    repo = new SubscriptionRepository(file, clock, vault.key)
    repo.decisions.record(s.id, '2026-10-20')
    const files = await readdir(dir)
    for (const name of files.filter((n) => n === 'xuding.db' || n === 'xuding.db-wal'))
      expect((await readFile(join(dir, name))).includes(Buffer.from(input.name))).toBe(false)
    const recovery = new RecoveryService(dir, '0.8.0', () => vault.key),
      checkpoint = recovery.checkpointNow()
    expect(inspectDatabase(join(dir, checkpoint), vault.key)).toBe(5)
    expect((await readFile(join(dir, checkpoint))).includes(Buffer.from(input.notes))).toBe(false)
    repo.close()
    vault.lock()
    expect(vault.locked).toBe(true)
    const restarted = new LocalVault(dir)
    await restarted.initialize()
    expect(restarted.locked).toBe(true)
    await expect(restarted.unlock('incorrect password')).rejects.toThrow()
    await restarted.unlock(prepared.recoveryKey!, true)
    repo = new SubscriptionRepository(file, clock, restarted.key)
    expect(repo.list()[0].name).toBe(input.name)
    expect(repo.decisions.usage()).toHaveLength(1)
    repo.close()
    await restarted.changePassword(prepared.recoveryKey!, '新的本地解锁测试密码 2026')
    restarted.lock()
    await expect(restarted.unlock(password)).rejects.toThrow()
    await restarted.unlock('新的本地解锁测试密码 2026')
    const key = await restarted.rotateRecovery('新的本地解锁测试密码 2026')
    restarted.lock()
    await expect(restarted.unlock(prepared.recoveryKey!, true)).rejects.toThrow()
    await restarted.unlock(key, true)
  })
  it('authenticates a damaged ledger and restores an encrypted recovery point', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'xuding-vault-damaged-')),
      file = join(dir, 'xuding.db')
    const repo = new SubscriptionRepository(file, clock)
    repo.save(input)
    repo.close()
    const vault = new LocalVault(dir),
      prepared = await vault.prepare(password, options)
    await vault.enable(prepared.recoveryKey!.slice(-8))
    const recovery = new RecoveryService(
        dir,
        '0.8.0',
        () => vault.key,
        () => vault.keys
      ),
      point = recovery.checkpointNow()
    vault.lock()
    await writeFile(file, 'damaged database')
    await expect(vault.unlock('incorrect password')).rejects.toThrow()
    await vault.unlock(password)
    expect((await recovery.entries()).find((p) => p.id === point)?.valid).toBe(true)
    await recovery.restore(point)
    const restored = new SubscriptionRepository(file, clock, vault.key)
    expect(restored.list()[0].name).toBe(input.name)
    restored.close()
  })
  it('refuses an unsafe migration destination without touching the live ledger', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'xuding-vault-interruption-')),
      file = join(dir, 'xuding.db')
    const repo = new SubscriptionRepository(file, clock)
    repo.save(input)
    repo.close()
    const vault = new LocalVault(dir),
      p = await vault.prepare(password, options)
    // Fail copying by making the target a directory: original file must still be usable.
    const { mkdir } = await import('node:fs/promises')
    await mkdir(file + '.encrypted-next')
    await expect(vault.enable(p.recoveryKey!.slice(-8))).rejects.toThrow()
    const check = openDatabase(file)
    expect(check.prepare('SELECT count(*) AS n FROM subscriptions').get().n).toBe(1)
    check.close()
  })
  it('resumes an interrupted copy and retains access to older encrypted checkpoints after rekey', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'xuding-vault-resume-')),
      file = join(dir, 'xuding.db')
    const repo = new SubscriptionRepository(file, clock)
    repo.save(input)
    repo.close()
    const vault = new LocalVault(dir),
      p = await vault.prepare(password, options)
    const intent = (vault as unknown as { prepared: { config: unknown } }).prepared.config
    await writeFile(join(dir, 'vault-state.json'), JSON.stringify(intent))
    await writeFile(file + '.encrypted-next', 'incomplete copy')
    const recovered = new LocalVault(dir)
    await recovered.initialize()
    await recovered.unlock(password)
    expect(recovered.status()).toMatchObject({ enabled: true, locked: false })
    const service = new RecoveryService(
        dir,
        '0.8.0',
        () => recovered.key,
        () => recovered.keys
      ),
      point = service.checkpointNow()
    const oldKey = Buffer.from(recovered.key!)
    await recovered.rekey(password)
    expect(recovered.key!.equals(oldKey)).toBe(false)
    expect((await service.entries()).find((v) => v.id === point)?.valid).toBe(true)
    await service.restore(point)
    const check = new SubscriptionRepository(file, clock, recovered.key)
    expect(check.list()[0].name).toBe(input.name)
    check.close()
    oldKey.fill(0)
  })
})
