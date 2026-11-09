/**
 * dsh-cdh 的配置载体（dsh ≥ 0.1.7 契约）。
 *
 * 插件配置 = 导出的 `Config` schema + profile 条目 config。本插件的 bundle patch
 * 用 `id: dsh-cdh`，所以配置命名空间就是 `dsh-cdh`，标记 `.volatile()` 的字段会
 * 进入「设置 → 插件」表单并可热改（loader 原地更新引用、不重挂插件）。
 *
 * ⚠ volatile 字段解析后是 cosmokit 的 `Volatile<T>` **稳定引用**：
 * 业务代码一律经 {@link readCdhSettings} 每次现读现用，禁止在 apply 时缓存快照。
 *
 * ⚠ 密码字段**不标** `role('secret')`：settings 的远程读取统一走 `redactSecrets: true`，
 * secret 字段会被整个移除，配置页会读到空值。密码的保护由「仅写本机 profile 文件 +
 * 工具/RPC 回包从不回显密码」承担。
 */
import z from '@deepseek-ai/schemastery'

/** 只依赖 `get()` 的结构类型（兼容新旧 dsh 与测试替身）。 */
export interface VolatileRef<T> {
  get(): T
}

/** 字段可能是 volatile 引用（dsh ≥ 0.1.7）或普通值（旧版 dsh / 测试替身）。 */
export type MaybeVolatile<T> = T | VolatileRef<T>

/** 宿主半与工具使用的**普通值**配置快照。 */
export interface CdhSettings {
  /** CM 主机名或 IP（可带端口，如 `cm.example.com:7180`） */
  host: string
  port: number
  username: string
  password: string
  useTls: boolean
  /** CM REST API 版本，如 `v41` */
  apiVersion: string
  timeoutMs: number
  /** 默认集群名；留空时自动取 CM 上的第一个集群 */
  defaultCluster: string
  /** YARN ResourceManager Web 基址（如 http://rm.example.com:8088）；留空则 yarn 分类退回 CM 元数据 */
  yarnRmUrl: string
  /** YARN JobHistory Server Web 基址（如 http://jhs.example.com:19888）；留空则取不了容器日志正文 */
  yarnJhsUrl: string
}

/** `Config` schema 的解析结果：每个字段都可能是 volatile 引用。 */
export interface CdhConfig {
  host?: MaybeVolatile<string>
  port?: MaybeVolatile<number>
  username?: MaybeVolatile<string>
  password?: MaybeVolatile<string>
  useTls?: MaybeVolatile<boolean>
  apiVersion?: MaybeVolatile<string>
  timeoutMs?: MaybeVolatile<number>
  defaultCluster?: MaybeVolatile<string>
  yarnRmUrl?: MaybeVolatile<string>
  yarnJhsUrl?: MaybeVolatile<string>
}

/** 与 Schema 默认值保持一致的常量兜底。 */
const DEFAULTS = {
  host: 'localhost',
  port: 7180,
  username: 'admin',
  password: '',
  useTls: false,
  apiVersion: 'v41',
  timeoutMs: 30_000,
  defaultCluster: '',
  yarnRmUrl: '',
  yarnJhsUrl: '',
}

/**
 * cdh 插件的 **Config schema**（dsh ≥ 0.1.7 的配置载体）。
 *
 * 全部字段 volatile：改完即生效，无需重启（每个请求都现读配置）。
 */
export const CdhConfigSchema = z.object({
  host: z.string().default(DEFAULTS.host).volatile().description(
    'Cloudera Manager 主机名或 IP，可带端口（如 cm.example.com 或 cm.example.com:7180）',
  ),
  port: z.number().default(DEFAULTS.port).volatile().description('Cloudera Manager 端口，默认 7180'),
  username: z.string().default(DEFAULTS.username).volatile().description('Cloudera Manager 登录用户名'),
  password: z.string().default(DEFAULTS.password).volatile().description(
    'Cloudera Manager 登录密码（HTTP Basic Auth）。密码明文写入本机 profile 配置，请只填可信集群',
  ),
  useTls: z.boolean().default(DEFAULTS.useTls).volatile().description(
    '是否使用 HTTPS。Request 走 Node fetch：自签证书会被拒绝，需可信证书或内网 HTTP',
  ),
  apiVersion: z.string().default(DEFAULTS.apiVersion).volatile().description(
    'CM REST API 版本，默认 v41（CM 7.1.x / CDH 7.1.7）。CM 6.x 常用 v31/v40，可在此调整',
  ),
  timeoutMs: z.number().default(DEFAULTS.timeoutMs).volatile().description('单次 CM 请求超时（毫秒），默认 30000'),
  defaultCluster: z.string().default(DEFAULTS.defaultCluster).volatile().description(
    '默认集群名：工具省略 cluster_name 时使用；留空自动取 CM 上的第一个集群',
  ),
  yarnRmUrl: z.string().default(DEFAULTS.yarnRmUrl).volatile().description(
    'YARN ResourceManager Web 基址（如 http://rm.example.com:8088）：取作业 diagnostics 失败摘要与 AM 容器位置。' +
      '留空时自动从 CM 的 yarn-site.xml（yarn.resourcemanager.webapp.address）推导，推导失败才退回 CM 元数据。仅支持免 Kerberos（SPNEGO）的 HTTP 端点',
  ),
  yarnJhsUrl: z.string().default(DEFAULTS.yarnJhsUrl).volatile().description(
    'YARN JobHistory Server Web 基址（如 http://jhs.example.com:19888，可直接粘贴 yarn.log.server.url，会自动忽略路径部分）：' +
      '取聚合容器日志正文（Spark driver / Flink JobManager / MR·Tez AM）。留空时自动从 CM 的 yarn-site.xml（yarn.log.server.url）推导，推导失败则 yarn/logs 不可用',
  ),
})

/** 解包 volatile 引用（dsh ≥ 0.1.7）或普通值（旧版 dsh / 测试替身）。 */
function unwrap<T>(value: MaybeVolatile<T> | undefined | null): T | undefined {
  if (value === undefined || value === null) return undefined
  const ref = value as VolatileRef<T>
  if (typeof ref.get === 'function') {
    try {
      return ref.get()
    } catch {
      // 引用被替换/尚未提交时不致命：退回默认值。
      return undefined
    }
  }
  return value as T
}

function clamp(value: number | undefined, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.floor(value)))
}

function text(value: string | undefined, fallback: string): string {
  return typeof value === 'string' ? value.trim() : fallback
}

/** 取一份**普通值**配置快照（每次请求处理前都调用，不缓存）。 */
export function readCdhSettings(config?: CdhConfig | null): CdhSettings {
  const source: CdhConfig = config ?? {}
  const apiVersionRaw = text(unwrap(source.apiVersion), DEFAULTS.apiVersion) || DEFAULTS.apiVersion
  return {
    host: text(unwrap(source.host), DEFAULTS.host) || DEFAULTS.host,
    port: clamp(unwrap(source.port), 1, 65535, DEFAULTS.port),
    username: text(unwrap(source.username), DEFAULTS.username) || DEFAULTS.username,
    password: typeof unwrap(source.password) === 'string' ? (unwrap(source.password) as string) : DEFAULTS.password,
    useTls: unwrap(source.useTls) === true,
    apiVersion: apiVersionRaw.startsWith('v') ? apiVersionRaw : `v${apiVersionRaw}`,
    timeoutMs: clamp(unwrap(source.timeoutMs), 1000, 600_000, DEFAULTS.timeoutMs),
    defaultCluster: text(unwrap(source.defaultCluster), DEFAULTS.defaultCluster),
    yarnRmUrl: text(unwrap(source.yarnRmUrl), DEFAULTS.yarnRmUrl),
    yarnJhsUrl: text(unwrap(source.yarnJhsUrl), DEFAULTS.yarnJhsUrl),
  }
}
