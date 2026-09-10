import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Config, validateConfig } from '../src/config.ts'

describe('Configuration Validation', () => {
  it('validates default config successfully', () => {
    const config = Config({})
    assert.doesNotThrow(() => validateConfig(config))
    assert.equal(config.timeoutMs, 60000)
    assert.equal(config.toolMode, 'full')
    assert.equal(config.freshness.mode, 'warn')
    assert.equal(config.freshness.updateTimeoutMs, 120000)
    assert.equal(config.reconnect.enabled, true)
    assert.equal(config.reconnect.initialDelayMs, 500)
    assert.equal(config.reconnect.maxDelayMs, 30000)
    assert.equal(config.reconnect.maxAttempts, 10)
  })

  it('rejects non-positive or invalid timeoutMs', () => {
    const configZero = Config({ timeoutMs: 0 })
    assert.throws(() => validateConfig(configZero), /timeoutMs must be a positive number/)

    const configNegative = Config({ timeoutMs: -100 })
    assert.throws(() => validateConfig(configNegative), /timeoutMs must be a positive number/)

    const configNaN = Config({ timeoutMs: NaN })
    assert.throws(() => validateConfig(configNaN), /timeoutMs must be a positive number/)
  })

  it('rejects invalid toolMode', () => {
    // Force invalid toolMode via unknown cast
    const config = Config({})
    ;(config as { toolMode: unknown }).toolMode = 'medium'
    assert.throws(() => validateConfig(config), /toolMode must be 'compact' or 'full'/)
  })

  it('rejects invalid freshness.mode', () => {
    const config = Config({})
    ;(config.freshness as { mode: unknown }).mode = 'continuous'
    assert.throws(() => validateConfig(config), /freshness\.mode must be 'off', 'warn', or 'auto'/)
  })

  it('rejects non-positive freshness.updateTimeoutMs', () => {
    const configZero = Config({ freshness: { updateTimeoutMs: 0 } })
    assert.throws(() => validateConfig(configZero), /freshness\.updateTimeoutMs must be a positive number/)

    const configNeg = Config({ freshness: { updateTimeoutMs: -500 } })
    assert.throws(() => validateConfig(configNeg), /freshness\.updateTimeoutMs must be a positive number/)
  })

  it('rejects negative reconnect delays', () => {
    const configNegInit = Config({ reconnect: { initialDelayMs: -1 } })
    assert.throws(() => validateConfig(configNegInit), /reconnect\.initialDelayMs must be non-negative/)

    const configNegMax = Config({ reconnect: { maxDelayMs: -10 } })
    assert.throws(() => validateConfig(configNegMax), /reconnect\.maxDelayMs must be non-negative/)
  })

  it('rejects reconnect.maxDelayMs smaller than initialDelayMs', () => {
    const config = Config({
      reconnect: {
        initialDelayMs: 2000,
        maxDelayMs: 1000,
      },
    })
    assert.throws(() => validateConfig(config), /reconnect\.maxDelayMs .* must be >= reconnect\.initialDelayMs/)
  })

  it('rejects invalid reconnect.maxAttempts', () => {
    const configNeg = Config({ reconnect: { maxAttempts: -1 } })
    assert.throws(() => validateConfig(configNeg), /reconnect\.maxAttempts must be a non-negative integer/)

    const configFloat = Config({ reconnect: { maxAttempts: 2.5 } })
    assert.throws(() => validateConfig(configFloat), /reconnect\.maxAttempts must be a non-negative integer/)
  })
})
