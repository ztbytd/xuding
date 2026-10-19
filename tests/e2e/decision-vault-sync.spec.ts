import { test, expect, _electron as electron } from '@playwright/test'
import type { Page } from '@playwright/test'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'

test('decisions, encryption, lock/restart and two desktop instances synchronize securely', async ({}, testInfo) => {
  test.setTimeout(180000)
  const files = new Map<string, { bytes: Buffer; etag: string }>()
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const path = req.url!,
      old = files.get(path)
    if (
      req.headers.authorization !==
      'Basic ' + Buffer.from('desktop:integration-password').toString('base64')
    ) {
      res.writeHead(401).end()
      return
    }
    if (req.method === 'GET') {
      if (!old) {
        res.writeHead(404).end()
        return
      }
      res.writeHead(200, { ETag: old.etag, 'Content-Length': old.bytes.length }).end(old.bytes)
      return
    }
    if (req.method === 'DELETE') {
      files.delete(path)
      res.writeHead(204).end()
      return
    }
    if (req.method === 'PUT') {
      if (
        (req.headers['if-none-match'] === '*' && old) ||
        (req.headers['if-match'] && req.headers['if-match'] !== old?.etag)
      ) {
        res.writeHead(412).end()
        return
      }
      const bytes = Buffer.concat(chunks),
        etag = '"' + createHash('sha256').update(bytes).digest('hex') + '"'
      files.set(path, { bytes, etag })
      res.writeHead(201, { ETag: etag }).end()
      return
    }
    res.writeHead(405).end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = 'http://127.0.0.1:' + (server.address() as { port: number }).port + '/xuding/',
    aDir = await mkdtemp(join(tmpdir(), 'xuding-v08-a-')),
    bDir = await mkdtemp(join(tmpdir(), 'xuding-v08-b-'))
  const { ELECTRON_RUN_AS_NODE: _, ...env } = process.env
  const launch = (directory: string) =>
    electron.launch({
      args: ['.'],
      env: { ...env, XUDING_DATA_DIR: directory, XUDING_ALLOW_INSECURE_TEST_DAV: '1' }
    })
  let a = await launch(aDir),
    b: Awaited<ReturnType<typeof launch>> | undefined
  try {
    let page = await a.firstWindow()
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.getByRole('heading', { name: '每一笔订阅，心里有数。' }).waitFor()
    const result = await page.evaluate(() =>
      window.desktop.save({
        name: '决策与同步测试会员',
        category: '效率工具',
        amountMinor: 2990,
        currency: 'CNY',
        cycle: 'month',
        interval: 1,
        anchorDate: '2026-10-22',
        status: 'active',
        autoRenew: true,
        reminderDays: 3,
        website: '',
        notes: ''
      })
    )
    if (!result.ok) throw new Error(result.error)
    await page.reload()
    await page.getByRole('button', { name: '我的订阅', exact: true }).click()
    await page.getByRole('button', { name: '查看 决策与同步测试会员 详情', exact: true }).click()
    await page.getByRole('button', { name: '今天用过', exact: true }).click()
    await expect(page.locator('.usage-summary')).toContainText('近 30 天记录使用 1 天')
    await page.getByRole('button', { name: '管理决策与取消', exact: true }).click()
    await page.getByRole('combobox', { name: '续费决定', exact: true }).click()
    await page.getByRole('option', { name: '考虑取消', exact: true }).click()
    await page.getByRole('textbox', { name: '决策备注', exact: true }).fill('等待本轮使用后再决定')
    await page.getByRole('button', { name: '保存使用与决策', exact: true }).click()
    await expect
      .poll(async () => {
        const s = await page.evaluate(() => window.desktop.load())
        return s.ok ? s.data.decisions[0]?.decision : null
      })
      .toBe('consider')
    await page.getByRole('button', { name: '总览', exact: true }).click()
    await expect(page.locator('.attention-panel')).toContainText('即将续费，待决定')
    await page.keyboard.press('Control+k')
    await page.getByRole('textbox', { name: '全局搜索', exact: true }).fill('决策与同步')
    await page.getByRole('textbox', { name: '全局搜索', exact: true }).press('Enter')
    await expect(
      page.getByRole('heading', { name: '决策与同步测试会员', exact: true })
    ).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('v08-decisions.png'), fullPage: true })
    await page.getByRole('button', { name: '设置与备份', exact: true }).click()
    await page.getByRole('tab', { name: '安全', exact: true }).click()
    await page.getByRole('button', { name: '启用本地加密', exact: true }).click()
    const password = '桌面加密测试密码 2026'
    await page.getByRole('textbox', { name: '新解锁密码', exact: true }).fill(password)
    await page.getByRole('textbox', { name: '再次输入解锁密码', exact: true }).fill(password)
    await page.getByRole('button', { name: '提交安全设置', exact: true }).click()
    const recovery = await page.getByRole('textbox', { name: '恢复密钥', exact: true }).inputValue()
    expect(recovery).toHaveLength(64)
    await page
      .getByRole('textbox', { name: '恢复密钥最后八位', exact: true })
      .fill(recovery.slice(-8))
    await page.getByRole('button', { name: '确认启用加密', exact: true }).click()
    await expect(page.getByRole('dialog', { name: '启用本地加密', exact: true })).toBeHidden()
    await expect(page.getByText('已加密', { exact: true })).toBeVisible()
    const opts = await page.evaluate(() =>
      window.desktop.securityAction({
        action: 'options',
        options: {
          idleMinutes: 0,
          lockOnScreen: true,
          lockOnSuspend: true,
          remember: false,
          showNotificationDetails: false
        }
      })
    )
    expect(opts.ok).toBe(true)
    expect((await readFile(join(aDir, 'xuding.db'))).includes(Buffer.from(result.data.name))).toBe(
      false
    )
    await page.screenshot({ path: testInfo.outputPath('v08-security.png'), fullPage: true })
    await page.getByRole('button', { name: '锁定续订', exact: true }).click()
    await page.getByRole('heading', { name: '解锁续订', exact: true }).waitFor()
    const denied = await page.evaluate(() => window.desktop.load())
    expect(denied.ok).toBe(false)
    await page
      .getByRole('textbox', { name: '输入解锁密码', exact: true })
      .fill('incorrect password')
    await page.getByRole('button', { name: '解锁账本', exact: true }).click()
    await expect(page.getByRole('alert')).toBeVisible()
    await page.getByRole('textbox', { name: '输入解锁密码', exact: true }).fill(password)
    await page.getByRole('button', { name: '解锁账本', exact: true }).click()
    await page.getByRole('heading', { name: '每一笔订阅，心里有数。' }).waitFor()
    await page.getByRole('button', { name: '设置与备份', exact: true }).click()
    await page.getByRole('tab', { name: '同步与设备', exact: true }).click()
    async function joinSync(p: Page, name: string) {
      await p.getByRole('button', { name: '连接 WebDAV', exact: true }).click()
      await p.getByRole('textbox', { name: 'WebDAV 目录地址', exact: true }).fill(url)
      await p.getByRole('textbox', { name: 'WebDAV 用户名', exact: true }).fill('desktop')
      await p
        .getByRole('textbox', { name: 'WebDAV 密码', exact: true })
        .fill('integration-password')
      await p.getByRole('textbox', { name: '本机设备名称', exact: true }).fill(name)
      await p
        .getByRole('textbox', { name: '同步口令', exact: true })
        .fill('两台电脑同步测试口令 2026')
      await p.getByRole('button', { name: '预览同步连接', exact: true }).click()
      await p.getByRole('button', { name: '确认连接同步', exact: true }).waitFor()
      const key = p.getByRole('textbox', { name: '同步恢复密钥', exact: true })
      if (await key.count()) {
        const value = await key.inputValue()
        await p
          .getByRole('textbox', { name: '同步恢复密钥最后八位', exact: true })
          .fill(value.slice(-8))
      }
      await p.getByRole('button', { name: '确认连接同步', exact: true }).click()
      await expect(p.getByRole('dialog', { name: '连接加密同步', exact: true })).toBeHidden()
    }
    await joinSync(page, '测试电脑 A')
    b = await launch(bDir)
    const second = await b.firstWindow()
    await second.emulateMedia({ reducedMotion: 'reduce' })
    await second.getByRole('heading', { name: '每一笔订阅，心里有数。' }).waitFor()
    await second.getByRole('button', { name: '设置与备份', exact: true }).click()
    await second.getByRole('tab', { name: '同步与设备', exact: true }).click()
    await joinSync(second, '测试电脑 B')
    await expect
      .poll(async () => {
        const s = await second.evaluate(() => window.desktop.load())
        return s.ok ? s.data.subscriptions.length : -1
      })
      .toBe(1)
    const synced = await second.evaluate(() => window.desktop.load())
    expect(synced.ok && synced.data.decisions[0].reason).toBe('等待本轮使用后再决定')
    const updated = await second.evaluate(async () => {
      const s = await window.desktop.load()
      if (!s.ok) throw new Error(s.error)
      const { id, createdAt, updatedAt, ...v } = s.data.subscriptions[0]
      return window.desktop.save({ ...v, notes: '电脑 B 离线编辑' }, id)
    })
    expect(updated.ok).toBe(true)
    await second.getByRole('button', { name: '立即同步', exact: true }).click()
    await expect
      .poll(async () => {
        const s = await second.evaluate(() => window.desktop.syncStatus())
        return s.ok ? s.data.phase : 'error'
      })
      .toBe('idle')
    await page.getByRole('button', { name: '立即同步', exact: true }).click()
    await expect
      .poll(async () => {
        const s = await page.evaluate(() => window.desktop.load())
        return s.ok ? s.data.subscriptions[0]?.notes : ''
      })
      .toBe('电脑 B 离线编辑')
    await page.screenshot({ path: testInfo.outputPath('v08-sync.png'), fullPage: true })
    const remote = files.get('/xuding/xuding-sync-v1.json')!.bytes.toString()
    expect(remote).not.toContain('决策与同步测试会员')
    expect(remote).not.toContain('电脑 B 离线编辑')
    await a.close()
    a = await launch(aDir)
    page = await a.firstWindow()
    await page.getByRole('heading', { name: '解锁续订', exact: true }).waitFor()
    await page.getByRole('button', { name: '使用恢复密钥', exact: true }).click()
    await page.getByRole('textbox', { name: '输入恢复密钥', exact: true }).fill(recovery)
    await page.getByRole('button', { name: '解锁账本', exact: true }).click()
    await page.getByRole('heading', { name: '每一笔订阅，心里有数。' }).waitFor()
    const restored = await page.evaluate(() => window.desktop.load())
    expect(restored.ok && restored.data.subscriptions[0].notes).toBe('电脑 B 离线编辑')
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
    await page.setViewportSize({ width: 800, height: 620 })
    await page.getByRole('button', { name: '设置与备份', exact: true }).click()
    await page.getByRole('tab', { name: '安全', exact: true }).click()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  } finally {
    await b?.close()
    await a.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
