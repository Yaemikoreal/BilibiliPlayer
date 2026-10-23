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

export function readEvents(file) {
  let text = ''
  try {
    if (!existsSync(file)) return []
    text = readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const out = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    try {
      const ev = JSON.parse(line)
      if (ev && typeof ev === 'object' && typeof ev.type === 'string') out.push(ev)
    } catch {
      /* 损坏行跳过 */
    }
  }
  out.sort((a, b) => String(a.t || '').localeCompare(String(b.t || '')))
  return out
}

export function isDuplicate(existing, candidate) {
  const key = (e) =>
    [e.bvid || '', e.type || '', e.type === 'like' ? '' : (e.text || '')].join('\u0000')
  return existing.some((e) => key(e) === key(candidate))
}
