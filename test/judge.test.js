import test from 'node:test'
import assert from 'node:assert/strict'
import { judgeTaskLocal, scoreTask, clipTask } from '../index.js'

test('empty text keeps the previous score', () => {
  assert.equal(scoreTask('').score, 0)
  assert.equal(scoreTask('').triggered_by, 'empty')
  assert.equal(scoreTask('   ', 55).score, 55)
})

test('a greeting stays at the bottom of the scale', () => {
  const verdict = scoreTask('你好')
  assert.equal(verdict.score, 0)
  assert.ok(verdict.labels.includes('greeting'))
})

test('resending the same prompt escalates one step', () => {
  const verdict = scoreTask('重构这个模块', 15, '重构这个模块')
  assert.equal(verdict.score, 30)
  assert.equal(verdict.triggered_by, 'regenerate')
})

test('a correction adds to the previous score', () => {
  const verdict = scoreTask('还是不行，再试一次', 15, '别的任务')
  assert.equal(verdict.score, 25)
  assert.equal(verdict.triggered_by, 'correction')
})

test('an explicit maximum wins over everything else', () => {
  assert.equal(scoreTask('用最高强度重写这段').score, 100)
})

test('broad scope pushes the score up and labels the task', () => {
  const verdict = scoreTask('帮我把整个项目做一次端到端的设计文档评审')
  assert.ok(verdict.score >= 30)
  assert.ok(verdict.labels.includes('broad-scope'))
})

test('english hard words match whole words only', () => {
  assert.ok(!scoreTask('the prefix and the fixture of this string').labels.includes('hard-topic'))
  assert.ok(scoreTask('fix this crash in the parser').labels.includes('hard-topic'))
  assert.ok(scoreTask('fixes the crash').labels.includes('hard-topic'))
})

test('"be brief" caps the score instead of skipping the content signals', () => {
  const heavy = '重构整个项目的测试与部署流水线，排查并发死锁和内存泄漏。\n```js\nconst x = 1\n```\n'
    + '填充内容。'.repeat(300)
  assert.ok(scoreTask(heavy).score >= 45)
  assert.equal(scoreTask('简短回答。' + heavy).score, 20)
  const plain = scoreTask('简短说一下')
  assert.equal(plain.score, 0)
  assert.equal(plain.triggered_by, 'intent_exclude')
})

test('the legacy tier wrapper still derives a tier from the score', () => {
  assert.equal(judgeTaskLocal('你好').tier, 'low')
  assert.equal(judgeTaskLocal('用最高强度重写这段').tier, 'max')
})

test('oversized prompts keep head and tail', () => {
  const text = 'A'.repeat(5000) + 'TAIL-MARKER'
  const clipped = clipTask(text)
  assert.ok(clipped.length <= 4000)
  assert.ok(clipped.startsWith('AAAA'))
  assert.ok(clipped.endsWith('TAIL-MARKER'))
  assert.equal(clipTask('short'), 'short')
})
