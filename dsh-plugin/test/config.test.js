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

test('模型字段进入白名单：defaultsOf 取字符串、拒绝错误类型', () => {
  const d = defaultsOf({
    modelProvider: 'deepseek-account',
    modelName: 'deepseek-flash',
    modelReasoningEffort: 'high',
    modelBogus: 'x',
  })
  assert.equal(d.modelProvider, 'deepseek-account')
  assert.equal(d.modelName, 'deepseek-flash')
  assert.equal(d.modelReasoningEffort, 'high')
  assert.equal('modelBogus' in d, false)
  // 空字符串也是合法默认值（空 = 跟随会话默认模型）
  assert.equal(defaultsOf({ modelProvider: '' }).modelProvider, '')
  // 错误类型按脏数据忽略
  assert.equal('modelProvider' in defaultsOf({ modelProvider: 1 }), false)
  assert.equal('modelName' in defaultsOf({ modelName: null }), false)
})

test('模型字段 validateFields 接受字符串、拒绝非字符串', () => {
  assert.equal(validateFields({
    modelProvider: 'deepseek-account', modelName: 'deepseek-flash', modelReasoningEffort: 'high',
  }).ok, true)
  assert.equal(validateFields({ modelProvider: '' }).ok, true)
  assert.equal(validateFields({ modelProvider: 1 }).ok, false)
  assert.equal(validateFields({ modelName: null }).ok, false)
  assert.equal(validateFields({ modelReasoningEffort: true }).ok, false)
  assert.equal(validateFields({ modelNope: 'x' }).ok, false)
})

test('模型字段覆盖层往返：write/read 一致，脏字段被过滤', () => {
  const file = join(dir(), 'config.json')
  assert.deepEqual(readOverride(file), {})
  writeOverride(file, { modelProvider: 'p', modelName: 'm', modelReasoningEffort: 'high', bogus: 1 })
  assert.deepEqual(readOverride(file), {
    modelProvider: 'p', modelName: 'm', modelReasoningEffort: 'high',
  })
})

test('模型字段 effectiveConfig：patch 默认 + override 优先，来源正确', () => {
  const patchOnly = effectiveConfig({ modelProvider: 'patch-p', modelName: 'patch-m' }, join(dir(), 'config.json'))
  assert.equal(patchOnly.values.modelProvider, 'patch-p')
  assert.equal(patchOnly.values.modelName, 'patch-m')
  assert.equal(patchOnly.sources.modelProvider, 'patch')

  const file = join(dir(), 'config.json')
  writeOverride(file, { modelProvider: 'ov-p', modelName: 'ov-m', modelReasoningEffort: 'high' })
  const merged = effectiveConfig({ modelProvider: 'patch-p', modelName: 'patch-m' }, file)
  assert.equal(merged.values.modelProvider, 'ov-p')
  assert.equal(merged.values.modelName, 'ov-m')
  assert.equal(merged.values.modelReasoningEffort, 'high')
  assert.equal(merged.sources.modelProvider, 'override')
  assert.equal(merged.sources.modelReasoningEffort, 'override')
})

/* ── extractConfigBlock：overlay 里的 provider 段抽取（正则回溯事故的回归测试） ── */

import { extractConfigBlock } from '../lib/config.js'

// 真实的 desktop/cordis.patch.yml 形状：providers 下嵌套 `- id:` 列表项、块尾有空行、随后是下一个条目。
const REAL_PATCH = [
  '- id: agent-default-model',
  '  config:',
  '    provider: deepseek-account',
  '    model: deepseek-flash',
  '',
  '- id: llm-pi-ai',
  '  name: "@deepseek-ai/dsh-llm-pi-ai"',
  '  config:',
  '    providers:',
  '      huoshan:',
  '        apiKeyEnv: HUOSHAN_API_KEY',
  '        api: openai-responses',
  '        baseURL: https://ark.cn-beijing.volces.com/api/coding/v3',
  '        models:',
  '          - id: deepseek-v4-flash-ga-260731',
  '            name: deepseek-v4-flash-ga',
  '            contextWindow: 1000000',
  '          - id: glm-5-3-flash-260828',
  '            name: glm-5-3-flash',
  '            input:',
  '              - text',
  '              - image',
  '',
  '- id: permission',
  '  config:',
  '    presets: {}',
  '',
].join('\n')

test('extractConfigBlock：抽出 llm-pi-ai 的 config 块，含嵌套 - id 列表项，止于下一个条目', () => {
  const block = extractConfigBlock(REAL_PATCH, 'llm-pi-ai')
  assert.ok(block)
  assert.match(block, /^ {4}providers:/)
  assert.match(block, / {6}huoshan:/)
  assert.match(block, / {10}- id: glm-5-3-flash-260828/)
  assert.match(block, / {14}- image/)
  assert.equal(block.includes('- id: permission'), false)
  assert.equal(block.endsWith('\n'), false)
})

test('extractConfigBlock：下一个条目先到 / 无 config / 不存在时返回 null', () => {
  assert.equal(extractConfigBlock('- id: llm-pi-ai\n  name: x\n\n- id: other\n  config:\n    a: 1\n', 'llm-pi-ai'), null)
  assert.equal(extractConfigBlock('- id: llm-pi-ai\n  name: x\n', 'llm-pi-ai'), null)
  assert.equal(extractConfigBlock(REAL_PATCH, 'nope'), null)
  assert.equal(extractConfigBlock('', 'llm-pi-ai'), null)
  assert.equal(extractConfigBlock(null, 'llm-pi-ai'), null)
})

test('extractConfigBlock：真实形状的 patch 上线性完成（旧正则在此灾难性回溯）', () => {
  const long = REAL_PATCH + Array.from({ length: 50 }, (_, i) => `- id: extra-${i}\n  config:\n    n: ${i}\n`).join('\n')
  const t0 = Date.now()
  const block = extractConfigBlock(long, 'llm-pi-ai')
  const ms = Date.now() - t0
  assert.ok(block)
  assert.ok(ms < 100, `抽取耗时 ${ms}ms，疑似回溯`)
})

/* ── pickReasoningEffort：模型不支持显式推理强度时丢弃（2026-10-25 事故回归） ── */

import { pickReasoningEffort } from '../lib/config.js'

test('pickReasoningEffort：支持则保留，不支持则丢弃并回报被忽略值', () => {
  assert.deepEqual(pickReasoningEffort('high', ['off', 'low', 'high']), { effort: 'high', ignored: '' })
  assert.deepEqual(pickReasoningEffort('high', []), { effort: '', ignored: 'high' }) // 模型无推理强度（如 glm-5-3-flash）
  assert.deepEqual(pickReasoningEffort('high', ['off', 'low']), { effort: '', ignored: 'high' })
  assert.deepEqual(pickReasoningEffort('', ['high']), { effort: '', ignored: '' })
  assert.deepEqual(pickReasoningEffort('  ', ['high']), { effort: '', ignored: '' })
  assert.deepEqual(pickReasoningEffort('high', null), { effort: 'high', ignored: '' }) // 查询失败：不猜，保持
  assert.deepEqual(pickReasoningEffort('high', undefined), { effort: 'high', ignored: '' })
})

/* ── 内容源 / 禁令 / 动态形式：新增字段的白名单与覆盖层 ── */

test('内容源与禁令字段：defaultsOf / validateFields 类型正确', () => {
  const patch = {
    followAuto: true, followPerRound: 8,
    avoidList: ['BV1xx', '某UP', '标题词'],
    banPrivacy: false, banImpersonation: true, banControversy: false,
    banRepeat: false, banReplyRefusal: true, dynamicPureText: false,
  }
  assert.deepEqual(defaultsOf(patch), patch)
  assert.equal(validateFields(patch).ok, true)
  assert.equal(validateFields({ avoidList: 'BV1xx' }).ok, false)
  assert.equal(validateFields({ followAuto: 'yes' }).ok, false)
  assert.equal(validateFields({ followPerRound: '8' }).ok, false)
  assert.equal(validateFields({ banPrivacy: 'yes' }).ok, false)
  assert.equal(validateFields({ dynamicPureText: 1 }).ok, false)
})

test('禁令字段覆盖层：false 能存住（不被默认 true 吞掉）', () => {
  const file = join(dir(), 'config.json')
  writeOverride(file, { banPrivacy: false, dynamicPureText: false, avoidList: ['BV1'] })
  assert.deepEqual(readOverride(file), { banPrivacy: false, dynamicPureText: false, avoidList: ['BV1'] })
  const { values, sources } = effectiveConfig({ banPrivacy: true, dynamicPureText: true, avoidList: [] }, file)
  assert.equal(values.banPrivacy, false)
  assert.equal(values.dynamicPureText, false)
  assert.deepEqual(values.avoidList, ['BV1'])
  assert.equal(sources.banPrivacy, 'override')
})
