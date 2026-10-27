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
 * 解析「接话扫描」机器行（设计定稿 §3.3）：
 *   `接话扫描：候选 3 → 接 rpid 321560862800（666设计师）`
 *   `接话扫描：候选 0（热评全在站队，不接）`
 * 返回 { scans:[{bvid,candidates:[],candidateCount,decision,targetRpid,reason}], proactive:[{bvid,parent,text}] }
 * 失败一律返回空数组，绝不抛。
 */
export function parseProactiveScan(text, opts = {}) {
  const round = opts.round ?? null
  const stamp = opts.t || new Date().toISOString()
  const scans = []
  const proactive = []
  if (!text || typeof text !== 'string') return { scans, proactive }
  const pushScan = (bvid, line) => {
    if (!line) return
    const target = (/接\s*rpid\s*(\d+)/.exec(line) || [])[1]
    const candN = (/候选\s*(\d+)/.exec(line) || [])[1]
    const decision = target ? 'posted' : 'skipped'
    scans.push({
      t: stamp,
      round,
      bvid: bvid || '',
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
    const scanLine = (/接话扫描[：:]\s*(.+)/.exec(body) || [])[1]?.trim()
    const actLine = (/动作[：:]\s*(.+)/.exec(body) || [])[1]?.trim() || ''
    const pa = parseProactiveInAction(actLine)
    if (pa) proactive.push({ t: stamp, round, bvid, parent: pa.parent, text: pa.text, rpid: null })
    pushScan(bvid, scanLine)
  }
  // 兜底：模型把扫描写成全局一行（没有挂在 ### BV 下）时也要收，否则证据丢失
  if (!scans.length) {
    const m = /接话扫描[：:]\s*(.+)/.exec(text)
    if (m) pushScan(opts.bvid || '', m[1].trim())
  }
  return { scans, proactive }
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
    const actLine = (/动作[：:]\s*(.+)/.exec(body) || [])[1]?.trim() || ''

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
