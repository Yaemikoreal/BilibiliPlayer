/**
 * 一次性脚本：重导 whale 编译快照（卡内容有意变更时用；平时别跑）。
 * 与 test/persona.layers.test.js 的取数口径完全一致。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { buildLayers } from '../lib/persona/layers.js'
import { compilePersona } from '../lib/persona/compile.js'
import { deriveState } from '../lib/persona/state.js'

const P = (rel) => fileURLToPath(new URL(rel, import.meta.url))
const card = JSON.parse(readFileSync(P('../prompts/persona/whale.card.json'), 'utf8'))
const snapshot = JSON.parse(readFileSync(P('../test/fixtures/persona/whale.compile.snapshot.json'), 'utf8'))
const state = deriveState({ events: [], card, now: new Date(snapshot.meta.now) })
const layer = buildLayers({ card, state, bank: null, roundId: snapshot.meta.roundId })
const out = compilePersona(card, { state, bank: null, roundId: snapshot.meta.roundId })

const next = {
  meta: { ...snapshot.meta, card: `${card.id}@${card.version}`, updatedAt: new Date().toISOString() },
  c1: layer.c1,
  c2: layer.c2,
  compileText: out.text,
  used: out.used,
  blocks: Object.fromEntries(Object.entries(out.blocks).map(([k, b]) => [k, { len: b.len, max: b.max, over: b.over }])),
  stats: out.stats,
}
writeFileSync(P('../test/fixtures/persona/whale.compile.snapshot.json'), JSON.stringify(next, null, 2) + '\n', 'utf8')
console.log(`已重导快照：${next.meta.card}；compileText ${out.text.length} 字符；块 ${next.stats.per.map((p) => `${p.name} ${p.len}/${p.max}`).join(' / ')}`)
