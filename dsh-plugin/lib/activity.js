/** 事件 → 活动/轮次（设计文档 §5）。纯函数，不碰 IO。 */

export function dayKeyOf(iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function stageOf(events) {
  const types = new Set(events.map((e) => e.type))
  const repliesIn = events.filter((e) => e.type === 'reply-in')
  const replyOuts = events.filter((e) => e.type === 'reply-out')
  // ⭐ 接话（kind=proactive）不是「跟进了别人对我的回复」：两件事分开统计（设计定稿 §3.4）
  const followUps = replyOuts.filter((e) => e.kind !== 'proactive')
  const proactive = replyOuts.filter((e) => e.kind === 'proactive')
  const answered = new Set(replyOuts.map((e) => e.parent))
  const pendingReply = repliesIn.filter((e) => !answered.has(e.rpid)).length
  return {
    viewed: types.has('view') || types.has('skip'),
    liked: types.has('like'),
    commented: types.has('comment'),
    replies: repliesIn.length,
    repliedBack: followUps.length > 0,
    proactive: proactive.length,
    scanned: types.has('reply-scan'),
    dynamic: types.has('dynamic'),
    pendingReply,
  }
}

const convScore = (a) => (a.stage.replies > 0 || a.stage.repliedBack ? 0 : a.stage.liked || a.stage.commented ? 1 : 2)

export function toActivities(events) {
  const byBvid = new Map()
  const skipped = new Map()
  for (const e of events) {
    if (!e || typeof e.bvid !== 'string' || !e.bvid) continue
    // ⚠️ 账本里出现过 bvid:"-" 的跳过行：不能让它生成一张伪视频卡
    if (e.bvid === '-' || e.bvid === '—') continue
    if (!byBvid.has(e.bvid)) byBvid.set(e.bvid, [])
    byBvid.get(e.bvid).push(e)
    if (e.type === 'skip') skipped.set(e.bvid, e)
  }

  const activities = []
  for (const [bvid, evs] of byBvid) {
    const sorted = [...evs].sort((a, b) => String(a.t || '').localeCompare(String(b.t || '')))
    const view = sorted.find((e) => e.type === 'view') || {}
    const stage = stageOf(sorted)
    activities.push({
      bvid,
      title: view.title || skipped.get(bvid)?.title || '',
      author: view.author || '',
      views: view.views,
      duration: view.duration,
      source: view.source,
      grade: view.grade,
      skipped: skipped.has(bvid) ? { reason: skipped.get(bvid).reason } : undefined,
      events: sorted,
      stage,
      flags: {
        fromReport: sorted.some((e) => e.source === 'report'),
      },
    })
  }

  const byRound = new Map()
  for (const a of activities) {
    const roundId = a.events[0]?.round || null
    if (!byRound.has(roundId)) byRound.set(roundId, [])
    byRound.get(roundId).push(a)
  }

  const rounds = [...byRound.entries()].map(([id, items]) => {
    const ordered = [...items].sort((a, b) => convScore(a) - convScore(b) ||
      String(a.events[0]?.t || '').localeCompare(String(b.events[0]?.t || '')))
    return {
      id: id || 'unknown',
      startedAt: ordered[0]?.events[0]?.t || '',
      sourceLabel: sourceLabelOf(ordered),
      items: ordered,
    }
  }).sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))

  return { activities, rounds }
}

function sourceLabelOf(items) {
  const sources = new Set(items.map((a) => a.source).filter(Boolean))
  if (sources.has('hot')) return '热门'
  if (sources.has('search')) return '搜索'
  if (sources.has('follow')) return '订阅'
  return ''
}

export function groupByDay(rounds, dayKeyOfEvent = dayKeyOf) {
  const days = new Map()
  for (const r of rounds) {
    const day = dayKeyOfEvent(r.startedAt) || 'unknown'
    if (!days.has(day)) days.set(day, [])
    days.get(day).push(r)
  }
  return [...days.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([date, rs]) => ({ date, rounds: rs }))
}
