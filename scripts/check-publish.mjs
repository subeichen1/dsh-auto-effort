/**
 * Guard for `npm publish`: the marketplace links an npm package to its repository through the
 * `repository` field, so publishing with a placeholder (or a private package) would create a
 * package no catalog entry can ever claim. Fail before the tarball leaves the machine.
 */
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const problems = []

if (pkg.private === true) problems.push('package.json still has "private": true')

const repo = pkg.repository !== undefined && pkg.repository !== null ? String(pkg.repository.url ?? '') : ''
if (repo.includes('<') || repo.includes('OWNER')) {
  problems.push(`repository.url still contains a placeholder: ${repo}`)
} else if (!/^git\+https:\/\/github\.com\/[^/]+\/[^/]+\.git$/.test(repo)) {
  problems.push(`repository.url is not a GitHub repository URL: ${repo}`)
}

const homepage = String(pkg.homepage ?? '')
if (homepage.includes('<') || homepage === '') problems.push('homepage is missing or a placeholder')

if (typeof pkg.name !== 'string' || !/^dsh-[a-z0-9-]+$/.test(pkg.name)) {
  problems.push(`unexpected package name: ${String(pkg.name)}`)
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`[publish] ${problem}`)
  console.error('[publish] fix package.json before publishing')
  process.exit(1)
}

console.log(`[publish] ${pkg.name}@${pkg.version} -> ${repo}`)
