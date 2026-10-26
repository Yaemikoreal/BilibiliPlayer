/**
 * legacy 直通：旧 `personaPrompt`（一段正文 或 一个文件路径）保持**完全不变**的注入行为。
 *
 * 为什么必须保留：
 *   1. 现在真实配置里 `personaPrompt` 就指向 `prompts/persona-whale.md`，升级不能改它的行为；
 *   2. 用户手写的自由文本人设没有结构，硬迁移只会更差；
 *   3. "改坏了能退回来"是升级的前提。
 * 所以：legacy 路径 = 老加载器（lib/persona.js）+ 老包装格式，一个字节都不动。
 */
import { loadPersona } from '../persona.js'

/** 现有 index.js 的包装格式（改一个字都会改变行为，别动）。 */
export const legacyBlock = (text, note) =>
  text
    ? `\n\n===== 人设${note}（**按这个来说话**）=====\n${text}\n===== 人设结束 =====\n`
    : note
      ? `\n\n⚠️ ${note}\n`
      : '\n\n⭐ 本轮没有拿到人设 ⇒ 按一个独立、有自己判断的普通网友说话，别编人格。\n'

/**
 * @param {string} rawInput 配置里的 personaPrompt（正文或路径）
 * @returns {{text:string, note:string, source:string, block:string}}
 */
export const loadLegacy = (rawInput) => {
  const { text, note, source } = loadPersona(rawInput)
  return { text, note, source, block: legacyBlock(text, note) }
}
