/**
 * 账本：append-only JSONL。一行一个事件，见设计文档 §4。
 * 所有 IO 都在 try/catch 里——账本写失败绝不能拖垮值班轮。
 */
import { appendFileSync, existsSync, readFileSync, renameSync, statSync } from 'node:fs'

const DEFAULT_ROTATE_BYTES = 5 * 1024 * 1024

export function appendEvents(file, events, opts = {}) {
  if (!Array.isArray(events) || events.length === 0) return 0
  const rotateBytes = opts.rotateBytes ?? DEFAULT_ROTATE_BYTES
  // ⭐ 先轮转、再追加：否则刚写入的事件会被一起卷进 .old，主文件变空
  try {
    if (existsSync(file) && statSync(file).size > rotateBytes) {
      renameSync(file, file + '.old')
    }
  } catch {
    /* 轮转失败不影响主流程 */
  }
  const line = events.map((e) => JSON.stringify(e)).join('\n') + '\n'
  try {
    appendFileSync(file, line, 'utf8')
  } catch {
    return 0
  }
  return events.length
}

/**
 * 从一段文本里逐个捞出顶层的 JSON 对象（字符串/转义敏感）。
 *
 * 为什么需要：章程要求"一行一个事件"，但 Agent 手写账本时会一个物理行塞进多个对象
 * （2026-10-25 实测：5 行装了 57 个对象）。旧实现 `JSON.parse(line)` 一失败就整行丢弃，
 * 于是**整行事件全部消失**——当天评论/动态事件恰好都写在这种合并行里，导致宿主下发的
 * 「今天已评 0」与实际 4 条不符，值班轮为此空转 118 行推理（见 docs/analysis/2026-10-25-log-findings.md §2.2/§5.1）。
 * 宁可多救回几条事件，也不要让一行格式不整把整批账销掉。
 */
const salvageObjects = (line) => {
  const out = []
  let depth = 0
  let start = -1
  let inStr = false
  let esc = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') { inStr = true; continue }
    if (ch === '{') { if (depth === 0) start = i; depth += 1; continue }
    if (ch === '}') {
      if (depth > 0) depth -= 1
      if (depth === 0 && start >= 0) {
        try { out.push(JSON.parse(line.slice(start, i + 1))) } catch { /* 这一段坏了就丢这一段 */ }
        start = -1
      }
    }
  }
  return out
}

/** 账本事件的统一排序口径（时间字符串升序；Node 的 sort 是稳定排序）。 */
export const sortEvents = (list) => [...list].sort((a, b) => String(a.t || '').localeCompare(String(b.t || '')))

/**
 * 把一段账本文本解析成事件数组（**不排序**）。
 *
 * 单独抽出来是为了让增量读（lib/ledger-index.js）与全量读共用**同一套解析器**：
 * 两套解析逻辑早晚会漂移，而账本里每一行都可能是「一行塞多个对象」的脏数据。
 */
export const parseLedgerText = (text) => {
  const out = []
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim()
    if (!line) continue
    let one = null
    try { one = JSON.parse(line) } catch { one = null }
    const candidates = one && typeof one === 'object' ? [one] : salvageObjects(line)
    for (const ev of candidates) {
      if (ev && typeof ev === 'object' && typeof ev.type === 'string') out.push(ev)
    }
  }
  return out
}

export function readEvents(file) {
  let text = ''
  try {
    if (!existsSync(file)) return []
    text = readFileSync(file, 'utf8')
  } catch {
    return []
  }
  return sortEvents(parseLedgerText(text))
}

export function isDuplicate(existing, candidate) {
  const key = (e) =>
    [e.bvid || '', e.type || '', e.type === 'like' ? '' : (e.text || '')].join('\u0000')
  return existing.some((e) => key(e) === key(candidate))
}
