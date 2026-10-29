/**
 * 插件「能被宿主加载」的守卫（2026-10-28 事故回归）。
 *
 * 事故：`speakGateMode` 用了 `z.enum([...])`，而**宿主注入的 `z` 是受限 schema 构造器，没有 `.enum()`**
 * ⇒ 导入期抛 `TypeError: z.enum is not a function` ⇒ 整个插件 entry 失败（`fiberPhase: null`，
 * 控制台显示"插件加载错误"）。而当时 `npm test` **全绿**：单测只 `apply()`，不走宿主的 schema 校验，
 * 所以"测试通过"完全没拦住这类错误。
 *
 * 这类"只有宿主才校验"的东西测不了运行期，但可以**静态锁**住：把宿主允许的 `z.*` 方法列成白名单，
 * 出现新方法就先红，逼人去确认宿主到底支不支持。这个测试很便宜，但能挡住整类事故。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const pluginDir = dirname(dirname(fileURLToPath(import.meta.url)))
const read = (rel) => readFileSync(join(pluginDir, rel), 'utf8')

/** 去掉块注释与整行行注释，避免把"注释里提到的坏用法"算进扫描（本文件注释里就写了 z.enum）。 */
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .filter((line) => !/^\s*\/\//.test(line))
  .join('\n')

/**
 * 宿主注入的 `z` 支持的方法（白名单）。
 * 目前实测可用：object / string / number / natural / boolean / array。
 * 加新方法前必须先在真宿主里验证 —— 否则整个插件会加载失败（不是运行时降级，是导入期挂掉）。
 */
const ALLOWED_Z_METHODS = new Set(['object', 'string', 'number', 'natural', 'boolean', 'array'])

test('index.js 的 config schema 只用宿主支持的 z.* 方法（z.enum 会让插件加载失败）', () => {
  const src = stripComments(read('index.js'))
  const used = new Map()
  for (const m of src.matchAll(/\bz\.([A-Za-z]+)\s*\(/g)) {
    const name = m[1]
    used.set(name, (used.get(name) || 0) + 1)
  }
  assert.ok(used.size > 0, '没找到任何 z.* 用法（文件结构变了？）')
  const illegal = [...used.keys()].filter((k) => !ALLOWED_Z_METHODS.has(k))
  assert.deepEqual(
    illegal, [],
    `config schema 用了宿主不支持的 z.${illegal.join(' / z.')}()。`
    + ' 宿主注入的 z 是受限构造器（实测没有 .enum），用了会在导入期抛 TypeError，'
    + ' 整个插件 entry 加载失败。请改用白名单内的方法（如 z.string() + 运行期收口），或先在真宿主验证。',
  )
})

test('插件入口与 bundle patch 都能被宿主找到（package.json 的三个字段）', () => {
  const pkg = JSON.parse(read('package.json'))
  assert.ok(existsSync(join(pluginDir, pkg.main || 'index.js')), 'main 指向的入口文件必须存在')
  assert.ok(existsSync(join(pluginDir, 'index.js')), 'index.js 必须存在（宿主按 main 加载）')
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml', 'dsh.bundle.patch 必须指向 cordis.patch.yml')
  assert.ok(existsSync(join(pluginDir, 'cordis.patch.yml')), 'cordis.patch.yml 必须存在')
  assert.ok(existsSync(join(pluginDir, 'client.js')), 'client.js 必须存在（dsh.client 平台入口）')
  assert.equal(pkg.dsh?.client?.platform, 'web')
})

test('index.js 的宿主挂载字段导出齐全（缺了插件会"加载成功但什么都不做"）', () => {
  const src = read('index.js')
  assert.match(src, /export\s+(async\s+)?function\s+apply\s*\(/, '必须导出 apply(ctx, config)（宿主按它挂载）')
  for (const must of ['export const inject', 'export const Config']) {
    assert.ok(src.includes(must), `index.js 缺少 \`${must}\`（宿主按它注入服务 / 校验配置）`)
  }
})

test('index.js 的 import 只指向相对路径或 node:（不引入宿主不给的第三方包）', () => {
  const src = read('index.js')
  const imports = [...src.matchAll(/^import[\s\S]*?from\s+'([^']+)'/gm)].map((m) => m[1])
  assert.ok(imports.length > 0)
  const offenders = imports.filter((s) => !(s.startsWith('node:') || s.startsWith('./') || s.startsWith('../')))
  assert.deepEqual(offenders, [], `index.js 引入了非相对/非 node: 的模块：${offenders.join(', ')}`)
})

test('所有相对 import 的目标文件都存在（宿主里缺文件同样是导入期失败）', () => {
  const src = read('index.js')
  const imports = [...src.matchAll(/^import[\s\S]*?from\s+'(\.[^']+)'/gm)].map((m) => m[1])
  assert.ok(imports.length > 0)
  const missing = imports
    .map((rel) => join(pluginDir, rel))
    .filter((p) => !existsSync(p))
  assert.deepEqual(missing, [], `相对 import 目标不存在（插件会在导入期挂掉）：${missing.join(', ')}`)
})
