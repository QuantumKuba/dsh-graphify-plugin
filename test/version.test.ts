import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getPackageVersion } from '../src/version.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')

describe('Package Version Resolution', () => {
  it('dynamically resolves the version matching package.json', () => {
    const pkgJsonPath = path.join(rootDir, 'package.json')
    const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')) as { version: string }

    const version = getPackageVersion()
    assert.equal(version, pkgJson.version)
    assert.match(version, /^\d+\.\d+\.\d+/)
  })
})
