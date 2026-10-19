import { z } from 'zod'

export const currencies = ['CNY', 'USD', 'EUR', 'HKD'] as const
export type Currency = (typeof currencies)[number]
export function isDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '1970-01-01' || value > '2100-12-31')
    return false
  const date = new Date(value + 'T00:00:00Z')
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}
export const dateSchema = z.string().refine(isDate, '请输入有效日期（1970—2100 年）')

export const categories = [
  '效率工具',
  '影音娱乐',
  '云存储',
  '学习成长',
  '生活服务',
  '其他'
] as const
