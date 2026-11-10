/**
 * Single source of truth for this package's version: read at runtime from the
 * nearest ancestor `package.json` whose `name` is this package.
 *
 * The upward walk works from every compiled layout — `dist/`, `dist/src/`
 * under the test build, `dist/mcp/`, and the packed tarball — where a fixed
 * `../package.json` relative path would miss by one level in the test build.
 *
 * @module dsh-log-enhance/version
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_NAME = 'dsh-log-enhance'

function readPackageVersion(): string {
  let directory = dirname(fileURLToPath(import.meta.url))
  for (;;) {
    const manifest = join(directory, 'package.json')
    try {
      const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: unknown; version?: unknown }
      if (parsed.name === PACKAGE_NAME && typeof parsed.version === 'string') return parsed.version
    } catch {
      // Not readable or not JSON — keep walking up.
    }
    const parent = dirname(directory)
    if (parent === directory) throw new Error(`${PACKAGE_NAME}/package.json not found above ${directory}`)
    directory = parent
  }
}

/** This package's version, derived from its own `package.json` rather than a duplicated literal. */
export const PACKAGE_VERSION: string = readPackageVersion()
