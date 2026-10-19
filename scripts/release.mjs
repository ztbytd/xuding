import { createHash, createPrivateKey, sign, verify } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const { version } = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Only stable releases may be signed')
const filename = `xuding-${version}-windows-x64-setup.exe`,
  path = resolve(root, 'release', filename)
const hash = createHash('sha512')
for await (const chunk of createReadStream(path)) hash.update(chunk)
const sha512 = hash.digest('base64'),
  size = (await stat(path)).size
const notes = await readFile(resolve(root, 'docs/release-notes.md'), 'utf8')
const publishedAt = new Date().toISOString()
const payload = Buffer.from(
  JSON.stringify({ format: 'xuding-update', version, filename, sha512, size, notes, publishedAt })
)
const keyText =
  process.env.XUDING_UPDATE_PRIVATE_KEY ??
  (process.env.XUDING_UPDATE_PRIVATE_KEY_FILE
    ? await readFile(process.env.XUDING_UPDATE_PRIVATE_KEY_FILE, 'utf8')
    : null)
if (!keyText)
  throw new Error('A release signing key is required; no unsigned update will be published')
const privateKey = createPrivateKey(keyText),
  signature = sign(null, payload, privateKey)
const { publicKey } = JSON.parse(
  await readFile(resolve(root, 'resources/update-trust.json'), 'utf8')
)
if (!verify(null, payload, publicKey, signature))
  throw new Error('Release key does not match the client trust key')
await writeFile(
  resolve(root, 'release/xuding-update.json'),
  JSON.stringify(
    { payload: payload.toString('base64'), signature: signature.toString('base64') },
    null,
    2
  ) + '\n'
)
await writeFile(
  resolve(root, 'release/latest.yml'),
  `version: ${version}\nfiles:\n  - url: ${filename}\n    sha512: ${sha512}\n    size: ${size}\npath: ${filename}\nsha512: ${sha512}\nreleaseDate: '${publishedAt}'\n`
)
console.log(`Signed release ${version}: installer, latest.yml and xuding-update.json`)
