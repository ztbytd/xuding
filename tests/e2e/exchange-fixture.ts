import type { ElectronApplication } from '@playwright/test'

export async function mockExchange(app: ElectronApplication, offline = false) {
  await app.evaluate(({ net }, unavailable) => {
    net.fetch = async () => {
      if (unavailable) throw new Error('Test offline')
      return new Response(
        JSON.stringify([
          { date: '2026-10-16', base: 'EUR', quote: 'CNY', rate: 7.2 },
          { date: '2026-10-16', base: 'EUR', quote: 'USD', rate: 1 },
          { date: '2026-10-16', base: 'EUR', quote: 'HKD', rate: 7.8 }
        ]),
        { status: 200 }
      )
    }
  }, offline)
}
