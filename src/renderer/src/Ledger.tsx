import { useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { Button, DatePicker, InputNumber, Modal, Tabs, Collapse } from 'antd'
import dayjs from 'dayjs'
import { CalendarDays, Plus } from 'lucide-react'
import { currencies } from '../../shared/model'
import type { Currency, Subscription } from '../../shared/model'
import { billInputSchema, billUpdateSchema, priceInputSchema } from '../../shared/ledger-model'
import type { BillRecord, LedgerChange, Price } from '../../shared/ledger-model'
import { billStatus, spendingMonths } from '../../shared/ledger'
import { formatDate, formatMoney, localDate, parseAmount } from '../../shared/billing'
import { SelectField } from './controls'

const unwrap = <T,>(result: { ok: true; data: T } | { ok: false; error: string }): T => {
  if (!result.ok) throw new Error(result.error)
  return result.data
}
const dateProps = {
  format: 'YYYY-MM-DD',
  preserveInvalidOnBlur: true,
  previewValue: false as const,
  minDate: dayjs('1970-01-01'),
  maxDate: dayjs('2100-12-31'),
  suffixIcon: <CalendarDays size={16} />,
  onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Enter') event.preventDefault()
  }
}
export type BillTarget = { subscription: Subscription; bill?: BillRecord }

export function BillEditor({
  target,
  onClose,
  onSaved
}: {
  target: BillTarget
  onClose: () => void
  onSaved: () => Promise<unknown>
}) {
  const { subscription: s, bill } = target
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    const values = new FormData(event.currentTarget),
      amountMinor = parseAmount(String(values.get('paymentAmount')))
    if (amountMinor === null) {
      setError('金额请填写最多两位小数，范围为 0—9,999,999.99。')
      return
    }
    const payment = {
      amountMinor,
      currency: values.get('paymentCurrency'),
      paidOn: values.get('paidOn')
    }
    const validation = bill
      ? billUpdateSchema.safeParse({
          id: bill.id,
          expectedUpdatedAt: bill.updatedAt,
          status: 'paid',
          payment
        })
      : billInputSchema.safeParse({ subscriptionId: s.id, due: values.get('due'), payment })
    if (!validation.success) {
      setError(validation.error.issues.map((i) => i.message).join('；'))
      return
    }
    setBusy(true)
    setError('')
    try {
      if (bill) unwrap(await window.desktop.updateBill(billUpdateSchema.parse(validation.data)))
      else unwrap(await window.desktop.addBill(billInputSchema.parse(validation.data)))
      await onSaved()
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败，请重试。')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal
      open
      title={bill ? (bill.status === 'paid' ? '编辑支付记录' : '确认支付') : '补录账单'}
      onCancel={() => !busy && onClose()}
      maskClosable={false}
      footer={null}
      width={500}
    >
      <p className="ledger-dialog-summary">
        {s.name}
        {bill && ` · 应扣 ${bill.due} · ${formatMoney(bill.amountMinor, bill.currency)}`}
      </p>
      <form onSubmit={(event) => void submit(event)} className="ledger-form">
        {!bill && (
          <label>
            应扣日期
            <DatePicker
              {...dateProps}
              aria-label="应扣日期"
              name="due"
              required
              defaultValue={dayjs()}
              disabledDate={(d) => d.format('YYYY-MM-DD') > localDate()}
              disabled={busy}
            />
          </label>
        )}
        <div className="form-grid">
          <label>
            实际扣款金额
            <InputNumber<string>
              name="paymentAmount"
              aria-label="实际扣款金额"
              stringMode
              controls={false}
              changeOnBlur={false}
              inputMode="decimal"
              min="0"
              max="9999999.99"
              required
              defaultValue={(
                (bill?.payment?.amountMinor ?? bill?.amountMinor ?? s.amountMinor) / 100
              ).toFixed(2)}
              disabled={busy}
            />
          </label>
          <label>
            支付币种
            <SelectField
              label="支付币种"
              name="paymentCurrency"
              defaultValue={bill?.payment?.currency ?? bill?.currency ?? s.currency}
              options={currencies.map((c) => ({ value: c, label: c }))}
              disabled={busy}
            />
          </label>
          <label className="full">
            实际支付日期
            <DatePicker
              {...dateProps}
              aria-label="实际支付日期"
              name="paidOn"
              required
              defaultValue={dayjs(bill?.payment?.paidOn ?? localDate())}
              disabledDate={(d) => d.format('YYYY-MM-DD') > localDate()}
              disabled={busy}
            />
          </label>
        </div>
        <p className="footnote">
          按实际支付日期计入支出。支付币种可与订阅币种不同，例如填写银行卡实际扣款的人民币金额。
          {bill?.status === 'paid'
            ? '编辑后保留原汇率快照，缺少快照时会补齐当前参考汇率。'
            : '确认时保存当前参考汇率；缺少汇率的账单会显示待折算。'}
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
          <Button htmlType="submit" type="primary" loading={busy} autoInsertSpace={false}>
            {bill?.status === 'paid' ? '保存支付记录' : bill ? '确认支付' : '保存补录'}
          </Button>
        </div>
      </form>
    </Modal>
  )
}

export function PriceEditor({
  subscription: s,
  onClose,
  onSaved
}: {
  subscription: Subscription
  onClose: () => void
  onSaved: () => Promise<unknown>
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    const data = new FormData(event.currentTarget),
      amountMinor = parseAmount(String(data.get('newPrice')))
    const result = priceInputSchema.safeParse({
      subscriptionId: s.id,
      amountMinor,
      currency: data.get('newCurrency'),
      effectiveOn: data.get('effectiveOn')
    })
    if (!result.success) {
      setError(
        amountMinor === null
          ? '请输入最多两位小数的有效金额。'
          : result.error.issues.map((i) => i.message).join('；')
      )
      return
    }
    setBusy(true)
    setError('')
    try {
      unwrap(await window.desktop.changePrice(result.data))
      await onSaved()
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : '调整价格失败。')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal
      open
      title="调整价格"
      onCancel={() => !busy && onClose()}
      maskClosable={false}
      footer={null}
      width={500}
    >
      <p className="ledger-dialog-summary">
        {s.name} · 当前 {formatMoney(s.amountMinor, s.currency)}
      </p>
      <form onSubmit={(event) => void submit(event)} className="ledger-form">
        <div className="form-grid">
          <label>
            新价格
            <InputNumber<string>
              name="newPrice"
              aria-label="新价格"
              stringMode
              controls={false}
              changeOnBlur={false}
              min="0"
              max="9999999.99"
              required
              defaultValue={(s.amountMinor / 100).toFixed(2)}
              disabled={busy}
            />
          </label>
          <label>
            币种
            <SelectField
              label="新价格币种"
              name="newCurrency"
              defaultValue={s.currency}
              options={currencies.map((c) => ({ value: c, label: c }))}
              disabled={busy}
            />
          </label>
          <label className="full">
            生效日期
            <DatePicker
              {...dateProps}
              name="effectiveOn"
              aria-label="价格生效日期"
              required
              defaultValue={dayjs()}
              minDate={dayjs(localDate())}
              disabled={busy}
            />
          </label>
        </div>
        <p className="footnote">
          新价格用于生效日及之后的预计扣款。已生成的账单保留原金额。同一生效日期再次调整会替换该日期的价格计划，变更记录会保留。
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
            保存价格
          </Button>
        </div>
      </form>
    </Modal>
  )
}

export function RecordRows({
  bills,
  subscriptions,
  onEdit,
  onStatus,
  busy = false
}: {
  bills: BillRecord[]
  subscriptions: Subscription[]
  onEdit: (bill: BillRecord) => void
  onStatus: (bill: BillRecord, status: 'pending' | 'skipped') => void
  busy?: boolean
}) {
  const [expanded, setExpanded] = useState(false)
  return (
    <div className="record-list">
      {!bills.length && (
        <div className="ledger-empty">
          暂无账单记录。到扣款日会生成待确认账单，也可以补录以往支付。
        </div>
      )}
      {(expanded ? bills : bills.slice(0, 12)).map((b) => (
        <div className="record-row" key={b.id}>
          <div className="record-info">
            <strong>
              {subscriptions.find((s) => s.id === b.subscriptionId)?.name ?? '订阅'}
              <span className={`badge bill-${b.status}`}>{billStatus[b.status]}</span>
            </strong>
            <small>
              应扣 {b.due}
              {b.manual ? ' · 手动补录' : ''}
              {b.payment ? ` · 支付 ${b.payment.paidOn}` : ''}
            </small>
          </div>
          <div className="record-price">
            <strong>
              {formatMoney(
                b.payment?.amountMinor ?? b.amountMinor,
                b.payment?.currency ?? b.currency
              )}
            </strong>
            {b.payment &&
              (b.payment.amountMinor !== b.amountMinor || b.payment.currency !== b.currency) && (
                <small>预计 {formatMoney(b.amountMinor, b.currency)}</small>
              )}
          </div>
          <div className="record-actions">
            <Button
              size="small"
              type={b.status === 'pending' ? 'primary' : 'default'}
              disabled={busy}
              autoInsertSpace={false}
              onClick={() => onEdit(b)}
            >
              {b.status === 'paid' ? '编辑支付' : b.status === 'skipped' ? '记录支付' : '确认支付'}
            </Button>
            <Button
              size="small"
              type="text"
              disabled={busy}
              autoInsertSpace={false}
              onClick={() => onStatus(b, b.status === 'pending' ? 'skipped' : 'pending')}
            >
              {b.status === 'pending' ? '跳过' : '撤销确认'}
            </Button>
          </div>
        </div>
      ))}
      {bills.length > 12 && (
        <Button type="text" onClick={() => setExpanded(!expanded)}>
          {expanded ? '收起记录' : `查看全部 ${bills.length} 笔`}
        </Button>
      )}
    </div>
  )
}

export function LedgerHistory({
  subscription: s,
  schedule,
  bills,
  prices,
  changes,
  onEdit,
  onStatus,
  onAdd,
  onPrice,
  busy
}: {
  subscription: Subscription
  schedule: ReactNode
  bills: BillRecord[]
  prices: Price[]
  changes: LedgerChange[]
  onEdit: (b: BillRecord) => void
  onStatus: (b: BillRecord, status: 'pending' | 'skipped') => void
  onAdd: () => void
  onPrice: () => void
  busy: boolean
}) {
  const paid = bills.filter((b) => b.status === 'paid' && b.payment)
  const total = currencies
    .map((c) => ({
      currency: c,
      amount: paid
        .filter((b) => b.payment!.currency === c)
        .reduce((n, b) => n + b.payment!.amountMinor, 0),
      count: paid.filter((b) => b.payment!.currency === c).length
    }))
    .filter((x) => x.count)
  return (
    <section className="panel spaced ledger-history">
      <Tabs
        items={[
          {
            key: 'bills',
            label: `账单记录 (${bills.length})`,
            children: (
              <>
                <div className="ledger-toolbar">
                  <span className="small muted">
                    累计实际支出：
                    {total.length
                      ? total.map((x) => formatMoney(x.amount, x.currency)).join(' + ')
                      : '暂无支付记录'}
                  </span>
                  <Button size="small" icon={<Plus size={14} />} onClick={onAdd} disabled={busy}>
                    补录账单
                  </Button>
                </div>
                <RecordRows
                  bills={bills}
                  subscriptions={[s]}
                  onEdit={onEdit}
                  onStatus={onStatus}
                  busy={busy}
                />
              </>
            )
          },
          { key: 'schedule', label: '后续计划', children: schedule },
          {
            key: 'changes',
            label: '变更记录',
            children: (
              <>
                <div className="ledger-toolbar">
                  <span className="small muted">价格计划按生效日期倒序排列</span>
                  <Button size="small" onClick={onPrice}>
                    调整价格
                  </Button>
                </div>
                {prices.map((p) => (
                  <div key={p.id} className="price-history-row">
                    <span>
                      {p.effectiveOn === '1970-01-01'
                        ? '初始价格'
                        : `${formatDate(p.effectiveOn)} 生效`}
                      {p.effectiveOn > localDate() && <span className="badge neutral">待生效</span>}
                    </span>
                    <strong>{formatMoney(p.amountMinor, p.currency)}</strong>
                  </div>
                ))}
                <Collapse
                  ghost
                  items={[
                    {
                      key: 'audit',
                      label: `操作记录 (${changes.length})`,
                      children: (
                        <div className="audit-list">
                          {changes.map((c) => (
                            <div key={c.id}>
                              <span>{c.label}</span>
                              <small>{new Date(c.changedAt).toLocaleString('zh-CN')}</small>
                            </div>
                          ))}
                        </div>
                      )
                    }
                  ]}
                />
              </>
            )
          }
        ]}
      />
    </section>
  )
}

export function SpendingTrend({
  bills,
  currency,
  today
}: {
  bills: BillRecord[]
  currency: Currency
  today: string
}) {
  const months = spendingMonths(bills, currency, today),
    max = Math.max(1, ...months.map((m) => m.total ?? 0))
  return (
    <div className="spending-chart" role="img" aria-label={`近六个月实际支出，${currency}`}>
      {months.map((m) => (
        <div
          className="spending-column"
          key={m.month}
          title={`${m.month}：${m.count ? (m.total === null ? '有未折算账单' : formatMoney(m.total, currency)) : '暂无记录'}`}
        >
          <span className="spending-value">
            {!m.count ? '暂无记录' : m.total === null ? '待折算' : formatMoney(m.total, currency)}
          </span>
          <div className="spending-track">
            <div
              style={{
                height:
                  m.count && m.total !== null ? `${Math.max(2, (m.total / max) * 100)}%` : '2px'
              }}
              className={!m.count ? 'no-records' : ''}
            />
          </div>
          <small>{m.month.slice(5)}月</small>
        </div>
      ))}
    </div>
  )
}
