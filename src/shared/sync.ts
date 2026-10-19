import type { Backup } from './model'
import { backupSchema } from './model'
import type { SyncRecords } from './sync-model'

export function stable(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']'
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ':' + stable((value as Record<string, unknown>)[k]))
        .join(',') +
      '}'
    )
  return JSON.stringify(value)
}
export function recordsFromBackup(raw: Backup): SyncRecords {
  if (raw.version !== 4) throw new Error('同步需要新版完整账本。')
  const result: SyncRecords = {}
  const put = (kind: string, rows: any[], key: (r: any) => string) =>
    rows.forEach((r) => (result[kind + ':' + key(r)] = { ...r }))
  put('subscriptions', raw.subscriptions, (r) => r.id)
  put('histories', raw.histories, (r) => r.id + ':' + r.updatedAt)
  put('rateHistory', raw.rateHistory, (r) => r.date)
  put('bills', raw.bills, (r) => (r.manual ? r.id : r.subscriptionId + ':' + r.due))
  put('prices', raw.prices, (r) => r.subscriptionId + ':' + r.effectiveOn)
  put('tracking', raw.tracking, (r) => r.subscriptionId)
  put('changes', raw.changes, (r) => r.id)
  put('budgets', raw.budgets, (r) => r.month)
  put('importBatches', raw.importBatches, (r) => r.id)
  put('usage', raw.usage, (r) => r.subscriptionId + ':' + r.day)
  put('decisions', raw.decisions, (r) => r.subscriptionId)
  return result
}
export function backupFromRecords(records: SyncRecords): Extract<Backup, { version: 4 }> {
  const rows = (kind: string) =>
    Object.entries(records)
      .filter(([k, v]) => k.startsWith(kind + ':') && v)
      .map(([, v]) => v)
  const subscriptions = rows('subscriptions'),
    ids = new Set(subscriptions.map((s) => s!.id))
  const related = (kind: string) => rows(kind).filter((r) => ids.has(r!.subscriptionId))
  // Natural keys avoid duplicate auto-generated records from independently running devices.
  const bills = related('bills'),
    billIds = new Set(bills.map((b) => b!.id))
  return backupSchema.parse({
    format: 'xuding',
    version: 4,
    exportedAt: new Date().toISOString(),
    subscriptions,
    histories: rows('histories').filter((s) => ids.has(s!.id)),
    rateHistory: rows('rateHistory'),
    bills,
    prices: related('prices'),
    tracking: related('tracking'),
    changes: related('changes').filter((c) => !c!.billId || billIds.has(c!.billId)),
    budgets: rows('budgets'),
    budgetReminders: [],
    importBatches: rows('importBatches'),
    usage: related('usage'),
    decisions: related('decisions')
  }) as Extract<Backup, { version: 4 }>
}
export function localRecords(backup: Backup, base: SyncRecords): SyncRecords {
  const result = recordsFromBackup(backup)
  for (const key of Object.keys(base)) if (!(key in result)) result[key] = null
  return result
}
export function mergeRecords(base: SyncRecords, local: SyncRecords, remote: SyncRecords) {
  const records: SyncRecords = {},
    conflicts: { key: string; local: unknown; remote: unknown }[] = []
  for (const key of new Set([
    ...Object.keys(base),
    ...Object.keys(local),
    ...Object.keys(remote)
  ])) {
    const b = base[key] ?? null,
      l = local[key] ?? null,
      r = remote[key] ?? null
    if (stable(l) === stable(r) || stable(r) === stable(b)) {
      records[key] = l
      continue
    }
    if (stable(l) === stable(b)) {
      records[key] = r
      continue
    }
    const kind = key.split(':')[0]
    if (kind === 'histories' || kind === 'rateHistory') {
      records[key] = r ?? l
      continue
    }
    if (kind === 'usage') {
      records[key] = l ?? r
      continue
    }
    if (kind === 'tracking' && l && r) {
      records[key] = {
        ...l,
        startedOn: [String(l.startedOn), String(r.startedOn)].sort()[0],
        through: [String(l.through), String(r.through)].sort().at(-1)
      }
      continue
    }
    if (
      kind === 'prices' &&
      l &&
      r &&
      l.amountMinor === r.amountMinor &&
      l.currency === r.currency
    ) {
      records[key] = l
      continue
    }
    if (
      kind === 'bills' &&
      l &&
      r &&
      l.status === 'pending' &&
      r.status === 'pending' &&
      l.amountMinor === r.amountMinor &&
      l.currency === r.currency
    ) {
      records[key] = l
      continue
    }
    if (l && r && b && (kind === 'subscriptions' || kind === 'decisions')) {
      const merged: Record<string, unknown> = {},
        bad: string[] = []
      const ignored = new Set(['updatedAt'])
      const group =
        kind === 'subscriptions'
          ? [
              'amountMinor',
              'currency',
              'cycle',
              'interval',
              'anchorDate',
              'autoRenew',
              'status',
              'accessEndsOn'
            ]
          : ['cancellation', 'requestedOn', 'confirmedOn', 'endsOn', 'autoArchive']
      const changed = (x: Record<string, unknown>) =>
        group.some((f) => stable(x[f]) !== stable(b[f]))
      if (changed(l) && changed(r) && group.some((f) => stable(l[f]) !== stable(r[f])))
        bad.push('group')
      for (const field of new Set([...Object.keys(b), ...Object.keys(l), ...Object.keys(r)])) {
        if (ignored.has(field)) {
          merged[field] = new Date().toISOString()
          continue
        }
        if (stable(l[field]) === stable(r[field]) || stable(r[field]) === stable(b[field]))
          merged[field] = l[field]
        else if (stable(l[field]) === stable(b[field])) merged[field] = r[field]
        else bad.push(field)
      }
      if (!bad.length) {
        records[key] = Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== undefined))
        continue
      }
    }
    conflicts.push({ key, local: l, remote: r })
    records[key] = l
  }
  // Delete versus an edit in a child record must retain both sides for a decision.
  for (const [key, value] of Object.entries(records))
    if (key.startsWith('subscriptions:') && !value) {
      const id = key.slice(14)
      const children = Object.keys(records).filter((k) => records[k]?.subscriptionId === id)
      if (
        children.some(
          (k) => stable(local[k]) !== stable(base[k]) || stable(remote[k]) !== stable(base[k])
        )
      ) {
        if (!conflicts.some((c) => c.key === key))
          conflicts.push({ key, local: local[key] ?? null, remote: remote[key] ?? null })
        records[key] = local[key] ?? remote[key] ?? null
      }
    }
  return { records, conflicts }
}
