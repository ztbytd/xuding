import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto'
import { z } from 'zod'
const b64 = (size: number) =>
  z.string().refine((v) => {
    const b = Buffer.from(v, 'base64')
    return b.length === size && b.toString('base64') === v
  })
export const sealedSchema = z
  .object({
    v: z.literal(1),
    iv: b64(12),
    tag: b64(16),
    data: z
      .string()
      .max(100 * 1024 * 1024)
      .regex(/^[A-Za-z0-9+/]*={0,2}$/)
  })
  .strict()
export const wrappedSchema = z
  .object({ v: z.literal(1), salt: b64(32), sealed: sealedSchema })
  .strict()
export type Wrapped = z.infer<typeof wrappedSchema>
export function seal(data: Buffer, key: Buffer, context: string): z.infer<typeof sealedSchema> {
  const iv = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from('xuding:' + context + ':v1'))
  return {
    v: 1,
    iv: iv.toString('base64'),
    data: Buffer.concat([cipher.update(data), cipher.final()]).toString('base64'),
    tag: cipher.getAuthTag().toString('base64')
  }
}
export function unseal(raw: unknown, key: Buffer, context: string): Buffer {
  const v = sealedSchema.parse(raw),
    data = Buffer.from(v.data, 'base64')
  if (data.toString('base64') !== v.data) throw new Error('加密内容无效。')
  const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(v.iv, 'base64'))
  cipher.setAAD(Buffer.from('xuding:' + context + ':v1'))
  cipher.setAuthTag(Buffer.from(v.tag, 'base64'))
  return Buffer.concat([cipher.update(data), cipher.final()])
}
async function derive(password: string, salt: Buffer): Promise<Buffer> {
  if (password.length > 256) throw new Error('密码过长。')
  return new Promise((resolve, reject) =>
    scrypt(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (e, k) =>
      e ? reject(e) : resolve(k)
    )
  )
}
export async function wrap(data: Buffer, password: string, context: string): Promise<Wrapped> {
  const salt = randomBytes(32),
    key = await derive(password, salt)
  try {
    return { v: 1, salt: salt.toString('base64'), sealed: seal(data, key, context) }
  } finally {
    key.fill(0)
  }
}
export async function unwrap(raw: unknown, password: string, context: string): Promise<Buffer> {
  const v = wrappedSchema.parse(raw),
    key = await derive(password, Buffer.from(v.salt, 'base64'))
  try {
    return unseal(v.sealed, key, context)
  } catch {
    throw new Error('密码或恢复密钥错误，或保护文件已损坏。')
  } finally {
    key.fill(0)
  }
}
