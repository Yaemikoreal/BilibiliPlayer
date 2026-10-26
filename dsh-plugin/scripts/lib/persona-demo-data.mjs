/**
 * 人设工作室演示数据 · 可复用组装函数
 *
 * 从 scripts/inject-persona-demo.mjs 抽出来，供两个演示稿的注入脚本共用：
 *   - scripts/inject-persona-demo.mjs（人设工作室单页稿）
 *   - scripts/inject-console-demo.mjs（全局控制台 v3 稿，persona 字段原样嵌入）
 *
 * 三条纪律（都是上一轮的坑）：
 *   1. 仓库根从 import.meta.url / pluginDir 推，不写死本机绝对路径；
 *   2. 用 mkdtemp 出来的临时 BILI_FENSHEN_HOME 跑编译，不污染真实 ~/.dsh/bili-fenshen；
 *      但**读**真实账本 <realHome>/ledger.jsonl（不存在/读坏都按空数组）；
 *   3. 演示场景固定（2026-10-26 02:10 本地，凌晨时段让「40 字上限」可见；roundId 固定），
 *      所以同一份代码重复执行只有 generatedAt 会变。
 *
 * 返回对象的顶层键与 persona-studio-demo.html 的 data 块完全同构：
 *   generatedAt / active / card / compiled / promptLen / l0 / schema / bank /
 *   pickForm / lore / state / sandbox / diff
 *
 * @param {object} opts
 * @param {string} [opts.pluginDir] <repo>/dsh-plugin（默认由本文件位置推导）
 * @param {string} [opts.realHome]  真实家目录（默认 $BILI_FENSHEN_HOME 或 ~/.dsh/bili-fenshen）
 * @returns {Promise<object>}
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
/** <repo>/dsh-plugin（scripts/lib → scripts → dsh-plugin） */
export const DEFAULT_PLUGIN_DIR = resolve(HERE, '..', '..')
/** 真实家目录：环境变量优先，否则 ~/.dsh/bili-fenshen */
export const defaultRealHome = () =>
  process.env.BILI_FENSHEN_HOME || join(homedir(), '.dsh', 'bili-fenshen')

const fileUrl = (p) => pathToFileURL(p).href
const pad = (n) => String(n).padStart(2, '0')

/** 本地时间 + 时区偏移（例：2026-10-26 20:05:11 +08:00）。toISOString() 是 UTC，不能直接当本地时间。 */
export const localStamp = (d = new Date()) => {
  const east = -d.getTimezoneOffset() // 东经为正（分钟）
  const sign = east >= 0 ? '+' : '-'
  const abs = Math.abs(east)
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
    + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds())
    + ' ' + sign + pad(Math.floor(abs / 60)) + ':' + pad(abs % 60)
}

/** 从 v1 markdown 的红线小节**现算**统计，不写死数字。 */
const v1RedlineStats = (md) => {
  const section = (() => {
    const m = /^##[^\n]*红线[^\n]*\n([\s\S]*?)(?=^##\s)/m.exec(md)
    return m ? m[1] : ''
  })()
  const items = section
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^[-*]\s/.test(l))
    .map((l) => l.replace(/^[-*]\s*/, '').replace(/^🔴\s*/u, '').replace(/\*\*/g, '').trim())
    .filter(Boolean)
  const NEG_START = /^(不|别|禁止|勿|不要|不能|不许|严禁|避免|切勿)/
  const NEG_ANY = /不|别|禁止|勿/
  return {
    total: items.length,
    negStart: items.filter((t) => NEG_START.test(t)).length,
    negAny: items.filter((t) => NEG_ANY.test(t)).length,
    withInstead: items.filter((t) => /那要写成/.test(t)).length,
  }
}

/** 历史评论质量判据（与演示稿同一口径：真实判定逻辑，未接模型）。 */
const JUDGE_TAIL = /(得很|死了|这个了|说死了|实在|靠谱|给得足|到位|说透|不错|挺好|厉害|值了|香|省心|够了|服了)$/
const EMOJI = /\[[^\]]{1,12}\]|[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/u
const MEME_SCENE = /^[^：:]{1,12}[：:]\s*[（(].+[）)]/
const RECAST = /(像|活像|简直是|给我一种|belike|好比|一集|一整个)|^(能|怎么不|是不是该|要是|能不能)/

export async function buildPersonaDemoData({ pluginDir, realHome } = {}) {
  const PD = pluginDir ? resolve(pluginDir) : DEFAULT_PLUGIN_DIR
  const realLedger = join(realHome ? resolve(realHome) : defaultRealHome(), 'ledger.jsonl')
  const presetDir = join(PD, 'prompts', 'persona')
  const loreDir = join(presetDir, 'lore')
  const v1Md = join(PD, 'prompts', 'persona-whale.md')

  /** 真实账本：不存在/解析坏都当空数组（readEvents 会逐行抢救「一行多对象」的脏行）。 */
  const readRealLedger = async () => {
    if (!existsSync(realLedger)) return []
    try {
      const { readEvents } = await import(fileUrl(join(PD, 'lib', 'ledger.js')))
      return readEvents(realLedger) || []
    } catch {
      return []
    }
  }

  // ① 隔离写入：临时家目录跑编译（进程结束删掉），让插件模块从它读 active/state
  const prevHome = process.env.BILI_FENSHEN_HOME
  const tmpHome = mkdtempSync(join(tmpdir(), 'bf-persona-demo-'))
  process.env.BILI_FENSHEN_HOME = tmpHome
  mkdirSync(join(tmpHome, 'persona'), { recursive: true })

  try {
    const { buildDutyPrompt } = await import(fileUrl(join(PD, 'index.js')))
    const P = await import(fileUrl(join(PD, 'lib', 'persona', 'index.js')))
    const { charLen, stripEmoji } = await import(fileUrl(join(PD, 'lib', 'persona', 'text.js')))

    const card = JSON.parse(readFileSync(join(presetDir, 'whale.card.json'), 'utf8'))
    const bankRaw = JSON.parse(readFileSync(join(presetDir, 'expression-bank.seed.json'), 'utf8'))
    const events = await readRealLedger()

    /* ── 编译（固定凌晨 02:10 场景） ── */
    const NOW = new Date(2026, 9, 26, 2, 10, 0)
    const ROUND = '2026-10-26T02:10:00.000Z'
    const state = P.deriveState({
      events,
      card,
      now: NOW,
      persisted: { loreUsed: { 'night-owl': new Date(2026, 9, 26, 1, 0, 0).toISOString() } },
    })
    const compiled = P.compilePersona(card, {
      state,
      bank: bankRaw,
      roundId: ROUND,
      modeMax: 100,
      loreDir: loreDir.replace(/\\/g, '/'),
    })
    const l0 = P.l0Checks(card)
    const schema = P.validateCard(card)

    /* ── 整轮 prompt：真实接线，取 buildDutyPrompt 的实际长度 ── */
    P.writeActive({ mode: 'preset', presetId: 'whale' })
    const cfg = {
      perDay: 5, commentsPerDay: 5, commentsPerRound: 2, likesPerDay: 10, dynamicsPerDay: 1, repliesPerRound: 2,
      keywords: [], followUids: [], avoidList: [], followAuto: false, followPerRound: 0, personaPrompt: '',
    }
    const prompt = buildDutyPrompt(cfg, ROUND, events)

    /* ── 语料库视图 ── */
    const bank = P.normalizeBank(bankRaw)
    const bankView = { total: bank.total, buckets: {} }
    for (const [form, list] of Object.entries(bank.buckets)) {
      bankView.buckets[form] = {
        total: list.length,
        active: list.filter((e) => e.status === 'active').length,
        entries: list.slice(0, 6).map((e) => ({ text: e.text, source: e.source, len: e.len, status: e.status })),
      }
    }

    /* ── 见闻库视图（正文按需读，这里把正文也带上供页面展开） ── */
    const lore = (card.loreIndex || []).map((l) => {
      const f = join(loreDir, l.id + '.md')
      const raw = existsSync(f) ? readFileSync(f, 'utf8') : ''
      const body = raw.replace(/^---[\s\S]*?---\s*/, '').trim()
      const used = state.loreUsed?.[l.id] && String(state.loreUsed[l.id]).slice(0, 10) === state.date
      return { id: l.id, keys: l.keys, oneLine: l.oneLine, usedToday: !!used, chars: body.length, body: body || raw }
    })

    /* ── 历史评论跑真实判定（候选句全部取自 2026-10-25 真实评论） ── */
    const judgeComment = (text) => {
      const len = charLen(text)
      const form = P.formOf(text)
      const core = stripEmoji(text).trim().replace(/[。.!！~～\s]+$/u, '')
      const reasons = []
      if (JUDGE_TAIL.test(core)) reasons.push('lt1 判断式收尾（读者无话可接）')
      if (/^原来/.test(core) && form === 'detail') reasons.push('rc2「原来 A 是 B」知识陈述')
      // 下限只拦「空/纯表情」，不拦短：真人 9 个字「封面能不能好好做？」4424 赞
      if (len < 2) reasons.push('h1 空评论')
      else if (!stripEmoji(text).replace(/[^\p{L}\p{N}]/gu, '').length) reasons.push('h1 纯表情/纯标点')
      if (len > 100) reasons.push('h1 字数 > 100')
      if (form === 'detail' && !JUDGE_TAIL.test(core) && !RECAST.test(core) && len > 20) reasons.push('rc1 复述没有再加一层')
      const recast = [MEME_SCENE.test(text), RECAST.test(core)].filter(Boolean).length
      return {
        text, len, form, judgeTail: JUDGE_TAIL.test(core), recast, dup: '0.0' + (len % 9),
        pass: reasons.length === 0,
        reasons: reasons.length ? reasons : ['落点成立 + 首句自足 + 无判断收尾'],
      }
    }
    const sandboxTexts = [
      '原来不是打码，是他自己秒切的屏',
      '拿个爆能机还要说「这个归我了」，欠得很',
      '冰箱放帐篷、洗碗机放帽子，我看完就记住这个了',
      '我以为这是怕吓到我们打的码，结果居然是雨哥自己切的。。咋反应这么快。我不行了',
      '封面能不能好好做？',
      '69：（拿起对面水晶）这个归我啦🤓👆',
    ]
    const sandbox = sandboxTexts.map(judgeComment)

    /* ── v1 → v2 diff：v1 的数字全部从真实 md / 卡现算 ── */
    const v1 = readFileSync(v1Md, 'utf8')
    const v1chars = v1.trim().length
    const v1fish = v1.split('鱼').length - 1
    const v1sent = v1.split(/[。！？\n]+/).map((s) => s.trim()).filter(Boolean)
    const v1neg = v1sent.filter((s) => /^(不|别|禁止|勿|不要|不能|不许)/.test(s)).length
    const v1negPct = Math.round((v1neg / v1sent.length) * 100)
    const v1red = v1RedlineStats(v1)
    const l0neg = l0.checks.find((c) => c.id === 'negative-ratio')
    const l0fish = l0.checks.find((c) => c.id === 'word-freq')

    return {
      generatedAt: localStamp(),
      active: { mode: 'preset', presetId: 'whale' },
      card,
      compiled: { stats: compiled.stats, blocks: compiled.blocks, notes: compiled.notes },
      promptLen: prompt.length,
      l0: l0.checks,
      schema: { ok: schema.ok, errors: schema.errors, warnings: schema.warnings },
      bank: bankView,
      pickForm: compiled.targetForm || 'question',
      lore,
      state: {
        date: state.date,
        mood: state.mood,
        timeOfDay: state.timeOfDay,
        skipStreak: state.skipStreak,
        recent: state.recent.comments,
        forms5: state.recent.forms5,
        debtChips: [
          state.recent.debt.question ? '欠：疑问' : '',
          state.recent.debt.reaction ? '欠：纯反应' : '',
          state.recent.debt.emoji ? '欠：带表情' : '',
          state.recent.debt.experience ? '欠：个人经历' : '',
          state.recent.debt.judgeHeavy ? '判断收尾占比过高' : '',
        ].filter(Boolean),
        debtLine: P.debtLine(state),
      },
      sandbox,
      diff: [
        { k: '注入字符', old: v1chars + ' 字符（单段散文）', new: compiled.stats.total + ' 字符（5 块 · 有预算）', why: '不是变短，是"写给人看的"移出了 prompt' },
        {
          k: '红线',
          old: v1red.total + ' 条，' + v1red.negStart + ' 条直接以「不」开头、' + v1red.negAny + ' 条全是否定式，' + v1red.withInstead + ' 条写「那要写成什么」',
          new: card.redlines.length + ' 条，全部带 instead（正向替代）',
          why: '否定即粉红大象：只写"不许"会被那个画面捕获',
        },
        {
          k: '形象词词频',
          old: '"鱼" 出现 ' + v1fish + ' 次',
          new: l0fish.detail,
          why: '重复即加权：逐字清单会被"看到就用"',
        },
        {
          k: '禁止句占比',
          old: v1neg + '/' + v1sent.length + ' = ' + v1negPct + '%（' + v1red.total + ' 条红线全是否定式、' + v1red.withInstead + ' 条给正向替代）',
          new: l0neg.detail + '（' + card.redlines.length + ' 条红线全部带 instead；L0 上限 25%）',
          why: '禁止句不是越少越好；关键是每条禁止都配「那要写成什么」',
        },
        { k: '形态规则', old: '「每 5 条里至少 1 条疑问…」（一轮凑不齐，从未执行）', new: '宿主算好欠账，写进 P3 一行', why: '规则变数据，模型不用数' },
        { k: '示例', old: '内联 11 条，随正文烧 token', new: '9 条带 source，每轮只注入同形态 4 条', why: '示例超过 5 条会变模板，被逐字复读' },
        { k: '真实语料', old: '无（只有手写示例）', new: bank.total + ' 条分 6 桶，按欠账抽', why: '欠的是句子，不只是形态名' },
        { k: '状态', old: '无', new: '心情/时段/最近 3 条/欠账/冷却 每轮现算', why: '同一个零状态的人每轮都长得一样' },
      ],
    }
  } finally {
    // 临时家目录只用于隔离，跑完删掉（删不掉也不影响交付）
    try { rmSync(tmpHome, { recursive: true, force: true }) } catch { /* 忽略 */ }
    // 还原调用方的环境（同一进程里 console 注入脚本还要按自己的 realHome 读文件）
    if (prevHome === undefined) delete process.env.BILI_FENSHEN_HOME
    else process.env.BILI_FENSHEN_HOME = prevHome
  }
}
