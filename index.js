'use strict'

const fs = require('fs')
const path = require('path')

// Kept as structured entries rather than display strings so the support check
// is an exact match. Comparing prefixes would tell a linux-arm (32-bit) user
// that linux-arm64 covers them.
const PREBUILD_TARGETS = [
  { target: 'win32-x64', libc: '' },
  { target: 'win32-arm64', libc: '' },
  { target: 'linux-x64', libc: ' (glibc and musl)' },
  { target: 'linux-arm64', libc: ' (glibc and musl)' }
]

function detectLibc () {
  if (process.platform !== 'linux') return null
  if (process.env.LIBC) return process.env.LIBC + ' (forced by the LIBC environment variable)'
  try {
    const report = process.report.getReport()
    if (report && report.header && report.header.glibcVersionRuntime) {
      return 'glibc ' + report.header.glibcVersionRuntime
    }
  } catch {
    return 'unknown'
  }
  return 'musl (no glibc runtime reported)'
}

// Lists what is actually on disk, filenames included, because the tags in those
// names (".glibc", ".musl") are what a libc mismatch turns on. Reporting only
// the directory would show "linux-x64" to someone whose real problem is that
// they have the glibc build and need the musl one.
function listBundledPrebuilds () {
  const root = path.join(__dirname, 'prebuilds')
  const found = []
  let directories
  try {
    directories = fs.readdirSync(root).sort()
  } catch {
    return found
  }
  for (const directory of directories) {
    let binaries = []
    try {
      binaries = fs.readdirSync(path.join(root, directory)).filter((f) => f.endsWith('.node')).sort()
    } catch {
      // fall through and report the directory alone
    }
    if (binaries.length === 0) found.push(directory + '/ (no .node file)')
    else for (const binary of binaries) found.push(directory + '/' + binary)
  }
  return found
}

function packageVersion () {
  try {
    return require('./package.json').version
  } catch {
    return 'unknown'
  }
}

// This message is part of the package's contract: an install that cannot read
// the OS clock must say exactly why and how to fix it, because the alternative
// this package refuses to offer -- a JavaScript fallback -- would keep working
// while silently returning timestamps that ignore every clock adjustment.
function loadErrorMessage (cause) {
  const libc = detectLibc()
  const target = process.platform + '-' + process.arch
  const bundled = listBundledPrebuilds()
  const supported = PREBUILD_TARGETS.some((entry) => entry.target === target)

  // node-gyp-build reports "No native build was found" when nothing matched.
  // Any other error means a binary was selected and then failed to load -- a
  // missing shared library, a corrupt file, an incompatible runtime -- which is
  // a different problem with a different fix.
  const nothingMatched = /No native build was found/i.test(cause && cause.message ? cause.message : '')

  let verdict
  if (!nothingMatched) {
    verdict = 'a binary was found and selected, but loading it failed; this is not a packaging problem -- see the loader error at the end'
  } else if (!supported) {
    verdict = 'your platform is NOT in the prebuilt matrix; it needs a source build'
  } else if (bundled.length === 0) {
    verdict = 'your platform IS in the prebuilt matrix but this install contains no binaries at all'
  } else if (bundled.some((entry) => entry.startsWith(target + '/'))) {
    verdict = 'a binary for ' + target + ' is present but no variant matched -- compare the libc tag above with the filenames'
  } else {
    verdict = 'your platform IS in the prebuilt matrix, but no ' + target + ' binary reached this install'
  }

  const lines = [
    'nanoepoch@' + packageVersion() + ': failed to load the native addon, and there is no JavaScript fallback.',
    '',
    '  detected : ' + target + (libc ? ' (' + libc + ')' : ''),
    '             node ' + process.versions.node + ', Node-API ' + process.versions.napi,
    '  prebuilt : ' + PREBUILD_TARGETS.map((entry) => entry.target + entry.libc).join(', '),
    '  bundled  : ' + (bundled.length ? bundled.join(', ') : '(none found in this install -- the package directory looks incomplete)'),
    '  verdict  : ' + verdict,
    '',
    'Why there is no fallback: every nanoepoch call must read the OS realtime clock',
    'directly. A JavaScript fallback could only anchor a start time and add elapsed',
    'intervals, which silently ignores NTP steps and manual clock changes -- exactly',
    'the failure mode this package exists to prevent. Failing loudly is the feature.',
    '',
    'How to fix it:',
    '  1. Reinstall so the bundled binaries are restored:',
    '       npm install nanoepoch --force',
    '  2. On Linux, if the libc above looks wrong, override the detection:',
    '       LIBC=glibc  (or)  LIBC=musl',
    '  3. Build from source (needs a C toolchain):',
    '       Debian/Ubuntu : apt-get install -y build-essential python3',
    '       Alpine        : apk add build-base python3',
    '       Windows       : Visual Studio Build Tools, "Desktop development with C++"',
    '                       (Visual Studio 2026 also requires node-gyp >= 12.1)',
    '     then: npm rebuild nanoepoch',
    '  4. Still stuck? Report it with the block above:',
    '       https://github.com/eg97park/nanoepoch/issues/new',
    '',
    'Underlying loader error: ' + (cause && cause.message ? cause.message : String(cause))
  ]

  return lines.join('\n')
}

let binding
try {
  binding = require('node-gyp-build')(__dirname)
} catch (cause) {
  // The addon itself throws with an ERR_NANOEPOCH_ code when it loaded fine but
  // the platform clock is unusable. Wrapping that in the "no binary for your
  // platform" story would send the reader hunting for a libc mismatch that does
  // not exist, so let it through untouched.
  if (cause && typeof cause.code === 'string' && cause.code.startsWith('ERR_NANOEPOCH_')) {
    throw cause
  }

  // Building the diagnostic must never cost the diagnosis. If anything in the
  // environment probing above misbehaves, fall back to a plain message and keep
  // the original loader error attached as the cause.
  let message
  try {
    message = loadErrorMessage(cause)
  } catch {
    message = 'nanoepoch: failed to load the native addon, and there is no JavaScript fallback. ' +
      'See https://github.com/eg97park/nanoepoch#there-is-no-javascript-fallback'
  }
  const error = new Error(message, { cause })
  error.code = 'ERR_NANOEPOCH_LOAD_FAILED'
  throw error
}

// The native functions are re-exported unwrapped: every one of them already
// reads the clock and validates its own arguments, so a JavaScript wrapper
// would only add a call frame.
//
// now() returns a BigInt created on the native side. The alternative -- have
// the addon write into a shared BigUint64Array and read the slot back in JS,
// the way process.hrtime.bigint() does -- measured about 1.9x SLOWER here
// (bench/compare.mjs), because that path has to locate and bounds-check a typed
// array on every call while hrtime's internal buffer needs no argument parsing
// at all. Creating the BigInt across the Node-API boundary is the cheaper half.
module.exports = {
  now: binding.now,
  nowMicros: binding.nowMicros,
  nowInto: binding.nowInto
}

// Unstable test hook for the pure FILETIME conversion. Deliberately
// non-enumerable and absent from the TypeScript definitions: it is not public
// API and may be removed in any release.
Object.defineProperty(module.exports, '_filetimeToNs', {
  value: binding._filetimeToNs,
  enumerable: false,
  configurable: true
})
