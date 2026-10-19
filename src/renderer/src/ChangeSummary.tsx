import { useState } from 'react'
import { Button } from 'antd'
import type { Snapshot, Currency } from '../../shared/model'
import { formatMoney } from '../../shared/billing'
import { spendingChanges } from '../../shared/spending-changes'
import { HelpTip } from './controls'
export function ChangeSummary({
  snapshot,
  currency,
  today,
  compact = false,
  onOpen
}: {
  snapshot: Snapshot
  currency: Currency
  today: string
  compact?: boolean
  onOpen: (id: string) => void
}) {
  const [all, setAll] = useState(false),
    result = spendingChanges(snapshot, currency, today),
    money = (n: number | null) =>
      n === null ? '暂无可比数据' : `${n > 0 ? '+' : ''}${formatMoney(Math.round(n), currency)}`
  if (compact && !result.rows.length && !result.unknown.length) return null
  return (
    <section className="panel spaced change-summary">
      <div className="panel-head">
        <div className="panel-title">
          <h2>支出为什么变化</h2>
          <HelpTip label="支出变化">
            当前月均费用与上月末对比，两期统一使用当前参考汇率；汇率影响单独列出。取消后减少的是未来预计费用，已支付账单仍保留。没有历史快照时不推断之前状态。
          </HelpTip>
        </div>
        <small className="muted">相比 {result.baseline}</small>
      </div>
      <div className="change-totals">
        <span>
          月均费用变化<strong>{money(result.delta)}</strong>
        </span>
        {!compact && (
          <>
            <span>
              本月与上月已记录支付之差<strong>{money(result.actualDelta)}</strong>
            </span>
            <span>
              汇率影响<strong>{money(result.exchange)}</strong>
            </span>
          </>
        )}
      </div>
      {result.rows.slice(0, all ? undefined : compact ? 3 : 6).map((r) => (
        <button className="change-item" key={r.id} onClick={() => onOpen(r.id)}>
          <span>
            <strong>{r.name}</strong>
            <small>{r.kind}</small>
          </span>
          <span>{money(r.amount)}</span>
        </button>
      ))}
      {result.unknown.length > 0 && (
        <p className="footnote">
          {result.unknown.length} 项缺少历史状态或折算汇率，完整变化暂不可比。
        </p>
      )}
      {result.rows.length > (compact ? 3 : 6) && (
        <Button type="link" onClick={() => setAll(!all)}>
          {all ? '收起' : '查看全部变化'}
        </Button>
      )}
    </section>
  )
}
