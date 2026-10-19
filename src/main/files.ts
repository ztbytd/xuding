import { randomUUID } from 'node:crypto'
import { open, rename, unlink } from 'node:fs/promises'

export async function atomicWrite(path: string, data: string | Buffer): Promise<void> {
  const temporary = path + '.' + randomUUID() + '.tmp'
  try {
    const file = await open(temporary, 'wx', 0o600)
    try {
      await file.writeFile(data)
      await file.sync()
    } finally {
      await file.close()
    }
    await rename(temporary, path)
  } finally {
    await unlink(temporary).catch(() => {})
  }
}
