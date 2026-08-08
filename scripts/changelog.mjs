// Prints one version's section of CHANGELOG.md, which is what the GitHub
// release body is cut from. The parsing lives in lib/ because the release gate
// uses it too, before publish, to refuse a version the changelog does not
// describe.
//
// Usage: node scripts/changelog.mjs --section <version> [--file <path>]

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { section } from './lib/changelog.mjs'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

function flag (name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

const version = flag('--section')
if (!version) {
  console.error('usage: node scripts/changelog.mjs --section <version> [--file <path>]')
  process.exit(1)
}

const file = flag('--file') ?? join(packageRoot, 'CHANGELOG.md')

let changelog
try {
  changelog = readFileSync(file, 'utf8')
} catch (error) {
  console.error(`changelog: cannot read ${file} (${error.message})`)
  process.exit(1)
}

const body = section(changelog, version)
if (body === null) {
  console.error(`changelog: no "## ${version}" section in ${file}`)
  process.exit(1)
}

process.stdout.write(`${body}\n`)
