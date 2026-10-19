import { z } from 'zod'

export const passwordSchema = z
  .string()
  .min(12, '密码至少需要 12 个字符。')
  .max(256, '密码不能超过 256 个字符。')
export const backupProtectionSchema = z.discriminatedUnion('enabled', [
  z
    .object({ enabled: z.literal(true), password: passwordSchema, remember: z.literal(true) })
    .strict(),
  z.object({ enabled: z.literal(false) }).strict()
])
export const exportBackupOptionsSchema = z.discriminatedUnion('encrypted', [
  z.object({ encrypted: z.literal(true), password: passwordSchema }).strict(),
  z.object({ encrypted: z.literal(false) }).strict()
])
export type BackupProtection = z.infer<typeof backupProtectionSchema>
export type ExportBackupOptions = z.infer<typeof exportBackupOptionsSchema>
export type BackupSelection = { token: string; source: string; encrypted: boolean }
export type ProtectionStatus = { enabled: boolean; credentialAvailable: boolean }
export type UpdateState = {
  phase:
    | 'idle'
    | 'checking'
    | 'current'
    | 'available'
    | 'downloading'
    | 'downloaded'
    | 'installing'
    | 'error'
    | 'unsupported'
  currentVersion: string
  version: string | null
  notes: string
  progress: number
  error: string | null
  checkedAt: string | null
  automatic: boolean
}
export type RecoveryEntry = {
  id: string
  createdAt: string
  version: number | null
  valid: boolean
  size: number
}
export type RecoveryState = { active: boolean; reason: string; entries: RecoveryEntry[] }

export const signedUpdatePayloadSchema = z
  .object({
    format: z.literal('xuding-update'),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    filename: z.string().regex(/^xuding-\d+\.\d+\.\d+-windows-x64-setup\.exe$/),
    sha512: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
    size: z
      .number()
      .int()
      .positive()
      .max(500 * 1024 * 1024),
    notes: z.string().max(20000),
    publishedAt: z.string().datetime()
  })
  .strict()
export type SignedUpdatePayload = z.infer<typeof signedUpdatePayloadSchema>
