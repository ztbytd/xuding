import { z } from 'zod'
import { passwordSchema } from './operations-model'
export const securityOptionsSchema = z
  .object({
    idleMinutes: z
      .union([z.literal(0), z.literal(5), z.literal(15), z.literal(30), z.literal(60)])
      .default(15),
    lockOnSuspend: z.boolean().default(true),
    lockOnScreen: z.boolean().default(true),
    remember: z.boolean().default(false),
    showNotificationDetails: z.boolean().default(false)
  })
  .strict()
export type SecurityOptions = z.infer<typeof securityOptionsSchema>
export const securityActionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('prepare'),
    password: passwordSchema,
    options: securityOptionsSchema
  }),
  z.object({ action: z.literal('enable'), confirmation: z.string().max(100) }),
  z.object({
    action: z.literal('unlock'),
    password: z.string().min(1).max(256),
    recovery: z.boolean().default(false)
  }),
  z.object({ action: z.literal('lock') }),
  z.object({ action: z.literal('options'), options: securityOptionsSchema }),
  z.object({
    action: z.literal('password'),
    current: z.string().max(256),
    password: passwordSchema,
    options: securityOptionsSchema.optional()
  }),
  z.object({ action: z.literal('recovery'), password: z.string().max(256) }),
  z.object({ action: z.literal('rekey'), password: z.string().max(256) }),
  z.object({ action: z.literal('saveRecovery'), key: z.string().regex(/^[A-F0-9]{64}$/) }),
  z.object({ action: z.literal('legacy'), operation: z.enum(['list', 'convert', 'delete']) })
])
export type SecurityAction = z.infer<typeof securityActionSchema>
export type SecurityStatus = {
  busy?: boolean
  enabled: boolean
  locked: boolean
  options: SecurityOptions
  recoveryKey?: string
  prepared?: boolean
  legacy?: { id: string; size: number }[]
}
