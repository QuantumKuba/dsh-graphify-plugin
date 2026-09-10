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
    assert.equal(config.command, 'auto')
    assert.deepEqual(config.args, [])
    assert.deepEqual(config.cliArgs, [])
    assert.equal(config.autoDetect, true)
    assert.equal(config.enablePromptSection, true)
    assert.equal(config.timeoutMs, 60000)
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

  it('uses Graphify’s graphify-out root marker when present', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-graphify-marker-'))
    const outputDir = path.join(tempDir, 'graphify-out')
    fs.mkdirSync(outputDir)
    fs.writeFileSync(path.join(outputDir, 'graph.json'), '{}')
    fs.writeFileSync(path.join(outputDir, '.graphify_root'), fixtureDir)
    try {
      assert.equal(detectGraph(tempDir)?.projectRoot, fixtureDir)
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('resolves project root correctly when relative custom graph escapes searchDir to parent canonical graphify-out', () => {
    const tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-escape-root-'))
    const srcDir = path.join(tempRepo, 'src')
    const graphDir = path.join(tempRepo, 'graphify-out')
    fs.mkdirSync(srcDir, { recursive: true })
    fs.mkdirSync(graphDir, { recursive: true })
    const graphJson = path.join(graphDir, 'graph.json')
    fs.writeFileSync(graphJson, '{}')

    try {
      // searchDir is /tempRepo/src, relative graphPath is ../graphify-out/graph.json
      const detected = detectGraph(srcDir, '../graphify-out/graph.json')
      assert.ok(detected)
      assert.equal(detected.projectRoot, tempRepo, 'Should resolve /tempRepo, not /tempRepo/src')
      assert.equal(detected.graphJsonPath, graphJson)
    } finally {
      fs.rmSync(tempRepo, { recursive: true, force: true })
    }
  })

  it('resolves project root correctly for relative custom graph inside searchDir', () => {
    const tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-inside-root-'))
    const subDir = path.join(tempRepo, 'sub')
    fs.mkdirSync(subDir, { recursive: true })
    const graphJson = path.join(subDir, 'graph.json')
    fs.writeFileSync(graphJson, '{}')

    try {
      const detected = detectGraph(tempRepo, 'sub/graph.json')
      assert.ok(detected)
      assert.equal(detected.projectRoot, tempRepo)
      assert.equal(detected.graphJsonPath, graphJson)
    } finally {
      fs.rmSync(tempRepo, { recursive: true, force: true })
    }
  })

  it('resolves project root for absolute graph inside searchDir and absolute graph outside searchDir', () => {
    const tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-abs-root-'))
    const srcDir = path.join(tempRepo, 'src')
    const graphDir = path.join(tempRepo, 'graphify-out')
    fs.mkdirSync(srcDir, { recursive: true })
    fs.mkdirSync(graphDir, { recursive: true })
    const graphJson = path.join(graphDir, 'graph.json')
    fs.writeFileSync(graphJson, '{}')

    try {
      // 1. Absolute graph inside tempRepo when searchDir is tempRepo
      const inside = detectGraph(tempRepo, graphJson)
      assert.ok(inside)
      assert.equal(inside.projectRoot, tempRepo)

      // 2. Absolute graph outside searchDir when searchDir is srcDir
      const outside = detectGraph(srcDir, graphJson)
      assert.ok(outside)
      assert.equal(outside.projectRoot, tempRepo, 'Canonical graphify-out inference resolves parent tempRepo')
    } finally {
      fs.rmSync(tempRepo, { recursive: true, force: true })
    }
  })

  it('prioritizes valid .graphify_root marker over canonical inference and falls back when marker is invalid', () => {
    const tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-marker-prec-'))
    const intendedTarget = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-marker-intended-'))
    const graphDir = path.join(tempRepo, 'graphify-out')
    fs.mkdirSync(graphDir, { recursive: true })
    const graphJson = path.join(graphDir, 'graph.json')
    fs.writeFileSync(graphJson, '{}')

    // Valid marker pointing to intendedTarget
    const markerPath = path.join(graphDir, '.graphify_root')
    fs.writeFileSync(markerPath, intendedTarget)

    try {
      const detected = detectGraph(tempRepo)
      assert.ok(detected)
      assert.equal(detected.projectRoot, intendedTarget, 'Valid .graphify_root marker must win')

      // Invalid marker pointing to non-existent directory -> falls back to canonical inference
      fs.writeFileSync(markerPath, '/non/existent/directory/path/12345')
      const fallbackDetected = detectGraph(tempRepo)
      assert.ok(fallbackDetected)
      assert.equal(fallbackDetected.projectRoot, tempRepo, 'Must fall back to canonical tempRepo when marker path does not exist')
    } finally {
      fs.rmSync(tempRepo, { recursive: true, force: true })
      fs.rmSync(intendedTarget, { recursive: true, force: true })
    }
  })
})
