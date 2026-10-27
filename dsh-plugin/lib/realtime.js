/**
 * 概览推送中枢（设计定稿 §2.2/§2.4）。纯逻辑 + 注入时钟/定时器，可在没有宿主的情况下单测。
 *
 * 解决的两件事：
 * 1. **单一信封**：/overview、SSE 概览帧、tick 帧都出自这里，seq 单调递增，客户端只做「更大」判断；
 * 2. **合并风暴**：agent 一轮结束时会把十几条账本事件在 1 秒内写完，fs.watch 会连续触发；
 *    debounce + 最小间隔把「十几次重算」压成一次。
 *
 * 失败语义：compute 抛错时**保留上一次数据**，只置 degraded（页面显示「数据 Ns 前·正在重连」），
 * 绝不把概览清空——旧数据 + 明确的新鲜度，比空白更有用。
 */
export function createOverviewHub(opts = {}) {
  const compute = opts.compute
  if (typeof compute !== 'function') throw new Error('createOverviewHub 需要 compute()')
  const now = opts.now || Date.now
  const debounceMs = Math.max(0, Number(opts.debounceMs ?? 250))
  const minIntervalMs = Math.max(0, Number(opts.minIntervalMs ?? 800))
  const schedule = opts.schedule || ((fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t })
  const cancel = opts.cancel || ((t) => clearTimeout(t))

  let seq = 0
  let data = null
  let dataUpdatedAt = ''
  let serverTime = ''
  let degraded = false
  let lastError = ''
  let lastComputeAt = 0
  let timer = null
  let dirty = true
  let closed = false
  const subscribers = new Set()

  const envelope = () => ({
    ok: !degraded,
    seq,
    serverTime,
    dataUpdatedAt,
    degraded,
    ...(data || {}),
  })

  const broadcast = (env, reason) => {
    for (const fn of subscribers) {
      try { fn(env, reason) } catch { /* 单个订阅者失败不影响其他 */ }
    }
  }

  const recompute = (reason) => {
    timer = null
    if (closed) return envelope()
    lastComputeAt = now()
    serverTime = new Date(lastComputeAt).toISOString()
    try {
      data = compute()
      dataUpdatedAt = serverTime
      degraded = false
      lastError = ''
    } catch (e) {
      degraded = true
      lastError = String(e?.message ?? e)
    }
    dirty = false
    seq += 1
    const env = envelope()
    broadcast(env, reason)
    return env
  }

  const scheduleRun = (reason) => {
    if (closed) return
    dirty = true
    if (timer) return // 已有待执行的重算：这期间的多次 publish 合并成一次
    const since = now() - lastComputeAt
    const delay = Math.max(debounceMs, minIntervalMs - since, 0)
    timer = schedule(() => recompute(reason), delay)
  }

  return {
    get seq() { return seq },
    /** 读当前信封；从未算过或有未落地的变更时同步重算（/overview 是读接口，不能返回空） */
    view(reason = 'read') {
      if (!data || dirty) {
        if (timer) { cancel(timer); timer = null }
        return recompute(reason)
      }
      return envelope()
    },
    /** 标记有变更；按 debounce/最小间隔合并后重算并推送 */
    publish(reason = 'publish') { scheduleRun(reason) },
    /** 订阅（SSE 用）。返回退订函数。 */
    subscribe(fn) {
      if (typeof fn !== 'function') return () => {}
      subscribers.add(fn)
      return () => subscribers.delete(fn)
    },
    close() {
      closed = true
      if (timer) { cancel(timer); timer = null }
      subscribers.clear()
    },
    stats() { return { seq, degraded, lastError, dataUpdatedAt, pending: !!timer } },
  }
}
