import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

describe('DSH client manifest', () => {
  it('exposes the metadata and browser artifact required by client discovery', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8')) as {
      exports: Record<string, unknown>
      dsh?: { client?: { platform?: string } }
    }

    assert.equal(manifest.exports['./package.json'], './package.json')
    assert.deepEqual(manifest.exports['./client'], {
      types: './lib/types/web-client.d.ts',
      default: './lib/graphify-client.js',
    })
    assert.equal(manifest.dsh?.client?.platform, 'web')
    assert.match(
      fs.readFileSync(path.join(repositoryRoot, 'lib/graphify-client.js'), 'utf8'),
      /window\.__ModuleLoader__\.load\(\{\s*id: "dsh-graphify"/,
    )
  })
})
