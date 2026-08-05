// The binary resolver used to be node-gyp-build's problem. It is ours now, so
// it gets the coverage a dependency would have shipped with: which filenames
// are looked for, in what order, what wins when several exist, and what the
// failure says when none of them load.
//
// Every case runs in a throwaway package directory built from the real index.js
// and a real .node, and is exercised through a child process -- a loader is only
// interesting at require time, and require caches.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const nanoepoch = require('../index.js')

const target = `${process.platform}-${process.arch}`

// Whatever binary this checkout actually has -- a local build or a shipped
// prebuild. The fixtures are copies of it, so they load exactly as the real one
// does and the tests below are about resolution, not about the addon.
//
// In prebuilds/ the pick follows the loader's own candidate order rather than
// readdir order. On Linux that directory holds both libc builds, and the
// alphabetically first one is the glibc build even on Alpine -- a fixture built
// from it would be testing whether one libc's binary happens to load on the
// other, which is not what any test here is about.
function realBinary () {
  for (const directory of [join(packageRoot, 'build', 'Release'), join(packageRoot, 'build', 'Debug')]) {
    let entries = []
    try {
      entries = readdirSync(directory).filter((entry) => entry.endsWith('.node')).sort()
    } catch {
      continue
    }
    if (entries.length > 0) return join(directory, entries[0])
  }

  const prebuilds = join(packageRoot, 'prebuilds', target)
  for (const name of nanoepoch._candidateNames()) {
    const file = join(prebuilds, name)
    if (existsSync(file)) return file
  }

  throw new Error('no .node in build/ or prebuilds/; run `npm run build` first')
}

const binary = realBinary()
const fixtures = []

function makeFixture (layout) {
  const root = mkdtempSync(join(tmpdir(), 'nanoepoch-loader-'))
  fixtures.push(root)
  copyFileSync(join(packageRoot, 'index.js'), join(root, 'index.js'))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'nanoepoch', version: '0.0.0-fixture' }))
  for (const [relative, content] of Object.entries(layout)) {
    const file = join(root, ...relative.split('/'))
    mkdirSync(dirname(file), { recursive: true })
    if (content === 'real') copyFileSync(binary, file)
    else writeFileSync(file, content)
  }
  return root
}

// Reports which file the loader ended up using, so precedence can be asserted
// on identity rather than on "it worked".
const PROBE = `
  const nanoepoch = require(process.argv[1])
  const value = nanoepoch.now()
  if (typeof value !== 'bigint') throw new Error('not a bigint: ' + typeof value)
  const used = Object.keys(require.cache).filter((k) => k.endsWith('.node'))
  console.log(JSON.stringify({ ok: true, value: String(value), used }))
`

function load (root, env = {}) {
  const result = spawnSync(process.execPath, ['-e', PROBE, root], {
    encoding: 'utf8',
    env: { ...process.env, ...env }
  })
  if (result.status === 0) return { ok: true, ...JSON.parse(result.stdout) }
  return { ok: false, stderr: result.stderr }
}

test.after(() => {
  for (const root of fixtures) rmSync(root, { recursive: true, force: true, maxRetries: 5 })
})

test('the candidate list matches what the release actually publishes', () => {
  const names = nanoepoch._candidateNames()
  assert.ok(names.length >= 1)
  for (const name of names) assert.match(name, /^nanoepoch(\.(glibc|musl))?\.node$/)

  if (process.platform === 'linux') {
    // Both libc builds live in one directory, so both names must be reachable
    // or a wrong guess would be terminal instead of merely slow.
    assert.deepEqual([...names].sort(), ['nanoepoch.glibc.node', 'nanoepoch.musl.node'])
  } else {
    assert.deepEqual(names, ['nanoepoch.node'])
  }
})

test('a bundled prebuild is found and loaded', () => {
  const name = process.platform === 'linux' ? nanoepoch._candidateNames()[0] : 'nanoepoch.node'
  const root = makeFixture({ [`prebuilds/${target}/${name}`]: 'real' })

  const result = load(root)
  assert.ok(result.ok, `expected the prebuild to load, got:\n${result.stderr}`)
  assert.ok(BigInt(result.value) > 1750000000000000000n)
  assert.equal(result.used.length, 1)
  assert.ok(result.used[0].includes('prebuilds'))
})

test('a local build outranks a bundled prebuild', () => {
  const name = process.platform === 'linux' ? nanoepoch._candidateNames()[0] : 'nanoepoch.node'
  const root = makeFixture({
    'build/Release/nanoepoch.node': 'real',
    [`prebuilds/${target}/${name}`]: 'real'
  })

  const result = load(root)
  assert.ok(result.ok, `expected the local build to load, got:\n${result.stderr}`)
  assert.equal(result.used.length, 1)
  assert.ok(result.used[0].includes('Release'), `expected build/Release to win, used ${result.used[0]}`)
})

test('a broken local build is reported, not masked by a working prebuild', () => {
  const name = process.platform === 'linux' ? nanoepoch._candidateNames()[0] : 'nanoepoch.node'
  const root = makeFixture({
    'build/Release/nanoepoch.node': 'not a shared object',
    [`prebuilds/${target}/${name}`]: 'real'
  })

  // Falling through to the prebuild here would hand a contributor the shipped
  // behaviour while they believe they are testing their own build.
  const result = load(root)
  assert.equal(result.ok, false, 'a broken local build must not fall through to the prebuild')
  assert.match(result.stderr, /Load attempts, in order:/)
  // The path, not the bare word "build": the generic advice block below always
  // says "build from source" and "build-essential", so matching /build/ would
  // pass no matter which file the loader actually tried.
  assert.match(result.stderr, /Release[\\/]nanoepoch\.node/)
})

test('a candidate that fails to load falls through to the next one', {
  skip: process.platform === 'linux' ? false : 'only Linux ships more than one candidate per target'
}, () => {
  const [first, second] = nanoepoch._candidateNames()

  // The reason candidateNames() returns both libc builds instead of picking
  // one. Without this, a wrong guess would be terminal, which is exactly the
  // node-gyp-build behaviour this loader replaced.
  const root = makeFixture({
    [`prebuilds/${target}/${first}`]: 'not a shared object',
    [`prebuilds/${target}/${second}`]: 'real'
  })

  const result = load(root)
  assert.ok(result.ok, `expected a fall-through to ${second}, got:\n${result.stderr}`)
  assert.equal(result.used.length, 1)
  assert.ok(result.used[0].endsWith(second), `expected ${second} to load, used ${result.used[0]}`)
})

test('no binary at all fails loudly and says why there is no fallback', () => {
  const root = makeFixture({})

  const result = load(root)
  assert.equal(result.ok, false, 'loading must fail when there is no binary')
  assert.match(result.stderr, /ERR_NANOEPOCH_LOAD_FAILED/)
  assert.match(result.stderr, /no JavaScript fallback/)
  assert.match(result.stderr, /detected : /)
  // The names it looked for are the difference between "we shipped you nothing"
  // and "we shipped you the other libc".
  assert.match(result.stderr, /looked {3}: nanoepoch/)
  // Pin the branch, not just the label: all four verdicts match /verdict {2}: /,
  // and telling a supported platform it is unsupported is the failure that
  // sends someone installing a compiler they do not need.
  const supported = ['win32-x64', 'win32-arm64', 'linux-x64', 'linux-arm64'].includes(target)
  assert.match(result.stderr, supported
    ? /verdict {2}: your platform IS in the prebuilt matrix but this install contains no binaries at all/
    : /verdict {2}: your platform is NOT in the prebuilt matrix/)
})

test('a prebuild that exists but cannot load reports the attempt, not a packaging fault', () => {
  const name = process.platform === 'linux' ? nanoepoch._candidateNames()[0] : 'nanoepoch.node'
  const root = makeFixture({ [`prebuilds/${target}/${name}`]: 'not a shared object' })

  const result = load(root)
  assert.equal(result.ok, false)
  assert.match(result.stderr, /a binary was found and selected, but loading it failed/)
  assert.match(result.stderr, /Load attempts, in order:/)
  assert.match(result.stderr, new RegExp(name.replace(/\./g, '\\.')))
})

test('LIBC selects one build and excludes the other', {
  skip: process.platform === 'linux' ? false : 'LIBC only affects the Linux candidate list'
}, () => {
  let mine = 'glibc'
  try {
    if (!process.report.getReport().header.glibcVersionRuntime) mine = 'musl'
  } catch {
    // keep the glibc assumption; the assertions below are about which file the
    // resolver names, and both branches exercise that equally
  }
  const other = mine === 'glibc' ? 'musl' : 'glibc'

  // Only the binary for THIS libc is present. Forcing the other one must fail
  // rather than quietly fall back, or the override could not be used to
  // diagnose a misdetection.
  const root = makeFixture({ [`prebuilds/${target}/nanoepoch.${mine}.node`]: 'real' })

  assert.ok(load(root, { LIBC: mine }).ok, `LIBC=${mine} should have loaded the ${mine} build`)

  const forced = load(root, { LIBC: other })
  assert.equal(forced.ok, false, `LIBC=${other} must not load the ${mine} build`)
  assert.match(forced.stderr, new RegExp(`looked {3}: nanoepoch\\.${other}\\.node`))
})

test('an unknown LIBC value is ignored rather than obeyed into a dead end', {
  skip: process.platform === 'linux' ? false : 'LIBC only affects the Linux candidate list'
}, () => {
  const root = makeFixture({
    [`prebuilds/${target}/nanoepoch.glibc.node`]: 'real',
    [`prebuilds/${target}/nanoepoch.musl.node`]: 'real'
  })

  // "gnu", "GLIBC", "1" -- a typo in an override should degrade to normal
  // detection, which still works, instead of naming a file that cannot exist.
  const result = load(root, { LIBC: 'gnu' })
  assert.ok(result.ok, `an unrecognised LIBC should fall back to detection, got:\n${result.stderr}`)

  // And when that degraded path still fails, the diagnostic must say the value
  // was ignored -- not claim an override took effect that the resolver never
  // honoured.
  const empty = makeFixture({})
  const failed = load(empty, { LIBC: 'gnu' })
  assert.equal(failed.ok, false)
  assert.match(failed.stderr, /gnu \(ignored: LIBC must be "glibc" or "musl"\)/)
  assert.doesNotMatch(failed.stderr, /forced by the LIBC environment variable/)
})
