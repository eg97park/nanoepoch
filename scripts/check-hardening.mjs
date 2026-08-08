// Reads one binary and reports whether the hardening binding.gyp asks for
// actually took effect.
//
// This is the pull-request-time half of a check the release gate also performs.
// It exists separately because the release gate only ever sees eight binaries
// at once, on a tag, when it is far too late to discover that a flag was
// spelled wrong -- and because the flags are invisible to every other test: a
// binary with no RELRO passes the entire suite.
//
// Where it runs matters as much as what it checks. Pointing it at a local
// `npm run dev:build` on Ubuntu would prove nothing, because that distribution's
// GCC applies most of these by default and the check would go green whether or
// not binding.gyp had any effect. It runs against the real manylinux and Alpine
// build outputs instead, plus the MSVC build on Windows, where /guard:cf is
// definitely not a default.
//
// Usage: node scripts/check-hardening.mjs <file> --as <target>

import { readFileSync } from 'node:fs'
import { inspect, TARGETS } from './lib/hardening.mjs'

const [file] = process.argv.slice(2).filter((argument) => !argument.startsWith('--'))
const asIndex = process.argv.indexOf('--as')
const target = asIndex === -1 ? undefined : process.argv[asIndex + 1]

if (!file || !target) {
  console.error('usage: node scripts/check-hardening.mjs <file> --as <target>')
  console.error(`targets: ${TARGETS.join(', ')}`)
  process.exit(1)
}

let buffer
try {
  buffer = readFileSync(file)
} catch (error) {
  console.error(`check-hardening: cannot read ${file} (${error.message})`)
  process.exit(1)
}

const { problems, notes } = inspect(buffer, target)

console.log(`${file} as ${target} (${buffer.length} bytes)`)
for (const note of notes) console.log(`  - ${note}`)

if (problems.length > 0) {
  console.error(`\ncheck-hardening: ${file} is not hardened the way binding.gyp asks:`)
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}

console.log('  all hardening checks passed')
