// Produces one prebuilt binary for the platform this runs on:
//
//   node-gyp rebuild  ->  strip  ->  prebuilds/<platform>-<arch>/<name>.node
//
// This replaces prebuildify, which brought twenty-four packages to do the same
// three steps. The parts of prebuildify that justify that size -- building the
// same source against many Node and Electron ABIs, multi-arch tuples, uv and
// armv tags -- do not apply here: a Node-API addon is built once and loads on
// every runtime and ABI that supports Node-API 6.
//
// One deliberate difference from prebuildify: it passes
// --target=<newest version node-abi knows>, so the headers came from a static
// table that ages with the dependency. This builds against the headers of the
// Node that runs it, which is pinned by the build container (see
// scripts/build-prebuild.sh). NAPI_VERSION=6 in binding.gyp is what keeps the
// result ABI-portable either way.
//
// Usage: node scripts/prebuild.mjs [--libc glibc|musl]

import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const { name } = require(join(packageRoot, 'package.json'))

function fail (message) {
  console.error(`prebuild: ${message}`)
  process.exit(1)
}

// shell defaults to false: passing arguments through a shell is unescaped
// concatenation, which Node deprecated in DEP0190. Only a bare "node-gyp.cmd"
// resolved from PATH needs one, and that call site asks for it explicitly.
function run (command, args, { optional = false, shell = false } = {}) {
  const result = spawnSync(command, args, {
    cwd: packageRoot,
    stdio: 'inherit',
    shell,
    windowsHide: true
  })
  if (result.error || result.status !== 0) {
    if (optional) return false
    fail(`${command} ${args.join(' ')} failed${result.error ? `: ${result.error.message}` : ` with status ${result.status}`}`)
  }
  return true
}

// This package's own node-gyp devDependency, pinned to ^13 because 12.0.x
// cannot detect Visual Studio 2026; a bare "node-gyp" on PATH would silently
// pick up whichever version npm bundles, which differs per Node line. Looked up
// by literal path rather than require.resolve so the search cannot walk up into
// a surrounding node_modules and build with someone else's node-gyp.
function nodeGyp () {
  try {
    const local = join(packageRoot, 'node_modules', 'node-gyp', 'package.json')
    const manifest = require(local)
    const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin['node-gyp']
    return { command: process.execPath, args: [join(dirname(local), bin), 'rebuild', '--release'], shell: false }
  } catch {
    // A .cmd needs a shell on Windows, and an args array sent through a shell
    // is what DEP0190 warns about, so the constant invocation goes in the
    // command string instead.
    if (process.platform === 'win32') return { command: 'node-gyp.cmd rebuild --release', args: [], shell: true }
    return { command: 'node-gyp', args: ['rebuild', '--release'], shell: false }
  }
}

// The libc a Linux binary was built against becomes part of its filename, and
// the loader refuses the other one. Unlike the loader, this can afford the
// authoritative check: it runs once per build, not once per require.
function libcTag () {
  if (process.platform !== 'linux') return ''

  // A present --libc always decides the answer, including when its value is
  // missing or wrong. Falling back to autodetection there would answer a
  // question the caller explicitly took out of our hands, and the wrong answer
  // is a mislabelled binary in the release.
  const flag = process.argv.indexOf('--libc')
  if (flag !== -1) {
    const forced = process.argv[flag + 1]
    if (forced !== 'glibc' && forced !== 'musl') fail(`--libc must be glibc or musl, got ${forced === undefined ? 'nothing' : JSON.stringify(forced)}`)
    return `.${forced}`
  }

  let glibc
  try {
    glibc = process.report.getReport().header.glibcVersionRuntime
  } catch (error) {
    fail(`could not determine libc (${error.message}); pass --libc glibc|musl`)
  }
  return glibc ? '.glibc' : '.musl'
}

const gyp = nodeGyp()
run(gyp.command, gyp.args, { shell: gyp.shell })

const releaseDir = join(packageRoot, 'build', 'Release')
let built
try {
  built = readdirSync(releaseDir).filter((entry) => entry.endsWith('.node')).sort()
} catch {
  fail(`node-gyp reported success but ${releaseDir} does not exist`)
}
if (built.length !== 1) {
  fail(`expected exactly one .node in build/Release, found ${built.length ? built.join(', ') : 'none'}`)
}
const source = join(releaseDir, built[0])

// Stripping is what takes the Linux binary from roughly 100KB of debug info to
// 14KB. Windows keeps its symbols in a separate .pdb that is never copied, so
// there is nothing to strip there.
if (process.platform === 'linux' || process.platform === 'darwin') {
  const args = process.platform === 'darwin' ? ['-Sx', source] : ['--strip-all', source]
  if (!run('strip', args, { optional: true })) {
    console.error('prebuild: strip is unavailable, shipping the unstripped binary')
  }
}

const targetDir = join(packageRoot, 'prebuilds', `${process.platform}-${process.arch}`)
const target = join(targetDir, `${name}${libcTag()}.node`)
mkdirSync(targetDir, { recursive: true })
copyFileSync(source, target)

console.log(`prebuild: ${target} (${statSync(target).size} bytes)`)
