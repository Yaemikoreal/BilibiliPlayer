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
      const fakeSlots = {
        inject(name, reg) {
          injected.push(name)
          const r = reg()
          if (r && typeof r.next === 'function') {
            // main 槽位是生成器：逐个 yield 出 register 结果
            for (const item of r) registered.push(item)
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
const ok = injected.length === 3
  && injected.includes('sidebar.panellist')
  && injected.includes('main')
  && injected.includes('settings.section')
  && registered.every((r) => r.hasComponent)
console.log(ok ? 'SMOKE OK' : 'SMOKE FAIL')
process.exit(ok ? 0 : 1)
