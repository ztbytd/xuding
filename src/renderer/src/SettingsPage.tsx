import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, Drawer, Modal, Switch } from 'antd'
import { Download, History, ShieldCheck, Upload } from 'lucide-react'
import type {
  BackupEntry,
  BackupStatus,
  RestorePreview,
  Result,
  SettingsPatch,
  Snapshot
} from '../../shared/model'
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
export function SettingsPage({
  snapshot,
  onReload,
  onNotice
}: {
  snapshot: Snapshot
  onReload: () => Promise<Snapshot>
  onNotice: (message: string) => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [status, setStatus] = useState<BackupStatus>(snapshot.backupStatus)
  const [history, setHistory] = useState<BackupEntry[]>([])
  const [historyOpen, setHistoryOpen] = useState(false)
  const [preview, setPreview] = useState<RestorePreview | null>(null)
  const settings = snapshot.settings
  useEffect(() => {
    let active = true
    const refresh = async () => {
      try {
        const value = unwrap(await window.desktop.backupStatus())
        if (active) setStatus(value)
      } catch {
        /* The next poll or manual operation can retry. */
      }
    }
    void refresh()
    const timer = setInterval(() => void refresh(), 3000)
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
    } catch (error) {
      setError(error instanceof Error ? error.message : '操作失败，请重试。')
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
      onChange={(value) => save(patch(value))}
    />
  )
  return (
    <section className="settings-page">
      <header className="page-head">
        <div>
          <h1>设置与备份</h1>
          <p>数据留在本机，由你掌握。</p>
        </div>
        <ShieldCheck className="muted" size={26} />
      </header>
      {error && !preview && (
        <div className="error-banner" role="alert">
          {error}
        </div>
      )}
      <div className="settings-grid">
        <div className="settings-column">
          <Region
            title="桌面提醒"
            help="后台运行时会继续提醒。退出应用或电脑休眠期间不会发送通知；恢复运行后检查仍需处理的提醒。系统关闭通知时也可能收不到提醒。"
          >
            <div className="setting-row">
              <span>
                <strong>到期通知</strong>
                <small>按订阅提前天数提醒续费、试用结束或权益到期，每期最多一次。</small>
              </span>
              {toggle('开启桌面通知', settings.notificationsEnabled, (value) => ({
                notificationsEnabled: value
              }))}
            </div>
          </Region>
          <Region title="启动与后台">
            <div className="setting-row">
              <span>
                <strong>开机启动</strong>
                <small>
                  {snapshot.startupSupported
                    ? '登录 Windows 后自动启动续订。'
                    : 'Windows 安装版可配置开机启动。'}
                </small>
              </span>
              {toggle(
                '开机启动',
                settings.launchAtLogin,
                (value) => ({ launchAtLogin: value }),
                !snapshot.startupSupported
              )}
            </div>
            <div className="setting-row">
              <span>
                <strong>启动后收起到托盘</strong>
                <small>随系统启动时在后台运行。</small>
              </span>
              {toggle(
                '启动后收起到托盘',
                settings.startInTray,
                (value) => ({ startInTray: value }),
                !settings.launchAtLogin
              )}
            </div>
            <div className="setting-row">
              <span>
                <strong>关闭窗口时</strong>
                <small>后台运行会保留托盘图标并继续提醒。</small>
              </span>
              <SelectField
                label="关闭窗口时"
                value={settings.closeBehavior}
                disabled={busy}
                onChange={(value) => save({ closeBehavior: value as 'ask' | 'tray' | 'quit' })}
                options={[
                  { value: 'ask', label: '每次询问' },
                  { value: 'tray', label: '后台运行' },
                  { value: 'quit', label: '退出应用' }
                ]}
              />
            </div>
          </Region>
        </div>
        <Region
          title="数据备份"
          help="本地数据库与备份均未加密，建议将备份保存在可信位置。自动备份保留所选天数，恢复前快照额外保留最近 10 份。"
        >
          <div className="setting-row">
            <span>
              <strong>自动备份</strong>
              <small>修改订阅后自动保存，当天的修改合并到一份快照。</small>
            </span>
            {toggle('自动备份', settings.autoBackupEnabled, (value) => ({
              autoBackupEnabled: value
            }))}
          </div>
          <div className="setting-row">
            <span>
              <strong>保留时间</strong>
              <small>自动清理到期的应用备份。</small>
            </span>
            <SelectField
              label="备份保留时间"
              value={String(settings.backupRetentionDays)}
              disabled={busy}
              onChange={(value) => save({ backupRetentionDays: Number(value) })}
              options={[7, 14, 30, 90].map((value) => ({
                value: String(value),
                label: `最近 ${value} 天`
              }))}
            />
          </div>
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
          <div className="backup-status">
            <strong>
              {status.pending
                ? '等待自动备份…'
                : status.lastSuccess
                  ? `最近备份：${timestamp(status.lastSuccess)}`
                  : '尚未生成备份'}
            </strong>
            {status.lastError && <span className="backup-error">备份失败：{status.lastError}</span>}
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
          </div>
          <div className="setting-row">
            <span>
              <strong>导出订阅</strong>
              <small>包含订阅、图标与到期日的 JSON 文件。</small>
            </span>
            <Button
              icon={<Download size={15} />}
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  if (unwrap(await window.desktop.exportBackup())) onNotice('备份已导出。')
                })
              }
            >
              导出备份
            </Button>
          </div>
          <div className="setting-row">
            <span>
              <strong>导入备份</strong>
              <small>先预览变化，恢复前自动保存当前账本。</small>
            </span>
            <Button
              icon={<Upload size={15} />}
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  setPreview(unwrap(await window.desktop.previewImport()))
                })
              }
            >
              导入备份
            </Button>
          </div>
        </Region>
      </div>
      <footer className="settings-about">
        续订 {snapshot.version} · MIT 开源许可 · 本机 SQLite 存储
      </footer>
      <Drawer
        title="备份历史"
        closable={{ 'aria-label': '关闭备份历史' }}
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        size={480}
      >
        {!history.length ? (
          <div className="empty">还没有可恢复的备份。</div>
        ) : (
          history.map((item) => (
            <div className="backup-history-item" key={item.id}>
              <div>
                <strong>{timestamp(item.createdAt)}</strong>
                <small>
                  {item.kind === 'daily'
                    ? '自动备份'
                    : item.kind === 'manual'
                      ? '手动备份'
                      : '恢复前快照'}{' '}
                  · {item.count} 项订阅 · {(item.size / 1024).toFixed(1)} KB
                </small>
              </div>
              <Button
                disabled={busy}
                aria-label={`恢复 ${item.id}`}
                onClick={() =>
                  void run(async () => {
                    setPreview(unwrap(await window.desktop.previewBackup(item.id)))
                  })
                }
              >
                恢复
              </Button>
            </div>
          ))
        )}
      </Drawer>
      <Modal
        zIndex={1200}
        cancelButtonProps={{ autoInsertSpace: false }}
        okButtonProps={{ autoInsertSpace: false }}
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
            const count = unwrap(await window.desktop.restoreBackup(preview.token))
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
            <p className="restore-source" title={preview.source}>
              {preview.source}
              <small>备份时间：{timestamp(preview.exportedAt)}</small>
            </p>
            <div className="restore-counts">
              <span>
                新增<strong>{preview.added}</strong>
              </span>
              <span>
                覆盖<strong>{preview.overwritten}</strong>
              </span>
              <span>
                保留<strong>{preview.retained}</strong>
              </span>
            </div>
            <p className="footnote">
              相同 ID 的订阅会覆盖，其他订阅保留。恢复前会自动备份当前账本；备份失败时停止恢复。
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
