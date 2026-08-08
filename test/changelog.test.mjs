// The release body is cut from CHANGELOG.md, and the release gate refuses to
// publish a version the changelog does not describe. Both go through section(),
// so a bug here either publishes an empty release note or blocks a release that
// should go out.
//
// This got its own module and its own test after the first attempt -- a regular
// expression assembled inside a `node -e` inside YAML inside a shell string --
// had its backslashes eaten twice and matched nothing at all, silently.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { section } from '../scripts/lib/changelog.mjs'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

const SAMPLE = [
  '# Changelog',
  '',
  '## Unreleased',
  '',
  '- something in flight',
  '',
  '## 0.3.10 — 2026-09-01',
  '',
  '- the ten',
  '',
  '## v0.3.1 — 2026-08-06',
  '',
  '### Fixed',
  '',
  '- the one',
  '',
  '## 0.3.0 — 2026-08-06',
  '',
  '- the zero',
  ''
].join('\n')

test('a version section is returned without its heading or padding', () => {
  assert.equal(section(SAMPLE, '0.3.1'), '### Fixed\n\n- the one')
})

test('the leading v is optional on both sides', () => {
  assert.equal(section(SAMPLE, 'v0.3.1'), section(SAMPLE, '0.3.1'))
  assert.equal(section(SAMPLE, '0.3.0'), '- the zero')
})

test('0.3.1 does not match the 0.3.10 heading', () => {
  // Prefix matching would cut the wrong section, and the release note would
  // describe a version nobody published.
  assert.equal(section(SAMPLE, '0.3.10'), '- the ten')
  assert.notEqual(section(SAMPLE, '0.3.1'), section(SAMPLE, '0.3.10'))
})

test('a section stops at the next heading', () => {
  assert.doesNotMatch(section(SAMPLE, '0.3.1'), /the zero/)
})

test('an absent version is null rather than an empty string', () => {
  // The gate distinguishes them: null means "no section", while a real but
  // empty section is a different mistake and should not be reported as this one.
  assert.equal(section(SAMPLE, '9.9.9'), null)
  assert.equal(section('# Changelog\n', '0.3.1'), null)
})

test('a section with no body is an empty string, not null', () => {
  assert.equal(section('## 1.0.0\n\n## 0.9.0\n\n- old\n', '1.0.0'), '')
})

test('the current version has a section in the real changelog', () => {
  // The same thing the release gate asserts, run on every pull request rather
  // than only on a tag -- so the changelog entry is written while the change is
  // being made, not remembered at release time.
  const version = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).version
  const changelog = readFileSync(join(packageRoot, 'CHANGELOG.md'), 'utf8')
  assert.notEqual(section(changelog, version), null,
    `CHANGELOG.md has no "## ${version}" section, so the release notes would be empty`)
})
