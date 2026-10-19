import { createHash, verify } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readFile, unlink } from 'node:fs/promises'
import { z } from 'zod'
import { signedUpdatePayloadSchema } from '../shared/operations-model'
import type { SignedUpdatePayload, UpdateState } from '../shared/operations-model'
import { atomicWrite } from './files'

const signedEnvelopeSchema = z
  .object({ payload: z.string().max(40000), signature: z.string().max(128) })
  .strict()
export function verifyUpdateManifest(value: unknown, publicKey: string): SignedUpdatePayload {
  const envelope = signedEnvelopeSchema.parse(value)
  const bytes = Buffer.from(envelope.payload, 'base64'),
    signature = Buffer.from(envelope.signature, 'base64')
  if (
    bytes.toString('base64') !== envelope.payload ||
    signature.length !== 64 ||
    !verify(null, bytes, publicKey, signature)
  )
    throw new Error('更新信息签名无效，已停止更新。')
  const payload = signedUpdatePayloadSchema.parse(JSON.parse(bytes.toString('utf8')))
  if (payload.filename !== `xuding-${payload.version}-windows-x64-setup.exe`)
    throw new Error('更新包版本不匹配。')
  return payload
}
export function newerVersion(next: string, current: string): boolean {
  const a = next.split('.').map(Number),
    b = current.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i]
  }
  return false
}
export async function verifyInstaller(path: string, expected: SignedUpdatePayload): Promise<void> {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.size !== expected.size)
    throw new Error('更新包大小校验失败，请重新下载。')
  const hash = createHash('sha512')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  if (hash.digest('base64') !== expected.sha512)
    throw new Error('更新包完整性校验失败，请重新下载。')
}
export interface UpdateAdapter {
  check(base: string): Promise<{
    version: string
    files: { url: string; sha512: string; size?: number }[]
    packages?: unknown
  }>
  download(progress: (percent: number) => void): Promise<string[]>
  install(): void
}
export class UpdateService {
  private state: UpdateState
  private envelope: unknown = null
  private expected: SignedUpdatePayload | null = null
  private installer: string | null = null
  private operation: Promise<UpdateState> | null = null
  constructor(
    private options: {
      version: string
      supported: boolean
      publicKey: string
      statePath: string
      fetchManifest: () => Promise<unknown | null>
      adapter: UpdateAdapter
      prepareInstall: () => Promise<void>
      releaseInstall?: () => void
      log: (event: string, error?: unknown) => void
      baseUrl?: (version: string) => string
    }
  ) {
    this.state = {
      phase: options.supported ? 'idle' : 'unsupported',
      currentVersion: options.version,
      version: null,
      notes: '',
      progress: 0,
      error: null,
      checkedAt: null,
      automatic: true
    }
  }
  status(): UpdateState {
    return { ...this.state }
  }
  private async persist() {
    await atomicWrite(
      this.options.statePath,
      JSON.stringify({
        automatic: this.state.automatic,
        checkedAt: this.state.checkedAt,
        envelope: this.envelope,
        installer: this.installer
      })
    )
  }
  async initialize(): Promise<void> {
    try {
      const saved = JSON.parse(await readFile(this.options.statePath, 'utf8'))
      if (typeof saved.automatic === 'boolean') this.state.automatic = saved.automatic
      if (typeof saved.checkedAt === 'string' && !Number.isNaN(Date.parse(saved.checkedAt)))
        this.state.checkedAt = saved.checkedAt
      if (saved.envelope && this.options.supported) {
        const expected = verifyUpdateManifest(saved.envelope, this.options.publicKey)
        if (newerVersion(expected.version, this.options.version)) {
          this.expected = expected
          this.envelope = saved.envelope
          Object.assign(this.state, {
            version: expected.version,
            notes: expected.notes,
            phase: 'available'
          })
          // Restore a cached package through electron-updater on the next explicit download.
          // Its download helper must own the installation path after every restart.
          if (typeof saved.installer === 'string') {
            await verifyInstaller(saved.installer, expected)
            this.state.notes += '\n\n已保存下载缓存，点击下载可校验并重新载入。'
          }
        }
      }
    } catch {
      /* first start or unavailable cached data */
    }
  }
  async preference(automatic: boolean): Promise<UpdateState> {
    this.state.automatic = automatic
    await this.persist()
    return this.status()
  }
  async automatic(): Promise<UpdateState> {
    if (!this.state.automatic || !this.options.supported || this.state.phase === 'downloaded')
      return this.status()
    const checked = this.state.checkedAt ? Date.parse(this.state.checkedAt) : 0
    if (Date.now() - checked < 86400000) return this.status()
    return this.check()
  }
  private run(
    work: () => Promise<void>,
    failedPhase: UpdateState['phase'] = 'error'
  ): Promise<UpdateState> {
    if (this.operation) return this.operation
    this.operation = work()
      .catch((error) => {
        this.options.log('update.failed', error)
        this.state.phase = failedPhase === 'downloaded' && !this.installer ? 'error' : failedPhase
        this.state.error =
          error instanceof Error && /签名|校验|备份|账本|忙|凭据|取消/.test(error.message)
            ? error.message
            : '更新暂时不可用，请检查网络后重试，或打开正式发布页。'
      })
      .then(() => this.status())
      .finally(() => {
        this.operation = null
      })
    return this.operation
  }
  check(): Promise<UpdateState> {
    if (!this.options.supported || ['downloaded', 'installing'].includes(this.state.phase))
      return Promise.resolve(this.status())
    return this.run(async () => {
      this.state.phase = 'checking'
      this.state.error = null
      this.state.checkedAt = new Date().toISOString()
      await this.persist()
      const envelope = await this.options.fetchManifest()
      if (!envelope) {
        this.state.phase = 'current'
        return
      }
      const expected = verifyUpdateManifest(envelope, this.options.publicKey)
      if (!newerVersion(expected.version, this.options.version)) {
        this.state.phase = 'current'
        this.expected = null
        this.envelope = null
        this.state.version = null
        this.state.notes = ''
        await this.persist()
        return
      }
      this.envelope = envelope
      this.expected = expected
      this.installer = null
      Object.assign(this.state, {
        phase: 'available',
        version: expected.version,
        notes: expected.notes,
        progress: 0
      })
      await this.persist()
      this.options.log('update.available')
    })
  }
  download(): Promise<UpdateState> {
    return this.run(async () => {
      if (!this.options.supported || !this.expected || !this.envelope)
        throw new Error('请先检查更新。')
      const expected = verifyUpdateManifest(this.envelope, this.options.publicKey)
      this.state.phase = 'downloading'
      this.state.error = null
      this.state.progress = 0
      const base =
        this.options.baseUrl?.(expected.version) ??
        `https://github.com/ztbytd/xuding/releases/download/v${expected.version}/`
      const info = await this.options.adapter.check(base)
      if (info.version !== expected.version || info.files.length !== 1 || info.packages)
        throw new Error('更新清单校验失败，已停止下载。')
      const file = info.files[0]
      if (
        file.url !== expected.filename ||
        file.sha512 !== expected.sha512 ||
        file.size !== expected.size
      )
        throw new Error('更新清单与签名不一致，校验失败。')
      const paths = await this.options.adapter.download((percent) => {
        this.state.progress = Math.max(0, Math.min(100, Math.round(percent)))
      })
      if (paths.length !== 1) throw new Error('更新包校验失败。')
      try {
        await verifyInstaller(paths[0], expected)
      } catch (error) {
        await unlink(paths[0]).catch(() => {})
        throw error
      }
      this.installer = paths[0]
      this.state.phase = 'downloaded'
      this.state.progress = 100
      await this.persist()
      this.options.log('update.downloaded')
    })
  }
  install(): Promise<UpdateState> {
    return this.run(
      async () => {
        if (
          this.state.phase !== 'downloaded' ||
          !this.installer ||
          !this.expected ||
          !this.envelope
        )
          throw new Error('请先完成下载和校验。')
        this.state.error = null
        try {
          await verifyInstaller(
            this.installer,
            verifyUpdateManifest(this.envelope, this.options.publicKey)
          )
        } catch (error) {
          this.installer = null
          await this.persist()
          throw error
        }
        await this.options.prepareInstall()
        try {
          await verifyInstaller(
            this.installer,
            verifyUpdateManifest(this.envelope, this.options.publicKey)
          )
          this.state.phase = 'installing'
          this.options.log('update.installing')
          this.options.adapter.install()
        } catch (error) {
          this.options.releaseInstall?.()
          throw error
        }
      },
      this.installer ? 'downloaded' : 'error'
    )
  }
}
