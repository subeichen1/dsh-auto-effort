import test from 'node:test'
import assert from 'node:assert/strict'
import { chooseEffort, effortMapping } from '../index.js'

test('a tier takes the first effort it declares, in preference order', () => {
  assert.equal(chooseEffort('low', ['xhigh', 'max']), 'xhigh')
  assert.equal(chooseEffort('high', ['low', 'medium', 'high']), 'high')
  assert.equal(chooseEffort('max', ['off', 'low', 'high', 'max']), 'max')
})

test('an unrankable vocabulary falls back to the advertised order', () => {
  // The host calls these ids adapter-owned opaque strings, and the advertised array runs weakest
  // to strongest, so the ends of the array stand in for low and max.
  assert.equal(chooseEffort('low', ['turbo']), 'turbo')
  assert.equal(chooseEffort('max', ['turbo']), 'turbo')
  assert.equal(chooseEffort('low', ['none', 'thinking', 'deep']), 'none')
  assert.equal(chooseEffort('high', ['none', 'thinking', 'deep']), 'thinking')
  assert.equal(chooseEffort('max', ['none', 'thinking', 'deep']), 'deep')
  assert.equal(chooseEffort('low', []), null)
  assert.equal(chooseEffort('low', null), null)
})

test('overrides replace the preference order', () => {
  assert.equal(chooseEffort('high', ['low', 'high'], { high: ['low'] }), 'low')
})

test('without a match the nearest rank wins', () => {
  assert.equal(chooseEffort('max', ['low', 'minimal']), 'low')
})

test('the applied effort is reported against the tier it was chosen for', () => {
  assert.equal(effortMapping('low', 'xhigh'), 'raised')
  assert.equal(effortMapping('max', 'high'), 'capped')
  assert.equal(effortMapping('high', 'high'), 'exact')
  assert.equal(effortMapping('low', 'off'), 'capped')
  assert.equal(effortMapping('low', 'unknown-id'), 'exact')
})
