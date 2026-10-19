import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  net,
  Notification,
  powerMonitor,
  safeStorage,
  shell
} from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { mkdirSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { SubscriptionRepository } from './database'
import { ExchangeService } from './exchange'
import { CsvService } from './csv'
import { csvExportSchema, csvOptionsSchema } from '../shared/csv-model'
import { exportCsv } from '../shared/csv'
import { budgetReminderCandidates } from '../shared/analytics'
import { budgetInputSchema } from '../shared/analytics-model'
import { BackupService } from './backups'
import { DesktopLifecycle } from './desktop'
import {
  backupSchema,
  settingsPatchSchema,
  settingsSchema,
  subscriptionInputSchema
} from '../shared/model'
import { billInputSchema, billUpdateSchema } from '../shared/ledger-model'
import { channels } from '../shared/channels'
import type { Result, DesktopAction } from '../shared/model'
import { localDate } from '../shared/billing'
import { reminderCandidates } from '../shared/attention'
import { backupProtectionSchema, exportBackupOptionsSchema } from '../shared/operations-model'
import { CredentialVault } from './credentials'
import { Diagnostics } from './diagnostics'
import { RecoveryService } from './recovery'
import { UpdateService } from './updates'
import { NsisUpdater } from 'electron-updater'
import updateTrust from '../../resources/update-trust.json'
import { atomicWrite } from './files'
import { LocalVault } from './vault'
import { SyncEngine } from './sync'
import { securityActionSchema } from '../shared/vault-model'
import { syncActionSchema } from '../shared/sync-model'
import { decisionInputSchema } from '../shared/decision-model'
import { dateSchema } from '../shared/primitives'
import type { SecurityStatus } from '../shared/vault-model'

app.setName('xuding')
if (process.env.XUDING_DATA_DIR && isAbsolute(process.env.XUDING_DATA_DIR)) {
  mkdirSync(process.env.XUDING_DATA_DIR, { recursive: true })
  app.setPath('userData', process.env.XUDING_DATA_DIR)
}
app.setAppUserModelId('io.github.ztbytd.xuding')
let window: BrowserWindow | null = null
let repository: SubscriptionRepository
let exchange: ExchangeService
let backups: BackupService
let csv: CsvService
let desktop: DesktopLifecycle
let diagnostics: Diagnostics
let recovery: RecoveryService
let recoveryReason: string | null = null
let updates: UpdateService
let localVault: LocalVault
let systemVault: CredentialVault
let sync: SyncEngine
let apiRegistered = false
let securityBusy = false
let syncTimer: ReturnType<typeof setInterval> | undefined
let syncDelay: ReturnType<typeof setTimeout> | undefined
let syncOperations = 0
let lastAutoSync = 0
let lockRequested = false
let maintenance = false
let activeOperations = 0
let startupMarked = false
const mutatingChannels = new Set<string>([
  channels.save,
  channels.archive,
  channels.updateBill,
  channels.addBill,
  channels.changePrice,
  channels.saveBudget,
  channels.settings,
  channels.csvCommit,
  channels.restoreBackup,
  channels.backupNow,
  channels.configureProtection,
  channels.chooseBackupDirectory,
  channels.removeBackup,
  channels.exportBackup,
  channels.decisionSave,
  channels.usageRecord
])
let rendererReady = false
let pendingAction: DesktopAction | null = null
let sequence = 0
const remindersInFlight = new Set<string>()
const visibleNotifications = new Set<Notification>()
let reminderTimer: ReturnType<typeof setInterval> | undefined
const devUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined
const rendererPath = join(__dirname, '../renderer/index.html')

function isTrusted(event: IpcMainInvokeEvent): boolean {
  if (
    !window ||
    event.sender !== window.webContents ||
    event.senderFrame !== window.webContents.mainFrame
  )
    return false
  const url = event.senderFrame?.url
  if (!url) return false
  return devUrl
    ? new URL(url).origin === new URL(devUrl).origin
    : url.split('#')[0] === pathToFileURL(rendererPath).href
}
function handle(channel: string, handler: (...args: any[]) => unknown): void {
  ipcMain.handle(channel, async (event, ...args): Promise<Result<unknown>> => {
    if (!isTrusted(event)) return { ok: false, error: '无法处理此来源的请求。' }
    if (
      localVault?.locked &&
      ![
        channels.securityStatus,
        channels.securityAction,
        channels.diagnosticsExport,
        channels.recoveryStatus
      ].includes(channel as typeof channels.securityStatus)
    )
      return { ok: false, error: '账本已锁定，请先解锁。' }
    const mutating = mutatingChannels.has(channel)
    if (
      maintenance &&
      ![channels.updateStatus, channels.diagnosticsExport, channels.securityStatus].includes(
        channel as typeof channels.updateStatus
      )
    )
      return { ok: false, error: '应用正在保护或切换账本，请稍后操作。' }
    const ledgerOperation = ![
      channels.securityStatus,
      channels.securityAction,
      channels.syncStatus,
      channels.syncAction,
      channels.recoveryStatus,
      channels.updateStatus,
      channels.updateAction,
      channels.recoveryAction,
      channels.diagnosticsExport
    ].includes(channel as typeof channels.securityStatus)
    if (ledgerOperation) activeOperations++
    try {
      const data = await handler(...args)
      if (mutating && sync && !localVault?.locked) {
        if (syncDelay) clearTimeout(syncDelay)
        syncDelay = setTimeout(() => void runSync(), 10000)
        syncDelay.unref()
      }
      return { ok: true, data }
    } catch (error) {
      diagnostics?.record('ipc.' + channel.replaceAll(':', '-'), error)
      if (error instanceof z.ZodError)
        return { ok: false, error: error.issues.map((i) => i.message).join('；') }
      return { ok: false, error: error instanceof Error ? error.message : '操作失败，请重试。' }
    } finally {
      if (ledgerOperation) activeOperations--
      if (lockRequested && !activeOperations && !maintenance && !sync?.busy)
        void lockLedger().catch((e) => diagnostics.record('security.lock-failed', e))
    }
  })
}

function registerOperations(): void {
  handle(channels.recoveryStatus, async () => ({
    active: recoveryReason !== null,
    reason: recoveryReason || '',
    entries: localVault?.locked ? [] : await recovery.entries()
  }))
  handle(channels.recoveryAction, async (raw, id) => {
    const action = z.enum(['retry', 'restore', 'directory']).parse(raw)
    if (action === 'directory') {
      await shell.openPath(app.getPath('userData'))
      return
    }
    if (!recoveryReason && action === 'retry') throw new Error('仅在启动恢复窗口中执行此操作。')
    if (action === 'restore') {
      const entry = z.string().max(180).parse(id)
      const result = await dialog.showMessageBox(window!, {
        type: 'warning',
        title: '恢复升级前副本',
        message: '将使用所选副本恢复本机账本。',
        detail: '当前故障数据库及关联文件会另外保留。副本创建后的修改不会出现在恢复的账本中。',
        buttons: ['取消', '恢复并重启'],
        defaultId: 0,
        cancelId: 0
      })
      if (result.response !== 1) return
      const normal = !recoveryReason
      if (normal) {
        if (activeOperations || maintenance || sync?.busy || syncOperations > 0)
          throw new Error('账本正忙，请等待当前操作完成。')
        maintenance = true
        try {
          await backups.flush()
          await backups.nowBackup()
          recovery.checkpointNow()
          repository.close()
        } catch (error) {
          maintenance = false
          throw error
        }
      }
      try {
        await recovery.restore(entry)
      } catch (error) {
        diagnostics.record('recovery.restore-failed', error)
        if (normal) {
          app.relaunch()
          app.exit(1)
        }
        throw error
      }
      diagnostics.record('recovery.restored')
    }
    app.relaunch()
    app.exit(0)
  })
  handle(channels.diagnosticsExport, async () => {
    if (!window) return false
    const answer = await dialog.showMessageBox(window, {
      type: 'info',
      title: '导出诊断',
      message: '诊断包包含应用版本、系统版本与操作错误码。',
      detail: '不包含账本、备份、订阅内容、密码和个人文件路径。文件只保存到你选择的位置。',
      buttons: ['取消', '选择保存位置'],
      defaultId: 1,
      cancelId: 0
    })
    if (answer.response !== 1) return false
    const picked = await dialog.showSaveDialog(window, {
      title: '保存诊断包',
      defaultPath: `xuding-diagnostics-${localDate()}.json`,
      filters: [{ name: '诊断包', extensions: ['json'] }]
    })
    if (picked.canceled || !picked.filePath) return false
    await atomicWrite(picked.filePath, await diagnostics.export())
    return true
  })
}

function registerApi(): void {
  handle(channels.openLicenses, async () => {
    const error = await shell.openPath(
      app.isPackaged
        ? join(process.resourcesPath, 'third-party-notices.txt')
        : join(app.getAppPath(), 'resources/third-party-notices.txt')
    )
    if (error) throw new Error('无法打开第三方许可文件。')
  })
  handle(channels.navigationReady, () => {
    rendererReady = true
    if (!startupMarked) {
      startupMarked = true
      repository.saveMetadata('last-success-version', app.getVersion())
      void recovery.successful().catch((e) => diagnostics.record('recovery.cleanup-failed', e))
    }
    const action = pendingAction
    pendingAction = null
    return action
  })
  handle(channels.exchangeRates, async (force) => {
    const result = await exchange.get(z.boolean().optional().parse(force))
    if (result.table) repository.recordRate(result.table)
    return result
  })
  handle(channels.pickIcon, async () => {
    if (!window) return null
    const picked = await dialog.showOpenDialog(window, {
      title: '选择订阅图标',
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg'] }]
    })
    if (picked.canceled || !picked.filePaths[0]) return null
    const file = picked.filePaths[0]
    if ((await stat(file)).size > 5 * 1024 * 1024)
      throw new Error('图片不能超过 5 MB，请选择较小的图片。')
    const image = nativeImage.createFromBuffer(await readFile(file))
    if (image.isEmpty()) throw new Error('无法读取这张图片，请选择 PNG 或 JPG 图片。')
    const { width, height } = image.getSize()
    const normalized = image.resize({
      ...(width >= height ? { width: Math.min(width, 128) } : { height: Math.min(height, 128) }),
      quality: 'best'
    })
    return 'data:image/png;base64,' + normalized.toPNG().toString('base64')
  })
  handle(channels.updateBill, async (raw) => {
    const input = billUpdateSchema.parse(raw)
    const rates =
      input.status === 'paid' ? (await exchange.get()).table : repository.exchangeRates()
    const bill = repository.ledger.updateBill(input, rates)
    backups.changed()
    return bill
  })
  handle(channels.addBill, async (raw) => {
    const input = billInputSchema.parse(raw)
    const rates = (await exchange.get()).table
    const bill = repository.ledger.addBill(input, rates)
    backups.changed()
    return bill
  })
  handle(channels.changePrice, (input) => {
    repository.ledger.changePrice(input)
    backups.changed()
  })
  handle(channels.decisionSave, (input) => {
    const d = repository.decisions.update(decisionInputSchema.parse(input))
    backups.changed()
    return d
  })
  handle(channels.usageRecord, (id, day, remove) => {
    repository.decisions.record(
      z.string().uuid().parse(id),
      dateSchema.parse(day),
      z.boolean().optional().parse(remove)
    )
    backups.changed()
  })
  handle(channels.load, () => {
    repository.decisions.archiveDue()
    const billsChanged = repository.ledger.sync(),
      budgetsChanged = repository.finance.ensureMonths()
    if (billsChanged || budgetsChanged) backups.changed()
    return {
      budgets: repository.finance.budgets(),
      importBatches: repository.finance.batches(),
      bills: repository.ledger.bills(),
      prices: repository.ledger.prices(),
      changes: repository.ledger.changes(),
      subscriptions: repository.list(),
      usage: repository.decisions.usage(),
      histories: repository.history(),
      rateHistory: repository.rateHistory(),
      decisions: repository.decisions.list(),
      settings: repository.settings(),
      exchangeRates: repository.exchangeRates(),
      version: app.getVersion(),
      backupStatus: backups.status(),
      startupSupported: desktop.startupSupported
    }
  })
  handle(channels.save, (raw, id) => {
    const item = repository.save(
      subscriptionInputSchema.parse(raw),
      id === undefined ? undefined : z.string().uuid().parse(id)
    )
    backups.changed()
    return item
  })
  handle(channels.archive, (id) => {
    repository.archive(z.string().uuid().parse(id))
    backups.changed()
  })
  handle(channels.settings, (raw) => {
    const patch = settingsPatchSchema.parse(raw),
      previous = repository.settings()
    const next = settingsSchema.parse({ ...previous, ...patch })
    if (!next.launchAtLogin) next.startInTray = false
    desktop.updateLogin(previous, next)
    const saved = repository.saveSettings(next)
    backups.changed()
    return saved
  })
  handle(channels.saveBudget, (input) => {
    const item = repository.finance.save(budgetInputSchema.parse(input))
    backups.changed()
    return item
  })
  handle(channels.csvChoose, async () => {
    if (!window) return null
    const picked = await dialog.showOpenDialog(window, {
      title: '选择 CSV 文件',
      properties: ['openFile'],
      filters: [{ name: 'CSV 表格', extensions: ['csv', 'tsv'] }]
    })
    return picked.canceled || !picked.filePaths[0] ? null : csv.choose(picked.filePaths[0])
  })
  handle(channels.csvDecode, (token, encoding) =>
    csv.decode(z.string().uuid().parse(token), z.enum(['utf-8', 'gb18030']).parse(encoding))
  )
  handle(channels.csvPreview, async (raw) => {
    const options = csvOptionsSchema.parse(raw)
    repository.ledger.sync()
    repository.finance.ensureMonths()
    const rates =
      options.conversion === 'current' ? (await exchange.get()).table : repository.exchangeRates()
    return csv.preview(options, rates)
  })
  handle(channels.csvCommit, (token) => csv.commit(z.string().uuid().parse(token)))
  handle(channels.csvExport, async (raw) => {
    const input = csvExportSchema.parse(raw)
    if (!window) return false
    const result = await dialog.showSaveDialog(window, {
      title: input.template ? '保存 CSV 模板' : '导出 CSV',
      defaultPath: `xuding-${input.kind}-${input.template ? 'template' : localDate()}.csv`,
      filters: [{ name: 'CSV 表格', extensions: ['csv'] }]
    })
    if (result.canceled || !result.filePath) return false
    await writeFile(
      result.filePath,
      exportCsv(input, repository.list(), repository.ledger.bills()),
      { encoding: 'utf8', mode: 0o600 }
    )
    return true
  })
  handle(channels.backupStatus, () => backups.status())
  handle(channels.protectionStatus, () => backups.protectionStatus())
  handle(channels.configureProtection, (raw) =>
    backups.configure(backupProtectionSchema.parse(raw))
  )
  handle(channels.selectBackup, (id) => backups.select(z.string().max(120).parse(id)))
  handle(channels.unlockBackup, (token, password) =>
    backups.unlock(z.string().uuid().parse(token), z.string().max(256).optional().parse(password))
  )
  handle(channels.removeBackup, (id) => backups.remove(z.string().max(120).parse(id)))
  handle(channels.copyBackup, async (raw) => {
    const id = z.string().max(120).parse(raw),
      bytes = await backups.bytes(id)
    const picked = await dialog.showSaveDialog(window!, {
      title: '另存备份',
      defaultPath: id,
      filters: [{ name: '续订备份', extensions: [id.endsWith('.json') ? 'json' : 'xudingbackup'] }]
    })
    if (picked.canceled || !picked.filePath) return false
    await atomicWrite(picked.filePath, bytes)
    return true
  })
  handle(channels.openBackupDirectory, async () => {
    await mkdir(backups.status().directory, { recursive: true })
    const error = await shell.openPath(backups.status().directory)
    if (error) throw new Error('无法打开备份目录。')
  })
  handle(channels.chooseImport, async () => {
    const picked = await dialog.showOpenDialog(window!, {
      title: '导入续订备份',
      properties: ['openFile'],
      filters: [{ name: '续订备份', extensions: ['json', 'xudingbackup'] }]
    })
    if (picked.canceled || !picked.filePaths[0]) return null
    return backups.selectFile(picked.filePaths[0])
  })
  handle(channels.updateStatus, () => updates.status())
  handle(channels.updateAction, (raw) => {
    const action = z.enum(['check', 'download', 'install']).parse(raw)
    return action === 'check'
      ? updates.check()
      : action === 'download'
        ? updates.download()
        : updates.install()
  })
  handle(channels.updatePreference, (raw) => updates.preference(z.boolean().parse(raw)))
  handle(channels.backupNow, () => backups.nowBackup())
  handle(channels.backupHistory, () => backups.history())
  handle(channels.previewBackup, (id) => backups.preview(z.string().max(120).parse(id)))
  handle(channels.restoreBackup, (token, mode) =>
    backups.restore(
      z.string().uuid().parse(token),
      z.enum(['merge', 'replace']).optional().parse(mode)
    )
  )
  handle(channels.chooseBackupDirectory, async () => {
    if (!window) return backups.status()
    const picked = await dialog.showOpenDialog(window, {
      title: '选择备份位置',
      properties: ['openDirectory', 'createDirectory']
    })
    return picked.canceled || !picked.filePaths[0]
      ? backups.status()
      : backups.setDirectory(picked.filePaths[0])
  })
  handle(channels.openWebsite, async (raw) => {
    const url = z.string().max(2048).parse(raw)
    const parsed = new URL(url)
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password)
      throw new Error('仅支持不含登录凭据的 HTTP / HTTPS 网页。')
    await shell.openExternal(parsed.href)
  })
  handle(channels.exportBackup, async (raw) => {
    const options = exportBackupOptionsSchema.parse(raw ?? { encrypted: false })
    if (!window) return false
    const result = await dialog.showSaveDialog(window, {
      title: '导出账本备份',
      defaultPath: `xuding-backup-${localDate()}.${options.encrypted ? 'xudingbackup' : 'json'}`,
      filters: [
        {
          name: options.encrypted ? '加密备份' : 'JSON 备份',
          extensions: [options.encrypted ? 'xudingbackup' : 'json']
        }
      ]
    })
    if (result.canceled || !result.filePath) return false
    await atomicWrite(result.filePath, await backups.export(options))
    return true
  })
  handle(channels.previewImport, async () => {
    if (!window) return null
    const picked = await dialog.showOpenDialog(window, {
      title: '导入续订备份',
      properties: ['openFile'],
      filters: [{ name: 'JSON 备份', extensions: ['json'] }]
    })
    if (picked.canceled || !picked.filePaths[0]) return null
    return backups.prepareFile(picked.filePaths[0])
  })
}
function checkReminders(): void {
  if (maintenance || localVault?.locked || !repository) return
  const archived = repository.decisions.archiveDue()
  if (archived) backups.changed()
  const billsChanged = repository.ledger.sync(),
    budgetsChanged = repository.finance.ensureMonths()
  if (billsChanged || budgetsChanged) backups.changed()
  if (!Notification.isSupported()) return
  const settings = repository.settings(),
    today = localDate()
  const candidates = [
    ...(settings.notificationsEnabled
      ? reminderCandidates(repository.list(), today).map((c) => ({
          ...c,
          key: 'subscription:' + c.key,
          sent: () => repository.hasReminder(c.key),
          mark: () => repository.markReminder(c.key),
          open: () => showWindow({ page: 'detail', id: c.id })
        }))
      : []),
    ...(settings.budgetNotificationsEnabled
      ? budgetReminderCandidates(
          repository.finance.budgets().find((b) => b.month === today.slice(0, 7)),
          repository.ledger.bills()
        ).map((c) => ({
          ...c,
          key: 'budget:' + c.key,
          sent: () => repository.finance.hasReminder(c.key),
          mark: () => c.keys.forEach((key) => repository.finance.markReminder(key)),
          open: () => showWindow({ page: 'analysis' })
        }))
      : [])
  ]
  for (const c of candidates) {
    if (c.sent() || remindersInFlight.has(c.key)) continue
    remindersInFlight.add(c.key)
    const privateNotice =
      localVault.status().enabled && !localVault.status().options.showNotificationDetails
    const notification = new Notification({
      title: privateNotice ? '续订 · 有待处理提醒' : c.title,
      body: privateNotice ? '解锁续订后查看详情。' : c.body
    })
    visibleNotifications.add(notification)
    notification.on('close', () => visibleNotifications.delete(notification))
    notification.on('click', c.open)
    notification.on('show', () => {
      if (!localVault.locked) c.mark()
      remindersInFlight.delete(c.key)
    })
    notification.on('failed', () => remindersInFlight.delete(c.key))
    setTimeout(() => remindersInFlight.delete(c.key), 30_000).unref()
    notification.show()
  }
}
function showWindow(
  action?: { page: 'new' } | { page: 'analysis' } | { page: 'detail'; id: string }
): void {
  if (!window) createWindow()
  if (window?.isMinimized()) window.restore()
  window?.show()
  window?.focus()
  if (action) {
    const value: DesktopAction = { ...action, sequence: ++sequence }
    if (rendererReady && window) window.webContents.send(channels.navigate, value)
    else pendingAction = value
  }
}
function createWindow(): void {
  rendererReady = false
  window = new BrowserWindow({
    width: 1220,
    height: 860,
    minWidth: 800,
    minHeight: 620,
    show: false,
    title: '续订',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#f5f6f4', symbolColor: '#243229', height: 38 },
    backgroundColor: '#f5f6f4',
    icon: app.isPackaged
      ? join(process.resourcesPath, 'icon.png')
      : join(app.getAppPath(), 'resources/icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true
    }
  })
  Menu.setApplicationMenu(null)
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('did-start-loading', () => {
    rendererReady = false
  })
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false)
  )
  window.webContents.session.setPermissionCheckHandler(() => false)
  desktop?.attach(window)
  window.once('ready-to-show', () => {
    if (!desktop?.startHidden() || pendingAction) window?.show()
  })
  window.on('closed', () => {
    window = null
  })
  if (devUrl) void window.loadURL(devUrl)
  else void window.loadFile(rendererPath)
  window.on('focus', () => void runSync())
}

async function runSync(force = false): Promise<void> {
  if (
    !sync ||
    !repository ||
    maintenance ||
    securityBusy ||
    syncOperations > 0 ||
    localVault?.locked ||
    recoveryReason ||
    activeOperations
  )
    return
  if (
    !force &&
    (!repository.pendingSync() ||
      (sync.status().phase === 'conflict' && repository.pendingSync() <= 1)) &&
    Date.now() - lastAutoSync < 300000
  )
    return
  lastAutoSync = Date.now()
  await sync.synchronize()
  backups.changed()
}
async function lockLedger(): Promise<void> {
  if (!localVault?.status().enabled || localVault.locked) return
  if (maintenance || activeOperations || sync?.busy || syncOperations > 0) {
    lockRequested = true
    throw new Error('账本正在保存或同步，完成后将锁定。')
  }
  maintenance = true
  try {
    const settings = repository.settings()
    await backups.suspend().catch((e) => diagnostics.record('backup.lock-flush-failed', e))
    sync?.clearForLock()
    for (const notice of visibleNotifications) notice.close()
    visibleNotifications.clear()
    csv?.clear()
    repository.checkpoint()
    repository.close()
    desktop?.setLocked(settings)
    localVault.lock()
    lockRequested = false
    // Reload tears down React trees, drafts and decrypted snapshots immediately.
    window?.webContents.reload()
  } finally {
    maintenance = false
  }
}
function registerSecurity(): void {
  handle(channels.securityStatus, () => localVault.status())
  handle(channels.securityAction, async (raw) => {
    const input = securityActionSchema.parse(raw)
    if (securityBusy) throw new Error('正在处理安全设置，请稍后重试。')
    securityBusy = true
    try {
      if (input.action === 'unlock') {
        if (!localVault.locked) return localVault.status()
        await localVault.unlock(input.password, input.recovery)
        await initializeLedger()
      } else if (input.action === 'lock') await lockLedger()
      else {
        if (localVault.locked) throw new Error('请先解锁账本。')
        if (sync?.busy || syncOperations > 0 || activeOperations || maintenance)
          throw new Error('账本正忙，请稍后重试。')
        if (input.action === 'prepare') {
          const protection = await backups.protectionStatus()
          if (!protection.enabled)
            await backups.configure({ enabled: true, password: input.password, remember: true })
          return localVault.prepare(input.password, input.options)
        }
        if (input.action === 'enable' || input.action === 'rekey') {
          if (input.action === 'enable') localVault.checkPrepared(input.confirmation)
          maintenance = true
          try {
            await backups.suspend()
            repository.checkpoint()
            repository.close()
            let recoveryKey: string | undefined
            if (input.action === 'enable') await localVault.enable(input.confirmation)
            else recoveryKey = await localVault.rekey(input.password)
            await initializeLedger()
            return { ...localVault.status(), recoveryKey }
          } catch (e) {
            diagnostics.record('security.migration-failed', e)
            // Durable migration intent is recovered on the next launch.
            localVault.lock()
            window?.webContents.reload()
            throw e
          } finally {
            maintenance = false
          }
        }
        if (input.action === 'options') await localVault.options(input.options)
        if (input.action === 'saveRecovery') {
          const file = await dialog.showSaveDialog(window!, {
            title: '保存恢复密钥',
            defaultPath: 'xuding-recovery-key.txt',
            filters: [{ name: '恢复密钥', extensions: ['txt'] }]
          })
          if (!file.canceled && file.filePath)
            await atomicWrite(
              file.filePath,
              Buffer.from(
                '续订恢复密钥\n请离线保管，任何持有者均可解锁对应账本。\n\n' + input.key + '\n'
              )
            )
        }
        if (input.action === 'password')
          await localVault.changePassword(input.current, input.password, input.options)
        if (input.action === 'recovery')
          return {
            ...localVault.status(),
            recoveryKey: await localVault.rotateRecovery(input.password)
          }
        if (input.action === 'legacy') {
          if (input.operation !== 'list') {
            const answer = await dialog.showMessageBox(window!, {
              type: 'warning',
              title: '处理旧明文备份',
              message:
                input.operation === 'convert'
                  ? '将旧明文备份转换为加密备份？'
                  : '删除应用备份目录中的旧明文备份？',
              detail: '仅处理续订创建的备份。另存到其他位置的文件需要自行处理。',
              buttons: ['取消', '确认'],
              defaultId: 0,
              cancelId: 0
            })
            if (answer.response !== 1) return localVault.status()
          }
          const legacy = await localVault.legacy(
            backups.status().directory,
            input.operation,
            await backups.protectionPassword()
          )
          return { ...localVault.status(), legacy }
        }
      }
      return localVault.status()
    } finally {
      securityBusy = false
    }
  })
  handle(channels.syncStatus, () => sync.status())
  handle(channels.syncAction, async (raw) => {
    const input = syncActionSchema.parse(raw)
    if (securityBusy || syncOperations > 0 || sync.busy)
      throw new Error('正在处理安全设置或同步，请稍后重试。')
    syncOperations++
    try {
      if (input.action === 'test') return await sync.test(input.connection)
      if (input.action === 'preview') return await sync.prepare(input.connection, input.passphrase)
      if (input.action === 'connect') return await sync.connect(input.token, input.mode)
      if (input.action === 'sync') {
        const result = await sync.synchronize()
        backups.changed()
        return result
      }
      if (input.action === 'pause') return await sync.pause(input.paused)
      if (input.action === 'disconnect') return await sync.disconnect()
      if (input.action === 'resolve') return await sync.resolve(input.id, input.choice, input.value)
      if (input.action === 'rotate') return await sync.rotate(input.passphrase)
      return await sync.recovery(input.passphrase)
    } finally {
      syncOperations--
    }
  })
}

async function initializeLedger(): Promise<boolean> {
  try {
    await recovery.beforeOpen()
    const opened = new SubscriptionRepository(
      join(app.getPath('userData'), 'xuding.db'),
      () => new Date(),
      localVault.key
    )
    if (repository) Object.assign(repository, opened)
    else repository = opened
    backupSchema.parse(repository.export())
    repository.settings()
  } catch (error) {
    try {
      repository?.close()
    } catch {}
    diagnostics.record('database.start-failed', error)
    recoveryReason =
      error instanceof Error && /不兼容|对应版本|较新版本/.test(error.message)
        ? '数据库由其他版本创建，请升级到对应版本后重试，或明确选择一个兼容副本。'
        : '账本无法正常打开，可能是数据库损坏或升级未完成。可以重试，或从已验证的升级前副本恢复。'
    if (!window) createWindow()
    return false
  }
  backups = new BackupService(
    repository,
    join(app.getPath('userData'), 'backups'),
    () => new Date(),
    systemVault,
    (event, error) => diagnostics.record(event, error)
  )
  backups.requireEncryption = localVault.status().enabled
  csv = new CsvService(repository, backups)
  exchange = new ExchangeService(repository, (input, init) => net.fetch(input, init))
  sync = new SyncEngine(
    repository,
    systemVault,
    () => backups.beforeSync(),
    (url, init) => net.fetch(url instanceof URL ? url.href : url, init),
    !!process.env.XUDING_DATA_DIR && process.env.XUDING_ALLOW_INSECURE_TEST_DAV === '1'
  )
  if (desktop) {
    desktop.updateStorage(repository, backups)
    desktop.setLocked(null)
  } else
    desktop = new DesktopLifecycle(repository, backups, (add) =>
      showWindow(add ? { page: 'new' } : undefined)
    )
  if (!updates) {
    const updater = new NsisUpdater()
    updater.autoDownload = false
    updater.autoInstallOnAppQuit = false
    updater.allowPrerelease = false
    updater.allowDowngrade = false
    updater.disableWebInstaller = true
    updater.disableDifferentialDownload = true
    updater.logger = null
    updater.on('error', (error) => diagnostics.record('update.adapter-error', error))
    updates = new UpdateService({
      version: app.getVersion(),
      supported: app.isPackaged && process.platform === 'win32',
      publicKey: updateTrust.publicKey,
      statePath: join(app.getPath('userData'), 'update-state.json'),
      fetchManifest: async () => {
        const response = await net.fetch(
          'https://github.com/ztbytd/xuding/releases/latest/download/xuding-update.json',
          { signal: AbortSignal.timeout(15000), cache: 'no-store' }
        )
        if (response.status === 404) return null
        if (!response.ok || Number(response.headers.get('content-length') || 0) > 60000)
          throw new Error('更新服务不可用。')
        const bytes = await response.text()
        if (bytes.length > 60000) throw new Error('更新信息过大。')
        return JSON.parse(bytes)
      },
      adapter: {
        check: async (url) => {
          updater.setFeedURL({ provider: 'generic', url, useMultipleRangeRequest: false })
          const result = await updater.checkForUpdates()
          if (!result) throw new Error('更新器不可用。')
          return result.updateInfo
        },
        download: async (progress) => {
          const listener = (info: { percent: number }) => progress(info.percent)
          updater.on('download-progress', listener)
          try {
            return await updater.downloadUpdate()
          } finally {
            updater.removeListener('download-progress', listener)
          }
        },
        install: () => {
          let installError: Error | null = null
          const failed = (error: Error) => {
            installError = error
          }
          updater.once('error', failed)
          updater.quitAndInstall(false, true)
          updater.removeListener('error', failed)
          if (installError) {
            maintenance = false
            throw installError
          }
          desktop.prepareUpdateExit()
        }
      },
      prepareInstall: async () => {
        if (activeOperations || maintenance || sync?.busy || syncOperations > 0)
          throw new Error('账本正忙，请等待当前操作完成后重试。')
        const choice = await dialog.showMessageBox(window!, {
          type: 'question',
          title: '重启并安装',
          message: '现在保存数据并安装新版本？',
          detail: '应用将创建升级前副本并退出。安装完成后可以继续使用。',
          buttons: ['稍后', '重启并安装'],
          defaultId: 0,
          cancelId: 0
        })
        if (choice.response !== 1) throw new Error('安装已取消，已下载的更新仍然保留。')
        if (activeOperations || maintenance || sync?.busy || syncOperations > 0)
          throw new Error('账本正忙，请等待当前操作完成后重试。')
        maintenance = true
        try {
          await backups.flush()
          recovery.checkpointNow()
        } catch (error) {
          maintenance = false
          throw error
        }
      },
      releaseInstall: () => {
        maintenance = false
      },
      log: (event, error) => diagnostics.record(event, error)
    })
    await updates.initialize()
  }
  if (!apiRegistered) {
    registerApi()
    apiRegistered = true
  }
  if (!window) createWindow()
  if (!reminderTimer) {
    setTimeout(() => {
      void updates.automatic().catch((error) => diagnostics.record('update.check-failed', error))
    }, 10000).unref()
    const reminders = () => {
      try {
        checkReminders()
        if (!maintenance && !localVault.locked)
          void updates
            .automatic()
            .catch((error) => diagnostics.record('update.check-failed', error))
      } catch (error) {
        diagnostics.record('reminder.failed', error)
      }
    }
    reminderTimer = setInterval(reminders, 60_000)
    powerMonitor.on('resume', () => {
      reminders()
      void runSync(true)
    })
    powerMonitor.on('suspend', () => {
      if (localVault.status().options.lockOnSuspend)
        void lockLedger().catch((e) => diagnostics.record('security.lock-failed', e))
    })
    powerMonitor.on('lock-screen', () => {
      if (localVault.status().options.lockOnScreen)
        void lockLedger().catch((e) => diagnostics.record('security.lock-failed', e))
    })
    powerMonitor.on('unlock-screen', reminders)
    void backups.automatic().catch((error) => diagnostics.record('backup.automatic-failed', error))
    setTimeout(reminders, 5000).unref()
    syncTimer = setInterval(() => {
      if (lockRequested && !localVault.locked) void lockLedger().catch(() => {})
      if (localVault.status().enabled && !localVault.locked) {
        const idle = localVault.status().options.idleMinutes
        if (idle && powerMonitor.getSystemIdleTime() >= idle * 60)
          void lockLedger().catch((e) => diagnostics.record('security.lock-failed', e))
      }
      void runSync()
    }, 15000)
    app.on('activate', () => {
      showWindow()
    })
  }
  return true
}

if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', () => {
    showWindow()
  })
  void app
    .whenReady()
    .then(async () => {
      await mkdir(app.getPath('userData'), { recursive: true })
      diagnostics = new Diagnostics(join(app.getPath('userData'), 'logs'), app.getVersion())
      diagnostics.record('app.start')
      registerOperations()
      systemVault = new CredentialVault(
        join(app.getPath('userData'), 'credentials'),
        async (value) => {
          if (!safeStorage.isEncryptionAvailable()) throw new Error('系统凭据保护不可用。')
          return safeStorage.encryptString(value)
        },
        async (value) => {
          if (!safeStorage.isEncryptionAvailable()) throw new Error('系统凭据保护不可用。')
          return safeStorage.decryptString(value)
        }
      )
      localVault = new LocalVault(app.getPath('userData'), systemVault)
      await localVault.initialize()
      recovery = new RecoveryService(
        app.getPath('userData'),
        app.getVersion(),
        () => localVault.key,
        () => localVault.keys
      )
      registerSecurity()
      if (localVault.locked) {
        createWindow()
        return
      }
      await initializeLedger()
    })
    .catch((error) => {
      dialog.showErrorBox('续订启动失败', error instanceof Error ? error.message : String(error))
      app.quit()
    })
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
  app.on('will-quit', () => {
    if (reminderTimer) clearInterval(reminderTimer)
    if (syncTimer) clearInterval(syncTimer)
    if (syncDelay) clearTimeout(syncDelay)
    localVault?.lock()
    try {
      repository?.close()
    } catch {
      /* already closed by recovery */
    }
  })
}
