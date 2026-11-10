/**
 * CDH 诊断业务层。
 *
 * 与参考实现 `cdh_diagnosis_mcp` 的 8 个分类工具一一对应：
 * connection / cluster / service / host / role / events / metrics / diagnosis。
 * 浏览器半 RPC 与 agent 工具共用同一分发器（`createDispatcher`），
 * 校验、错误折叠、配置解析只实现一次。
 */
import { CmClient, CmError, truncate, type QueryParams } from './cm-client.js'
import { YarnClient } from './yarn-client.js'
import {
  analyzeHealthChecks,
  bool,
  buildEventQuery,
  deriveYarnUrlsFromProps,
  extractErrorLines,
  extractLogText,
  flinkLogFiles,
  flinkTaskManagerIds,
  hostStatusIssue,
  itemsOf,
  latestAttempt,
  latestValue,
  metricLatest,
  num,
  obj,
  parseAggregatedLogsPath,
  parseHadoopConfigXml,
  parseSeverity,
  ratioPercent,
  resolveClusterName,
  rmAppAttempts,
  runStateIssue,
  sparkExecutors,
  str,
  webappAddressToUrl,
  type EngineLogFile,
  type HealthProblem,
  type Severity,
} from './analysis.js'
import type { CdhSettings } from './settings.js'

/** 角色日志/配置文件返回的最大字符数（避免撑爆模型上下文）。 */
const MAX_TEXT_CHARS = 512 * 1024

/** 心跳超时阈值（秒）；CM 默认约 15 秒一次心跳。 */
const HEARTBEAT_STALE_SECONDS = 60

/** 诊断分类。 */
export const CDH_CATEGORIES = [
  'connection',
  'cluster',
  'service',
  'host',
  'role',
  'events',
  'metrics',
  'diagnosis',
  'yarn',
] as const

export type CdhCategory = (typeof CDH_CATEGORIES)[number]

/** 每个分类支持的 action（同时作为工具描述的事实来源）。 */
export const CDH_ACTIONS: Record<CdhCategory, readonly string[]> = {
  connection: ['test', 'version'],
  cluster: ['list', 'get', 'diagnose', 'hosts'],
  service: ['list', 'get', 'diagnose'],
  host: ['list', 'get', 'diagnose'],
  role: ['list', 'diagnose', 'logs', 'config_file'],
  events: ['query', 'alerts', 'build_query'],
  metrics: ['query', 'list', 'service', 'host'],
  diagnosis: ['overview', 'hdfs', 'yarn', 'impala', 'command_status', 'command_logs'],
  yarn: ['apps', 'app', 'attempts', 'logs', 'flink_logs', 'spark_logs', 'diagnose'],
}

/** 分发器（浏览器 RPC 与 agent 工具共用）。 */
export type Dispatch = (category: string, action: string, args: Record<string, unknown>) => Promise<unknown>

interface Context {
  client: CmClient
  yarn: YarnClient
  settings: CdhSettings
  signal?: AbortSignal
  /** 非致命的降级提示（例如指标名失效） */
  warnings: string[]
}

/** 单实体诊断项。 */
interface Issue {
  check: string
  severity: string
  explanation: string
}

/** 读取必填字符串参数。 */
function requireStr(args: Record<string, unknown>, key: string, hint?: string): string {
  const value = str(args[key]).trim()
  if (!value) throw new Error(`缺少 ${key} 参数${hint ? `（${hint}）` : ''}`)
  return value
}

function severityRank(severity: string): number {
  switch (severity.toUpperCase()) {
    case 'CRITICAL':
      return 0
    case 'ERROR':
      return 1
    case 'IMPORTANT':
      return 2
    default:
      return 3
  }
}

/** 按行截取末尾 N 行。 */
function tailLines(text: string, lines: number): { total: number; lines: string[] } {
  const all = text.split(/\r?\n/)
  // 末尾换行会产生一个空元素，丢掉以免 returnedLines 多算一行
  if (all.length > 0 && all[all.length - 1] === '') all.pop()
  const start = Math.max(0, all.length - lines)
  return { total: all.length, lines: all.slice(start) }
}

/** 安全查询时序指标：单个指标名失效不应拖垮整个诊断。 */
async function safeTimeseries(
  ctx: Context,
  tsquery: string,
): Promise<unknown | undefined> {
  try {
    const query: QueryParams = [['query', tsquery]]
    return await ctx.client.get('/timeseries', query, ctx.signal)
  } catch (err) {
    ctx.warnings.push(`指标查询失败（tsquery=\`${tsquery}\`）：${err instanceof Error ? err.message : String(err)}`)
    return undefined
  }
}

/* ── connection ─────────────────────────────────────────────────────────── */

async function connectionAction(ctx: Context, action: string): Promise<unknown> {
  switch (action) {
    case 'test': {
      const cmVersion = await ctx.client.get('/cm/version', [], ctx.signal)
      const maxApiVersion = await ctx.client.serverApiVersion(ctx.signal)
      const configured = ctx.client.apiVersion
      const hint =
        maxApiVersion === undefined
          ? ' 无法读取服务端最高 API 版本（需 v30+ 的 /api/version）。'
          : maxApiVersion === configured
            ? ' 当前 api_version 与服务端最高版本一致。'
            : ` 注意：服务端最高支持 ${maxApiVersion}，本插件配置为 ${configured}` +
              `（默认 v41 适配 CDH 7.1.7 / CM 7.1.x）；版本不符可在设置里改 apiVersion。`
      return {
        connected: true,
        baseUrl: ctx.client.baseUrl,
        cmVersion,
        configuredApiVersion: configured,
        maxSupportedApiVersion: maxApiVersion ?? null,
        message: `Cloudera Manager 连接与认证成功。${hint}`,
      }
    }

    case 'version':
      return ctx.client.get('/cm/version', [], ctx.signal)

    default:
      throw new Error(`connection 不支持 action=${action}`)
  }
}

/* ── cluster ────────────────────────────────────────────────────────────── */

async function clusterName(ctx: Context, args: Record<string, unknown>): Promise<string> {
  return resolveClusterName(
    () => ctx.client.get('/clusters', [], ctx.signal),
    ctx.settings.defaultCluster,
    str(args.cluster_name),
  )
}

async function clusterAction(ctx: Context, action: string, args: Record<string, unknown>): Promise<unknown> {
  switch (action) {
    case 'list':
      return ctx.client.get('/clusters', [], ctx.signal)

    case 'get': {
      const name = await clusterName(ctx, args)
      return ctx.client.get(`/clusters/${encodeURIComponent(name)}`, [], ctx.signal)
    }

    case 'hosts': {
      const name = await clusterName(ctx, args)
      // lastHeartbeat / healthSummary 等字段需 full 视图（CM 文档标注 Requires "full" view）
      return ctx.client.get(`/clusters/${encodeURIComponent(name)}/hosts`, [['view', 'full']], ctx.signal)
    }

    case 'diagnose': {
      const name = await clusterName(ctx, args)
      const cluster = await ctx.client.get(`/clusters/${encodeURIComponent(name)}`, [], ctx.signal)
      const servicesResp = await ctx.client.get(`/clusters/${encodeURIComponent(name)}/services`, [], ctx.signal)

      const badServices: unknown[] = []
      const concerningServices: unknown[] = []
      const stoppedServices: string[] = []
      const staleServices: string[] = []
      const serviceItems = itemsOf(servicesResp)

      for (const svc of serviceItems) {
        const row = obj(svc)
        const serviceName = str(row.name, '?')
        const health = analyzeHealthChecks(row)
        const state = str(row.serviceState, 'UNKNOWN')
        const stale = bool(row.configStale)
        const entry = {
          name: serviceName,
          serviceType: str(row.type),
          healthSummary: health.healthSummary,
          serviceState: state,
          configStale: stale,
          problemCount: health.problemCount,
          problems: health.problems,
        }
        if (health.healthSummary === 'BAD') badServices.push(entry)
        else if (health.healthSummary === 'CONCERNING') concerningServices.push(entry)
        // NA = 无状态服务（如纯 client 组件），从不"启动"，不列入未运行清单
        if (state.toUpperCase() !== 'STARTED' && state.toUpperCase() !== 'NA') stoppedServices.push(serviceName)
        if (stale) staleServices.push(serviceName)
      }

      const overall: Severity =
        badServices.length > 0 ? 'BAD' : concerningServices.length > 0 ? 'CONCERNING' : 'GOOD'

      return {
        clusterName: name,
        overallHealth: overall,
        clusterHealth: analyzeHealthChecks(cluster),
        serviceSummary: {
          total: serviceItems.length,
          bad: badServices.length,
          concerning: concerningServices.length,
          stopped: stoppedServices,
          configStale: staleServices,
        },
        badServices,
        concerningServices,
        message:
          overall === 'GOOD'
            ? `集群 ${name} 服务整体健康`
            : `集群 ${name} 存在异常：${badServices.length} 个 BAD、${concerningServices.length} 个 CONCERNING 服务`,
      }
    }

    default:
      throw new Error(`cluster 不支持 action=${action}`)
  }
}

/* ── service ────────────────────────────────────────────────────────────── */

async function serviceAction(ctx: Context, action: string, args: Record<string, unknown>): Promise<unknown> {
  const name = await clusterName(ctx, args)
  const servicesPath = `/clusters/${encodeURIComponent(name)}/services`

  switch (action) {
    case 'list':
      return ctx.client.get(servicesPath, [], ctx.signal)

    case 'get': {
      const serviceName = requireStr(args, 'service_name', '如 HDFS 服务名 hdfs1')
      return ctx.client.get(`${servicesPath}/${encodeURIComponent(serviceName)}`, [], ctx.signal)
    }

    case 'diagnose': {
      const resp = await ctx.client.get(servicesPath, [], ctx.signal)
      const items = itemsOf(resp)
      const findings: unknown[] = []

      for (const svc of items) {
        const row = obj(svc)
        const serviceName = str(row.name, '?')
        const health = analyzeHealthChecks(row)
        const state = str(row.serviceState, 'UNKNOWN')
        const stale = bool(row.configStale)
        const issues: Issue[] = []

        if (health.healthSummary === 'BAD' || health.healthSummary === 'CONCERNING') {
          for (const problem of health.problems) {
            issues.push({ check: problem.name, severity: problem.summary, explanation: problem.explanation })
          }
        }
        // 手动停止（STOPPED=按预期停止）与无状态组件（NONE / serviceState=NA）不期待 STARTED
        const stateIssue = runStateIssue(row, 'service')
        if (stateIssue) {
          issues.push({ check: 'SERVICE_STATE', severity: 'BAD', explanation: stateIssue })
        }
        if (stale) {
          issues.push({
            check: 'CONFIG_STALE',
            severity: 'CONCERNING',
            explanation: '配置已过期，需重新部署客户端配置或重启服务',
          })
        }
        if (issues.length === 0) continue

        findings.push({
          name: serviceName,
          type: str(row.type),
          healthSummary: health.healthSummary,
          serviceState: state,
          configStale: stale,
          issueCount: issues.length,
          issues,
        })
      }

      const overall: Severity =
        findings.some((f) => obj(f).healthSummary === 'BAD')
          ? 'BAD'
          : findings.length > 0
            ? 'CONCERNING'
            : 'GOOD'

      return {
        clusterName: name,
        overallHealth: overall,
        serviceCount: items.length,
        problemServiceCount: findings.length,
        findings,
        message:
          findings.length === 0
            ? `集群 ${name} 所有服务健康`
            : `集群 ${name} 发现 ${findings.length} 个服务存在异常`,
      }
    }

    default:
      throw new Error(`service 不支持 action=${action}`)
  }
}

/* ── host ───────────────────────────────────────────────────────────────── */

async function hostAction(ctx: Context, action: string, args: Record<string, unknown>): Promise<unknown> {
  switch (action) {
    case 'list':
      // lastHeartbeat / healthSummary / healthChecks 均需 full 视图（CM 文档标注 Requires "full" view）
      return ctx.client.get('/hosts', [['view', 'full']], ctx.signal)

    case 'get': {
      const hostId = requireStr(args, 'host_id', 'CM 的 hostId 或主机名')
      return ctx.client.get(`/hosts/${encodeURIComponent(hostId)}`, [['view', 'full']], ctx.signal)
    }

    case 'diagnose': {
      // 不带 view=full 时 CM 不返回 lastHeartbeat，历史上会把所有主机误判成"缺少心跳"
      const resp = await ctx.client.get('/hosts', [['view', 'full']], ctx.signal)
      const items = itemsOf(resp)
      const findings: unknown[] = []
      const now = Date.now()

      for (const host of items) {
        const row = obj(host)
        const hostId = str(row.hostId, '?')
        const hostname = str(row.hostname, hostId)
        // ApiHost 没有 status 字段，运行状态的事实来源是 entityStatus（v11+）
        const entityStatus = str(row.entityStatus, 'UNKNOWN')
        const health = analyzeHealthChecks(row)
        const maintenance = bool(row.maintenanceMode)
        const issues: Issue[] = []

        const lastHeartbeat = str(row.lastHeartbeat)
        if (lastHeartbeat) {
          const parsed = Date.parse(lastHeartbeat)
          if (Number.isNaN(parsed)) {
            issues.push({
              check: 'HEARTBEAT_PARSE',
              severity: 'CONCERNING',
              explanation: `无法解析心跳时间: ${lastHeartbeat}`,
            })
          } else {
            const seconds = Math.round((now - parsed) / 1000)
            if (seconds > HEARTBEAT_STALE_SECONDS) {
              issues.push({
                check: 'HEARTBEAT_STALE',
                severity: 'BAD',
                explanation: `主机心跳已停止约 ${seconds} 秒（最后心跳 ${lastHeartbeat}），Agent 可能离线`,
              })
            }
          }
        } else {
          issues.push({
            check: 'HEARTBEAT_MISSING',
            severity: 'CONCERNING',
            explanation: '缺少心跳时间字段（已按 view=full 查询，该主机可能从未上报过心跳）',
          })
        }

        // 主机自身的健康检查（磁盘、时钟偏移等），与服务/角色诊断同一归纳通道
        if (health.healthSummary === 'BAD' || health.healthSummary === 'CONCERNING') {
          for (const problem of health.problems) {
            issues.push({ check: problem.name, severity: problem.summary, explanation: problem.explanation })
          }
        }
        // 只有 CM 判定"应在线而未运行"（DOWN）才算状态异常；STOPPED=按预期停止不报
        const statusIssue = hostStatusIssue(row)
        if (statusIssue) {
          issues.push({ check: 'HOST_STATUS', severity: 'BAD', explanation: statusIssue })
        }
        if (maintenance) {
          issues.push({
            check: 'MAINTENANCE_MODE',
            severity: 'INFO',
            explanation: '主机处于维护模式，相关告警已被抑制',
          })
        }
        if (issues.length === 0) continue

        findings.push({
          hostId,
          hostname,
          entityStatus,
          healthSummary: health.healthSummary,
          maintenanceMode: maintenance,
          issueCount: issues.length,
          issues,
        })
      }

      const bad = findings.filter((f) => {
        const issues = obj(f).issues
        return Array.isArray(issues) && issues.some((i) => str(obj(i).severity) === 'BAD')
      }).length

      return {
        hostCount: items.length,
        problemHostCount: findings.length,
        badHostCount: bad,
        findings,
        message:
          findings.length === 0
            ? `全部 ${items.length} 台主机状态正常`
            : `发现 ${findings.length} 台主机存在异常（其中 ${bad} 台严重）`,
      }
    }

    default:
      throw new Error(`host 不支持 action=${action}`)
  }
}

/* ── role ───────────────────────────────────────────────────────────────── */

async function roleAction(ctx: Context, action: string, args: Record<string, unknown>): Promise<unknown> {
  const name = await clusterName(ctx, args)
  const serviceName = requireStr(args, 'service_name', '如 HDFS 服务名 hdfs1')
  const rolesPath = `/clusters/${encodeURIComponent(name)}/services/${encodeURIComponent(serviceName)}/roles`

  switch (action) {
    case 'list':
      return ctx.client.get(rolesPath, [], ctx.signal)

    case 'diagnose': {
      const resp = await ctx.client.get(rolesPath, [], ctx.signal)
      const items = itemsOf(resp)
      const findings: unknown[] = []

      for (const role of items) {
        const row = obj(role)
        const roleName = str(row.name, '?')
        const health = analyzeHealthChecks(row)
        const state = str(row.roleState, 'UNKNOWN')
        const stale = bool(row.configStale)
        const issues: Issue[] = []

        if (health.healthSummary === 'BAD' || health.healthSummary === 'CONCERNING') {
          for (const problem of health.problems) {
            issues.push({ check: problem.name, severity: problem.summary, explanation: problem.explanation })
          }
        }
        // client / gateway 等无状态角色（roleState=NA / entityStatus=NONE）与手动停止的服务
        //（其角色随服务 STOPPED）不期待 STARTED；只有 CM 判定 DOWN 才是异常
        const stateIssue = runStateIssue(row, 'role')
        if (stateIssue) {
          issues.push({ check: 'ROLE_STATE', severity: 'BAD', explanation: stateIssue })
        }
        if (stale) {
          issues.push({
            check: 'CONFIG_STALE',
            severity: 'CONCERNING',
            explanation: '角色配置已过期，需重启或重新部署配置',
          })
        }
        if (issues.length === 0) continue

        findings.push({
          name: roleName,
          type: str(row.type),
          healthSummary: health.healthSummary,
          roleState: state,
          configStale: stale,
          issueCount: issues.length,
          issues,
        })
      }

      return {
        clusterName: name,
        serviceName,
        roleCount: items.length,
        problemRoleCount: findings.length,
        findings,
        message:
          findings.length === 0
            ? `服务 ${serviceName} 全部 ${items.length} 个角色健康`
            : `服务 ${serviceName} 发现 ${findings.length} 个角色异常`,
      }
    }

    case 'logs': {
      const roleName = requireStr(args, 'role_name')
      const logType = str(args.log_type).trim() || 'stderr'
      const lines = Math.max(1, Math.min(5000, num(args.lines) ?? 200))
      const path = `${rolesPath}/${encodeURIComponent(roleName)}/logs/${encodeURIComponent(logType)}`
      const text = await ctx.client.requestText('GET', path, [], ctx.signal)
      const tail = tailLines(text, lines)
      return {
        clusterName: name,
        serviceName,
        roleName,
        logType,
        totalLines: tail.total,
        returnedLines: tail.lines.length,
        log: truncate(tail.lines.join('\n'), MAX_TEXT_CHARS),
      }
    }

    case 'config_file': {
      const roleName = requireStr(args, 'role_name')
      const fileName = requireStr(args, 'file_name', '如 hdfs-site.xml / yarn-site.xml / core-site.xml')
      const path =
        `${rolesPath}/${encodeURIComponent(roleName)}/process/configFiles/${encodeURIComponent(fileName)}`
      const content = await ctx.client.requestText('GET', path, [], ctx.signal)
      return {
        clusterName: name,
        serviceName,
        roleName,
        fileName,
        content: truncate(content, MAX_TEXT_CHARS),
      }
    }

    default:
      throw new Error(`role 不支持 action=${action}`)
  }
}

/* ── events ─────────────────────────────────────────────────────────────── */

async function eventsAction(ctx: Context, action: string, args: Record<string, unknown>): Promise<unknown> {
  switch (action) {
    case 'build_query': {
      const { query, startTime, endTime } = buildEventQuery(args)
      return {
        generatedQuery: query,
        startTime,
        endTime,
        syntax:
          '相等用 ==；同属性多值用空格表示 OR（如 severity==CRITICAL ERROR）；' +
          '多个属性用分号 ; 连接表示 AND（分号两侧不要空格）；不要用逗号。',
        tip: '复制 generatedQuery 到 action=query 的 query 字段即可直接执行；或直接用结构化字段（category/severities/event_type/source）由服务端自动拼装。',
        note: '结构化字段优先级低于 query 原始覆盖；两者都空时返回全部事件。',
      }
    }

    case 'query': {
      const { query, startTime, endTime } = buildEventQuery(args)
      const limit = Math.max(1, Math.min(5000, num(args.limit) ?? 100))
      const params: Array<[string, string | number]> = [['limit', limit]]
      if (query) params.push(['query', query])
      if (startTime) params.push(['startTime', startTime])
      if (endTime) params.push(['endTime', endTime])
      return ctx.client.get('/events', params, ctx.signal)
    }

    case 'alerts': {
      const hours = Math.max(1, Math.min(24 * 30, num(args.hours) ?? 24))
      const severitiesRaw = Array.isArray(args.severities)
        ? args.severities.filter((s): s is string => typeof s === 'string')
        : []
      const severities = severitiesRaw.length > 0 ? severitiesRaw : ['IMPORTANT', 'ERROR', 'CRITICAL']
      const startTime = new Date(Date.now() - hours * 3_600_000).toISOString()

      const resp = await ctx.client.get('/events', [['startTime', startTime], ['limit', 500]], ctx.signal)
      const items = itemsOf(resp)
      const wanted = new Set(severities.map((s) => s.toUpperCase()))
      const counts: Record<string, number> = {}
      const alerts: unknown[] = []

      for (const event of items) {
        const row = obj(event)
        const severity = str(row.severity, 'UNKNOWN').toUpperCase()
        if (!wanted.has(severity)) continue
        counts[severity] = (counts[severity] ?? 0) + 1
        alerts.push({
          id: row.id ?? null,
          time: row.timestamp ?? null,
          severity: row.severity ?? null,
          category: row.category ?? null,
          type: row.type ?? null,
          summary: row.summary ?? null,
          source: row.source ?? null,
        })
      }

      alerts.sort((a, b) => severityRank(str(obj(a).severity)) - severityRank(str(obj(b).severity)))

      return {
        hours,
        severityFilter: severities,
        totalEventsScanned: items.length,
        matchedAlertCount: alerts.length,
        severityCounts: counts,
        alerts,
        message: `过去 ${hours} 小时内发现 ${alerts.length} 条告警`,
      }
    }

    default:
      throw new Error(`events 不支持 action=${action}`)
  }
}

/* ── metrics ────────────────────────────────────────────────────────────── */

async function metricsAction(ctx: Context, action: string, args: Record<string, unknown>): Promise<unknown> {
  switch (action) {
    case 'query': {
      const tsquery = requireStr(args, 'tsquery', '如 select cpu_percent where category = HOST')
      const params: Array<[string, string]> = [['query', tsquery]]
      const from = str(args.from).trim()
      const to = str(args.to).trim()
      if (from) params.push(['from', from])
      if (to) params.push(['to', to])
      return ctx.client.get('/timeseries', params, ctx.signal)
    }

    case 'list': {
      const filter = str(args.filter).trim()
      const context = str(args.context).trim().toUpperCase()
      const limit = Math.max(1, Math.min(5000, num(args.limit) ?? 200))
      let filterRegex: RegExp | undefined
      const useRegex = bool(args.regex)
      if (useRegex && filter) {
        try {
          filterRegex = new RegExp(filter, 'i')
        } catch (err) {
          throw new Error(`filter 正则表达式无效: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      const lowerFilter = filter.toLowerCase()

      const resp = await ctx.client.get('/timeseries/schema', [], ctx.signal)
      const items = itemsOf(resp)
      const matched: unknown[] = []

      for (const metric of items) {
        const row = obj(metric)
        const metricName = str(row.name)
        if (!metricName) continue
        const description = str(row.description)
        if (filter) {
          const hit = filterRegex
            ? filterRegex.test(metricName) || filterRegex.test(description)
            : metricName.toLowerCase().includes(lowerFilter) || description.toLowerCase().includes(lowerFilter)
          if (!hit) continue
        }
        if (context) {
          const contexts = Array.isArray(row.context) ? row.context.map((c) => str(c)) : []
          if (!contexts.includes(context)) continue
        }
        matched.push({
          name: metricName,
          description,
          unit: str(row.unit),
          context: Array.isArray(row.context) ? row.context : [],
        })
        if (matched.length >= limit) break
      }

      return {
        totalAvailable: items.length,
        returned: matched.length,
        filter,
        regex: useRegex,
        context,
        metrics: matched,
      }
    }

    case 'host': {
      const hostId = requireStr(args, 'host_id', 'CM 的 hostId')
      const tsquery =
        `select cpu_percent, mem_used, mem_total, disk_used, disk_total where entityName = "${hostId}" and category = HOST`
      const resp = await safeTimeseries(ctx, tsquery)
      if (resp === undefined) {
        return { hostId, seriesCount: 0, latest: [], flags: [], warnings: ctx.warnings }
      }
      const series = itemsOf(resp)
      const latest = series.map((s) => {
        const row = obj(s)
        return {
          metric: str(row.metricName, '?'),
          entityName: str(row.entityName),
          latestValue: latestValue(row) ?? null,
        }
      })

      const flags: unknown[] = []
      for (const item of series) {
        const row = obj(item)
        const metricName = str(row.metricName)
        const value = latestValue(row)
        if (metricName !== 'cpu_percent' || value === undefined) continue
        if (value > 90) {
          flags.push({
            metric: 'cpu_percent',
            level: 'BAD',
            message: `CPU 使用率 ${value.toFixed(1)}% 超过 90% 阈值`,
          })
        }
      }

      return {
        hostId,
        seriesCount: series.length,
        latest,
        flags,
        warnings: ctx.warnings,
        raw: resp,
      }
    }

    case 'service': {
      const serviceName = requireStr(args, 'service_name')
      const tsquery = `select * where entityName = "${serviceName}" and category = SERVICE`
      const resp = await safeTimeseries(ctx, tsquery)
      if (resp === undefined) {
        return { serviceName, seriesCount: 0, warnings: ctx.warnings }
      }
      return {
        serviceName,
        seriesCount: itemsOf(resp).length,
        warnings: ctx.warnings,
        raw: resp,
      }
    }

    default:
      throw new Error(`metrics 不支持 action=${action}`)
  }
}

/* ── diagnosis ──────────────────────────────────────────────────────────── */

/** 在集群内查找指定服务类型（如 HDFS / YARN / IMPALA）的服务名。 */
async function findServiceName(ctx: Context, clusterNameValue: string, serviceType: string): Promise<string | undefined> {
  const resp = await ctx.client.get(
    `/clusters/${encodeURIComponent(clusterNameValue)}/services`,
    [],
    ctx.signal,
  )
  for (const svc of itemsOf(resp)) {
    const row = obj(svc)
    if (str(row.type) === serviceType) {
      const serviceName = str(row.name)
      if (serviceName) return serviceName
    }
  }
  return undefined
}

/** Impala 查询状态是否失败。 */
function isFailureState(state: string): boolean {
  return ['FAILED', 'EXCEPTION'].includes(state.toUpperCase())
}

/** 解析耗时（兼容毫秒数值与 "12s" / "5ms" / "3m" 字符串）。 */
function parseDurationMs(value: unknown): number | undefined {
  const direct = num(value)
  if (direct !== undefined) return direct
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  const units: Array<[RegExp, number]> = [
    [/ms$/i, 1],
    [/s$/i, 1000],
    [/m$/i, 60_000],
    [/h$/i, 3_600_000],
  ]
  for (const [pattern, scale] of units) {
    if (!pattern.test(text)) continue
    const parsed = Number.parseFloat(text.replace(pattern, '').trim())
    return Number.isFinite(parsed) ? parsed * scale : undefined
  }
  const parsed = Number.parseFloat(text)
  return Number.isFinite(parsed) ? parsed * 1000 : undefined
}

/** 对失败查询做聚合（按 SQL 文本）。 */
function topFailingStatements(failed: Array<Record<string, unknown>>, topN: number): unknown[] {
  const groups = new Map<string, number>()
  for (const query of failed) {
    const statement = str(query.statement, '<未知 SQL>')
    groups.set(statement, (groups.get(statement) ?? 0) + 1)
  }
  return [...groups.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([statement, count]) => ({
      count,
      statement: statement.length > 500 ? `${statement.slice(0, 500)}…` : statement,
    }))
}

async function diagnosisAction(ctx: Context, action: string, args: Record<string, unknown>): Promise<unknown> {
  switch (action) {
    case 'overview': {
      const name = await clusterName(ctx, args)
      const services = obj(await serviceAction(ctx, 'diagnose', { cluster_name: name }))
      const hosts = obj(await hostAction(ctx, 'diagnose', {}))
      const alerts = obj(await eventsAction(ctx, 'alerts', {}))

      const svcBad = num(services.problemServiceCount) ?? 0
      const svcTotal = Math.max(1, num(services.serviceCount) ?? 0)
      const hostBad = num(hosts.badHostCount) ?? 0
      const hostTotal = Math.max(1, num(hosts.hostCount) ?? 0)
      const alertCount = num(alerts.matchedAlertCount) ?? 0

      let score = 100
      score -= Math.floor((svcBad * 100) / svcTotal) / 2
      score -= Math.floor((hostBad * 100) / hostTotal) / 2
      score -= Math.min(20, alertCount)
      score = Math.max(0, Math.min(100, Math.round(score)))

      const overall: Severity = score >= 90 ? 'GOOD' : score >= 60 ? 'CONCERNING' : 'BAD'
      const recommendations: string[] = []
      if (svcBad > 0) recommendations.push(`优先处理 ${svcBad} 个异常服务，查看 service/diagnose 明细`)
      if (hostBad > 0) recommendations.push(`检查 ${hostBad} 台心跳超时/状态异常的主机（可能为 Agent 离线）`)
      if (alertCount > 0) recommendations.push(`复盘过去 24 小时内的 ${alertCount} 条告警，定位反复出现的根因`)
      if (recommendations.length === 0) recommendations.push('当前未发现明显异常，建议保持监控')

      return {
        clusterName: name,
        overallHealth: overall,
        healthScore: score,
        serviceHealth: {
          total: svcTotal,
          problem: svcBad,
          findings: services.findings ?? [],
        },
        hostHealth: {
          total: hostTotal,
          problem: num(hosts.problemHostCount) ?? 0,
          bad: hostBad,
          findings: hosts.findings ?? [],
        },
        recentAlerts: {
          count: alertCount,
          severityCounts: alerts.severityCounts ?? {},
        },
        recommendations,
        warnings: ctx.warnings,
      }
    }

    case 'hdfs': {
      const name = await clusterName(ctx, args)
      const hdfsName = await findServiceName(ctx, name, 'HDFS')
      if (!hdfsName) throw new Error('未找到 HDFS 服务')

      const service = await ctx.client.get(
        `/clusters/${encodeURIComponent(name)}/services/${encodeURIComponent(hdfsName)}`,
        [],
        ctx.signal,
      )
      const health = analyzeHealthChecks(service)

      // CDH 7 指标改名：dfs_under_replicated → under_replicated_blocks，
      // dfs_missing_blocks → missing_blocks；容量类 dfs_capacity* 保留原名。
      const capacityRaw = await safeTimeseries(
        ctx,
        `select dfs_capacity, dfs_capacity_used, dfs_capacity_used_non_hdfs where entityName = "${hdfsName}"`,
      )
      const blockRaw = await safeTimeseries(
        ctx,
        `select under_replicated_blocks, missing_blocks where entityName = "${hdfsName}"`,
      )

      const capacity = capacityRaw === undefined ? undefined : metricLatest(capacityRaw, 'dfs_capacity')
      const used = capacityRaw === undefined ? undefined : metricLatest(capacityRaw, 'dfs_capacity_used')
      const underReplicated = blockRaw === undefined ? undefined : metricLatest(blockRaw, 'under_replicated_blocks')
      const missingBlocks = blockRaw === undefined ? undefined : metricLatest(blockRaw, 'missing_blocks')
      const usedRatio = ratioPercent(used, capacity)

      const roles = obj(await roleAction(ctx, 'diagnose', { cluster_name: name, service_name: hdfsName }))
      const findings: Array<{ check: string; level: string; detail: string }> = []

      if (usedRatio !== undefined) {
        const level = usedRatio > 85 ? 'BAD' : usedRatio > 70 ? 'CONCERNING' : 'GOOD'
        findings.push({
          check: 'CAPACITY_USAGE',
          level,
          detail:
            `HDFS 容量使用率 ${usedRatio.toFixed(1)}%` +
            `（已用 ${((used ?? 0) / 1e12).toFixed(2)} TB / 总量 ${((capacity ?? 0) / 1e12).toFixed(2)} TB）`,
        })
      }
      if (underReplicated !== undefined && underReplicated > 0) {
        findings.push({
          check: 'UNDER_REPLICATED_BLOCKS',
          level: underReplicated > 100 ? 'BAD' : 'CONCERNING',
          detail: `存在 ${underReplicated} 个副本不足块`,
        })
      }
      if (missingBlocks !== undefined && missingBlocks > 0) {
        findings.push({
          check: 'MISSING_BLOCKS',
          level: 'BAD',
          detail: `存在 ${missingBlocks} 个丢失块（数据可能永久损坏）`,
        })
      }

      const overall: Severity = findings.some((f) => f.level === 'BAD')
        ? 'BAD'
        : findings.some((f) => f.level === 'CONCERNING')
          ? 'CONCERNING'
          : 'GOOD'

      return {
        clusterName: name,
        hdfsService: hdfsName,
        overallHealth: overall,
        capacity: {
          totalBytes: capacity ?? null,
          usedBytes: used ?? null,
          usedPercent: usedRatio ?? null,
          underReplicatedBlocks: underReplicated ?? null,
          missingBlocks: missingBlocks ?? null,
        },
        serviceHealth: health,
        roleDiagnosis: {
          problemRoleCount: num(roles.problemRoleCount) ?? 0,
          findings: roles.findings ?? [],
        },
        findings,
        warnings: ctx.warnings,
        message: `HDFS 专项诊断完成，整体健康度 ${overall}`,
      }
    }

    case 'yarn': {
      const name = await clusterName(ctx, args)
      const yarnName = await findServiceName(ctx, name, 'YARN')
      if (!yarnName) throw new Error('未找到 YARN 服务')

      const service = await ctx.client.get(
        `/clusters/${encodeURIComponent(name)}/services/${encodeURIComponent(yarnName)}`,
        [],
        ctx.signal,
      )
      const health = analyzeHealthChecks(service)
      const roles = obj(await roleAction(ctx, 'diagnose', { cluster_name: name, service_name: yarnName }))

      // CDH 7 改名：yarn_allocated_memory_mb → yarn_reports_containers_allocated_memory；
      // yarn_allocated_vcores → yarn_reports_containers_allocated_vcores。
      const usageRaw = await safeTimeseries(
        ctx,
        `select yarn_reports_containers_allocated_memory, yarn_reports_containers_allocated_vcores where entityName = "${yarnName}"`,
      )
      const queueRaw = await safeTimeseries(
        ctx,
        `select apps_running, apps_pending where entityName = "${yarnName}"`,
      )

      const allocatedMemory = usageRaw === undefined ? undefined : metricLatest(usageRaw, 'yarn_reports_containers_allocated_memory')
      const allocatedVcores = usageRaw === undefined ? undefined : metricLatest(usageRaw, 'yarn_reports_containers_allocated_vcores')
      const appsRunning = queueRaw === undefined ? undefined : metricLatest(queueRaw, 'apps_running')
      const appsPending = queueRaw === undefined ? undefined : metricLatest(queueRaw, 'apps_pending')

      const findings: Array<{ check: string; level: string; detail: string }> = []
      if (appsPending !== undefined && appsRunning !== undefined && appsPending > 0 && appsPending >= appsRunning * 0.1) {
        findings.push({
          check: 'RESOURCE_PRESSURE',
          level: 'CONCERNING',
          detail:
            `YARN 存在 ${Math.round(appsPending)} 个待运行应用（运行中 ${Math.round(appsRunning)} 个），` +
            '可能存在资源争抢或队列容量不足',
        })
      }

      const overall: Severity = findings.some((f) => f.level === 'BAD')
        ? 'BAD'
        : findings.some((f) => f.level === 'CONCERNING')
          ? 'CONCERNING'
          : 'GOOD'

      return {
        clusterName: name,
        yarnService: yarnName,
        overallHealth: overall,
        resources: {
          allocatedMemoryMb: allocatedMemory ?? null,
          allocatedVcores: allocatedVcores ?? null,
          appsRunning: appsRunning ?? null,
          appsPending: appsPending ?? null,
        },
        serviceHealth: health,
        roleDiagnosis: {
          problemRoleCount: num(roles.problemRoleCount) ?? 0,
          findings: roles.findings ?? [],
        },
        findings,
        warnings: ctx.warnings,
        message: `YARN 专项诊断完成，整体健康度 ${overall}`,
      }
    }

    case 'impala': {
      const name = await clusterName(ctx, args)
      const explicitService = str(args.service_name).trim()
      const impalaName = explicitService || (await findServiceName(ctx, name, 'IMPALA'))
      if (!impalaName) throw new Error('未找到 IMPALA 服务（可用 service_name 显式指定）')

      const now = Date.now()
      const from = str(args.from).trim() || new Date(now - 24 * 3_600_000).toISOString()
      const to = str(args.to).trim() || new Date(now).toISOString()
      const limit = Math.max(1, Math.min(5000, Math.floor(num(args.limit) ?? 1000)))
      const onlyFailed = bool(args.only_failed)
      const minDurationMs = num(args.min_duration_ms)
      const includeSql = bool(args.include_sql)
      const topN = Math.max(1, Math.min(50, Math.floor(num(args.top_n) ?? 10)))

      const filterParts: string[] = []
      if (onlyFailed) filterParts.push('(queryState=FAILED or queryState=EXCEPTION)')
      const user = str(args.user).trim()
      if (user) filterParts.push(`user = ${/\s/.test(user) ? `"${user}"` : user}`)
      const filter = filterParts.length > 0 ? filterParts.join(' and ') : undefined

      const params: Array<[string, string | number]> = [
        ['from', from],
        ['to', to],
        ['limit', limit],
      ]
      if (filter) params.push(['filter', filter])

      const resp = await ctx.client.get(
        `/clusters/${encodeURIComponent(name)}/services/${encodeURIComponent(impalaName)}/impalaQueries`,
        params,
        ctx.signal,
      )

      const responseRow = obj(resp)
      const queries = (Array.isArray(responseRow.queries) ? responseRow.queries : []).map((q) => obj(q))
      const cmWarnings = Array.isArray(responseRow.warnings)
        ? responseRow.warnings.filter((w): w is string => typeof w === 'string')
        : []

      const stateCounts: Record<string, number> = {}
      const failed: Array<Record<string, unknown>> = []
      const longRunning: Array<{ ms: number; query: Record<string, unknown> }> = []

      for (const query of queries) {
        const state = str(query.queryState) || str(query.query_state) || 'UNKNOWN'
        stateCounts[state] = (stateCounts[state] ?? 0) + 1
        if (isFailureState(state)) failed.push(query)

        const ms = parseDurationMs(query.durationMillis ?? query.query_duration)
        if (ms === undefined) continue
        if (minDurationMs !== undefined && ms < minDurationMs) continue
        longRunning.push({ ms, query })
      }

      const total = queries.length
      const failureRate = total > 0 ? (failed.length / total) * 100 : undefined

      longRunning.sort((a, b) => b.ms - a.ms)
      const topLongRunning = longRunning.slice(0, topN).map(({ ms, query }) => {
        const row: Record<string, unknown> = {
          queryId: query.queryId ?? null,
          user: query.user ?? query.connectedUser ?? null,
          state: query.queryState ?? query.query_state ?? null,
          durationMs: ms,
          rowsFetched: query.rowsFetched ?? null,
          startTime: query.startTime ?? null,
          endTime: query.endTime ?? null,
        }
        if (includeSql) row.statement = query.statement ?? null
        return row
      })

      const findings: Array<{ check: string; level: string; detail: string }> = []
      if (failed.length > 0) {
        const rate = failureRate ?? 0
        findings.push({
          check: 'IMPALA_FAILED_QUERIES',
          level: rate > 20 ? 'BAD' : 'CONCERNING',
          detail: `时间范围内有 ${failed.length} 条失败查询（失败率 ${rate.toFixed(1)}%），需关注高频失败 SQL`,
        })
      }
      if (cmWarnings.length > 0) {
        findings.push({
          check: 'IMPALA_CM_WARNING',
          level: 'CONCERNING',
          detail: 'Cloudera Manager 返回了查询警告，可能表示时间范围过大或过滤条件不兼容',
        })
      }
      if (total >= limit) {
        findings.push({
          check: 'IMPALA_TRUNCATION',
          level: 'CONCERNING',
          detail: `返回查询数达到上限 ${limit}，统计可能不完整；可缩小时间范围或增大 limit 后重试`,
        })
      }

      const overall: Severity = findings.some((f) => f.level === 'BAD')
        ? 'BAD'
        : findings.some((f) => f.level === 'CONCERNING')
          ? 'CONCERNING'
          : 'GOOD'

      if (total >= limit) ctx.warnings.push(`返回查询数达到上限 ${limit}，统计可能不完整`)
      ctx.warnings.push(...cmWarnings)

      return {
        clusterName: name,
        impalaService: impalaName,
        timeRange: { from, to },
        query: { limit, filter: filter ?? null, onlyFailed },
        totalQueries: total,
        failedCount: failed.length,
        failureRatePercent: failureRate ?? null,
        stateCounts,
        topFailingStatements: topFailingStatements(failed, topN),
        topLongRunningQueries: topLongRunning,
        findings,
        warnings: ctx.warnings,
        message:
          `Impala 诊断完成：共 ${total} 条查询，失败 ${failed.length} 条` +
          `（失败率 ${(failureRate ?? 0).toFixed(1)}%），整体 ${overall}`,
      }
    }

    case 'command_status': {
      const commandId = num(args.command_id)
      if (commandId === undefined) throw new Error('缺少 command_id 参数')
      const resp = obj(await ctx.client.get(`/commands/${Math.floor(commandId)}`, [], ctx.signal))
      return {
        commandId: Math.floor(commandId),
        active: resp.active ?? null,
        success: resp.success ?? null,
        name: resp.name ?? null,
        resultMessage: resp.resultMessage ?? null,
        startTime: resp.startTime ?? null,
        endTime: resp.endTime ?? null,
        serviceRef: resp.serviceRef ?? null,
      }
    }

    case 'command_logs': {
      const commandId = num(args.command_id)
      if (commandId === undefined) throw new Error('缺少 command_id 参数')
      const logType = str(args.log_type).trim() || 'stderr'
      if (logType !== 'stderr' && logType !== 'stdout') throw new Error('log_type 仅支持 stderr 或 stdout')
      const lines = Math.max(1, Math.min(5000, num(args.lines) ?? 200))
      const text = await ctx.client.requestText(
        'GET',
        `/commands/${Math.floor(commandId)}/logs/${logType}`,
        [],
        ctx.signal,
      )
      const tail = tailLines(text, lines)
      return {
        commandId: Math.floor(commandId),
        logType,
        totalLines: tail.total,
        returnedLines: tail.lines.length,
        log: truncate(tail.lines.join('\n'), MAX_TEXT_CHARS),
      }
    }

    default:
      throw new Error(`diagnosis 不支持 action=${action}`)
  }
}

/* ── yarn（Spark/Flink/Hive on YARN 作业与容器日志取证） ─────────────────── */

/** JHS 取日志末尾的字节 chunk：按行数估算并夹取到文本上限内（start 取负值=从末尾取）。 */
function logChunkBytes(lines: number): number {
  return Math.min(MAX_TEXT_CHARS, Math.max(8192, lines * 512))
}

/** 定位 YARN 服务名（yarn/apps 走 CM yarnApplications 需要）。 */
async function yarnServiceName(ctx: Context, args: Record<string, unknown>): Promise<{ cluster: string; service: string }> {
  const cluster = await clusterName(ctx, args)
  const explicit = str(args.service_name).trim()
  const service = explicit || (await findServiceName(ctx, cluster, 'YARN'))
  if (!service) throw new Error('未找到 YARN 服务（可用 service_name 显式指定）')
  return { cluster, service }
}

/** 要求已配置 ResourceManager Web 地址，否则给出可读纠正提示。 */
function requireRm(ctx: Context): void {
  if (!ctx.yarn.hasRm) {
    throw new Error(
      '该动作需要 ResourceManager Web 地址：请在设置 → 插件 → CDH 填 yarnRmUrl（如 http://rm:8088），或确保插件能读到 YARN 服务的 yarn-site.xml 自动推导；仅支持免 Kerberos（SPNEGO）的 HTTP 端点',
    )
  }
}

/** 解析角色所在主机名（webapp address 为 0.0.0.0 等绑定地址时用来替换 host）。 */
async function resolveRoleHostname(ctx: Context, hostId: string): Promise<string> {
  if (!hostId) return ''
  const host = obj(await ctx.client.get(`/hosts/${encodeURIComponent(hostId)}`, [], ctx.signal))
  return str(host.hostname)
}

/**
 * 手动配置优先，留空时从 CM 自动推导 RM/JHS 地址：读一个 RESOURCEMANAGER 角色下发的
 * yarn-site.xml，取 yarn.resourcemanager.webapp.address（RM）与 yarn.log.server.url（JHS）。
 * 推导目标来自所配置集群自身的配置（非运行时传入 host），仍满足目标锁定不变量。
 * 任何失败都降级为「仅手动配置」并记 warning，不拖垮 yarn 动作（apps 纯 CM，不调用本函数）。
 */
async function resolveYarnTargets(ctx: Context): Promise<void> {
  if (ctx.yarn.hasRm && ctx.yarn.hasJhs) return
  try {
    const { cluster, service } = await yarnServiceName(ctx, {})
    const rolesPath = `/clusters/${encodeURIComponent(cluster)}/services/${encodeURIComponent(service)}/roles`
    const rolesResp = await ctx.client.get(rolesPath, [], ctx.signal)
    const rmRole = itemsOf(rolesResp).map((r) => obj(r)).find((r) => str(r.type) === 'RESOURCEMANAGER')
    if (!rmRole) throw new Error('YARN 服务下未找到 RESOURCEMANAGER 角色')
    const roleName = str(rmRole.name)
    const hostId = str(obj(rmRole.hostRef).hostId)
    const xml = await ctx.client.requestText(
      'GET',
      `${rolesPath}/${encodeURIComponent(roleName)}/process/configFiles/yarn-site.xml`,
      [],
      ctx.signal,
    )
    const derived = deriveYarnUrlsFromProps(parseHadoopConfigXml(xml))
    let rmUrl = derived.rmUrl
    if (derived.needsHostname) {
      rmUrl = webappAddressToUrl(derived.rmAddrRaw, await resolveRoleHostname(ctx, hostId))
    }
    if (derived.ha) {
      ctx.warnings.push(
        `HA 集群：已推导第一个 RM（${derived.rmId || '?'}）的 Web 地址；若指向 standby，请手动把 yarnRmUrl 设为 active RM`,
      )
    }
    const hadRm = ctx.yarn.hasRm
    const hadJhs = ctx.yarn.hasJhs
    ctx.yarn.fillDerived(rmUrl, derived.jhsUrl)
    const notes: string[] = []
    if (!hadRm && ctx.yarn.hasRm) notes.push(`yarnRmUrl=${rmUrl}`)
    if (!hadJhs && ctx.yarn.hasJhs) notes.push(`yarnJhsUrl=${derived.jhsUrl}`)
    if (notes.length > 0) ctx.warnings.push(`YARN 地址未手动配置，已从 CM yarn-site.xml 推导：${notes.join('，')}`)
  } catch (err) {
    ctx.warnings.push(`从 CM 自动推导 YARN 地址失败（降级为仅手动配置）：${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * 手动配置优先，留空时从 CM 推导 Spark History Server 地址：Spark 服务下带 HISTORY 的
 * 角色（CDH 为 SPARK_YARN_HISTORY_SERVER）的 roleUrl 即其 Web UI 根地址。
 * 推导目标仍是所配置集群自身的角色地址，不引入运行时 host/URL。
 */
async function resolveSparkHistoryUrl(ctx: Context): Promise<void> {
  if (ctx.yarn.hasSparkHistory) return
  try {
    const cluster = await clusterName(ctx, {})
    const services = itemsOf(await ctx.client.get(`/clusters/${encodeURIComponent(cluster)}/services`, [], ctx.signal))
    const sparkService = services
      .map((item) => obj(item))
      .find((item) => ['SPARK', 'SPARK_ON_YARN'].includes(str(item.type).toUpperCase()))
    if (!sparkService) return
    const serviceName = str(sparkService.name)
    if (!serviceName) return
    const roles = itemsOf(
      await ctx.client.get(
        `/clusters/${encodeURIComponent(cluster)}/services/${encodeURIComponent(serviceName)}/roles`,
        [],
        ctx.signal,
      ),
    )
    const historyRole = roles
      .map((item) => obj(item))
      .find((item) => str(item.type).toUpperCase().includes('HISTORY') && str(item.roleUrl).trim())
    if (!historyRole) return
    const url = str(historyRole.roleUrl).trim()
    ctx.yarn.fillDerived('', '', url)
    if (ctx.yarn.hasSparkHistory) {
      ctx.warnings.push(`Spark History 地址未手动配置，已从 CM 角色 ${str(historyRole.name)} 的 Web UI 地址推导：${url}`)
    }
  } catch (err) {
    ctx.warnings.push(`从 CM 推导 Spark History 地址失败（降级为仅手动配置）：${err instanceof Error ? err.message : String(err)}`)
  }
}

/** 引擎日志每个组件最多读取的文件数（log/out/err 等，6 足以覆盖）。 */
const MAX_ENGINE_FILES = 6

/** YARN 作业是否仍在运行：finalStatus 已确定（非 UNDEFINED）即结束，否则看 state。 */
function appIsLive(app: Record<string, unknown>): boolean {
  const final = str(app.finalStatus).toUpperCase()
  if (final && final !== 'UNDEFINED') return false
  const state = str(app.state).toUpperCase()
  return state === '' || ['NEW', 'NEW_SAVING', 'SUBMITTED', 'ACCEPTED', 'RUNNING'].includes(state)
}

/**
 * 引擎 Web 基址：RM 跟踪地址优先（运行期实时、经 RM 代理，天然限定在配置集群内），
 * 退回 AM 的 HTTP 地址（Flink 用 amHostHttpAddress 直连 JobManager）。
 */
function engineBaseFromApp(app: Record<string, unknown>): string {
  const tracking = str(app.trackingUrl).trim()
  if (tracking) return tracking
  const am = str(app.amHostHttpAddress).trim()
  if (!am) return ''
  return /^https?:\/\//i.test(am) ? am : `http://${am}`
}

/** 按文件名子串过滤并限流；filter 为空表示全部（默认 'log' 只取主日志，跳过 .out/.err 噪声）。 */
function selectLogFiles(files: EngineLogFile[], filter: string): EngineLogFile[] {
  const wanted = filter.trim().toLowerCase()
  const matched = wanted ? files.filter((file) => file.name.toLowerCase().includes(wanted)) : files
  return matched.slice(0, MAX_ENGINE_FILES)
}

interface EngineLogFetch {
  name: string
  size: number | null
  mtime: number | null
  totalLines: number
  returnedLines: number
  errorLines: string[]
  log: string
  error?: string
}

/** 取单个引擎日志文件尾部；单个文件失败折叠为 error，不拖垮其余组件。 */
async function fetchEngineLogFile(
  ctx: Context,
  base: string,
  path: string,
  file: EngineLogFile,
  lines: number,
): Promise<EngineLogFetch> {
  try {
    const text = await ctx.yarn.engineTextTail(base, path, logChunkBytes(lines), ctx.signal)
    const tail = tailLines(text, lines)
    return {
      ...file,
      totalLines: tail.total,
      returnedLines: tail.lines.length,
      errorLines: extractErrorLines(text, 20),
      log: truncate(tail.lines.join('\n'), MAX_TEXT_CHARS),
    }
  } catch (err) {
    return {
      ...file,
      totalLines: 0,
      returnedLines: 0,
      errorLines: [],
      log: '',
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

/** 归一化 CM ApiYarnApplication 行。 */
function mapCmYarnApp(row: Record<string, unknown>): Record<string, unknown> {
  return {
    applicationId: str(row.applicationId),
    name: str(row.name),
    user: str(row.user),
    applicationType: str(row.applicationType),
    state: str(row.state),
    finalStatus: str(row.finalStatus),
    startTime: row.startTime ?? null,
    endTime: row.endTime ?? null,
    trackingUrl: str(row.trackingUrl),
  }
}

async function yarnAction(ctx: Context, action: string, args: Record<string, unknown>): Promise<unknown> {
  // apps 纯 CM 元数据，无需 RM/JHS；其余动作先把手动留空的地址从 CM 推导补齐。
  if (action !== 'apps') await resolveYarnTargets(ctx)
  switch (action) {
    case 'apps': {
      const { cluster, service } = await yarnServiceName(ctx, args)
      const now = Date.now()
      const from = str(args.from).trim() || new Date(now - 24 * 3_600_000).toISOString()
      const to = str(args.to).trim() || new Date(now).toISOString()
      const limit = Math.max(1, Math.min(5000, Math.floor(num(args.limit) ?? 200)))
      const params: Array<[string, string | number]> = [['from', from], ['to', to], ['limit', limit]]
      const resp = await ctx.client.get(
        `/clusters/${encodeURIComponent(cluster)}/services/${encodeURIComponent(service)}/yarnApplications`,
        params,
        ctx.signal,
      )
      const responseRow = obj(resp)
      const rawApps = Array.isArray(responseRow.applications) ? responseRow.applications : itemsOf(resp)
      const cmWarnings = Array.isArray(responseRow.warnings)
        ? responseRow.warnings.filter((w): w is string => typeof w === 'string')
        : []

      const user = str(args.user).trim().toLowerCase()
      const appType = str(args.application_type).trim().toUpperCase()
      const state = str(args.state).trim().toUpperCase()
      const finalStatus = str(args.final_status).trim().toUpperCase()
      const onlyFailed = bool(args.only_failed)

      const apps: Array<Record<string, unknown>> = []
      for (const item of rawApps) {
        const row = obj(item)
        const rowUser = str(row.user).toLowerCase()
        const rowType = str(row.applicationType).toUpperCase()
        const rowState = str(row.state).toUpperCase()
        const rowFinal = str(row.finalStatus).toUpperCase()
        const failed = rowFinal === 'FAILED' || rowState === 'FAILED'
        if (user && rowUser !== user) continue
        if (appType && rowType !== appType) continue
        if (state && rowState !== state) continue
        if (finalStatus && rowFinal !== finalStatus) continue
        if (onlyFailed && !failed) continue
        apps.push(mapCmYarnApp(row))
      }
      const failedCount = apps.filter((a) => str(a.finalStatus).toUpperCase() === 'FAILED' || str(a.state).toUpperCase() === 'FAILED').length
      ctx.warnings.push(...cmWarnings)

      return {
        clusterName: cluster,
        yarnService: service,
        timeRange: { from, to },
        totalScanned: rawApps.length,
        returned: apps.length,
        failedCount,
        filters: { user: user || null, applicationType: appType || null, state: state || null, finalStatus: finalStatus || null, onlyFailed },
        apps,
        warnings: ctx.warnings,
        message: `扫描 ${rawApps.length} 个 YARN 应用，过滤后 ${apps.length} 个（失败 ${failedCount} 个）；用 yarn/app 或 yarn/diagnose 深入单个作业`,
      }
    }

    case 'app': {
      const appId = requireStr(args, 'application_id', '如 application_1700000000000_0001')
      if (ctx.yarn.hasRm) {
        const app = obj(obj(await ctx.yarn.rmGet(`apps/${encodeURIComponent(appId)}`, [], ctx.signal)).app)
        return {
          source: 'resourcemanager',
          applicationId: str(app.id, appId),
          name: str(app.name),
          user: str(app.user),
          queue: str(app.queue),
          applicationType: str(app.applicationType),
          state: str(app.state),
          finalStatus: str(app.finalStatus),
          diagnostics: str(app.diagnostics),
          trackingUrl: str(app.trackingUrl),
          amHostHttpAddress: str(app.amHostHttpAddress),
          amContainerLogs: str(app.amContainerLogs),
          startedTime: app.startedTime ?? null,
          finishedTime: app.finishedTime ?? null,
          elapsedTime: app.elapsedTime ?? null,
          raw: app,
        }
      }
      const { cluster, service } = await yarnServiceName(ctx, args)
      const row = obj(
        await ctx.client.get(
          `/clusters/${encodeURIComponent(cluster)}/services/${encodeURIComponent(service)}/yarnApplications/${encodeURIComponent(appId)}`,
          [],
          ctx.signal,
        ),
      )
      ctx.warnings.push('未能获得 yarnRmUrl（未配置且自动推导失败），已退回 CM 元数据（无 diagnostics 失败摘要）；手动配置 ResourceManager 地址后可取 diagnostics 与 AM 容器位置')
      return {
        source: 'cloudera-manager',
        clusterName: cluster,
        yarnService: service,
        ...mapCmYarnApp(row),
        raw: row,
        warnings: ctx.warnings,
      }
    }

    case 'attempts': {
      requireRm(ctx)
      const appId = requireStr(args, 'application_id', '如 application_1700000000000_0001')
      const raw = await ctx.yarn.rmGet(`apps/${encodeURIComponent(appId)}/appattempts`, [], ctx.signal)
      const attempts = rmAppAttempts(raw)
      return {
        applicationId: appId,
        attemptCount: attempts.length,
        latest: latestAttempt(attempts) ?? null,
        attempts: attempts.map((a) => ({
          appAttemptId: str(a.appAttemptId),
          id: num(a.id) ?? null,
          containerId: str(a.containerId),
          nodeId: str(a.nodeId),
          nodeHttpAddress: str(a.nodeHttpAddress),
          appAttemptState: str(a.appAttemptState),
          logsLink: str(a.logsLink),
          startTime: a.startTime ?? null,
          finishedTime: a.finishedTime ?? null,
        })),
      }
    }

    case 'logs': {
      if (!ctx.yarn.hasJhs) {
        throw new Error(
          'yarn/logs 需要 JobHistory Server 地址：请在设置 → 插件 → CDH 填 yarnJhsUrl（如 http://jhs:19888，可粘贴 yarn.log.server.url），或确保插件能读到 yarn-site.xml 自动推导；仅支持免 Kerberos（SPNEGO）的 HTTP 端点',
        )
      }
      const appId = requireStr(args, 'application_id', '如 application_1700000000000_0001')
      const file = str(args.file).trim() || str(args.log_type).trim() || 'stderr'
      const lines = Math.max(1, Math.min(5000, Math.floor(num(args.lines) ?? 200)))
      let nodeId = str(args.node).trim()
      let containerId = str(args.container_id).trim()
      let user = str(args.user).trim()
      let entity = str(args.entity).trim()

      // 缺字段时用 RM 补全（默认取最新 attempt 的 AM 容器）。
      if (!nodeId || !containerId || !user) {
        if (!ctx.yarn.hasRm) {
          throw new Error(
            '缺少 node/container_id/user，且未配置 yarnRmUrl 无法自动定位 AM 容器。请显式传 node/container_id/user，或配置 yarnRmUrl（如 http://rm:8088）',
          )
        }
        const app = obj(obj(await ctx.yarn.rmGet(`apps/${encodeURIComponent(appId)}`, [], ctx.signal)).app)
        if (!user) user = str(app.user)
        const attempts = rmAppAttempts(await ctx.yarn.rmGet(`apps/${encodeURIComponent(appId)}/appattempts`, [], ctx.signal))
        const wanted = str(args.attempt_id).trim()
        const attempt = (wanted ? attempts.find((a) => str(a.appAttemptId) === wanted) : undefined) ?? latestAttempt(attempts)
        if (attempt) {
          // 失败态 logsLink 指向 JHS，路径里就有准确的 node/container/entity/user。
          const parsed = parseAggregatedLogsPath(str(attempt.logsLink))
          if (parsed) {
            if (!nodeId) nodeId = parsed.nodeId
            if (!containerId) containerId = parsed.containerId
            if (!entity) entity = parsed.entity
            if (!user) user = parsed.user
          }
          if (!nodeId) nodeId = str(attempt.nodeId)
          if (!containerId) containerId = str(attempt.containerId)
        }
      }
      if (!nodeId || !containerId || !user) {
        throw new Error(
          `无法定位容器日志（node="${nodeId}" container="${containerId}" user="${user}"）：作业可能仍在运行（聚合未完成）或 RM 未返回 AM 容器。可显式传 node/container_id/user 重试`,
        )
      }
      if (!entity) entity = containerId

      const html = await ctx.yarn.jhsLogHtml({ nodeId, containerId, entity, user, file, start: -logChunkBytes(lines) }, ctx.signal)
      const extracted = extractLogText(html)
      if (extracted.source === 'fallback') {
        ctx.warnings.push('JHS 未返回 <pre> 日志正文（可能聚合未完成、文件不存在或 ACL 拒绝），已回退为页面文本')
      }
      const tail = tailLines(extracted.text, lines)
      return {
        applicationId: appId,
        containerId,
        nodeId,
        user,
        entity,
        file,
        source: extracted.source,
        totalLines: tail.total,
        returnedLines: tail.lines.length,
        log: truncate(tail.lines.join('\n'), MAX_TEXT_CHARS),
        warnings: ctx.warnings,
      }
    }

    case 'flink_logs': {
      requireRm(ctx)
      const appId = requireStr(args, 'application_id', '如 application_1700000000000_0001')
      const component = str(args.component).trim().toLowerCase() || 'all'
      if (!['all', 'jobmanager', 'taskmanager'].includes(component)) {
        throw new Error('component 仅支持 all / jobmanager / taskmanager')
      }
      const taskManagerId = str(args.taskmanager_id).trim()
      const rawFile = str(args.file).trim()
      // 默认只取主日志（*.log）；file:"all" / "*" 取全部，含 .out/.err
      const fileFilter = rawFile === '*' || rawFile.toLowerCase() === 'all' ? '' : rawFile || 'log'
      const lines = Math.max(1, Math.min(5000, Math.floor(num(args.lines) ?? 200)))
      const limit = Math.max(1, Math.min(50, Math.floor(num(args.limit) ?? 5)))

      const app = obj(obj(await ctx.yarn.rmGet(`apps/${encodeURIComponent(appId)}`, [], ctx.signal)).app)
      const appType = str(app.applicationType).toUpperCase()
      if (appType && !appType.includes('FLINK')) {
        throw new Error(`作业 applicationType=${appType} 不是 Flink；Spark 作业请用 yarn/spark_logs，其他类型用 yarn/logs`)
      }
      if (!appIsLive(app)) {
        throw new Error(
          `Flink JobManager REST 只在作业运行期间可用（当前 state=${str(app.state, '?')} finalStatus=${str(app.finalStatus, '?')}）：` +
            '已结束的作业请用 yarn/logs 取 JHS 聚合的 JobManager（AM）容器日志；TaskManager 日志只能在运行期间抓取',
        )
      }
      const base = engineBaseFromApp(app)
      if (!base) {
        throw new Error('ResourceManager 未返回 trackingUrl / amHostHttpAddress，无法定位 Flink JobManager Web API')
      }

      const wantJobManager = component !== 'taskmanager'
      const wantTaskManagers = component !== 'jobmanager'
      let jobManager: Record<string, unknown> | null = null
      let taskManagerCount = 0
      const taskManagers: unknown[] = []

      if (wantJobManager) {
        const listed = flinkLogFiles(await ctx.yarn.engineGetJson(base, '/jobmanager/logs', ctx.signal))
        const selected = selectLogFiles(listed, fileFilter)
        if (listed.length === 0) {
          ctx.warnings.push('JobManager 未返回日志文件清单（检查作业是否仍在运行、REST 是否可达）')
        } else if (selected.length === 0) {
          ctx.warnings.push(`JobManager 日志文件名不含 "${fileFilter}"（可用：${listed.map((file) => file.name).join(', ')}）`)
        }
        const files: EngineLogFetch[] = []
        for (const file of selected) {
          files.push(await fetchEngineLogFile(ctx, base, `/jobmanager/logs/${encodeURIComponent(file.name)}`, file, lines))
        }
        jobManager = { fileCount: listed.length, fetchedFileCount: files.length, files }
      }

      if (wantTaskManagers) {
        let ids: string[] = []
        try {
          ids = flinkTaskManagerIds(await ctx.yarn.engineGetJson(base, '/taskmanagers', ctx.signal))
        } catch (err) {
          // TaskManager 清单失败不拖垮已取到的 JobManager 日志
          ctx.warnings.push(`Flink TaskManager 清单获取失败（降级为仅 JobManager 日志）：${err instanceof Error ? err.message : String(err)}`)
        }
        taskManagerCount = ids.length
        const matched = taskManagerId ? ids.filter((id) => id === taskManagerId || id.includes(taskManagerId)) : ids
        const selectedIds = matched.slice(0, limit)
        if (taskManagerId && matched.length === 0) {
          ctx.warnings.push(`taskmanager_id="${taskManagerId}" 未匹配（共 ${ids.length} 个：${ids.join(', ') || '无'}）`)
        } else if (!taskManagerId && ids.length > limit) {
          ctx.warnings.push(`TaskManager 共 ${ids.length} 个，仅取前 ${limit} 个（用 taskmanager_id 指定或调大 limit）`)
        }
        for (const id of selectedIds) {
          try {
            const listed = flinkLogFiles(
              await ctx.yarn.engineGetJson(base, `/taskmanagers/${encodeURIComponent(id)}/logs`, ctx.signal),
            )
            const files: EngineLogFetch[] = []
            for (const file of selectLogFiles(listed, fileFilter)) {
              files.push(
                await fetchEngineLogFile(
                  ctx,
                  base,
                  `/taskmanagers/${encodeURIComponent(id)}/logs/${encodeURIComponent(file.name)}`,
                  file,
                  lines,
                ),
              )
            }
            taskManagers.push({ id, fileCount: listed.length, files })
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            ctx.warnings.push(`TaskManager ${id} 日志清单获取失败（降级）：${message}`)
            taskManagers.push({ id, files: [], error: message })
          }
        }
      }

      return {
        applicationId: appId,
        engine: 'flink',
        baseUrl: base,
        app: {
          name: str(app.name),
          user: str(app.user),
          state: str(app.state),
          applicationType: str(app.applicationType),
        },
        jobManager,
        taskManagerCount,
        fetchedTaskManagerCount: taskManagers.length,
        taskManagers,
        warnings: ctx.warnings,
        message:
          `Flink 作业 ${appId} 引擎日志取证完成：JobManager ${wantJobManager ? '已取' : '未取'}，` +
          `TaskManager ${taskManagers.length}/${taskManagerCount} 个；REST 仅作业运行期间可用，且需免 Kerberos（SPNEGO）`,
      }
    }

    case 'spark_logs': {
      const appId = requireStr(args, 'application_id', '如 application_1700000000000_0001')
      const logType = str(args.log_type).trim().toLowerCase() || 'stderr'
      if (logType !== 'stderr' && logType !== 'stdout') throw new Error('log_type 仅支持 stderr 或 stdout')
      const executorFilter = str(args.executor_id).trim()
      const lines = Math.max(1, Math.min(5000, Math.floor(num(args.lines) ?? 200)))
      const limit = Math.max(1, Math.min(50, Math.floor(num(args.limit) ?? 10)))

      let app: Record<string, unknown> = {}
      let user = str(args.user).trim()
      if (ctx.yarn.hasRm) {
        try {
          app = obj(obj(await ctx.yarn.rmGet(`apps/${encodeURIComponent(appId)}`, [], ctx.signal)).app)
          if (!user) user = str(app.user)
        } catch (err) {
          ctx.warnings.push(`ResourceManager 未返回作业信息（可能已被清理，改查 History Server）：${err instanceof Error ? err.message : String(err)}`)
        }
      }
      const appType = str(app.applicationType).toUpperCase()
      if (appType && !appType.includes('SPARK')) {
        ctx.warnings.push(`applicationType=${appType} 不是 SPARK，结果可能为空；Flink 作业请用 yarn/flink_logs`)
      }

      // 运行中作业走 RM 代理拿实时 executor 列表；已结束或 RM 无记录时走 Spark History Server
      let base = ''
      let source = ''
      if (appIsLive(app)) {
        const liveBase = engineBaseFromApp(app)
        if (liveBase) {
          base = liveBase
          source = 'resourcemanager-proxy'
        }
      }
      if (!base) {
        await resolveSparkHistoryUrl(ctx)
        if (ctx.yarn.hasSparkHistory) {
          base = ctx.yarn.sparkHistoryUrl
          source = 'spark-history-server'
        }
      }
      if (!base) {
        throw new Error(
          '未能定位 Spark REST：运行中作业需要 yarnRmUrl（默认从 CM 推导）；' +
            '已完成/失败作业需要 Spark History Server 地址（设置 sparkHistoryUrl，或由 CM Spark 角色 Web UI 自动推导），' +
            '否则请先用 yarn/logs 取 driver（AM）容器日志',
        )
      }

      const executorsPath = `/api/v1/applications/${encodeURIComponent(appId)}/executors`
      let executorsRaw: unknown
      try {
        executorsRaw = await ctx.yarn.engineGetJson(base, executorsPath, ctx.signal)
      } catch (err) {
        // RM 代理不可用时，已配置/可推导的 History Server 仍能给出 executor 列表（含运行中作业）
        if (source !== 'resourcemanager-proxy') throw err
        await resolveSparkHistoryUrl(ctx)
        if (!ctx.yarn.hasSparkHistory) throw err
        ctx.warnings.push(
          `RM 代理取 Spark executor 列表失败（${err instanceof Error ? err.message : String(err)}），改走 Spark History Server`,
        )
        base = ctx.yarn.sparkHistoryUrl
        source = 'spark-history-server'
        executorsRaw = await ctx.yarn.engineGetJson(base, executorsPath, ctx.signal)
      }
      const executors = sparkExecutors(executorsRaw)
      if (executors.length === 0) {
        ctx.warnings.push('REST 未返回 executor 列表（作业刚启动、History Server 尚未收录，或 event log 未记录日志 URL）')
      }
      // driver 排在最前：失败根因多数在 driver 日志里
      executors.sort((a, b) => (a.id === 'driver' ? -1 : b.id === 'driver' ? 1 : 0))
      const selected = executorFilter ? executors.filter((item) => item.id === executorFilter) : executors.slice(0, limit)
      if (executorFilter && selected.length === 0) {
        ctx.warnings.push(`executor_id="${executorFilter}" 未匹配（可用：${executors.map((item) => item.id).join(', ') || '无'}）`)
      } else if (!executorFilter && executors.length > limit) {
        ctx.warnings.push(`共 ${executors.length} 个 executor，仅取前 ${limit} 个（用 executor_id 指定或调大 limit）`)
      }

      const results: unknown[] = []
      let fallbackWarned = false
      for (const executor of selected) {
        const rawLogUrl = executor.logs[logType] ?? executor.logs[logType.toUpperCase()] ?? ''
        if (!rawLogUrl) {
          results.push({
            id: executor.id,
            hostPort: executor.hostPort,
            active: executor.active,
            error: `executorLogs 未提供 ${logType} URL（可用：${Object.keys(executor.logs).join(', ') || '无'}）`,
          })
          continue
        }
        try {
          const fetched = await ctx.yarn.containerLogHtml(rawLogUrl, logChunkBytes(lines), user, ctx.signal)
          const extracted = extractLogText(fetched.html)
          if (extracted.source === 'fallback' && !fallbackWarned) {
            fallbackWarned = true
            ctx.warnings.push('NM/JHS 未返回 <pre> 日志正文（可能 ACL 拒绝或日志已删除），已回退为页面文本')
          }
          const tail = tailLines(extracted.text, lines)
          results.push({
            id: executor.id,
            hostPort: executor.hostPort,
            active: executor.active,
            logUrl: fetched.url,
            source: extracted.source,
            totalLines: tail.total,
            returnedLines: tail.lines.length,
            errorLines: extractErrorLines(extracted.text, 20),
            log: truncate(tail.lines.join('\n'), MAX_TEXT_CHARS),
          })
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          ctx.warnings.push(`executor ${executor.id} 日志获取失败（降级）：${message}`)
          results.push({ id: executor.id, hostPort: executor.hostPort, active: executor.active, logUrl: rawLogUrl, error: message })
        }
      }

      return {
        applicationId: appId,
        engine: 'spark',
        baseUrl: base,
        source,
        logType,
        app: {
          name: str(app.name),
          user,
          state: str(app.state),
          finalStatus: str(app.finalStatus),
          applicationType: str(app.applicationType),
        },
        executorCount: executors.length,
        fetchedExecutorCount: results.length,
        executors: results,
        warnings: ctx.warnings,
        message:
          `Spark 作业 ${appId} 引擎日志取证完成：取 ${results.length}/${executors.length} 个 executor 的 ${logType}；` +
          `运行中作业走 RM 代理，已结束作业需 Spark History Server（仅免 Kerberos 的 HTTP 端点）`,
      }
    }

    case 'diagnose': {
      const appId = requireStr(args, 'application_id', '如 application_1700000000000_0001')
      const lines = Math.max(1, Math.min(2000, Math.floor(num(args.lines) ?? 200)))
      const findings: Array<{ check: string; level: string; detail: string }> = []
      let appInfo: Record<string, unknown> = {}
      let diagnostics = ''
      let finalStatus = ''
      let applicationType = ''
      let user = ''

      if (ctx.yarn.hasRm) {
        const app = obj(obj(await ctx.yarn.rmGet(`apps/${encodeURIComponent(appId)}`, [], ctx.signal)).app)
        diagnostics = str(app.diagnostics)
        finalStatus = str(app.finalStatus).toUpperCase()
        applicationType = str(app.applicationType)
        user = str(app.user)
        appInfo = {
          applicationId: str(app.id, appId),
          name: str(app.name),
          user,
          queue: str(app.queue),
          applicationType,
          state: str(app.state),
          finalStatus: str(app.finalStatus),
          trackingUrl: str(app.trackingUrl),
          startedTime: app.startedTime ?? null,
          finishedTime: app.finishedTime ?? null,
          elapsedTime: app.elapsedTime ?? null,
        }
      } else {
        const { cluster, service } = await yarnServiceName(ctx, args)
        const row = obj(
          await ctx.client.get(
            `/clusters/${encodeURIComponent(cluster)}/services/${encodeURIComponent(service)}/yarnApplications/${encodeURIComponent(appId)}`,
            [],
            ctx.signal,
          ),
        )
        finalStatus = str(row.finalStatus).toUpperCase()
        applicationType = str(row.applicationType)
        user = str(row.user)
        appInfo = { ...mapCmYarnApp(row), applicationId: str(row.applicationId, appId) }
        ctx.warnings.push('未能获得 yarnRmUrl（未配置且自动推导失败）：diagnostics 失败摘要不可用，已退回 CM 元数据')
      }

      if (appIsLive(appInfo)) {
        ctx.warnings.push(
          '作业仍在运行：JHS 聚合日志可能尚未完成，实时组件日志请用 yarn/flink_logs（Flink）或 yarn/spark_logs（Spark）',
        )
      }
      if (finalStatus === 'FAILED') {
        findings.push({ check: 'APP_FAILED', level: 'BAD', detail: '作业最终状态 FAILED' })
      } else if (finalStatus === 'KILLED') {
        findings.push({ check: 'APP_KILLED', level: 'CONCERNING', detail: '作业被 KILLED（可能人为终止、超时或资源抢占）' })
      }
      if (diagnostics) findings.push({ check: 'DIAGNOSTICS', level: 'CONCERNING', detail: truncate(diagnostics, 2000) })

      let amContainer: Record<string, unknown> | null = null
      let logTail = ''
      let errorLines: string[] = []
      if (ctx.yarn.hasRm && ctx.yarn.hasJhs) {
        try {
          const attempts = rmAppAttempts(await ctx.yarn.rmGet(`apps/${encodeURIComponent(appId)}/appattempts`, [], ctx.signal))
          const attempt = latestAttempt(attempts)
          if (attempt) {
            const parsed = parseAggregatedLogsPath(str(attempt.logsLink))
            const nodeId = parsed?.nodeId || str(attempt.nodeId)
            const containerId = parsed?.containerId || str(attempt.containerId)
            const entity = parsed?.entity || containerId
            const owner = parsed?.user || user
            amContainer = {
              appAttemptId: str(attempt.appAttemptId),
              containerId,
              nodeId,
              nodeHttpAddress: str(attempt.nodeHttpAddress),
              appAttemptState: str(attempt.appAttemptState),
            }
            if (nodeId && containerId && owner) {
              const file = str(args.file).trim() || 'stderr'
              const html = await ctx.yarn.jhsLogHtml({ nodeId, containerId, entity, user: owner, file, start: -logChunkBytes(lines) }, ctx.signal)
              const extracted = extractLogText(html)
              if (extracted.source === 'fallback') ctx.warnings.push('JHS 未返回日志正文（聚合可能未完成），已回退为页面文本')
              const tail = tailLines(extracted.text, lines)
              logTail = truncate(tail.lines.join('\n'), MAX_TEXT_CHARS)
              errorLines = extractErrorLines(extracted.text)
              if (errorLines.length > 0) {
                findings.push({ check: 'AM_LOG_ERRORS', level: 'BAD', detail: `AM 容器日志含 ${errorLines.length} 行异常/错误关键行（见 errorLines）` })
              }
            }
          }
        } catch (err) {
          ctx.warnings.push(`AM 容器日志取证失败（降级，不拖垮整体）：${err instanceof Error ? err.message : String(err)}`)
        }
      } else {
        if (!ctx.yarn.hasRm) ctx.warnings.push('未能获得 yarnRmUrl（未配置且自动推导失败）：无法定位 AM 容器')
        if (!ctx.yarn.hasJhs) ctx.warnings.push('未能获得 yarnJhsUrl（未配置且自动推导失败）：无法取容器日志正文')
      }

      const overall: Severity = findings.some((f) => f.level === 'BAD')
        ? 'BAD'
        : findings.some((f) => f.level === 'CONCERNING')
          ? 'CONCERNING'
          : 'GOOD'
      return {
        applicationId: appId,
        overallHealth: overall,
        app: appInfo,
        diagnostics: diagnostics || null,
        amContainer,
        errorLines,
        logTail,
        findings,
        warnings: ctx.warnings,
        message: `YARN 作业 ${appId}（${applicationType || '未知类型'}）诊断完成，最终状态 ${finalStatus || '未知'}，整体 ${overall}`,
      }
    }

    default:
      throw new Error(`yarn 不支持 action=${action}`)
  }
}

/* ── 分发器 ─────────────────────────────────────────────────────────────── */

/**
 * 构造分发器。
 *
 * @param settings 现读配置快照提供者（volatile 值随时在变，每次调用现读）
 * @param signal 调用方取消信号（agent 工具传入 exec.signal）
 */
export function createDispatcher(
  settings: () => CdhSettings,
  signal?: AbortSignal,
): (category: string, action: string, args?: Record<string, unknown>) => Promise<unknown> {
  return async function dispatch(category, action, args = {}) {
    const snapshot = settings()
    if (!snapshot.host) {
      throw new Error('未配置 Cloudera Manager 连接（设置 → 插件 → CDH：host / username / password）')
    }
    const supported = CDH_ACTIONS[category as CdhCategory]
    if (!supported) {
      throw new Error(`未知分类 "${category}"。可选：${CDH_CATEGORIES.join(', ')}`)
    }
    if (!supported.includes(action)) {
      throw new Error(`分类 ${category} 不支持 action="${action}"。可选：${supported.join(', ')}`)
    }

    const ctx: Context = {
      client: new CmClient(snapshot),
      yarn: new YarnClient(snapshot),
      settings: snapshot,
      signal,
      warnings: [],
    }

    try {
      switch (category as CdhCategory) {
        case 'connection':
          return await connectionAction(ctx, action)
        case 'cluster':
          return await clusterAction(ctx, action, args)
        case 'service':
          return await serviceAction(ctx, action, args)
        case 'host':
          return await hostAction(ctx, action, args)
        case 'role':
          return await roleAction(ctx, action, args)
        case 'events':
          return await eventsAction(ctx, action, args)
        case 'metrics':
          return await metricsAction(ctx, action, args)
        case 'diagnosis':
          return await diagnosisAction(ctx, action, args)
        case 'yarn':
          return await yarnAction(ctx, action, args)
        default:
          throw new Error(`未知分类 "${category}"`)
      }
    } catch (err) {
      // 业务错误补上分类/动作上下文，模型据此改参数。
      if (err instanceof CmError) throw err
      const message = err instanceof Error ? err.message : String(err)
      throw new Error(`${category}/${action} 失败: ${message}`)
    }
  }
}

/** 供冒烟脚本与测试使用：不访问网络，只校验分类/动作表。 */
export function describeCategories(): Record<string, readonly string[]> {
  return CDH_ACTIONS
}

// 保留类型导出，避免 analysis.ts 的 HealthProblem 在未使用时被判为未使用导入。
export type { HealthProblem }
