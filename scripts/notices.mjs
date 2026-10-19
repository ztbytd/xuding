import { createRequire } from 'node:module'
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
const root = resolve(import.meta.dirname, '..'),
  visited = new Set(),
  sections = []
function visit(directory) {
  if (visited.has(directory)) return
  visited.add(directory)
  const pkg = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
  if (directory !== root) {
    const files = readdirSync(directory).filter((n) =>
      /^(licen[cs]e|copying|notice)(\..*)?$/i.test(n)
    )
    sections.push(
      `${pkg.name} ${pkg.version} (${pkg.license ?? 'see package'})\n${pkg.homepage ?? ''}\n` +
        files.map((n) => readFileSync(join(directory, n), 'utf8')).join('\n')
    )
  }
  const require = createRequire(join(directory, 'package.json'))
  for (const name of Object.keys(pkg.dependencies ?? {})) {
    const parent = require.resolve
      .paths(name)
      ?.find((parent) => existsSync(join(parent, name, 'package.json')))
    if (!parent) throw new Error('Cannot locate runtime dependency ' + name)
    visit(join(parent, name))
  }
}
visit(root)
const amalgamation = readFileSync(
  join(root, 'node_modules/better-sqlite3-multiple-ciphers/deps/sqlite3/sqlite3.c'),
  'utf8'
)
const notices = [
  ...new Set(
    (amalgamation.match(/\/\*[\s\S]*?\*\//g) ?? []).filter(
      (t) =>
        /copyright|public domain/i.test(t) &&
        /redistribution|permission is hereby|public domain|license:\s+MIT/i.test(t)
    )
  )
]
sections.push(
  'SQLite3 Multiple Ciphers 2.4.0 and bundled cryptography\nCopyright (c) 2006-2026 Ulrich Telle\nMIT license; accompanying component notices from the bundled source:\n' +
    notices.join('\n\n')
)
const file = join(root, 'resources/third-party-notices.txt')
writeFileSync(
  file,
  ('续订 — Third-party notices\n\n' + sections.join('\n\n' + '='.repeat(72) + '\n\n'))
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .join('\n')
)
console.log(`Generated notices for ${visited.size - 1} runtime packages.`)
