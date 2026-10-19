import { app, BrowserWindow, dialog, Menu, nativeImage, Tray } from 'electron'
import { join } from 'node:path'
import type { Settings } from '../shared/model'
import type { SubscriptionRepository } from './database'
import type { BackupService } from './backups'

export class DesktopLifecycle {
  private tray: Tray | null = null
  private quitting = false
  private quitReady = false
  private asking = false
  readonly startupSupported = app.isPackaged && process.platform === 'win32'
  constructor(
    private repo: SubscriptionRepository,
    private backups: BackupService,
    private show: (newSubscription?: boolean) => void
  ) {
    const image = nativeImage
      .createFromPath(
        app.isPackaged
          ? join(process.resourcesPath, 'icon.png')
          : join(app.getAppPath(), 'resources/icon.png')
      )
      .resize({ width: 20, height: 20 })
    try {
      this.tray = new Tray(image)
      this.tray.setToolTip('续订 · 订阅与到期提醒')
      this.tray.setContextMenu(
        Menu.buildFromTemplate([
          { label: '打开续订', click: () => this.show() },
          { label: '添加订阅', click: () => this.show(true) },
          { type: 'separator' },
          { label: '退出应用', click: () => app.quit() }
        ])
      )
      this.tray.on('double-click', () => this.show())
    } catch (error) {
      console.error('Tray unavailable', error)
    }
    app.on('before-quit', (event) => {
      if (this.quitReady) return
      event.preventDefault()
      if (this.quitting) return
      this.quitting = true
      void this.backups
        .flush()
        .catch((error) => console.error('Final backup failed', error))
        .finally(() => {
          this.quitReady = true
          app.quit()
        })
    })
    app.on('will-quit', () => {
      this.tray?.destroy()
      this.tray = null
    })
  }
  attach(window: BrowserWindow): void {
    window.on('close', (event) => {
      if (this.quitting) return
      event.preventDefault()
      const preference = this.repo.settings().closeBehavior
      if (preference === 'quit') {
        app.quit()
        return
      }
      if (preference === 'tray' && this.tray) {
        window.hide()
        return
      }
      if (this.asking) return
      this.asking = true
      void dialog
        .showMessageBox(window, {
          type: 'question',
          title: '关闭续订',
          message: '关闭窗口后如何运行？',
          detail: '后台运行会保留托盘图标并继续发送提醒。退出应用将停止提醒。',
          buttons: this.tray ? ['后台运行', '退出应用', '取消'] : ['退出应用', '取消'],
          defaultId: 0,
          cancelId: this.tray ? 2 : 1,
          checkboxLabel: '记住我的选择',
          checkboxChecked: false
        })
        .then((result) => {
          const background = !!this.tray && result.response === 0
          const exit = result.response === (this.tray ? 1 : 0)
          if (result.checkboxChecked && (background || exit))
            this.repo.saveSettings({ closeBehavior: background ? 'tray' : 'quit' })
          if (background && !window.isDestroyed()) window.hide()
          if (exit) app.quit()
        })
        .catch((error) => console.error('Close dialog failed', error))
        .finally(() => {
          this.asking = false
        })
    })
  }
  prepareUpdateExit(): void {
    this.quitting = true
    this.quitReady = true
  }
  startHidden(): boolean {
    return (
      !!this.tray &&
      process.argv.includes('--autostart') &&
      this.repo.settings().launchAtLogin &&
      this.repo.settings().startInTray
    )
  }
  updateLogin(previous: Settings, next: Settings): void {
    if (previous.launchAtLogin === next.launchAtLogin) return
    if (!this.startupSupported) throw new Error('开机启动请在 Windows 安装版中设置。')
    app.setLoginItemSettings({
      openAtLogin: next.launchAtLogin,
      path: process.execPath,
      args: ['--autostart']
    })
  }
}
