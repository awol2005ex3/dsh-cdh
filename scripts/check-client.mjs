/**
 * 冒烟：浏览器 bundle 契约。
 *
 * 校验 lib/client.js 是「惰性 CJS 闭包工厂」——不含 ESM 语法，
 * 且形如 window.__ModuleLoader__.load({ id, factory })；再用假 window/document
 * 执行 factory，断言其导出 { name, inject, apply }。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const path = new URL('../lib/client.js', import.meta.url)
const code = readFileSync(path, 'utf8')

assert.ok(code.includes('window.__ModuleLoader__.load('), 'client bundle must call __ModuleLoader__.load')
assert.ok(code.includes('"dsh-cdh"') || code.includes("'dsh-cdh'"), 'bundle id must be dsh-cdh')
// tsc 的 export {} 尾部与任何 import/export 语句都会破坏 classic-script 解析
assert.ok(!/^\s*export\s/m.test(code), 'bundle must not contain ESM export statements')
assert.ok(!/^\s*import\s/m.test(code), 'bundle must not contain ESM import statements')

// 最小 DOM 桩：只覆盖 apply 之前的模块体（apply 需要 connection 才会继续）
const noop = () => {}
const fakeElement = () => ({
  style: {},
  dataset: {},
  children: [],
  append: noop,
  appendChild: noop,
  remove: noop,
  addEventListener: noop,
  setAttribute: noop,
  replaceChildren: noop,
  querySelector: () => null,
  querySelectorAll: () => [],
})

let factory = null
const sandbox = {
  window: {
    __ModuleLoader__: {
      load({ id, factory: f }) {
        assert.equal(id, 'dsh-cdh')
        factory = f
      },
    },
  },
  document: {
    createElement: fakeElement,
    createTextNode: () => ({}),
    documentElement: fakeElement(),
    querySelector: () => null,
    body: fakeElement(),
  },
  MutationObserver: class {
    observe() {}
    disconnect() {}
  },
  console,
  setTimeout,
  clearTimeout,
  URL,
  Request,
  Response,
  fetch: noop,
}

const vm = await import('node:vm')
vm.createContext(sandbox)
vm.runInContext(code, sandbox, { filename: 'lib/client.js' })

assert.equal(typeof factory, 'function', 'factory must be registered')
const exported = factory((id) => {
  throw new Error(`bundle must not require(${id}) during load`)
})
assert.equal(exported.name, 'dsh-cdh')
// vm 上下文里的数组原型与宿主不同，比较前先摊平成普通字符串数组。
assert.deepEqual(Array.from(exported.inject), ['connection'])
assert.equal(typeof exported.apply, 'function')

// 没有 connection 时 apply 必须静默退出（宿主端工具照常工作）
assert.doesNotThrow(() => exported.apply({ get: () => undefined }))

console.log('check-client: ok')
