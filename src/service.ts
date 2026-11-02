/**
 * CDH 诊断业务层。
 *
 * 与参考实现 `cdh_diagnosis_mcp` 的 8 个分类工具一一对应：
 * connection / cluster / service / host / role / events / metrics / diagnosis。
 * 浏览器半 RPC 与 agent 工具共用同一分发器（`createDispatcher`），
 * 校验、错误折叠、配置解析只实现一次。
 */
import { CmClient, CmError, truncate, type QueryParams } from './cm-client.js'
import {
  analyzeHealthChecks,
  bool,
  buildEventQuery,
  hostStatusIssue,
  itemsOf,
  latestValue,
  metricLatest,
  num,
  obj,
  parseSeverity,
  ratioPercent,
  resolveClusterName,
  runStateIssue,
  str,
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
}

/** 分发器（浏览器 RPC 与 agent 工具共用）。 */
export type Dispatch = (category: string, action: string, args: Record<string, unknown>) => Promise<unknown>

interface Context {
  client: CmClient
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
