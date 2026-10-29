/**
 * 体检自纠（W7-3）：把 `buildCheckup` 的偏离判据翻译成**一条能照做的话**，塞进下一轮 C2。
 *
 * 为什么需要这一层：`checkup` 给的是数字（「中位字数 45，基线 27，+67%」），
 * 直接塞进 prompt 等于让模型自己做数学——它不会，而且会把"45"当成风格参考。
 * 这里把数字翻成动作（"话变长了，这次收短"），并且**一次只说一件事**：
 * 尾注/状态段是竞争性资源，堆三条提醒等于没提醒。
 *
 * 纪律：
 *   - 只在 `level !== 'ok'` 时产出；ok/数据不足 一律返回空串（不给模型多余指令）；
 *   - 只取**第一个**（最严重的）偏离，最多 1 行；
 *   - 纯函数：同一 checkup 必得同一句话。
 */

/** 一句话自纠的硬上限（字符）：超过就说明翻错了，宁可截断也不占满状态段。 */
export const SELF_CORRECT_MAX_CHARS = 60

const has = (reasons, kw) => reasons.some((r) => String(r).includes(kw))
const num = (reasons, kw) => {
  const hit = reasons.find((r) => String(r).includes(kw))
  const m = hit && String(hit).match(/-?\d+(?:\.\d+)?/g)
  return m ? Number(m[0]) : null
}

/**
 * @param {{verdict?:{level:string,reasons:string[]}, n?:number, metrics?:object, baseline?:object}} checkup
 * @returns {string} 空串 = 不用自纠
 */
export const selfCorrectFromCheckup = (checkup) => {
  const verdict = checkup?.verdict
  if (!verdict || verdict.level === 'ok') return ''
  const reasons = Array.isArray(verdict.reasons) ? verdict.reasons : []
  if (!reasons.length) return ''

  let line = ''
  const metrics = checkup.metrics || {}
  const base = checkup.baseline || {}

  if (has(reasons, '中位字数')) {
    const m = Number(metrics.medianChars) || 0
    const b = Number(base.medianChars) || 27
    line = m > b
      ? `你最近话变长了（中位 ${m} 字，本来 ${b} 字左右）—— 这条收短，一句说完。`
      : `你最近话太短了（中位 ${m} 字，本来 ${b} 字左右）—— 这条给个具体细节，别只有一句反应。`
  } else if (has(reasons, '句号')) {
    line = '你最近一条里塞了好几句（句号偏多）—— 这条只留一个句号，剩下的用逗号或直接断句。'
  } else if (has(reasons, '表情')) {
    const m = Number(metrics.emojiRatio) || 0
    const b = Number(base.emojiRatio) || 0.417
    line = m < b
      ? '你最近几乎不带表情了 —— 这条顺手带一个（[doge]/[笑哭] 这类都行）。'
      : '你最近每条都带表情 —— 这条别带，靠字本身说话。'
  } else if (has(reasons, '问号')) {
    line = '你最近净是陈述、没有疑问 —— 这条如果真有想问的，就问一句。'
  } else if (has(reasons, '禁用词')) {
    line = '你最近用了几次明令禁用的说法 —— 这条换成人话，别套那些词。'
  } else {
    // 兜底：只报数字不报动作的判据（未来新增指标也不会没有兜底）
    line = `最近的说话口径偏了（${String(reasons[0]).slice(0, 30)}）—— 这条按真人随口一句的感觉来。`
  }

  const out = String(line).trim()
  return out.length > SELF_CORRECT_MAX_CHARS ? out.slice(0, SELF_CORRECT_MAX_CHARS) : out
}

/** 给归因/控制台的一行摘要（不影响注入）。 */
export const describeCheckup = (checkup) => {
  if (!checkup) return ''
  const v = checkup.verdict || {}
  const n = Number(checkup.n) || 0
  const level = v.level || 'ok'
  if (level === 'ok') return `体检：正常（近 ${n} 条）`
  const why = (Array.isArray(v.reasons) ? v.reasons : []).slice(0, 2).join('；')
  return `体检：${level === 'bad' ? '明显偏离' : '轻微偏离'}（近 ${n} 条）—— ${why}`
}
