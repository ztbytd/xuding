import { z } from 'zod'
import { passwordSchema } from './operations-model'
export const syncConnectionSchema = z
  .object({
    url: z.string().url().max(2048),
    username: z.string().max(256),
    password: z.string().max(1024),
    deviceName: z.string().trim().min(1).max(60)
  })
  .strict()
export const syncActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('test'), connection: syncConnectionSchema }),
  z.object({
    action: z.literal('preview'),
    connection: syncConnectionSchema,
    passphrase: passwordSchema
  }),
  z.object({
    action: z.literal('connect'),
    token: z.string().uuid(),
    mode: z.enum(['merge', 'replace'])
  }),
  z.object({ action: z.literal('sync') }),
  z.object({ action: z.literal('pause'), paused: z.boolean() }),
  z.object({ action: z.literal('disconnect') }),
  z.object({
    action: z.literal('resolve'),
    id: z.string().uuid(),
    choice: z.enum(['local', 'remote', 'manual']),
    value: z.string().max(500000).optional()
  }),
  z.object({ action: z.literal('rotate'), passphrase: passwordSchema }),
  z.object({ action: z.literal('recovery'), passphrase: passwordSchema })
])
export type SyncAction = z.infer<typeof syncActionSchema>
export type SyncConnection = z.infer<typeof syncConnectionSchema>
export type SyncConflict = {
  id: string
  key: string
  label: string
  local: unknown
  remote: unknown
  localRelated?: SyncRecords
  remoteRelated?: SyncRecords
}
export type SyncPreview = {
  token: string
  remote: boolean
  localSubscriptions: number
  remoteSubscriptions: number
  conflicts: number
  expiresAt: string
}
export type SyncStatus = {
  connected: boolean
  phase: 'off' | 'idle' | 'syncing' | 'paused' | 'error' | 'conflict' | 'locked'
  lastSuccess: string | null
  error: string | null
  pending: number
  conflicts: SyncConflict[]
  devices: { id: string; name: string; seenAt: string }[]
  preview?: SyncPreview
  recoveryKey?: string
  url?: string
  deviceName?: string
  revision?: string
}
export type SyncRecords = Record<string, Record<string, unknown> | null>
export const syncDocumentSchema = z
  .object({
    format: z.literal('xuding-sync'),
    version: z.literal(1),
    ledgerId: z.string().uuid(),
    revision: z.string().uuid(),
    ancestors: z.array(z.string().uuid()).max(20000),
    records: z.record(
      z
        .string()
        .max(160)
        .regex(
          /^(subscriptions|bills|prices|tracking|changes|budgets|importBatches|usage|decisions|histories|rateHistory):[A-Za-z0-9:.\-]+$/
        ),
      z.record(z.string(), z.unknown()).nullable()
    ),
    devices: z
      .array(
        z
          .object({
            id: z.string().uuid(),
            name: z.string().max(60),
            seenAt: z.string().datetime()
          })
          .strict()
      )
      .max(100)
  })
  .strict()
export type SyncDocument = z.infer<typeof syncDocumentSchema>
