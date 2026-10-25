// dsh-plugin/test/persona.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadPersona, looksLikePath, expandPath, PERSONA_MAX_CHARS } from '../lib/persona.js'

const dir = () => mkdtempSync(join(tmpdir(), 'bf-persona-'))
const preset = (name) => fileURLToPath(new URL(`../prompts/${name}`, import.meta.url))

test('空配置 ⇒ 中性（无 note，不往 prompt 里塞任何东西）', () => {
  const r = loadPersona('')
  assert.deepEqual(r, { text: '', note: '', source: 'inline' })
  assert.deepEqual(loadPersona('   \n '), { text: '', note: '', source: 'inline' })
})

test('普通文字人设 ⇒ 原样返回，不误判成路径', () => {
  const text = '一个二十五六岁的男生，说话短、不客套，偶尔自嘲。'
  const r = loadPersona(text)
  assert.equal(r.source, 'inline')
  assert.equal(r.text, text)
  assert.equal(r.note, '')
})

test('多行文字人设 ⇒ 原样返回', () => {
  const text = '# 人设\n\n- 说话短\n- 不客套'
  const r = loadPersona(text)
  assert.equal(r.text, text)
  assert.equal(r.source, 'inline')
})

test('macOS / Linux 绝对路径 ⇒ 读文件（旧实现会把这个路径当正文注入）', () => {
  const f = join(dir(), 'persona.md')
  writeFileSync(f, '# 鲸鱼娘\n\n开饭了。\n', 'utf8')
  const r = loadPersona(f)
  assert.equal(r.source, 'file')
  assert.match(r.text, /鲸鱼娘/)
  assert.match(r.note, /读自文件/)
})

test('~/ 路径按 home 展开（不再依赖 Windows 的 USERPROFILE）', () => {
  const home = dir()
  mkdirSync(join(home, 'notes'))
  writeFileSync(join(home, 'notes', 'p.md'), '大肥鱼', 'utf8')
  const r = loadPersona('~/notes/p.md', { home })
  assert.equal(r.source, 'file')
  assert.equal(r.text, '大肥鱼')
})

test('路径是目录 ⇒ 读目录下的 AGENTS.md', () => {
  const home = dir()
  writeFileSync(join(home, 'AGENTS.md'), '目录人设', 'utf8')
  const r = loadPersona('~/', { home })
  assert.equal(r.text, '目录人设')
  assert.equal(r.source, 'file')
})

test('路径不存在 ⇒ 降级中性 + 说明（绝不把路径字符串当人设）', () => {
  const r = loadPersona(join(dir(), 'nope.md'))
  assert.equal(r.source, 'missing')
  assert.equal(r.text, '')
  assert.match(r.note, /不存在/)
})

test('目录里没有 AGENTS.md ⇒ 说清楚是目录（不要误报"文件不存在"）', () => {
  const r = loadPersona(dir())
  assert.equal(r.source, 'missing')
  assert.equal(r.text, '')
  assert.match(r.note, /AGENTS\.md/)
})

test('空文件 ⇒ 中性 + 说明', () => {
  const f = join(dir(), 'empty.md')
  writeFileSync(f, '  \n', 'utf8')
  const r = loadPersona(f)
  assert.equal(r.source, 'empty')
  assert.equal(r.text, '')
  assert.match(r.note, /空/)
})

test('超长 ⇒ 截断并标注（旧实现静默截断到 6000）', () => {
  const long = '鱼'.repeat(PERSONA_MAX_CHARS + 50)
  const inline = loadPersona(long)
  assert.equal(inline.text.length, PERSONA_MAX_CHARS)
  assert.match(inline.note, /截断/)

  const f = join(dir(), 'long.md')
  writeFileSync(f, long, 'utf8')
  const fromFile = loadPersona(f)
  assert.equal(fromFile.text.length, PERSONA_MAX_CHARS)
  assert.match(fromFile.note, /读自文件/)
  assert.match(fromFile.note, /截断/)
})

test('仓库内置人设都能被真实加载（且不超截断线）', () => {
  for (const name of ['persona-whale.md', 'persona-elaina.md']) {
    const r = loadPersona(preset(name))
    assert.equal(r.source, 'file', `${name} 应能读到`)
    assert.ok(r.text.length > 200, `${name} 内容不应为空`)
    assert.ok(r.text.length <= PERSONA_MAX_CHARS, `${name} 不应超 ${PERSONA_MAX_CHARS} 字`)
  }
})

test('looksLikePath / expandPath 边界', () => {
  assert.equal(looksLikePath('/Users/x/p.md'), true)
  assert.equal(looksLikePath('~/p.md'), true)
  assert.equal(looksLikePath('C:\\p.md'), true)
  assert.equal(looksLikePath('D:/p.md'), true)
  assert.equal(looksLikePath('一个普通网友'), false)
  assert.equal(looksLikePath('/开头的一句话但含\n换行'), false)
  assert.equal(expandPath('/abs/p.md', '/home/me'), '/abs/p.md')
  assert.equal(expandPath('~', '/home/me'), '~') // 只有 "~/" 才展开
  assert.equal(expandPath('~/p.md', ''), null)
})
