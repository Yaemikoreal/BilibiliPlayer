// 控制台渲染/截图共用的 fixture 数据（由 client.render-smoke.mjs 抽出，单一口径）
// 数据形状与 /api/bili-fenshen/* 的真实响应一致（design-v4 §2.1 信封）；页面结构与 SSR 断言在 client.render-smoke.mjs。
//
// 设计要点：
//  - overview 信封带 seq / serverTime / dataUpdatedAt（客户端 seq 单调守卫要用）；
//  - 老字段全部保留（向后兼容），新字段只增不改；
//  - quota.perRound 是「本轮」分栏；quota.replyScans / proactiveSkipped 是接话扫描口径；
//  - round.lastRound 由账本按 roundId 聚合，带 counts + proactiveMissing；
//  - presence.available=false 时给 note，不硬显示 0。

const DAY = '2026-10-23'
const TODAY = '2026-10-28'

export const FIX = {
  '/api/bili-fenshen/overview': {
    ok: true,
    seq: 1287,
    serverTime: '2026-10-28T00:30:02.000Z',
    dataUpdatedAt: '2026-10-28T00:30:01.870Z',
    // 账号并进信封（老 /account 路由保留兼容）
    account: {
      loggedIn: true, uname: '蓝鱼小号', mid: '10000001', face: '', level: 6,
      coins: 1447.5, fans: 12, vip: false, checkedAt: '2026-10-28T00:28:00.000Z', stale: false,
    },
    duty: {
      autoDuty: true,
      windows: { noon: true, night: true },
      nextWindowLabel: '中午 12:00（2h54m 后）',
      nextRunAt: 1793000000000,
    },
    quota: {
      picked: 3, comments: 2, likes: 6, dynamics: 1,
      replies: 1, repliesProactive: 1, replyScans: 2, proactiveSkipped: 1,
      limits: {
        perDay: 5, commentsPerDay: 5, likesPerDay: 10, dynamicsPerDay: 1,
        repliesPerRound: 2, replyOthersPerRound: 3,
      },
      perRound: {
        roundId: 'r1', picked: 3, comments: 2, likes: 6, dynamics: 1,
        proactive: 1, scans: 1, replies: 0,
      },
      updatedAt: '2026-10-28T00:30:01.000Z',
    },
    round: {
      running: false,
      roundId: '2026-10-23T08:26:00Z',
      startedAt: '2026-10-23T08:26:00Z',
      elapsedMs: 576600,
      phase: { key: 'act', label: '发言' },
      stats: {
        events: 0, tools: {},
        actions: { like: 0, comment: 0, dynamic: 0, reply: 0, proactive: 0, scan: 0 },
        errors: 0,
      },
      lastRunAt: '2026-10-23T08:35:37Z',
      lastWhy: 'web',
      lastCode: 0,
      lastDurationMs: 576600,
      lastRound: {
        roundId: '2026-10-23T08:26:00Z',
        startedAt: '2026-10-23T08:26:00Z',
        endedAt: '2026-10-23T08:35:37Z',
        code: 0,
        durationMs: 576600,
        counts: { views: 2, likes: 2, comments: 1, replies: 1, proactive: 1, dynamics: 0, skips: 1, scans: 1 },
        proactiveMissing: false,
      },
      // W2-1 归因 + W5「本轮实际注入 / 页头一行」：形状与 lib/persona/attribution.js 的账本事件一致
      personaTag: 'whale@2.0.0',
      personaInject: {
        t: '2026-10-23T08:26:05Z',
        round: '2026-10-23T08:26:00Z',
        type: 'persona-inject',
        personaTag: 'whale@2.0.0',
        mode: 'card',
        channel: 'c1',
        layers: [
          { name: 'core', chars: 1281, max: 1500 },
          { name: 'lore', chars: 236, max: 300 },
          { name: 'state', chars: 112, max: 500 },
          { name: 'samples', chars: 140, max: 450 },
          { name: 'tail', chars: 159, max: 250 },
        ],
        total: 1913,
        totalMax: 3000,
        hits: [
          { kind: 'lore', id: 'wuchang-ranked' },
          { kind: 'canon', id: '问是不是 AI' },
          { kind: 'expression', id: 'reaction#1' },
        ],
        degraded: ['lore:shrink'],
        guard: { level: 'warn', len: 21000, softMax: 20000, hardMax: 24000 },
        notes: ['P4 用表达库（question，4 条）'],
      },
      // W7-2 发言门控（buildRoundGate → gateView 形状，见 plan §8.5）：
      // base 取「观察中 + 收紧」——最容易让主人误判成「已经在拦」的一档，所以 UI 必须写明「不拦」。
      speakGate: {
        mode: 'observe',
        decision: 'throttle',
        reason: '节奏偏密：最近 5 个动作里说了 3 次（观察中，不强制；建议本轮最多 1 条）',
        suggestedMaxComments: 1,
        enforced: false,
        features: { recentShare: 0.6, recentWindow: 5, recentSpoke: 3, gapMinutes: 12, pendingReplies: 0 },
      },
      nextRunAt: 1793000000000,
      nextWindowLabel: '中午 12:00（2h54m 后）',
    },
    inbox: { pendingReply: 0, lastPollAt: '2026-10-28T00:29:58.000Z', lastPollOk: true },
    presence: {
      available: false,
      likes7d: 0, replies7d: 1, comments7d: 3,
      trend: [{ date: '2026-10-27', count: 1 }, { date: '2026-10-28', count: 0 }],
      latest: { text: '这个折叠次数是给手残党看的吧', bvid: 'BV1xrnz6gEVD', t: '2026-10-23T08:27:00Z' },
      note: '收到点赞没有数据源（like-in 至今无写入方），这一格不显示 0。',
    },
    health: { cli: 'D:/x/bin.js', cliCheckedAt: '2026-10-28T00:20:00.000Z', cred: true, routeOk: true },
    model: { provider: 'deepseek-account', name: 'deepseek-flash', reasoningEffort: 'high' },
    home: 'C:/h', ledgerFile: 'C:/h/ledger.jsonl',
  },
  '/api/bili-fenshen/activity': {
    ok: true,
    days: [{
      date: DAY,
      rounds: [{
        id: 'r1', startedAt: '2026-10-23T08:26:00Z', sourceLabel: '热门',
        items: [
          {
            bvid: 'BV1xrnz6gEVD', title: '折1万次，会坏吗？iPhone Duo深度评测', author: '影视飓风',
            views: 3136000, duration: 1492, source: 'hot', grade: 'worth',
            events: [
              { t: '2026-10-23T08:26:11Z', round: 'r1', type: 'view' },
              { t: '2026-10-23T08:26:30Z', round: 'r1', type: 'like' },
              { t: '2026-10-23T08:27:00Z', round: 'r1', type: 'comment', text: '我的评论', rpid: 123456 },
              { t: '2026-10-23T09:00:00Z', round: 'r1', type: 'reply-in', parent: 123456, rpid: 999001, from: '张三', text: '回复我' },
              { t: '2026-10-23T09:10:00Z', round: 'r1', type: 'reply-out', parent: 999001, rpid: 999100, text: '我回答' },
            ],
            stage: {
              viewed: true, liked: true, commented: true, replies: 1, repliedBack: true,
              dynamic: false, pendingReply: 0, scanned: true, proactive: 0,
            },
            flags: { fromReport: false },
          },
          {
            // 接话样例：扫描 → 接一条（kind: 'proactive'），带 reply-scan 机器行
            bvid: 'BV1CqnW6oE8B', title: '设计师是怎么被产品经理气死的', author: '影视飓风',
            views: 1203000, duration: 620, source: 'hot', grade: 'ok',
            events: [
              { t: '2026-10-23T08:28:00Z', round: 'r1', type: 'view' },
              { t: '2026-10-23T08:28:20Z', round: 'r1', type: 'like' },
              {
                t: '2026-10-23T08:29:00Z', round: 'r1', type: 'reply-scan', bvid: 'BV1CqnW6oE8B',
                candidates: [
                  { rpid: 321560862800, user: '666设计师', like: 396, verdict: '接', why: '一句能答的吐槽' },
                  { rpid: 321560862900, user: '甲方乙方', like: 88, verdict: '不接', why: '纯站队' },
                ],
                decision: 'posted', targetRpid: 321560862800, postedRpid: 318378624657,
              },
              {
                t: '2026-10-23T08:29:30Z', round: 'r1', type: 'reply-out', kind: 'proactive',
                parent: 321560862800, rpid: 318378624657, text: '这句真的是设计师本命',
              },
            ],
            stage: {
              viewed: true, liked: true, commented: false, replies: 0, repliedBack: false,
              dynamic: false, pendingReply: 0, scanned: true, proactive: 1,
            },
            flags: { fromReport: false },
          },
          {
            bvid: 'BV2skip', title: '跳过的视频',
            events: [{ t: '2026-10-23T08:29:00Z', round: 'r1', type: 'skip', bvid: 'BV2skip', title: '跳过的视频', reason: '无字幕' }],
            stage: {
              viewed: true, liked: false, commented: false, replies: 0, repliedBack: false,
              dynamic: false, pendingReply: 0, scanned: false, proactive: 0,
            },
            skipped: { reason: '无字幕' }, flags: {},
          },
        ],
      }],
    }],
  },
  // 老路由保留兼容（信封里已有 account；SettingsEntry 用 sse:false 的轮询）
  '/api/bili-fenshen/account': {
    ok: true,
    account: {
      loggedIn: true, uname: '蓝鱼小号', mid: '10000001', face: '', level: 6,
      coins: 1447.5, fans: 12, vip: false,
    },
  },
  '/api/bili-fenshen/config': {
    ok: true,
    values: {
      autoDuty: true, noon: true, night: true, perDay: 5, commentsPerDay: 5, commentsPerRound: 2,
      likesPerDay: 10, dynamicsPerDay: 1, repliesPerRound: 2, replyOthersPerRound: 3,
      followAuto: true, followPerRound: 8, avoidList: ['引战'], keywords: ['AI 实测'], followUids: [10000001],
      banPrivacy: true, banImpersonation: true, banControversy: true, banRepeat: true, banReplyRefusal: true,
      dynamicPureText: false, growthEnable: true, growthAutoPromote: 3,
      // W7-2 / W2-3 本轮新加配置项（设置页「人设 / 质量门」分组）
      speakGateMode: 'observe', growthCheckedOnly: false,
      personaPrompt: '', reportLevel: 'full', dshBin: '', headlessProfile: 'headless', dutyTools: [],
      modelProvider: '', modelName: '', modelReasoningEffort: '',
    },
    sources: { perDay: 'patch' },
    defaults: {
      autoDuty: false, noon: true, night: true, perDay: 5, commentsPerDay: 5, commentsPerRound: 2,
      likesPerDay: 10, dynamicsPerDay: 1, repliesPerRound: 2, replyOthersPerRound: 3,
      followAuto: true, followPerRound: 8, avoidList: [], keywords: [], followUids: [],
      banPrivacy: true, banImpersonation: true, banControversy: true, banRepeat: true, banReplyRefusal: true,
      dynamicPureText: false, growthEnable: true, growthAutoPromote: 3,
      // W7-2 / W2-3 本轮新加配置项（设置页「人设 / 质量门」分组）
      speakGateMode: 'observe', growthCheckedOnly: false,
      personaPrompt: '', reportLevel: 'full', dshBin: '', headlessProfile: 'headless', dutyTools: [],
      modelProvider: '', modelName: '', modelReasoningEffort: '',
    },
  },
  // 模型配置：provider/model/推理强度目录 + 当前生效
  '/api/bili-fenshen/models': {
    ok: true,
    selection: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' },
    effective: { mode: 'config', provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' },
    config: { modelProvider: 'deepseek-account', modelName: 'deepseek-flash', modelReasoningEffort: 'high' },
    providers: [{ id: 'deepseek-account', name: 'DeepSeek' }, { id: 'openai', name: 'OpenAI' }],
    models: {
      'deepseek-account': [{ id: 'deepseek-flash', name: 'deepseek-flash' }, { id: 'deepseek-pro', name: 'deepseek-pro' }],
      openai: [{ id: 'gpt-x', name: 'gpt-x' }],
    },
    reasoningEfforts: [{ id: 'low', name: 'Low', description: '' }, { id: 'high', name: 'High', description: '' }],
    warnings: [],
  },
  // 实时事件流：GET /live（空闲形态；SSE 不可用时降级轮询也走这里）
  '/api/bili-fenshen/live': {
    ok: true, running: false, roundId: '2026-10-23T08:26:00Z',
    startedAt: '2026-10-23T08:26:00Z', elapsedMs: 576600, why: 'web',
    lastCode: 0, lastDurationMs: 576600, lastRunAt: '2026-10-23T08:35:37Z',
    phase: { key: 'act', label: '发言' },
    cursor: 0, events: [],
    stats: {
      events: 0, tools: {},
      actions: { like: 0, comment: 0, dynamic: 0, reply: 0, proactive: 0, scan: 0 }, errors: 0,
    },
    quota: {
      picked: 1, comments: 0, likes: 0, dynamics: 0,
      limits: { perDay: 5, commentsPerDay: 5, likesPerDay: 10, dynamicsPerDay: 1, repliesPerRound: 2 },
    },
  },
  // 人设：生效卡健康度 + 内置预设 + 语料库统计（GET /persona）
  '/api/bili-fenshen/persona': {
    ok: true,
    active: { mode: 'preset', presetId: 'whale' },
    health: {
      mode: 'card', ok: true, detail: 'whale@2.0.0（preset，1733 字符）',
      path: 'D:/x/prompts/persona/whale.card.json', source: 'preset',
    },
    presets: [
      { id: 'whale', name: '蓝色大肥鱼', version: '2.0.0', oneLiner: 'DeepSeek 的民间拟人形象', license: 'CC BY-NC-SA 4.0', file: 'D:/x/whale.card.json' },
      { id: 'elaina', name: '灰之魔女', version: '2.0.0', oneLiner: '会飞的灰之魔女', license: 'CC BY-NC-SA 4.0', file: 'D:/x/elaina.card.json' },
      { id: 'generic', name: '普通网友', version: '2.0.0', oneLiner: '没有 IP 的普通网友', license: 'CC BY-NC-SA 4.0', file: 'D:/x/generic.card.json' },
    ],
    card: {
      spec: 'bili-fenshen.persona/v2', id: 'whale', version: '2.0.0', name: '蓝色大肥鱼', license: 'CC BY-NC-SA 4.0',
      identity: { oneLiner: 'DeepSeek 的民间拟人形象', background: '蓝白、圆滚滚、端着一碗白饭。' },
      voice: { register: ['逗句', '口语'], moves: ['纯情绪', '反问', '玩梗'] },
      mindset: { contradictions: ['摸鱼 vs 怕被认出来'] },
      taste: { watch: ['游戏实测'], avoid: ['引战'] },
      stance: [{ topic: 'AI 拉踩', attitude: '不站队', how: '只聊作品' }],
      redlines: [], canon: [], loreIndex: [], samples: { good: [] },
    },
    cardSource: { source: 'preset', path: 'D:/x/prompts/persona/whale.card.json', error: null },
    versions: [{ name: 'whale-2.0.0-2026-10-26.json', mtime: 1761400000000 }],
    bank: {
      total: 23, updatedAt: '2026-10-26T00:00:00Z',
      byBucket: {
        reaction: { total: 2, active: 2 }, question: { total: 5, active: 5 }, experience: { total: 3, active: 3 },
        meme: { total: 5, active: 5 }, detail: { total: 2, active: 2 }, rant: { total: 6, active: 6 },
      },
    },
    budget: { blocks: { core: 1500, lore: 300, state: 500, samples: 450, tail: 250 }, totalMax: 3000 },
  },
  // 人设编译预览（GET /persona/preview）：五块预算 / L0 六条 / 今日状态
  '/api/bili-fenshen/persona/preview': {
    ok: true,
    tag: 'whale@2.0.0',
    text: '===== 你是谁（按这个来）=====\nDeepSeek 的民间拟人形象\n===== 写之前，最后看三行 =====\n1) 别收在判断上。',
    stats: {
      total: 1733, totalMax: 3000, overTotal: false, over: [],
      per: [
        { name: 'core', len: 1052, max: 1500 }, { name: 'lore', len: 227, max: 300 },
        { name: 'state', len: 208, max: 500 }, { name: 'samples', len: 129, max: 450 },
        { name: 'tail', len: 117, max: 250 },
      ],
    },
    notes: ['P4 用表达库（question，4 条）'],
    errors: [], warnings: [],
    l0: {
      ok: true,
      checks: [
        { id: 'redline-triple', name: '红线三件套（不许+为什么+那要写成什么）', level: 'pass', pass: true, detail: '9 条全部有 instead' },
        { id: 'negative-ratio', name: '禁止句占比（≤25%）', level: 'pass', pass: true, detail: '7/141 = 5%' },
        { id: 'moves-table', name: '手段表（≥6 类可做的事）', level: 'pass', pass: true, detail: '6 类' },
        { id: 'word-freq', name: '词频（签名词 ≤3 次）', level: 'pass', pass: true, detail: '无超限词' },
        { id: 'contradiction', name: '矛盾写成 X vs Y', level: 'pass', pass: true, detail: '4 条，0 条是标签' },
        { id: 'sample-dup', name: '示例不重复且带来源', level: 'pass', pass: true, detail: '9 条互不重复' },
      ],
    },
    state: {
      date: TODAY,
      mood: { label: '佛系', energy: 4, patience: 6 },
      timeOfDay: { key: 'late', label: '凌晨', maxChars: 40, note: '话更短，别写长经历' },
      skipStreak: 0, loreUsed: {}, canonUsed: {}, expressionUsed: {},
      recent: {
        comments: [
          { text: '原来不是打码，是他自己秒切的屏', form: 'detail' },
          { text: '拿个爆能机还要说「这个归我了」，欠得很', form: 'detail' },
        ],
        forms5: ['detail', 'detail', 'question'],
        debt: { question: true, reaction: false, emoji: false, experience: false, judgeHeavy: true },
      },
    },
  },
  // 语料库 / 见闻库 / 版本（人设页 2、3 子页签）
  '/api/bili-fenshen/persona/expression': {
    ok: true, total: 23,
    buckets: {
      question: [
        { text: '封面能不能好好做？', source: 'comment-reception', len: 9, status: 'active', heat: 1 },
        // W3-3：软删除留痕 —— disabled:true 的条目在回收站里可恢复/彻底删除
        { text: '这是被软删的语料', source: 'comment-reception', len: 8, status: 'active', heat: 0, disabled: true },
      ],
      reaction: [{ text: '啊这', source: 'comment-reception', len: 2, status: 'active', heat: 0 }],
    },
  },
  '/api/bili-fenshen/persona/lore': {
    ok: true,
    entries: [
      { id: 'wuchang-ranked', keys: ['无畏契约'], oneLine: '常年白银边缘', usedToday: false, chars: 12, body: '正文内容' },
      // W3-3：软删除的见闻条目
      { id: 'old-meme', keys: ['旧梗'], oneLine: '已删除的旧见闻', usedToday: false, chars: 6, body: '旧正文', disabled: true },
    ],
  },
  '/api/bili-fenshen/persona/versions': {
    ok: true,
    versions: [{ name: 'whale-2.0.0-2026-10-26.json', mtime: 1761400000000 }],
  },
  // W5-2 体检（GET /persona/checkup）：近 12 条 vs 247 条基线，一处表情占比偏离 → warn
  '/api/bili-fenshen/persona/checkup': {
    ok: true,
    windowDays: 14,
    n: 12,
    metrics: { medianChars: 24, periodPerComment: 0.083, emojiRatio: 0.75, questionRatio: 0.167, avoidHits: 0 },
    baseline: { medianChars: 27, periodPerComment: 0.109, emojiRatio: 0.417, questionRatio: 0.126 },
    verdict: {
      level: 'warn',
      reasons: ['表情占比 75%（基线 42%，偏离 +33%）'],
    },
    samples: [
      { bvid: 'BV1xrnz6gEVD', text: '原来不是打码，是他自己秒切的屏', t: '2026-10-23T08:27:00Z' },
      { bvid: 'BV1CqnW6oE8B', text: '这句真的是设计师本命', t: '2026-10-23T08:29:30Z' },
      { bvid: 'BV1xrnz6gEVD', text: '拿个爆能机还要说「这个归我了」，欠得很', t: '2026-10-23T09:10:00Z' },
    ],
  },
  // W5 换卡对比（GET /persona/history）：按 personaTag 分组，各 3 条评论 + 赞
  '/api/bili-fenshen/persona/history': {
    ok: true,
    tags: [
      {
        personaTag: 'whale@2.0.0', rounds: 3, lastAt: '2026-10-23T09:10:00Z', likes: 7,
        samples: [
          { bvid: 'BV1xrnz6gEVD', text: '原来不是打码，是他自己秒切的屏', t: '2026-10-23T08:27:00Z', likes: 4 },
          { bvid: 'BV1CqnW6oE8B', text: '这句真的是设计师本命', t: '2026-10-23T08:29:30Z', likes: 2 },
          { bvid: 'BV1xrnz6gEVD', text: '拿个爆能机还要说「这个归我了」，欠得很', t: '2026-10-23T09:10:00Z', likes: 1 },
        ],
      },
      {
        personaTag: 'elaina@2.0.0', rounds: 1, lastAt: '2026-10-21T09:00:00Z', likes: 0,
        samples: [
          { bvid: 'BV1xrnz6gEVD', text: '封面能不能好好做？', t: '2026-10-21T08:30:00Z', likes: 0 },
        ],
      },
    ],
  },
  // 一键诊断：9 pass / 1 warn / 0 fail
  '/api/bili-fenshen/diagnose': {
    ok: true, generatedAt: '2026-10-25T01:02:03.000Z', durationMs: 1234,
    summary: { pass: 9, warn: 1, fail: 0 },
    items: [
      { id: 'python', label: 'Python 解释器', status: 'pass', detail: 'Python 3.11.15', fix: '', durationMs: 42 },
      { id: 'deps', label: 'Python 依赖', status: 'pass', detail: 'mcp / bilibili_api / aiohttp 均已安装', fix: '', durationMs: 30 },
      { id: 'mcp-server', label: 'MCP Server 文件', status: 'pass', detail: 'mcp_server.py 可编译', fix: '', durationMs: 18 },
      { id: 'mcp-connection', label: 'MCP 连接', status: 'pass', detail: '已注册 28 个 bili 工具', fix: '', durationMs: 2 },
      { id: 'credential', label: 'B 站登录凭证', status: 'warn', detail: '未登录', fix: '到控制台重新扫码登录', durationMs: 10 },
      { id: 'dsh-cli', label: 'dsh CLI', status: 'pass', detail: '/usr/local/bin/dsh', fix: '', durationMs: 1 },
      { id: 'headless-profile', label: 'headless profile', status: 'pass', detail: '/home/x/.dsh/profiles/headless', fix: '', durationMs: 1 },
      { id: 'home', label: '家目录可写', status: 'pass', detail: '/home/x/.dsh/bili-fenshen', fix: '', durationMs: 3 },
      { id: 'model', label: '模型可用', status: 'pass', detail: 'deepseek-account / deepseek-flash（跟随默认）', fix: '', durationMs: 5 },
      { id: 'route', label: '控制台路由', status: 'pass', detail: '已挂载 /api/bili-fenshen', fix: '', durationMs: 1 },
    ],
  },
  '/api/bili-fenshen/seen': {
    ok: true,
    rows: [
      { date: DAY, time: '08:26', bvid: 'BV1xrnz6gEVD', action: '看过+赞过+评论过', title: '折1万次，会坏吗？iPhone Duo深度评测' },
      { date: DAY, time: '08:28', bvid: 'BV1CqnW6oE8B', action: '看过+赞过+接话过', title: '设计师是怎么被产品经理气死的' },
      { date: DAY, time: '', bvid: '', action: '第二轮值班开始（已登录，凭证有效）', title: '-' },
    ],
  },
  '/api/bili-fenshen/reports': {
    ok: true,
    days: [DAY], digests: ['2026-10'], overlay: true,
  },
  '/api/bili-fenshen/report': {
    ok: true,
    text: '# 测试日报\n\n## 第一轮（round id 2026-10-23T08:26:00Z）\n\n### BV1xrnz6gEVD\n\n'
      + '**档位**：值得看\n\n- 看到「折 1 万次」那段，脑子里只剩「这也能测」\n'
      + '- 动作：点赞 + 评论（rpid 318143807425）：`这个折叠次数是给手残党看的吧`\n'
      + '- 接话扫描：候选 2 → 接 rpid 318378624657（666设计师）\n\n'
      + '## 第二轮（round id 2026-10-23T10:00:00Z）\n\n无字幕跳过 2 条。',
  },
  '/api/bili-fenshen/log': {
    ok: true,
    path: 'C:/h/logs/host.log',
    events: [
      '[2026-10-28T00:20:01.123Z] 值班轮启动（why=web）',
      '[2026-10-28T00:20:03.456Z] 工具 bili_search 调用',
      '[2026-10-28T00:20:09.789Z] 评论发送失败：-101 未登录',
    ],
    raw: '…原始子进程输出…',
  },
}

// 运行中的实时状态（注入 ConsolePage 的 props.live；SSR 不执行 effect，故用 fixture 顶替 useLive 的初始值）
export const RUNNING_LIVE = {
  data: {
    running: true,
    roundId: '2026-10-28T00:20:00.000Z',
    startedAt: '2026-10-28T00:20:00.000Z',
    elapsedMs: 83000,
    why: 'web',
    phase: { key: 'watch', label: '看内容' },
    stats: {
      events: 3,
      tools: { bili_search: 1, bili_subtitle: 2 },
      actions: { like: 1, comment: 1, dynamic: 0, reply: 0, proactive: 1, scan: 1 },
      errors: 0,
    },
    quota: {
      picked: 1, comments: 0, likes: 0, dynamics: 0,
      limits: { perDay: 5, commentsPerDay: 5, likesPerDay: 10, dynamicsPerDay: 1, repliesPerRound: 2 },
    },
    events: [
      { seq: 101, t: '2026-10-28T00:20:12.000Z', kind: 'tool', tool: 'bili_search', text: '→ bili_search' },
      { seq: 102, t: '2026-10-28T00:20:20.000Z', kind: 'tool', tool: 'bili_subtitle', text: '→ bili_subtitle BV1xrnz6gEVD' },
      { seq: 103, t: '2026-10-28T00:20:30.000Z', kind: 'host', text: '正在读字幕' },
    ],
    lastCode: null,
    lastDurationMs: null,
    lastRunAt: null,
  },
  mode: 'poll',
  error: '',
}

// 概览「运行中」信封（seq 更大；running:true + 真实 phase/stats）
export const RUNNING_OVERVIEW = {
  ...FIX['/api/bili-fenshen/overview'],
  seq: 1290,
  serverTime: '2026-10-28T00:21:24.000Z',
  dataUpdatedAt: '2026-10-28T00:21:23.900Z',
  round: {
    ...FIX['/api/bili-fenshen/overview'].round,
    running: true,
    roundId: '2026-10-28T00:20:00.000Z',
    startedAt: '2026-10-28T00:20:00.000Z',
    elapsedMs: 84000,
    phase: { key: 'watch', label: '看内容' },
    stats: {
      events: 12,
      tools: { bili_search: 1, bili_subtitle: 2 },
      actions: { like: 1, comment: 1, dynamic: 0, reply: 0, proactive: 1, scan: 1 },
      errors: 0,
    },
  },
  quota: {
    ...FIX['/api/bili-fenshen/overview'].quota,
    perRound: { roundId: '2026-10-28T00:20:00.000Z', picked: 1, comments: 1, likes: 1, dynamics: 0, proactive: 1, scans: 1, replies: 0 },
  },
}

// 接话「未扫描」信封（round.lastRound.proactiveMissing = true）
export const MISSING_PROACTIVE_OVERVIEW = {
  ...FIX['/api/bili-fenshen/overview'],
  seq: 1300,
  round: {
    ...FIX['/api/bili-fenshen/overview'].round,
    lastRound: {
      ...FIX['/api/bili-fenshen/overview'].round.lastRound,
      counts: { views: 2, likes: 2, comments: 1, replies: 1, proactive: 0, dynamics: 0, skips: 1, scans: 0 },
      proactiveMissing: true,
    },
  },
}

/* ═══ W5 人设页「无数据」两态 fixture ═══
 * 新端点（/persona/checkup、/persona/history）的**空数据变体**：服务端 200 + ok:true + 空结构，
 * 页面必须渲染「暂无数据」而不是崩或「未找到」。另给一份「概览有、但本轮没注入」的信封。 */
export const PERSONA_CHECKUP_EMPTY = {
  ok: true,
  windowDays: 14,
  n: 0,
  metrics: { medianChars: 0, periodPerComment: 0, emojiRatio: 0, questionRatio: 0, avoidHits: 0 },
  baseline: { medianChars: 27, periodPerComment: 0.109, emojiRatio: 0.417, questionRatio: 0.126 },
  verdict: { level: 'ok', reasons: ['数据不足（最近 0 条，至少 5 条才体检）'] },
  samples: [],
}

export const PERSONA_HISTORY_EMPTY = { ok: true, tags: [] }

/** 概览信封在、但本轮没走卡链路（round.personaInject = null）⇒ 页面「暂无数据」而不是「正在连接…」。 */
export const NO_PERSONA_INJECT_OVERVIEW = {
  ...FIX['/api/bili-fenshen/overview'],
  seq: 1310,
  round: {
    ...FIX['/api/bili-fenshen/overview'].round,
    personaTag: '',
    personaInject: null,
  },
}

/* ═══ W7-2 发言门控 fixture：概览信封 round.speakGate 的四种形态 ═══
 * base FIX 已是 observe+throttle（观察中、不拦）；这里补 null / enforce+normal / forced / 字段半截。
 * 注意：门控**独立于**人设注入——可能这轮没走卡链路，但门控照样有记录（反之亦然）。 */
export const NO_SPEAK_GATE_OVERVIEW = {
  ...FIX['/api/bili-fenshen/overview'],
  seq: 1320,
  round: { ...FIX['/api/bili-fenshen/overview'].round, speakGate: null },
}

/** 强制档 + 正常放行：mode=enforce 必须显示「强制」，不能仍写「观察中」。 */
export const ENFORCE_GATE_OVERVIEW = {
  ...FIX['/api/bili-fenshen/overview'],
  seq: 1321,
  round: {
    ...FIX['/api/bili-fenshen/overview'].round,
    speakGate: {
      mode: 'enforce',
      decision: 'normal',
      reason: '节奏正常（近 5 个动作说了 1 次，距上次 42 分钟）',
      suggestedMaxComments: 2,
      enforced: false,
      features: { recentShare: 0.2, recentWindow: 5, recentSpoke: 1, gapMinutes: 42, pendingReplies: 0 },
    },
  },
}

/** 被回复 / 被 @：直接放行（仍占配额）——门控判定 forced。 */
export const FORCED_GATE_OVERVIEW = {
  ...FIX['/api/bili-fenshen/overview'],
  seq: 1322,
  round: {
    ...FIX['/api/bili-fenshen/overview'].round,
    speakGate: {
      mode: 'enforce',
      decision: 'forced',
      reason: '有 2 条回复还没回，优先回（放行且不收紧）',
      suggestedMaxComments: 2,
      enforced: false,
      features: { recentShare: 0.2, recentWindow: 5, recentSpoke: 1, gapMinutes: 30, pendingReplies: 2 },
    },
  },
}

/** 字段半截：只有 decision，mode/reason/features 都缺 ⇒ 必须退化渲染（不抛错、不渲染 undefined）。 */
export const PARTIAL_GATE_OVERVIEW = {
  ...FIX['/api/bili-fenshen/overview'],
  seq: 1323,
  round: {
    ...FIX['/api/bili-fenshen/overview'].round,
    speakGate: { decision: 'throttle' },
  },
}
