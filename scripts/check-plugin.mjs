/**
 * 冒烟：假 cordis ctx 驱动真实插件（不访问 CDH / 不联网）。
 *
 * 覆盖：4 个导出齐备、路由注册与信封、错误分支、agent 工具注册、disposer 清空。
 */
import assert from 'node:assert/strict'

const effects = []
const routes = new Map()
const tools = []

const logger = Object.assign(
  (scope) => ({
    info: (...args) => console.log(`[info:${scope}]`, ...args),
    warn: (...args) => console.log(`[warn:${scope}]`, ...args),
    error: (...args) => console.log(`[error:${scope}]`, ...args),
  }),
  {
    info: (...args) => console.log('[info]', ...args),
    warn: (...args) => console.log('[warn]', ...args),
    error: (...args) => console.log('[error]', ...args),
  },
)

const services = {
  connection: {
    fetch: {
      register(route) {
        assert.ok(route.path.startsWith('/api/'), `route path must be under /api: ${route.path}`)
        routes.set(route.path, route)
        return async () => {
          routes.delete(route.path)
        }
      },
    },
  },
  tools: {
    register(tool) {
      tools.push(tool)
      return () => {
        const index = tools.indexOf(tool)
        if (index >= 0) tools.splice(index, 1)
      }
    },
  },
}

const ctx = {
  logger,
  get: (name) => services[name],
  effect(fn, label) {
    const dispose = fn()
    effects.push({ label, dispose })
    return dispose
  },
}

const mod = await import('../lib/index.js')
assert.equal(mod.name, 'dsh-cdh')
assert.equal(typeof mod.apply, 'function')
assert.ok(mod.Config, 'Config schema must be exported')
assert.deepEqual([...mod.inject], ['connection', 'tools'])

mod.apply(ctx, { host: 'cm.example.com', port: 7180, username: 'admin', password: 'secret' })

// 路由
assert.deepEqual([...routes.keys()].sort(), ['/api/cdh/diagnose', '/api/cdh/ping', '/api/cdh/settings'])
for (const [path, route] of routes) {
  assert.deepEqual(route.methods, ['POST'], `${path} methods`)
  assert.equal(route.requestBody, 'buffered', `${path} requestBody`)
}

// 工具
assert.equal(tools.length, 1)
assert.equal(tools[0].name, 'cdh')

// 信封：malformed 请求 → 400
const diagnose = routes.get('/api/cdh/diagnose')
const badEnvelope = await diagnose.fetch(new Request('http://localhost/api/cdh/diagnose', { method: 'POST', body: '{}' }))
assert.equal(badEnvelope.status, 400)

// 信封：正常请求 + 未知端点 → ok:false + code/details
const unknown = routes.get('/api/cdh/diagnose')
const response = await unknown.fetch(
  new Request('http://localhost/api/cdh/diagnose', {
    method: 'POST',
    body: JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'cdh/diagnose', payload: { args: {} } }),
  }),
)
assert.equal(response.status, 200)
const envelope = await response.json()
assert.equal(envelope.type, 'server-response')
assert.equal(envelope.rpcId, 'r1')
assert.equal(envelope.result.ok, false)
assert.equal(envelope.result.error.code, 'bad-request')
assert.equal(typeof envelope.result.error.details, 'object')

// ping / settings 正常返回；settings 绝不回传密码
const ping = await routes
  .get('/api/cdh/ping')
  .fetch(
    new Request('http://localhost/api/cdh/ping', {
      method: 'POST',
      body: JSON.stringify({ type: 'client-request', rpcId: 'r2', payload: { args: {} } }),
    }),
  )
assert.deepEqual((await ping.json()).result, { ok: true, value: { ok: true } })

const settingsResponse = await routes
  .get('/api/cdh/settings')
  .fetch(
    new Request('http://localhost/api/cdh/settings', {
      method: 'POST',
      body: JSON.stringify({ type: 'client-request', rpcId: 'r3', payload: { args: {} } }),
    }),
  )
const settingsBody = JSON.stringify((await settingsResponse.json()).result)
assert.ok(!settingsBody.includes('secret'), 'settings 回包不得包含密码明文')
assert.ok(settingsBody.includes('"hasPassword":true'), 'settings 应回报 hasPassword')

// 未知分类 → 业务错误分支（不抛 500）
const badCategory = await routes
  .get('/api/cdh/diagnose')
  .fetch(
    new Request('http://localhost/api/cdh/diagnose', {
      method: 'POST',
      body: JSON.stringify({
        type: 'client-request',
        rpcId: 'r4',
        payload: { args: { category: 'nope', action: 'x' } },
      }),
    }),
  )
assert.equal(badCategory.status, 200)
const badCategoryBody = await badCategory.json()
assert.equal(badCategoryBody.result.ok, false)
assert.match(badCategoryBody.result.error.message, /未知分类/)

// disposer 清空路由与工具
for (const { dispose } of effects.reverse()) {
  if (typeof dispose === 'function') await dispose()
}
assert.equal(routes.size, 0, 'routes must be disposed')
assert.equal(tools.length, 0, 'tools must be disposed')

console.log('check-plugin: ok')
