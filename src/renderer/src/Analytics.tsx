import { useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { Button, DatePicker, Input, InputNumber, Modal, Progress, Switch, Table } from 'antd'
import dayjs from 'dayjs'
import { ArrowRight, CalendarDays, Download, Upload } from 'lucide-react'
import type { Currency, Snapshot } from '../../shared/model'
import { categories, currencies } from '../../shared/model'
import type { Budget } from '../../shared/analytics-model'
import { budgetInputSchema } from '../../shared/analytics-model'
import { actualTotals, billStatus, paymentMinor } from '../../shared/ledger'
import {
  analysisMonths,
  budgetProgress,
  monthEnd,
  monthlyProjection,
  shiftMonth,
  spendingRanking
} from '../../shared/analytics'
import { formatMoney, localDate, parseAmount } from '../../shared/billing'
import type { BillRecord } from '../../shared/ledger-model'
import { HelpTip, SelectField } from './controls'

export function AnalysisPanel({
  title,
  extra,
  children,
  className = '',
  id
}: {
  title: string
  extra?: ReactNode
  children: ReactNode
  className?: string
  id?: string
}) {
  return (
    <section id={id} className={`panel ${className}`}>
      <div className="panel-head">
        <h2>{title}</h2>
        {extra}
      </div>
      {children}
    </section>
  )
}
export function BudgetEditor({
  month,
  budget,
  onClose,
  onSaved
}: {
  month: string
  budget?: Budget
  onClose: () => void
  onSaved: () => Promise<unknown>
}) {
  const [enabled, setEnabled] = useState(budget?.enabled ?? true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  const previous = budget
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    const data = new FormData(event.currentTarget),
      amountMinor = parseAmount(String(data.get('total')))
    const allocations = categories.flatMap((category) => {
      const value = String(data.get('allocation:' + category) || '')
      return value ? [{ category, amountMinor: parseAmount(value) }] : []
    })
    const result = budgetInputSchema.safeParse({
      month,
      enabled,
      currency: data.get('budgetCurrency'),
      amountMinor,
      threshold: Number(data.get('threshold')),
      allocations
    })
    if (!result.success) {
      setError(
        amountMinor === null
          ? '请输入最多两位小数的有效预算金额。'
          : result.error.issues.map((i) => i.message).join('；')
      )
      return
    }
    setBusy(true)
    setError('')
    try {
      const r = await window.desktop.saveBudget(result.data)
      if (!r.ok) throw new Error(r.error)
      await onSaved()
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : '预算保存失败。')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal
      open
      title={`${month} 月度预算`}
      onCancel={() => !busy && onClose()}
      footer={null}
      maskClosable={false}
      width={560}
    >
      <form className="ledger-form" onSubmit={(event) => void submit(event)}>
        <div className="budget-enabled">
          <span>启用本月预算</span>
          <Switch
            aria-label="启用本月预算"
            checked={enabled}
            onChange={setEnabled}
            disabled={busy}
          />
        </div>
        <div className="form-grid">
          <label>
            总预算
            <InputNumber<string>
              name="total"
              aria-label="总预算"
              stringMode
              controls={false}
              changeOnBlur={false}
              required
              min="0.01"
              max="9999999.99"
              defaultValue={previous ? (previous.amountMinor / 100).toFixed(2) : '500.00'}
              disabled={busy}
            />
          </label>
          <label>
            预算币种
            <SelectField
              label="预算币种"
              name="budgetCurrency"
              defaultValue={previous?.currency ?? 'CNY'}
              options={currencies.map((c) => ({ value: c, label: c }))}
              disabled={busy}
            />
          </label>
          <label className="full">
            提前提醒阈值（%）
            <InputNumber
              name="threshold"
              aria-label="预算提醒阈值"
              controls={false}
              changeOnBlur={false}
              min={1}
              max={99}
              required
              defaultValue={previous?.threshold ?? 80}
              disabled={busy}
            />
          </label>
        </div>
        <div className="budget-allocation-title">
          <strong>分类分配</strong>
          <span className="small muted">可留空，分类合计须不超过总预算</span>
        </div>
        <div className="form-grid">
          {categories.map((category) => (
            <label key={category}>
              {category}
              <InputNumber<string>
                aria-label={`${category}预算`}
                name={'allocation:' + category}
                stringMode
                controls={false}
                changeOnBlur={false}
                min="0"
                max="9999999.99"
                placeholder="不单独分配"
                defaultValue={
                  previous?.allocations.find((a) => a.category === category)
                    ? (
                        previous.allocations.find((a) => a.category === category)!.amountMinor / 100
                      ).toFixed(2)
                    : undefined
                }
                disabled={busy}
              />
            </label>
          ))}
        </div>
        <p className="footnote">
          预算币种独立保存，后续月份默认沿用。调整本月不改变已保存的其他月份；关闭后保留历史预算。桌面预算通知可在设置中开启。
        </p>
        {error && (
          <div role="alert" className="error-banner">
            {error}
          </div>
        )}
        <div className="form-actions">
          <Button onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button htmlType="submit" type="primary" loading={busy}>
            保存预算
          </Button>
        </div>
      </form>
    </Modal>
  )
}
export function BudgetStrip({
  snapshot,
  today,
  onOpen
}: {
  snapshot: Snapshot
  today: string
  onOpen: () => void
}) {
  const budget = snapshot.budgets.find((b) => b.month === today.slice(0, 7))
  if (!budget?.enabled)
    return (
      <button className="budget-invite" onClick={onOpen}>
        {budget ? '本月预算已关闭 · 管理预算' : '设置月度预算，了解本月剩余额度'}
        <ArrowRight size={14} />
      </button>
    )
  const projection = monthlyProjection(
    snapshot.subscriptions,
    snapshot.bills,
    snapshot.prices,
    budget.currency,
    today,
    snapshot.exchangeRates
  )
  const progress = budgetProgress(budget, snapshot.bills, projection),
    money = (v: number | null) => (v === null ? '—' : formatMoney(v, budget.currency))
  return (
    <button
      className={`budget-strip${progress.ratio !== null && progress.ratio >= 1 ? ' budget-over' : ''}`}
      onClick={onOpen}
      aria-label="查看本月预算分析"
    >
      <div className="budget-strip-head">
        <strong>本月预算 {money(budget.amountMinor)}</strong>
        <span>
          已支付 {money(progress.actual.total)} · 剩余 {money(progress.remaining)}
          <ArrowRight size={14} />
        </span>
      </div>
      <Progress
        percent={progress.ratio === null ? 0 : Math.min(100, Math.round(progress.ratio * 100))}
        showInfo={false}
        strokeColor="var(--brand)"
        size="small"
      />
      <small>
        {progress.actual.total === null
          ? '实际支出有未折算账单，预算判断暂不可用。'
          : progress.ratio! >= 1
            ? `实际已超出 ${money(Math.max(0, -progress.remaining!))}。`
            : progress.ratio! >= budget.threshold / 100
              ? `实际已使用 ${Math.round(progress.ratio! * 100)}%，接近预算。`
              : '预算按独立币种统计。'}{' '}
        {projection.total === null
          ? '本月预测有缺少汇率的项目。'
          : `预计本月 ${money(projection.total)}${projection.total > budget.amountMinor ? `，可能超出 ${money(projection.total - budget.amountMinor)}` : `，预计结余 ${money(budget.amountMinor - projection.total)}`}。`}
      </small>
    </button>
  )
}
export function AnalyticsPage({
  snapshot,
  month,
  onMonth,
  currency,
  onCurrency,
  onOpen,
  onEdit,
  onStatus,
  onImport,
  onExport,
  onBudget,
  today
}: {
  snapshot: Snapshot
  month: string
  onMonth: (month: string) => void
  currency: Currency
  onCurrency: (currency: Currency) => void
  onOpen: (id: string) => void
  onEdit: (bill: BillRecord) => void
  onStatus: (bill: BillRecord, status: 'pending' | 'skipped') => Promise<void>
  onImport: () => void
  onExport: (subscriptionIds: string[], billIds: string[]) => void
  onBudget: (month: string) => void
  today: string
}) {
  const [category, setCategory] = useState('all'),
    [subscriptionId, setSubscriptionId] = useState('all'),
    [status, setStatus] = useState('paid'),
    [query, setQuery] = useState(''),
    [view, setView] = useState('month'),
    [busy, setBusy] = useState(false)
  const { bills, subscriptions, prices, exchangeRates } = snapshot
  const actual = actualTotals(bills, currency, month + '-01', monthEnd(month)),
    projection =
      month === today.slice(0, 7)
        ? monthlyProjection(subscriptions, bills, prices, currency, today, exchangeRates)
        : null
  const budget = snapshot.budgets.find((b) => b.month === month),
    progress = budget?.enabled
      ? budgetProgress(
          budget,
          bills,
          month === today.slice(0, 7)
            ? monthlyProjection(subscriptions, bills, prices, budget.currency, today, exchangeRates)
            : undefined
        )
      : null
  const previous = actualTotals(
    bills,
    currency,
    shiftMonth(month, -1) + '-01',
    monthEnd(shiftMonth(month, -1))
  )
  const change =
    actual.count &&
    previous.count &&
    actual.total !== null &&
    previous.total !== null &&
    previous.total > 0
      ? ((actual.total - previous.total) / previous.total) * 100
      : null
  const months = analysisMonths(bills, currency, month),
    max = Math.max(1, ...months.map((m) => m.total ?? 0)),
    ranking = spendingRanking(bills, subscriptions, currency, month)
  const visibleSubs = subscriptions.filter(
    (s) =>
      (category === 'all' || s.category === category) &&
      (subscriptionId === 'all' || s.id === subscriptionId) &&
      s.name.toLowerCase().includes(query.toLowerCase())
  )
  const visible = bills.filter((b) => {
    const s = subscriptions.find((s) => s.id === b.subscriptionId)
    return (
      (b.status === 'paid' ? b.payment?.paidOn.startsWith(month) : b.due.startsWith(month)) &&
      (category === 'all' || b.category === category) &&
      (subscriptionId === 'all' || b.subscriptionId === subscriptionId) &&
      (status === 'all' || b.status === status) &&
      !!s?.name.toLowerCase().includes(query.toLowerCase())
    )
  })
  const money = (v: number | null, c = currency) => (v === null ? '—' : formatMoney(v, c))
  const drill = () =>
    requestAnimationFrame(() =>
      document.getElementById('analysis-bills')?.scrollIntoView({
        behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth',
        block: 'start'
      })
    )
  const reset = () => {
    setQuery('')
    setCategory('all')
    setSubscriptionId('all')
    setStatus('paid')
    setView('month')
  }
  const focusCategory = (c: string) => {
    setCategory(c)
    setSubscriptionId('all')
    setStatus('paid')
    setView('month')
    drill()
  }
  async function update(bill: BillRecord, state: 'pending' | 'skipped') {
    setBusy(true)
    try {
      await onStatus(bill, state)
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <header className="page-head">
        <div>
          <h1>支出分析</h1>
          <p>查看预算、实际支出与每一笔明细</p>
        </div>
        <div className="page-actions">
          <Button onClick={() => onBudget(month)}>预算设置</Button>
          <Button icon={<Upload size={14} />} onClick={onImport}>
            导入 CSV
          </Button>
          <Button
            icon={<Download size={14} />}
            onClick={() =>
              onExport(
                visibleSubs.map((s) => s.id),
                visible.map((b) => b.id)
              )
            }
          >
            导出
          </Button>
        </div>
      </header>
      <div className="analysis-toolbar">
        <DatePicker
          picker="month"
          aria-label="分析月份"
          value={dayjs(month + '-01')}
          format="YYYY年M月"
          allowClear={false}
          minDate={dayjs('1970-01-01')}
          maxDate={dayjs(today)}
          suffixIcon={<CalendarDays size={16} />}
          onChange={(value) => {
            if (value) {
              onMonth(value.format('YYYY-MM'))
              reset()
            }
          }}
        />
        <label className="inline-field">
          <span>统计币种</span>
          <SelectField
            label="分析统计币种"
            value={currency}
            onChange={(v) => onCurrency(v as Currency)}
            options={currencies.map((c) => ({ value: c, label: c }))}
          />
        </label>
        <span className="small muted">按支付日期统计 · 预计金额仅用于当前月份</span>
      </div>
      <div className="stats analysis-summary">
        <button
          className="stat featured"
          onClick={() => {
            reset()
            setStatus('paid')
            drill()
          }}
        >
          <div className="stat-heading">
            <span>实际支出</span>
            <small>{actual.count} 笔已支付</small>
          </div>
          <strong>{money(actual.total)}</strong>
          <small className="muted">
            {change === null
              ? '上月与本月均有记录时可比较'
              : `较上月已记录支出${change >= 0 ? '增加' : '减少'} ${Math.abs(change).toFixed(1)}%`}
          </small>
        </button>
        <button className="stat" disabled={!projection} onClick={() => setView('projection')}>
          <div className="stat-heading">
            <span>{projection ? '本月预测' : '历史月份'}</span>
            <small>{projection ? '点击查看组成' : '仅统计实际支出'}</small>
          </div>
          <strong>{projection ? money(projection.total) : '—'}</strong>
          <small className="muted">
            {projection
              ? `含待确认 ${projection.pending.length} 笔、未来预计 ${projection.future.length} 笔`
              : '历史预测不倒推'}
          </small>
        </button>
        <button className="stat" onClick={() => onBudget(month)}>
          <div className="stat-heading">
            <span>预算剩余</span>
            <small>{budget?.enabled ? budget.currency : '设置月度预算'}</small>
          </div>
          <strong>{progress ? money(progress.remaining, budget!.currency) : '—'}</strong>
          <small className="muted">
            {progress
              ? `额度 ${money(budget!.amountMinor, budget!.currency)}`
              : '预算按月份独立保存'}
          </small>
        </button>
      </div>
      {projection && projection.missing > 0 && (
        <div role="status" className="exchange-notice">
          本月预测有 {projection.missing} 项缺少折算信息，已知金额 {money(projection.knownTotal)}
          ，完整预测与超预算判断暂不可用。
        </div>
      )}
      {actual.missing > 0 && (
        <div role="status" className="exchange-notice">
          有 {actual.missing} 笔支付缺少该币种的历史折算信息。已知金额 {money(actual.knownTotal)}
          ，完整实际合计和比较暂不可用。
        </div>
      )}
      {progress && (
        <AnalysisPanel
          title={`${month} 预算进度`}
          extra={<span className="small muted">固定币种 {budget!.currency}</span>}
          className="spaced"
        >
          <div className="budget-progress-head">
            <span>
              已支付 {money(progress.actual.total, budget!.currency)} /{' '}
              {money(budget!.amountMinor, budget!.currency)}
            </span>
            <strong>
              {progress.ratio === null ? '待折算' : `${Math.round(progress.ratio * 100)}%`}
            </strong>
          </div>
          <Progress
            percent={progress.ratio === null ? 0 : Math.min(100, Math.round(progress.ratio * 100))}
            showInfo={false}
            strokeColor={
              progress.ratio !== null && progress.ratio >= 1 ? 'var(--error)' : 'var(--brand)'
            }
          />
          <div className="allocation-progress">
            {progress.allocations.map((a) => (
              <button key={a.category} onClick={() => focusCategory(a.category)}>
                <span>{a.category}</span>
                <span>
                  {money(a.total, budget!.currency)} / {money(a.amountMinor, budget!.currency)}
                </span>
                <Progress
                  percent={a.ratio === null ? 0 : Math.min(100, a.ratio * 100)}
                  showInfo={false}
                  strokeColor={a.ratio !== null && a.ratio >= 1 ? 'var(--error)' : 'var(--brand)'}
                  size="small"
                />
              </button>
            ))}
          </div>
          <p className="footnote">
            未分配额度{' '}
            {money(
              budget!.amountMinor - budget!.allocations.reduce((n, a) => n + a.amountMinor, 0),
              budget!.currency
            )}
            。
            {progress.ratio === null
              ? '缺少历史折算，暂不判断预算。'
              : progress.ratio >= 1
                ? '实际支出已用尽预算。'
                : progress.ratio >= budget!.threshold / 100
                  ? '实际支出已达到提醒阈值。'
                  : '总预算包含全部分类。'}
          </p>
        </AnalysisPanel>
      )}
      {view === 'projection' && projection && (
        <AnalysisPanel
          title="本月预测组成"
          className="spaced"
          extra={
            <Button type="text" onClick={() => setView('month')}>
              收起
            </Button>
          }
        >
          <div className="projection-parts">
            <button
              onClick={() => {
                setStatus('paid')
                setView('month')
                drill()
              }}
            >
              已支付<strong>{money(projection.actual.total)}</strong>
            </button>
            <button
              onClick={() => {
                setStatus('pending')
                setView('month')
                drill()
              }}
            >
              待确认<strong>{money(projection.pendingAmount)}</strong>
            </button>
            <div>
              剩余预计<strong>{money(projection.futureAmount)}</strong>
            </div>
          </div>
          <p className="footnote">
            {projection.olderPending > 0
              ? `以前月份另有 ${projection.olderPending} 笔待确认，未假定在本月支付。`
              : ''}
            预测使用当前参考汇率{exchangeRates ? `（${exchangeRates.date}）` : ''}，不含已跳过项目。
          </p>
          {projection.future.map((b) => (
            <button
              className="projection-row"
              key={b.subscription.id + b.due}
              onClick={() => onOpen(b.subscription.id)}
            >
              <span>
                {b.subscription.name} · {b.due}
              </span>
              <strong>{formatMoney(b.amountMinor, b.currency)}</strong>
            </button>
          ))}
        </AnalysisPanel>
      )}
      <AnalysisPanel
        title="近 12 个月实际支出"
        className="spaced"
        extra={
          <HelpTip label="支出趋势">
            点击月份查看对应账单。暂无记录不推断为零支出；缺少折算信息时不显示不完整总额。
          </HelpTip>
        }
      >
        <div className="analysis-chart" aria-label="十二个月支出趋势">
          {months.map((m) => (
            <button
              key={m.month}
              className={`analysis-month${m.month === month ? ' selected' : ''}`}
              aria-label={`查看 ${m.month} 支出`}
              onClick={() => {
                onMonth(m.month)
                reset()
              }}
            >
              <small>{!m.count ? '暂无记录' : m.total === null ? '待折算' : money(m.total)}</small>
              <span className="analysis-track">
                <i
                  style={{
                    height:
                      m.count && m.total !== null ? `${Math.max(2, (m.total / max) * 100)}%` : '2px'
                  }}
                />
              </span>
              <span>{m.month.slice(5)}月</span>
            </button>
          ))}
        </div>
      </AnalysisPanel>
      <div className="analysis-columns spaced">
        <AnalysisPanel title="分类实际支出">
          {actual.categories
            .filter(
              (c) =>
                c.amount !== 0 ||
                bills.some(
                  (b) =>
                    b.status === 'paid' &&
                    b.category === c.category &&
                    b.payment?.paidOn.startsWith(month)
                )
            )
            .map((c) => (
              <button
                className="analysis-category"
                key={c.category}
                onClick={() => focusCategory(c.category)}
              >
                <span>{c.category}</span>
                <strong>{money(c.amount)}</strong>
                <small>
                  {c.amount !== null && actual.total
                    ? `${((c.amount / actual.total) * 100).toFixed(1)}%`
                    : '—'}
                </small>
                <Progress
                  percent={c.amount !== null && actual.total ? (c.amount / actual.total) * 100 : 0}
                  showInfo={false}
                  strokeColor="var(--brand)"
                  size="small"
                />
              </button>
            ))}
          {!actual.count && <div className="ledger-empty">本月暂无已支付记录。</div>}
        </AnalysisPanel>
        <AnalysisPanel title="订阅支出排行">
          {ranking.map((r, index) => (
            <div className="ranking-row" key={r.subscription.id}>
              <span className="muted">{index + 1}</span>
              <button
                onClick={() => {
                  setSubscriptionId(r.subscription.id)
                  setStatus('paid')
                  setCategory('all')
                  setQuery('')
                  drill()
                }}
              >
                <strong>{r.subscription.name}</strong>
                <small>{r.count} 笔支付</small>
              </button>
              <strong>{money(r.total)}</strong>
              <Button type="text" size="small" onClick={() => onOpen(r.subscription.id)}>
                详情
              </Button>
            </div>
          ))}
          {!ranking.length && <div className="ledger-empty">本月暂无订阅支出排行。</div>}
        </AnalysisPanel>
      </div>
      <AnalysisPanel
        id="analysis-bills"
        title="账单明细"
        className="spaced"
        extra={
          <Button type="text" size="small" onClick={reset}>
            重置筛选
          </Button>
        }
      >
        <div className="analysis-filters">
          <Input
            aria-label="搜索账单订阅"
            placeholder="搜索订阅名称"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <SelectField
            label="分析分类筛选"
            value={category}
            onChange={setCategory}
            options={[
              { value: 'all', label: '全部分类' },
              ...categories.map((c) => ({ value: c, label: c }))
            ]}
          />
          <SelectField
            label="分析订阅筛选"
            value={subscriptionId}
            onChange={setSubscriptionId}
            options={[
              { value: 'all', label: '全部订阅' },
              ...subscriptions.map((s) => ({ value: s.id, label: s.name }))
            ]}
          />
          <SelectField
            label="账单状态筛选"
            value={status}
            onChange={setStatus}
            options={[
              { value: 'all', label: '全部状态' },
              ...Object.entries(billStatus).map(([value, label]) => ({ value, label }))
            ]}
          />
        </div>
        <Table<BillRecord>
          rowKey="id"
          size="small"
          dataSource={visible}
          pagination={{ pageSize: 10, showSizeChanger: false, hideOnSinglePage: true }}
          scroll={{ x: 780 }}
          columns={[
            {
              title: '订阅',
              dataIndex: 'subscriptionId',
              render: (id) => (
                <button className="text-button" onClick={() => onOpen(id)}>
                  {subscriptions.find((s) => s.id === id)?.name}
                </button>
              )
            },
            {
              title: '日期',
              render: (_, b) => (
                <span>
                  {b.payment?.paidOn ?? b.due}
                  <small className="table-note">应扣 {b.due}</small>
                </span>
              )
            },
            { title: '分类', dataIndex: 'category' },
            {
              title: '状态',
              dataIndex: 'status',
              render: (s) => (
                <span className={`badge bill-${s}`}>
                  {billStatus[s as keyof typeof billStatus]}
                </span>
              )
            },
            {
              title: '原币金额',
              render: (_, b) =>
                formatMoney(
                  b.payment?.amountMinor ?? b.amountMinor,
                  b.payment?.currency ?? b.currency
                )
            },
            {
              title: currency,
              render: (_, b) =>
                b.payment ? (
                  <span>
                    {money(paymentMinor(b, currency))}
                    <small className="table-note">
                      {b.conversion?.source === 'manual'
                        ? '历史折算金额'
                        : b.conversion?.source === 'import-current'
                          ? '导入时参考汇率'
                          : b.conversion?.source === 'import-none'
                            ? '原币记录'
                            : (b.rates?.date ?? '原币')}
                    </small>
                  </span>
                ) : (
                  '—'
                )
            },
            {
              title: '操作',
              render: (_, b) => (
                <div className="record-actions">
                  <Button type="link" size="small" disabled={busy} onClick={() => onEdit(b)}>
                    {b.status === 'paid' ? '编辑' : '确认支付'}
                  </Button>
                  <Button
                    type="text"
                    size="small"
                    disabled={busy}
                    onClick={() => void update(b, b.status === 'pending' ? 'skipped' : 'pending')}
                  >
                    {b.status === 'pending' ? '跳过' : '撤销'}
                  </Button>
                </div>
              )
            }
          ]}
        />
      </AnalysisPanel>
      <AnalysisPanel title="导入记录" className="spaced">
        <div className="import-batches">
          {snapshot.importBatches.length ? (
            snapshot.importBatches.slice(0, 10).map((batch) => (
              <div key={batch.id}>
                <strong>{batch.source}</strong>
                <span>
                  新增 {batch.added} · 更新 {batch.updated} · 跳过 {batch.skipped}
                </span>
                <small>{new Date(batch.createdAt).toLocaleString('zh-CN')}</small>
              </div>
            ))
          ) : (
            <p className="small muted">暂无 CSV 导入记录。</p>
          )}
        </div>
      </AnalysisPanel>
    </>
  )
}
