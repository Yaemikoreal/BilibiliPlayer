// 值班轮 MCP 白名单：新增工具必须能进老用户的「冻结列表」（否则线上模型永远调不到）。
// 2026-10-29 实证：`followPerRound=40` + 每次 UP 一次 bili_user_videos ⇒ 一轮 6 次调用；
// 加了 bili_feed / bili_ledger_append / bili_report_append 之后必须保证它们出现在白名单里。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'bf-duty-tools-'))
process.env.BILI_FENSHEN_HOME = HOME

const { dutyToolList } = await import('../index.js')

test('dutyToolList：默认配置带上发现/记账新工具（老配置没列也要补）', () => {
  const list = dutyToolList({})
  for (const t of ['bili_search', 'bili_video_info', 'bili_followings', 'bili_persona_lore',
    'bili_persona_note', 'bili_feed', 'bili_ledger_append', 'bili_report_append']) {
    assert.ok(list.includes(t), `白名单缺 ${t}`)
  }
  assert.equal(new Set(list).size, list.length, '不能有重复项')
})

test('dutyToolList：冻结列表缺新工具时补齐（线上真实配置形态）', () => {
  const frozen = ['bili_search', 'bili_hot_videos', 'bili_user_videos', 'bili_reply']
  const list = dutyToolList({ dutyTools: frozen, followAuto: true, growthEnable: true })
  assert.deepEqual(list.slice(0, frozen.length), frozen, '用户原有顺序不能被打乱')
  for (const t of ['bili_feed', 'bili_ledger_append', 'bili_report_append', 'bili_followings', 'bili_persona_lore']) {
    assert.ok(list.includes(t), `冻结列表补不上 ${t}`)
  }
})

test('dutyToolList：关掉 followAuto / growth 就不给对应工具，但记账工具始终在', () => {
  const list = dutyToolList({ dutyTools: ['bili_search'], followAuto: false, growthEnable: false })
  assert.equal(list.includes('bili_followings'), false)
  assert.equal(list.includes('bili_persona_note'), false)
  for (const t of ['bili_feed', 'bili_ledger_append', 'bili_report_append', 'bili_persona_lore']) {
    assert.ok(list.includes(t), `基础工具不该被关掉：${t}`)
  }
})
