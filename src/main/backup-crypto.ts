import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto'
import { z } from 'zod'
import { backupSchema } from '../shared/model'
import type { Backup } from '../shared/model'
import { passwordSchema } from '../shared/operations-model'

export const MAX_BACKUP_BYTES = 50 * 1024 * 1024
export const MAX_BACKUP_FILE_BYTES = 72 * 1024 * 1024
const b64 = (bytes: number) =>
  z.string().refine((value) => {
    const decoded = Buffer.from(value, 'base64')
    return decoded.length === bytes && decoded.toString('base64') === value
  })
const envelopeSchema = z
  .object({
    format: z.literal('xuding-encrypted'),
    version: z.literal(1),
    kdf: z
      .object({
        name: z.literal('scrypt'),
        N: z.literal(32768),
        r: z.literal(8),
        p: z.literal(1),
        salt: b64(32)
      })
      .strict(),
    cipher: z.object({ name: z.literal('aes-256-gcm'), iv: b64(12), tag: b64(16) }).strict(),
    ciphertext: z
      .string()
      .max(Math.ceil(MAX_BACKUP_BYTES / 3) * 4)
      .regex(/^[A-Za-z0-9+/]*={0,2}$/)
  })
  .strict()
type Envelope = z.infer<typeof envelopeSchema>
function aad(value: Envelope): Buffer {
  return Buffer.from(
    JSON.stringify({
      format: value.format,
      version: value.version,
      kdf: value.kdf,
      cipher: { name: value.cipher.name, iv: value.cipher.iv }
    })
  )
}
function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) =>
      error ? reject(error) : resolve(key)
    )
  )
}
export function parseBackupFile(bytes: Buffer): unknown {
  if (bytes.length > MAX_BACKUP_FILE_BYTES) throw new Error('备份文件超过大小限制。')
  try {
    return JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''))
  } catch {
    throw new Error('备份文件无法读取，请检查文件格式。')
  }
}
export function isEncryptedBackup(value: unknown): boolean {
  return (
    !!value && typeof value === 'object' && 'format' in value && value.format === 'xuding-encrypted'
  )
}
export async function encodeBackup(backup: Backup, password?: string): Promise<Buffer> {
  const data = Buffer.from(JSON.stringify(backupSchema.parse(backup)))
  if (data.length > MAX_BACKUP_BYTES) throw new Error('账本超过 50 MB，请减少图标大小后重试。')
  if (password === undefined) return data
  passwordSchema.parse(password)
  const salt = randomBytes(32),
    iv = randomBytes(12),
    key = await derive(password, salt)
  const envelope: Envelope = {
    format: 'xuding-encrypted',
    version: 1,
    kdf: { name: 'scrypt', N: 32768, r: 8, p: 1, salt: salt.toString('base64') },
    cipher: { name: 'aes-256-gcm', iv: iv.toString('base64'), tag: '' },
    ciphertext: ''
  }
  try {
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    cipher.setAAD(aad(envelope))
    envelope.ciphertext = Buffer.concat([cipher.update(data), cipher.final()]).toString('base64')
    envelope.cipher.tag = cipher.getAuthTag().toString('base64')
    return Buffer.from(JSON.stringify(envelope))
  } finally {
    key.fill(0)
    data.fill(0)
  }
}
export async function decodeBackup(value: unknown, password?: string): Promise<Backup> {
  if (!isEncryptedBackup(value)) return backupSchema.parse(value)
  const parsed = envelopeSchema.safeParse(value)
  if (!parsed.success) throw new Error('加密备份格式不受支持或文件已损坏。')
  if (password === undefined) throw new Error('请输入此备份的密码。')
  const envelope = parsed.data
  const ciphertext = Buffer.from(envelope.ciphertext, 'base64')
  if (ciphertext.toString('base64') !== envelope.ciphertext || ciphertext.length > MAX_BACKUP_BYTES)
    throw new Error('加密备份格式无效。')
  const key = await derive(passwordSchema.parse(password), Buffer.from(envelope.kdf.salt, 'base64'))
  let data: Buffer | undefined
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.cipher.iv, 'base64'))
    decipher.setAAD(aad(envelope))
    decipher.setAuthTag(Buffer.from(envelope.cipher.tag, 'base64'))
    data = Buffer.concat([decipher.update(ciphertext), decipher.final()])
    return backupSchema.parse(JSON.parse(data.toString('utf8')))
  } catch {
    throw new Error('密码错误或备份文件已损坏，请检查后重试。')
  } finally {
    key.fill(0)
    data?.fill(0)
  }
}
