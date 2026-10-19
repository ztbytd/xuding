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
import { BackupService } from './backups'
import { DesktopLifecycle } from './desktop'
import { settingsPatchSchema, settingsSchema, subscriptionInputSchema } from '../shared/model'
import { channels } from '../shared/channels'
import type { Result, DesktopAction } from '../shared/model'
import { localDate } from '../shared/billing'
import { reminderCandidates } from '../shared/attention'

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
let desktop: DesktopLifecycle
let rendererReady = false
let pendingAction: DesktopAction | null = null
let sequence = 0
const remindersInFlight = new Set<string>()
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
    try {
      return { ok: true, data: await handler(...args) }
    } catch (error) {
      if (error instanceof z.ZodError)
        return { ok: false, error: error.issues.map((i) => i.message).join('；') }
      return { ok: false, error: error instanceof Error ? error.message : '操作失败，请重试。' }
    }
  })
}

function registerApi(): void {
  handle(channels.navigationReady, () => {
    rendererReady = true
    const action = pendingAction
    pendingAction = null
    return action
  })
  handle(channels.exchangeRates, (force) => exchange.get(z.boolean().optional().parse(force)))
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
  handle(channels.load, () => ({
    subscriptions: repository.list(),
    settings: repository.settings(),
    exchangeRates: repository.exchangeRates(),
    version: app.getVersion(),
    backupStatus: backups.status(),
    startupSupported: desktop.startupSupported
  }))
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
  handle(channels.backupStatus, () => backups.status())
  handle(channels.backupNow, () => backups.nowBackup())
  handle(channels.backupHistory, () => backups.history())
  handle(channels.previewBackup, (id) => backups.preview(z.string().max(120).parse(id)))
  handle(channels.restoreBackup, (token) => backups.restore(z.string().uuid().parse(token)))
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
  handle(channels.exportBackup, async () => {
    if (!window) return false
    const result = await dialog.showSaveDialog(window, {
      title: '导出订阅备份',
      defaultPath: `xuding-backup-${localDate()}.json`,
      filters: [{ name: 'JSON 备份', extensions: ['json'] }]
    })
    if (result.canceled || !result.filePath) return false
    await writeFile(result.filePath, JSON.stringify(repository.export(), null, 2), {
      encoding: 'utf8',
      mode: 0o600
    })
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
  if (!repository.settings().notificationsEnabled || !Notification.isSupported()) return
  for (const candidate of reminderCandidates(repository.list(), localDate())) {
    const key = candidate.key
    if (repository.hasReminder(key) || remindersInFlight.has(key)) continue
    remindersInFlight.add(key)
    const notification = new Notification({
      title: candidate.title,
      body: candidate.body
    })
    notification.on('click', () => showWindow({ page: 'detail', id: candidate.id }))
    notification.on('show', () => {
      repository.markReminder(key)
      remindersInFlight.delete(key)
    })
    notification.on('failed', () => remindersInFlight.delete(key))
    setTimeout(() => remindersInFlight.delete(key), 30_000).unref()
    notification.show()
  }
}
function showWindow(action?: { page: 'new' } | { page: 'detail'; id: string }): void {
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
  desktop.attach(window)
  window.once('ready-to-show', () => {
    if (!desktop.startHidden() || pendingAction) window?.show()
  })
  window.on('closed', () => {
    window = null
  })
  if (devUrl) void window.loadURL(devUrl)
  else void window.loadFile(rendererPath)
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
      repository = new SubscriptionRepository(join(app.getPath('userData'), 'xuding.db'))
      backups = new BackupService(repository, join(app.getPath('userData'), 'backups'))
      exchange = new ExchangeService(repository, (input, init) => net.fetch(input, init))
      desktop = new DesktopLifecycle(repository, backups, (add) =>
        showWindow(add ? { page: 'new' } : undefined)
      )
      registerApi()
      createWindow()
      const reminders = () => {
        try {
          checkReminders()
        } catch (error) {
          console.error('Reminder check failed', error)
        }
      }
      reminderTimer = setInterval(reminders, 60_000)
      powerMonitor.on('resume', reminders)
      powerMonitor.on('unlock-screen', reminders)
      void backups.automatic().catch((error) => console.error('Automatic backup failed', error))
      setTimeout(reminders, 5000).unref()
      app.on('activate', () => {
        showWindow()
      })
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
    repository?.close()
  })
}
