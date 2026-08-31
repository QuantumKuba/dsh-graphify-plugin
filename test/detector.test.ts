import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { detectGraph } from '../src/detector.ts'
import { Config } from '../src/config.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const fixtureDir = path.join(__dirname, 'fixtures', 'sample-project')

describe('detector & config', () => {
  it('validates default config schema', () => {
    const config = Config({})
    assert.equal(config.command, 'graphify')
    assert.deepEqual(config.args, ['serve', '--transport', 'stdio'])
    assert.equal(config.autoDetect, true)
    assert.equal(config.enablePromptSection, true)
    assert.equal(config.timeoutMs, 60000)
    assert.equal(config.serverName, 'graphify')
  })

  it('detects graph in current workspace directory', () => {
    const detected = detectGraph(fixtureDir)
    assert.ok(detected, 'Should detect graph in fixture workspace')
    assert.equal(detected.hasGraph, true)
    assert.ok(detected.graphJsonPath.endsWith('graph.json'))
    assert.ok(detected.graphDir.endsWith('graphify-out'))
    assert.ok(fs.existsSync(detected.graphJsonPath))
  })

  it('detects graph from nested subdirectory', () => {
    const nestedDir = path.join(fixtureDir, 'docs', 'subsystems')
    const detected = detectGraph(nestedDir)
    assert.ok(detected, 'Should detect graph from nested directory')
    assert.equal(detected.hasGraph, true)
    assert.equal(detected.projectRoot, fixtureDir)
  })

  it('returns null when no graph exists in empty directory', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-graphify-test-'))
    try {
      const detected = detectGraph(tempDir)
      assert.equal(detected, null)
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('detects graph via explicit customGraphPath', () => {
    const explicitPath = path.join(fixtureDir, 'graphify-out', 'graph.json')
    const detected = detectGraph(os.tmpdir(), explicitPath)
    assert.ok(detected)
    assert.equal(detected.graphJsonPath, explicitPath)
  })
})

