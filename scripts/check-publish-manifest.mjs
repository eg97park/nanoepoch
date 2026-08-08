// Refuses a release whose manifest npm would rewrite into one that runs code
// at install time -- checked before the upload rather than after it, which is
// the difference between a red release and a broken package on the registry.
//
// Usage: node scripts/check-publish-manifest.mjs <report.json> [--integrity-to <file>]
//
// The report comes from `npm publish --dry-run --json`. The decision is in
// lib/publish-manifest.mjs so it can be tested against every shape npm has
// emitted; see test/publish-manifest.test.mjs.

import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { inspect } from './lib/publish-manifest.mjs'

const require = createRequire(import.meta.url)
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

const [reportPath] = process.argv.slice(2)
if (!reportPath || reportPath.startsWith('--')) {
  console.error('usage: node scripts/check-publish-manifest.mjs <report.json> [--integrity-to <file>]')
  process.exit(1)
}

const integrityIndex = process.argv.indexOf('--integrity-to')
const integrityTo = integrityIndex === -1 ? null : process.argv[integrityIndex + 1]
if (integrityIndex !== -1 && !integrityTo) {
  console.error('--integrity-to requires a path')
  process.exit(1)
}

let reported
try {
  reported = JSON.parse(readFileSync(reportPath, 'utf8'))
} catch (error) {
  // The likeliest cause is a lifecycle script writing to stdout, which npm's
  // --json modes use as a data channel. Say so, because the raw parse error
  // points at the package name and reads like a corrupt package.
  console.error(`could not read ${reportPath} as JSON (${error.message})`)
  console.error('if it starts with human-readable text, a lifecycle script wrote to stdout')
  process.exit(1)
}

const pkg = require(join(packageRoot, 'package.json'))
const { problems, entry } = inspect(reported, pkg)

if (problems.length > 0) {
  console.error('refusing to publish: the manifest npm would upload is not the one this package promises')
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}

console.error(`npm would upload ${entry.filename} (${entry.files.length} files, integrity ${entry.integrity})`)
if (integrityTo) writeFileSync(integrityTo, entry.integrity)
