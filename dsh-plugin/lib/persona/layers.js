/**
 * 注入分层装配（W1-0）：把编译器产出的五块文本，按"三通道"装成两段 + 一个结构提示。
 *
 * 为什么单独一层（设计 §2.2）：
 *   - **C1 编译期-前段**（章程之前）：L1 身份 + L2 见闻索引 —— 只放永不变的，越短越好；
 *   - **C2 编译期-后段**（整轮 prompt 末尾）：L3 状态 + L4 手感 + L0 尾注 —— 越靠后越有效；
 *   - **C3 生成期-每步**（`systemPrompt.context`）：W6 才消费，这里只留结构（本轮不接）。
 *
 * 纯函数：同一 (card, state, bank, roundId, modes, degrade) 必得同一 c1/c2 字节。
 * `buildDutyPrompt` 只做"取数 → 调这里 → 拼装"，编译器细节全部留在 compile.js。
 */
import { compilePersona } from './compile.js'
import { POSITION_DEFAULTS, RENDER_POSITIONS, resolveBudget } from './budget.js'

/** 人设两段的块标题（与升级前逐字一致，改动会改变注入字节）。 */
export const LAYER_TITLES = Object.freeze({
  core: (tag) => `人设（${tag} · 按这个来说话）`,
  lore: () => '你的生活（相关时才用；要用先读正文）',
  state: () => '你这会儿的状态',
  samples: () => '手感（看落点，别抄内容）',
  tail: () => '写之前，最后看几行',
})

/** 块标题的固定顺序（决定 c1/c2 内部顺序，与编译器的五块顺序同源）。 */
const BLOCK_ORDER = Object.freeze(['core', 'lore', 'state', 'samples', 'tail'])

const banner = (title) => `\n\n===== ${title} =====\n`
const END = '===== 人设结束 =====\n'

/**
 * 解析注入位置：读卡 `render.position` 优先，缺省看 POSITION_DEFAULTS。
 * 未知值按缺省处理（校验由 validateCard 负责，运行时不让坏配置把 prompt 拆坏）。
 */
export const resolvePosition = (card = {}) => {
  const raw = card?.render?.position
  const out = { ...POSITION_DEFAULTS }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const k of BLOCK_ORDER) {
      if (RENDER_POSITIONS.includes(raw[k])) out[k] = raw[k]
    }
  }
  return out
}

const isBefore = (pos) => String(pos || '').startsWith('before')

/**
 * 装配三段。
 *
 * @param {object} opts
 * @param {object} opts.card 生效卡
 * @param {object} opts.state deriveState 的结果
 * @param {object|null} [opts.bank] 表达库
 * @param {Date} [opts.now] 时间（透传给编译器/抽样；抽样实际用 roundId seed）
 * @param {object|null} [opts.modes] 场域字数（W1-2）；null = 旧口径单一 modeMax
 * @param {object|null} [opts.budget] 生效五块预算（缺省读卡 render.budget）
 * @param {string[]} [opts.degrade] 降级动作（W1-5）
 * @param {object|null} [opts.used] 预留给调用方传入的已用素材（本轮不消费，冷却表仍在 state 里）
 * @param {string} [opts.roundId] 抽样 seed / 逐轮复现
 * @param {string} [opts.loreDir] 见闻正文目录（绝对路径提示）
 * @returns {{c1:string, c2:string, c3Hints:object, used:object, stats:object, blocks:object,
 *            notes:string[], targetForm:string, degraded:string[], tag:string, position:object, budget:object}}
 */
export const buildLayers = ({
  card = {}, state = {}, bank = null, now = new Date(), modes = null, budget = null,
  degrade = [], used = null, roundId = 'round', loreDir = 'persona/lore',
} = {}) => {
  const position = resolvePosition(card)
  const effBudget = budget || resolveBudget(card)
  const compiled = compilePersona(card, { state, bank, roundId, modes, budget: effBudget, degrade, loreDir })
  const tag = `${card.id}@${card.version}`
  const titleOf = (k) => LAYER_TITLES[k](tag)
  const textOf = (k) => compiled.blocks?.[k]?.text || ''

  const beforeKeys = BLOCK_ORDER.filter((k) => isBefore(position[k]))
  const afterKeys = BLOCK_ORDER.filter((k) => !isBefore(position[k]))

  // C1：章程之前。core 恒出标题（身份是常驻的，空也占位），其余块有内容才出；
  //     块与块之间多一个空行（与升级前的 before 逐字节一致）。
  let c1 = ''
  let first = true
  for (const k of beforeKeys) {
    const text = textOf(k)
    if (k !== 'core' && !text) continue
    c1 += `${first ? '' : '\n'}${banner(titleOf(k))}${text}\n`
    first = false
  }
  if (c1) c1 += END

  // C2：整轮末尾。只出有内容的块；banner 自带前导空行（与升级前的 after 逐字节一致）。
  let c2 = ''
  for (const k of afterKeys) {
    const text = textOf(k)
    if (!text) continue
    c2 += `${banner(titleOf(k))}${text}\n`
  }

  // C3：生成期通道（W6 才消费）。这里只给宿主一个可用的结构骨架：
  //     每步按现场信息（视频标题/字幕/热评）做 keys 子串匹配 → 命中见闻正文（≤2 条 ≤600 字）。
  //     三条契约（设计 §2.5）：interpolate:false、失败静默降级、现场信息走文件。
  const c3Hints = {
    channel: 'generate-time',
    target: 'systemPrompt.context',
    interpolate: false,
    order: ['lore-hits', 'scene'],
    maxChars: 600,
    maxLoreBodies: 2,
    loreIndex: (compiled.loreIndex || []).map(({ id, keys, oneLine }) => ({ id, keys, oneLine })),
    note: 'W6 消费：等模型看见视频/热评后再命中见闻正文；失败必须静默降级，不阻断本轮',
  }

  return {
    c1,
    c2,
    c3Hints,
    used: used || compiled.used || { loreIds: [], canonKeys: [], expressionIds: [] },
    stats: compiled.stats,
    blocks: compiled.blocks,
    notes: compiled.notes || [],
    targetForm: compiled.targetForm,
    degraded: compiled.degraded || [],
    tag,
    position,
    budget: effBudget,
  }
}
