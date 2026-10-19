import { mkdir, readdir, readFile, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { platform, release, arch } from 'node:os'
import { atomicWrite } from './files'

type Entry = { at: string; event: string; code: string }
export class Diagnostics {
  private queue: Promise<unknown> = Promise.resolve()
  constructor(
    private directory: string,
    private version: string
  ) {}
  record(event: string, error?: unknown): void {
    // Only program-defined event names and bounded error identifiers enter logs.
    const name = /^[a-z][a-z0-9.-]{0,79}$/.test(event) ? event : 'operation.error'
    const rawCode =
      error && typeof error === 'object' && 'code' in error
        ? String(error.code)
        : error instanceof Error
          ? error.name
          : 'OK'
    const code = /^(OK|Error|TypeError|RangeError|ZodError|ERR_[A-Z0-9_]{1,60}|E[A-Z]{1,24})$/.test(
      rawCode
    )
      ? rawCode
      : 'ERROR'
    const entry: Entry = { at: new Date().toISOString(), event: name, code }
    this.queue = this.queue
      .catch(() => {})
      .then(async () => {
        await mkdir(this.directory, { recursive: true })
        const path = join(this.directory, entry.at.slice(0, 10) + '.json')
        let entries: Entry[] = []
        try {
          entries = JSON.parse(await readFile(path, 'utf8'))
        } catch {
          /* first entry */
        }
        entries.push(entry)
        await atomicWrite(path, JSON.stringify(entries.slice(-10000)))
        const files = await readdir(this.directory),
          cutoff = Date.now() - 7 * 86400000
        const dated: { name: string; time: number; size: number }[] = []
        for (const name of files.filter((v) => /^\d{4}-\d{2}-\d{2}\.json$/.test(v))) {
          const info = await stat(join(this.directory, name))
          dated.push({ name, time: info.mtimeMs, size: info.size })
        }
        let size = 0
        for (const file of dated.sort((a, b) => b.time - a.time)) {
          size += file.size
          if (file.time < cutoff || size > 20 * 1024 * 1024)
            await unlink(join(this.directory, file.name))
        }
      })
    void this.queue.catch(() => {})
  }
  async export(): Promise<Buffer> {
    await this.queue.catch(() => {})
    const logs: Entry[] = []
    for (const name of (await readdir(this.directory).catch(() => [])).filter((v) =>
      /^\d{4}-\d{2}-\d{2}\.json$/.test(v)
    )) {
      if ((await stat(join(this.directory, name))).size > 2 * 1024 * 1024) continue
      try {
        const rows: Entry[] = JSON.parse(await readFile(join(this.directory, name), 'utf8'))
        for (const row of rows)
          if (
            typeof row.at === 'string' &&
            /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(row.at) &&
            /^[a-z][a-z0-9.-]{0,79}$/.test(row.event) &&
            /^[A-Za-z0-9_]{1,64}$/.test(row.code)
          )
            logs.push({ at: row.at, event: row.event, code: row.code })
      } catch {
        /* ignore damaged local diagnostic files */
      }
    }
    return Buffer.from(
      JSON.stringify(
        {
          format: 'xuding-diagnostics',
          version: 1,
          appVersion: this.version,
          generatedAt: new Date().toISOString(),
          system: { platform: platform(), release: release(), arch: arch() },
          logs: logs.slice(-50000)
        },
        null,
        2
      )
    )
  }
}
