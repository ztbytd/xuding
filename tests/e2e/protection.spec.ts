import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'

test('encrypted backups, password change, wrong-password protection and private diagnostics', async ({}, testInfo) => {
  test.setTimeout(120000)
  const directory = await mkdtemp(join(tmpdir(), 'xuding-protection-e2e-'))
  const { ELECTRON_RUN_AS_NODE: _, ...env } = process.env
  const launch = () => electron.launch({ args: ['.'], env: { ...env, XUDING_DATA_DIR: directory } })
  let app = await launch()
  try {
    let page = await app.firstWindow()
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.getByRole('heading', { name: '每一笔订阅，心里有数。' }).waitFor()
    const saved = await page.evaluate(() =>
      window.desktop.save({
        name: '诊断不应包含这份私人订阅',
        notes: '私人备注不可泄漏',
        category: '效率工具',
        amountMinor: 1999,
        currency: 'CNY',
        cycle: 'month',
        interval: 1,
        anchorDate: '2026-10-19',
        status: 'active',
        autoRenew: false,
        reminderDays: 3,
        website: ''
      })
    )
    if (!saved.ok) throw new Error(saved.error)
    await page.reload()
    await page.getByRole('button', { name: '设置与备份', exact: true }).click()
    await page.getByRole('tab', { name: '数据与备份', exact: true }).click()
    const password = '保护我的订阅备份 2026',
      newer = '更换后的订阅备份密码 2026'
    const setPassword = async (value: string) => {
      await page.getByRole('textbox', { name: '备份密码', exact: true }).fill(value)
      await page.getByRole('textbox', { name: '再次输入密码', exact: true }).fill(value)
      await page.getByRole('switch', { name: '在本机安全保存备份凭据', exact: true }).click()
      await page.getByRole('button', { name: '验证并启用', exact: true }).click()
      await expect(page.getByRole('dialog', { name: '设置备份密码', exact: true })).toBeHidden()
    }
    await page.getByRole('switch', { name: '加密新备份', exact: true }).click()
    await setPassword(password)
    await expect(page.getByRole('switch', { name: '加密新备份', exact: true })).toBeChecked()
    const initial = await page.evaluate(() => window.desktop.backupHistory())
    if (!initial.ok) throw new Error(initial.error)
    const old = initial.data.find((v) => v.kind === 'manual' && v.encrypted)!
    expect(old).toBeTruthy()
    const bytes = await readFile(join(directory, 'backups', old.id), 'utf8')
    expect(bytes).not.toContain(saved.data.name)
    expect(bytes).not.toContain(password)
    await page.getByRole('button', { name: '更改备份密码', exact: true }).click()
    await setPassword(newer)
    await page.getByRole('button', { name: '备份历史', exact: true }).click()
    await page.getByRole('button', { name: `恢复 ${old.id}`, exact: true }).click()
    await page.getByRole('textbox', { name: '解锁备份密码', exact: true }).fill(newer)
    await page.getByRole('button', { name: '验证并预览', exact: true }).click()
    await expect(
      page.getByRole('dialog', { name: '解锁备份', exact: true }).getByRole('alert')
    ).toContainText('密码错误')
    expect((await page.evaluate(() => window.desktop.load())).ok).toBe(true)
    await page.getByRole('textbox', { name: '解锁备份密码', exact: true }).fill(password)
    await page.getByRole('button', { name: '验证并预览', exact: true }).click()
    await expect(page.getByRole('dialog', { name: '恢复预览', exact: true })).toBeVisible()
    await page.screenshot({
      path: testInfo.outputPath('encrypted-restore.png'),
      animations: 'disabled'
    })
    await page.getByRole('button', { name: '确认恢复', exact: true }).click()
    await expect(page.getByRole('status')).toContainText('已导入 1 项订阅')
    const protection = await page.evaluate(() => window.desktop.protectionStatus())
    expect(protection.ok && protection.data.enabled).toBe(true)
    const damaged = 'manual-2026-10-19-00000000-0000-4000-8000-000000000009.json'
    await writeFile(join(directory, 'backups', damaged), 'not json')
    await page.getByRole('button', { name: '备份历史', exact: true }).click()
    await expect(page.getByRole('button', { name: `恢复 ${damaged}`, exact: true })).toBeDisabled()
    await page.getByRole('button', { name: '关闭备份历史', exact: true }).click()
    await page.screenshot({
      path: testInfo.outputPath('backup-protection.png'),
      animations: 'disabled'
    })
    await page.getByRole('tab', { name: '关于与更新', exact: true }).click()
    const diagnostics = join(directory, 'diagnostics.json')
    await app.evaluate(({ dialog }, file) => {
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false })
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: file })
    }, diagnostics)
    await page.getByRole('button', { name: '导出诊断包', exact: true }).click()
    await expect(page.getByRole('status')).toHaveText('诊断包已保存。')
    const report = await readFile(diagnostics, 'utf8')
    expect(report).not.toContain(saved.data.name)
    expect(report).not.toContain(password)
    expect(report).not.toContain(directory)
    expect(report).not.toContain('私人备注')
    await page.screenshot({
      path: testInfo.outputPath('about-updates.png'),
      animations: 'disabled'
    })
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
    await page.setViewportSize({ width: 800, height: 620 })
    await page.getByRole('tab', { name: '数据与备份', exact: true }).click()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({
      path: testInfo.outputPath('backup-dark-narrow.png'),
      animations: 'disabled'
    })
    await app.close()
    app = await launch()
    page = await app.firstWindow()
    await page.getByRole('heading', { name: '每一笔订阅，心里有数。' }).waitFor()
    const restarted = await page.evaluate(() => window.desktop.protectionStatus())
    expect(restarted.ok && restarted.data).toEqual({ enabled: true, credentialAvailable: true })
  } finally {
    await app.close()
    const target = resolve(directory)
    if (
      !target.startsWith(resolve(tmpdir()) + sep) ||
      !basename(target).startsWith('xuding-protection-e2e-')
    )
      throw new Error('Unexpected cleanup target')
    await rm(target, { recursive: true, force: true })
  }
})

test('a corrupt ledger opens the independent recovery window without touching the failed file', async ({}, testInfo) => {
  const directory = await mkdtemp(join(tmpdir(), 'xuding-recovery-e2e-'))
  const { ELECTRON_RUN_AS_NODE: _, ...env } = process.env
  await writeFile(join(directory, 'xuding.db'), 'synthetic damaged SQLite file')
  const app = await electron.launch({ args: ['.'], env: { ...env, XUDING_DATA_DIR: directory } })
  try {
    const page = await app.firstWindow()
    await expect(page.getByRole('heading', { name: '恢复续订账本', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '重试启动', exact: true })).toBeVisible()
    expect(await readFile(join(directory, 'xuding.db'), 'utf8')).toBe(
      'synthetic damaged SQLite file'
    )
    expect((await readdir(directory)).filter((v) => v.startsWith('upgrade-'))).toEqual([])
    await page.screenshot({
      path: testInfo.outputPath('startup-recovery.png'),
      animations: 'disabled'
    })
  } finally {
    await app.close()
    const target = resolve(directory)
    if (
      !target.startsWith(resolve(tmpdir()) + sep) ||
      !basename(target).startsWith('xuding-recovery-e2e-')
    )
      throw new Error('Unexpected cleanup target')
    await rm(target, { recursive: true, force: true })
  }
})
