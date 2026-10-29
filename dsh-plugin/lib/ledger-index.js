/**
 * 账本增量读器（W4-1）：把「每次概览/tick 都全量 readFileSync + 全量 sort」变成
 * 「stat 未变 0 次读盘 / size 增大只读增量段 / size 变小全量回退」。
 *
 * 为什么需要：`index.js` 里有 **11 处** `readEvents(...)`（概览、配额、判重清单、接话清单、
 * 轮末盘点…），而 `lib/ledger.js` 的 `readEvents` 每次都是 `readFileSync` 全量读 + 全量 sort。
 * 账本按 5MB 轮转、一天几十条事件，10 万行时单次就是几十 ms；SSE 每帧都重算就会打满 CPU。
 *
 * 三条硬约束（都来自事故与设计）：
 *   1. **语义必须与 readEvents 完全一致**：解析复用 `parseLedgerText`，排序复用 `sortEvents`；
 *   2. **只消费完整行**：半截行（进程被杀 / 正在 append）留在 offset 之前不解析，
 *      下次补齐后再读一遍 —— 否则会把半截 JSON 当坏行丢掉，事件永久丢失；
 *   3. **任何不确定都全量回退**：size 变小（轮转到 .old）、mtime 变了但 size 没变（原地重写）、
 *      文件消失又出现 —— 一律全量重读，并把次数记进 `fallbacks`（首周要能看见它发生了几次）。
 *
 * 纯 IO + 纯记忆，无定时器、无全局状态：一个 file 一个实例。
 */
import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { parseLedgerText, sortEvents } from './ledger.js'

/**
 * @param {string} file 账本绝对路径
 * @returns {{ read: () => Array, stats: () => object }}
 */
export const createLedgerReader = (file) => {
  const counters = {
    calls: 0,          // read() 被调用次数
    cacheHits: 0,      // stat 判定「没变化」⇒ 0 次读盘
    fullReads: 0,      // 全量读盘次数
    incrementalReads: 0, // 只读增量段的次数
    fallbacks: 0,      // 本该增量却被迫全量的次数（轮转/原地重写）
    bytesRead: 0,      // 累计读盘字节数（断言「没变化时 0 次读盘」用）
  }
  let events = []
  let offset = 0      // 已消费的**完整行**字节数
  let sig = ''        // 上次读盘时的签名：`size:mtimeMs`
  let anchor = ''     // 已消费区尾部的 32 字节（hex）：增量读前先核对，防"非 append 写"
  const ANCHOR_LEN = 32

  const statOf = () => {
    try {
      const st = statSync(file)
      return st.isFile() ? st : null
    } catch {
      return null
    }
  }

  const signature = (st) => (st ? `${st.size}:${Math.round(st.mtimeMs)}` : '')

  const readBytes = (from, len) => {
    if (len <= 0) return Buffer.alloc(0)
    const fd = openSync(file, 'r')
    try {
      const buf = Buffer.alloc(len)
      const n = readSync(fd, buf, 0, len, from)
      counters.bytesRead += Math.max(0, n)
      return buf.subarray(0, Math.max(0, n))
    } finally {
      closeSync(fd)
    }
  }

  /** 只取到最后一个换行为止的完整行；返回解析文本与消费字节数。 */
  const completeLines = (buf) => {
    const nl = buf.lastIndexOf(0x0a)
    if (nl < 0) return { text: '', consumed: 0 }
    // 从换行处切 ⇒ 不会把多字节字符切一半（换行是单字节且不可能是 UTF-8 续字节）
    return { text: buf.subarray(0, nl + 1).toString('utf8'), consumed: nl + 1 }
  }

  const anchorOf = (buf, end) => {
    const from = Math.max(0, end - ANCHOR_LEN)
    return buf.subarray(from, end).toString('hex')
  }

  const fullRead = () => {
    counters.fullReads++
    const st = statOf()
    if (!st) {
      events = []
      offset = 0
      sig = ''
      anchor = ''
      return events
    }
    const raw = readBytes(0, st.size)
    const { text, consumed } = completeLines(raw)
    events = sortEvents(parseLedgerText(text))
    offset = consumed
    anchor = anchorOf(raw, consumed)
    sig = signature(st)
    return events
  }

  const read = () => {
    counters.calls++
    const st = statOf()
    const now = signature(st)

    // ① 没变化：一次读盘都不做
    if (sig && now === sig) {
      counters.cacheHits++
      return events
    }
    // ② 文件消失：清空（不保留旧事件，否则会把上一轮的账算到这一轮）
    if (!st) {
      events = []
      offset = 0
      sig = ''
      return events
    }
    // ③ 首次 / 变小（轮转）/ 原地重写（sig 变了但 size 没长）：全量回退
    if (!sig || st.size < offset) {
      if (sig) counters.fallbacks++
      return fullRead()
    }
    // ③b size 与已消费字节相等、签名却变了 ⇒ mtime 变了：说明文件被原地重写/动过，
    //     绝不能当成「没有新增」返回旧缓存（否则概览会一直显示重写前的旧数字）。
    if (st.size === offset) {
      counters.fallbacks++
      return fullRead()
    }
    // ③c 锚点核对：增量读之前先确认「已消费区尾部 32 字节」没被改过。
    //     追加是唯一安全的写模式；如果账本被整体重写且变长（size 变大了），
    //     单看 size 会误判成 append，从而把半个对象当增量读进来。32 字节的核对成本可忽略。
    if (offset >= ANCHOR_LEN && anchor) {
      const probe = readBytes(offset - ANCHOR_LEN, ANCHOR_LEN).toString('hex')
      if (probe !== anchor) {
        counters.fallbacks++
        return fullRead()
      }
    }
    // ④ 追加：只读 offset 之后的字节
    const raw = readBytes(offset, st.size - offset)
    const { text, consumed } = completeLines(raw)
    if (consumed > 0) {
      const added = parseLedgerText(text)
      if (added.length) events = sortEvents(events.concat(added))
      offset += consumed
      // 就地滚动锚点：旧的已消费尾 32 字节 + 本次消费的字节，取最后 32 字节（不再多读一次盘）
      const rolling = Buffer.concat([Buffer.from(anchor || '', 'hex'), raw.subarray(0, consumed)])
      anchor = rolling.subarray(Math.max(0, rolling.length - ANCHOR_LEN)).toString('hex')
      counters.incrementalReads++
    } else {
      // 只有半截行：本次无事可做，等下次补齐
      counters.cacheHits++
    }
    sig = now
    return events
  }

  return {
    file,
    read,
    /** 快照计数（测试/诊断用；不要直接改它）。 */
    stats: () => ({ ...counters, events: events.length, offset }),
    /** 强制下一次 read() 全量重读（配置改路径、手动刷新用）。 */
    invalidate: () => { sig = '' },
  }
}

/** 按文件路径复用同一个实例（一行代码接入；测试里可直接 createLedgerReader）。 */
const registry = new Map()
export const ledgerReaderFor = (file) => {
  const key = String(file || '')
  if (!registry.has(key)) registry.set(key, createLedgerReader(key))
  return registry.get(key)
}
