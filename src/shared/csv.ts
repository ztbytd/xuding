import { fieldLabels, subscriptionFields, billFields } from './csv-model'
import type { CsvField, CsvKind, CsvExport } from './csv-model'
import type { Subscription } from './model'
import type { BillRecord } from './ledger-model'
import { paymentMinor } from './ledger'
import { isDate } from './primitives'

export function parseCsv(text: string): { headers: string[]; rows: string[][] } {
  text = text.replace(/^\uFEFF/, '')
  if (text.includes('\0')) throw new Error('文件包含无效字符，请检查编码。')
  let first = '',
    inQuotes = false
  for (const c of text) {
    if (c === '"') inQuotes = !inQuotes
    if (!inQuotes && (c === '\r' || c === '\n')) break
    first += c
  }
  const counts = [',', ';', '\t']
      .map((delimiter) => {
        let count = 1,
          quoted = false
        for (let i = 0; i < first.length; i++) {
          if (first[i] === '"') {
            if (quoted && first[i + 1] === '"') {
              i++
              continue
            }
            quoted = !quoted
          } else if (!quoted && first[i] === delimiter) count++
        }
        return [delimiter, count] as const
      })
      .sort((a, b) => b[1] - a[1]),
    delimiter = counts[0][0]
  const rows: string[][] = [],
    row: string[] = []
  let field = '',
    quoted = false,
    closed = false
  function cell() {
    if (field.length > 10000) throw new Error('单元格内容超过 10,000 字符。')
    row.push(field)
    field = ''
    closed = false
    if (row.length > 100) throw new Error('CSV 最多支持 100 列。')
  }
  function line() {
    cell()
    if (row.some((v) => v.trim() !== '')) rows.push([...row])
    row.length = 0
    if (rows.length > 10001) throw new Error('单次导入最多 10,000 行。')
  }
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else {
          quoted = false
          closed = true
        }
      } else field += c
      continue
    }
    if (c === '"') {
      if (field || closed) throw new Error('CSV 引号格式无效。')
      quoted = true
    } else if (c === delimiter) cell()
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      line()
    } else {
      if (closed) {
        if (c === ' ' || c === '\t') continue
        throw new Error('CSV 引号后存在多余字符。')
      }
      field += c
    }
  }
  if (quoted) throw new Error('CSV 引号未闭合。')
  if (field || row.length || closed) line()
  const headers = rows.shift()?.map((h) => h.trim()) ?? []
  if (!headers.length || !rows.length) throw new Error('文件需要包含标题行和至少一行数据。')
  if (rows.some((r) => r.length > headers.length))
    throw new Error('数据列数超过标题列数，请检查分隔符和引号。')
  return { headers, rows: rows.map((r) => headers.map((_, i) => r[i] ?? '')) }
}
const aliases: Partial<Record<CsvField, string[]>> = {
  subscriptionId: ['subscription_id', 'subscriptionid', '订阅id'],
  name: ['name', 'subscription', 'subscription_name', '名称', '订阅', '订阅名称', '服务名称'],
  amount: ['amount', 'price', 'amount_minor_display', '金额', '价格', '预计金额', '单期金额'],
  currency: ['currency', '币种', '货币', '订阅币种', '预计币种'],
  category: ['category', '分类'],
  cycle: ['cycle', '周期', '周期单位'],
  interval: ['interval', '周期间隔', '间隔'],
  anchorDate: ['anchor_date', 'anchordate', '首次扣款日', '计费基准日'],
  status: ['status', '状态', '订阅状态', '账单状态'],
  autoRenew: ['auto_renew', 'autorenew', '自动续费'],
  accessEndsOn: ['access_ends_on', 'accessendson', '权益到期日'],
  website: ['website', '网址', '服务商网址'],
  notes: ['notes', '备注'],
  effectiveOn: ['effective_on', '价格生效日期'],
  billId: ['bill_id', 'billid', '账单id'],
  due: ['due', 'due_date', '应扣日期', '扣款日'],
  paymentAmount: ['payment_amount', 'paid_amount', '实际金额', '实际支付金额', '实际扣款金额'],
  paymentCurrency: ['payment_currency', 'paid_currency', '支付币种', '实际币种'],
  paidOn: ['paid_on', 'payment_date', '支付日期', '实际支付日期'],
  convertedAmount: ['converted_amount', '历史折算金额', '折算金额'],
  convertedCurrency: [
    'converted_currency',
    'display_currency',
    '历史折算币种',
    '折算币种',
    '统计币种'
  ],
  fxDate: ['fx_date', '汇率参考日期'],
  manual: ['manual', '手动补录']
}
export function autoMapping(headers: string[], kind: CsvKind): Partial<Record<CsvField, number>> {
  const normalize = (s: string) => s.toLowerCase().replace(/[\s_-]/g, '')
  const fields = kind === 'subscriptions' ? subscriptionFields : billFields,
    result: Partial<Record<CsvField, number>> = {}
  for (const f of fields) {
    const index = headers.findIndex((h) =>
      [fieldLabels[f], ...(aliases[f] ?? [])].some((a) => normalize(h) === normalize(a))
    )
    if (index >= 0) result[f] = index
  }
  return result
}
export function csvDate(value: string, order: 'YMD' | 'DMY' | 'MDY'): string {
  const clean = value.trim()
  let match = clean.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/),
    parts: string[]
  if (match) parts = [match[1], match[2], match[3]]
  else {
    match = clean.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/)
    if (!match || order === 'YMD')
      throw new Error('日期须为 YYYY-MM-DD；日/月有歧义时请选择日期顺序。')
    parts = order === 'DMY' ? [match[3], match[2], match[1]] : [match[3], match[1], match[2]]
  }
  const result = `${parts[0]}-${parts[1].padStart(2, '0')}-${parts[2].padStart(2, '0')}`
  if (!isDate(result)) throw new Error(`无效日期：${value}`)
  return result
}
// Prefix risky spreadsheet text, including leading control characters. Quote every field.
export function serializeCsv(rows: (string | number | boolean | null | undefined)[][]): string {
  return (
    '\uFEFF' +
    rows
      .map((row) =>
        row
          .map((value) => {
            let text = String(value ?? '')
            if (/^[\s\u0000-\u001f]*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text)) text = "'" + text
            return '"' + text.replaceAll('"', '""') + '"'
          })
          .join(',')
      )
      .join('\r\n') +
    '\r\n'
  )
}
export function exportCsv(
  input: CsvExport,
  subscriptions: Subscription[],
  bills: BillRecord[]
): string {
  const fields = input.kind === 'subscriptions' ? subscriptionFields : billFields
  const selected = new Set(input.ids)
  const names = new Map(subscriptions.map((s) => [s.id, s.name]))
  const rows: Record<string, string>[] = []
  if (input.template) {
    rows.push(
      input.kind === 'subscriptions'
        ? {
            name: '示例订阅',
            amount: '19.99',
            currency: 'CNY',
            category: '效率工具',
            cycle: 'month',
            interval: '1',
            anchorDate: '2026-10-19',
            status: 'active',
            autoRenew: 'true'
          }
        : {
            name: '请填写已有订阅名称',
            due: '2026-10-19',
            amount: '19.99',
            currency: 'CNY',
            status: 'paid',
            paymentAmount: '19.99',
            paymentCurrency: 'CNY',
            paidOn: '2026-10-19',
            category: '效率工具'
          }
    )
  } else if (input.kind === 'subscriptions') {
    for (const s of subscriptions.filter((s) => !input.ids || selected.has(s.id)))
      rows.push({
        subscriptionId: s.id,
        name: s.name,
        category: s.category,
        amount: (s.amountMinor / 100).toFixed(2),
        currency: s.currency,
        cycle: s.cycle,
        interval: String(s.interval),
        anchorDate: s.anchorDate,
        status: s.status,
        autoRenew: String(s.autoRenew),
        accessEndsOn: s.accessEndsOn ?? '',
        website: s.website,
        notes: s.notes,
        effectiveOn: ''
      })
  } else {
    for (const b of bills.filter((b) => !input.ids || selected.has(b.id))) {
      const converted = b.payment ? paymentMinor(b, input.currency) : null
      rows.push({
        billId: b.id,
        subscriptionId: b.subscriptionId,
        name: names.get(b.subscriptionId) ?? '',
        due: b.due,
        amount: (b.amountMinor / 100).toFixed(2),
        currency: b.currency,
        status: b.status,
        paymentAmount: b.payment ? (b.payment.amountMinor / 100).toFixed(2) : '',
        paymentCurrency: b.payment?.currency ?? '',
        paidOn: b.payment?.paidOn ?? '',
        category: b.category,
        convertedAmount: converted === null ? '' : (converted / 100).toFixed(2),
        convertedCurrency: converted === null ? '' : input.currency,
        fxDate:
          b.conversion?.source === 'manual' ? (b.conversion.date ?? '') : (b.rates?.date ?? ''),
        manual: String(b.manual)
      })
    }
  }
  return serializeCsv([
    fields.map((f) => fieldLabels[f]),
    ...rows.map((row) => fields.map((f) => row[f] ?? ''))
  ])
}
