import { randomUUID } from 'node:crypto'
import { mkdir, readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWrite } from './files'
import { passwordSchema } from '../shared/operations-model'

export interface BackupVault {
  create(password: string): Promise<string>
  read(id: string): Promise<string>
  remove(id: string): Promise<void>
}
export class CredentialVault implements BackupVault {
  constructor(
    private directory: string,
    private protect: (value: string) => Promise<Buffer>,
    private unprotect: (value: Buffer) => Promise<string>
  ) {}
  private path(id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('备份凭据无效，请重新设置密码。')
    return join(this.directory, id + '.credential')
  }
  async create(password: string): Promise<string> {
    passwordSchema.parse(password)
    const protectedValue = await this.protect(password)
    if ((await this.unprotect(protectedValue)) !== password)
      throw new Error('无法验证本机备份凭据。')
    await mkdir(this.directory, { recursive: true })
    const id = randomUUID()
    await atomicWrite(this.path(id), protectedValue)
    return id
  }
  async read(id: string): Promise<string> {
    try {
      return passwordSchema.parse(await this.unprotect(await readFile(this.path(id))))
    } catch {
      throw new Error('无法读取本机备份凭据，请在数据与备份中重新设置密码。')
    }
  }
  async remove(id: string): Promise<void> {
    await unlink(this.path(id)).catch(() => {})
  }
  async createSecret(value: string): Promise<string> {
    if (value.length > 16384) throw new Error('凭据过大。')
    const protectedValue = await this.protect(value)
    if ((await this.unprotect(protectedValue)) !== value) throw new Error('系统凭据验证失败。')
    await mkdir(this.directory, { recursive: true })
    const id = randomUUID()
    await atomicWrite(this.path(id), protectedValue)
    return id
  }
  async readSecret(id: string): Promise<string> {
    return this.unprotect(await readFile(this.path(id)))
  }
}
