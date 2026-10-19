import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { Button, DatePicker, Input, InputNumber, Switch } from 'antd'
import dayjs from 'dayjs'
import {
  Archive,
  ArrowLeft,
  ArrowRight,
  Bell,
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Layers,
  LayoutDashboard,
  Pencil,
  Plus,
  Repeat2,
  RefreshCw,
  Search,
  Settings as SettingsIcon,
  Upload,
  X
} from 'lucide-react'
import { categories, currencies, subscriptionInputSchema } from '../../shared/model'
import type {
  Bill,
  Currency,
  Result,
  Snapshot,
  Subscription,
  SubscriptionInput,
  DesktopAction
} from '../../shared/model'
import {
  addDays,
  cycleLabel,
  daysBetween,
  formatDate,
  formatMoney,
  isRenewing,
  localDate,
  monthlyMinor,
  nextBills,
  parseAmount,
  totals
} from '../../shared/billing'
import { useSidebar } from './useSidebar'
import { HelpTip, SelectField } from './controls'
import { convertMinor } from '../../shared/exchange'
import type { ExchangeRates } from '../../shared/exchange'
import { SettingsPage } from './SettingsPage'
import { BillEditor, PriceEditor, RecordRows, LedgerHistory, SpendingTrend } from './Ledger'
import type { BillTarget } from './Ledger'
import { actualTotals, billStatus, calendarBills } from '../../shared/ledger'
import type { BillRecord } from '../../shared/ledger-model'
import { accessLabel, attentionItems } from '../../shared/attention'

type MainPage = 'overview' | 'list' | 'calendar' | 'settings'
type Route =
  | { [P in MainPage]: { page: P } }[MainPage]
  | { page: 'detail'; id: string; from: MainPage }
  | { page: 'edit'; id?: string; from: MainPage }
const pageNames = {
  overview: '总览',
  list: '我的订阅',
  calendar: '扣款日历',
  settings: '设置与备份'
}
const navItems = [
  { page: 'overview', icon: LayoutDashboard },
  { page: 'list', icon: Layers },
  { page: 'calendar', icon: CalendarDays },
  { page: 'settings', icon: SettingsIcon }
] as const
const currencyNames: Record<Currency, string> = {
  CNY: '人民币 CNY',
  USD: '美元 USD',
  EUR: '欧元 EUR',
  HKD: '港币 HKD'
}

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error)
  return result.data
}
function Panel({
  title,
  help,
  extra,
  children,
  className = ''
}: {
  title: string
  help?: string
  extra?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={`panel ${className}`}>
      <div className="panel-head">
        <div className="panel-title">
          <h2>{title}</h2>
          {help && <HelpTip label={title}>{help}</HelpTip>}
        </div>
        {extra}
      </div>
      {children}
    </section>
  )
}
function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="empty">
      <Layers size={26} strokeWidth={1.4} />
      <div>{children}</div>
    </div>
  )
}
function Status({ subscription: s }: { subscription: Subscription }) {
  const label =
    s.status === 'archived'
      ? '已归档'
      : !s.autoRenew
        ? '续费已关闭'
        : s.status === 'trial' && s.anchorDate > localDate()
          ? '试用中'
          : '续费中'
  return (
    <span className={`badge ${s.status === 'archived' || !s.autoRenew ? 'neutral' : ''}`}>
      {label}
    </span>
  )
}
function SubscriptionAvatar({
  name,
  icon,
  large = false
}: {
  name: string
  icon?: string
  large?: boolean
}) {
  return (
    <span className={`avatar${large ? ' large' : ''}`}>
      {icon ? (
        <img src={icon} alt={`${name || '订阅'}图标`} />
      ) : (
        name.slice(0, 1) || <Layers size={20} />
      )}
    </span>
  )
}
function BillRows({
  bills,
  onOpen,
  displayCurrency,
  rates = null
}: {
  bills: Bill[]
  onOpen: (id: string) => void
  displayCurrency?: Currency
  rates?: ExchangeRates | null
}) {
  return (
    <div>
      {bills.map((b) => (
        <button
          className="subscription-row"
          key={b.recordId || `${b.subscription.id}-${b.due}`}
          onClick={() => onOpen(b.subscription.id)}
          aria-label={`查看 ${b.subscription.name} 详情`}
        >
          <SubscriptionAvatar {...b.subscription} />
          <span className="row-info">
            <strong>{b.subscription.name}</strong>
            <small>
              {formatDate(b.due)} ·{' '}
              {b.status
                ? billStatus[b.status]
                : daysBetween(localDate(), b.due) === 0
                  ? '今天'
                  : `${daysBetween(localDate(), b.due)}天后`}
            </small>
          </span>
          <span className="row-price">
            <strong>
              {displayCurrency && displayCurrency !== b.currency
                ? convertMinor(b.amountMinor, b.currency, displayCurrency, rates) === null
                  ? '待换算'
                  : `≈ ${formatMoney(Math.round(convertMinor(b.amountMinor, b.currency, displayCurrency, rates)!), displayCurrency)}`
                : formatMoney(b.amountMinor, b.currency)}
            </strong>
            <small>
              {displayCurrency && displayCurrency !== b.currency
                ? `原币 ${formatMoney(b.amountMinor, b.currency)}`
                : cycleLabel(b.subscription)}
            </small>
          </span>
          <ChevronRight size={16} className="chevron" />
        </button>
      ))}
    </div>
  )
}

export function App() {
  const { collapsed, toggle } = useSidebar()
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [route, setRoute] = useState<Route>({ page: 'overview' })
  const [currency, setCurrency] = useState<Currency>('CNY')
  const [calendarCurrency, setCalendarCurrency] = useState<Currency>('CNY')
  const [ratesLoading, setRatesLoading] = useState(false)
  const [ratesError, setRatesError] = useState<string | null>(null)
  const ratesPending = useRef(false)
  const initializedCurrency = useRef(false)
  const chooseCurrency = useCallback((value: Currency) => {
    setCurrency(value)
    try {
      localStorage.setItem('xuding.currency', value)
    } catch {
      /* Storage may be unavailable. */
    }
  }, [])
  const [today, setToday] = useState(localDate())
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('全部分类')
  const [status, setStatus] = useState('current')
  const [month, setMonth] = useState(today.slice(0, 7))
  const [selectedDate, setSelectedDate] = useState<string | null>(null)
  const [archiveId, setArchiveId] = useState<string | null>(null)
  const [allAttention, setAllAttention] = useState(false)
  const [billTarget, setBillTarget] = useState<BillTarget | null>(null)
  const [priceTarget, setPriceTarget] = useState<Subscription | null>(null)
  const [allPending, setAllPending] = useState(false)
  const [categoryMode, setCategoryMode] = useState('forecast')
  const navigationSequence = useRef(0)

  const reload = useCallback(async () => {
    const value = unwrap(await window.desktop.load())
    if (!initializedCurrency.current) {
      initializedCurrency.current = true
      let saved: string | null = null
      try {
        saved = localStorage.getItem('xuding.currency')
      } catch {
        /* Use available subscriptions. */
      }
      chooseCurrency(currencies.includes(saved as Currency) ? (saved as Currency) : 'CNY')
    }
    setSnapshot(value)
    return value
  }, [chooseCurrency])
  useEffect(() => {
    void reload().catch((e) => setError(String(e.message)))
    const timer = setInterval(() => {
      setToday(localDate())
      void reload().catch(() => {})
    }, 30_000)
    const focus = () => {
      void reload().catch(() => {})
    }
    window.addEventListener('focus', focus)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', focus)
    }
  }, [reload])
  useEffect(() => {
    const navigate = (action: DesktopAction) => {
      if (action.sequence <= navigationSequence.current) return
      navigationSequence.current = action.sequence
      void reload()
        .then(() => {
          if (action.sequence !== navigationSequence.current) return
          setRoute(
            action.page === 'new'
              ? { page: 'edit', from: 'list' }
              : { page: 'detail', id: action.id, from: 'overview' }
          )
        })
        .catch((error) => setError(String(error.message)))
    }
    const unsubscribe = window.desktop.onNavigate(navigate)
    void window.desktop
      .navigationReady()
      .then((result) => {
        const action = unwrap(result)
        if (action) navigate(action)
      })
      .catch((error) => setError(String(error.message)))
    return unsubscribe
  }, [reload])
  useEffect(() => {
    setArchiveId(null)
    setError('')
  }, [route])
  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(''), 5000)
    return () => clearTimeout(timer)
  }, [notice])

  async function perform(work: () => Promise<void>) {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await work()
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败，请重试。')
    } finally {
      setBusy(false)
    }
  }
  const data = snapshot?.subscriptions || []
  const records = snapshot?.bills || []
  const prices = snapshot?.prices || []
  const rates = snapshot?.exchangeRates ?? null
  const needsExchange =
    data.some(
      (s) =>
        isRenewing(s) &&
        ((s.currency !== currency && s.amountMinor > 0) ||
          prices.some(
            (p) =>
              p.subscriptionId === s.id &&
              p.currency !== currency &&
              p.amountMinor > 0 &&
              p.effectiveOn >= today
          ))
    ) ||
    records.some(
      (b) =>
        b.status === 'pending' && b.due >= today && b.currency !== currency && b.amountMinor > 0
    )
  const refreshRates = useCallback(async (force = false) => {
    if (ratesPending.current) return
    ratesPending.current = true
    setRatesLoading(true)
    try {
      const result = unwrap(await window.desktop.exchangeRates(force))
      setSnapshot((previous) =>
        previous ? { ...previous, exchangeRates: result.table } : previous
      )
      setRatesError(result.error)
    } catch {
      setRatesError('暂时无法更新汇率，请重试。')
    } finally {
      ratesPending.current = false
      setRatesLoading(false)
    }
  }, [])
  useEffect(() => {
    if (needsExchange && route.page === 'overview') void refreshRates()
  }, [needsExchange, route.page, today, refreshRates])
  const selected = 'id' in route ? data.find((s) => s.id === route.id) : undefined
  const currentPage = route.page === 'detail' || route.page === 'edit' ? 'list' : route.page
  const openDetail = (id: string, from: MainPage) => setRoute({ page: 'detail', id, from })
  const go = (page: MainPage) => setRoute({ page })
  const addButton = (
    <button
      className="primary"
      disabled={busy}
      onClick={() => setRoute({ page: 'edit', from: 'list' })}
    >
      <Plus size={17} />
      新增订阅
    </button>
  )
  const currencyPicker = (
    <label className="currency-picker">
      <span>统计币种</span>
      <SelectField
        label="统计币种"
        value={currency}
        onChange={(value) => chooseCurrency(value as Currency)}
        options={currencies.map((c) => ({ value: c, label: currencyNames[c] }))}
      />
    </label>
  )

  function overview() {
    const summary = totals(data, currency, today, rates, prices, records)
    const actual = actualTotals(
      records,
      currency,
      today.slice(0, 7) + '-01',
      today.slice(0, 7) + '-31'
    )
    const pending = records.filter((b) => b.status === 'pending')
    const categorySummary =
      categoryMode === 'actual' ? { monthly: actual.total, categories: actual.categories } : summary
    const current = data.filter((s) => s.status !== 'archived')
    const paused = current.filter((s) => !s.autoRenew).length
    const money = (amount: number | null) => (amount === null ? '—' : formatMoney(amount, currency))
    const emptyReason = !current.length
      ? '还没有当前订阅。'
      : !summary.count
        ? `当前 ${current.length} 项订阅均已关闭续费，未计入预计支出。`
        : '未来 30 天没有预计扣款。'
    const attention = attentionItems(data, today)
    return (
      <>
        <header className="page-head">
          <div>
            <h1>每一笔订阅，心里有数。</h1>
            <p>
              {formatDate(today)} ·{' '}
              {current.length ? `已记录 ${current.length} 项当前订阅` : '把持续支出看清楚'}
            </p>
          </div>
          {currencyPicker}
        </header>
        {current.length > 0 && (
          <div className="overview-context">
            <span>
              统一折算为 {currency} · {summary.count} 项续费订阅
              {paused > 0 && ` · ${paused} 项续费已关闭，不计入预计支出`}
            </span>
            {needsExchange && (
              <span className="exchange-status">
                <span>
                  {ratesLoading
                    ? '正在更新汇率…'
                    : ratesError
                      ? rates
                        ? '更新失败 · 使用缓存'
                        : '暂缺汇率'
                      : rates
                        ? `参考汇率 ${rates.date}${daysBetween(rates.date, today) > 7 ? ' · 缓存较旧' : ''}`
                        : '等待汇率'}
                </span>
                <HelpTip label="汇率" placement="bottom">
                  来源：Frankfurter / 欧洲央行。
                  {rates
                    ? `参考日期：${rates.date}；获取时间：${new Date(rates.fetchedAt).toLocaleString('zh-CN')}。`
                    : '尚无本地汇率缓存。'}
                  每天首次需要换算时更新，离线使用缓存。换算仅用于估算，不含银行手续费，原始订阅金额不变。
                  {ratesError}
                </HelpTip>
                <button
                  className="text-button"
                  disabled={ratesLoading}
                  onClick={() => void refreshRates(true)}
                >
                  <RefreshCw size={13} />
                  刷新汇率
                </button>
              </span>
            )}
          </div>
        )}
        {summary.missing.length > 0 && (
          <div className="exchange-notice" role="status">
            {ratesLoading ? '正在获取' : '缺少'} {summary.missing.join('、')} → {currency}{' '}
            汇率，完整汇总暂不可用。扣款明细保留原币金额。
          </div>
        )}
        <div className="stats">
          <div className="stat featured">
            <div className="stat-heading">
              <span>本月实际支出</span>
              <small>
                {actual.count} 笔已支付 · {currency}
              </small>
            </div>
            <strong>{money(actual.total)}</strong>
          </div>
          <div className="stat">
            <div className="stat-heading">
              <span>月均订阅费用</span>
              <small title={`年度折算费用 ${money(summary.annual)}`}>
                年度折算 {money(summary.annual)}
              </small>
            </div>
            <strong>{money(summary.monthly)}</strong>
          </div>
          <div className="stat">
            <div className="stat-heading">
              <span>未来 30 天预计扣款</span>
              <small title={`${today} 至 ${addDays(today, 29)}`}>
                {today.slice(5)} — {addDays(today, 29).slice(5)}
              </small>
            </div>
            <strong>{money(summary.upcoming)}</strong>
          </div>
        </div>
        {actual.missing > 0 && (
          <div className="exchange-notice" role="status">
            本月有 {actual.missing}{' '}
            笔已支付账单缺少汇率快照，完整实际支出暂不可用。可编辑支付记录填写实际扣款币种及金额。
          </div>
        )}
        {pending.length > 0 && (
          <Panel
            title="待确认账单"
            className="spaced pending-panel"
            extra={
              <button className="text-button" onClick={() => setAllPending(!allPending)}>
                {allPending
                  ? '收起'
                  : `共 ${pending.length} 笔${pending.length > 3 ? ' · 查看全部' : ''}`}
              </button>
            }
          >
            <RecordRows
              bills={allPending ? pending : pending.slice(0, 3)}
              subscriptions={data}
              onEdit={editBill}
              onStatus={updateBillStatus}
              busy={busy}
            />
          </Panel>
        )}
        {attention.length > 0 && (
          <Panel
            title="需要关注"
            className="attention-panel"
            extra={<span className="small muted">{attention.length} 项</span>}
          >
            {(allAttention ? attention : attention.slice(0, 4)).map((item) => (
              <button
                key={item.subscription.id}
                className="attention-item"
                onClick={() => openDetail(item.subscription.id, 'overview')}
                aria-label={`查看 ${item.subscription.name} 详情`}
              >
                <Bell size={16} />
                <span>
                  <strong>{item.subscription.name}</strong>
                  <small>
                    {item.label} · {item.date}
                  </small>
                </span>
                <ChevronRight size={16} className="chevron" />
              </button>
            ))}
            {attention.length > 4 && (
              <button className="text-button" onClick={() => setAllAttention(!allAttention)}>
                {allAttention ? '收起' : `查看全部 ${attention.length} 项`}
              </button>
            )}
          </Panel>
        )}
        <div className="overview-columns">
          <Panel
            title="即将扣款"
            extra={
              <button className="text-button" onClick={() => go('list')}>
                全部订阅
                <ArrowRight size={14} />
              </button>
            }
          >
            {summary.bills.length ? (
              <BillRows
                bills={summary.bills.slice(0, 5)}
                displayCurrency={currency}
                rates={rates}
                onOpen={(id) => openDetail(id, 'overview')}
              />
            ) : (
              <Empty>
                {data.length ? (
                  emptyReason
                ) : (
                  <>
                    还没有订阅。
                    <br />
                    <button className="text-button" onClick={() => go('list')}>
                      前往我的订阅
                      <ArrowRight size={14} />
                    </button>
                  </>
                )}
              </Empty>
            )}
          </Panel>
          <Panel
            title="钱花在哪儿"
            extra={
              <SelectField
                label="分类支出口径"
                value={categoryMode}
                onChange={setCategoryMode}
                options={[
                  { value: 'forecast', label: '月均预计' },
                  { value: 'actual', label: '本月实际' }
                ]}
              />
            }
          >
            {categorySummary.monthly !== null &&
              categorySummary.categories.map(({ category: c, amount }) => {
                return (
                  amount !== null &&
                  amount > 0 && (
                    <div className="bar-row" key={c}>
                      <div>
                        <span>{c}</span>
                        <span>{formatMoney(Math.round(amount), currency)}</span>
                      </div>
                      <div className="bar-track">
                        <div
                          style={{
                            width: `${Math.min(100, (amount / Math.max(1, categorySummary.monthly!)) * 100)}%`
                          }}
                        />
                      </div>
                    </div>
                  )
                )
              })}
            {!categorySummary.monthly && (
              <Empty>
                {categorySummary.monthly === null
                  ? '补齐汇率后显示完整分类支出。'
                  : categoryMode === 'actual'
                    ? '本月暂无已确认的实际支出。'
                    : summary.count
                      ? '当前续费订阅金额为 0，暂无分类支出。'
                      : emptyReason}
              </Empty>
            )}
          </Panel>
        </div>
        <Panel
          title="近 6 个月实际支出"
          className="spaced"
          help="按实际支付日期统计，仅计入已确认支付的账单。缺少记录的月份不推断为零支出。"
          extra={<span className="small muted">{currency}</span>}
        >
          <SpendingTrend bills={records} currency={currency} today={today} />
        </Panel>
      </>
    )
  }
  function list() {
    const visible = data.filter(
      (s) =>
        (status === 'all' ||
          (status === 'archived' ? s.status === 'archived' : s.status !== 'archived')) &&
        (category === '全部分类' || s.category === category) &&
        s.name.toLowerCase().includes(query.toLowerCase())
    )
    return (
      <>
        <header className="page-head">
          <div>
            <h1>我的订阅</h1>
            <p>
              {data.filter((s) => s.status !== 'archived').length} 项当前订阅 · 记录每一份持续投入
            </p>
          </div>
          {addButton}
        </header>
        <div className="list-tools">
          <Input
            className="search-field"
            prefix={<Search size={17} aria-hidden="true" />}
            aria-label="搜索订阅"
            placeholder="搜索订阅名称…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <SelectField
            label="分类筛选"
            value={category}
            onChange={setCategory}
            options={['全部分类', ...categories].map((c) => ({ value: c, label: c }))}
          />
          <SelectField
            label="状态筛选"
            value={status}
            onChange={setStatus}
            options={[
              { value: 'current', label: '当前订阅' },
              { value: 'archived', label: '已归档' },
              { value: 'all', label: '全部状态' }
            ]}
          />
        </div>
        <div className="subscription-list">
          {visible.map((s) => {
            const start = records.some(
              (b) =>
                b.subscriptionId === s.id && b.due === today && !b.manual && b.status !== 'pending'
            )
              ? addDays(today, 1)
              : today
            const next = nextBills(s, start, 1, prices)[0]
            return (
              <button
                className="subscription-row"
                key={s.id}
                onClick={() => openDetail(s.id, 'list')}
                aria-label={`查看 ${s.name} 详情`}
              >
                <SubscriptionAvatar {...s} />
                <span className="row-info">
                  <span className="row-title">
                    <strong>{s.name}</strong>
                    <Status subscription={s} />
                  </span>
                  <small>
                    {s.category}
                    {next ? ` · ${formatDate(next.due)} 预计扣款` : ''}
                    {!s.autoRenew && s.status !== 'archived'
                      ? ` · ${accessLabel(s, today)}${s.accessEndsOn ? `（${s.accessEndsOn}）` : ''}`
                      : ''}
                  </small>
                </span>
                <span className="row-price">
                  <strong>{formatMoney(s.amountMinor, s.currency)}</strong>
                  <small>/ {cycleLabel(s).slice(1)}</small>
                </span>
                <ChevronRight size={17} className="chevron" />
              </button>
            )
          })}
        </div>
        {!visible.length && (
          <div className="panel">
            <Empty>
              {data.length
                ? '没有符合条件的订阅，试试调整搜索或筛选。'
                : '点击右上角“新增订阅”，开始记录第一项。'}
            </Empty>
          </div>
        )}
      </>
    )
  }
  function detail(s: Subscription, from: MainPage) {
    const bills = nextBills(
        s,
        records.some(
          (b) => b.subscriptionId === s.id && b.due === today && !b.manual && b.status !== 'pending'
        )
          ? addDays(today, 1)
          : today,
        3,
        prices
      ),
      next = bills[0]
    return (
      <>
        <button className="back" onClick={() => go(from)}>
          <ArrowLeft size={16} />
          返回{pageNames[from]}
        </button>
        <header className="page-head">
          <div className="detail-title">
            <SubscriptionAvatar {...s} large />
            <div>
              <h1>{s.name}</h1>
              <p>{s.category} · 订阅详情</p>
            </div>
          </div>
          <button className="primary" onClick={() => setRoute({ page: 'edit', id: s.id, from })}>
            <Pencil size={16} />
            编辑订阅
          </button>
        </header>
        <div className="detail-grid">
          <Panel
            title="费用与周期"
            extra={
              <button className="text-button" onClick={() => setPriceTarget(s)}>
                调整价格
              </button>
            }
          >
            <div className="detail-price">
              {formatMoney(s.amountMinor, s.currency)}
              <small> / {cycleLabel(s).slice(1)}</small>
            </div>
            <dl className="facts">
              <div>
                <dt>计费周期</dt>
                <dd>{cycleLabel(s)}</dd>
              </div>
              <div>
                <dt>折合月均</dt>
                <dd>{formatMoney(Math.round(monthlyMinor(s)), s.currency)}</dd>
              </div>
              <div>
                <dt>年度折算</dt>
                <dd>{formatMoney(Math.round(monthlyMinor(s) * 12), s.currency)}</dd>
              </div>
              <div>
                <dt>计费基准日</dt>
                <dd>{formatDate(s.anchorDate)}</dd>
              </div>
            </dl>
            <p className="footnote">按当前价格折算；不代表已支付的历史账单。</p>
          </Panel>
          <Panel title="订阅状态" extra={<Status subscription={s} />}>
            <dl className="facts">
              <div>
                <dt>自动续费</dt>
                <dd>{s.autoRenew && s.status !== 'archived' ? '已开启' : '已关闭'}</dd>
              </div>
              <div>
                <dt>下次预计扣款</dt>
                <dd>{next ? formatDate(next.due) : '暂无计划'}</dd>
              </div>
              <div>
                <dt>权益到期日</dt>
                <dd>{s.accessEndsOn ? formatDate(s.accessEndsOn) : '到期日未记录'}</dd>
              </div>
              {s.accessEndsOn && (
                <div>
                  <dt>剩余权益</dt>
                  <dd>{accessLabel(s, today)}</dd>
                </div>
              )}
              <div>
                <dt>下次预计金额</dt>
                <dd>{next ? formatMoney(next.amountMinor, next.currency) : '—'}</dd>
              </div>
              <div>
                <dt>提醒时间</dt>
                <dd>{s.reminderDays ? `提前 ${s.reminderDays} 天` : '扣款当天'}</dd>
              </div>
              <div>
                <dt>桌面通知</dt>
                <dd>{snapshot?.settings.notificationsEnabled ? '已开启' : '未开启'}</dd>
              </div>
            </dl>
          </Panel>
        </div>
        <LedgerHistory
          key={s.id}
          schedule={
            <>
              {bills.length ? (
                bills.map((bill, i) => (
                  <div className="schedule-row" key={bill.due}>
                    <span>
                      {formatDate(bill.due)}
                      <small>
                        {i === 0 && s.status === 'trial' && bill.due === s.anchorDate
                          ? '试用结束后首笔扣款'
                          : '订阅续费'}
                      </small>
                    </span>
                    <strong>{formatMoney(bill.amountMinor, bill.currency)}</strong>
                  </div>
                ))
              ) : (
                <Empty>没有后续扣款计划。</Empty>
              )}
            </>
          }
          subscription={s}
          bills={records.filter((b) => b.subscriptionId === s.id)}
          prices={prices.filter((p) => p.subscriptionId === s.id)}
          changes={(snapshot?.changes || []).filter((c) => c.subscriptionId === s.id)}
          onEdit={editBill}
          onStatus={updateBillStatus}
          onAdd={() => setBillTarget({ subscription: s })}
          onPrice={() => setPriceTarget(s)}
          busy={busy}
        />
        {(s.notes || s.website) && (
          <Panel title="补充信息" className="spaced">
            {s.notes && <p className="notes">{s.notes}</p>}
            {s.website && (
              <button
                className="secondary"
                disabled={busy}
                onClick={() =>
                  void perform(async () => {
                    unwrap(await window.desktop.openWebsite(s.website))
                  })
                }
              >
                <ExternalLink size={16} />
                打开服务商网站
              </button>
            )}
          </Panel>
        )}
        <div className="detail-footer">
          <span className="small muted">最近更新：{formatDate(s.updatedAt.slice(0, 10))}</span>
          {s.status !== 'archived' && (
            <button className="text-button muted" onClick={() => setArchiveId(s.id)}>
              <Archive size={15} />
              归档订阅
            </button>
          )}
        </div>
        {archiveId === s.id && (
          <div className="confirmation" role="alert">
            <div>
              <strong>将「{s.name}」移入归档？</strong>
              <p>历史账单和实际支出会保留，后续预计扣款将停止。服务商处的实际续费需另行取消。</p>
            </div>
            <button className="secondary" disabled={busy} onClick={() => setArchiveId(null)}>
              保留
            </button>
            <button
              className="primary"
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  unwrap(await window.desktop.archive(s.id))
                  await reload()
                  setArchiveId(null)
                  setNotice('已归档，可从编辑页面恢复。')
                })
              }
            >
              确认归档
            </button>
          </div>
        )}
      </>
    )
  }
  function calendar() {
    const [year, number] = month.split('-').map(Number),
      first = month + '-01'
    const days = new Date(Date.UTC(year, number, 0)).getUTCDate(),
      end = `${month}-${days}`
    const offset = (new Date(first + 'T00:00:00Z').getUTCDay() + 6) % 7
    const currency = calendarCurrency
    const bills = calendarBills(data, records, prices, first, end, currency),
      shown = selectedDate ? bills.filter((b) => b.due === selectedDate) : bills
    function shift(delta: number) {
      const date = new Date(Date.UTC(year, number - 1 + delta, 1))
      setMonth(date.toISOString().slice(0, 7))
      setSelectedDate(null)
    }
    return (
      <>
        <header className="page-head">
          <div>
            <h1>扣款日历</h1>
            <p>查看预计扣款与账单确认状态</p>
          </div>
          <label className="currency-picker">
            <span>筛选币种</span>
            <SelectField
              label="筛选币种"
              value={calendarCurrency}
              onChange={(value) => setCalendarCurrency(value as Currency)}
              options={currencies.map((c) => ({ value: c, label: currencyNames[c] }))}
            />
          </label>
        </header>
        <div className="calendar-view">
          <div className="calendar-layout">
            <section className="panel calendar-panel" aria-label="月度扣款日历">
              <div className="calendar-head">
                <div>
                  <button
                    className="icon-button"
                    aria-label="上个月"
                    disabled={month <= '1970-01'}
                    onClick={() => shift(-1)}
                  >
                    <ChevronLeft size={18} />
                  </button>
                  <h2>
                    {year}年{number}月
                  </h2>
                  <button
                    className="icon-button"
                    aria-label="下个月"
                    disabled={month >= '2100-12'}
                    onClick={() => shift(1)}
                  >
                    <ChevronRight size={18} />
                  </button>
                </div>
                <Button
                  size="small"
                  autoInsertSpace={false}
                  onClick={() => {
                    setMonth(today.slice(0, 7))
                    setSelectedDate(null)
                  }}
                >
                  本月
                </Button>
              </div>
              <div className="calendar-grid">
                {['一', '二', '三', '四', '五', '六', '日'].map((w) => (
                  <div className="weekday" key={w}>
                    {w}
                  </div>
                ))}
                {Array.from({ length: offset }, (_, i) => (
                  <div key={`space-${i}`} />
                ))}
                {Array.from({ length: days }, (_, i) => {
                  const date = `${month}-${String(i + 1).padStart(2, '0')}`,
                    items = bills.filter((b) => b.due === date),
                    amount = formatMoney(
                      items
                        .filter((b) => b.status !== 'skipped')
                        .reduce((n, b) => n + b.amountMinor, 0),
                      currency
                    )
                  return (
                    <button
                      key={date}
                      className={`day ${date === today ? 'today' : ''} ${items.length ? 'has-bills' : ''}`}
                      aria-pressed={selectedDate === date}
                      aria-current={date === today ? 'date' : undefined}
                      aria-label={`${date}，${items.length}笔扣款${items.length ? `，合计${amount}` : ''}`}
                      title={items.length ? `${items.length}笔扣款 · ${amount}` : '暂无预计扣款'}
                      onClick={() => setSelectedDate(selectedDate === date ? null : date)}
                    >
                      <span className="day-number">
                        {i + 1}
                        {items.length > 0 && (
                          <span className="day-statuses" aria-hidden="true">
                            {[...new Set(items.map((b) => b.status || 'forecast'))].map(
                              (status) => (
                                <i key={status} className={`status-dot ${status}`} />
                              )
                            )}
                          </span>
                        )}
                      </span>
                      {items.length > 0 && <strong>{amount}</strong>}
                    </button>
                  )
                })}
              </div>
              <div className="calendar-legend">
                <span>
                  <i className="status-dot" />
                  预计
                </span>
                <span>
                  <i className="status-dot pending" />
                  待确认
                </span>
                <span>
                  <i className="status-dot paid" />
                  已支付
                </span>
                <span>
                  <i className="status-dot skipped" />
                  已跳过（不计入合计）
                </span>
              </div>
            </section>
            <Panel
              className="calendar-details"
              title={selectedDate ? `${formatDate(selectedDate)}的扣款` : '本月扣款计划'}
              extra={
                <span className="small muted">
                  合计{' '}
                  {formatMoney(
                    shown
                      .filter((b) => b.status !== 'skipped')
                      .reduce((n, b) => n + b.amountMinor, 0),
                    currency
                  )}
                </span>
              }
            >
              {selectedDate && (
                <button
                  className="text-button calendar-reset"
                  onClick={() => setSelectedDate(null)}
                >
                  查看整月计划
                </button>
              )}
              {shown.length ? (
                <BillRows bills={shown} onOpen={(id) => openDetail(id, 'calendar')} />
              ) : (
                <Empty>{selectedDate ? '所选日期没有预计扣款。' : '本月没有预计扣款。'}</Empty>
              )}
            </Panel>
          </div>
        </div>
      </>
    )
  }
  function editBill(bill: BillRecord) {
    const subscription = data.find((s) => s.id === bill.subscriptionId)
    if (subscription) setBillTarget({ subscription, bill })
  }
  function updateBillStatus(bill: BillRecord, status: 'pending' | 'skipped') {
    void perform(async () => {
      unwrap(
        await window.desktop.updateBill({ id: bill.id, expectedUpdatedAt: bill.updatedAt, status })
      )
      await reload()
      setNotice(status === 'pending' ? '账单已恢复为待确认。' : '已跳过本期账单。')
    })
  }
  function settings() {
    return <SettingsPage snapshot={snapshot!} onReload={reload} onNotice={setNotice} />
  }

  return (
    <>
      <header className="window-titlebar" aria-hidden="true" />
      <div className={`app-shell${collapsed ? ' sidebar-collapsed' : ''}`}>
        <aside className="sidebar">
          <button
            className="sidebar-toggle"
            onClick={toggle}
            aria-label={collapsed ? '展开侧栏' : '收起侧栏'}
            aria-expanded={!collapsed}
            aria-controls="main-navigation"
            aria-keyshortcuts="Control+B Meta+B"
            title={`${collapsed ? '展开' : '收起'}侧栏 (Ctrl+B)`}
          >
            {collapsed ? (
              <ChevronRight size={16} aria-hidden="true" />
            ) : (
              <ChevronLeft size={16} aria-hidden="true" />
            )}
          </button>
          <div className="brand">
            <span className="brand-mark" aria-hidden="true">
              <Repeat2 size={18} />
            </span>
            <span className="brand-name">续订</span>
          </div>
          <nav id="main-navigation" aria-label="主导航">
            {navItems.map(({ page, icon: Icon }) => (
              <button
                key={page}
                aria-label={pageNames[page]}
                title={collapsed ? pageNames[page] : undefined}
                aria-current={currentPage === page ? 'page' : undefined}
                onClick={() => go(page)}
              >
                <Icon size={19} aria-hidden="true" />
                <span className="nav-label">{pageNames[page]}</span>
                {page === 'list' && (
                  <small>{data.filter((s) => s.status !== 'archived').length}</small>
                )}
              </button>
            ))}
          </nav>
          <div className="sidebar-bottom" title={collapsed ? '本地存储' : undefined}>
            <span className="local-dot" />
            <div className="storage-label">
              本地存储<small>你的订阅，你的数据。</small>
            </div>
          </div>
        </aside>
        <main className={`main${route.page === 'settings' ? ' settings-main' : ''}`}>
          {error && (
            <div role="alert" className="error-banner">
              <span>{error}</span>
              <button
                className="icon-button"
                aria-label="关闭错误提示"
                onClick={() => setError('')}
              >
                <X size={16} />
              </button>
            </div>
          )}
          {!snapshot ? (
            <Empty>
              {error ? (
                <button
                  className="secondary"
                  onClick={() =>
                    void perform(async () => {
                      await reload()
                    })
                  }
                >
                  重新加载
                </button>
              ) : (
                '正在读取本地订阅…'
              )}
            </Empty>
          ) : route.page === 'overview' ? (
            overview()
          ) : route.page === 'list' ? (
            list()
          ) : route.page === 'calendar' ? (
            calendar()
          ) : route.page === 'settings' ? (
            settings()
          ) : route.page === 'detail' ? (
            selected ? (
              detail(selected, route.from)
            ) : (
              <Empty>
                订阅不存在。
                <button className="text-button" onClick={() => go('list')}>
                  返回列表
                </button>
              </Empty>
            )
          ) : (
            <SubscriptionForm
              key={route.id || 'new'}
              subscription={selected}
              busy={busy}
              onCancel={() => (route.id ? openDetail(route.id, route.from) : go('list'))}
              onSave={(input) =>
                void perform(async () => {
                  const item = unwrap(await window.desktop.save(input, route.id))
                  await reload()
                  openDetail(item.id, route.from)
                  setNotice('订阅已保存。')
                })
              }
            />
          )}
          {billTarget && (
            <BillEditor
              key={billTarget.bill?.id || billTarget.subscription.id}
              target={billTarget}
              onClose={() => setBillTarget(null)}
              onSaved={async () => {
                await reload()
                setNotice('账单已保存。')
              }}
            />
          )}
          {priceTarget && (
            <PriceEditor
              subscription={priceTarget}
              onClose={() => setPriceTarget(null)}
              onSaved={async () => {
                await reload()
                setNotice('价格计划已保存。')
              }}
            />
          )}
          {notice && (
            <div className="toast" role="status">
              <Check size={16} />
              {notice}
            </div>
          )}
        </main>
      </div>
    </>
  )
}

function SubscriptionForm({
  subscription: s,
  busy,
  onCancel,
  onSave
}: {
  subscription?: Subscription
  busy: boolean
  onCancel: () => void
  onSave: (input: SubscriptionInput) => void
}) {
  const [error, setError] = useState('')
  const [autoRenew, setAutoRenew] = useState(s?.autoRenew ?? true)
  const [hasAccessDate, setHasAccessDate] = useState(!!s?.accessEndsOn)
  const [icon, setIcon] = useState(s?.icon)
  const [name, setName] = useState(s?.name || '')
  const [pickingIcon, setPickingIcon] = useState(false)
  async function pickIcon() {
    setPickingIcon(true)
    setError('')
    try {
      const value = unwrap(await window.desktop.pickIcon())
      if (value) setIcon(value)
    } catch (e) {
      setError(e instanceof Error ? e.message : '读取图标失败，请重试。')
    } finally {
      setPickingIcon(false)
    }
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy || pickingIcon) return
    const values = new FormData(event.currentTarget)
    const amountMinor = s ? s.amountMinor : parseAmount(String(values.get('amount')))
    if (amountMinor === null) {
      setError('金额请填写最多两位小数，范围为 0—9,999,999.99。')
      return
    }
    const raw = {
      name: values.get('name'),
      icon,
      category: values.get('category'),
      amountMinor,
      currency: s?.currency || values.get('currency'),
      cycle: values.get('cycle'),
      interval: Number(values.get('interval')),
      anchorDate: values.get('anchorDate'),
      status: values.get('status'),
      autoRenew: values.has('autoRenew'),
      accessEndsOn: String(values.get('accessEndsOn') || '').trim() || undefined,
      reminderDays: Number(values.get('reminderDays')),
      website: values.get('website'),
      notes: values.get('notes')
    }
    if (raw.status === 'archived') raw.autoRenew = false
    const result = subscriptionInputSchema.safeParse(raw)
    if (!result.success) {
      setError(result.error.issues.map((i) => i.message).join('；'))
      return
    }
    setError('')
    onSave(result.data)
  }
  return (
    <>
      <header className="page-head form-page-head">
        <button
          className="form-back"
          disabled={busy}
          onClick={onCancel}
          aria-label={s ? '返回订阅详情' : '返回我的订阅'}
          title={s ? '返回订阅详情' : '返回我的订阅'}
        >
          <ArrowLeft size={18} aria-hidden="true" />
        </button>
        <h1>{s ? '编辑订阅' : '新增订阅'}</h1>
      </header>
      <form className="subscription-form panel" onSubmit={submit}>
        <fieldset disabled={busy}>
          <div className="icon-editor">
            <SubscriptionAvatar name={name} icon={icon} large />
            <div className="icon-editor-content">
              <div className="icon-editor-actions">
                <Button
                  size="small"
                  icon={<Upload size={14} />}
                  disabled={busy}
                  loading={pickingIcon}
                  onClick={() => void pickIcon()}
                >
                  {icon ? '更换图标' : '上传图标'}
                </Button>
                {icon && (
                  <Button
                    size="small"
                    type="text"
                    disabled={busy || pickingIcon}
                    onClick={() => setIcon(undefined)}
                  >
                    移除图标
                  </Button>
                )}
              </div>
              <small>PNG / JPG，最大 5 MB · 图片保存在本机</small>
            </div>
          </div>
          <div className="form-grid">
            <label className="full">
              订阅名称
              <Input
                name="name"
                disabled={busy}
                required
                maxLength={80}
                placeholder="例如：音乐会员"
                value={name}
                onChange={(event) => setName(event.target.value)}
                autoFocus
              />
            </label>
            <label>
              金额
              <InputNumber<string>
                name="amount"
                aria-label="金额"
                disabled={busy || !!s}
                inputMode="decimal"
                stringMode
                controls={false}
                changeOnBlur={false}
                min="0"
                max="9999999.99"
                step="0.01"
                required
                title="请输入最多两位小数的非负金额"
                placeholder="0.00"
                defaultValue={s ? (s.amountMinor / 100).toFixed(2) : ''}
              />
            </label>
            <label>
              币种
              <SelectField
                label="币种"
                name="currency"
                defaultValue={s?.currency || 'CNY'}
                disabled={busy || !!s}
                options={currencies.map((c) => ({ value: c, label: currencyNames[c] }))}
              />
            </label>
            <label>
              周期单位
              <SelectField
                label="周期单位"
                name="cycle"
                defaultValue={s?.cycle || 'month'}
                disabled={busy}
                options={[
                  { value: 'month', label: '月' },
                  { value: 'year', label: '年' }
                ]}
              />
            </label>
            <label>
              每隔多少个周期
              <InputNumber
                name="interval"
                aria-label="每隔多少个周期"
                disabled={busy}
                inputMode="numeric"
                changeOnBlur={false}
                min={1}
                max={12}
                step={1}
                required
                defaultValue={s?.interval || 1}
              />
            </label>
            <label>
              计费基准日 / 首次扣款日
              <DatePicker
                name="anchorDate"
                aria-label="计费基准日 / 首次扣款日"
                disabled={busy}
                format="YYYY-MM-DD"
                minDate={dayjs('1970-01-01')}
                maxDate={dayjs('2100-12-31')}
                preserveInvalidOnBlur
                // Hover previews can replace an invalid draft with the previous date on blur.
                previewValue={false}
                onKeyDown={(event) => {
                  // Enter confirms the date without submitting the subscription form.
                  if (event.key === 'Enter') event.preventDefault()
                }}
                suffixIcon={<CalendarDays size={16} aria-hidden="true" />}
                required
                defaultValue={dayjs(s?.anchorDate || localDate())}
              />
            </label>
            <label>
              分类
              <SelectField
                label="分类"
                name="category"
                defaultValue={s?.category || '效率工具'}
                disabled={busy}
                options={categories.map((c) => ({ value: c, label: c }))}
              />
            </label>
            <label>
              订阅阶段
              <SelectField
                label="订阅阶段"
                name="status"
                defaultValue={s?.status || 'active'}
                disabled={busy}
                options={[
                  { value: 'active', label: '付费订阅' },
                  { value: 'trial', label: '免费试用' },
                  { value: 'archived', label: '已归档' }
                ]}
              />
            </label>
            <label>
              提醒时间
              <SelectField
                label="提醒时间"
                name="reminderDays"
                defaultValue={String(s?.reminderDays ?? 3)}
                disabled={busy}
                options={[
                  { value: '0', label: '扣款当天' },
                  ...[1, 3, 7, 14].map((n) => ({ value: String(n), label: `提前 ${n} 天` }))
                ]}
              />
            </label>
            <label className="full">
              服务商网址（可选）
              <Input
                name="website"
                disabled={busy}
                type="url"
                maxLength={2048}
                placeholder="https://"
                defaultValue={s?.website || ''}
              />
            </label>
            <label className="full">
              备注（可选）
              <Input.TextArea
                name="notes"
                disabled={busy}
                maxLength={2000}
                rows={3}
                placeholder="套餐内容、使用频率，或取消续费的位置…"
                defaultValue={s?.notes || ''}
              />
            </label>
          </div>
          {s && (
            <p className="footnote">
              金额与币种请在订阅详情中使用“调整价格”，可设置生效日期并保留历史价格。
            </p>
          )}
          <label className="check-row">
            <Switch
              aria-label="自动续费"
              checked={autoRenew}
              onChange={setAutoRenew}
              disabled={busy}
            />
            {autoRenew && <input name="autoRenew" type="hidden" value="on" />}
            {autoRenew ? '自动续费已开启' : '自动续费已关闭'}
          </label>
          <div className="access-date-field" hidden={autoRenew && !hasAccessDate}>
            <label>
              <span>权益到期日（可选）</span>
              <DatePicker
                name="accessEndsOn"
                aria-label="权益到期日"
                disabled={busy}
                format="YYYY-MM-DD"
                minDate={dayjs('1970-01-01')}
                maxDate={dayjs('2100-12-31')}
                preserveInvalidOnBlur
                previewValue={false}
                defaultValue={s?.accessEndsOn ? dayjs(s.accessEndsOn) : null}
                onChange={(value) => setHasAccessDate(!!value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') event.preventDefault()
                }}
                suffixIcon={<CalendarDays size={16} />}
                placeholder="选择服务可使用至哪一天"
              />
            </label>
            <HelpTip label="权益到期日">
              关闭续费后，服务可能仍可使用到某一天。填写此日期可以查看剩余权益并接收到期提醒；留空时不推算。
            </HelpTip>
          </div>
          <p className="footnote">
            试用订阅请将基准日设为试用结束后的首次扣款日。修改续费开关只影响本地账本，实际取消需到服务商处操作。
          </p>
          {error && (
            <div className="error-banner" role="alert">
              {error}
            </div>
          )}
          <div className="form-actions">
            <Button disabled={busy} onClick={onCancel}>
              {s ? '取消编辑' : '取消'}
            </Button>
            <Button htmlType="submit" type="primary" loading={busy} disabled={pickingIcon}>
              {busy ? '正在保存…' : s ? '保存修改' : '添加订阅'}
            </Button>
          </div>
        </fieldset>
      </form>
    </>
  )
}
