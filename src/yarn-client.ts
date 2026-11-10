/**
 * YARN Web 只读客户端（ResourceManager REST + JobHistory Server 聚合日志）。
 *
 * 与 CmClient 并列的传输层：连接目标只能来自插件配置（yarnRmUrl / yarnJhsUrl），
 * 运行时不接受传入的 host/URL，避免诊断请求被指到配置之外的主机（同 CM 客户端不变量）。
 *
 * 仅支持免 Kerberos（SPNEGO）的 HTTP 端点：零第三方运行时依赖做不了 SPNEGO，
 * Kerberos 集群请把这两个地址指向免认证反向代理，或只用 CM 侧元数据（yarn/apps）。
 *
 * 通道契约（已对照 Hadoop 源码核实）：
 * - RM：`{rm}/ws/v1/cluster/apps/{id}` 取 diagnostics；`.../appattempts` 取 AM 容器的
 *   nodeId（host:8041）/ containerId / logsLink。
 * - JHS：`{jhs}/jobhistory/logs/{nodeId}/{containerId}/{entity}/{user}/{file}?start=-N`
 *   返回 HTML，日志正文在 <pre> 里（提取/反转义见 analysis.ts）；start 负值表示从末尾取字节。
 */
import { abortedMessage, truncate, withTimeout, type QueryParams } from './cm-client.js'
import { containerLogTailUrl } from './analysis.js'
import type { CdhSettings } from './settings.js'

/** 取 scheme://host:port（忽略路径）：用户粘贴 yarn.log.server.url 带 /jobhistory/logs 也能用。 */
function normalizeOrigin(raw: string, label: string): string {
  const trimmed = raw.trim()
  if (!trimmed) {
    throw new Error(`未配置 ${label}（设置 → 插件 → CDH）`)
  }
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    throw new Error(`${label} 不是合法 URL: "${raw}"（应形如 http://host:port）`)
  }
  return url.origin
}

function buildUrl(base: string, query: QueryParams): string {
  const url = new URL(base)
  for (const [key, value] of query) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value))
  }
  return url.toString()
}

/**
 * 引擎基址归一化：保留 path（RM 代理地址形如 `http://rm:8088/proxy/application_xxx/`，
 * 子路径必须保留），去掉末尾斜杠与查询串。非 http(s) 输入按 http 补全。
 */
function engineBase(raw: string, label: string): string {
  const trimmed = raw.trim()
  if (!trimmed) throw new Error(`未配置 ${label}`)
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    throw new Error(`${label} 不是合法 URL: "${raw}"（应形如 http://host:port）`)
  }
  const path = url.pathname.replace(/\/+$/, '')
  return `${url.origin}${path}`
}

function joinPath(base: string, path: string): string {
  return `${base}/${path.replace(/^\/+/, '')}`
}

/**
 * 读取响应流但只保留末尾 maxBytes：Flink 日志端点一次返回整个文件、不支持 Range，
 * 滚动缓冲可避免大日志（几十/上百 MB）撑爆插件内存；裁切点可能落在多字节字符中间，
 * 由 TextDecoder 以替换字符兜底（日志尾部判读不受影响）。
 */
async function readTail(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) {
    const text = await response.text()
    return text.length > maxBytes ? text.slice(text.length - maxBytes) : text
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let kept = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value || value.length === 0) continue
    chunks.push(value)
    kept += value.length
    while (kept > maxBytes && chunks.length > 0) {
      const first = chunks[0]!
      const excess = kept - maxBytes
      if (first.length <= excess) {
        chunks.shift()
        kept -= first.length
      } else {
        chunks[0] = first.subarray(excess)
        kept -= excess
      }
    }
  }
  const merged = new Uint8Array(kept)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.length
  }
  return new TextDecoder().decode(merged)
}

/** JHS 聚合日志请求参数（entity 缺省等于 containerId，AM 容器亦然）。 */
export interface JhsLogRequest {
  nodeId: string
  containerId: string
  entity: string
  user: string
  file: string
  /** 起始字节偏移；负值表示从文件末尾取（如 -262144 取末尾 256KB）。 */
  start: number
}

/** YARN Web 客户端（每次调用无状态；URL 合法性延迟到使用时校验，配置错误只影响 yarn 分类）。 */
export class YarnClient {
  private rmRaw: string
  private jhsRaw: string
  private sparkHistoryRaw: string
  private readonly timeoutMs: number

  constructor(settings: CdhSettings) {
    this.rmRaw = settings.yarnRmUrl.trim()
    this.jhsRaw = settings.yarnJhsUrl.trim()
    this.sparkHistoryRaw = settings.sparkHistoryUrl.trim()
    this.timeoutMs = settings.timeoutMs
  }

  /**
   * 用 CM 推导值填补未手动配置的地址（手动配置优先，只补空字段）。
   * 推导来源是配置内 CM 集群自身的 yarn-site.xml / 角色 Web UI 地址，不是运行时传入的
   * host/URL，故仍满足「目标只来自插件配置」不变量（目标锁定到所配置集群的节点）。
   */
  fillDerived(rmUrl: string, jhsUrl: string, sparkHistoryUrl = ''): void {
    if (!this.rmRaw && rmUrl.trim()) this.rmRaw = rmUrl.trim()
    if (!this.jhsRaw && jhsUrl.trim()) this.jhsRaw = jhsUrl.trim()
    if (!this.sparkHistoryRaw && sparkHistoryUrl.trim()) this.sparkHistoryRaw = sparkHistoryUrl.trim()
  }

  get hasRm(): boolean {
    return this.rmRaw.length > 0
  }

  get hasJhs(): boolean {
    return this.jhsRaw.length > 0
  }

  get hasSparkHistory(): boolean {
    return this.sparkHistoryRaw.length > 0
  }

  /** 生效的 Spark History Server 地址（可能是手动配置或 CM 推导值）。 */
  get sparkHistoryUrl(): string {
    return this.sparkHistoryRaw
  }

  private async requestText(url: string, accept: string, signal?: AbortSignal): Promise<string> {
    const { signal: merged, cancel } = withTimeout(signal, this.timeoutMs)
    try {
      const response = await fetch(url, { method: 'GET', headers: { Accept: accept }, signal: merged })
      const body = await response.text()
      if (!response.ok) {
        throw new Error(`YARN Web 返回 HTTP ${response.status}: ${truncate(body, 2000)}`)
      }
      return body
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('YARN Web 返回 HTTP')) throw err
      throw new Error(`GET ${url} 失败: ${abortedMessage(signal, err)}`)
    } finally {
      cancel()
    }
  }

  /** ResourceManager REST（`/ws/v1/cluster/<path>`），返回解析后的 JSON。 */
  async rmGet(path: string, query: QueryParams = [], signal?: AbortSignal): Promise<unknown> {
    const url = buildUrl(`${normalizeOrigin(this.rmRaw, 'yarnRmUrl')}/ws/v1/cluster/${path}`, query)
    const text = await this.requestText(url, 'application/json', signal)
    try {
      return JSON.parse(text)
    } catch (err) {
      throw new Error(`解析 ResourceManager JSON 失败: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** JobHistory Server 聚合日志页（HTML 原文，提取纯文本由调用方做）。 */
  async jhsLogHtml(req: JhsLogRequest, signal?: AbortSignal): Promise<string> {
    const base =
      `${normalizeOrigin(this.jhsRaw, 'yarnJhsUrl')}/jobhistory/logs/` +
      [req.nodeId, req.containerId, req.entity, req.user, req.file].map(encodeURIComponent).join('/')
    // user.name 用于非安全模式的伪认证/ACL 校验；Kerberos 集群忽略它（需 SPNEGO，本插件不支持）。
    const url = buildUrl(base, [['start', req.start], ['user.name', req.user]])
    return this.requestText(url, 'text/html', signal)
  }

  /**
   * 引擎 REST 文本请求。maxBytes 为 null 时读全文（JSON 用），否则只保留末尾若干字节
   * （Flink 日志文件端点不支持 Range，只能整文件传输后做滚动尾部）。
   */
  private async engineFetchText(
    url: string,
    accept: string,
    maxBytes: number | null,
    signal?: AbortSignal,
  ): Promise<string> {
    const { signal: merged, cancel } = withTimeout(signal, this.timeoutMs)
    try {
      const response = await fetch(url, { method: 'GET', headers: { Accept: accept }, signal: merged })
      if (!response.ok) {
        const body = await response.text()
        throw new Error(`引擎 REST 返回 HTTP ${response.status}（${url}）: ${truncate(body, 2000)}`)
      }
      return maxBytes === null ? await response.text() : await readTail(response, maxBytes)
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('引擎 REST 返回 HTTP')) throw err
      throw new Error(`GET ${url} 失败: ${abortedMessage(signal, err)}`)
    } finally {
      cancel()
    }
  }

  /**
   * 引擎 Web API 的 JSON（base 可为 RM 代理跟踪地址或 Spark History Server 基址，
   * path 以 `/` 开头，如 `/jobmanager/logs`、`/api/v1/applications/{id}/executors`）。
   */
  async engineGetJson(base: string, path: string, signal?: AbortSignal): Promise<unknown> {
    const url = joinPath(engineBase(base, '引擎地址'), path)
    const text = await this.engineFetchText(url, 'application/json', null, signal)
    try {
      return JSON.parse(text)
    } catch (err) {
      throw new Error(`解析引擎 JSON 失败（${url}）: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** 引擎日志文件正文（只保留末尾 maxBytes，供调用方按行截取）。 */
  async engineTextTail(base: string, path: string, maxBytes: number, signal?: AbortSignal): Promise<string> {
    const url = joinPath(engineBase(base, '引擎地址'), path)
    return this.engineFetchText(url, 'text/plain, */*', maxBytes, signal)
  }

  /**
   * 取 NM / JHS 容器日志页（Spark executorLogs 给出的 URL）。
   * start 负值取末尾字节；user.name 供非安全模式 ACL 校验（不覆盖 URL 已有值）。
   */
  async containerLogHtml(
    rawUrl: string,
    bytes: number,
    user: string,
    signal?: AbortSignal,
  ): Promise<{ url: string; html: string }> {
    const url = containerLogTailUrl(rawUrl, bytes, user)
    const html = await this.engineFetchText(url, 'text/html, */*', Math.max(bytes * 8, 256 * 1024), signal)
    return { url, html }
  }
}