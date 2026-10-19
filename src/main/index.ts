import { app, BrowserWindow, dialog, ipcMain, Menu, Notification, shell } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { mkdirSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { SubscriptionRepository } from './database'
import { backupSchema, settingsSchema, subscriptionInputSchema } from '../shared/model'
import { channels } from '../shared/channels'
import type { Result } from '../shared/model'
import { daysBetween, formatMoney, localDate, nextBills } from '../shared/billing'

app.setName('xuding')
if (process.env.XUDING_DATA_DIR && isAbsolute(process.env.XUDING_DATA_DIR)) {
  mkdirSync(process.env.XUDING_DATA_DIR, { recursive: true })
  app.setPath('userData', process.env.XUDING_DATA_DIR)
}
app.setAppUserModelId('io.github.ztbytd.xuding')
let window: BrowserWindow | null = null
let repository: SubscriptionRepository
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
  handle(channels.load, () => ({
    subscriptions: repository.list(),
    settings: repository.settings(),
    version: app.getVersion()
  }))
  handle(channels.save, (raw, id) =>
    repository.save(
      subscriptionInputSchema.parse(raw),
      id === undefined ? undefined : z.string().uuid().parse(id)
    )
  )
  handle(channels.archive, (id) => repository.archive(z.string().uuid().parse(id)))
  handle(channels.settings, (raw) => repository.saveSettings(settingsSchema.parse(raw)))
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
  handle(channels.importBackup, async () => {
    if (!window) return null
    const picked = await dialog.showOpenDialog(window, {
      title: '导入续订备份',
      properties: ['openFile'],
      filters: [{ name: 'JSON 备份', extensions: ['json'] }]
    })
    if (picked.canceled || !picked.filePaths[0]) return null
    if ((await stat(picked.filePaths[0])).size > 5 * 1024 * 1024)
      throw new Error('备份文件不能超过 5 MB。')
    const backup = backupSchema.parse(JSON.parse(await readFile(picked.filePaths[0], 'utf8')))
    const confirmation = await dialog.showMessageBox(window, {
      type: 'question',
      buttons: ['取消', '导入'],
      defaultId: 0,
      cancelId: 0,
      title: '导入备份',
      message: `导入 ${backup.subscriptions.length} 项订阅？`,
      detail: '相同 ID 的订阅将被备份内容覆盖；其他现有订阅会保留。'
    })
    return confirmation.response === 1 ? repository.import(backup) : null
  })
}
function checkReminders(): void {
  if (!repository.settings().notificationsEnabled || !Notification.isSupported()) return
  const today = localDate()
  for (const subscription of repository.list()) {
    const bill = nextBills(subscription, today, 1)[0]
    if (!bill) continue
    const days = daysBetween(today, bill.due)
    const key = `${subscription.id}:${bill.due}`
    if (days > subscription.reminderDays || repository.hasReminder(key)) continue
    const notification = new Notification({
      title: `${subscription.name} · 续费提醒`,
      body: `${days === 0 ? '今天' : `${days} 天后`}预计扣款 ${formatMoney(bill.amountMinor, subscription.currency)}${subscription.status === 'trial' ? '（试用结束）' : ''}`
    })
    notification.on('click', () => {
      window?.show()
      window?.focus()
    })
    notification.on('show', () => repository.markReminder(key))
    notification.show()
  }
}
function createWindow(): void {
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
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false)
  )
  window.webContents.session.setPermissionCheckHandler(() => false)
  window.once('ready-to-show', () => window?.show())
  window.on('closed', () => {
    window = null
  })
  if (devUrl) void window.loadURL(devUrl)
  else void window.loadFile(rendererPath)
}

if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', () => {
    if (window?.isMinimized()) window.restore()
    window?.show()
    window?.focus()
  })
  void app
    .whenReady()
    .then(async () => {
      await mkdir(app.getPath('userData'), { recursive: true })
      repository = new SubscriptionRepository(join(app.getPath('userData'), 'xuding.db'))
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
      setTimeout(reminders, 5000).unref()
      app.on('activate', () => {
        if (!window) createWindow()
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
