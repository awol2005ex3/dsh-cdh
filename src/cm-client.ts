/**
 * Cloudera Manager REST API 客户端。
 *
 * 对应参考实现 `cdh_diagnosis_mcp/src/cm_client.rs`：Basic Auth + URL 拼装 +
 * 查询参数 + JSON/文本响应。使用 Node 内置 fetch（Node ≥ 22），无第三方依赖。
 *
 * 连接目标只能来自插件配置（设置 → 插件 → CDH），运行时不可改写，避免诊断
 * 请求被指到配置之外的主机。
 */
import type { CdhSettings } from './settings.js'

/** CM 返回的业务错误（HTTP 非 2xx / 网络失败），消息可直接回显给模型。 */
export class CmError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
    this.name = 'CmError'
  }
}

/** 已解析的 CM 连接信息（host 里允许自带端口，配置端口作为兜底）。 */
interface ResolvedTarget {
  origin: string
  apiVersion: string
  authHeader: string
  timeoutMs: number
}

function resolveTarget(settings: CdhSettings): ResolvedTarget {
  const scheme = settings.useTls ? 'https' : 'http'
  const rawHost = settings.host.replace(/^https?:\/\//i, '').replace(/\/+$/, '')
  // host 自带端口时以它为准（面板只填 `cm.example.com:7180` 也能用）。
  const hasPort = /:\d+$/.test(rawHost) || rawHost.startsWith('[')
  const hostPart = hasPort ? rawHost : `${rawHost}:${settings.port}`
  const credentials = Buffer.from(`${settings.username}:${settings.password}`, 'utf8').toString('base64')
  return {
    origin: `${scheme}://${hostPart}`,
    apiVersion: settings.apiVersion,
    authHeader: `Basic ${credentials}`,
    timeoutMs: settings.timeoutMs,
  }
}

/** 把外部 signal 与超时合并成一个 AbortSignal。 */
export function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`请求超时（${timeoutMs}ms）`)), timeoutMs)
  const onAbort = () => controller.abort(signal?.reason)
  if (signal) {
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  return {
    signal: controller.signal,
    cancel: () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    },
  }
}

export function abortedMessage(signal: AbortSignal | undefined, error: unknown): string {
  if (signal?.aborted) return '请求已取消'
  const reason = (error as { cause?: unknown })?.cause
  return reason instanceof Error ? reason.message : error instanceof Error ? error.message : String(error)
}

/** Cloudera Manager REST 客户端（每次调用无状态）。 */
export class CmClient {
  private readonly target: ResolvedTarget

  constructor(settings: CdhSettings) {
    if (!settings.host) throw new CmError('未配置 Cloudera Manager 主机（设置 → 插件 → CDH）')
    this.target = resolveTarget(settings)
  }

  /** 基础 URL（不含 /api 路径），用于结果回显与连通性提示。 */
  get baseUrl(): string {
    return this.target.origin
  }

  /** 当前使用的 API 版本。 */
  get apiVersion(): string {
    return this.target.apiVersion
  }

  /** 拼接完整的 API URL。 */
  apiUrl(path: string): string {
    return `${this.target.origin}/api/${this.target.apiVersion}/${path.replace(/^\/+/, '')}`
  }

  private buildUrl(path: string, query: QueryParams): string {
    const url = new URL(this.apiUrl(path))
    for (const [key, value] of query) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value))
    }
    return url.toString()
  }

  private async send(
    method: string,
    url: string,
    signal: AbortSignal | undefined,
    body?: unknown,
  ): Promise<Response> {
    const { signal: merged, cancel } = withTimeout(signal, this.target.timeoutMs)
    try {
      return await fetch(url, {
        method,
        headers: {
          Authorization: this.target.authHeader,
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: merged,
      })
    } catch (err) {
      throw new CmError(`${method} ${url} 失败: ${abortedMessage(signal, err)}`)
    } finally {
      cancel()
    }
  }

  /** 发起 JSON 请求并解析响应体；204 返回 null。 */
  async request(
    method: string,
    path: string,
    query: QueryParams = [],
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const url = this.buildUrl(path, query)
    const response = await this.send(method, url, signal, body)
    if (response.status === 204) return null
    const textBody = await response.text()
    if (!response.ok) {
      throw new CmError(`Cloudera Manager 返回 HTTP ${response.status}: ${truncate(textBody, 2000)}`, response.status)
    }
    if (!textBody.trim()) return null
    try {
      return JSON.parse(textBody)
    } catch (err) {
      throw new CmError(`解析 JSON 响应失败: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** 发起请求并以纯文本返回（角色日志、配置文件、/api/version 等非 JSON 端点）。 */
  async requestText(
    method: string,
    path: string,
    query: QueryParams = [],
    signal?: AbortSignal,
  ): Promise<string> {
    const url = this.buildUrl(path, query)
    const response = await this.send(method, url, signal)
    const textBody = await response.text()
    if (!response.ok) {
      throw new CmError(`Cloudera Manager 返回 HTTP ${response.status}: ${truncate(textBody, 2000)}`, response.status)
    }
    return textBody
  }

  /**
   * 服务端“最高支持的 API 版本”，纯文本（如 `v41`）。
   * 该端点不在版本前缀下：`/api/version`。
   */
  async serverApiVersion(signal?: AbortSignal): Promise<string | undefined> {
    try {
      const url = `${this.target.origin}/api/version`
      const response = await this.send('GET', url, signal)
      if (!response.ok) return undefined
      const body = (await response.text()).trim()
      return body || undefined
    } catch {
      // 仅作提示，失败不影响主流程。
      return undefined
    }
  }

  get(path: string, query: QueryParams = [], signal?: AbortSignal): Promise<unknown> {
    return this.request('GET', path, query, undefined, signal)
  }

  post(path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
    return this.request('POST', path, [], body, signal)
  }

  put(path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
    return this.request('PUT', path, [], body, signal)
  }

  delete(path: string, signal?: AbortSignal): Promise<unknown> {
    return this.request('DELETE', path, [], undefined, signal)
  }
}

/** 查询参数：值可为字符串/数字/布尔，空值调用方负责过滤。 */
export type QueryParams = ReadonlyArray<readonly [string, string | number | boolean | undefined | null]>

/** 文本截断（错误体/日志体过大时避免撑爆上下文）。 */
export function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}…[截断，共 ${text.length} 字符]`
}
