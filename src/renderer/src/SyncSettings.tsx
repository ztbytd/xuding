import { useEffect, useState } from 'react'
import {
  Button,
  DatePicker,
  Drawer,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Switch,
  Tag
} from 'antd'
import dayjs from 'dayjs'
import { RefreshCw, Cloud, Monitor } from 'lucide-react'
import type { SyncAction, SyncConflict, SyncConnection, SyncStatus } from '../../shared/sync-model'
import { HelpTip, SelectField } from './controls'
const phases = {
  off: '未连接',
  idle: '已同步',
  syncing: '正在同步',
  paused: '已暂停',
  error: '同步失败',
  conflict: '有待处理冲突',
  locked: '已锁定'
}
const fieldNames: Record<string, string> = {
  name: '名称',
  amountMinor: '金额',
  currency: '币种',
  cycle: '周期',
  interval: '间隔',
  anchorDate: '计费基准日',
  status: '状态',
  autoRenew: '自动续费',
  accessEndsOn: '权益到期日',
  notes: '备注',
  category: '分类',
  website: '网站',
  frequency: '使用频率',
  decision: '续费决定',
  reason: '决策备注',
  reviewOn: '评估日期',
  cancellation: '取消进度',
  endsOn: '权益结束',
  requestedOn: '申请日期',
  confirmedOn: '确认日期',
  autoArchive: '自动归档',
  payment: '支付信息',
  paidOn: '支付日期',
  due: '应扣日期',
  enabled: '启用',
  month: '月份',
  threshold: '预算提醒比例',
  cancellationUrl: '取消入口',
  cancellationNotes: '取消备注',
  idleDays: '未使用提醒天数',
  categories: '分类预算'
}
const values: Record<string, string> = {
  active: '使用中',
  trial: '试用中',
  archived: '已归档',
  paid: '已支付',
  pending: '待确认',
  skipped: '已跳过',
  month: '月',
  year: '年',
  none: '尚未申请',
  requested: '已申请',
  confirmed: '已确认',
  review: '待评估',
  keep: '继续保留',
  consider: '考虑取消',
  end: '到期处理',
  unknown: '尚未评估',
  often: '经常使用',
  sometimes: '偶尔使用',
  rarely: '很少使用'
}
function readable(value: unknown): string {
  if (value === null || value === undefined) return '无'
  if (typeof value === 'boolean') return value ? '是' : '否'
  if (typeof value === 'object')
    return (
      Object.entries(value)
        .filter(([k]) => fieldNames[k])
        .map(
          ([k, v]) =>
            `${fieldNames[k]}：${k === 'amountMinor' ? (Number(v) / 100).toFixed(2) : readable(v)}`
        )
        .join('；') || '其他记录'
    )
  return values[String(value)] ?? String(value)
}
export function SyncSettings({ onReload }: { onReload: () => Promise<unknown> }) {
  const [state, setState] = useState<SyncStatus | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [open, setOpen] = useState(false),
    [notice, setNotice] = useState(''),
    [connection, setConnection] = useState<SyncConnection>({
      url: '',
      username: '',
      password: '',
      deviceName: '我的电脑'
    }),
    [passphrase, setPassphrase] = useState(''),
    [repeat, setRepeat] = useState(''),
    [recovery, setRecovery] = useState(''),
    [confirmation, setConfirmation] = useState(''),
    [mode, setMode] = useState<'merge' | 'replace'>('merge'),
    [conflictsOpen, setConflictsOpen] = useState(false),
    [editing, setEditing] = useState<SyncConflict | null>(null),
    [manual, setManual] = useState<Record<string, unknown> | null>(null),
    [rotation, setRotation] = useState<'rotate' | 'recovery' | null>(null)
  useEffect(() => {
    let active = true
    const refresh = () =>
      void window.desktop
        .syncStatus()
        .then((r) => {
          if (active && r.ok)
            setState((s) =>
              s?.preview && !r.data.connected ? { ...r.data, preview: s.preview } : r.data
            )
        })
        .catch(() => {})
    refresh()
    const timer = setInterval(refresh, 2000)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [])
  async function action(input: SyncAction) {
    const r = await window.desktop.syncAction(input)
    if (!r.ok) throw new Error(r.error)
    setState(r.data)
    if (r.data.recoveryKey) setRecovery(r.data.recoveryKey)
    return r.data
  }
  async function run(work: () => Promise<unknown>) {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await work()
    } catch (e) {
      setError(e instanceof Error ? e.message : '同步失败，请重试。')
    } finally {
      setBusy(false)
    }
  }
  function edit(c: SyncConflict) {
    setEditing(c)
    setManual(
      c.local && typeof c.local === 'object'
        ? structuredClone(c.local as Record<string, unknown>)
        : c.remote && typeof c.remote === 'object'
          ? structuredClone(c.remote as Record<string, unknown>)
          : null
    )
  }
  const clear = () => {
    setOpen(false)
    setState((s) => (s ? { ...s, preview: undefined } : s))
    setPassphrase('')
    setRepeat('')
    setRecovery('')
    setConfirmation('')
    setConnection((c) => ({ ...c, password: '' }))
  }
  const remoteBusy = busy || state?.phase === 'syncing'
  return (
    <div className="settings-tab-content settings-grid">
      <section className="panel">
        <div className="panel-head">
          <div className="panel-title">
            <Cloud size={18} />
            <h2>同步账本</h2>
            <HelpTip label="同步账本">
              使用自选 WebDAV
              目录，上传前在本机加密。服务仍可看到文件大小和访问时间。离线可编辑，锁定期间暂停同步。
            </HelpTip>
          </div>
          <Tag color={state?.phase === 'error' ? 'red' : state?.connected ? 'green' : 'default'}>
            {phases[state?.phase ?? 'off']}
          </Tag>
        </div>
        {error && (
          <div className="error-banner" role="alert">
            {error}
          </div>
        )}
        {state?.error && (
          <div role="alert" className="error-banner">
            {state.error}
          </div>
        )}
        {notice && <p role="status">{notice}</p>}
        <p className="footnote">
          在多台 Windows 电脑上使用同一账本。需要支持安全条件写入的 HTTPS WebDAV 目录。
        </p>
        {state?.connected ? (
          <>
            <dl className="facts">
              <div>
                <dt>最近成功同步</dt>
                <dd>
                  {state.lastSuccess
                    ? new Date(state.lastSuccess).toLocaleString('zh-CN')
                    : '尚未成功'}
                </dd>
              </div>
              <div>
                <dt>待上传变更</dt>
                <dd>{state.pending}</dd>
              </div>
              <div>
                <dt>待处理冲突</dt>
                <dd>{state.conflicts.length}</dd>
              </div>
            </dl>
            <div className="backup-actions">
              <Button
                icon={<RefreshCw size={15} />}
                disabled={remoteBusy || state.phase === 'paused'}
                onClick={() =>
                  void run(async () => {
                    await action({ action: 'sync' })
                    await onReload()
                  })
                }
              >
                立即同步
              </Button>
              <Button
                disabled={remoteBusy}
                onClick={() =>
                  void run(() => action({ action: 'pause', paused: state.phase !== 'paused' }))
                }
              >
                {state.phase === 'paused' ? '恢复同步' : '暂停同步'}
              </Button>
              <Button disabled={!state.conflicts.length} onClick={() => setConflictsOpen(true)}>
                处理冲突
              </Button>
              <Popconfirm
                title="断开本机同步？"
                description="本地账本和远端数据都会保留。"
                onConfirm={() => run(() => action({ action: 'disconnect' }))}
              >
                <Button disabled={remoteBusy}>断开连接</Button>
              </Popconfirm>
            </div>
          </>
        ) : (
          <Button
            type="primary"
            onClick={() => {
              setOpen(true)
              setNotice('')
              setError('')
            }}
          >
            连接 WebDAV
          </Button>
        )}
      </section>
      {state?.connected && (
        <>
          <section className="panel">
            <div className="panel-head">
              <h2>已接入设备</h2>
              <HelpTip label="已接入设备">
                显示最近提交同步的设备。设备丢失时更换同步密钥，并在服务端更换可能泄漏的 WebDAV
                凭据；无法收回设备已下载的历史数据。
              </HelpTip>
            </div>
            {state.devices.map((d) => (
              <div key={d.id} className="device-item">
                <Monitor size={18} />
                <strong>{d.name}</strong>
                <small>{new Date(d.seenAt).toLocaleString('zh-CN')}</small>
              </div>
            ))}
          </section>
          <section className="panel">
            <div className="panel-head">
              <h2>同步保护与恢复</h2>
            </div>
            <p className="footnote">
              同步口令与本地解锁密码独立。重建同步空间后，其他可信设备需重新接入。
            </p>
            <div className="backup-actions">
              <Button
                disabled={remoteBusy}
                onClick={() => {
                  setRotation('recovery')
                  setPassphrase('')
                  setRepeat('')
                  setRecovery('')
                }}
              >
                修改同步口令与恢复密钥
              </Button>
              <Button
                disabled={remoteBusy}
                onClick={() => {
                  setRotation('rotate')
                  setPassphrase('')
                  setRepeat('')
                  setRecovery('')
                }}
              >
                重建同步空间
              </Button>
            </div>
          </section>
        </>
      )}
      <Modal
        title="连接加密同步"
        open={open}
        onCancel={() => {
          if (!busy) clear()
        }}
        footer={null}
        destroyOnHidden
        maskClosable={!busy}
      >
        {error && (
          <div role="alert" className="error-banner">
            {error}
          </div>
        )}
        {state?.preview ? (
          <>
            <p>
              {state.preview.remote ? '找到远端账本' : '将创建新的同步账本'}：本机{' '}
              {state.preview.localSubscriptions} 项订阅，远端 {state.preview.remoteSubscriptions}{' '}
              项订阅。
              {state.preview.conflicts ? `可能有 ${state.preview.conflicts} 项修改需要确认。` : ''}
            </p>
            <SelectField
              label="首次连接方式"
              value={mode}
              onChange={(v) => setMode(v as typeof mode)}
              options={[
                { value: 'merge', label: '合并本机和远端账本' },
                ...(state.preview.remote
                  ? [{ value: 'replace', label: '使用远端账本替换本机' }]
                  : [])
              ]}
            />
            {mode === 'replace' && (
              <p className="footnote">替换前创建保护备份；本机独有记录将移除。</p>
            )}
            {recovery && (
              <>
                <p>请保存同步恢复密钥，再输入最后 8 位确认。</p>
                <Input.TextArea aria-label="同步恢复密钥" readOnly value={recovery} autoSize />
                <Button
                  onClick={() =>
                    void run(async () => {
                      const r = await window.desktop.securityAction({
                        action: 'saveRecovery',
                        key: recovery
                      })
                      if (!r.ok) throw new Error(r.error)
                    })
                  }
                >
                  另存同步恢复密钥
                </Button>
                <Input
                  aria-label="同步恢复密钥最后八位"
                  value={confirmation}
                  onChange={(e) => setConfirmation(e.target.value)}
                  placeholder="最后 8 位"
                />
              </>
            )}
            <div className="backup-actions">
              <Button
                type="primary"
                loading={busy}
                aria-label="确认连接同步"
                disabled={!!recovery && confirmation.trim().toUpperCase() !== recovery.slice(-8)}
                onClick={() =>
                  void run(async () => {
                    await action({ action: 'connect', token: state.preview!.token, mode })
                    await onReload()
                    clear()
                  })
                }
              >
                确认连接并同步
              </Button>
              <Button
                disabled={busy}
                onClick={() => setState((s) => (s ? { ...s, preview: undefined } : s))}
              >
                返回连接信息
              </Button>
            </div>
          </>
        ) : (
          <div className="secure-form">
            <label>
              <span>WebDAV 目录地址</span>
              <Input
                aria-label="WebDAV 目录地址"
                value={connection.url}
                placeholder="https://…/xuding/"
                onChange={(e) => setConnection((c) => ({ ...c, url: e.target.value }))}
              />
            </label>
            <label>
              <span>用户名</span>
              <Input
                aria-label="WebDAV 用户名"
                value={connection.username}
                autoComplete="off"
                onChange={(e) => setConnection((c) => ({ ...c, username: e.target.value }))}
              />
            </label>
            <label>
              <span>WebDAV 密码或应用凭据</span>
              <Input.Password
                aria-label="WebDAV 密码"
                value={connection.password}
                autoComplete="off"
                onChange={(e) => setConnection((c) => ({ ...c, password: e.target.value }))}
              />
            </label>
            <label>
              <span>本机设备名称</span>
              <Input
                aria-label="本机设备名称"
                value={connection.deviceName}
                maxLength={60}
                onChange={(e) => setConnection((c) => ({ ...c, deviceName: e.target.value }))}
              />
            </label>
            <label>
              <span>同步口令或恢复密钥</span>
              <Input.Password
                aria-label="同步口令"
                value={passphrase}
                autoComplete="off"
                maxLength={256}
                onChange={(e) => setPassphrase(e.target.value)}
              />
            </label>
            <p className="footnote">
              新建时设置至少 12 个字符的口令；加入时输入原账本的同步口令或恢复密钥。
            </p>
            <div className="backup-actions">
              <Button
                loading={busy}
                onClick={() =>
                  void run(async () => {
                    await action({ action: 'test', connection })
                    setNotice('连接检查通过，支持安全同步。')
                  })
                }
              >
                测试连接
              </Button>
              <Button
                type="primary"
                loading={busy}
                aria-label="预览同步连接"
                onClick={() =>
                  void run(async () => {
                    setConfirmation('')
                    await action({ action: 'preview', connection, passphrase })
                  })
                }
              >
                下一步：预览账本
              </Button>
            </div>
            {notice && <p role="status">{notice}</p>}
          </div>
        )}
      </Modal>
      <Modal
        title={rotation === 'rotate' ? '重建同步空间' : '修改同步保护'}
        open={!!rotation}
        onCancel={() => {
          if (!busy) {
            setRotation(null)
            setPassphrase('')
            setRepeat('')
            setRecovery('')
          }
        }}
        footer={null}
        destroyOnHidden
      >
        {error && (
          <div role="alert" className="error-banner">
            {error}
          </div>
        )}
        {recovery ? (
          <>
            <p>请保存新的恢复密钥。</p>
            <Input.TextArea aria-label="新同步恢复密钥" value={recovery} readOnly autoSize />
            <div className="backup-actions">
              <Button
                onClick={() =>
                  void run(async () => {
                    const r = await window.desktop.securityAction({
                      action: 'saveRecovery',
                      key: recovery
                    })
                    if (!r.ok) throw new Error(r.error)
                  })
                }
              >
                另存恢复密钥
              </Button>
              <Button
                type="primary"
                onClick={() => {
                  setRecovery('')
                  setPassphrase('')
                  setRepeat('')
                  setRotation(null)
                }}
              >
                已保存
              </Button>
            </div>
          </>
        ) : (
          <div className="secure-form">
            <p>
              {rotation === 'rotate'
                ? '重建后其他设备会停止同步，需要重新加入。请先同步本机的最新修改。'
                : '修改口令后，已接入设备仍可使用保存的同步密钥；新设备需使用新口令。'}
            </p>
            <Input.Password
              aria-label="新同步口令"
              placeholder="新同步口令"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              autoComplete="new-password"
            />
            <Input.Password
              aria-label="再次输入同步口令"
              placeholder="再次输入"
              value={repeat}
              onChange={(e) => setRepeat(e.target.value)}
              autoComplete="new-password"
            />
            <Button
              type="primary"
              loading={busy}
              onClick={() =>
                void run(async () => {
                  if (passphrase.length < 12 || passphrase !== repeat)
                    throw new Error('至少 12 个字符，两次口令须一致。')
                  await action({ action: rotation!, passphrase })
                })
              }
            >
              确认修改
            </Button>
          </div>
        )}
      </Modal>
      <Drawer
        title="处理同步冲突"
        open={conflictsOpen}
        onClose={() => setConflictsOpen(false)}
        size={680}
        closable={{ 'aria-label': '关闭同步冲突' }}
      >
        {error && (
          <div className="error-banner" role="alert">
            {error}
          </div>
        )}
        {!state?.conflicts.length ? (
          <p>冲突已处理，可以继续同步。</p>
        ) : (
          state.conflicts.map((c) => (
            <section className="conflict-item" key={c.id}>
              <h3>{c.label}</h3>
              {c.key.startsWith('subscriptions:') && (
                <p className="footnote">
                  按整项订阅处理，包含相关价格、取消进度和账单修改。选择前请核对两边的内容。
                </p>
              )}
              <div className="conflict-columns">
                <div>
                  <strong>本机修改</strong>
                  <p>{readable(c.local)}</p>
                </div>
                <div>
                  <strong>其他设备修改</strong>
                  <p>{readable(c.remote)}</p>
                </div>
              </div>
              <div className="backup-actions">
                <Button
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await action({ action: 'resolve', id: c.id, choice: 'local' })
                      await onReload()
                    })
                  }
                >
                  保留本机
                </Button>
                <Button
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await action({ action: 'resolve', id: c.id, choice: 'remote' })
                      await onReload()
                    })
                  }
                >
                  采用其他设备
                </Button>
                {!!(c.local || c.remote) && (
                  <Button disabled={busy} onClick={() => edit(c)}>
                    手动调整
                  </Button>
                )}
              </div>
            </section>
          ))
        )}
      </Drawer>
      <Modal
        title="调整冲突记录"
        open={!!editing}
        onCancel={() => setEditing(null)}
        onOk={() =>
          void run(async () => {
            if (!editing) return
            await action({
              action: 'resolve',
              id: editing.id,
              choice: 'manual',
              value: JSON.stringify(manual)
            })
            await onReload()
            setEditing(null)
          })
        }
        okText="保存调整"
        confirmLoading={busy}
        destroyOnHidden
      >
        {error && (
          <div role="alert" className="error-banner">
            {error}
          </div>
        )}
        <div className="secure-form">
          {manual &&
            Object.entries(manual)
              .filter(([k]) => fieldNames[k])
              .map(([k, v]) => (
                <label key={k}>
                  <span>{fieldNames[k]}</span>
                  {typeof v === 'boolean' ? (
                    <Switch checked={v} onChange={(v) => setManual((d) => ({ ...d, [k]: v }))} />
                  ) : typeof v === 'number' ? (
                    <InputNumber
                      controls={false}
                      value={k === 'amountMinor' ? v / 100 : v}
                      precision={k === 'amountMinor' ? 2 : 0}
                      onChange={(v) =>
                        setManual((d) => ({
                          ...d,
                          [k]: k === 'amountMinor' ? Math.round(Number(v) * 100) : Number(v)
                        }))
                      }
                    />
                  ) : k === 'payment' && v && typeof v === 'object' ? (
                    <div className="secure-form">
                      <label>
                        <span>实际支付金额</span>
                        <InputNumber
                          aria-label="冲突实际支付金额"
                          controls={false}
                          precision={2}
                          min={0}
                          value={Number((v as Record<string, unknown>).amountMinor) / 100}
                          onChange={(n) =>
                            setManual((d) => ({
                              ...d,
                              payment: {
                                ...(d?.payment as object),
                                amountMinor: Math.round(Number(n) * 100)
                              }
                            }))
                          }
                        />
                      </label>
                      <label>
                        <span>支付币种</span>
                        <SelectField
                          label="冲突支付币种"
                          value={String((v as Record<string, unknown>).currency)}
                          options={['CNY', 'USD', 'EUR', 'HKD'].map((value) => ({
                            value,
                            label: value
                          }))}
                          onChange={(currency) =>
                            setManual((d) => ({
                              ...d,
                              payment: { ...(d?.payment as object), currency }
                            }))
                          }
                        />
                      </label>
                      <label>
                        <span>支付日期</span>
                        <DatePicker
                          aria-label="冲突支付日期"
                          previewValue={false}
                          value={dayjs(String((v as Record<string, unknown>).paidOn))}
                          onChange={(date) =>
                            setManual((d) => ({
                              ...d,
                              payment: {
                                ...(d?.payment as object),
                                paidOn: date?.format('YYYY-MM-DD')
                              }
                            }))
                          }
                        />
                      </label>
                    </div>
                  ) : typeof v === 'object' ? (
                    <p>{readable(v)}</p>
                  ) : [
                      'status',
                      'cycle',
                      'cancellation',
                      'decision',
                      'frequency',
                      'currency'
                    ].includes(k) ? (
                    <SelectField
                      label={fieldNames[k]}
                      value={String(v)}
                      options={(k === 'status'
                        ? editing?.key.startsWith('bills:')
                          ? ['pending', 'paid', 'skipped']
                          : ['active', 'trial', 'archived']
                        : k === 'cycle'
                          ? ['month', 'year']
                          : k === 'cancellation'
                            ? ['none', 'requested', 'confirmed']
                            : k === 'decision'
                              ? ['review', 'keep', 'consider', 'end']
                              : k === 'frequency'
                                ? ['unknown', 'often', 'sometimes', 'rarely']
                                : ['CNY', 'USD', 'EUR', 'HKD']
                      ).map((value) => ({ value, label: values[value] ?? value }))}
                      onChange={(v) => setManual((d) => ({ ...d, [k]: v }))}
                    />
                  ) : typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? (
                    <DatePicker
                      value={dayjs(v)}
                      previewValue={false}
                      onChange={(v) => setManual((d) => ({ ...d, [k]: v?.format('YYYY-MM-DD') }))}
                    />
                  ) : (
                    <Input
                      value={String(v ?? '')}
                      onChange={(e) => setManual((d) => ({ ...d, [k]: e.target.value }))}
                    />
                  )}
                </label>
              ))}
        </div>
      </Modal>
    </div>
  )
}
