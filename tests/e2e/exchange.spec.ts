import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { mockExchange } from './exchange-fixture'

test('overview converts the whole ledger and survives missing rates, offline use and restart', async ({}, testInfo) => {
  const userData = await mkdtemp(join(tmpdir(), 'xuding-exchange-'))
  const { ELECTRON_RUN_AS_NODE: _, ...env } = process.env
  const launch = () => electron.launch({ args: ['.'], env: { ...env, XUDING_DATA_DIR: userData } })
  let app = await launch()
  try {
    let page = await app.firstWindow()
    await page.setViewportSize({ width: 1220, height: 860 })
    await page.clock.setFixedTime(new Date('2026-10-19T12:00:00+08:00'))
    await mockExchange(app, true)
    await page.getByRole('heading', { name: '每一笔订阅，心里有数。' }).waitFor()
    await page.evaluate(async () => {
      for (const item of [
        { name: '美元订阅', amountMinor: 10000, currency: 'USD', category: '效率工具' },
        { name: '人民币订阅', amountMinor: 3000, currency: 'CNY', category: '生活服务' }
      ] as const) {
        const result = await window.desktop.save({
          ...item,
          cycle: 'month',
          interval: 1,
          anchorDate: '2026-10-19',
          status: 'active',
          autoRenew: true,
          reminderDays: 3,
          website: '',
          notes: ''
        })
        if (!result.ok) throw new Error(result.error)
      }
    })
    await page.reload()
    await expect(page.locator('.exchange-status')).toContainText('暂缺汇率')
    await expect(page.locator('.stats .stat > strong')).toHaveText(['—', '—', '—'])
    await expect(page.locator('.exchange-notice')).toContainText('缺少 USD → CNY 汇率')
    await expect(page.locator('.subscription-row')).toHaveCount(2)
    await expect(page.getByRole('button', { name: '查看 美元订阅 详情' })).toContainText(
      '原币 US$100.00'
    )
    await page.screenshot({
      path: testInfo.outputPath('exchange-missing.png'),
      animations: 'disabled'
    })
    await mockExchange(app)
    await page.getByRole('button', { name: '刷新汇率' }).click()
    await expect(page.locator('.stats .stat > strong')).toHaveText([
      '¥750.00',
      '¥9,000.00',
      '¥750.00'
    ])
    await expect(page.locator('.bar-row')).toHaveCount(2)
    await expect(page.locator('.overview-context')).toContainText('2 项续费订阅')
    await expect(page.locator('.exchange-notice')).toHaveCount(0)
    const dollar = page.getByRole('button', { name: '查看 美元订阅 详情' })
    await expect(dollar).toContainText('≈ ¥720.00')
    await expect(dollar).toContainText('原币 US$100.00')
    await page.screenshot({
      path: testInfo.outputPath('exchange-overview.png'),
      animations: 'disabled'
    })
    await page.getByRole('button', { name: '汇率说明' }).focus()
    await expect(page.getByRole('tooltip')).toContainText('参考日期：2026-10-16')
    await page.getByRole('combobox', { name: '统计币种' }).click()
    await page.getByRole('option', { name: '美元 USD', exact: true }).click()
    await expect(page.locator('.stats .stat > strong')).toHaveText([
      'US$104.17',
      'US$1,250.00',
      'US$104.17'
    ])
    await expect(page.locator('.subscription-row')).toHaveCount(2)
    await dollar.click()
    await expect(page.locator('.detail-price')).toContainText('US$100.00')
    await page
      .getByRole('navigation')
      .getByRole('button', { name: '我的订阅', exact: true })
      .click()
    await page.getByRole('button', { name: '新增订阅', exact: true }).click()
    await page.getByRole('textbox', { name: '订阅名称' }).fill('新增人民币订阅')
    await page.getByRole('spinbutton', { name: '金额', exact: true }).fill('24')
    await page.getByRole('button', { name: '添加订阅', exact: true }).click()
    await expect(page.getByRole('heading', { name: '新增人民币订阅', exact: true })).toBeVisible()
    await page.getByRole('navigation').getByRole('button', { name: '总览', exact: true }).click()
    await expect(page.locator('.currency-picker')).toContainText('美元 USD')
    await expect(page.locator('.stats .stat > strong')).toHaveText([
      'US$107.50',
      'US$1,290.00',
      'US$107.50'
    ])
    await page
      .getByRole('navigation')
      .getByRole('button', { name: '扣款日历', exact: true })
      .click()
    await expect(page.getByRole('combobox', { name: '筛选币种' })).toBeVisible()
    await page.getByRole('navigation').getByRole('button', { name: '总览', exact: true }).click()
    await expect(page.locator('.currency-picker')).toContainText('美元 USD')
    await app.close()
    app = await launch()
    page = await app.firstWindow()
    await page.clock.setFixedTime(new Date('2026-10-19T12:00:00+08:00'))
    await mockExchange(app, true)
    await page.reload()
    await expect(page.locator('.stats .stat > strong')).toHaveText([
      'US$107.50',
      'US$1,290.00',
      'US$107.50'
    ])
    await page.getByRole('button', { name: '刷新汇率' }).click()
    await expect(page.locator('.exchange-status')).toContainText('更新失败 · 使用缓存')
    await expect(page.locator('.stats .stat > strong')).toHaveText([
      'US$107.50',
      'US$1,290.00',
      'US$107.50'
    ])
    const saved = await page.evaluate(() => window.desktop.load())
    if (!saved.ok) throw new Error(saved.error)
    expect(saved.data.exchangeRates?.rates.CNY).toBe(7.2)
    expect(saved.data.subscriptions.find((s) => s.name === '美元订阅')).toMatchObject({
      amountMinor: 10000,
      currency: 'USD'
    })
    expect(saved.data.subscriptions.find((s) => s.name === '人民币订阅')).toMatchObject({
      amountMinor: 3000,
      currency: 'CNY'
    })
    await page.setViewportSize({ width: 800, height: 700 })
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
    await expect(page.getByRole('heading', { name: '每一笔订阅，心里有数。' })).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)
    await page.screenshot({
      path: testInfo.outputPath('exchange-offline-dark.png'),
      fullPage: true,
      animations: 'disabled'
    })
  } finally {
    await app.close()
    const target = resolve(userData)
    if (
      !target.startsWith(resolve(tmpdir()) + sep) ||
      !basename(target).startsWith('xuding-exchange-')
    )
      throw new Error('Refusing to remove unexpected test directory')
    await rm(target, { recursive: true, force: true })
  }
})
