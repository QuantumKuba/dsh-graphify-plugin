import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

let cachedVersion: string | undefined

/**
 * Returns the package version of dsh-graphify.
 * Resolves package.json dynamically so client reporting never goes stale.
 */
export function getPackageVersion(): string {
  if (cachedVersion) return cachedVersion

  try {
    const currentDir = path.dirname(fileURLToPath(import.meta.url))
    const candidates = [
      path.resolve(currentDir, '..', 'package.json'),
      path.resolve(currentDir, 'package.json'),
    ]
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        const content = fs.readFileSync(candidate, 'utf8')
        const parsed = JSON.parse(content) as { version?: string }
        if (parsed.version) {
          cachedVersion = parsed.version
          return cachedVersion
        }
      }
    }
  } catch {
    // Fall back to default version if filesystem read fails
  }

  cachedVersion = '0.2.0'
  return cachedVersion
}
