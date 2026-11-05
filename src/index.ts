// @dsh-version 0.1.7-rc.2
/**
 * dsh-cdh · 宿主半（Node / Cordis 插件）。
 *
 * 职责：
 * 1. 经 `connection.fetch.register()` 注册 `/api/cdh/<endpoint>` 精确路由
 *    （0.1.5 起 rpc.handle 对插件失效，这是插件 RPC 的唯一正解）；
 * 2. 注册 `cdh` agent 工具（与浏览器半共用同一个分发器、同一条校验与错误路径）。
 *
 * 浏览器半（lib/client.js）通过 `connection.rpc.call('/api', 'cdh/<endpoint>', …)`
 * 调用这里注册的路由。
 *
 * 配置（host/port/username/password/…）全部来自 `Config` 的 volatile 字段，
 * 每次请求现读，设置页改完即生效（无需重启）。
 */
import type { Context } from '@deepseek-ai/cordis'

import { CdhConfigSchema, readCdhSettings, type CdhConfig } from './settings.js'
import { createDispatcher } from './service.js'
import { createRpcDispatcher, registerRpcRoutes } from './rpc.js'
import { createCdhTool } from './tool.js'
import { registerBuiltinSkills } from './skill.js'

/** Plugin id — must be unique within the composed plugin tree. */
export const name = 'dsh-cdh'

/** Declare the host services this plugin needs; the loader waits for them. */
export const inject = ['connection', 'tools'] as const

/**
 * 插件配置 schema（dsh ≥ 0.1.7 的配置载体）。
 * volatile 字段改动不重挂插件：loader 原地更新引用并广播 loader/volatile-update；
 * 本插件所有请求都现读配置（readCdhSettings），无需监听也能生效。
 */
export const Config = CdhConfigSchema

export function apply(ctx: Context, config: CdhConfig): void {
  const logger = ctx.logger('cdh')

  // volatile 配置现读快照器：每次请求现取，引用不变、值在变。
  const settings = () => readCdhSettings(config)

  // ── RPC 分发器（浏览器半 + agent 工具共用） ───────────────────────────────
  const dispatch = createDispatcher(settings)
  const rpcDispatch = createRpcDispatcher(dispatch, settings)

  // ── 注册 Fetch 精确路由（ctx.effect 保证 HMR/卸载可逆） ───────────────────
  const connection = ctx.get('connection')
  ctx.effect(() => {
    const dispose = registerRpcRoutes(connection, rpcDispatch, (message) => logger.warn('dsh-cdh: %s', message))
    logger.info('dsh-cdh: /api/cdh/* routes registered')
    return dispose
  }, 'cdh: rpc routes')

  // ── 注册 agent 工具 ──────────────────────────────────────────────────────
  ctx.effect(() => {
    // tools 服务由 loader 提供；ctx.get 兼容测试替身，属性访问只适用于真实 cordis。
    const tools =
      (ctx as unknown as { get?: (n: string) => unknown }).get?.('tools') ??
      (ctx as unknown as { tools?: { register: unknown } }).tools
    const registry = tools as { register: (t: unknown) => unknown } | undefined
    if (!registry || typeof registry.register !== 'function') {
      logger.warn('dsh-cdh: tools registry unavailable; agent tool not registered')
      return () => {}
    }
    logger.info('dsh-cdh: cdh agent tool registered')
    const dispose = registry.register(createCdhTool(dispatch)) as () => void
    return () => {
      dispose()
    }
  }, 'cdh: agent tool')

  // ── 内置 skills（CPU/内存/IO/内核/JVM OOM 排查 + tsquery 语法）─────────────
  // 走 ctx.inject(['skills']) 延迟装配：skills 服务缺席时只降级掉这些增强功能，
  // 不影响上面的 RPC 路由与 cdh 工具（故不写进顶层 inject）。
  registerBuiltinSkills(ctx)
}
