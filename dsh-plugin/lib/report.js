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
    if (/点赞|赞过/.test(actLine)) actions.push({ type: 'like' })
    const cmt = /评论（「([\s\S]*?)」）/.exec(actLine)
    if (cmt) actions.push({ type: 'comment', text: cmt[1].trim(), rpid: null })
    const dyn = /动态(?:分享|（「([\s\S]*?)」）)?/.exec(actLine)
    if (dyn && /发动态|动态分享/.test(actLine)) {
      actions.push({ type: 'dynamic', text: (dyn[1] || '').trim() })
    }

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
