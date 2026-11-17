import test from 'node:test'
import assert from 'node:assert/strict'
import { buildEffortLadder, chooseEffortForScore, chooseEffort, effortMapping } from '../index.js'

const ids = (efforts) => buildEffortLadder(efforts.map((id) => ({ id }))).map((entry) => entry.id)

test('the ladder follows the model declaration, weakest to strongest', () => {
  assert.deepEqual(ids(['max', 'xhigh']), ['xhigh', 'max'])
  assert.deepEqual(ids(['low', 'high', 'xhigh', 'max']), ['low', 'high', 'xhigh', 'max'])
  assert.deepEqual(ids(['off', 'low', 'high']), ['low', 'high'])
  assert.deepEqual(ids(['high']), ['high'])
  assert.deepEqual(ids([]), [])
})

test('off is excluded from the work ladder unless explicitly allowed', () => {
  assert.deepEqual(ids(['off', 'low', 'high']), ['low', 'high'])
  assert.deepEqual(
    buildEffortLadder([{ id: 'off' }, { id: 'low' }], { includeOff: true }).map((entry) => entry.id),
    ['off', 'low'],
  )
})

test('two levels split at the midpoint', () => {
  const efforts = [{ id: 'xhigh' }, { id: 'max' }]
  assert.equal(chooseEffortForScore(0, efforts).effort, 'xhigh')
  assert.equal(chooseEffortForScore(49, efforts).effort, 'xhigh')
  assert.equal(chooseEffortForScore(50, efforts).effort, 'max')
  assert.equal(chooseEffortForScore(100, efforts).effort, 'max')
})

test('three levels split into thirds', () => {
  const efforts = [{ id: 'low' }, { id: 'high' }, { id: 'max' }]
  assert.equal(chooseEffortForScore(33, efforts).effort, 'low')
  assert.equal(chooseEffortForScore(34, efforts).effort, 'high')
  assert.equal(chooseEffortForScore(66, efforts).effort, 'high')
  assert.equal(chooseEffortForScore(67, efforts).effort, 'max')
})

test('four levels use every rung', () => {
  const efforts = [{ id: 'low' }, { id: 'high' }, { id: 'xhigh' }, { id: 'max' }]
  assert.equal(chooseEffortForScore(24, efforts).effort, 'low')
  assert.equal(chooseEffortForScore(25, efforts).effort, 'high')
  assert.equal(chooseEffortForScore(49, efforts).effort, 'high')
  assert.equal(chooseEffortForScore(50, efforts).effort, 'xhigh')
  assert.equal(chooseEffortForScore(74, efforts).effort, 'xhigh')
  assert.equal(chooseEffortForScore(75, efforts).effort, 'max')
})

test('one level is always the only choice; no level returns null', () => {
  assert.equal(chooseEffortForScore(0, [{ id: 'high' }]).effort, 'high')
  assert.equal(chooseEffortForScore(100, [{ id: 'high' }]).effort, 'high')
  assert.equal(chooseEffortForScore(50, []), null)
  assert.equal(chooseEffortForScore(50, [{ id: 'off' }]), null)
})

test('the legacy tier selector still works for old callers', () => {
  assert.equal(chooseEffort('low', ['xhigh', 'max']), 'xhigh')
  assert.equal(chooseEffort('max', ['low', 'high', 'max']), 'max')
  assert.equal(chooseEffort('low', []), null)
})

test('effortMapping reports whether the legacy tier was raised or capped', () => {
  assert.equal(effortMapping('low', 'xhigh'), 'raised')
  assert.equal(effortMapping('max', 'high'), 'capped')
  assert.equal(effortMapping('high', 'high'), 'exact')
})
