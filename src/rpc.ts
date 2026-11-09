/**
 * 宿主半 RPC：把浏览器半的请求桥接到 CDH 诊断分发器。
 *
 * 通道契约（harness 0.1.5+，0.1.7 验证不变）：
 * - 0.1.5 起 `connection.rpc.handle` 对插件失效，插件 RPC 的唯一正解是
 *   `connection.fetch.register()` 注册 `/api/cdh/<endpoint>` 精确路由
 *   （exact 路由优先于 /api prefix，鉴权与体积上限由 Connection 统一施加）。
 * - 浏览器 transport POST `{ type:'client-request', rpcId, method, payload }`；
 *   本端回 `HTTP 200` + `{ type:'server-response', rpcId, result }`。
 * - result 必须是 `{ ok:true, value }` 或 `{ ok:false, error:{ code, message, details } }`；
 *   code/details 不可省略，浏览器信封校验会拒绝残缺错误。
 * - 业务错误一律 HTTP 200 + 错误分支；错误码用闭合集里的 'bad-request'。
 */
import { CDH_CATEGORIES, type Dispatch } from './service.js'

/** 宿主 connection.fetch 的最小形状（见 harness connection/src/rpc.ts）。 */
export interface HostConnectionFetch {
  register(route: {
    path: string
    methods: readonly ('GET' | 'HEAD' | 'POST')[]
    requestBody: 'buffered' | 'streaming'
    fetch: (request: Request) => Promise<Response>
  }): () => Promise<void>
}

/** 载体中立的 RPC 结果（浏览器 transport 严格要求 code/details）。 */
export type RpcResult =
  | { ok: true; value: unknown }
  | { ok: false; error: { code: string; message: string; details: Record<string, unknown> } }

/** 精确 Fetch 路由的 base（必须在 /api 下）。 */
export const RPC_BASE = '/api/cdh'
/** 端点前缀（rpc.call 的 method 字段）。 */
export const RPC_PREFIX = 'cdh/'

/**
 * 暴露为精确路由的端点。
 *
 * 第一个是 `diagnose`——浏览器半与工具都只用一个万能端点（category+action），
 * 其余是配置页需要的辅助端点。
 */
export const RPC_ENDPOINTS = ['diagnose', 'settings', 'ping'] as const

export type RpcEndpoint = (typeof RPC_ENDPOINTS)[number]

interface ClientRequestEnvelope {
  type?: unknown
  rpcId?: unknown
  method?: unknown
  payload?: unknown
}

function ok(value: unknown): RpcResult {
  return { ok: true, value }
}

/** 把任意异常折叠成合法的 RpcResult 错误分支。 */
export function failure(err: unknown): RpcResult {
  const message = err instanceof Error ? err.message : String(err)
  return { ok: false, error: { code: 'bad-request', message, details: {} } }
}

/** 脱敏配置快照：密码绝不回传。 */
export interface PublicSettings {
  host: string
  port: number
  username: string
  useTls: boolean
  apiVersion: string
  timeoutMs: number
  defaultCluster: string
  yarnRmUrl: string
  yarnJhsUrl: string
  hasPassword: boolean
}

/** 分发器入参：端点 + 参数对象。 */
export function createRpcDispatcher(
  dispatch: Dispatch,
  settings: () => { host: string; port: number; username: string; password: string; useTls: boolean; apiVersion: string; timeoutMs: number; defaultCluster: string; yarnRmUrl: string; yarnJhsUrl: string },
): (endpoint: string, args: Record<string, unknown>) => Promise<RpcResult> {
  return async function rpcDispatch(endpoint, args): Promise<RpcResult> {
    try {
      switch (endpoint) {
        case 'ping':
          return ok({ ok: true })

        case 'settings': {
          const snap = settings()
          const publicSettings: PublicSettings = {
            host: snap.host,
            port: snap.port,
            username: snap.username,
            useTls: snap.useTls,
            apiVersion: snap.apiVersion,
            timeoutMs: snap.timeoutMs,
            defaultCluster: snap.defaultCluster,
            yarnRmUrl: snap.yarnRmUrl,
            yarnJhsUrl: snap.yarnJhsUrl,
            hasPassword: Boolean(snap.password),
          }
          return ok(publicSettings)
        }

        case 'diagnose': {
          const category = typeof args.category === 'string' ? args.category : ''
          const action = typeof args.action === 'string' ? args.action : ''
          if (!category || !action) {
            return failure(
              new Error(`需要 category（${CDH_CATEGORIES.join('/')}）与 action 参数`),
            )
          }
          const rest: Record<string, unknown> =
            typeof args.args === 'object' && args.args !== null ? { ...(args.args as Record<string, unknown>) } : {}
          // category/action 之外的顶层字段也接受（面板直接传扁平参数）
          for (const [key, value] of Object.entries(args)) {
            if (key === 'category' || key === 'action' || key === 'args') continue
            if (!(key in rest)) rest[key] = value
          }
          return ok(await dispatch(category, action, rest))
        }

        default:
          return failure(new Error(`unknown endpoint ${endpoint}`))
      }
    } catch (err) {
      return failure(err)
    }
  }
}

/**
 * 为每个端点注册精确 Fetch 路由，并回填 0.1.5 信封。
 *
 * @returns 解除全部路由的 disposer（幂等）
 */
export function registerRpcRoutes(
  connection: unknown,
  rpcDispatch: (endpoint: string, args: Record<string, unknown>) => Promise<RpcResult>,
  log: (message: string) => void,
): () => void {
  const registry = (connection as { fetch?: Partial<HostConnectionFetch> } | undefined)?.fetch
  if (!registry || typeof registry.register !== 'function') {
    log('connection.fetch registry unavailable; Web client RPC disabled')
    return () => {}
  }
  const register = registry.register.bind(registry)

  const answer = (endpoint: string) => async (request: Request): Promise<Response> => {
    let body: ClientRequestEnvelope
    try {
      body = (await request.json()) as ClientRequestEnvelope
    } catch {
      return new Response('malformed rpc envelope', { status: 400 })
    }
    if (body?.type !== 'client-request' || typeof body.rpcId !== 'string') {
      return new Response('malformed rpc envelope', { status: 400 })
    }
    const rpcId = body.rpcId
    try {
      const payload = (body.payload ?? {}) as { args?: Record<string, unknown> }
      const args = payload.args ?? {}
      const result = await rpcDispatch(endpoint, args)
      return new Response(JSON.stringify({ type: 'server-response', rpcId, result }), {
        headers: { 'content-type': 'application/json' },
      })
    } catch (err) {
      // rpcDispatch 内部已折叠业务错误；到这里说明框架级异常。
      return new Response(`cdh rpc failed: ${err instanceof Error ? err.message : String(err)}`, { status: 500 })
    }
  }

  const disposers: Array<() => unknown> = []
  for (const endpoint of RPC_ENDPOINTS) {
    try {
      const remove = register({
        path: `${RPC_BASE}/${endpoint}`,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: answer(endpoint),
      })
      disposers.push(remove)
    } catch (err) {
      log(`failed to register route ${RPC_BASE}/${endpoint}: ${String(err)}`)
    }
  }

  return () => {
    for (const dispose of disposers) {
      try {
        void dispose()
      } catch {
        // 单个路由解除失败不阻断其余清理
      }
    }
  }
}
