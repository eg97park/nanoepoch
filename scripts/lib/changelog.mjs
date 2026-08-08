// Reading one version's section out of CHANGELOG.md, shared by the release gate
// (which refuses to publish a version the changelog does not describe) and the
// release job (which cuts the GitHub release body from it). One implementation,
// so the check and the use cannot disagree about what counts as a section.
//
// Line-oriented on purpose. The first version of this was a regular expression
// built inside a `node -e` inside YAML inside a shell string, where its
// backslashes were consumed twice and it silently matched nothing at all.

// Returns the body of the section headed "## <version>", without the heading,
// or null when there is no such heading.
//
// The heading's version is its first whitespace-separated word, with any
// leading "v" removed -- so "## 0.3.1 - 2026-08-06" and "## v0.3.1" both mean
// 0.3.1, while "## 0.3.10" and "## Unreleased" are neither.
export function section (changelog, wanted) {
  const version = String(wanted).replace(/^v/, '')
  const collected = []
  let found = false
  let inside = false

  for (const line of changelog.split(/\r?\n/)) {
    if (line.startsWith('## ')) {
      if (inside) break
      const heading = line.slice(3).trim().split(/\s+/)[0].replace(/^v/, '')
      inside = heading === version
      found = found || inside
      continue
    }
    if (inside) collected.push(line)
  }

  if (!found) return null

  // Markdown sections are padded with blank lines at both ends; a release body
  // should not begin or end with them.
  while (collected.length > 0 && collected[0].trim() === '') collected.shift()
  while (collected.length > 0 && collected[collected.length - 1].trim() === '') collected.pop()
  return collected.join('\n')
}
