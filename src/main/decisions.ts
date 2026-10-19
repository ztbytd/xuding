import { randomUUID } from 'node:crypto'
import type { DatabaseConnection } from './sqlite'
import {
  decisionInputSchema,
  decisionSchema,
  usageSchema,
  decisionNames
} from '../shared/decision-model'
import type { DecisionInput, Decision, Usage } from '../shared/decision-model'
import type { Subscription, SubscriptionInput } from '../shared/model'
import { localDate } from '../shared/billing'

export class DecisionStore {
  constructor(
    private db: DatabaseConnection,
    private subscriptions: () => Subscription[],
    private save: (input: SubscriptionInput, id: string) => Subscription,
    private now = () => new Date()
  ) {}
  list(): Decision[] {
    return this.db
      .prepare('SELECT document FROM decisions')
      .all()
      .map((r) => decisionSchema.parse(JSON.parse(r.document)))
  }
  usage(): Usage[] {
    return this.db
      .prepare('SELECT document FROM usage_records ORDER BY day DESC')
      .all()
      .map((r) => usageSchema.parse(JSON.parse(r.document)))
  }
  record(id: string, day: string, remove = false): void {
    if (!this.subscriptions().some((s) => s.id === id)) throw new Error('订阅不存在。')
    if (day > localDate(this.now())) throw new Error('不能记录未来的使用情况。')
    if (remove)
      this.db.prepare('DELETE FROM usage_records WHERE subscription_id=? AND day=?').run(id, day)
    else {
      const u = usageSchema.parse({
        id: randomUUID(),
        subscriptionId: id,
        day,
        createdAt: this.now().toISOString()
      })
      this.db
        .prepare('INSERT OR IGNORE INTO usage_records VALUES(?,?,?,?)')
        .run(u.id, id, day, JSON.stringify(u))
    }
    this.db.prepare('INSERT INTO ledger_events DEFAULT VALUES').run()
  }
  update(raw: DecisionInput): Decision {
    const input = decisionInputSchema.parse(raw),
      s = this.subscriptions().find((s) => s.id === input.subscriptionId)
    if (!s) throw new Error('订阅不存在。')
    const today = localDate(this.now())
    if ([input.requestedOn, input.confirmedOn].some((d) => d && d > today))
      throw new Error('申请和确认日期不能晚于今天。')
    const previous = this.list().find((d) => d.subscriptionId === s.id)
    // A savepoint keeps cancellation state and the subscription rule atomic, including rollback.
    this.db.exec('SAVEPOINT decision_update')
    try {
      if (input.cancellation === 'confirmed') {
        const { id, createdAt, updatedAt, ...value } = s
        // Repository.save starts a transaction, so commit the subscription here using existing snapshots.
        const item = {
          ...s,
          autoRenew: false,
          accessEndsOn: input.endsOn ?? s.accessEndsOn,
          updatedAt: this.now().toISOString()
        }
        this.db
          .prepare('UPDATE subscriptions SET document=?,updated_at=? WHERE id=?')
          .run(JSON.stringify(item), item.updatedAt, s.id)
        this.db
          .prepare(
            'INSERT INTO subscription_changes(subscription_id,document,changed_at) VALUES(?,?,?)'
          )
          .run(s.id, JSON.stringify(item), item.updatedAt)
      }
      const result = decisionSchema.parse({
        ...input,
        updatedAt: new Date(
          Math.max(this.now().getTime(), previous ? Date.parse(previous.updatedAt) + 1 : 0)
        ).toISOString()
      })
      this.db
        .prepare(
          'INSERT INTO decisions VALUES(?,?) ON CONFLICT(subscription_id) DO UPDATE SET document=excluded.document'
        )
        .run(s.id, JSON.stringify(result))
      this.db.prepare('INSERT INTO ledger_events DEFAULT VALUES').run()
      const eventId = randomUUID(),
        label = `续费决策：${decisionNames[result.decision]}；${result.cancellation === 'confirmed' ? '已确认停止续费' : result.cancellation === 'requested' ? '已提交取消申请' : '尚未申请取消'}`
      this.db
        .prepare('INSERT INTO ledger_changes VALUES(?,?,?)')
        .run(
          eventId,
          s.id,
          JSON.stringify({ id: eventId, subscriptionId: s.id, label, changedAt: result.updatedAt })
        )
      this.db.exec('RELEASE decision_update')
      return result
    } catch (e) {
      this.db.exec('ROLLBACK TO decision_update; RELEASE decision_update')
      throw e
    }
  }
  archiveDue(): number {
    let count = 0
    for (const d of this.list())
      if (
        d.autoArchive &&
        d.cancellation === 'confirmed' &&
        d.endsOn &&
        d.endsOn < localDate(this.now())
      ) {
        const s = this.subscriptions().find(
          (s) => s.id === d.subscriptionId && s.status !== 'archived' && !s.autoRenew
        )
        if (s) {
          const { id, createdAt, updatedAt, ...input } = s
          this.save({ ...input, status: 'archived' }, id)
          count++
        }
      }
    return count
  }
  import(data: { usage: Usage[]; decisions: Decision[] }): void {
    for (const u of data.usage)
      this.db
        .prepare(
          'INSERT INTO usage_records VALUES(?,?,?,?) ON CONFLICT(subscription_id,day) DO UPDATE SET document=excluded.document'
        )
        .run(u.id, u.subscriptionId, u.day, JSON.stringify(u))
    for (const d of data.decisions)
      this.db
        .prepare(
          'INSERT INTO decisions VALUES(?,?) ON CONFLICT(subscription_id) DO UPDATE SET document=excluded.document'
        )
        .run(d.subscriptionId, JSON.stringify(d))
  }
}
