import { useEffect, useState } from 'react'
import { Button, Input, Modal, Switch, Tag } from 'antd'
import { LockKeyhole, ShieldCheck } from 'lucide-react'
import type { SecurityAction, SecurityOptions, SecurityStatus } from '../../shared/vault-model'
import { securityOptionsSchema } from '../../shared/vault-model'
import { HelpTip, SelectField } from './controls'
export function SecuritySettings() {
  const [state, setState] = useState<SecurityStatus | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [mode, setMode] = useState<'enable' | 'password' | 'recovery' | 'rekey' | null>(null),
    [password, setPassword] = useState(''),
    [current, setCurrent] = useState(''),
    [repeat, setRepeat] = useState(''),
    [recovery, setRecovery] = useState(''),
    [confirmation, setConfirmation] = useState(''),
    [prepared, setPrepared] = useState(false),
    [options, setOptions] = useState(securityOptionsSchema.parse({})),
    [legacy, setLegacy] = useState<{ id: string; size: number }[]>([])
  useEffect(() => {
    void window.desktop.securityStatus().then((r) => {
      if (r.ok) {
        setState(r.data)
        setOptions(r.data.options)
      }
    })
  }, [])
  async function action(input: SecurityAction) {
    const r = await window.desktop.securityAction(input)
    if (!r.ok) throw new Error(r.error)
    setState(r.data)
    if (r.data.recoveryKey) setRecovery(r.data.recoveryKey)
    if (r.data.legacy) setLegacy(r.data.legacy)
    return r.data
  }
  async function run(work: () => Promise<unknown>) {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await work()
    } catch (e) {
      setError(e instanceof Error ? e.message : '安全设置失败。')
    } finally {
      setBusy(false)
    }
  }
  function open(v: typeof mode) {
    setPassword('')
    setCurrent('')
    setRepeat('')
    setRecovery('')
    setConfirmation('')
    setPrepared(false)
    setError('')
    setMode(v)
  }
  const saveOption = (patch: Partial<SecurityOptions>) =>
    void run(async () => {
      const next = { ...options, ...patch }
      await action({ action: 'options', options: next })
      setOptions(next)
    })
  const row = (title: string, detail: string, control: React.ReactNode) => (
    <div className="setting-row">
      <span>
        {title}
        <small>{detail}</small>
      </span>
      {control}
    </div>
  )
  return (
    <div className="settings-tab-content settings-grid">
      <section className="panel">
        <div className="panel-head">
          <div className="panel-title">
            <ShieldCheck size={18} />
            <h2>本地账本加密</h2>
            <HelpTip label="本地账本加密">
              加密保护数据库、关联日志和新恢复副本。保护文件被复制后的内容；解锁运行期间，应用仍需在内存中使用数据。
            </HelpTip>
          </div>
          <Tag color={state?.enabled ? 'green' : 'default'}>
            {state?.enabled ? '已加密' : '未开启'}
          </Tag>
        </div>
        {error && (
          <div className="error-banner" role="alert">
            {error}
          </div>
        )}
        <p className="footnote">
          启用后设置解锁密码并保存恢复密钥。密码与恢复密钥均丢失时，需从其他备份或设备恢复。
        </p>
        <div className="backup-actions">
          {!state?.enabled ? (
            <Button type="primary" onClick={() => open('enable')}>
              启用本地加密
            </Button>
          ) : (
            <>
              <Button
                icon={<LockKeyhole size={15} />}
                disabled={busy}
                onClick={() => void run(() => action({ action: 'lock' }))}
              >
                立即锁定
              </Button>
              <Button onClick={() => open('password')}>修改解锁密码</Button>
              <Button onClick={() => open('recovery')}>更换恢复密钥</Button>
              <Button onClick={() => open('rekey')}>更换数据密钥</Button>
            </>
          )}
        </div>
        {state?.enabled && (
          <>
            <div className="setting-row">
              <span>空闲自动锁定</span>
              <SelectField
                label="空闲自动锁定"
                value={String(options.idleMinutes)}
                onChange={(v) =>
                  saveOption({ idleMinutes: Number(v) as SecurityOptions['idleMinutes'] })
                }
                options={[
                  { value: '0', label: '关闭' },
                  ...[5, 15, 30, 60].map((n) => ({ value: String(n), label: `${n} 分钟` }))
                ]}
              />
            </div>
            {row(
              '系统锁屏时锁定',
              '解锁后恢复同步和提醒。',
              <Switch
                aria-label="系统锁屏时锁定"
                checked={options.lockOnScreen}
                disabled={busy}
                onChange={(v) => saveOption({ lockOnScreen: v })}
              />
            )}
            {row(
              '电脑休眠时锁定',
              '锁定期间暂停账本任务。',
              <Switch
                aria-label="电脑休眠时锁定"
                checked={options.lockOnSuspend}
                disabled={busy}
                onChange={(v) => saveOption({ lockOnSuspend: v })}
              />
            )}
            {row(
              '通知显示名称和金额',
              '关闭后只提示有待处理事项。',
              <Switch
                aria-label="通知显示名称和金额"
                checked={options.showNotificationDetails}
                disabled={busy}
                onChange={(v) => saveOption({ showNotificationDetails: v })}
              />
            )}
            {row(
              '在此 Windows 账户记住解锁信息',
              '开启后重启可自动解锁；保护范围是当前系统账户。',
              <Switch
                aria-label="记住解锁信息"
                checked={options.remember}
                disabled={busy}
                onChange={(v) => (v ? open('password') : saveOption({ remember: false }))}
              />
            )}
          </>
        )}
      </section>
      {state?.enabled && (
        <section className="panel">
          <div className="panel-head">
            <h2>历史明文备份</h2>
            <HelpTip label="历史明文备份">
              只检查应用管理的备份目录。复制到其他目录或网盘的旧文件需自行处理；普通删除不保证物理擦除。
            </HelpTip>
          </div>
          <div className="backup-actions">
            <Button
              disabled={busy}
              onClick={() => void run(() => action({ action: 'legacy', operation: 'list' }))}
            >
              检查旧明文备份
            </Button>
            <Button
              disabled={busy || !legacy.length}
              onClick={() =>
                void run(async () => {
                  await action({ action: 'legacy', operation: 'convert' })
                  await action({ action: 'legacy', operation: 'list' })
                })
              }
            >
              转换并移除明文
            </Button>
            <Button
              danger
              disabled={busy || !legacy.length}
              onClick={() =>
                void run(async () => {
                  await action({ action: 'legacy', operation: 'delete' })
                  await action({ action: 'legacy', operation: 'list' })
                })
              }
            >
              删除旧明文备份
            </Button>
          </div>
          {legacy.map((v) => (
            <div key={v.id} className="legacy-item">
              <span>{v.id}</span>
              <small>{(v.size / 1024).toFixed(1)} KB</small>
            </div>
          ))}
        </section>
      )}
      <Modal
        title={
          mode === 'enable'
            ? '启用本地加密'
            : mode === 'password'
              ? '修改解锁密码'
              : mode === 'rekey'
                ? '更换数据密钥'
                : '更换恢复密钥'
        }
        open={mode !== null}
        onCancel={() => {
          if (!busy) {
            setMode(null)
            setPassword('')
            setCurrent('')
            setRecovery('')
          }
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
        {recovery ? (
          <>
            <p>请将恢复密钥保存在可信位置。输入最后 8 位确认保存。</p>
            <Input.TextArea
              aria-label="恢复密钥"
              className="recovery-key"
              readOnly
              value={recovery}
              autoSize
            />
            <div className="backup-actions">
              <Button
                onClick={() => void run(() => action({ action: 'saveRecovery', key: recovery }))}
              >
                另存恢复密钥
              </Button>
            </div>
            {mode === 'enable' && prepared ? (
              <>
                <Input
                  aria-label="恢复密钥最后八位"
                  placeholder="最后 8 位"
                  value={confirmation}
                  onChange={(e) => setConfirmation(e.target.value)}
                />
                <Button
                  type="primary"
                  aria-label="确认启用加密"
                  loading={busy}
                  disabled={confirmation.trim().toUpperCase() !== recovery.slice(-8)}
                  onClick={() =>
                    void run(async () => {
                      await action({ action: 'enable', confirmation })
                      setMode(null)
                      setRecovery('')
                      setPassword('')
                    })
                  }
                >
                  确认并加密账本
                </Button>
              </>
            ) : (
              <Button
                type="primary"
                onClick={() => {
                  setRecovery('')
                  setMode(null)
                }}
              >
                已妥善保存
              </Button>
            )}
          </>
        ) : (
          <div className="secure-form">
            {mode !== 'enable' && (
              <label>
                <span>{mode === 'password' ? '当前密码或恢复密钥' : '当前解锁密码'}</span>
                <Input.Password
                  aria-label="当前解锁密码"
                  autoComplete="off"
                  value={current}
                  onChange={(e) => setCurrent(e.target.value)}
                  maxLength={256}
                />
              </label>
            )}
            {(mode === 'enable' || mode === 'password') && (
              <>
                <label>
                  <span>新解锁密码</span>
                  <Input.Password
                    aria-label="新解锁密码"
                    autoComplete="new-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    maxLength={256}
                  />
                </label>
                <label>
                  <span>再次输入密码</span>
                  <Input.Password
                    aria-label="再次输入解锁密码"
                    autoComplete="new-password"
                    value={repeat}
                    onChange={(e) => setRepeat(e.target.value)}
                    maxLength={256}
                  />
                </label>
                <p className="footnote">
                  至少 12 个字符。已有备份密码保持独立；未配置时会用此密码启用加密备份。
                </p>
                <div className="setting-row">
                  <span>记住此设备解锁信息</span>
                  <Switch
                    aria-label="配置时记住解锁信息"
                    checked={options.remember}
                    onChange={(v) => setOptions((o) => ({ ...o, remember: v }))}
                  />
                </div>
              </>
            )}
            {mode === 'rekey' && (
              <p className="footnote">
                重新加密本地账本，并生成新的恢复密钥。请先确认当前备份可用。
              </p>
            )}
            <Button
              type="primary"
              loading={busy}
              aria-label="提交安全设置"
              onClick={() =>
                void run(async () => {
                  if (
                    (mode === 'enable' || mode === 'password') &&
                    (password.length < 12 || password !== repeat)
                  )
                    throw new Error('请输入至少 12 个字符，且两次密码须一致。')
                  if (mode === 'enable') {
                    await action({ action: 'prepare', password, options })
                    setPrepared(true)
                  } else if (mode === 'password') {
                    await action({ action: 'password', current, password, options })
                    setMode(null)
                    setPassword('')
                    setCurrent('')
                  } else if (mode === 'recovery')
                    await action({ action: 'recovery', password: current })
                  else if (mode === 'rekey') await action({ action: 'rekey', password: current })
                })
              }
            >
              {mode === 'enable' ? '生成恢复密钥' : '确认修改'}
            </Button>
          </div>
        )}
      </Modal>
    </div>
  )
}

export function UnlockPage({ onUnlocked }: { onUnlocked: () => void }) {
  const [password, setPassword] = useState(''),
    [recovery, setRecovery] = useState(false),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false)
  async function unlock() {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const r = await window.desktop.securityAction({ action: 'unlock', password, recovery })
      if (!r.ok) throw new Error(r.error)
      setPassword('')
      onUnlocked()
    } catch (e) {
      setError(e instanceof Error ? e.message : '解锁失败。')
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <header className="window-titlebar" aria-hidden="true" />
      <main className="unlock-page">
        <section className="panel">
          <span className="unlock-symbol">
            <LockKeyhole size={28} />
          </span>
          <h1>解锁续订</h1>
          <p>账本已加密，解锁后继续使用。</p>
          {error && (
            <div role="alert" className="error-banner">
              {error}
            </div>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault()
              void unlock()
            }}
          >
            <Input.Password
              aria-label={recovery ? '输入恢复密钥' : '输入解锁密码'}
              placeholder={recovery ? '恢复密钥' : '解锁密码'}
              value={password}
              maxLength={256}
              autoComplete="off"
              autoFocus
              onChange={(e) => setPassword(e.target.value)}
            />
            <Button
              type="primary"
              htmlType="submit"
              aria-label="解锁账本"
              loading={busy}
              disabled={!password}
            >
              解锁账本
            </Button>
          </form>
          <Button
            type="link"
            onClick={() => {
              setRecovery(!recovery)
              setPassword('')
              setError('')
            }}
          >
            {recovery ? '使用密码解锁' : '使用恢复密钥'}
          </Button>
          <small>锁定期间暂停账本同步、备份与扣款提醒。</small>
        </section>
      </main>
    </>
  )
}
