/**
 * 诊断公共逻辑：健康度归纳、实体提取、集群名解析、事件查询语法规范化。
 *
 * 对应参考实现 `cdh_diagnosis_mcp/src/utils.rs` 与 `src/tools/events.rs`
 * 的 `normalize_event_query`。
 */

/** 健康度级别。 */
export type Severity = 'GOOD' | 'CONCERNING' | 'BAD' | 'UNKNOWN'

/** CM 的 healthSummary / healthCheck.summary 字符串 → 内部级别。 */
export function parseSeverity(raw: unknown): Severity {
  const s = typeof raw === 'string' ? raw.toUpperCase() : ''
  switch (s) {
    case 'GOOD':
      return 'GOOD'
    case 'CONCERNING':
    case 'WARN':
    case 'WARNING':
      return 'CONCERNING'
    case 'BAD':
    case 'ERROR':
    case 'CRITICAL':
      return 'BAD'
    default:
      return 'UNKNOWN'
  }
}

/** 宽松对象取值。 */
export function obj(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

export function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

export function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function bool(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/** 从 CM 列表响应（`{items:[...]}`）中提取数组，缺失时返回空数组。 */
export function itemsOf(value: unknown): unknown[] {
  const items = obj(value).items
  return Array.isArray(items) ? items : []
}

/** 单个健康检查项的问题条目。 */
export interface HealthProblem {
  name: string
  summary: string
  explanation: string
}

/** 把实体的 healthSummary 与 healthChecks 归纳为可读结论。 */
export function analyzeHealthChecks(entity: unknown): {
  healthSummary: Severity
  problemCount: number
  problems: HealthProblem[]
} {
  const row = obj(entity)
  const healthSummary = parseSeverity(row.healthSummary)
  const checks = Array.isArray(row.healthChecks) ? row.healthChecks : []
  const problems: HealthProblem[] = []
  for (const check of checks) {
    const item = obj(check)
    const severity = parseSeverity(item.summary)
    if (severity !== 'BAD' && severity !== 'CONCERNING') continue
    problems.push({
      name: str(item.name, '?'),
      summary: str(item.summary),
      explanation: str(item.explanation),
    })
  }
  return { healthSummary, problemCount: problems.length, problems }
}

/**
 * 运行状态是否构成问题（返回说明文本；不构成问题时返回 undefined）。
 *
 * 以 CM 自身语义（`ApiEntityStatus`，v11+）为准，避免我们自己臆断"应该在跑"：
 * - `DOWN`：CM 判定"应运行而未运行"，才是异常；
 * - `STOPPED`：按预期停止（用户手动停止的服务/角色），不报；
 * - `NONE`：无状态组件（纯 client / gateway 角色、client-only 服务），根本不存在
 *   "运行中"的概念，不期待 STARTED/BUSY；
 * - 其余取值（健康类、STARTING/STOPPING、UNKNOWN）：CM 未判定为 DOWN，不额外判罪，
 *   真正的健康问题由 `analyzeHealthChecks` 那条通道兜底。
 *
 * `entityStatus` 缺失（旧 API / 视图未返回）时回退到 `serviceState` / `roleState`：
 * `NA` 与 `STOPPED` 视为"不期待运行"不报，其余非 STARTED/BUSY 才报。
 */
export function runStateIssue(entity: unknown, kind: 'service' | 'role'): string | undefined {
  const row = obj(entity)
  const stateKey = kind === 'service' ? 'serviceState' : 'roleState'
  const runningStates = kind === 'service' ? ['STARTED'] : ['STARTED', 'BUSY']
  const label = kind === 'service' ? '服务' : '角色'
  const state = str(row[stateKey], 'UNKNOWN')
  const upper = state.toUpperCase()
  const entityStatus = str(row.entityStatus).toUpperCase()

  if (entityStatus === 'DOWN') {
    return `${label}状态为 ${state}，CM 判定应处于运行状态（entityStatus=DOWN）`
  }
  if (entityStatus) return undefined
  if (upper === 'NA' || upper === 'STOPPED') return undefined
  if (runningStates.includes(upper)) return undefined
  return `${label}状态为 ${state}，预期 ${runningStates.join(' 或 ')}`
}

/**
 * 主机运行状态是否构成问题（返回说明文本；不构成问题时返回 undefined）。
 *
 * `ApiHost` 上没有 `status` 字段（历史 bug：读它永远得到 UNKNOWN，导致每台主机都被误报），
 * 事实来源是 `entityStatus`（v11+，与 CM UI 状态列同源）：
 * - `DOWN`：CM 判定应在线而未运行（Agent 停止/离线），报 BAD；
 * - `STOPPED`：按预期停止，不报；
 * - 健康类取值（GOOD_HEALTH / CONCERNING_HEALTH / BAD_HEALTH 等）表达的是健康而非
 *   运行状态，交给 `analyzeHealthChecks` 归纳，这里不重复判罪；
 * - `entityStatus` 缺失（API < v11）时不臆断，返回 undefined。
 */
export function hostStatusIssue(host: unknown): string | undefined {
  const status = str(obj(host).entityStatus).toUpperCase()
  if (status === 'DOWN') {
    return 'CM 判定主机应在线但未运行（entityStatus=DOWN），Agent 可能已停止'
  }
  return undefined
}

/** 统一成功包装（与参考实现的 `{success:true,data:...}` 形态不同——工具直接返回 data）。 */
export function notAvailable(what: string): never {
  throw new Error(`${what} 不可用`)
}

/**
 * 解析集群名：优先参数 `cluster_name`，其次插件配置的默认集群，
 * 最后取 CM 上的第一个集群。
 */
export async function resolveClusterName(
  listClusters: () => Promise<unknown>,
  defaultCluster: string,
  explicit: string | undefined,
): Promise<string> {
  const wanted = (explicit ?? '').trim()
  if (wanted) return wanted
  if (defaultCluster.trim()) return defaultCluster.trim()

  const response = await listClusters()
  const items = itemsOf(response)
  const first = items.find((item) => str(obj(item).name).trim())
  if (!first) throw new Error('未找到任何集群，无法自动推断 cluster_name')
  return str(obj(first).name)
}

/** 计算使用率百分比。 */
export function ratioPercent(used: number | undefined, total: number | undefined): number | undefined {
  if (used === undefined || total === undefined || !(total > 0)) return undefined
  return (used / total) * 100
}

/** 取时序序列最后一个有限数值。 */
export function latestValue(series: unknown): number | undefined {
  const data = obj(series).data
  if (!Array.isArray(data)) return undefined
  for (let i = data.length - 1; i >= 0; i -= 1) {
    const value = num(obj(data[i]).value)
    if (value !== undefined && Number.isFinite(value)) return value
  }
  return undefined
}

/** 在 /timeseries 响应里按指标名取最新值。 */
export function metricLatest(raw: unknown, metricName: string): number | undefined {
  for (const series of itemsOf(raw)) {
    if (str(obj(series).metricName) === metricName) return latestValue(series)
  }
  return undefined
}

/**
 * CM 事件查询语法（`/events` 的 `query` 参数）规范化，语义同参考实现：
 * - 相等比较符必须是 `==`，单 `=` 会触发 "Missing comparator"；
 * - 多个属性用分号 `;` 连接（AND），分号两侧不能有空格；
 * - 同一属性取多个值用空格表示 OR；
 * - 用户常把逗号当 OR，`attr==v1,attr==v2` 会被规范成 `attr==v1 v2`。
 * - 日期比较符 `=lt=` / `=le=` / `=ge=` / `=gt=` 原样保留。
 */
export function normalizeEventQuery(input: string): string {
  return mergeSameAttrComma(trimSemicolons(toDoubleEquals(input)))
}

function toDoubleEquals(input: string): string {
  const chars = Array.from(input)
  const n = chars.length
  let out = ''
  let i = 0
  while (i < n) {
    const ch = chars[i]!
    if (ch !== '=') {
      out += ch
      i += 1
      continue
    }
    const tail = chars.slice(i, i + 4).join('')
    if (tail === '=lt=' || tail === '=le=' || tail === '=ge=' || tail === '=gt=') {
      out += tail
      i += 4
      continue
    }
    const prevIsCmp = i > 0 && '=<>!'.includes(chars[i - 1]!)
    const nextIsEq = i + 1 < n && chars[i + 1] === '='
    out += prevIsCmp || nextIsEq ? '=' : '=='
    i += 1
  }
  return out
}

function trimSemicolons(input: string): string {
  return input.replace(/ ; /g, ';').replace(/; /g, ';').replace(/ ;/g, ';')
}

function isIdentChar(ch: string): boolean {
  return /[A-Za-z0-9_.]/.test(ch)
}

function identAt(chars: string[], start: number): { name: string; end: number } | undefined {
  let end = start
  while (end < chars.length && isIdentChar(chars[end]!)) end += 1
  if (end === start) return undefined
  return { name: chars.slice(start, end).join(''), end }
}

function readIdentLeft(chars: string[], end: number): string | undefined {
  let start = end
  while (start > 0 && isIdentChar(chars[start - 1]!)) start -= 1
  if (start === end) return undefined
  return chars.slice(start, end).join('')
}

function attrBeforeComma(chars: string[], commaIndex: number): string | undefined {
  if (commaIndex === 0) return undefined
  for (let j = commaIndex; j > 0; j -= 1) {
    if (j >= 4) {
      const four = chars.slice(j - 4, j).join('')
      if (four === '=lt=' || four === '=le=' || four === '=ge=' || four === '=gt=') {
        return readIdentLeft(chars, j - 4)
      }
    }
    const two = chars.slice(j - 1, j + 1).join('')
    if (two === '==' || two === '!=' || two === '>=' || two === '<=' || two === '<>') {
      return readIdentLeft(chars, j - 1)
    }
  }
  return undefined
}

/** 把「同属性逗号列举」规范为「空格 OR」。 */
function mergeSameAttrComma(input: string): string {
  const chars = Array.from(input)
  const n = chars.length
  let out = ''
  let i = 0
  while (i < n) {
    const ch = chars[i]!
    if (ch !== ',') {
      out += ch
      i += 1
      continue
    }
    const left = attrBeforeComma(chars, i)
    let j = i + 1
    while (j < n && chars[j] === ' ') j += 1
    const right = identAt(chars, j)
    if (right && left) {
      let k = right.end
      while (k < n && chars[k] === ' ') k += 1
      const isEq = k + 1 < n && chars[k] === '=' && chars[k + 1] === '='
      if (left === right.name && isEq) {
        out += ' '
        i = k + 2
        continue
      }
    }
    out += ','
    i += 1
  }
  return out
}

/** 事件 severity 合法枚举。 */
export const EVENT_SEVERITIES = ['INFO', 'IMPORTANT', 'WARNING', 'ERROR', 'CRITICAL'] as const

/** 由结构化参数拼装 CM 事件查询串与时间范围。 */
export function buildEventQuery(args: Record<string, unknown>): {
  query: string
  startTime: string
  endTime: string
} {
  const raw = str(args.query).trim()
  const category = str(args.category).trim()
  const eventType = str(args.event_type).trim()
  const source = str(args.source).trim()
  const severities = Array.isArray(args.severities)
    ? args.severities.filter((s): s is string => typeof s === 'string').map((s) => s.trim()).filter(Boolean)
    : []
  const hours = num(args.hours)
  const startRaw = str(args.start_time).trim()
  const endRaw = str(args.end_time).trim()

  for (const severity of severities) {
    const upper = severity.toUpperCase()
    if (!(EVENT_SEVERITIES as readonly string[]).includes(upper)) {
      throw new Error(
        `severities 取值非法: '${severity}'。合法值：${EVENT_SEVERITIES.join(', ')}。` +
          `示例：{"severities":["CRITICAL","ERROR"],"hours":24}`,
      )
    }
  }

  const parts: string[] = []
  if (category) parts.push(`category==${category}`)
  if (severities.length > 0) parts.push(`severity==${severities.map((s) => s.toUpperCase()).join(' ')}`)
  if (eventType) parts.push(`eventtype==${eventType}`)
  if (source) parts.push(`source==${source}`)

  let startTime = startRaw
  if (!startTime && hours !== undefined) {
    startTime = new Date(Date.now() - hours * 3_600_000).toISOString()
  }

  return {
    query: raw ? normalizeEventQuery(raw) : parts.join(';'),
    startTime,
    endTime: endRaw,
  }
}
