import { UnlockPage } from './SecuritySettings'
import type { SecurityStatus } from '../../shared/vault-model'
import { useEffect, useState } from 'react'
import { Button, Tag } from 'antd'
import { ShieldAlert } from 'lucide-react'
import type { RecoveryState } from '../../shared/operations-model'
import { App } from './App'

export function Startup() {
  const [security, setSecurity] = useState<SecurityStatus | null>(null)
  const refreshSecurity = () =>
    void window.desktop
      .securityStatus()
      .then((r) => {
        if (r.ok && !r.data.busy) setSecurity(r.data)
      })
      .catch(() => {})
  useEffect(() => {
    refreshSecurity()
    const t = setInterval(refreshSecurity, 1000)
    return () => clearInterval(t)
  }, [])
  const [state, setState] = useState<RecoveryState | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false)
  useEffect(() => {
    void window.desktop
      .recoveryStatus()
      .then((result) => {
        if (result.ok) setState(result.data)
        else setError(result.error)
      })
      .catch(() => setError('无法读取启动状态，请重新启动续订。'))
  }, [])
  async function action(value: 'retry' | 'directory' | 'restore', id?: string) {
    setBusy(true)
    setError('')
    try {
      const result = await window.desktop.recoveryAction(value, id)
      if (!result.ok) throw new Error(result.error)
    } catch (e) {
      setError(e instanceof Error ? e.message : '恢复失败，请重试。')
    } finally {
      setBusy(false)
    }
  }
  if (!security) return <div className="startup-loading">正在打开续订…</div>
  if (security.locked)
    return (
      <UnlockPage
        onUnlocked={() => {
          setState(null)
          refreshSecurity()
          void window.desktop.recoveryStatus().then((r) => r.ok && setState(r.data))
        }}
      />
    )
  if (state && !state.active) return <App />
  if (!state) return <div className="startup-loading">{error || '正在打开续订…'}</div>
  return (
    <>
      <header className="window-titlebar" aria-hidden="true" />
      <main className="recovery-page">
        <ShieldAlert size={32} />
        <h1>恢复续订账本</h1>
        <p>{state.reason}</p>
        {error && (
          <div className="error-banner" role="alert">
            {error}
          </div>
        )}
        <div className="backup-actions">
          <Button disabled={busy} onClick={() => void action('retry')}>
            重试启动
          </Button>
          <Button disabled={busy} onClick={() => void action('directory')}>
            打开数据目录
          </Button>
          <Button
            disabled={busy}
            onClick={() =>
              void window.desktop.diagnosticsExport().then((v) => {
                if (!v.ok) setError(v.error)
              })
            }
          >
            导出诊断包
          </Button>
        </div>
        <section className="panel">
          <h2>升级前恢复副本</h2>
          <p className="footnote">选择恢复点后会再次确认。当前故障数据库将另外保留。</p>
          {state.entries.length ? (
            state.entries.map((entry) => (
              <div className="backup-history-item" key={entry.id}>
                <div>
                  <strong>
                    {new Date(entry.createdAt).toLocaleString('zh-CN', { hour12: false })}
                  </strong>
                  <small>
                    {entry.valid
                      ? `数据库结构 ${entry.version} · ${(entry.size / 1024).toFixed(1)} KB`
                      : '副本无法通过检查'}
                  </small>
                </div>
                <Tag color={entry.valid ? 'green' : 'red'}>{entry.valid ? '已验证' : '异常'}</Tag>
                <Button
                  disabled={busy || !entry.valid}
                  onClick={() => void action('restore', entry.id)}
                >
                  恢复并重启
                </Button>
              </div>
            ))
          ) : (
            <div className="empty">
              未找到可用恢复副本。请保留现有数据文件，并通过诊断信息排查。
            </div>
          )}
        </section>
      </main>
    </>
  )
}
