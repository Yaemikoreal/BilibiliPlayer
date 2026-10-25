/**
 * 人设加载：`personaPrompt` 既可以是普通文字，也可以是一个文件路径。
 *
 * 为什么单独一层：控制台承诺"也可填一个文件路径"，但旧实现只认 Windows 盘符与 `~/`，
 * 且 `~/` 用 `process.env.USERPROFILE` 展开（Windows 专用）——macOS / Linux 上
 * `/Users/x/persona.md` 会被当成人设**正文**直接注入 prompt，`~/x.md` 则展开成 `/x.md` 后读不到。
 * 这里统一处理：
 *   1. 路径形态：`/…`、`~/…`、`…/…`（Windows 盘符）；
 *   2. 目录：读该目录下的 AGENTS.md；
 *   3. 读不到 / 空文件：给出明确 note，调用方降级为中性（绝不把路径字符串当人设）；
 *   4. 超长：截到 PERSONA_MAX_CHARS 并在 note 里标明（旧实现是静默截断）。
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

export const PERSONA_MAX_CHARS = 6000

/** 只有"单行且长得像路径"才按路径处理：普通一句话人设（中文、标点、表情）不受影响。 */
export const looksLikePath = (raw) => {
  const s = String(raw || '').trim()
  if (!s || s.includes('\n')) return false
  if (s.startsWith('/')) return true // POSIX 绝对路径（macOS / Linux）
  if (s.startsWith('~/') || s.startsWith('~\\')) return true // Home 展开
  return /^[A-Za-z]:[\\/]/.test(s) // Windows 盘符
}

/** `~/x` → `<home>/x`；其余（含裸 `~`）原样返回。home 缺失时返回 null（无法展开）。 */
export const expandPath = (raw, home) => {
  const s = String(raw || '').trim()
  if (!s.startsWith('~/') && !s.startsWith('~\\')) return s
  if (!home) return null
  return join(home, s.slice(2)) // 去掉开头的 "~/" 或 "~\"
}

const homeOf = () => process.env.HOME || process.env.USERPROFILE || ''

/**
 * 解析人设字段。
 * @returns {{text: string, note: string, source: 'inline'|'file'|'missing'|'empty'}}
 *   - 普通文字：source=inline，note 为空；
 *   - 文件：source=file，note 以 `（读自文件…）` 说明来源；
 *   - 失败：text 为空、note 说明原因（调用方据此降级为中性并在日志里提示）。
 */
export function loadPersona(rawInput, { home = homeOf(), maxChars = PERSONA_MAX_CHARS } = {}) {
  const raw = String(rawInput || '').trim()
  if (!raw) return { text: '', note: '', source: 'inline' }
  if (!looksLikePath(raw)) {
    // 普通文字：原样返回；超长同样截断（旧实现是静默截断，这里给出 note）
    if (raw.length > maxChars) {
      return { text: raw.slice(0, maxChars), note: `（超过 ${maxChars} 字已截断）`, source: 'inline' }
    }
    return { text: raw, note: '', source: 'inline' }
  }

  const target = expandPath(raw, home)
  if (!target) return { text: '', note: `人设路径无法展开：${raw}（本轮按中性说话）`, source: 'missing' }

  let file = existsSync(target) ? target : null
  let wasDir = false
  if (file && statSync(file).isDirectory()) {
    wasDir = true
    file = join(file, 'AGENTS.md')
  }
  if (!file || !existsSync(file) || !statSync(file).isFile()) {
    const why = wasDir ? `人设目录里没有 AGENTS.md：${raw}` : `人设文件不存在：${raw}`
    return { text: '', note: `${why}（本轮按中性说话）`, source: 'missing' }
  }

  let text = ''
  try {
    text = readFileSync(file, 'utf8').trim()
  } catch {
    return { text: '', note: `人设文件读不了：${raw}（本轮按中性说话）`, source: 'missing' }
  }
  if (!text) return { text: '', note: `人设文件是空的：${raw}（本轮按中性说话）`, source: 'empty' }

  if (text.length > maxChars) {
    return { text: text.slice(0, maxChars), note: `（读自文件，超过 ${maxChars} 字已截断）`, source: 'file' }
  }
  return { text, note: '（读自文件）', source: 'file' }
}
