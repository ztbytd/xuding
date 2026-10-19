import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'

test('compact calendar filters bills and adapts to window width', async ({}, testInfo) => {
  const userData = await mkdtemp(join(tmpdir(), 'xuding-calendar-'))
  const { ELECTRON_RUN_AS_NODE: _, ...env } = process.env
  const app = await electron.launch({ args: ['.'], env: { ...env, XUDING_DATA_DIR: userData } })
  try {
    const page = await app.firstWindow()
    await page.clock.setFixedTime(new Date('2026-10-19T12:00:00+08:00'))
    await page.reload()
    await page.getByRole('heading', { name: '每一笔订阅，心里有数。' }).waitFor()
    await page.evaluate(async () => {
      for (const item of [
        { name: '云端笔记', amountMinor: 1900, anchorDate: '2026-10-19', currency: 'CNY' },
        { name: '声浪音乐', amountMinor: 3000, anchorDate: '2026-10-19', currency: 'CNY' },
        { name: '云盘 Plus', amountMinor: 1200, anchorDate: '2026-10-20', currency: 'CNY' },
        { name: '外币会员', amountMinor: 9900, anchorDate: '2026-10-19', currency: 'USD' }
      ] as const) {
        const result = await window.desktop.save({
          ...item,
          category: '效率工具',
          cycle: 'month',
          interval: 1,
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
    await page
      .getByRole('navigation')
      .getByRole('button', { name: '扣款日历', exact: true })
      .click()
    const panel = page.getByRole('region', { name: '月度扣款日历' })
    const details = page.locator('.calendar-details')
    await expect(details.locator('.subscription-row')).toHaveCount(3)
    await expect(details).toContainText('合计 ¥61.00')
    const wide = await panel.boundingBox()
    const side = await details.boundingBox()
    expect(side!.x).toBeGreaterThan(wide!.x + wide!.width)
    expect(wide!.height).toBeLessThan(440)
    await page.screenshot({
      path: testInfo.outputPath('calendar-wide.png'),
      animations: 'disabled'
    })
    const day = page.getByRole('button', {
      name: '2026-10-19，2笔预计扣款，合计¥49.00',
      exact: true
    })
    await day.click()
    await expect(day).toHaveAttribute('aria-pressed', 'true')
    await expect(details.locator('.subscription-row')).toHaveCount(2)
    await expect(details).toContainText('合计 ¥49.00')
    await details.getByRole('button', { name: '查看 云端笔记 详情', exact: true }).click()
    await page.getByRole('button', { name: '返回扣款日历', exact: true }).click()
    await expect(day).toHaveAttribute('aria-pressed', 'true')
    await page.getByRole('button', { name: '查看整月计划', exact: true }).click()
    await expect(details.locator('.subscription-row')).toHaveCount(3)
    await page.getByRole('button', { name: '2026-10-01，0笔预计扣款', exact: true }).click()
    await expect(details).toContainText('所选日期没有预计扣款。')
    await page.getByRole('button', { name: '下个月', exact: true }).click()
    await expect(details.getByRole('heading', { name: '本月扣款计划' })).toBeVisible()
    await expect(panel.locator('.day')).toHaveCount(30)
    const rows = await panel
      .locator('.day')
      .evaluateAll((nodes) => new Set(nodes.map((n) => n.getBoundingClientRect().top)).size)
    expect(rows).toBe(6)
    expect((await panel.boundingBox())!.height).toBeLessThan(505)
    await page.screenshot({
      path: testInfo.outputPath('calendar-six-weeks.png'),
      animations: 'disabled'
    })
    await page.getByRole('button', { name: '本月', exact: true }).click()
    await expect(day).toBeVisible()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(800, 700))
    await expect
      .poll(async () => (await details.boundingBox())!.y)
      .toBeGreaterThan((await panel.boundingBox())!.y + (await panel.boundingBox())!.height)
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)
    await page.screenshot({
      path: testInfo.outputPath('calendar-narrow.png'),
      fullPage: true,
      animations: 'disabled'
    })
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
    await expect(page.getByRole('heading', { name: '扣款日历', exact: true })).toBeVisible()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1220, 860))
    await page.screenshot({
      path: testInfo.outputPath('calendar-dark.png'),
      animations: 'disabled'
    })
    await page.getByRole('combobox', { name: '统计币种' }).click()
    await page.getByRole('option', { name: '美元 USD', exact: true }).click()
    await expect(details.locator('.subscription-row')).toHaveCount(1)
    await expect(details).toContainText('外币会员')
    await page.getByRole('combobox', { name: '统计币种' }).click()
    await page.getByRole('option', { name: '欧元 EUR', exact: true }).click()
    await expect(details).toContainText('本月没有预计扣款。')
  } finally {
    await app.close()
    const target = resolve(userData)
    if (
      !target.startsWith(resolve(tmpdir()) + sep) ||
      !basename(target).startsWith('xuding-calendar-')
    )
      throw new Error('Refusing to remove unexpected test directory')
    await rm(target, { recursive: true, force: true })
  }
})
