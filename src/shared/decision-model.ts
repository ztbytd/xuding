import { z } from 'zod'
import { dateSchema } from './primitives'

export const usageSchema = z
  .object({
    id: z.string().uuid(),
    subscriptionId: z.string().uuid(),
    day: dateSchema,
    createdAt: z.string().datetime()
  })
  .strict()
export const decisionInputSchema = z
  .object({
    subscriptionId: z.string().uuid(),
    frequency: z.enum(['unknown', 'often', 'sometimes', 'rarely']).default('unknown'),
    decision: z.enum(['review', 'keep', 'consider', 'end']).default('review'),
    reason: z.string().max(2000).default(''),
    reviewOn: dateSchema.optional(),
    idleDays: z.union([z.literal(30), z.literal(60), z.literal(90)]).default(30),
    cancellation: z.enum(['none', 'requested', 'confirmed']).default('none'),
    cancellationUrl: z
      .string()
      .max(2048)
      .default('')
      .refine((v) => {
        if (!v) return true
        try {
          const u = new URL(v)
          return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password
        } catch {
          return false
        }
      }, '请输入有效的取消网址'),
    requestedOn: dateSchema.optional(),
    confirmedOn: dateSchema.optional(),
    endsOn: dateSchema.optional(),
    cancellationNotes: z.string().max(2000).default(''),
    autoArchive: z.boolean().default(false)
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.autoArchive && (!v.endsOn || v.cancellation !== 'confirmed'))
      ctx.addIssue({ code: 'custom', message: '自动归档需要确认停止续费并填写权益结束日期。' })
    if (v.requestedOn && v.confirmedOn && v.confirmedOn < v.requestedOn)
      ctx.addIssue({ code: 'custom', message: '确认日期不能早于申请日期。' })
  })
export const decisionSchema = decisionInputSchema.safeExtend({ updatedAt: z.string().datetime() })
export type Usage = z.infer<typeof usageSchema>
export type DecisionInput = z.infer<typeof decisionInputSchema>
export type Decision = z.infer<typeof decisionSchema>
export const frequencyNames = {
  unknown: '尚未评估',
  often: '经常使用',
  sometimes: '偶尔使用',
  rarely: '很少使用'
}
export const decisionNames = {
  review: '待评估',
  keep: '继续保留',
  consider: '考虑取消',
  end: '到期处理'
}
