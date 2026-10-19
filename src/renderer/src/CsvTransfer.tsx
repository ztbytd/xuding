import { useState } from 'react'
import type { FormEvent } from 'react'
import { Button, Collapse, Input, InputNumber, Modal, Steps, Table } from 'antd'
import { Download, FileSpreadsheet, Upload } from 'lucide-react'
import type { Snapshot, SubscriptionInput, Currency } from '../../shared/model'
import { categories, currencies, subscriptionInputSchema } from '../../shared/model'
import { autoMapping } from '../../shared/csv'
import { billFields, fieldLabels, subscriptionFields } from '../../shared/csv-model'
import type {
  CsvDecision,
  CsvField,
  CsvFile,
  CsvKind,
  CsvOptions,
  CsvPreview,
  CsvPreviewRow
} from '../../shared/csv-model'
import { localDate, parseAmount } from '../../shared/billing'
import { SelectField } from './controls'
import type { ImportBatch } from '../../shared/analytics-model'

function unwrap<T>(r: { ok: true; data: T } | { ok: false; error: string }): T {
  if (!r.ok) throw new Error(r.error)
  return r.data
}
const rowLabels = {
  new: '新增',
  update: '更新',
  duplicate: '重复，默认跳过',
  error: '需要处理',
  skipped: '已排除'
}
export type ExportContext = { subscriptionIds?: string[]; billIds?: string[]; kind?: CsvKind }
export function CsvExportDialog({
  context,
  currency,
  onClose,
  onNotice
}: {
  context: ExportContext
  currency: Currency
  onClose: () => void
  onNotice: (message: string) => void
}) {
  const [kind, setKind] = useState<CsvKind>(context.kind ?? 'bills'),
    [scope, setScope] = useState(
      (context.kind === 'subscriptions' ? context.subscriptionIds : context.billIds)
        ? 'filtered'
        : 'all'
    ),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  async function save(template = false) {
    setBusy(true)
    setError('')
    try {
      const saved = unwrap(
        await window.desktop.csvExport({
          kind,
          currency,
          template,
          ids:
            !template && scope === 'filtered'
              ? kind === 'subscriptions'
                ? context.subscriptionIds
                : context.billIds
              : undefined
        })
      )
      if (saved) {
        onNotice(template ? 'CSV 模板已保存。' : 'CSV 已导出。')
        if (!template) onClose()
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '导出失败。')
    } finally {
      setBusy(false)
    }
  }
  const filtered = kind === 'subscriptions' ? context.subscriptionIds : context.billIds
  return (
    <Modal open title="导出 CSV" onCancel={() => !busy && onClose()} footer={null} width={480}>
      <div className="ledger-form">
        <label>
          数据类型
          <SelectField
            label="导出数据类型"
            value={kind}
            onChange={(v) => {
              setKind(v as CsvKind)
              setScope('all')
            }}
            options={[
              { value: 'subscriptions', label: '订阅清单' },
              { value: 'bills', label: '账单记录' }
            ]}
            disabled={busy}
          />
        </label>
        <label>
          导出范围
          <SelectField
            label="导出范围"
            value={scope}
            onChange={setScope}
            options={[
              { value: 'all', label: '全部记录' },
              ...(filtered
                ? [{ value: 'filtered', label: `当前筛选结果（${filtered.length} 项）` }]
                : [])
            ]}
            disabled={busy}
          />
        </label>
        <p className="footnote">
          本次导出{scope === 'filtered' ? `当前筛选的 ${filtered?.length ?? 0} 项` : '全部记录'}。
          UTF-8 编码，兼容 Excel 中文。账单保留原币与实际金额，并附 {currency}{' '}
          折算金额及参考日期。完整数据恢复请使用 JSON 备份。
        </p>
        {error && (
          <div role="alert" className="error-banner">
            {error}
          </div>
        )}
        <div className="form-actions">
          <Button onClick={() => void save(true)} disabled={busy}>
            下载导入模板
          </Button>
          <Button
            type="primary"
            loading={busy}
            icon={<Download size={14} />}
            onClick={() => void save()}
          >
            导出 CSV
          </Button>
        </div>
      </div>
    </Modal>
  )
}

function RowEditor({
  row,
  options,
  snapshot,
  onClose,
  onSave
}: {
  row: CsvPreviewRow
  options: CsvOptions
  snapshot: Snapshot
  onClose: () => void
  onSave: (decision: CsvDecision) => void
}) {
  const existing = options.decisions.find((d) => d.row === row.row)
  const [action, setAction] = useState<CsvDecision['action']>(existing?.action ?? 'auto'),
    [link, setLink] = useState(
      existing?.createSubscription
        ? 'create'
        : (existing?.subscriptionId ??
            (options.kind === 'bills'
              ? row.values.subscriptionId ||
                (row.candidates?.length === 1 ? row.candidates[0].id : '')
              : (row.matchedId ?? '')))
    ),
    [error, setError] = useState('')
  const fields = options.kind === 'subscriptions' ? subscriptionFields : billFields
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const data = new FormData(event.currentTarget),
      corrections: Record<string, string> = {}
    for (const field of fields) corrections[field] = String(data.get('correction:' + field) ?? '')
    let createSubscription: SubscriptionInput | undefined
    if (link === 'create') {
      const result = subscriptionInputSchema.safeParse({
        name: data.get('createName'),
        amountMinor: parseAmount(String(data.get('createAmount'))),
        currency: data.get('createCurrency'),
        category: data.get('createCategory'),
        cycle: data.get('createCycle'),
        interval: Number(data.get('createInterval')),
        anchorDate: data.get('createAnchor'),
        status: 'active',
        autoRenew: false,
        reminderDays: 3,
        website: '',
        notes: ''
      })
      if (!result.success) {
        setError(result.error.issues.map((i) => i.message).join('；'))
        return
      }
      createSubscription = result.data
    }
    onSave({
      row: row.row,
      action,
      subscriptionId: link && link !== 'create' ? link : undefined,
      corrections,
      createSubscription
    })
  }
  const defaults = existing?.createSubscription as SubscriptionInput | undefined
  return (
    <Modal
      open
      title={`处理第 ${row.row} 行`}
      onCancel={onClose}
      footer={null}
      width={680}
      zIndex={1200}
    >
      <form className="ledger-form row-editor" onSubmit={submit}>
        <p className="footnote">{row.message}。修改只影响本次导入预览。</p>
        <div className="form-grid">
          <label>
            处理方式
            <SelectField
              label="行处理方式"
              value={action}
              onChange={(v) => setAction(v as CsvDecision['action'])}
              options={[
                { value: 'auto', label: '自动检查，重复项跳过' },
                { value: 'skip', label: '排除此行' },
                { value: 'new', label: '明确新增一条记录' },
                { value: 'update', label: '更新匹配的已有记录' }
              ]}
            />
          </label>
          <label>
            {options.kind === 'bills' ? '关联订阅' : '更新目标订阅'}
            <SelectField
              label="行关联订阅"
              value={link}
              onChange={setLink}
              options={[
                {
                  value: '',
                  label: options.kind === 'bills' ? '按 ID 或名称匹配' : '按 ID 或名称匹配'
                },
                ...snapshot.subscriptions.map((s) => ({ value: s.id, label: s.name })),
                ...(options.kind === 'bills'
                  ? [{ value: 'create', label: '创建新订阅并关联' }]
                  : [])
              ]}
            />
          </label>
        </div>
        {link === 'create' && (
          <div className="csv-create-subscription">
            <strong>新订阅信息</strong>
            <div className="form-grid">
              <label>
                订阅名称
                <Input
                  name="createName"
                  aria-label="新关联订阅名称"
                  defaultValue={defaults?.name ?? row.values.name}
                  required
                />
              </label>
              <label>
                单期金额
                <InputNumber<string>
                  name="createAmount"
                  aria-label="新关联订阅金额"
                  stringMode
                  controls={false}
                  changeOnBlur={false}
                  defaultValue={
                    defaults ? String(defaults.amountMinor / 100) : (row.values.amount ?? '0')
                  }
                  min="0"
                  max="9999999.99"
                  required
                />
              </label>
              <label>
                币种
                <SelectField
                  label="新关联订阅币种"
                  name="createCurrency"
                  defaultValue={defaults?.currency ?? options.defaults.currency}
                  options={currencies.map((c) => ({ value: c, label: c }))}
                />
              </label>
              <label>
                分类
                <SelectField
                  label="新关联订阅分类"
                  name="createCategory"
                  defaultValue={defaults?.category ?? options.defaults.category}
                  options={categories.map((c) => ({ value: c, label: c }))}
                />
              </label>
              <label>
                周期
                <SelectField
                  label="新关联订阅周期"
                  name="createCycle"
                  defaultValue={defaults?.cycle ?? 'month'}
                  options={[
                    { value: 'month', label: '月' },
                    { value: 'year', label: '年' }
                  ]}
                />
              </label>
              <label>
                间隔
                <InputNumber
                  name="createInterval"
                  controls={false}
                  min={1}
                  max={12}
                  defaultValue={defaults?.interval ?? 1}
                  required
                />
              </label>
              <label className="full">
                计费基准日
                <Input
                  name="createAnchor"
                  aria-label="新关联订阅基准日"
                  placeholder="YYYY-MM-DD"
                  defaultValue={defaults?.anchorDate ?? localDate()}
                  required
                />
              </label>
            </div>
            <p className="footnote">新订阅默认关闭自动续费，导入后可在详情中设置。</p>
          </div>
        )}
        <div className="form-grid">
          {fields.map((field) => (
            <label key={field}>
              {fieldLabels[field]}
              <Input
                name={'correction:' + field}
                aria-label={`修正${fieldLabels[field]}`}
                defaultValue={row.values[field] ?? ''}
                placeholder="可留空以使用默认设置"
              />
            </label>
          ))}
        </div>
        {error && (
          <div role="alert" className="error-banner">
            {error}
          </div>
        )}
        <div className="form-actions">
          <Button onClick={onClose}>取消</Button>
          <Button type="primary" htmlType="submit">
            应用并重新检查
          </Button>
        </div>
      </form>
    </Modal>
  )
}

export function CsvImportWizard({
  snapshot,
  onClose,
  onImported
}: {
  snapshot: Snapshot
  onClose: () => void
  onImported: () => Promise<unknown>
}) {
  const today = localDate(),
    [step, setStep] = useState(0),
    [file, setFile] = useState<CsvFile | null>(null),
    [kind, setKind] = useState<CsvKind>('subscriptions'),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [preview, setPreview] = useState<CsvPreview | null>(null),
    [editing, setEditing] = useState<CsvPreviewRow | null>(null),
    [filter, setFilter] = useState('all'),
    [batch, setBatch] = useState<ImportBatch | null>(null)
  const [options, setOptions] = useState<CsvOptions>({
    fileToken: '',
    kind: 'subscriptions',
    mapping: {},
    dateOrder: 'YMD',
    conversion: 'none',
    defaults: {
      currency: 'CNY',
      category: '效率工具',
      cycle: 'month',
      interval: 1,
      anchorDate: today,
      autoRenew: true,
      status: 'active'
    },
    priceEffectiveOn: today,
    decisions: []
  })
  async function run(work: () => Promise<void>) {
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
  async function choose() {
    await run(async () => {
      const selected = unwrap(await window.desktop.csvChoose())
      if (selected) {
        setFile(selected)
        setOptions((p) => ({
          ...p,
          fileToken: selected.token,
          kind,
          mapping: autoMapping(selected.headers, kind),
          decisions: []
        }))
        setPreview(null)
      }
    })
  }
  const fields = kind === 'subscriptions' ? subscriptionFields : billFields
  const setDefault = (key: keyof CsvOptions['defaults'], value: string | number | boolean) =>
    setOptions((p) => ({ ...p, defaults: { ...p.defaults, [key]: value } }))
  async function check(next = options) {
    await run(async () => {
      const result = unwrap(await window.desktop.csvPreview(next))
      setOptions(next)
      setPreview(result)
      setStep(2)
    })
  }
  function decide(decision: CsvDecision) {
    const next = {
      ...options,
      decisions: [...options.decisions.filter((d) => d.row !== decision.row), decision]
    }
    setEditing(null)
    void check(next)
  }
  async function commit() {
    if (!preview) return
    await run(async () => {
      const result = unwrap(await window.desktop.csvCommit(preview.token))
      setBatch(result)
      await onImported()
      setStep(3)
    })
  }
  return (
    <Modal
      open
      title="导入 CSV"
      onCancel={() => !busy && onClose()}
      footer={null}
      width={960}
      maskClosable={false}
      closable={!busy}
      keyboard={!busy}
      className="csv-wizard"
    >
      <Steps
        size="small"
        current={step}
        items={[
          { title: '选择文件' },
          { title: '匹配字段' },
          { title: '检查预览' },
          { title: '完成' }
        ]}
      />
      <div className="csv-wizard-body">
        {step === 0 && (
          <>
            <div className="csv-kind">
              <label>
                导入类型
                <SelectField
                  label="CSV 导入类型"
                  value={kind}
                  onChange={(v) => {
                    const next = v as CsvKind
                    setKind(next)
                    setOptions((p) => ({
                      ...p,
                      kind: next,
                      mapping: file ? autoMapping(file.headers, next) : {},
                      decisions: []
                    }))
                  }}
                  disabled={busy}
                  options={[
                    { value: 'subscriptions', label: '订阅清单' },
                    { value: 'bills', label: '账单记录' }
                  ]}
                />
              </label>
              <Button icon={<Upload size={16} />} onClick={() => void choose()} loading={busy}>
                {file ? '重新选择文件' : '选择 CSV 文件'}
              </Button>
            </div>
            <p className="footnote">
              支持 CSV / TSV、UTF-8 与 GB18030 编码，最多 10 MB / 10,000
              行。先导入订阅清单，再导入账单；账单也可在预览中关联新订阅。
            </p>
            <div className="csv-templates">
              {(['subscriptions', 'bills'] as const).map((type) => (
                <Button
                  key={type}
                  type="link"
                  icon={<Download size={14} />}
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      unwrap(
                        await window.desktop.csvExport({
                          kind: type,
                          currency: 'CNY',
                          template: true
                        })
                      )
                    })
                  }
                >
                  下载{type === 'subscriptions' ? '订阅' : '账单'}模板
                </Button>
              ))}
            </div>
            {file && (
              <>
                <div className="csv-file-summary">
                  <FileSpreadsheet size={20} />
                  <strong>{file.name}</strong>
                  <span>
                    {file.rows.length} 行 · {file.headers.length} 列
                  </span>
                  <SelectField
                    label="CSV 文件编码"
                    value={file.encoding}
                    options={[
                      { value: 'utf-8', label: 'UTF-8' },
                      { value: 'gb18030', label: 'GB18030' }
                    ]}
                    disabled={busy}
                    onChange={(encoding) =>
                      void run(async () => {
                        const decoded = unwrap(
                          await window.desktop.csvDecode(
                            file.token,
                            encoding as 'utf-8' | 'gb18030'
                          )
                        )
                        setFile(decoded)
                        setOptions((p) => ({
                          ...p,
                          mapping: autoMapping(decoded.headers, kind),
                          decisions: []
                        }))
                      })
                    }
                  />
                </div>
                <Table
                  size="small"
                  rowKey={(_, index) => String(index)}
                  dataSource={file.rows.slice(0, 5)}
                  pagination={false}
                  scroll={{ x: 'max-content' }}
                  columns={file.headers.map((header, index) => ({
                    title: header || `第 ${index + 1} 列`,
                    key: String(index),
                    render: (_, row) => (
                      <span className="csv-cell" title={row[index]}>
                        {row[index]}
                      </span>
                    )
                  }))}
                />
              </>
            )}
          </>
        )}
        {step === 1 && file && (
          <>
            <p className="footnote">
              将表格列对应到应用字段。订阅名称、金额，以及已支付账单的应扣日期、实际金额、支付日期需要提供；空币种等字段使用下方明确设置的默认值。
            </p>
            <div className="csv-mapping-grid">
              {fields.map((field) => (
                <label key={field}>
                  {fieldLabels[field]}
                  <SelectField
                    label={`映射${fieldLabels[field]}`}
                    value={
                      options.mapping[field] === undefined ? '' : String(options.mapping[field])
                    }
                    disabled={busy}
                    options={[
                      { value: '', label: '不映射 / 使用默认值' },
                      ...file.headers.map((header, index) => ({
                        value: String(index),
                        label: `${index + 1}. ${header || '未命名列'}`
                      }))
                    ]}
                    onChange={(v) =>
                      setOptions((p) => {
                        const mapping = { ...p.mapping }
                        if (v === '') delete mapping[field]
                        else mapping[field] = Number(v)
                        return { ...p, mapping }
                      })
                    }
                  />
                </label>
              ))}
            </div>
            <Collapse
              className="csv-defaults"
              defaultActiveKey={['defaults']}
              items={[
                {
                  key: 'defaults',
                  label: '日期、币种与缺失字段的默认设置',
                  children: (
                    <div className="csv-mapping-grid">
                      <label>
                        日期顺序
                        <SelectField
                          label="CSV 日期顺序"
                          value={options.dateOrder}
                          disabled={busy}
                          onChange={(v) =>
                            setOptions((p) => ({ ...p, dateOrder: v as CsvOptions['dateOrder'] }))
                          }
                          options={[
                            { value: 'YMD', label: '年-月-日（YYYY-MM-DD）' },
                            { value: 'DMY', label: '日/月/年（DD/MM/YYYY）' },
                            { value: 'MDY', label: '月/日/年（MM/DD/YYYY）' }
                          ]}
                        />
                      </label>
                      <label>
                        默认币种
                        <SelectField
                          label="CSV 默认币种"
                          value={options.defaults.currency}
                          onChange={(v) => setDefault('currency', v)}
                          disabled={busy}
                          options={currencies.map((c) => ({ value: c, label: c }))}
                        />
                      </label>
                      <label>
                        默认分类
                        <SelectField
                          label="CSV 默认分类"
                          value={options.defaults.category}
                          onChange={(v) => setDefault('category', v)}
                          disabled={busy}
                          options={categories.map((c) => ({ value: c, label: c }))}
                        />
                      </label>
                      {kind === 'subscriptions' ? (
                        <>
                          <label>
                            默认周期
                            <SelectField
                              label="CSV 默认周期"
                              value={options.defaults.cycle}
                              onChange={(v) => setDefault('cycle', v)}
                              disabled={busy}
                              options={[
                                { value: 'month', label: '月' },
                                { value: 'year', label: '年' }
                              ]}
                            />
                          </label>
                          <label>
                            默认周期间隔
                            <InputNumber
                              aria-label="CSV 默认周期间隔"
                              value={options.defaults.interval}
                              controls={false}
                              min={1}
                              max={12}
                              onChange={(v) => setDefault('interval', v ?? 1)}
                              disabled={busy}
                            />
                          </label>
                          <label>
                            默认计费基准日
                            <Input
                              aria-label="CSV 默认计费基准日"
                              value={options.defaults.anchorDate}
                              placeholder="YYYY-MM-DD"
                              onChange={(e) => setDefault('anchorDate', e.target.value)}
                              disabled={busy}
                            />
                          </label>
                          <label>
                            默认自动续费
                            <SelectField
                              label="CSV 默认自动续费"
                              value={String(options.defaults.autoRenew)}
                              onChange={(v) => setDefault('autoRenew', v === 'true')}
                              disabled={busy}
                              options={[
                                { value: 'true', label: '开启' },
                                { value: 'false', label: '关闭' }
                              ]}
                            />
                          </label>
                          <label>
                            默认订阅状态
                            <SelectField
                              label="CSV 默认订阅状态"
                              value={options.defaults.status}
                              onChange={(v) => setDefault('status', v)}
                              disabled={busy}
                              options={[
                                { value: 'active', label: '付费订阅' },
                                { value: 'trial', label: '免费试用' },
                                { value: 'archived', label: '已归档' }
                              ]}
                            />
                          </label>
                          <label>
                            更新价格生效日
                            <Input
                              aria-label="CSV 更新价格生效日"
                              value={options.priceEffectiveOn}
                              placeholder="YYYY-MM-DD"
                              onChange={(e) =>
                                setOptions((p) => ({ ...p, priceEffectiveOn: e.target.value }))
                              }
                              disabled={busy}
                            />
                          </label>
                        </>
                      ) : (
                        <label>
                          缺少历史折算时
                          <SelectField
                            label="CSV 折算方式"
                            value={options.conversion}
                            onChange={(v) =>
                              setOptions((p) => ({ ...p, conversion: v as 'none' | 'current' }))
                            }
                            disabled={busy}
                            options={[
                              { value: 'none', label: '暂不折算，保留原币' },
                              { value: 'current', label: '使用导入时参考汇率' }
                            ]}
                          />
                        </label>
                      )}
                    </div>
                  )
                }
              ]}
            />
          </>
        )}
        {step === 2 && preview && (
          <>
            <div className="csv-preview-counts">
              <span>
                新增<strong>{preview.added}</strong>
              </span>
              <span>
                更新<strong>{preview.updated}</strong>
              </span>
              <span>
                跳过<strong>{preview.skipped}</strong>
              </span>
              <span className={preview.errors ? 'csv-error' : ''}>
                待处理<strong>{preview.errors}</strong>
              </span>
            </div>
            <div className="csv-preview-tools">
              <Button disabled={busy} onClick={() => void check()}>
                重新检查
              </Button>
              <SelectField
                label="预览行筛选"
                value={filter}
                onChange={setFilter}
                options={[
                  { value: 'all', label: '全部行' },
                  { value: 'error', label: '需要处理' },
                  { value: 'duplicate', label: '重复项' }
                ]}
              />
              {preview.errors > 0 && (
                <Button
                  disabled={busy}
                  onClick={() => {
                    const next = {
                      ...options,
                      decisions: [
                        ...options.decisions.filter(
                          (d) => !preview.rows.some((r) => r.row === d.row && r.status === 'error')
                        ),
                        ...preview.rows
                          .filter((r) => r.status === 'error')
                          .map((r) => ({ row: r.row, action: 'skip' as const }))
                      ]
                    }
                    void check(next)
                  }}
                >
                  明确排除全部错误行
                </Button>
              )}
              <p className="small muted">重复项默认跳过；新增或覆盖均可逐行确认。</p>
            </div>
            <Table<CsvPreviewRow>
              rowKey="row"
              size="small"
              dataSource={preview.rows.filter((r) => filter === 'all' || r.status === filter)}
              pagination={{ pageSize: 10, showSizeChanger: false }}
              scroll={{ x: 780 }}
              columns={[
                { title: '行', dataIndex: 'row', width: 50 },
                {
                  title: '处理',
                  dataIndex: 'status',
                  width: 120,
                  render: (s) => (
                    <span className={`csv-row-state ${s}`}>
                      {rowLabels[s as keyof typeof rowLabels]}
                    </span>
                  )
                },
                { title: '订阅', dataIndex: 'name', width: 130 },
                { title: '记录', dataIndex: 'summary', width: 170 },
                { title: '说明', dataIndex: 'message' },
                {
                  title: '操作',
                  width: 120,
                  render: (_, row) => (
                    <div className="record-actions">
                      <Button
                        type="link"
                        size="small"
                        disabled={busy}
                        onClick={() => setEditing(row)}
                      >
                        处理
                      </Button>
                      <Button
                        type="text"
                        size="small"
                        disabled={busy}
                        onClick={() =>
                          decide({
                            ...(options.decisions.find((d) => d.row === row.row) ?? {
                              row: row.row
                            }),
                            action: row.status === 'skipped' ? 'auto' : 'skip'
                          })
                        }
                      >
                        {row.status === 'skipped' ? '恢复' : '排除'}
                      </Button>
                    </div>
                  )
                }
              ]}
            />
            <p className="footnote">
              确认后先创建导入前备份，再一次性写入全部保留行；有错误或账本发生变化时停止导入。
              {kind === 'bills' && '“导入时参考汇率”不会被当成历史日汇率。'}
            </p>
          </>
        )}
        {step === 3 && batch && (
          <div className="csv-success">
            <FileSpreadsheet size={32} />
            <h2>导入完成</h2>
            <p>{batch.source}</p>
            <strong>
              新增 {batch.added} · 更新 {batch.updated} · 跳过 {batch.skipped}
            </strong>
            <p className="footnote">
              已保存导入前备份。如需撤销本次导入，可在设置的备份历史中选择对应快照，并使用“完整恢复”。恢复前还会保存当前账本。
            </p>
          </div>
        )}
      </div>
      {error && (
        <div role="alert" className="error-banner">
          {error}
        </div>
      )}
      <div className="csv-wizard-footer">
        {step > 0 && step < 3 && (
          <Button
            disabled={busy}
            onClick={() => {
              setStep(step - 1)
              setError('')
            }}
          >
            上一步
          </Button>
        )}
        <span />
        {step === 0 && (
          <Button
            aria-label="下一步：匹配字段"
            type="primary"
            disabled={!file}
            loading={busy}
            onClick={() => setStep(1)}
          >
            下一步：匹配字段
          </Button>
        )}
        {step === 1 && (
          <Button
            aria-label="检查并预览"
            type="primary"
            loading={busy}
            onClick={() => void check()}
          >
            检查并预览
          </Button>
        )}
        {step === 2 && (
          <Button
            aria-label="确认导入"
            type="primary"
            loading={busy}
            disabled={!preview || preview.errors > 0 || preview.added + preview.updated === 0}
            onClick={() => void commit()}
          >
            确认导入
          </Button>
        )}
        {step === 3 && (
          <Button type="primary" onClick={onClose}>
            完成
          </Button>
        )}
      </div>
      {editing && (
        <RowEditor
          key={editing.row}
          row={editing}
          options={options}
          snapshot={snapshot}
          onClose={() => setEditing(null)}
          onSave={decide}
        />
      )}
    </Modal>
  )
}
