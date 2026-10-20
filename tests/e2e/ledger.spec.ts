import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { mockExchange } from './exchange-fixture'

test('records payments, prices, calendar states and restores complete billing history', async ({}, testInfo) => {
  const userData = await mkdtemp(join(tmpdir(), 'xuding-ledger-'))
  const { ELECTRON_RUN_AS_NODE: _, ...env } = process.env
  const launch = () => electron.launch({ args: ['.'], env: { ...env, XUDING_DATA_DIR: userData } })
  let app = await launch()
  try {
    let page = await app.firstWindow()
    const setup = async () => {
      await app.evaluate(() => {
        const Original = Date
        const instant = Original.parse('2026-10-19T04:00:00Z')
        globalThis.Date = class extends Original {
          constructor(value?: string | number) {
            super(value === undefined ? instant : value)
          }
          static now() {
            return instant
          }
        } as unknown as DateConstructor
      })
      await page.clock.setFixedTime(new Date('2026-10-19T12:00:00+08:00'))
      await page.setViewportSize({ width: 1220, height: 860 })
      await mockExchange(app)
    }
    await setup()
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    const go = (name: string) =>
      page.getByRole('navigation').getByRole('button', { name, exact: true }).click()
    const dialog = (name: string) => page.getByRole('dialog', { name, exact: true })
    await go('我的订阅')
    await page.getByRole('button', { name: '新增订阅', exact: true }).click()
    await page.getByRole('textbox', { name: '订阅名称' }).fill('音乐会员')
    await page.getByRole('spinbutton', { name: '金额', exact: true }).fill('19.99')
    await page.getByRole('button', { name: '添加订阅', exact: true }).click()
    await expect(page.locator('.record-row')).toHaveCount(1)
    await page.locator('.record-row').getByRole('button', { name: '确认支付', exact: true }).click()
    await expect(page.locator('.ant-modal')).toHaveCSS('opacity', '1')
    await page.screenshot({
      path: testInfo.outputPath('ledger-payment.png'),
      animations: 'allow',
      style: '.toast {visibility:hidden}'
    })
    await page.getByRole('spinbutton', { name: '实际扣款金额' }).fill('18.888')
    await dialog('确认支付').getByRole('button', { name: '确认支付', exact: true }).click()
    await expect(dialog('确认支付').getByRole('alert')).toContainText('最多两位小数')
    await page.getByRole('spinbutton', { name: '实际扣款金额' }).fill('18.88')
    await dialog('确认支付').getByRole('button', { name: '确认支付', exact: true }).click()
    await expect(dialog('确认支付')).toBeHidden()
    await expect(page.locator('.record-row')).toContainText('已支付')
    await go('总览')
    await expect(page.locator('.stats .stat > strong')).toHaveText(['¥18.88', '¥19.99', '¥0.00'])
    await expect(page.locator('.pending-panel')).toHaveCount(0)
    await go('扣款日历')
    await page.getByRole('button', { name: /2026-10-19，1笔/ }).click()
    await expect(page.locator('.calendar-details .subscription-row')).toHaveCount(1)
    await expect(page.locator('.calendar-details')).toContainText('已支付')
    await page.locator('.calendar-details .subscription-row').click()
    await page.getByRole('button', { name: '调整价格', exact: true }).click()
    await page.getByRole('spinbutton', { name: '新价格', exact: true }).fill('25')
    await page.getByRole('textbox', { name: '价格生效日期' }).fill('2026-11-01')
    await page.getByRole('textbox', { name: '价格生效日期' }).press('Enter')
    await page.getByRole('button', { name: '保存价格', exact: true }).click()
    await expect(page.locator('.detail-price')).toContainText('19.99')
    await page.getByRole('tab', { name: '后续计划', exact: true }).click()
    await expect(page.locator('.schedule-row').first()).toContainText('¥25.00')
    await page.getByRole('tab', { name: '变更记录', exact: true }).click()
    await expect(page.locator('.price-history-row').first()).toContainText('待生效')
    await page.getByRole('tab', { name: /账单记录/ }).click()
    await page.getByRole('button', { name: '补录账单', exact: true }).click()
    await page.getByRole('textbox', { name: '应扣日期', exact: true }).fill('2026-09-19')
    await page.getByRole('textbox', { name: '应扣日期', exact: true }).press('Enter')
    await page.getByRole('textbox', { name: '实际支付日期', exact: true }).fill('2026-09-20')
    await page.getByRole('textbox', { name: '实际支付日期', exact: true }).press('Enter')
    await page.getByRole('spinbutton', { name: '实际扣款金额' }).fill('15')
    await page.getByRole('button', { name: '保存补录', exact: true }).click()
    await expect(page.locator('.record-row')).toHaveCount(2)
    await expect(
      page.getByRole('tabpanel', { name: /账单记录/ }).locator('.ledger-toolbar')
    ).toContainText('¥33.88')
    await page.evaluate(() => window.scrollTo(0, 0))
    await page.screenshot({
      path: testInfo.outputPath('ledger-detail.png'),
      fullPage: true,
      animations: 'disabled',
      style: '.toast {visibility:hidden}'
    })
    await page
      .locator('.record-row')
      .first()
      .getByRole('button', { name: '撤销确认', exact: true })
      .click()
    await page
      .locator('.record-row')
      .first()
      .getByRole('button', { name: '跳过', exact: true })
      .click()
    await expect(page.locator('.record-row').first()).toContainText('已跳过')
    await page
      .locator('.record-row')
      .first()
      .getByRole('button', { name: '记录支付', exact: true })
      .click()
    await dialog('确认支付').getByRole('button', { name: '确认支付', exact: true }).click()
    await expect(page.locator('.record-row').first()).toContainText('已支付')
    await go('总览')
    await expect(page.locator('.stats .stat > strong')).toHaveText(['¥19.99', '¥19.99', '¥0.00'])
    await page.getByRole('combobox', { name: '分类支出口径' }).click()
    await page.getByRole('option', { name: '本月实际', exact: true }).click()
    await expect(page.locator('.bar-row')).toContainText('¥19.99')
    await page.evaluate(() => window.scrollTo(0, 0))
    await page.screenshot({
      path: testInfo.outputPath('ledger-overview.png'),
      fullPage: true,
      animations: 'disabled',
      style: '.toast {visibility:hidden}'
    })
    await go('设置与备份')
    await page.getByRole('tab', { name: '数据与备份', exact: true }).click()
    await page.getByRole('button', { name: '立即备份', exact: true }).click()
    await expect(page.getByText('备份已完成。', { exact: true })).toBeVisible()
    const state = await page.evaluate(() => window.desktop.load())
    if (!state.ok) throw new Error(state.error)
    const files = await page.evaluate(() => window.desktop.backupHistory())
    if (!files.ok) throw new Error(files.error)
    const manual = files.data.find((f) => f.kind === 'manual')!
    const b = state.data.bills[0]
    await page.evaluate(async (b) => {
      const r = await window.desktop.updateBill({
        id: b.id,
        expectedUpdatedAt: b.updatedAt,
        status: 'skipped'
      })
      if (!r.ok) throw new Error(r.error)
    }, b)
    await page.getByRole('button', { name: '备份历史', exact: true }).click()
    await page.getByRole('button', { name: `恢复 ${manual.id}`, exact: true }).click()
    await expect(dialog('恢复预览')).toContainText('2 笔账单')
    await page.getByRole('button', { name: '确认恢复', exact: true }).click()
    await expect(page.getByRole('dialog', { name: '恢复预览', exact: true })).toBeHidden()
    const restored = await page.evaluate(() => window.desktop.load())
    expect(restored.ok && restored.data.bills).toEqual(state.data.bills)
    await app.close()
    app = await launch()
    page = await app.firstWindow()
    await setup()
    const restarted = await page.evaluate(() => window.desktop.load())
    expect(restarted.ok && restarted.data.bills).toEqual(state.data.bills)
    await go('我的订阅')
    await page.getByRole('button', { name: '查看 音乐会员 详情', exact: true }).click()
    await page.getByRole('button', { name: '编辑订阅', exact: true }).click()
    await expect(page.getByRole('spinbutton', { name: '金额', exact: true })).toBeDisabled()
    await page.getByRole('button', { name: '取消编辑', exact: true }).click()
    await page.setViewportSize({ width: 800, height: 700 })
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)
    await page.evaluate(() => window.scrollTo(0, 0))
    await page.screenshot({
      path: testInfo.outputPath('ledger-dark.png'),
      fullPage: true,
      animations: 'disabled',
      style: '.toast {visibility:hidden}'
    })
    expect(errors).toEqual([])
  } finally {
    await app.close()
    const target = resolve(userData)
    if (
      !target.startsWith(resolve(tmpdir()) + sep) ||
      !basename(target).startsWith('xuding-ledger-')
    )
      throw new Error('Unexpected cleanup path')
    await rm(target, { recursive: true, force: true })
  }
})
