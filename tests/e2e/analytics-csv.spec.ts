import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { mockExchange } from './exchange-fixture'
import { parseCsv, serializeCsv } from '../../src/shared/csv'

test('budgets, analysis, CSV correction and creation, filtered export and complete recovery', async ({}, testInfo) => {
  test.setTimeout(120000)
  const userData = await mkdtemp(join(tmpdir(), 'xuding-analysis-csv-'))
  const { ELECTRON_RUN_AS_NODE: _, ...env } = process.env
  const launch = () => electron.launch({ args: ['.'], env: { ...env, XUDING_DATA_DIR: userData } })
  let app = await launch()
  try {
    let page = await app.firstWindow()
    async function setup() {
      await app.evaluate(() => {
        const Original = Date,
          instant = Original.parse('2026-10-19T04:00:00Z')
        globalThis.Date = class extends Original {
          constructor(v?: string | number) {
            super(v === undefined ? instant : v)
          }
          static now() {
            return instant
          }
        } as unknown as DateConstructor
      })
      await page.clock.setFixedTime(new Date('2026-10-19T12:00:00+08:00'))
      await page.setViewportSize({ width: 1220, height: 860 })
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await mockExchange(app)
    }
    await setup()
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    const go = (name: string) =>
      page.getByRole('navigation').getByRole('button', { name, exact: true }).click()
    const dialog = (name: string) => page.getByRole('dialog', { name, exact: true })
    const pick = async (path: string) =>
      app.evaluate(({ dialog }, file) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
      }, path)
    await page.getByRole('heading', { name: '每一笔订阅，心里有数。' }).waitFor()
    await page.evaluate(async () => {
      const base = {
        category: '效率工具' as const,
        amountMinor: 3000,
        currency: 'CNY' as const,
        cycle: 'month' as const,
        interval: 1,
        anchorDate: '2026-10-19',
        status: 'active' as const,
        autoRenew: true,
        reminderDays: 3 as const,
        website: '',
        notes: ''
      }
      const first = await window.desktop.save({ ...base, name: '云端笔记' })
      if (!first.ok) throw new Error(first.error)
      const second = await window.desktop.save({
        ...base,
        name: '声浪音乐',
        category: '影音娱乐',
        amountMinor: 1800,
        anchorDate: '2026-10-25'
      })
      if (!second.ok) throw new Error(second.error)
      const third = await window.desktop.save({
        ...base,
        name: '影院会员',
        category: '影音娱乐',
        amountMinor: 2500,
        anchorDate: '2026-10-01',
        autoRenew: false
      })
      if (!third.ok) throw new Error(third.error)
      const state = await window.desktop.load()
      if (!state.ok) throw new Error(state.error)
      const bill = state.data.bills[0]
      const paid = await window.desktop.updateBill({
        id: bill.id,
        expectedUpdatedAt: bill.updatedAt,
        status: 'paid',
        payment: { amountMinor: 3000, currency: 'CNY', paidOn: '2026-10-19' }
      })
      if (!paid.ok) throw new Error(paid.error)
      const historical = await window.desktop.addBill({
        subscriptionId: third.data.id,
        due: '2026-10-01',
        payment: { amountMinor: 2500, currency: 'CNY', paidOn: '2026-10-01' }
      })
      if (!historical.ok) throw new Error(historical.error)
    })
    await page.reload()
    await go('支出分析')
    await expect(page.locator('.analysis-summary .stat>strong')).toHaveText([
      '¥55.00',
      '¥73.00',
      '—'
    ])
    await page.getByRole('button', { name: '预算设置', exact: true }).click()
    await page.getByRole('spinbutton', { name: '总预算', exact: true }).fill('100')
    await page.getByRole('spinbutton', { name: '效率工具预算', exact: true }).fill('120')
    await page.getByRole('button', { name: '保存预算', exact: true }).click()
    await expect(dialog('2026-10 月度预算').getByRole('alert')).toContainText('不能超过总预算')
    await page.getByRole('spinbutton', { name: '效率工具预算', exact: true }).fill('80')
    await page.getByRole('button', { name: '保存预算', exact: true }).click()
    await expect(dialog('2026-10 月度预算')).toBeHidden()
    await expect(page.locator('.analysis-summary .stat>strong')).toHaveText([
      '¥55.00',
      '¥73.00',
      '¥45.00'
    ])
    await go('总览')
    await expect(page.locator('.budget-strip')).toContainText('本月预算 ¥100.00')
    await page.getByRole('combobox', { name: '统计币种', exact: true }).click()
    await page.getByRole('option', { name: '美元 USD', exact: true }).click()
    await expect(page.locator('.budget-strip')).toContainText('本月预算 ¥100.00')
    await page.getByRole('button', { name: '查看本月预算分析', exact: true }).click()
    await page.getByRole('combobox', { name: '分析统计币种', exact: true }).click()
    await page.getByRole('option', { name: 'CNY', exact: true }).click()
    const subscriptionsFile = join(userData, 'subscriptions.csv')
    await writeFile(
      subscriptionsFile,
      serializeCsv([
        ['订阅名称', '预计金额', '订阅币种'],
        ['阅读会员', '9.99', 'CNY'],
        ['云端笔记', '30', 'CNY'],
        ['错误数据', '-1', 'CNY']
      ])
    )
    await pick(subscriptionsFile)
    await page.getByRole('button', { name: '导入 CSV', exact: true }).click()
    await dialog('导入 CSV').getByRole('button', { name: '选择 CSV 文件', exact: true }).click()
    await expect(dialog('导入 CSV')).toContainText('subscriptions.csv')
    await page.getByRole('button', { name: '下一步：匹配字段', exact: true }).click()
    await page.getByRole('combobox', { name: 'CSV 默认自动续费', exact: true }).click()
    await page.getByRole('option', { name: '关闭', exact: true }).click()
    await page.getByRole('button', { name: '检查并预览', exact: true }).click()
    await expect(page.locator('.csv-preview-counts')).toContainText('待处理1')
    await page.getByRole('button', { name: '明确排除全部错误行', exact: true }).click()
    await expect(page.locator('.csv-preview-counts')).toContainText('待处理0')
    await expect(page.getByRole('button', { name: '确认导入', exact: true })).toBeEnabled()
    await expect(page.locator('.ant-modal')).toHaveCSS('opacity', '1')
    await page.screenshot({
      path: testInfo.outputPath('csv-preview.png'),
      animations: 'allow',
      style: '.toast{visibility:hidden}'
    })
    await page.getByRole('button', { name: '确认导入', exact: true }).click()
    await expect(dialog('导入 CSV')).toContainText('导入完成')
    await page.getByRole('button', { name: '完成', exact: true }).click()
    const beforeBills = await page.evaluate(() => window.desktop.load())
    if (!beforeBills.ok) throw new Error(beforeBills.error)
    const firstBatch = beforeBills.data.importBatches.find((b) => b.kind === 'subscriptions')!
    const billsFile = join(userData, 'bills.csv')
    await writeFile(
      billsFile,
      serializeCsv([
        ['订阅名称', '应扣日期', '实际金额', '支付币种', '支付日期'],
        ['云端笔记', '2026-09-19', '30', 'CNY', '2026-10-05'],
        ['云端笔记', '2026-09-19', '30', 'CNY', '2026-10-05'],
        ['待关联会员', '2026-09-02', '10', 'CNY', '2026-09-02']
      ])
    )
    await pick(billsFile)
    await page.getByRole('button', { name: '导入 CSV', exact: true }).click()
    await page.getByRole('combobox', { name: 'CSV 导入类型', exact: true }).click()
    await page.getByRole('option', { name: '账单记录', exact: true }).click()
    await dialog('导入 CSV').getByRole('button', { name: '选择 CSV 文件', exact: true }).click()
    await page.getByRole('button', { name: '下一步：匹配字段', exact: true }).click()
    await page.getByRole('button', { name: '检查并预览', exact: true }).click()
    const badRow = dialog('导入 CSV').getByRole('row').filter({ hasText: '找不到订阅' })
    await badRow.getByRole('button', { name: '处理', exact: true }).click()
    await page.getByRole('combobox', { name: '行关联订阅', exact: true }).click()
    await page.getByRole('option', { name: '创建新订阅并关联', exact: true }).click()
    await page.getByRole('spinbutton', { name: '新关联订阅金额', exact: true }).fill('10')
    await page.getByRole('button', { name: '应用并重新检查', exact: true }).click()
    await expect(page.locator('.csv-preview-counts')).toContainText('新增2')
    await expect(page.locator('.csv-preview-counts')).toContainText('待处理0')
    await page.getByRole('button', { name: '确认导入', exact: true }).click()
    await page.getByRole('button', { name: '完成', exact: true }).click()
    await expect(page.locator('.analysis-summary .stat>strong')).toHaveText([
      '¥85.00',
      '¥103.00',
      '¥15.00'
    ])
    await page.evaluate(() => window.scrollTo(0, 0))
    await page.screenshot({
      path: testInfo.outputPath('analysis.png'),
      fullPage: true,
      animations: 'disabled',
      style: '.toast{visibility:hidden}'
    })
    await app.evaluate(({ Notification }) => {
      Notification.isSupported = () => true
      const notes: Electron.Notification[] = []
      ;(globalThis as unknown as { budgetNotes: Electron.Notification[] }).budgetNotes = notes
      Notification.prototype.show = function () {
        notes.push(this)
        this.emit('show')
      }
    })
    await go('设置与备份')
    await page.getByRole('switch', { name: '预算桌面通知', exact: true }).click()
    await app.evaluate(({ powerMonitor }) => powerMonitor.emit('resume'))
    await expect
      .poll(() =>
        app.evaluate(
          () =>
            (globalThis as unknown as { budgetNotes: Electron.Notification[] }).budgetNotes.length
        )
      )
      .toBe(1)
    await app.evaluate(({ powerMonitor }) => powerMonitor.emit('resume'))
    expect(
      await app.evaluate(
        () => (globalThis as unknown as { budgetNotes: Electron.Notification[] }).budgetNotes.length
      )
    ).toBe(1)
    await app.evaluate(() =>
      (globalThis as unknown as { budgetNotes: Electron.Notification[] }).budgetNotes[0].emit(
        'click'
      )
    )
    await expect(page.getByRole('heading', { name: '支出分析', exact: true })).toBeVisible()
    await page.getByRole('combobox', { name: '分析分类筛选', exact: true }).click()
    await page.getByRole('option', { name: '效率工具', exact: true }).click()
    const exported = join(userData, 'filtered.csv')
    await app.evaluate(({ dialog }, file) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: file })
    }, exported)
    await page.getByRole('button', { name: '导出', exact: true }).click()
    await page.getByRole('combobox', { name: '导出范围', exact: true }).click()
    await page.getByRole('option', { name: '全部记录', exact: true }).click()
    await expect(dialog('导出 CSV')).toContainText('本次导出全部记录')
    await page.getByRole('combobox', { name: '导出范围', exact: true }).click()
    await page.getByRole('option', { name: '当前筛选结果（2 项）', exact: true }).click()
    await expect(dialog('导出 CSV')).toContainText('本次导出当前筛选的 2 项')
    await dialog('导出 CSV').getByRole('button', { name: '导出 CSV', exact: true }).click()
    await expect(dialog('导出 CSV')).toBeHidden()
    expect(parseCsv(await readFile(exported, 'utf8')).rows).toHaveLength(2)
    await go('设置与备份')
    await page.getByRole('button', { name: '备份历史', exact: true }).click()
    await page.getByRole('button', { name: `恢复 ${firstBatch.safetyBackup}`, exact: true }).click()
    await page.getByRole('combobox', { name: '恢复方式', exact: true }).click()
    await page.getByRole('option', { name: '完整恢复整个账本', exact: true }).click()
    await page.getByRole('button', { name: '确认恢复', exact: true }).click()
    const recovered = await page.evaluate(() => window.desktop.load())
    expect(recovered.ok && recovered.data.subscriptions).toHaveLength(3)
    expect(recovered.ok && recovered.data.bills).toHaveLength(2)
    expect(recovered.ok && recovered.data.importBatches).toHaveLength(0)
    await app.close()
    app = await launch()
    page = await app.firstWindow()
    await setup()
    await go('支出分析')
    await expect(page.locator('.analysis-summary .stat>strong')).toHaveText([
      '¥55.00',
      '¥73.00',
      '¥45.00'
    ])
    await page.setViewportSize({ width: 800, height: 700 })
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)
    await page.evaluate(() => window.scrollTo(0, 0))
    await page.screenshot({
      path: testInfo.outputPath('analysis-dark.png'),
      fullPage: true,
      animations: 'disabled',
      style: '.toast{visibility:hidden}'
    })
    expect(errors).toEqual([])
  } catch (error) {
    const diagnostic = await app.firstWindow()
    await diagnostic.screenshot({ path: testInfo.outputPath('failure.png'), animations: 'allow' })
    throw error
  } finally {
    await app.close()
    const target = resolve(userData)
    if (
      !target.startsWith(resolve(tmpdir()) + sep) ||
      !basename(target).startsWith('xuding-analysis-csv-')
    )
      throw new Error('Unexpected cleanup path')
    await rm(target, { recursive: true, force: true })
  }
})
