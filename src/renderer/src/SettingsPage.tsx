import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, Drawer, Input, Modal, Popconfirm, Progress, Switch, Tabs, Tag } from 'antd'
import { Download, FolderOpen, History, KeyRound, ShieldCheck, Upload } from 'lucide-react'
import type {
  BackupEntry,
  BackupStatus,
  RestorePreview,
  Result,
  SettingsPatch,
  Snapshot
} from '../../shared/model'
import type {
  BackupSelection,
  ProtectionStatus,
  RecoveryEntry,
  UpdateState
} from '../../shared/operations-model'
import { HelpTip, SelectField } from './controls'

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(result.error)
  return result.data
}
function Region({ title, help, children }: { title: string; help?: string; children: ReactNode }) {
  return (
    <section className="panel">
      <div className="panel-head">
        <div className="panel-title">
          <h2>{title}</h2>
          {help && (
            <HelpTip label={title} placement="bottom">
              {help}
            </HelpTip>
          )}
        </div>
      </div>
      {children}
    </section>
  )
}
const timestamp = (value: string) => new Date(value).toLocaleString('zh-CN', { hour12: false })
const kindNames = {
  daily: '自动备份',
  manual: '手动备份',
  'before-import': 'CSV 导入前',
  'before-restore': '恢复前快照'
}
const tabs = [
  { key: 'general', label: '通用' },
  { key: 'notifications', label: '通知' },
  { key: 'data', label: '数据与备份' },
  { key: 'about', label: '关于与更新' }
]
export function SettingsPage({
  snapshot,
  onReload,
  onNotice,
  onCsvImport,
  onCsvExport
}: {
  snapshot: Snapshot
  onReload: () => Promise<Snapshot>
  onNotice: (message: string) => void
  onCsvImport: () => void
  onCsvExport: () => void
}) {
  const [tab, setTab] = useState(() => {
    try {
      const saved = sessionStorage.getItem('xuding.settings-tab')
      return tabs.some((v) => v.key === saved) ? saved! : 'general'
    } catch {
      return 'general'
    }
  })
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  const [status, setStatus] = useState<BackupStatus>(snapshot.backupStatus)
  const [protection, setProtection] = useState<ProtectionStatus>({
    enabled: !!snapshot.backupStatus.encrypted,
    credentialAvailable: true
  })
  const [history, setHistory] = useState<BackupEntry[]>([]),
    [historyOpen, setHistoryOpen] = useState(false)
  const [preview, setPreview] = useState<RestorePreview | null>(null),
    [restoreMode, setRestoreMode] = useState<'merge' | 'replace'>('merge')
  const [selection, setSelection] = useState<BackupSelection | null>(null)
  const [passwordMode, setPasswordMode] = useState<'protection' | 'export' | null>(null)
  const [password, setPassword] = useState(''),
    [confirmation, setConfirmation] = useState(''),
    [remember, setRemember] = useState(false)
  const [encryptedExport, setEncryptedExport] = useState(true)
  const [update, setUpdate] = useState<UpdateState | null>(null)
  const [checkpoints, setCheckpoints] = useState<RecoveryEntry[]>([]),
    [checkpointOpen, setCheckpointOpen] = useState(false)
  const settings = snapshot.settings
  const [modal, modalContext] = Modal.useModal()
  useEffect(() => setRestoreMode('merge'), [preview?.token])
  useEffect(() => {
    let active = true
    const refresh = async () => {
      const results = await Promise.all([
        window.desktop.backupStatus(),
        window.desktop.protectionStatus(),
        window.desktop.updateStatus()
      ])
      if (!active) return
      if (results[0].ok) setStatus(results[0].data)
      if (results[1].ok) setProtection(results[1].data)
      if (results[2].ok) setUpdate(results[2].data)
    }
    void refresh().catch(() => {})
    const timer = setInterval(() => void refresh().catch(() => {}), 1500)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [])
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
  const save = (patch: SettingsPatch) =>
    void run(async () => {
      unwrap(await window.desktop.settings(patch))
      await onReload()
      setStatus(unwrap(await window.desktop.backupStatus()))
    })
  const toggle = (
    label: string,
    checked: boolean,
    patch: (value: boolean) => SettingsPatch,
    disabled = false
  ) => (
    <Switch
      aria-label={label}
      checked={checked}
      disabled={busy || disabled}
      onChange={(v) => save(patch(v))}
    />
  )
  function clearPasswords() {
    setPassword('')
    setConfirmation('')
    setRemember(false)
  }
  function openPassword(mode: 'protection' | 'export') {
    clearPasswords()
    setError('')
    setEncryptedExport(true)
    setPasswordMode(mode)
  }
  async function select(value: BackupSelection | null) {
    if (!value) return
    setError('')
    clearPasswords()
    if (value.encrypted) setSelection(value)
    else setPreview(unwrap(await window.desktop.unlockBackup(value.token)))
  }
  const row = (title: string, description: string, control: ReactNode) => (
    <div className="setting-row">
      <span>
        <strong>{title}</strong>
        <small>{description}</small>
      </span>
      {control}
    </div>
  )
  const protectionHelp =
    '加密保护备份文件。本机 SQLite 数据库与升级恢复副本仍未加密。密码遗失无法找回；更改密码仅影响后续备份，旧文件仍使用原密码。'
  const updateBusy = update && ['checking', 'downloading', 'installing'].includes(update.phase)
  return (
    <section className="settings-page">
      {modalContext}
      <header className="page-head">
        <div>
          <h1>设置与备份</h1>
          <p>数据留在本机，由你掌握。</p>
        </div>
        <ShieldCheck className="muted" size={24} />
      </header>
      <Tabs
        className="settings-tabs"
        activeKey={tab}
        items={tabs.map((v) => ({
          ...v,
          label: (
            <span>
              {v.label}
              {v.key === 'about' && update?.version && <i className="update-dot" />}
            </span>
          )
        }))}
        onChange={(key) => {
          setTab(key)
          setError('')
          try {
            sessionStorage.setItem('xuding.settings-tab', key)
          } catch {}
        }}
      />
      {error && !preview && !passwordMode && !selection && (
        <div className="error-banner" role="alert">
          {error}
        </div>
      )}
      {tab === 'general' && (
        <div className="settings-tab-content">
          <Region title="启动与后台">
            {row(
              '开机启动',
              snapshot.startupSupported
                ? '登录 Windows 后自动启动续订。'
                : 'Windows 安装版可配置开机启动。',
              toggle(
                '开机启动',
                settings.launchAtLogin,
                (v) => ({ launchAtLogin: v }),
                !snapshot.startupSupported
              )
            )}
            {row(
              '启动后收起到托盘',
              '随系统启动时在后台运行。',
              toggle(
                '启动后收起到托盘',
                settings.startInTray,
                (v) => ({ startInTray: v }),
                !settings.launchAtLogin
              )
            )}
            {row(
              '关闭窗口时',
              '后台运行会保留托盘图标并继续提醒。',
              <SelectField
                label="关闭窗口时"
                value={settings.closeBehavior}
                disabled={busy}
                onChange={(v) => save({ closeBehavior: v as 'ask' | 'tray' | 'quit' })}
                options={[
                  { value: 'ask', label: '每次询问' },
                  { value: 'tray', label: '后台运行' },
                  { value: 'quit', label: '退出应用' }
                ]}
              />
            )}
          </Region>
        </div>
      )}
      {tab === 'notifications' && (
        <div className="settings-tab-content settings-grid">
          <Region
            title="桌面提醒"
            help="后台运行时会继续提醒。退出应用或电脑休眠期间不会发送通知；恢复运行后检查仍需处理的提醒。系统关闭通知时也可能收不到提醒。"
          >
            {row(
              '到期通知',
              '按订阅提前天数提醒续费、试用结束或权益到期，每期最多一次。',
              toggle('开启桌面通知', settings.notificationsEnabled, (v) => ({
                notificationsEnabled: v
              }))
            )}
          </Region>
          <Region
            title="预算提醒"
            help="根据本月已支付金额判断预算阈值，每月每个阈值提醒一次。缺少折算信息时暂停相关提醒。"
          >
            {row(
              '预算桌面通知',
              '达到提前提醒阈值或预算用尽时通知，可独立开启。',
              toggle('预算桌面通知', settings.budgetNotificationsEnabled, (v) => ({
                budgetNotificationsEnabled: v
              }))
            )}
          </Region>
        </div>
      )}
      {tab === 'data' && (
        <div className="settings-tab-content settings-data">
          <Region title="数据备份" help={protectionHelp}>
            <div className="backup-summary">
              <div>
                <strong>
                  {status.pending
                    ? '等待自动备份…'
                    : status.lastSuccess
                      ? `最近备份：${timestamp(status.lastSuccess)}`
                      : '尚未生成备份'}
                </strong>
                <span>
                  {settings.autoBackupEnabled ? '自动备份已开启' : '自动备份已关闭'} ·{' '}
                  {protection.enabled ? '新备份已加密' : '新备份未加密'}
                </span>
                {status.lastError && (
                  <span className="backup-error">
                    备份失败：请检查目录权限、磁盘空间或备份凭据。
                  </span>
                )}
                {!protection.credentialAvailable && protection.enabled && (
                  <span className="backup-error">备份凭据不可用，请重新设置密码。</span>
                )}
              </div>
              <Tag color={protection.enabled ? 'green' : 'default'}>
                {protection.enabled ? '加密备份' : '未加密'}
              </Tag>
            </div>
            <div className="backup-actions">
              <Button
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    setStatus(unwrap(await window.desktop.backupNow()))
                    onNotice('备份已完成。')
                  })
                }
              >
                立即备份
              </Button>
              <Button
                icon={<History size={15} />}
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    setHistory(unwrap(await window.desktop.backupHistory()))
                    setHistoryOpen(true)
                  })
                }
              >
                备份历史
              </Button>
              <Button
                icon={<FolderOpen size={15} />}
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    unwrap(await window.desktop.openBackupDirectory())
                  })
                }
              >
                打开目录
              </Button>
            </div>
            {row(
              '自动备份',
              '账本变更后保存，当天的修改合并到一份自动备份。',
              toggle('自动备份', settings.autoBackupEnabled, (v) => ({ autoBackupEnabled: v }))
            )}
            {row(
              '自动备份保留时间',
              '手动备份长期保留；导入及恢复前的保护副本额外保留最近 10 份。',
              <SelectField
                label="备份保留时间"
                value={String(settings.backupRetentionDays)}
                disabled={busy}
                onChange={(v) => save({ backupRetentionDays: Number(v) })}
                options={[7, 14, 30, 90].map((v) => ({ value: String(v), label: `最近 ${v} 天` }))}
              />
            )}
            <div className="backup-location">
              <div>
                <strong>备份位置</strong>
                <small title={status.directory}>{status.directory}</small>
              </div>
              <Button
                size="small"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    setStatus(unwrap(await window.desktop.chooseBackupDirectory()))
                    onNotice('备份位置已更新。')
                  })
                }
              >
                更改位置
              </Button>
            </div>
          </Region>
          <div className="settings-grid">
            <Region title="备份加密" help={protectionHelp}>
              {row(
                '加密新备份',
                '开启后，自动、手动及导入恢复前的账本备份均使用密码保护。',
                <Switch
                  aria-label="加密新备份"
                  checked={protection.enabled}
                  disabled={busy}
                  onChange={(v) => {
                    if (v) openPassword('protection')
                    else
                      modal.confirm({
                        title: '关闭后续备份加密？',
                        content: '已有加密文件仍需原密码恢复，新创建的备份将以明文保存。',
                        okText: '关闭加密',
                        cancelText: '取消',
                        onOk: () =>
                          run(async () => {
                            setProtection(
                              unwrap(await window.desktop.configureProtection({ enabled: false }))
                            )
                            setStatus(unwrap(await window.desktop.backupStatus()))
                          })
                      })
                  }}
                />
              )}
              <div className="backup-actions">
                <Button
                  icon={<KeyRound size={15} />}
                  disabled={busy}
                  onClick={() => openPassword('protection')}
                >
                  {protection.enabled ? '更改备份密码' : '设置备份密码'}
                </Button>
              </div>
              <p className="footnote">旧备份仍使用原密码。备份密码遗失后无法找回。</p>
            </Region>
            <Region title="账本文件">
              {row(
                '导出账本备份',
                '包含订阅、图标、账单、价格历史、预算及导入记录。',
                <Button
                  icon={<Download size={15} />}
                  disabled={busy}
                  onClick={() => openPassword('export')}
                >
                  导出备份
                </Button>
              )}
              {row(
                '从备份恢复',
                '支持加密文件和旧 JSON，先预览影响范围。',
                <Button
                  icon={<Upload size={15} />}
                  disabled={busy}
                  onClick={() =>
                    void run(async () => select(unwrap(await window.desktop.chooseImport())))
                  }
                >
                  导入备份
                </Button>
              )}
            </Region>
          </div>
          <Region
            title="数据迁移"
            help="CSV 用于表格交换，不包含图标和完整操作历史。完整恢复请使用账本备份；导入 CSV 前会保存保护副本。"
          >
            <div className="backup-actions">
              <Button onClick={onCsvImport}>导入 CSV</Button>
              <Button onClick={onCsvExport}>导出 CSV / 模板</Button>
              <Button
                onClick={() =>
                  void run(async () => {
                    const state = unwrap(await window.desktop.recoveryStatus())
                    setCheckpoints(state.entries)
                    setCheckpointOpen(true)
                  })
                }
              >
                升级恢复副本
              </Button>
            </div>
          </Region>
        </div>
      )}
      {tab === 'about' && (
        <div className="settings-tab-content">
          <Region title="版本更新">
            <div className="update-summary">
              <div>
                <strong>续订 {snapshot.version}</strong>
                <span>
                  {update?.phase === 'unsupported'
                    ? '当前为开发环境，请使用 Windows 安装版检查更新。'
                    : update?.phase === 'current'
                      ? '当前已是最新正式版'
                      : update?.version
                        ? `可用版本 ${update.version}`
                        : '保持应用为最新版本'}
                </span>
                {update?.checkedAt && <small>最近检查：{timestamp(update.checkedAt)}</small>}
              </div>
              <Tag>Windows x64</Tag>
            </div>
            {row(
              '自动检查更新',
              '每天最多检查一次，由你决定下载与安装时间。',
              <Switch
                aria-label="自动检查更新"
                checked={update?.automatic ?? true}
                disabled={busy}
                onChange={(v) =>
                  void run(async () => setUpdate(unwrap(await window.desktop.updatePreference(v))))
                }
              />
            )}
            {update?.notes && (
              <div className="release-notes">
                <strong>更新说明</strong>
                <p>{update.notes}</p>
              </div>
            )}
            {update?.phase === 'downloading' && (
              <Progress percent={update.progress} status="active" />
            )}
            {update?.phase === 'downloaded' && (
              <p className="footnote">更新已下载并校验。可以现在安装，或稍后回到这里继续。</p>
            )}
            {update?.error && (
              <div className="error-banner" role="alert">
                {update.error}
              </div>
            )}
            <div className="backup-actions">
              <Button
                loading={update?.phase === 'checking'}
                disabled={
                  busy ||
                  !!updateBusy ||
                  update?.phase === 'unsupported' ||
                  update?.phase === 'downloaded'
                }
                onClick={() =>
                  void run(async () =>
                    setUpdate(unwrap(await window.desktop.updateAction('check')))
                  )
                }
              >
                检查更新
              </Button>
              {update?.version && update.phase !== 'downloaded' && (
                <Button
                  type="primary"
                  loading={update.phase === 'downloading'}
                  disabled={busy || !!updateBusy}
                  onClick={() =>
                    void run(async () =>
                      setUpdate(unwrap(await window.desktop.updateAction('download')))
                    )
                  }
                >
                  下载更新
                </Button>
              )}
              {update?.phase === 'downloaded' && (
                <Button
                  type="primary"
                  disabled={busy}
                  onClick={() =>
                    void run(async () =>
                      setUpdate(unwrap(await window.desktop.updateAction('install')))
                    )
                  }
                >
                  重启并安装
                </Button>
              )}
              <Button
                onClick={() =>
                  void run(async () => {
                    unwrap(
                      await window.desktop.openWebsite('https://github.com/ztbytd/xuding/releases')
                    )
                  })
                }
              >
                正式发布页
              </Button>
            </div>
          </Region>
          <Region
            title="帮助与诊断"
            help="日志只记录操作类型、时间和错误码，保留最近 7 天，总大小不超过 20 MB。不包含订阅内容、密码和个人路径，也不会自动上传。"
          >
            {row(
              '导出诊断包',
              '保存前会展示包含的信息，由你决定是否分享。',
              <Button
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    if (unwrap(await window.desktop.diagnosticsExport())) onNotice('诊断包已保存。')
                  })
                }
              >
                导出诊断包
              </Button>
            )}
            <div className="backup-actions">
              <Button
                onClick={() =>
                  void run(async () => {
                    unwrap(await window.desktop.openWebsite('https://github.com/ztbytd/xuding'))
                  })
                }
              >
                开源仓库
              </Button>
              <Button
                onClick={() =>
                  void run(async () => {
                    unwrap(
                      await window.desktop.openWebsite('https://github.com/ztbytd/xuding/issues')
                    )
                  })
                }
              >
                反馈问题
              </Button>
            </div>
          </Region>
        </div>
      )}
      <footer className="settings-about">
        续订 {snapshot.version} · MIT 开源许可 · 本机 SQLite 存储
      </footer>
      <Drawer
        title="备份历史"
        closable={{ 'aria-label': '关闭备份历史' }}
        open={historyOpen}
        onClose={() => {
          if (!busy) setHistoryOpen(false)
        }}
        size={570}
      >
        {error && !preview && !selection && (
          <div className="error-banner" role="alert">
            {error}
          </div>
        )}
        {!history.length ? (
          <div className="empty">还没有可恢复的备份。</div>
        ) : (
          history.map((item) => (
            <div className="backup-history-item" key={item.id}>
              <div>
                <strong>{timestamp(item.createdAt)}</strong>
                <small>
                  {kindNames[item.kind]} · {(item.size / 1024).toFixed(1)} KB ·{' '}
                  {item.encrypted ? '已加密' : '未加密'}
                </small>
                <small>
                  {item.state === 'invalid'
                    ? item.error
                    : item.count === null
                      ? '输入密码并验证后可查看内容'
                      : `${item.count} 项订阅 · ${item.bills ?? 0} 笔账单 · ${item.budgets ?? 0} 个月预算`}
                </small>
              </div>
              <div className="history-buttons">
                <Button
                  disabled={busy || item.state === 'invalid'}
                  aria-label={`恢复 ${item.id}`}
                  onClick={() =>
                    void run(async () => select(unwrap(await window.desktop.selectBackup(item.id))))
                  }
                >
                  恢复
                </Button>
                <Button
                  size="small"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      if (unwrap(await window.desktop.copyBackup(item.id))) onNotice('备份已另存。')
                    })
                  }
                >
                  另存为
                </Button>
                <Popconfirm
                  title="删除这份备份？"
                  description={`${kindNames[item.kind]} · ${timestamp(item.createdAt)}，删除后无法恢复此文件。`}
                  okText="删除"
                  cancelText="取消"
                  onConfirm={() =>
                    run(async () => {
                      unwrap(await window.desktop.removeBackup(item.id))
                      setHistory(unwrap(await window.desktop.backupHistory()))
                    })
                  }
                >
                  <Button size="small" danger disabled={busy}>
                    删除
                  </Button>
                </Popconfirm>
              </div>
            </div>
          ))
        )}
      </Drawer>
      <Drawer
        title="升级恢复副本"
        open={checkpointOpen}
        onClose={() => setCheckpointOpen(false)}
        size={570}
      >
        <p className="footnote">
          副本包含完整本机数据库，未加密。用于升级异常时恢复；账本备份请使用“备份历史”。成功启动后保留最近
          3 个可用恢复点。
        </p>
        {!checkpoints.length ? (
          <div className="empty">尚未产生升级恢复副本。</div>
        ) : (
          checkpoints.map((item) => (
            <div className="backup-history-item" key={item.id}>
              <div>
                <strong>{timestamp(item.createdAt)}</strong>
                <small>
                  {item.valid ? `已通过检查 · 数据库结构 ${item.version}` : '文件异常，无法恢复'} ·{' '}
                  {(item.size / 1024).toFixed(1)} KB
                </small>
              </div>
              <Button
                disabled={!item.valid || busy}
                onClick={() =>
                  void run(async () => {
                    unwrap(await window.desktop.recoveryAction('restore', item.id))
                  })
                }
              >
                恢复并重启
              </Button>
            </div>
          ))
        )}
      </Drawer>
      <Modal
        okButtonProps={{ 'aria-label': passwordMode === 'protection' ? '验证并启用' : '导出备份' }}
        title={passwordMode === 'protection' ? '设置备份密码' : '导出账本备份'}
        open={!!passwordMode}
        okText={passwordMode === 'protection' ? '验证并启用' : '导出备份'}
        cancelText="取消"
        confirmLoading={busy}
        closable={!busy}
        maskClosable={!busy}
        keyboard={!busy}
        onCancel={() => {
          if (!busy) {
            setPasswordMode(null)
            clearPasswords()
            setError('')
          }
        }}
        onOk={() =>
          void run(async () => {
            if (passwordMode === 'protection' || encryptedExport) {
              if (password.length < 12) throw new Error('密码至少需要 12 个字符。')
              if (password !== confirmation) throw new Error('两次输入的密码不一致。')
            }
            if (passwordMode === 'protection') {
              if (!remember) throw new Error('自动加密备份需要开启在本机安全保存备份凭据。')
              setProtection(
                unwrap(
                  await window.desktop.configureProtection({
                    enabled: true,
                    password,
                    remember: true
                  })
                )
              )
              setStatus(unwrap(await window.desktop.backupStatus()))
              onNotice('加密备份已验证并启用。')
            } else if (
              !unwrap(
                await window.desktop.exportBackup(
                  encryptedExport ? { encrypted: true, password } : { encrypted: false }
                )
              )
            )
              return
            else onNotice('备份已导出。')
            setPasswordMode(null)
            clearPasswords()
          })
        }
      >
        {passwordMode === 'export' && (
          <label className="modal-field">
            备份格式
            <SelectField
              label="备份格式"
              value={encryptedExport ? 'encrypted' : 'json'}
              onChange={(v) => setEncryptedExport(v === 'encrypted')}
              options={[
                { value: 'encrypted', label: '加密备份（推荐）' },
                { value: 'json', label: '普通 JSON（未加密）' }
              ]}
            />
          </label>
        )}
        {passwordMode === 'protection' || encryptedExport ? (
          <div className="password-fields">
            <label>
              备份密码
              <Input.Password
                aria-label="备份密码"
                value={password}
                maxLength={256}
                autoComplete="new-password"
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            <small className="muted">至少 12 个字符，建议使用较长口令；支持中文和空格。</small>
            {password && (
              <Progress
                strokeColor="#2d654b"
                size="small"
                percent={Math.min(100, Math.round((password.length / 24) * 100))}
                showInfo={false}
                status={password.length >= 16 ? 'success' : 'normal'}
                aria-label="密码长度提示"
              />
            )}
            <label>
              再次输入密码
              <Input.Password
                aria-label="再次输入密码"
                value={confirmation}
                maxLength={256}
                autoComplete="new-password"
                onChange={(e) => setConfirmation(e.target.value)}
              />
            </label>
            {passwordMode === 'protection' &&
              row(
                '在本机安全保存备份凭据',
                '用于自动备份，受到当前 Windows 用户账户保护。',
                <Switch
                  aria-label="在本机安全保存备份凭据"
                  checked={remember}
                  onChange={setRemember}
                />
              )}
            <p className="footnote">
              密码遗失无法找回。修改密码只影响后续备份；旧备份仍使用原密码。本机数据库和升级副本仍未加密。
            </p>
          </div>
        ) : (
          <p className="footnote">JSON 文件包含完整账本内容，未加密，请保存在可信位置。</p>
        )}
        {error && (
          <div className="error-banner" role="alert">
            {error}
          </div>
        )}
      </Modal>
      <Modal
        okButtonProps={{ 'aria-label': '验证并预览' }}
        zIndex={1200}
        title="解锁备份"
        open={!!selection}
        okText="验证并预览"
        cancelText="取消"
        confirmLoading={busy}
        closable={!busy}
        maskClosable={!busy}
        keyboard={!busy}
        onCancel={() => {
          if (!busy) {
            setSelection(null)
            clearPasswords()
            setError('')
          }
        }}
        onOk={() =>
          void run(async () => {
            if (!selection) return
            setPreview(unwrap(await window.desktop.unlockBackup(selection.token, password)))
            setSelection(null)
            clearPasswords()
          })
        }
      >
        <p className="restore-source">{selection?.source}</p>
        <label className="modal-field">
          备份密码
          <Input.Password
            aria-label="解锁备份密码"
            autoComplete="off"
            value={password}
            maxLength={256}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <p className="footnote">请使用创建这份备份时的密码。</p>
        {error && (
          <div className="error-banner" role="alert">
            {error}
          </div>
        )}
      </Modal>
      <Modal
        okButtonProps={{ 'aria-label': '确认恢复' }}
        zIndex={1250}
        title="恢复预览"
        open={!!preview}
        okText="确认恢复"
        cancelText="取消"
        confirmLoading={busy}
        closable={!busy}
        maskClosable={!busy}
        keyboard={!busy}
        onCancel={() => {
          if (!busy) {
            setPreview(null)
            setError('')
          }
        }}
        onOk={() =>
          void run(async () => {
            if (!preview) return
            const count = unwrap(await window.desktop.restoreBackup(preview.token, restoreMode))
            setPreview(null)
            setHistoryOpen(false)
            await onReload()
            setStatus(unwrap(await window.desktop.backupStatus()))
            onNotice(`已导入 ${count} 项订阅。`)
          })
        }
      >
        {preview && (
          <>
            <p className="restore-source">
              {preview.source}
              <small>备份时间：{timestamp(preview.exportedAt)}</small>
            </p>
            <p className="footnote">
              {preview.legacy
                ? '旧版备份仅包含订阅，现有账单与价格历史会保留。'
                : `包含 ${preview.bills} 笔账单、${preview.prices} 条价格记录、${preview.budgets} 个月预算。`}
            </p>
            {preview.fullRestoreSupported && (
              <label className="modal-field">
                恢复方式
                <SelectField
                  label="恢复方式"
                  value={restoreMode}
                  onChange={(v) => setRestoreMode(v as 'merge' | 'replace')}
                  options={[
                    { value: 'merge', label: '按订阅 ID 合并' },
                    { value: 'replace', label: '完整恢复整个账本' }
                  ]}
                />
              </label>
            )}
            <div className="restore-counts">
              <span>
                新增<strong>{preview.added}</strong>
              </span>
              <span>
                覆盖<strong>{preview.overwritten}</strong>
              </span>
              <span>
                {restoreMode === 'replace' ? '移除' : '保留'}
                <strong>{preview.retained}</strong>
              </span>
            </div>
            <p className="footnote">
              {restoreMode === 'replace'
                ? '备份之外的订阅及其账单会移除，预算和导入记录恢复到备份状态。'
                : '相同 ID 的订阅会覆盖，备份之外的订阅继续保留。'}
              恢复前自动保存当前账本；保护副本失败时停止恢复。本机设备设置不随账本恢复。
            </p>
          </>
        )}
        {error && (
          <div className="error-banner" role="alert">
            {error}
          </div>
        )}
      </Modal>
    </section>
  )
}
