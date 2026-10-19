import { createHash, verify } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..'),
  directory = resolve(process.argv[2] ?? resolve(root, 'release'))
const envelope = JSON.parse(await readFile(resolve(directory, 'xuding-update.json'), 'utf8'))
const bytes = Buffer.from(envelope.payload, 'base64')
const { publicKey } = JSON.parse(
  await readFile(resolve(root, 'resources/update-trust.json'), 'utf8')
)
if (!verify(null, bytes, publicKey, Buffer.from(envelope.signature, 'base64')))
  throw new Error('Update signature invalid')
const payload = JSON.parse(bytes.toString('utf8'))
if (
  !/^\d+\.\d+\.\d+$/.test(payload.version) ||
  payload.filename !== `xuding-${payload.version}-windows-x64-setup.exe`
)
  throw new Error('Unexpected installer identity')
const installer = resolve(directory, payload.filename),
  hash = createHash('sha512')
for await (const chunk of createReadStream(installer)) hash.update(chunk)
if (hash.digest('base64') !== payload.sha512 || (await stat(installer)).size !== payload.size)
  throw new Error('Installer hash mismatch')
const latest = await readFile(resolve(directory, 'latest.yml'), 'utf8')
if (
  !latest.includes(`version: ${payload.version}\n`) ||
  !latest.includes(`sha512: ${payload.sha512}\n`) ||
  !latest.includes(`url: ${payload.filename}\n`)
)
  throw new Error('Updater metadata mismatch')
console.log(`Verified installer and signed update metadata for ${payload.version}`)
