/**
 * 今日状态：mood / 时段 / 最近 3 条 / 形态欠账 / 沉默计数 / 冷却表。
 *
 * 为什么由宿主算、不让模型编：
 *   1. 模型不会数数（日志实测：为"这轮第几条形态"反复权衡，还数错）；
 *   2. 让模型"想象自己的心情"会顺手编外部事实（今天加班/刚下飞机），踩红线；
 *   3. 同一天内必须稳定、跨天必须变化 —— 这是"活人"的信号，靠日期 seed 最便宜。
 *
 * 全部确定性：同一 (日期, 账本, 卡) 必得同一结果，事故可复现。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'
import { charLen, hash32, stripEmoji } from './text.js'
import { stateFile } from './store.js'

/** 8 种"今天的状态"。只允许表达**自己的**状态，不许衍生外部事实。 */
export const MOODS = [
  { label: '有点困', energy: 3, patience: 3 },
  { label: '还行', energy: 5, patience: 5 },
  { label: '有点烦', energy: 3, patience: 2 },
  { label: '佛系', energy: 4, patience: 6 },
  { label: '饿了', energy: 4, patience: 4 },
  { label: '来劲', energy: 7, patience: 6 },
  { label: '蔫', energy: 2, patience: 3 },
  { label: '上头', energy: 8, patience: 4 },
]

/** 时段（设计 §7.8）：凌晨/早/午/晚/深夜。 */
export const timeOfDayOf = (date = new Date()) => {
  const h = date.getHours()
  if (h <= 4) return { key: 'late', label: '凌晨', maxChars: 40, note: '话更短，别写长经历' }
  if (h <= 10) return { key: 'morning', label: '早', maxChars: 100, note: '正常' }
  if (h <= 13) return { key: 'noon', label: '午', maxChars: 100, note: '正常' }
  if (h <= 21) return { key: 'evening', label: '晚', maxChars: 100, note: '正常' }
  return { key: 'deep', label: '深夜', maxChars: 40, note: '话更短，别写长经历' }
}

const dayKeyOf = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/* ───────────────────────── 形态判定（P1 临时版） ───────────────────────── */

const JUDGE_TAIL = /(得很|死了|这个了|说死了|实在|靠谱|给得足|到位|说透|不错|挺好|厉害|值了|香|省心|够了|服了)$/
const EMOJI = /\[[^\]]{1,12}\]|[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/u

/**
 * 粗分评论形态。P3 会换成 `lib/style.js` 的正式分类器（同一套正则），
 * P1 先保证"欠账"能算对方向（尤其别把判断句算成情绪）。
 */
export const formOf = (text) => {
  const raw = String(text ?? '').trim()
  const n = charLen(raw)
  const noTail = stripEmoji(raw).trim()
  if (/[？?]\s*$/.test(noTail)) return 'question'
  const core = noTail.replace(/[。.!！~～\s]+$/u, '')
  if (JUDGE_TAIL.test(core)) return 'detail' // 判断收尾不算情绪（关键：否则欠账永远不欠）
  // 第一人称经历优先于"带表情"：否则"我吃晕了[doge]"会被算成玩梗
  if (/我/.test(core) && n >= 8) return 'experience'
  if (EMOJI.test(raw)) return 'meme'
  if (n <= 6) return 'reaction'
  return 'detail'
}

export const hasEmoji = (text) => EMOJI.test(String(text ?? ''))

/* ───────────────────────── 派生 ───────────────────────── */

const sortByTime = (list) =>
  [...list].sort((a, b) => String(a?.t ?? '').localeCompare(String(b?.t ?? '')))

/**
 * 从账本事件派生今日状态。
 * @param {{events?: Array, card?: object, now?: Date, persisted?: object}} opts
 */
export const deriveState = ({ events = [], card = null, now = new Date(), persisted = {} } = {}) => {
  const date = dayKeyOf(now)
  const mood = MOODS[hash32(`mood:${date}`) % MOODS.length]
  const tod = timeOfDayOf(now)

  const list = sortByTime(Array.isArray(events) ? events : [])
  const comments = list.filter((e) => e?.type === 'comment' && e?.text)
  const last3 = comments.slice(-3).map((e) => ({ t: e.t, text: String(e.text), form: formOf(e.text) }))
  const last5 = comments.slice(-5)
  const forms5 = last5.map((e) => formOf(e.text))

  const debt = {
    question: forms5.filter((f) => f === 'question').length < 1,
    reaction: forms5.filter((f) => f === 'reaction').length < 1,
    experience: forms5.filter((f) => f === 'experience').length < 1,
    emoji: last5.filter((e) => hasEmoji(e.text)).length < 1,
    // 判断收尾占比过高时单独记一笔（不直接对应某个形态）
    judgeHeavy: forms5.length > 0 && forms5.filter((f) => f === 'detail').length >= Math.ceil(forms5.length * 0.6),
  }

  // 沉默计数：从末尾往前数连续的 skip 事件
  let skipStreak = 0
  for (let i = list.length - 1; i >= 0; i--) {
    const t = list[i]?.type
    if (t === 'skip') skipStreak++
    else if (t === 'comment' || t === 'dynamic' || t === 'reply-out') break
  }

  return {
    date,
    mood,
    timeOfDay: tod,
    commentsToday: comments.length,
    recent: { comments: last3, forms5, debt },
    skipStreak,
    // 冷却表从持久化状态继承（由调用方在轮末回写）
    loreUsed: persisted?.loreUsed && typeof persisted.loreUsed === 'object' ? persisted.loreUsed : {},
    canonUsed: persisted?.canonUsed && typeof persisted.canonUsed === 'object' ? persisted.canonUsed : {},
    expressionUsed: persisted?.expressionUsed && typeof persisted.expressionUsed === 'object' ? persisted.expressionUsed : {},
    personaId: card?.id || persisted?.personaId || '',
    personaVersion: card?.version || persisted?.personaVersion || '',
  }
}

/** 欠账 → 一行提醒（写给模型看；没有欠账就返回空串）。 */
export const debtLine = (state) => {
  const d = state?.recent?.debt
  if (!d) return ''
  const owed = []
  if (d.question) owed.push('疑问')
  if (d.reaction) owed.push('纯反应')
  if (d.emoji) owed.push('带表情')
  if (d.experience) owed.push('个人经历')
  const parts = []
  const forms5 = state?.recent?.forms5 || []
  if (forms5.length) {
    const judgeN = forms5.filter((f) => f === 'detail').length
    parts.push(`最近 ${forms5.length} 条：${judgeN} 条收在判断或叙述上、${forms5.filter((f) => f === 'question').length} 条疑问、${forms5.filter((f) => f === 'reaction').length} 条纯反应`)
  }
  if (owed.length) parts.push(`这条优先「${owed.slice(0, 2).join('」或「')}」`)
  if (d.judgeHeavy) parts.push('别再用"抓一个细节+一句判断"的骨架')
  return parts.join('；')
}

/* ───────────────────────── 持久化 ───────────────────────── */

export const loadState = (file = stateFile()) => {
  try {
    if (!existsSync(file)) return {}
    return JSON.parse(readFileSync(file, 'utf8')) || {}
  } catch {
    return {}
  }
}

/**
 * 保存今日状态。
 *
 * W3-4：**tmp + rename 原子替换**。旧实现直写目标文件，进程在写的瞬间被杀就会留下半截 JSON；
 * 而 `loadState` 的 catch 会把半截文件当成 `{}` —— 等于把"今天用过哪些见闻/canon/语料"
 * 整张冷却表静默清零，当天立刻重复讲同一件事。
 */
export const saveState = (state, file = stateFile()) => {
  const tmp = `${file}.tmp-${process.pid}`
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8')
    renameSync(tmp, file)
    return true
  } catch {
    try { unlinkSync(tmp) } catch { /* 临时文件清不掉也不能影响主流程 */ }
    return false
  }
}

/** 轮末回写：把本轮用掉的 lore/canon/expression 记进冷却表。 */
export const recordUsage = (state, { loreIds = [], canonKeys = [], expressionIds = [] } = {}, now = new Date()) => {
  const t = now.toISOString()
  const next = { ...state, loreUsed: { ...(state.loreUsed || {}) }, canonUsed: { ...(state.canonUsed || {}) }, expressionUsed: { ...(state.expressionUsed || {}) } }
  for (const id of loreIds) next.loreUsed[id] = t
  // canon 存**本地日**（不是 UTC 切片）：UTC+8 的 00:00–08:00 时 UTC 日期还是"昨天"，
  // 用 `t.slice(0,10)` 会把今天的梗记成昨天用过 ⇒ 当天重复讲、跨天又不能讲。
  for (const k of canonKeys) next.canonUsed[k] = dayKeyOf(now)
  for (const id of expressionIds) next.expressionUsed[id] = t
  next.updatedAt = t
  return next
}

/**
 * 今天是否用过某个条目（**统一按本地日**）。
 *
 * 为什么不能直接 `at.slice(0,10)`：ISO 时间戳是 UTC，而"今天"是本地日。
 * 在 UTC+8，本地 00:00–08:00 的 UTC 日期是前一天 —— 那段时间里
 * 「今天用过」会一直判 false（当天重复讲同一件事），跨天后又会判 true（该讲的不讲）。
 */
export const usedToday = (map, id, now = new Date()) => {
  const at = map?.[id]
  if (typeof at !== 'string' || !at) return false
  // 已经是 YYYY-MM-DD（canon 口径）就直接比；带时间的按本地日折算
  const day = /^\d{4}-\d{2}-\d{2}$/.test(at) ? at : dayKeyOf(new Date(at))
  return day === dayKeyOf(now)
}
