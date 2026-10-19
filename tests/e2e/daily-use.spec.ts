import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'

test('background reminders, entitlement dates and guarded backup recovery', async ({}, testInfo) => {
  const userData = await mkdtemp(join(tmpdir(), 'xuding-daily-'))
  const { ELECTRON_RUN_AS_NODE: _, ...env } = process.env
  const launch = () => electron.launch({ args: ['.'], env: { ...env, XUDING_DATA_DIR: userData } })
  let app = await launch()
  const freezeReminderClock = () =>
    app.evaluate(() => {
      const OriginalDate = Date
      const instant = OriginalDate.parse('2026-10-19T04:00:00Z')
      globalThis.Date = class extends OriginalDate {
        constructor(value?: string | number) {
          super(value === undefined ? instant : value)
        }
        static now() {
          return instant
        }
      } as unknown as DateConstructor
    })
  try {
    let page = await app.firstWindow()
    await freezeReminderClock()
    await page.setViewportSize({ width: 1220, height: 860 })
    await page.clock.setFixedTime(new Date('2026-10-19T12:00:00+08:00'))
    const go = (name: string) =>
      page.getByRole('navigation').getByRole('button', { name, exact: true }).click()
    await go('我的订阅')
    await page.getByRole('button', { name: '新增订阅', exact: true }).click()
    await page.getByRole('textbox', { name: '订阅名称' }).fill('到期测试会员')
    await page.getByRole('spinbutton', { name: '金额', exact: true }).fill('19.99')
    await page.getByRole('switch', { name: '自动续费', exact: true }).click()
    const access = page.getByRole('textbox', { name: '权益到期日', exact: true })
    await access.fill('2026-02-30')
    await page.getByRole('button', { name: '添加订阅', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText('请输入有效日期')
    await access.fill('2026-10-21')
    await access.press('Enter')
    await page.getByRole('button', { name: '添加订阅', exact: true }).click()
    await expect(page.getByRole('heading', { name: '到期测试会员', exact: true })).toBeVisible()
    await expect(page.getByText('权益剩余 2 天', { exact: true })).toBeVisible()
    await go('总览')
    await expect(page.locator('.attention-panel')).toContainText('到期测试会员')
    await expect(page.locator('.stats .stat > strong')).toHaveText(['¥0.00', '¥0.00', '¥0.00'])
    await page.screenshot({
      path: testInfo.outputPath('entitlement-overview.png'),
      animations: 'disabled'
    })
    await go('设置与备份')
    await page.getByRole('tab', { name: '数据与备份', exact: true }).click()
    await expect(page.getByRole('switch', { name: '自动备份', exact: true })).toBeChecked()
    await expect
      .poll(async () => {
        const result = await page.evaluate(() => window.desktop.backupHistory())
        return result.ok ? result.data.length : 0
      })
      .toBeGreaterThan(0)
    await page.getByRole('button', { name: '立即备份', exact: true }).click()
    await expect(page.getByRole('status')).toHaveText('备份已完成。')
    await page.screenshot({
      path: testInfo.outputPath('daily-settings.png'),
      animations: 'disabled'
    })
    await page.getByRole('button', { name: '备份历史', exact: true }).click()
    await expect(page.getByRole('dialog', { name: '备份历史' })).toBeVisible()
    await expect(page.locator('.backup-history-item')).toHaveCount(2)
    const files = await page.evaluate(() => window.desktop.backupHistory())
    if (!files.ok) throw new Error(files.error)
    const manual = files.data.find((entry) => entry.kind === 'manual')!
    await page.getByRole('button', { name: `恢复 ${manual.id}`, exact: true }).click()
    await expect(page.getByRole('dialog', { name: '恢复预览' })).toBeVisible()
    await expect(page.locator('.restore-counts')).toContainText('覆盖1')
    await page.getByRole('button', { name: '确认恢复', exact: true }).click({ trial: true })
    await expect(page.locator('.ant-modal')).toHaveCSS('opacity', '1')
    await page.screenshot({
      path: testInfo.outputPath('restore-preview.png'),
      animations: 'allow'
    })
    await page
      .getByRole('dialog', { name: '恢复预览' })
      .getByRole('button', { name: '取消', exact: true })
      .click()
    await page
      .getByRole('dialog', { name: '备份历史' })
      .getByRole('button', { name: '关闭备份历史', exact: true })
      .click()
    const initial = await page.evaluate(() => window.desktop.load())
    if (!initial.ok) throw new Error(initial.error)
    const original = initial.data.subscriptions[0]
    await go('我的订阅')
    await page.getByRole('button', { name: '查看 到期测试会员 详情', exact: true }).click()
    await page.getByRole('button', { name: '编辑订阅', exact: true }).click()
    await expect(page.getByRole('textbox', { name: '权益到期日', exact: true })).toHaveValue(
      '2026-10-21'
    )
    await page.getByRole('button', { name: '取消编辑', exact: true }).click()
    await page.getByRole('button', { name: '调整价格', exact: true }).click()
    await page.getByRole('spinbutton', { name: '新价格', exact: true }).fill('29.99')
    await page.getByRole('button', { name: '保存价格', exact: true }).click()
    await expect(page.locator('.detail-price')).toContainText('29.99')
    await go('设置与备份')
    await page.getByRole('button', { name: '备份历史', exact: true }).click()
    await page.getByRole('button', { name: `恢复 ${manual.id}`, exact: true }).click()
    await page.getByRole('button', { name: '确认恢复', exact: true }).click()
    await expect(page.getByRole('status')).toHaveText('已导入 1 项订阅。')
    const restored = await page.evaluate(() => window.desktop.load())
    expect(restored.ok && restored.data.subscriptions[0]).toMatchObject({
      amountMinor: 1999,
      accessEndsOn: '2026-10-21'
    })
    const recovery = await page.evaluate(() => window.desktop.backupHistory())
    if (!recovery.ok) throw new Error(recovery.error)
    const safety = recovery.data.find((entry) => entry.kind === 'before-restore')!
    const json = JSON.parse(
      await readFile(join(initial.data.backupStatus.directory, safety.id), 'utf8')
    )
    expect(json.subscriptions[0].amountMinor).toBe(2999)
    // Native close dialog remembers background mode; second-instance activation restores the window.
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: true })
    })
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
    await expect
      .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()))
      .toBe(false)
    await app.evaluate(({ app }) => app.emit('second-instance', {}, [], ''))
    await expect
      .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()))
      .toBe(true)
    const background = await page.evaluate(() => window.desktop.load())
    expect(background.ok && background.data.settings.closeBehavior).toBe('tray')
    // Replace notification delivery so tests never send real OS notifications.
    await app.evaluate(({ Notification }) => {
      Notification.isSupported = () => true
      const collected: Electron.Notification[] = []
      ;(globalThis as unknown as { notifications: Electron.Notification[] }).notifications =
        collected
      Notification.prototype.show = function () {
        collected.push(this)
        this.emit('show')
      }
    })
    await page.evaluate(() => window.desktop.settings({ notificationsEnabled: true }))
    await app.evaluate(({ BrowserWindow, powerMonitor }) => {
      BrowserWindow.getAllWindows()[0].hide()
      powerMonitor.emit('resume')
    })
    await expect
      .poll(() =>
        app.evaluate(
          () => (globalThis as unknown as { notifications: unknown[] }).notifications.length
        )
      )
      .toBe(1)
    await app.evaluate(({ powerMonitor }) => powerMonitor.emit('resume'))
    expect(
      await app.evaluate(
        () => (globalThis as unknown as { notifications: unknown[] }).notifications.length
      )
    ).toBe(1)
    await app.evaluate(() =>
      (globalThis as unknown as { notifications: Electron.Notification[] }).notifications[0].emit(
        'click'
      )
    )
    await expect(page.getByRole('heading', { name: '到期测试会员', exact: true })).toBeVisible()
    expect(
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())
    ).toBe(true)
    await page.evaluate(() => window.desktop.settings({ notificationsEnabled: false }))
    await app.close()
    app = await launch()
    await freezeReminderClock()
    page = await app.firstWindow()
    await page.clock.setFixedTime(new Date('2026-10-19T12:00:00+08:00'))
    const restarted = await page.evaluate(() => window.desktop.load())
    expect(
      restarted.ok && restarted.data.subscriptions.find((s) => s.id === original.id)
    ).toMatchObject({ amountMinor: 1999, accessEndsOn: '2026-10-21' })
    expect(restarted.ok && restarted.data.settings.closeBehavior).toBe('tray')
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
    await expect
      .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()))
      .toBe(false)
  } finally {
    await app.close()
    const target = resolve(userData)
    if (
      !target.startsWith(resolve(tmpdir()) + sep) ||
      !basename(target).startsWith('xuding-daily-')
    )
      throw new Error('Unexpected test cleanup path')
    await rm(target, { recursive: true, force: true })
  }
})
