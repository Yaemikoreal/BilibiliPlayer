// 临时冒烟测试：验证 client.js 在 Node 里能加载、factory 执行、三个槽位注册成功。
// React 用最小桩（createElement 等只被引用不真正渲染）；document 不存在时 ensureStyle 自动跳过。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const pluginDir = dirname(dirname(fileURLToPath(import.meta.url)))

const ReactStub = {
  createElement: (...args) => ({ __el: args }),
  Fragment: 'Fragment',
  useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
}

const registered = []
const injected = []

globalThis.window = {
  __ModuleLoader__: {
    load(def) {
      const fakeRequire = (spec) => {
        if (spec === 'react') return ReactStub
        throw new Error('unexpected require: ' + spec)
      }
      const plugin = def.factory(fakeRequire)
      // 模拟宿主调用 apply
      // ⭐ 真实 slots 语义：inject 效果回调返回 register 的 disposer（普通回调）；生成器不是合法 disposer。
      const fakeSlots = {
        inject(name, reg) {
          injected.push(name)
          const r = reg()
          if (r && typeof r.next === 'function') {
            injected.push('⚠️ GENERATOR（真实宿主不认！）')
          } else if (r) {
            registered.push(r)
          }
        },
        register(def2, comp) {
          return { ...def2, hasComponent: typeof comp === 'function' }
        },
      }
      const fakeCtx = { slots: fakeSlots, get: () => null, layout: undefined }
      plugin.apply(fakeCtx)
      return plugin
    },
  },
}

// 执行 client.js（ESM 不可直接 eval —— 它是 CJS 风格的 window.__ModuleLoader__.load）
const code = readFileSync(join(pluginDir, 'client.js'), 'utf8')
// 用 Function 而非 eval，作用域隔离
new Function('window', code)(globalThis.window)

console.log('injected slots:', injected.join(', '))
console.log('registered:', JSON.stringify(registered))

/* ── 源码级回归守卫 ──
   下面几处是纯浏览器行为（SSE 帧序、flex 布局、hook 解包），Node 里跑不出来，
   用最小源码断言防止被后来的重构悄悄改回去（2026-10-28 控制台事故）。 */
const mustHave = [
  ['首帧无条件接受（seq 守卫只在有数据后生效）', /if \(r\.hasData && seq <= r\.seq\) return false/],
  ['tick 允许与当前信封同 seq（守卫含 r.hasData 前提）', /Number\.isFinite\(seq\) && r\.hasData && seq < r\.seq\) return/],
  ['wide 行纵向堆叠（防 label 竖排）', /\.bf-row-wide\{flex-direction:column/],
  ['Row 输出 bf-row-wide 类名', /bf-row\$\{wide \? ' bf-row-wide' : ''\}/],
  ['收赞按 likesAvailable 显无数据源', /likesAvailable !== false/],
]
const missed = mustHave.filter(([, re]) => !re.test(code)).map(([name]) => name)
for (const name of missed) console.log('MISSING:', name)

/* ── 反向守卫：应该被删掉的东西不许回来（先剥掉行注释，注释里提到不算复活） ──
 * 2026-10-29 起：人设唯一编辑入口 = 人设页「回滚出口：legacy 直通」（d274330），
 * 所以这里只禁「设置页的旧 personaPrompt 分组」复活，不禁人设页的回滚出口本身；
 * 设置页不含人设编辑入口由 render-smoke 的页面级断言守（settingsContent 不含「人设提示词」）。 */
const codeNoComments = code.replace(/^\s*\/\/.*$/gm, '')
const mustNotHave = [
  ['设置页旧 personaPrompt 分组（personaPromptGroup）', /personaPromptGroup/],
  ['设置页旧「人设提示词」textarea（aria-label 精确匹配，人设页回滚出口是「旧人设提示词（legacy）」不算）', /'aria-label': '人设提示词'/],
]
const resurrected = mustNotHave.filter(([, re]) => re.test(codeNoComments)).map(([name]) => name)
for (const name of resurrected) console.log('SHOULD BE GONE:', name)

const ok = injected.length === 3
  && injected.includes('sidebar.panellist')
  && injected.includes('main')
  && injected.includes('settings.section')
  && registered.every((r) => r.hasComponent)
  && missed.length === 0
  && resurrected.length === 0
console.log(ok ? 'SMOKE OK' : 'SMOKE FAIL')
process.exit(ok ? 0 : 1)
