/**
 * 人设注入归因（W2-1）。
 *
 * 问题：`personaTag` 过去只在内存里返回，唯一落点是会被删掉的 `pending-usage.json` ——
 * 于是「这轮吃了哪版人设 / 有没有超预算 / 砍了谁」在账本、报告、概览里全查不到。
 * 这里把一次注入编译成**账本事件**（append 成本 0），后续三处消费：
 *   ① 报告头一行（宿主拼进「本轮参数」，模型照抄）；
 *   ② 概览 `round.lastRound.personaTag`（控制台页头）；
 *   ③ 人设页「本轮实际注入」（五块进度条 + 命中见闻 + 降级徽标）。
 *
 * 纯函数、可单测：不读盘、不看时间（`t` 由调用方给）。
 */

/** 账本事件类型（别写成裸字符串，W5 的页面与测试都靠它对齐）。 */
export const PERSONA_EVENT = 'persona-inject'

const asArr = (v) => (Array.isArray(v) ? v : [])

/** 把 `compilePersona().stats.per` 归一成 [{name, chars, max}]（缺 max 时回落 0）。 */
export const layersFromStats = (stats, extra = {}) =>
  asArr(stats?.per).map((p) => ({
    name: String(p?.name || ''),
    chars: Number(p?.len) || 0,
    max: Number(p?.max) || 0,
    ...extra,
  }))

/** 命中清单：本轮真的摆到台面上的见闻 / canon / 语料（冷却闭环保留它们的唯一可查形态）。 */
export const hitsFromUsed = (used) => {
  const u = used || {}
  return [
    ...asArr(u.loreIds).map((id) => ({ kind: 'lore', id: String(id) })),
    ...asArr(u.canonKeys).map((id) => ({ kind: 'canon', id: String(id) })),
    ...asArr(u.expressionIds).map((id) => ({ kind: 'expression', id: String(id) })),
  ]
}

/**
 * 构造 `persona-inject` 账本事件。
 * @param {object} o
 * @param {string} o.round 本轮 round id
 * @param {string} [o.t] ISO 时间（缺省取 now，测试可注入）
 * @param {object} o.personaRes `resolvePersona()` 的返回值
 * @param {{level?:string, len?:number, softMax?:number, hardMax?:number}} [o.guard] buildDutyPrompt 的守卫结果
 * @param {string[]} [o.degraded] 实际生效的降级动作（如 ['lore:drop']）
 * @param {string[]} [o.notes] 额外说明
 * @returns {object|null} 不是卡链路（legacy/missing）时返回 null —— 账本只记卡链路的注入
 */
export const buildPersonaInjectEvent = (o = {}) => {
  const p = o.personaRes || {}
  if (p.mode !== 'card') return null
  const stats = p.stats || {}
  return {
    t: String(o.t || new Date().toISOString()),
    round: String(o.round || ''),
    type: PERSONA_EVENT,
    personaTag: String(p.personaTag || ''),
    mode: String(p.mode),
    // 通道：现在只有编译期两段（C1 章程前段 / C2 末尾）；C3 每步通道落地后这里会多一个值
    channel: 'c1',
    layers: layersFromStats(stats),
    total: Number(stats.total) || 0,
    totalMax: Number(stats.totalMax) || 0,
    hits: hitsFromUsed(p.used || {}),
    // W7-3：本轮体检结论 + 自纠动作（"这轮为什么被要求收短"要能查）
    checkup: p.checkup ? {
      level: String(p.checkup.level || 'ok'),
      n: Number(p.checkup.n) || 0,
      reasons: asArr(p.checkup.reasons).map(String),
      selfCorrect: String(p.checkup.selfCorrect || ''),
    } : null,
    // W7-1：本轮记忆注入了哪几条（"为什么这轮提了旧事"要能查；null = 这版还没有记忆字段）
    memory: p.memory ? {
      injected: asArr(p.memory.injected).map((m) => ({ id: String(m.id || ''), title: String(m.title || ''), importance: Number(m.importance) || 0, decayed: Number(m.decayed) || 0 })),
      pool: Number(p.memory.pool) || 0,
      relevant: Number(p.memory.relevant) || 0,
      fallbackToRecent: p.memory.fallbackToRecent === true,
    } : null,
    degraded: asArr(o.degraded).map(String),
    guard: o.guard
      ? {
          level: String(o.guard.level || 'ok'),
          len: Number(o.guard.len) || 0,
          softMax: Number(o.guard.softMax) || 0,
          hardMax: Number(o.guard.hardMax) || 0,
        }
      : null,
    notes: [...asArr(p.notes), ...asArr(o.notes)].map(String),
  }
}

/** 给定轮次找它的注入记录（同轮多条取最新一条）。 */
export const personaInjectOf = (events, roundId) => {
  if (!roundId) return null
  let found = null
  for (const e of asArr(events)) {
    if (!e || e.type !== PERSONA_EVENT || e.round !== roundId) continue
    if (!found || String(e.t || '') >= String(found.t || '')) found = e
  }
  return found
}

/** 最近的注入记录（不指定轮次时用于概览页头）。 */
export const lastPersonaInject = (events) => {
  let found = null
  for (const e of asArr(events)) {
    if (!e || e.type !== PERSONA_EVENT) continue
    if (!found || String(e.t || '') >= String(found.t || '')) found = e
  }
  return found
}

/** 报告头那一行：`人设：whale@2.0.0（core 1010 / lore 195 / … · 合计 1551；降级：无）`。 */
export const describePersonaInject = (ev) => {
  if (!ev) return ''
  const name = ev.personaTag || '未知'
  const parts = asArr(ev.layers).map((l) => `${l.name} ${l.chars}`)
  const degraded = asArr(ev.degraded)
  return `人设：${name}（${parts.join(' / ')} · 合计 ${ev.total}`
    + `${ev.totalMax ? ` / ${ev.totalMax}` : ''}；${degraded.length ? `降级：${degraded.join('、')}` : '降级：无'}）`
}
