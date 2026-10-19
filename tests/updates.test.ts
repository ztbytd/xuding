import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { basename, join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { UpdateService, verifyUpdateManifest } from '../src/main/updates'
import type { SignedUpdatePayload } from '../src/shared/operations-model'

describe('signed update delivery and install protection', () => {
  let directory: string,
    expected: SignedUpdatePayload,
    envelope: { payload: string; signature: string },
    service: UpdateService
  const pair = generateKeyPairSync('ed25519'),
    publicKey = pair.publicKey.export({ format: 'pem', type: 'spki' }).toString()
  const installer = Buffer.from('synthetic installer bytes for service verification')
  const download = vi.fn<() => Promise<string[]>>(),
    install = vi.fn(),
    prepare = vi.fn<() => Promise<void>>()
  function create(
    manifest: unknown = envelope,
    files?: { url: string; sha512: string; size: number }[]
  ) {
    return new UpdateService({
      version: '0.5.0',
      supported: true,
      publicKey,
      statePath: join(directory, 'update-state.json'),
      fetchManifest: async () => manifest,
      adapter: {
        check: async () => ({
          version: expected.version,
          files: files ?? [{ url: expected.filename, sha512: expected.sha512, size: expected.size }]
        }),
        download,
        install
      },
      prepareInstall: prepare,
      log: () => {}
    })
  }
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'xuding-update-'))
    expected = {
      format: 'xuding-update',
      version: '0.5.1',
      filename: 'xuding-0.5.1-windows-x64-setup.exe',
      sha512: createHash('sha512').update(installer).digest('base64'),
      size: installer.length,
      notes: 'Release notes',
      publishedAt: new Date().toISOString()
    }
    const bytes = Buffer.from(JSON.stringify(expected))
    envelope = {
      payload: bytes.toString('base64'),
      signature: sign(null, bytes, pair.privateKey).toString('base64')
    }
    await writeFile(join(directory, expected.filename), installer)
    download.mockReset().mockResolvedValue([join(directory, expected.filename)])
    install.mockReset()
    prepare.mockReset().mockResolvedValue()
    service = create()
  })
  afterEach(async () => {
    const target = resolve(directory)
    if (
      !target.startsWith(resolve(tmpdir()) + sep) ||
      !basename(target).startsWith('xuding-update-')
    )
      throw new Error('Unexpected cleanup target')
    await rm(target, { recursive: true, force: true })
  })
  it('verifies release identity, rejects a changed payload and never downloads an unsigned release', async () => {
    expect(verifyUpdateManifest(envelope, publicKey)).toEqual(expected)
    const modified = {
      ...envelope,
      payload: Buffer.from(JSON.stringify({ ...expected, notes: 'tampered' })).toString('base64')
    }
    expect(() => verifyUpdateManifest(modified, publicKey)).toThrow('签名')
    expect((await create(modified).check()).phase).toBe('error')
    expect(download).not.toHaveBeenCalled()
  })
  it('matches updater metadata to the signed hash, version and filename before download', async () => {
    const wrong = create(envelope, [
      { url: 'evil.exe', sha512: expected.sha512, size: expected.size }
    ])
    await wrong.check()
    expect((await wrong.download()).error).toContain('校验')
    expect(download).not.toHaveBeenCalled()
  })
  it('requires explicit download, rechecks file integrity, and runs protection before installation', async () => {
    expect((await service.check()).phase).toBe('available')
    expect(download).not.toHaveBeenCalled()
    expect((await service.download()).phase).toBe('downloaded')
    expect(install).not.toHaveBeenCalled()
    expect((await service.install()).phase).toBe('installing')
    expect(prepare).toHaveBeenCalledTimes(1)
    expect(install).toHaveBeenCalledTimes(1)
    expect(prepare.mock.invocationCallOrder[0]).toBeLessThan(install.mock.invocationCallOrder[0])
  })
  it('blocks installation if the downloaded file changes or protective backup fails', async () => {
    await service.check()
    await service.download()
    await writeFile(join(directory, expected.filename), Buffer.alloc(installer.length, 1))
    expect((await service.install()).error).toContain('校验')
    expect(prepare).not.toHaveBeenCalled()
    expect(install).not.toHaveBeenCalled()
    await writeFile(join(directory, expected.filename), installer)
    await service.download()
    prepare.mockRejectedValue(new Error('备份目录不可写'))
    expect((await service.install()).error).toContain('备份')
    expect(install).not.toHaveBeenCalled()
  })
  it('preserves a downloaded update when installation is cancelled and suppresses daily repeated checks', async () => {
    await service.check()
    await service.download()
    prepare.mockRejectedValueOnce(new Error('安装已取消，已下载的更新仍然保留。'))
    expect((await service.install()).phase).toBe('downloaded')
    expect((await service.install()).phase).toBe('installing')
    const restarted = create()
    await restarted.initialize()
    expect(restarted.status().version).toBe('0.5.1')
    expect((await restarted.automatic()).phase).toBe('available')
    await restarted.preference(false)
    const disabled = create()
    await disabled.initialize()
    expect(disabled.status().automatic).toBe(false)
  })
  it('ignores a correctly signed older release', async () => {
    const bytes = Buffer.from(
      JSON.stringify({
        ...expected,
        version: '0.4.0',
        filename: 'xuding-0.4.0-windows-x64-setup.exe'
      })
    )
    const old = {
      payload: bytes.toString('base64'),
      signature: sign(null, bytes, pair.privateKey).toString('base64')
    }
    expect((await create(old).check()).phase).toBe('current')
    expect(install).not.toHaveBeenCalled()
  })
})
