/**
 * 报告 → 兜底事件（设计文档 §4.3）。
 * 只在账本缺该事件时使用，事件带 source:'report'，前端标注「据报告回填」。
 * 解析失败一律返回空结果，绝不抛。
 */
const GRADE = { 值得看: 'worth', 可以看: 'ok', 不值当: 'meh' }

const toViews = (s) => {
  const m = /([\d.]+)\s*万/.exec(s)
  if (m) return Math.round(parseFloat(m[1]) * 10000)
  const n = /(\d+)/.exec(s.replace(/,/g, ''))
  return n ? parseInt(n[1], 10) : undefined
}

const toDuration = (s) => {
  const m = /(\d+):(\d{2})/.exec(s)
  return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : undefined
}

/**
 * 「点赞」是否真的发生了。
 *
 * 旧实现只要动作行里出现"点赞"两字就记一条 like —— Agent 写「点赞没做（今日点赞已超日配额）」
 * 时会被回填成一条**幽灵点赞**（2026-10-25 实测：报告 L166 明写没点赞，ledger 仍多出一条 like，
 * 见 docs/analysis/2026-10-25-log-findings.md §4.3）。这里先排除否定说法。
 */
const NEGATED_LIKE = /点赞没做|没点赞|不点赞|未点赞|没再点赞|点赞\s*0|没做点赞/
const didLike = (act) => /点赞|赞过/.test(act) && !NEGATED_LIKE.test(act)

/** 从动作行里取出被引用的一段正文：反引号 / 「」 / 成对双引号 / 单引号，取第一种能对上的。 */
const quotedText = (s) => {
  const pats = [/`([\s\S]*?)`/, /「([\s\S]*?)」/, /“([\s\S]*?)”/, /"([\s\S]*?)"/]
  for (const p of pats) {
    const m = p.exec(s)
    if (m && m[1].trim()) return m[1].trim()
  }
  return ''
}

/**
 * 解析评论动作。Agent 实际写法（2026-10-25 报告原文）：
 *   `评论（rpid 318143807425）：`正文``
 *   `评论（「正文」）`（旧格式，测试夹具用）
 * 都取不到 rpid 时 rpid 记 null —— 章程明禁自己编数字。
 */
const parseCommentAction = (act) => {
  if (!/评论/.test(act)) return null
  if (/评论没发|没评论|不评论|未评论|评论\s*0/.test(act)) return null
  const tail = act.slice(act.indexOf('评论'))
  const rpidRaw = (/rpid\s*[：:]?\s*(\d+)/.exec(tail) || [])[1]
  const text = quotedText(tail)
  if (!text) return null
  return { type: 'comment', text, rpid: rpidRaw ? Number(rpidRaw) : null }
}

/** 解析动态动作：`分享成动态（动态 id 1263081450085810181）：`正文`` / `+ 发动态分享`。 */
const parseDynamicAction = (act) => {
  if (!/动态/.test(act)) return null
  if (/动态没发|没发动态|不发动态|未发动态|动态\s*0/.test(act)) return null
  if (!/分享成动态|发动态|动态分享/.test(act)) return null
  const tail = act.slice(act.indexOf('动态'))
  const id = (/动态\s*id\s*(\d+)/.exec(act) || [])[1]
  return { type: 'dynamic', text: quotedText(tail), ...(id ? { id } : {}) }
}

/**
 * 剥离动作行里的「接话」段（设计定稿 §3.3）。
 * 报告动作行的两种写法：
 *   `动作：点赞 + 评论（rpid 1）：`正文` + 接话（rpid 2）：`接话正文``
 *   `动作：接话（rpid 2）：`接话正文``
 * 旧实现直接 indexOf('评论') 后取第一个 rpid 与第一个引号段 —— 接话写在前面时会把
 * 接话的 rpid/正文当成评论的回填，是随时会咬人的解析地雷。
 */
const cutProactive = (act) => {
  const s = String(act || '')
  const i = s.indexOf('接话')
  if (i < 0) return s
  return s.slice(0, i).replace(/\s*\+\s*$/, '').trim()
}

const NEGATED_PROACTIVE = /接话\s*0|没接话|不接话|未接话|接话没做/

/** 从动作行里取出「接话」段：{ parent, text }（parent = 对方一级评论 rpid） */
const parseProactiveInAction = (act) => {
  const s = String(act || '')
  const i = s.indexOf('接话')
  if (i < 0) return null
  const seg = s.slice(i)
  if (NEGATED_PROACTIVE.test(seg)) return null
  const rpidRaw = (/rpid\s*[：:]?\s*(\d+)/.exec(seg) || [])[1]
  const text = quotedText(seg)
  if (!text) return null
  return { parent: rpidRaw ? Number(rpidRaw) : null, text }
}

/**
 * 取日报里**本轮那一块**（`## … round id <ISO>` 到下一个 `## ` 之前）。
 *
 * 为什么必须切块：2026-10-29 两轮实测，`backfillFromReport` 按**整份日报**解析 ——
 * 第二轮回填时把第一轮的「接话扫描」行又补了一遍（还挂到错的 bvid 上），
 * 一轮扫描在账本里变成 2–4 条：概览「今日扫描」翻倍、活动页挂错视频。
 *
 * 返回 `{ text, found, rounds }`：`found=false` 时 `text` 为空，由调用方决定退回整份还是放弃。
 */
export function roundSection(text, roundId) {
  const t = String(text || '')
  const id = String(roundId || '').trim()
  if (!t || !id) return { text: t, found: false, rounds: 0 }
  const starts = []
  const re = /^## /gm
  let m
  while ((m = re.exec(t)) !== null) starts.push(m.index)
  if (!starts.length) return { text: '', found: false, rounds: 0 }
  const blocks = starts.map((s, i) => t.slice(s, i + 1 < starts.length ? starts[i + 1] : t.length))
  const idOf = (b) => {
    const hit = /round\s*id\s*[:：]?\s*([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z)/i.exec(b)
    return hit ? hit[1] : ''
  }
  const ids = blocks.map(idOf)
  const norm = (s) => String(s || '').replace(/Z$/, '')
  const hit = blocks.findIndex((b, i) => ids[i] && norm(ids[i]) === norm(id))
  if (hit >= 0) return { text: blocks[hit], found: true, rounds: ids.filter(Boolean).length }
  return { text: '', found: false, rounds: ids.filter(Boolean).length }
}

/**
 * 回填去重：模型**已经写过** `reply-scan` 的，不要再补一条。
 *
 * 旧实现的去重键带 `t`（回填时间是「现在」，模型写的是轮内时刻）⇒ 永远不相等，等于没去重。
 * 现在按语义去重：`posted` 认 targetRpid，`skipped` 认 bvid（一行只写一条视频的结论）。
 * ⭐ 2026-10-29：两种键都**全局**去重（不再按 round 过滤）——
 *    ① posted：「同一 target rpid 永不重复接」本来就是全局纪律；
 *    ② skipped：同一视频被上一轮跳过后必然进「已看过清单」，不会再被合法扫描一轮，
 *       重复的 skipped 记录没有任何信息量（01:37 失败轮回填实测漏过 1 条）。
 *    旧实现按 round 过滤时，MCP 补的 round 与宿主 roundId 双源不一致（差 1s+）导致
 *    同轮都对不上，跨轮失败轮还会把旧扫描整套抄一遍（01:37/02:13 实测各多 1 条）。
 */
export function dedupeScans(existing, candidates, roundId = null) {
  void roundId // 保留参数兼容旧调用方；去重已是全局语义
  const key = (e) => (e && e.decision === 'posted'
    ? `posted|${e.targetRpid == null ? '' : e.targetRpid}`
    : `skipped|${(e && e.bvid) || ''}`)
  const seen = new Set()
  for (const e of asArrLite(existing)) {
    if (!e || e.type !== 'reply-scan') continue
    seen.add(key(e))
  }
  const out = []
  for (const c of asArrLite(candidates)) {
    const k = key(c)
    if (seen.has(k)) continue
    seen.add(k)          // 同一批回填里也不要重复
    out.push(c)
  }
  return out
}

const asArrLite = (v) => (Array.isArray(v) ? v : [])

/**
 * 解析「接话扫描」机器行（设计定稿 §3.3）：
 *   `接话扫描：候选 3 → 接 rpid 321560862800（666设计师）`
 *   `接话扫描 BV1xxxx：候选 0（热评全在站队，不接）`   ← 行内带 BV 时以它为准
 * 返回 { scans:[{bvid,candidates:[],candidateCount,decision,targetRpid,reason}], proactive:[{bvid,parent,text}] }
 * 失败一律返回空数组，绝不抛。
 *
 * ⭐ 一个 `### ` 小节里可能出现**多行**接话扫描（2026-10-29 真实报告：两条扫描都写在同一小节末尾）
 *    ⇒ 以前只取第一行，第二条证据直接丢。现在逐行解析，行内有 BV 就按行内定视频，没有再退回小节标题。
 */
export function parseProactiveScan(text, opts = {}) {
  const round = opts.round ?? null
  const stamp = opts.t || new Date().toISOString()
  const scans = []
  const proactive = []
  if (!text || typeof text !== 'string') return { scans, proactive }
  const pushScan = (bvid, line) => {
    if (!line) return
    const inline = (/BV[0-9A-Za-z]+/.exec(line) || [])[0]
    const target = (/接\s*rpid\s*(\d+)/.exec(line) || [])[1]
    const candN = (/候选\s*(\d+)/.exec(line) || [])[1]
    const decision = target ? 'posted' : 'skipped'
    scans.push({
      t: stamp,
      round,
      bvid: inline || bvid || '',
      candidateCount: candN ? Number(candN) : 0,
      candidates: [],
      decision,
      ...(target ? { targetRpid: Number(target) } : {}),
      ...(decision === 'skipped' ? { reason: line } : {}),
      raw: line,
    })
  }
  const parts = text.split(/^### /m)
  for (const raw of parts.slice(1)) {
    const lines = raw.split('\n')
    const bvid = (/^(BV[0-9A-Za-z]+)/.exec((lines[0] || '').trim()) || [])[1]
    if (!bvid) continue
    const body = lines.slice(1).join('\n')
    // ⚠️ 同一小节里所有接话扫描行都要收（不只第一行）
    for (const hit of body.matchAll(/接话扫描\s*[^：:]*[：:]\s*(.+)/g)) pushScan(bvid, hit[1].trim())
    const actLine = actionLinesOf(body)
    const pa = parseProactiveInAction(actLine)
    if (pa) proactive.push({ t: stamp, round, bvid, parent: pa.parent, text: pa.text, rpid: null })
  }
  // 兜底：模型把扫描写成全局一行（没有挂在 ### BV 下）时也要收，否则证据丢失
  if (!scans.length) {
    for (const hit of text.matchAll(/接话扫描\s*[^：:]*[：:]\s*(.+)/g)) pushScan(opts.bvid || '', hit[1].trim())
  }
  return { scans, proactive }
}

/**
 * 一个 `### ` 小节里的**所有**动作行，拼成一条（宿主按它回填账本）。
 *
 * 2026-10-29 真实报告把「点赞没做（超配额）」和「评论（rpid …）」写成了两行 `动作：`，
 * 旧实现只取第一行 ⇒ 那条评论在回填时直接丢失（当时只是碰巧模型自己也记了账本）。
 */
const actionLinesOf = (body) => {
  const out = []
  for (const hit of String(body || '').matchAll(/^[-\s>*]*动作[：:]\s*(.+)$/gm)) out.push(hit[1].trim())
  return out.join(' + ')
}

export function parseRoundReport(text, opts = {}) {
  const round = opts.round ?? null
  const views = []
  const skips = []
  if (!text || typeof text !== 'string') return { views, skips }

  // 只取本轮区块：以 "## " 开头的最后一段（宿主传入的已是本轮新增片段时直接解析）
  const sections = text.split(/^### /m)
  for (const raw of sections.slice(1)) {
    const lines = raw.split('\n')
    const first = (lines[0] || '').trim()
    const bvid = (/^(BV[0-9A-Za-z]+)/.exec(first) || [])[1]
    if (!bvid) continue
    const body = lines.slice(1).join('\n')

    const title = (/标题[：:]\s*(.+)/.exec(body) || [])[1]?.trim()
    const upLine = (/UP[：:]\s*(.+)/.exec(body) || [])[1]?.trim() || ''
    const author = upLine.split('·')[0].trim()
    const gradeRaw = (/\*\*档位\*\*[：:]\s*(\S+)/.exec(body) || [])[1]
    const actLine = actionLinesOf(body)

    const actions = []
    if (didLike(actLine)) actions.push({ type: 'like' })
    // ⭐ 先剥掉接话段再解析评论：接话段自带 rpid 与正文，混在一起会把评论回填成错的那条
    const cmt = parseCommentAction(cutProactive(actLine))
    if (cmt) actions.push(cmt)
    const pa = parseProactiveInAction(actLine)
    if (pa) actions.push({ type: 'reply-out', kind: 'proactive', parent: pa.parent, text: pa.text })
    const dyn = parseDynamicAction(actLine)
    if (dyn) actions.push(dyn)

    views.push({
      bvid,
      title,
      author,
      views: toViews(upLine),
      duration: toDuration(upLine),
      grade: GRADE[gradeRaw] || undefined,
      actions,
    })
  }

  // 跳过记录：从「跳过记录」到该节结束（下一个 "## " 之前）
  const skipIdx = text.search(/跳过记录/)
  if (skipIdx >= 0) {
    const tail = text.slice(skipIdx)
    const stopAt = tail.search(/\n## /)
    const block = stopAt >= 0 ? tail.slice(0, stopAt) : tail
    for (const line of block.split('\n')) {
      const m = /^-\s*(BV[0-9A-Za-z]+)[（(]([^）)]*)[）)]\s*[：:]\s*(.+)$/.exec(line.trim())
      if (!m) continue
      skips.push({ bvid: m[1], title: m[2].trim(), reason: m[3].trim() })
    }
  }

  const stamp = opts.t || new Date().toISOString()
  return {
    views: views.map((v) => ({ ...v, round, t: stamp, source: 'report' })),
    skips: skips.map((s) => ({ ...s, round, t: stamp, source: 'report', type: 'skip' })),
  }
}
