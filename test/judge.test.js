import test from 'node:test'
import assert from 'node:assert/strict'
import { judgeTaskLocal, clipTask } from '../index.js'

test('empty text keeps the previous tier', () => {
  assert.equal(judgeTaskLocal('').tier, 'low')
  assert.equal(judgeTaskLocal('').triggered_by, 'empty')
  assert.equal(judgeTaskLocal('   ', 'high').tier, 'high')
})

test('a greeting stays cheap', () => {
  const verdict = judgeTaskLocal('你好')
  assert.equal(verdict.tier, 'low')
  assert.ok(verdict.labels.includes('greeting'))
})

test('resending the same prompt escalates one tier', () => {
  const verdict = judgeTaskLocal('重构这个模块', 'low', '重构这个模块')
  assert.equal(verdict.tier, 'high')
  assert.equal(verdict.triggered_by, 'regenerate')
})

test('a correction escalates the previous tier', () => {
  const verdict = judgeTaskLocal('还是不行，再试一次', 'low', '别的任务')
  assert.equal(verdict.tier, 'high')
  assert.equal(verdict.triggered_by, 'correction')
})

test('an explicit maximum wins over everything else', () => {
  assert.equal(judgeTaskLocal('用最高强度重写这段').tier, 'max')
})

test('broad scope alone is enough to reach high', () => {
  const verdict = judgeTaskLocal('帮我把整个项目做一次端到端的设计文档评审')
  assert.equal(verdict.tier, 'high')
  assert.ok(verdict.labels.includes('broad-scope'))
})

test('english hard words match whole words only', () => {
  assert.ok(!judgeTaskLocal('the prefix and the fixture of this string').labels.includes('hard-topic'))
  assert.ok(judgeTaskLocal('fix this crash in the parser').labels.includes('hard-topic'))
  assert.ok(judgeTaskLocal('fixes the crash').labels.includes('hard-topic'))
})

test('"be brief" caps the tier instead of skipping the content signals', () => {
  const heavy = '重构整个项目的测试与部署流水线，排查并发死锁和内存泄漏。\n```js\nconst x = 1\n```\n'
    + '填充内容。'.repeat(300)
  assert.equal(judgeTaskLocal(heavy).tier, 'max')
  assert.equal(judgeTaskLocal('简短回答。' + heavy).tier, 'high')
  const plain = judgeTaskLocal('简短说一下')
  assert.equal(plain.tier, 'low')
  assert.equal(plain.triggered_by, 'intent_exclude')
})

test('oversized prompts keep head and tail', () => {
  const text = 'A'.repeat(5000) + 'TAIL-MARKER'
  const clipped = clipTask(text)
  assert.ok(clipped.length <= 4000)
  assert.ok(clipped.startsWith('AAAA'))
  assert.ok(clipped.endsWith('TAIL-MARKER'))
  assert.equal(clipTask('short'), 'short')
})
