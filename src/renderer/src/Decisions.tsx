import { useState } from 'react'
import { Button, DatePicker, Drawer, Input, Modal, Switch, Tag } from 'antd'
import dayjs from 'dayjs'
import { Check, Clock, ExternalLink } from 'lucide-react'
import type { Subscription, Result } from '../../shared/model'
import { localDate } from '../../shared/billing'
import { decisionInputSchema, decisionNames, frequencyNames } from '../../shared/decision-model'
import type { Decision, DecisionInput, Usage } from '../../shared/decision-model'
import { usageSummary } from '../../shared/decisions'
import { HelpTip, SelectField } from './controls'
const unwrap = <T,>(r: Result<T>): T => {
  if (!r.ok) throw new Error(r.error)
  return r.data
}
export function DecisionPanel({
  subscription,
  decision,
  usage,
  onReload
}: {
  subscription: Subscription
  decision?: Decision
  usage: Usage[]
  onReload: () => Promise<unknown>
}) {
  const [editing, setEditing] = useState(false)
  const { updatedAt, ...initial } = decision ?? {
    updatedAt: '',
    ...decisionInputSchema.parse({ subscriptionId: subscription.id })
  }
  const [draft, setDraft] = useState<DecisionInput>(initial),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [day, setDay] = useState(localDate()),
    [history, setHistory] = useState(false)
  const summary = usageSummary(usage, subscription.id, localDate()),
    usedToday = usage.some((u) => u.subscriptionId === subscription.id && u.day === localDate())
  const patch = (value: Partial<DecisionInput>) => setDraft((d) => ({ ...d, ...value }))
  async function run(work: () => Promise<unknown>) {
    setBusy(true)
    setError('')
    try {
      await work()
      await onReload()
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败。')
    } finally {
      setBusy(false)
    }
  }
  const date = (label: string, field: 'reviewOn' | 'requestedOn' | 'confirmedOn' | 'endsOn') => (
    <label>
      <span>{label}</span>
      <DatePicker
        aria-label={label}
        value={draft[field] ? dayjs(draft[field]) : null}
        format="YYYY-MM-DD"
        previewValue={false}
        onChange={(v) => patch({ [field]: v?.format('YYYY-MM-DD') })}
      />
    </label>
  )
  return (
    <section className="panel spaced decision-panel">
      <div className="panel-head">
        <div className="panel-title">
          <h2>使用与续费决策</h2>
          <HelpTip label="使用记录">
            使用情况由你记录；没有记录不代表没有使用。取消申请确认前仍保留预计扣款。
          </HelpTip>
        </div>
        <Tag>{decisionNames[decision?.decision ?? 'review']}</Tag>
      </div>
      {error && (
        <div role="alert" className="error-banner">
          {error}
        </div>
      )}
      <div className="usage-summary">
        <div>
          <strong>{summary.last ? `最近使用 ${summary.last}` : '尚无使用记录'}</strong>
          <small>近 30 天记录使用 {summary.count} 天</small>
        </div>
        <div className="backup-actions">
          <Button
            icon={<Check size={14} />}
            disabled={busy}
            onClick={() =>
              void run(async () =>
                unwrap(await window.desktop.usageRecord(subscription.id, localDate(), usedToday))
              )
            }
          >
            {usedToday ? '撤销今天的记录' : '今天用过'}
          </Button>
          <Button type="text" onClick={() => setHistory(true)}>
            补记与历史
          </Button>
          <Button onClick={() => setEditing(true)}>管理决策与取消</Button>
        </div>
      </div>
      <div className="decision-summary">
        <span>{frequencyNames[decision?.frequency ?? 'unknown']}</span>
        {decision?.reviewOn && <span>下次评估 {decision.reviewOn}</span>}
        {decision?.cancellation !== 'none' && decision?.cancellation && (
          <span>{decision.cancellation === 'confirmed' ? '已确认停止续费' : '取消申请待确认'}</span>
        )}
        {decision?.reason && <p>{decision.reason}</p>}
      </div>
      <Drawer
        title="续费决策与取消跟进"
        open={editing}
        onClose={() => {
          if (!busy) setEditing(false)
        }}
        size={570}
        closable={{ 'aria-label': '关闭续费决策' }}
      >
        {error && (
          <div className="error-banner" role="alert">
            {error}
          </div>
        )}
        <div className="decision-fields">
          <label>
            <span>使用频率</span>
            <SelectField
              label="使用频率"
              value={draft.frequency}
              onChange={(v) => patch({ frequency: v as DecisionInput['frequency'] })}
              options={Object.entries(frequencyNames).map(([value, label]) => ({ value, label }))}
            />
          </label>
          <label>
            <span>续费决定</span>
            <SelectField
              label="续费决定"
              value={draft.decision}
              onChange={(v) => patch({ decision: v as DecisionInput['decision'] })}
              options={Object.entries(decisionNames).map(([value, label]) => ({ value, label }))}
            />
          </label>
          {date('下次评估日期', 'reviewOn')}
          <label>
            <span>未记录使用提醒</span>
            <SelectField
              label="未记录使用提醒"
              value={String(draft.idleDays)}
              onChange={(v) => patch({ idleDays: Number(v) as 30 | 60 | 90 })}
              options={[30, 60, 90].map((n) => ({ value: String(n), label: `${n} 天` }))}
            />
          </label>
          <label className="field-wide">
            <span>决策备注</span>
            <Input.TextArea
              aria-label="决策备注"
              value={draft.reason}
              maxLength={2000}
              autoSize={{ minRows: 2, maxRows: 4 }}
              onChange={(e) => patch({ reason: e.target.value })}
            />
          </label>
        </div>
        <div className="decision-cancellation">
          <div className="panel-head">
            <h3>取消与到期跟进</h3>
            <small className="muted">
              {draft.cancellation === 'confirmed'
                ? '已确认停止续费'
                : draft.cancellation === 'requested'
                  ? '等待服务商确认'
                  : '尚未申请取消'}
            </small>
          </div>
          <div className="decision-fields">
            <label>
              <span>取消进度</span>
              <SelectField
                label="取消进度"
                value={draft.cancellation}
                onChange={(v) =>
                  patch({
                    cancellation: v as DecisionInput['cancellation'],
                    autoArchive: v === 'confirmed' ? draft.autoArchive : false,
                    ...(v === 'requested' && !draft.requestedOn
                      ? { requestedOn: localDate() }
                      : {}),
                    ...(v === 'confirmed' && !draft.confirmedOn ? { confirmedOn: localDate() } : {})
                  })
                }
                options={[
                  { value: 'none', label: '尚未申请' },
                  { value: 'requested', label: '已提交取消申请' },
                  { value: 'confirmed', label: '已确认停止续费' }
                ]}
              />
            </label>
            {date('权益结束日期', 'endsOn')}
            {date('申请取消日期', 'requestedOn')}
            {date('确认取消日期', 'confirmedOn')}
            <label className="field-wide">
              <span>服务商取消入口</span>
              <Input
                aria-label="服务商取消入口"
                placeholder="https://…"
                maxLength={2048}
                value={draft.cancellationUrl}
                onChange={(e) => patch({ cancellationUrl: e.target.value })}
                suffix={
                  draft.cancellationUrl ? (
                    <Button
                      type="text"
                      size="small"
                      aria-label="打开取消入口"
                      icon={<ExternalLink size={14} />}
                      onClick={() =>
                        void run(async () =>
                          unwrap(await window.desktop.openWebsite(draft.cancellationUrl))
                        )
                      }
                    />
                  ) : null
                }
              />
            </label>
            <label className="field-wide">
              <span>取消备注</span>
              <Input.TextArea
                aria-label="取消备注"
                value={draft.cancellationNotes}
                maxLength={2000}
                autoSize={{ minRows: 1, maxRows: 3 }}
                onChange={(e) => patch({ cancellationNotes: e.target.value })}
              />
            </label>
          </div>
          <div className="setting-row">
            <span>
              权益结束后自动归档<small>确认停止续费并填写结束日期后可用；归档保留历史账单。</small>
            </span>
            <Switch
              aria-label="权益结束后自动归档"
              checked={draft.autoArchive}
              disabled={draft.cancellation !== 'confirmed' || !draft.endsOn}
              onChange={(v) => patch({ autoArchive: v })}
            />
          </div>
          {draft.cancellation === 'confirmed' && subscription.autoRenew && (
            <p className="footnote">保存后关闭自动续费，停止后续预测。已支付账单保留。</p>
          )}
        </div>
        <div className="backup-actions">
          <Button
            type="primary"
            loading={busy}
            aria-label="保存使用与决策"
            onClick={() =>
              void run(async () =>
                unwrap(await window.desktop.decisionSave(decisionInputSchema.parse(draft)))
              )
            }
          >
            保存使用与决策
          </Button>
          <span className="small muted">
            <Clock size={13} /> 续费决定可随时调整
          </span>
        </div>
      </Drawer>
      <Modal
        title="使用记录"
        open={history}
        onCancel={() => setHistory(false)}
        footer={null}
        destroyOnHidden
      >
        <div className="backup-actions">
          <DatePicker
            aria-label="补记使用日期"
            value={dayjs(day)}
            previewValue={false}
            disabledDate={(d) => d.format('YYYY-MM-DD') > localDate()}
            onChange={(v) => v && setDay(v.format('YYYY-MM-DD'))}
          />
          <Button
            disabled={busy}
            onClick={() =>
              void run(async () => unwrap(await window.desktop.usageRecord(subscription.id, day)))
            }
          >
            补记使用
          </Button>
        </div>
        <div className="usage-history">
          {usage
            .filter((u) => u.subscriptionId === subscription.id)
            .sort((a, b) => b.day.localeCompare(a.day))
            .map((u) => (
              <div key={u.id}>
                <span>{u.day}</span>
                <Button
                  type="text"
                  size="small"
                  disabled={busy}
                  aria-label={`删除 ${u.day} 使用记录`}
                  onClick={() =>
                    void run(async () =>
                      unwrap(await window.desktop.usageRecord(subscription.id, u.day, true))
                    )
                  }
                >
                  撤销
                </Button>
              </div>
            ))}
        </div>
      </Modal>
    </section>
  )
}
