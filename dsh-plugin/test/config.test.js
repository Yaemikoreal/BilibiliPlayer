// dsh-plugin/test/config.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultsOf, readOverride, writeOverride, effectiveConfig, validateFields } from '../lib/config.js'

const dir = () => mkdtempSync(join(tmpdir(), 'bf-cfg-'))

const PATCH = { autoDuty: false, perDay: 5, commentsPerDay: 5, keywords: ['AI'], rejectMe: 'x' }

test('defaultsOf 只取白名单字段', () => {
  const d = defaultsOf(PATCH)
  assert.equal(d.autoDuty, false)
  assert.equal(d.perDay, 5)
  assert.equal('rejectMe' in d, false)
})

test('writeOverride/readOverride 往返一致（缺省返回空对象）', () => {
  const file = join(dir(), 'config.json')
  assert.deepEqual(readOverride(file), {})
  writeOverride(file, { autoDuty: true })
  assert.deepEqual(readOverride(file), { autoDuty: true })
})

test('effectiveConfig 覆盖层优先，并给出每字段来源', () => {
  const file = join(dir(), 'config.json')
  writeOverride(file, { perDay: 9 })
  const { values, sources } = effectiveConfig(PATCH, file)
  assert.equal(values.perDay, 9)
  assert.equal(values.commentsPerDay, 5)
  assert.equal(sources.perDay, 'override')
  assert.equal(sources.commentsPerDay, 'patch')
})

test('validateFields 拒绝未知字段与错误类型', () => {
  assert.equal(validateFields({ nope: 1 }).ok, false)
  assert.equal(validateFields({ perDay: 'five' }).ok, false)
  assert.equal(validateFields({ perDay: 7 }).ok, true)
  assert.equal(validateFields({ autoDuty: true, keywords: ['a'] }).ok, true)
})

test('effectiveConfig 忽略覆盖层里的脏数据', () => {
  const file = join(dir(), 'config.json')
  writeOverride(file, { perDay: 9, bogus: 1 })
  const { values } = effectiveConfig(PATCH, file)
  assert.equal('bogus' in values, false)
})
