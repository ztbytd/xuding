import { test, expect, _electron as electron } from '@playwright/test'
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'

test('icons persist in backups and overview explains currency and renewal filters', async ({}, testInfo) => {
  const userData = await mkdtemp(join(tmpdir(), 'xuding-icons-'))
  const { ELECTRON_RUN_AS_NODE: _, ...env } = process.env
  const launch = () => electron.launch({ args: ['.'], env: { ...env, XUDING_DATA_DIR: userData } })
  let app = await launch()
  try {
    let page = await app.firstWindow()
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    const go = (name: string) =>
      page.getByRole('navigation').getByRole('button', { name, exact: true }).click()
    await go('我的订阅')
    await page.getByRole('button', { name: '新增订阅', exact: true }).click()
    await page.getByRole('textbox', { name: '订阅名称' }).fill('Chatgpt-pro')
    await page.getByRole('spinbutton', { name: '金额', exact: true }).fill('100')
    await page.getByRole('combobox', { name: '币种', exact: true }).click()
    await page.getByRole('option', { name: '美元 USD', exact: true }).click()
    await expect(page.getByRole('switch', { name: '自动续费', exact: true })).toBeChecked()
    const iconFile = join(userData, 'icon.png')
    await writeFile(iconFile, 'not an image')
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
    }, iconFile)
    await page.getByRole('button', { name: '上传图标', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText('无法读取这张图片')
    await copyFile(resolve('resources/icon.png'), iconFile)
    await page.getByRole('button', { name: '上传图标', exact: true }).click()
    await expect(page.getByRole('img', { name: 'Chatgpt-pro图标' })).toBeVisible()
    await expect(page.getByRole('alert')).toHaveCount(0)
    await page.screenshot({
      path: testInfo.outputPath('icon-form.png'),
      fullPage: true,
      animations: 'disabled'
    })
    await page.getByRole('button', { name: '添加订阅', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Chatgpt-pro', exact: true })).toBeVisible()
    const snapshot = await page.evaluate(() => window.desktop.load())
    if (!snapshot.ok) throw new Error(snapshot.error)
    const item = snapshot.data.subscriptions[0]
    expect(item.autoRenew).toBe(true)
    expect(item.icon).toMatch(/^data:image\/png;base64,/)
    expect(item.icon!.length).toBeLessThan(100_000)
    await rm(iconFile)
    await go('总览')
    await expect(page.locator('.currency-picker')).toContainText('美元 USD')
    await expect(page.locator('.stats .stat > strong')).toHaveText([
      'US$100.00',
      'US$1,200.00',
      'US$100.00'
    ])
    await expect(page.locator('.bar-row')).toContainText('US$100.00')
    await expect(page.getByRole('img', { name: 'Chatgpt-pro图标' })).toBeVisible()
    await page.screenshot({
      path: testInfo.outputPath('overview-active.png'),
      animations: 'disabled'
    })
    // Existing USD-only data also chooses USD on first use, without relying on save navigation.
    await page.evaluate(() => localStorage.removeItem('xuding.currency'))
    await page.reload()
    await expect(page.locator('.currency-picker')).toContainText('美元 USD')
    await go('我的订阅')
    await page.getByRole('button', { name: '查看 Chatgpt-pro 详情', exact: true }).click()
    await page.getByRole('button', { name: '编辑订阅', exact: true }).click()
    // Canceling the picker must retain the existing icon.
    await app.evaluate(({ dialog }) => {
      dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] })
    })
    await page.getByRole('button', { name: '更换图标', exact: true }).click()
    await expect(page.getByRole('img', { name: 'Chatgpt-pro图标' })).toBeVisible()
    await page.getByRole('switch', { name: '自动续费', exact: true }).click()
    await expect(page.getByText('自动续费已关闭', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: '保存修改', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Chatgpt-pro', exact: true })).toBeVisible()
    await go('总览')
    await expect(page.locator('.stats .stat > strong')).toHaveText([
      'US$0.00',
      'US$0.00',
      'US$0.00'
    ])
    await expect(page.locator('.overview-context')).toContainText('1 项续费已关闭，不计入预计支出')
    await expect(page.getByText('添加订阅后，分类支出会显示在这里。')).toHaveCount(0)
    await page.screenshot({
      path: testInfo.outputPath('overview-paused.png'),
      animations: 'disabled'
    })
    await page.getByRole('combobox', { name: '统计币种' }).click()
    await page.getByRole('option', { name: '人民币 CNY', exact: true }).click()
    await expect(page.locator('.overview-columns')).toContainText('当前没有 CNY 订阅')
    await page.reload()
    await expect(page.locator('.currency-picker')).toContainText('人民币 CNY')
    await page.getByRole('button', { name: '查看 USD', exact: true }).click()
    await expect(page.locator('.currency-picker')).toContainText('美元 USD')
    await go('我的订阅')
    const row = page.getByRole('button', { name: '查看 Chatgpt-pro 详情', exact: true })
    await expect(row.locator('.row-title .badge')).toHaveText('续费已关闭')
    await expect(row.locator('.row-price')).toHaveText('US$100.00/ 月')
    await page.screenshot({
      path: testInfo.outputPath('subscription-list.png'),
      animations: 'disabled'
    })
    const backupPath = join(userData, 'backup.json')
    await app.evaluate(({ dialog }, file) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: file })
    }, backupPath)
    await go('设置与备份')
    await page.getByRole('button', { name: '导出备份', exact: true }).click()
    await expect(page.getByRole('status')).toHaveText('备份已导出。')
    expect(JSON.parse(await readFile(backupPath, 'utf8')).subscriptions[0].icon).toBe(item.icon)
    await go('我的订阅')
    await row.click()
    await page.getByRole('button', { name: '编辑订阅', exact: true }).click()
    await page.getByRole('button', { name: '移除图标', exact: true }).click()
    await page.getByRole('button', { name: '保存修改', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Chatgpt-pro', exact: true })).toBeVisible()
    await expect(page.getByRole('img')).toHaveCount(0)
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false })
    }, backupPath)
    await go('设置与备份')
    await page.getByRole('button', { name: '导入备份', exact: true }).click()
    await expect(page.getByRole('status')).toContainText('已导入 1 项订阅')
    await app.close()
    app = await launch()
    page = await app.firstWindow()
    await go('我的订阅')
    const restored = page.getByRole('img', { name: 'Chatgpt-pro图标' })
    await expect(restored).toBeVisible()
    expect(
      await restored.evaluate(
        (img: HTMLImageElement) => img.complete && img.naturalWidth > 0 && img.naturalWidth <= 128
      )
    ).toBe(true)
    expect(errors).toEqual([])
  } finally {
    await app.close()
    const target = resolve(userData)
    if (
      !target.startsWith(resolve(tmpdir()) + sep) ||
      !basename(target).startsWith('xuding-icons-')
    )
      throw new Error('Refusing to remove unexpected test directory')
    await rm(target, { recursive: true, force: true })
  }
})
