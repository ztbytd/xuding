import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'

test('desktop CRUD, details, backups, and restart persistence', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'xuding-test-'))
  const { ELECTRON_RUN_AS_NODE: _, ...env } = process.env
  const launch = () => electron.launch({ args: ['.'], env: { ...env, XUDING_DATA_DIR: userData } })
  let app = await launch()
  try {
    let page = await app.firstWindow()
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    await expect(page.getByRole('heading', { name: '每一笔订阅，心里有数。' })).toBeVisible()
    await expect(page.getByRole('button', { name: '新增订阅', exact: true })).toHaveCount(0)
    expect(
      await page.evaluate(() => typeof (window as unknown as { require?: unknown }).require)
    ).toBe('undefined')
    await page
      .getByRole('navigation')
      .getByRole('button', { name: /我的订阅/ })
      .click()
    await page.getByRole('button', { name: '新增订阅', exact: true }).click()
    await page.getByRole('textbox', { name: '订阅名称' }).fill('桌面测试会员')
    await page.getByRole('textbox', { name: '金额', exact: true }).fill('19.99')
    await page.getByRole('button', { name: '添加订阅', exact: true }).click()
    await expect(page.getByRole('heading', { name: '桌面测试会员', exact: true })).toBeVisible()
    await expect(page.locator('.detail-price')).toContainText('19.99')
    await expect(page.locator('input')).toHaveCount(0)
    await page.getByRole('button', { name: '编辑订阅', exact: true }).click()
    await page.getByRole('textbox', { name: '金额', exact: true }).fill('29.99')
    await page.getByRole('button', { name: '取消编辑', exact: true }).click()
    await expect(page.locator('.detail-price')).toContainText('19.99')
    await page.getByRole('button', { name: '编辑订阅', exact: true }).click()
    await page.getByRole('textbox', { name: '金额', exact: true }).fill('29.99')
    await page.getByRole('button', { name: '保存修改', exact: true }).click()
    await expect(page.locator('.detail-price')).toContainText('29.99')
    await page.getByRole('button', { name: '返回我的订阅', exact: true }).click()
    await page.getByRole('button', { name: '查看 桌面测试会员 详情', exact: true }).click()
    await expect(page.getByRole('heading', { name: '费用与周期' })).toBeVisible()
    const exported = join(userData, 'backup.json')
    await app.evaluate(({ dialog }, file) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: file })
    }, exported)
    await page.getByRole('button', { name: '设置与备份', exact: true }).click()
    await page.getByRole('button', { name: '导出备份', exact: true }).click()
    await expect(page.getByRole('status')).toHaveText('备份已导出。')
    expect(JSON.parse(await readFile(exported, 'utf8')).subscriptions[0].amountMinor).toBe(2999)
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false })
    }, exported)
    await page.getByRole('button', { name: '导入备份', exact: true }).click()
    await expect(page.getByRole('status')).toContainText('已导入 1 项订阅')
    await app.close()
    app = await launch()
    page = await app.firstWindow()
    await page
      .getByRole('navigation')
      .getByRole('button', { name: /我的订阅/ })
      .click()
    await page.getByRole('button', { name: '查看 桌面测试会员 详情', exact: true }).click()
    await expect(page.locator('.detail-price')).toContainText('29.99')
    await page.getByRole('button', { name: '归档订阅', exact: true }).click()
    await page.getByRole('button', { name: '确认归档', exact: true }).click()
    await expect(page.locator('.badge')).toHaveText('已归档')
    expect(errors).toEqual([])
  } finally {
    await app.close()
    const target = resolve(userData)
    if (!target.startsWith(resolve(tmpdir()) + sep) || !basename(target).startsWith('xuding-test-'))
      throw new Error('Refusing to remove unexpected test directory')
    await rm(target, { recursive: true, force: true })
  }
})
