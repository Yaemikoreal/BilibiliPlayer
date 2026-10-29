/**
 * 见闻库：索引常驻（P2）、正文按需读。
 *
 * 为什么不能编译期召回（这条是设计里最硬的约束）：
 *   候选视频是在子进程里"拉内容源"之后才出现的，而 prompt 在 spawn 前就定死了。
 *   World Info 全部机制都发生在编译期（只能匹配已在上下文里的文本），
 *   官方文档还明确"Outlet 宏在角色卡字段里无法展开，因为字段被提前解析"——
 *   凡是"先看到内容才知道要不要用"的信息，只能生成期取用。
 *   所以：prompt 里只放**索引**（我有哪些经历），正文让模型按需 `read`。
 */
import { join } from 'node:path'
import { assetDir } from './store.js'
import { usedToday } from './state.js'

/** 见闻正文的绝对路径（给 agent 读；不在 prompt 里塞正文）。 */
export const lorePath = (id, active) => join(assetDir(active), 'lore', `${id}.md`)

/**
 * 解析索引条目：卡里 `loreIndex[]` 是唯一事实来源，正文文件可缺（缺了就从索引退化）。
 *
 * W3-3：`disabled:true` 的条目默认**不进编译**（等于已删），但控制台回收站需要看到它们，
 * 所以留 `includeDisabled` 读口 —— 编译永远用默认值，列表接口才传 true。
 * @returns {Array<{id,keys,oneLine,usedToday:boolean,disabled:boolean}>}
 */
export const resolveLoreIndex = (card, state = {}, now = new Date(), { includeDisabled = false } = {}) => {
  const list = Array.isArray(card?.loreIndex) ? card.loreIndex : []
  return list
    .filter((l) => l && l.id)
    .filter((l) => includeDisabled || l.disabled !== true)
    .map((l) => ({
      id: String(l.id),
      keys: Array.isArray(l.keys) ? l.keys.map(String) : [],
      oneLine: String(l.oneLine || ''),
      usedToday: usedToday(state?.loreUsed, String(l.id), now),
      disabled: l.disabled === true,
    }))
}

/**
 * 渲染 P2：一行一条。今天用过的排到最后并标注（防止每条评论都讲同一个故事）。
 * @param {Array} entries resolveLoreIndex 的结果
 * @param {{maxItems?: number}} opts
 */
export const renderLoreIndex = (entries, { maxItems = 8, dir = 'persona/lore' } = {}) => {
  const list = (entries || []).slice(0, maxItems)
  if (!list.length) return ''
  const fresh = list.filter((e) => !e.usedToday)
  const used = list.filter((e) => e.usedToday)
  const lines = []
  for (const e of fresh) lines.push(`${e.id} · ${e.keys.slice(0, 4).join('/')} · ${e.oneLine}`)
  if (used.length) lines.push(`今天用过了：${used.map((e) => e.id).join('、')}`)
  // W6-1：正文改由 MCP 工具按需取（`bili_persona_lore(keyword=…)`），不再让模型自己 read 文件。
  // 这样"先看到标题/热评才知道该用哪条"发生在**生成期**，且正文不占 argv 24k 硬线。
  lines.push('→ 写之前把「视频标题 + 字幕要点 + 热评关键词」拼成一句话，调 `bili_persona_lore(keyword=…)` 取正文再写；别凭这一行编细节。')
  return lines.join('\n')
}

/** 见闻条目的轻校验（保存/入库时用）：必须有一行摘要、必须非空。 */
export const validateLoreEntry = (entry) => {
  const errors = []
  if (!entry?.id) errors.push('缺少 id')
  if (!Array.isArray(entry?.keys) || !entry.keys.length) errors.push('缺少 keys')
  if (!entry?.oneLine) errors.push('缺少 oneLine')
  if (entry?.oneLine && entry.oneLine.length > 40) errors.push('oneLine 建议 ≤40 字（索引是常驻预算）')
  return { ok: errors.length === 0, errors }
}
