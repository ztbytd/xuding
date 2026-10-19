import { useCallback, useEffect, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { Switch } from 'antd'
import {
  Archive,
  ArrowLeft,
  ArrowRight,
  Bell,
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  Layers,
  LayoutDashboard,
  Pencil,
  Plus,
  Repeat2,
  Search,
  Settings as SettingsIcon,
  ShieldCheck,
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
  SubscriptionInput
} from '../../shared/model'
import {
  addDays,
  cycleLabel,
  daysBetween,
  forecast,
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
function BillRows({ bills, onOpen }: { bills: Bill[]; onOpen: (id: string) => void }) {
  return (
    <div>
      {bills.map((b) => (
        <button
          className="subscription-row"
          key={`${b.subscription.id}-${b.due}`}
          onClick={() => onOpen(b.subscription.id)}
          aria-label={`查看 ${b.subscription.name} 详情`}
        >
          <span className="avatar">{b.subscription.name.slice(0, 1)}</span>
          <span className="row-info">
            <strong>{b.subscription.name}</strong>
            <small>
              {formatDate(b.due)} ·{' '}
              {daysBetween(localDate(), b.due) === 0
                ? '今天'
                : `${daysBetween(localDate(), b.due)}天后`}
            </small>
          </span>
          <span className="row-price">
            <strong>{formatMoney(b.amountMinor, b.subscription.currency)}</strong>
            <small>{cycleLabel(b.subscription)}</small>
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

  const reload = useCallback(async () => {
    const value = unwrap(await window.desktop.load())
    setSnapshot(value)
    return value
  }, [])
  useEffect(() => {
    void reload().catch((e) => setError(String(e.message)))
    const timer = setInterval(() => setToday(localDate()), 30_000)
    return () => clearInterval(timer)
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
        onChange={(value) => setCurrency(value as Currency)}
        options={currencies.map((c) => ({ value: c, label: currencyNames[c] }))}
      />
    </label>
  )

  function overview() {
    const summary = totals(data, currency, today)
    const trial = summary.bills.find(
      (b) =>
        b.subscription.status === 'trial' &&
        b.due === b.subscription.anchorDate &&
        daysBetween(today, b.due) <= 7
    )
    return (
      <>
        <header className="page-head">
          <div>
            <h1>每一笔订阅，心里有数。</h1>
            <p>{formatDate(today)} · 把持续支出看清楚</p>
          </div>
          {currencyPicker}
        </header>
        <div className="stats">
          <div className="stat featured">
            <div className="stat-heading">
              <span>月均费用</span>
              <small>按当前价格折算</small>
            </div>
            <strong>{formatMoney(summary.monthly, currency)}</strong>
          </div>
          <div className="stat">
            <div className="stat-heading">
              <span>年度折算费用</span>
              <small>
                {summary.count} 项自动续费 · {currency}
              </small>
            </div>
            <strong>{formatMoney(summary.annual, currency)}</strong>
          </div>
          <div className="stat">
            <div className="stat-heading">
              <span>未来 30 天预计扣款</span>
              <small title={`${today} 至 ${addDays(today, 29)}`}>
                {today.slice(5)} — {addDays(today, 29).slice(5)}
              </small>
            </div>
            <strong>{formatMoney(summary.upcoming, currency)}</strong>
          </div>
        </div>
        {trial && (
          <div className="notice-banner">
            <Bell size={18} />
            <span>
              {trial.subscription.name} 将于 {formatDate(trial.due)} 结束试用，预计扣款{' '}
              {formatMoney(trial.amountMinor, currency)}
            </span>
            <button
              className="text-button"
              onClick={() => openDetail(trial.subscription.id, 'overview')}
            >
              查看详情
              <ArrowRight size={14} />
            </button>
          </div>
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
                onOpen={(id) => openDetail(id, 'overview')}
              />
            ) : (
              <Empty>
                {data.length ? (
                  '当前币种下，近期没有预计扣款。'
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
          <Panel title="钱花在哪儿" extra={<span className="muted small">月均 · {currency}</span>}>
            {categories.map((c) => {
              const amount = data
                .filter((s) => isRenewing(s) && s.currency === currency && s.category === c)
                .reduce((n, s) => n + monthlyMinor(s), 0)
              return (
                amount > 0 && (
                  <div className="bar-row" key={c}>
                    <div>
                      <span>{c}</span>
                      <span>{formatMoney(Math.round(amount), currency)}</span>
                    </div>
                    <div className="bar-track">
                      <div
                        style={{
                          width: `${Math.min(100, (amount / Math.max(1, summary.monthly)) * 100)}%`
                        }}
                      />
                    </div>
                  </div>
                )
              )
            })}
            {!summary.monthly && <Empty>添加订阅后，分类支出会显示在这里。</Empty>}
          </Panel>
        </div>
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
          <label className="search-field">
            <Search size={17} />
            <input
              aria-label="搜索订阅"
              placeholder="搜索订阅名称…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
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
            const next = nextBills(s, today, 1)[0]
            return (
              <button
                className="subscription-row"
                key={s.id}
                onClick={() => openDetail(s.id, 'list')}
                aria-label={`查看 ${s.name} 详情`}
              >
                <span className="avatar">{s.name.slice(0, 1)}</span>
                <span className="row-info">
                  <strong>{s.name}</strong>
                  <small>
                    {s.category} · {next ? `${formatDate(next.due)} 预计扣款` : '暂无续费计划'}
                  </small>
                </span>
                <Status subscription={s} />
                <span className="row-price">
                  <strong>{formatMoney(s.amountMinor, s.currency)}</strong>
                  <small>{cycleLabel(s)}</small>
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
    const bills = nextBills(s, today),
      next = bills[0]
    return (
      <>
        <button className="back" onClick={() => go(from)}>
          <ArrowLeft size={16} />
          返回{pageNames[from]}
        </button>
        <header className="page-head">
          <div className="detail-title">
            <span className="avatar large">{s.name.slice(0, 1)}</span>
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
          <Panel title="费用与周期">
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
                <dt>下次预计金额</dt>
                <dd>{next ? formatMoney(next.amountMinor, s.currency) : '—'}</dd>
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
        <Panel
          title="接下来三期"
          extra={<span className="small muted">预计扣款</span>}
          className="spaced"
        >
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
                <strong>{formatMoney(bill.amountMinor, s.currency)}</strong>
              </div>
            ))
          ) : (
            <Empty>没有后续扣款计划。</Empty>
          )}
        </Panel>
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
              <p>记录会保留，并从费用统计和扣款计划中移除。服务商处的实际续费需另行取消。</p>
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
    const bills = forecast(data, first, end, currency),
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
            <p>提前看见每一笔计划中的支出</p>
          </div>
          {currencyPicker}
        </header>
        <div className="panel">
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
            <button
              className="secondary"
              onClick={() => {
                setMonth(today.slice(0, 7))
                setSelectedDate(null)
              }}
            >
              本月
            </button>
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
                items = bills.filter((b) => b.due === date)
              return (
                <button
                  key={date}
                  className={`day ${date === today ? 'today' : ''} ${items.length ? 'has-bills' : ''}`}
                  aria-pressed={selectedDate === date}
                  aria-label={`${date}，${items.length}笔预计扣款`}
                  onClick={() => setSelectedDate(selectedDate === date ? null : date)}
                >
                  <span>{i + 1}</span>
                  {items.length > 0 && (
                    <>
                      <strong>
                        {formatMoney(
                          items.reduce((n, b) => n + b.amountMinor, 0),
                          currency
                        )}
                      </strong>
                      <small>{items.length} 项订阅</small>
                    </>
                  )}
                </button>
              )
            })}
          </div>
        </div>
        <Panel
          className="spaced"
          title={selectedDate ? `${formatDate(selectedDate)}的扣款` : '本月扣款计划'}
          extra={
            <span className="small muted">
              合计{' '}
              {formatMoney(
                shown.reduce((n, b) => n + b.amountMinor, 0),
                currency
              )}
            </span>
          }
        >
          {shown.length ? (
            <BillRows bills={shown} onOpen={(id) => openDetail(id, 'calendar')} />
          ) : (
            <Empty>所选日期没有预计扣款。</Empty>
          )}
        </Panel>
      </>
    )
  }
  function settings() {
    return (
      <>
        <header className="page-head">
          <div>
            <h1>设置与备份</h1>
            <p>数据留在本机，由你掌握。</p>
          </div>
          <ShieldCheck className="muted" size={28} />
        </header>
        <Panel
          title="桌面提醒"
          help="关闭应用或电脑休眠期间不会发送通知。系统关闭通知时也可能收不到提醒。"
        >
          <div className="setting-row">
            <span>
              <strong>到期通知</strong>
              <small>应用运行时，按每项订阅的提前天数发送系统通知，每期最多一次。</small>
            </span>
            <Switch
              aria-label="开启桌面通知"
              checked={snapshot?.settings.notificationsEnabled || false}
              disabled={busy}
              onChange={(enabled) => {
                void perform(async () => {
                  unwrap(await window.desktop.settings({ notificationsEnabled: enabled }))
                  await reload()
                  setNotice(enabled ? '已开启桌面通知。' : '已关闭桌面通知。')
                })
              }}
            />
          </div>
        </Panel>
        <Panel
          title="数据备份"
          className="spaced"
          help="本地数据库与备份均未加密，建议将备份保存在可信位置。"
        >
          <div className="setting-row">
            <span>
              <strong>导出订阅</strong>
              <small>导出 JSON 文件，包含订阅信息和备注，不包含修改历史。</small>
            </span>
            <button
              className="secondary"
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  if (unwrap(await window.desktop.exportBackup())) setNotice('备份已导出。')
                })
              }
            >
              <Download size={16} />
              导出备份
            </button>
          </div>
          <div className="setting-row">
            <span>
              <strong>导入备份</strong>
              <small>相同 ID 的订阅会覆盖，其他订阅保留。导入前会再次确认。</small>
            </span>
            <button
              className="secondary"
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  const count = unwrap(await window.desktop.importBackup())
                  if (count !== null) {
                    await reload()
                    setNotice(`已导入 ${count} 项订阅。`)
                  }
                })
              }
            >
              <Upload size={16} />
              导入备份
            </button>
          </div>
        </Panel>
        <Panel title="关于续订" className="spaced">
          <p className="notes">一个本地优先的开源订阅账本。支持离线使用，无需账号。</p>
          <dl className="facts">
            <div>
              <dt>版本</dt>
              <dd>{snapshot?.version}</dd>
            </div>
            <div>
              <dt>开源许可</dt>
              <dd>MIT</dd>
            </div>
            <div>
              <dt>数据存储</dt>
              <dd>本机 SQLite 数据库</dd>
            </div>
          </dl>
        </Panel>
      </>
    )
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
              <Repeat2 size={22} />
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
        <main className="main">
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
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const values = new FormData(event.currentTarget)
    const amountMinor = parseAmount(String(values.get('amount')))
    if (amountMinor === null) {
      setError('金额请填写最多两位小数，范围为 0—9,999,999.99。')
      return
    }
    const raw = {
      name: values.get('name'),
      category: values.get('category'),
      amountMinor,
      currency: values.get('currency'),
      cycle: values.get('cycle'),
      interval: Number(values.get('interval')),
      anchorDate: values.get('anchorDate'),
      status: values.get('status'),
      autoRenew: values.has('autoRenew'),
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
      <button className="back" disabled={busy} onClick={onCancel}>
        <ArrowLeft size={16} />
        {s ? '返回订阅详情' : '返回我的订阅'}
      </button>
      <header className="page-head">
        <div>
          <h1>{s ? '编辑订阅' : '新增订阅'}</h1>
          <p>{s ? '更新账本信息，未来扣款计划会同步调整。' : '从下一笔扣款开始，记录这份订阅。'}</p>
        </div>
      </header>
      <form className="subscription-form panel" onSubmit={submit}>
        <fieldset disabled={busy}>
          <h2>订阅信息</h2>
          <div className="form-grid">
            <label className="full">
              订阅名称
              <input
                name="name"
                required
                maxLength={80}
                placeholder="例如：音乐会员"
                defaultValue={s?.name || ''}
                autoFocus
              />
            </label>
            <label>
              金额
              <input
                name="amount"
                inputMode="decimal"
                required
                pattern="[0-9]{1,7}(\.[0-9]{1,2})?"
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
                disabled={busy}
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
              <input
                name="interval"
                type="number"
                min={1}
                max={12}
                step={1}
                required
                defaultValue={s?.interval || 1}
              />
            </label>
            <label>
              计费基准日 / 首次扣款日
              <input
                name="anchorDate"
                type="date"
                min="1970-01-01"
                max="2100-12-31"
                required
                defaultValue={s?.anchorDate || localDate()}
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
              <input
                name="website"
                type="url"
                maxLength={2048}
                placeholder="https://"
                defaultValue={s?.website || ''}
              />
            </label>
            <label className="full">
              备注（可选）
              <textarea
                name="notes"
                maxLength={2000}
                rows={3}
                placeholder="套餐内容、使用频率，或取消续费的位置…"
                defaultValue={s?.notes || ''}
              />
            </label>
          </div>
          <label className="check-row">
            <Switch
              aria-label="自动续费已开启"
              checked={autoRenew}
              onChange={setAutoRenew}
              disabled={busy}
            />
            {autoRenew && <input name="autoRenew" type="hidden" value="on" />}
            自动续费已开启
          </label>
          <p className="footnote">
            试用订阅请将基准日设为试用结束后的首次扣款日。修改续费开关只影响本地账本，实际取消需到服务商处操作。
          </p>
          {error && (
            <div className="error-banner" role="alert">
              {error}
            </div>
          )}
          <div className="form-actions">
            <button type="button" className="secondary" onClick={onCancel}>
              {s ? '取消编辑' : '取消'}
            </button>
            <button type="submit" className="primary">
              {busy ? '正在保存…' : s ? '保存修改' : '添加订阅'}
            </button>
          </div>
        </fieldset>
      </form>
    </>
  )
}
