/**
 * dsh-cdh 的 agent 工具。
 *
 * 设计同参考实现的 8 个分类工具，但收拢成一个入口：`cdh(category, action, args)`。
 * 工具面越小，模型选错工具的概率越低；具体能力的最后一跳由 `CDH_ACTIONS` 表达。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { CDH_ACTIONS, CDH_CATEGORIES, type Dispatch } from './service.js'

/** 输出 JSON 截断上限（工具结果过大会挤爆上下文）。 */
const OUTPUT_LIMIT = 256 * 1024

/** 每个分类的 action 清单（写进工具描述，模型无需猜）。 */
const ACTION_HINT = CDH_CATEGORIES.map((category) => `${category}: ${CDH_ACTIONS[category].join('/')}`).join(' | ')

export function createCdhTool(dispatch: Dispatch) {
  return defineTool({
    name: 'cdh',
    description: [
      '只读诊断 Cloudera Manager / CDH 集群（配置在 dsh-cdh 插件设置里：host/port/username/password）。',
      '调用方式：给 `category` + `action`，参数放进 `args`。',
      `可用能力 —— ${ACTION_HINT}。`,
      '常用示例：',
      '{category:"connection",action:"test"} 先确认连通性与 API 版本；',
      '{category:"diagnosis",action:"overview",args:{cluster_name:"prod"}} 集群总览评分与建议；',
      '{category:"cluster",action:"diagnose"} 服务健康度汇总；',
      '{category:"host",action:"diagnose"} 主机心跳/状态异常；',
      '{category:"role",action:"logs",args:{service_name:"hdfs1",role_name:"hdfs-DATANODE-xxx",log_type:"stderr",lines:200}};',
      '{category:"events",action:"alerts",args:{hours:24,severities:["CRITICAL","ERROR"]}};',
      '{category:"metrics",action:"list",args:{filter:"dfs_",context:"SERVICE"}} 先查指标名再 query；',
      '{category:"diagnosis",action:"hdfs"} / "yarn" / "impala" 专项诊断。',
      '写 metrics/query 的 tsquery 前先加载 skill "cdh-tsquery"（CM tsquery 语法、与 events/query 的区别、指标名核对）；',
      'cluster_name 省略时用插件默认集群，其次取 CM 上的第一个集群。',
    ].join(' '),
    parameters: {
      category: {
        type: 'string',
        required: true,
        description: `诊断分类，one of: ${CDH_CATEGORIES.join(', ')}`,
      },
      action: {
        type: 'string',
        required: true,
        description: `分类下的操作：${ACTION_HINT}`,
      },
      args: {
        type: 'object',
        additionalProperties: true,
        description:
          '操作参数：cluster_name / service_name / role_name / host_id / file_name / log_type / lines / ' +
          'tsquery / filter / hours / severities / query / from / to / limit / command_id 等，按 action 选取。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          category: { type: 'string' },
          action: { type: 'string' },
          ok: { type: 'boolean' },
          result: { type: 'string', description: 'JSON 结果（超过 256KB 截断）' },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: value.ok
            ? `cdh ${value.category}/${value.action} → ${value.result}`
            : `cdh ${value.category}/${value.action} 失败 → ${value.result}`,
        },
      ],
    },
    async execute(args, exec) {
      if (exec.signal?.aborted) throw new Error('已取消')
      const category = String(args.category ?? '').trim()
      const action = String(args.action ?? '').trim()
      if (!(CDH_CATEGORIES as readonly string[]).includes(category)) {
        throw new Error(`未知分类 "${category}"。可选：${CDH_CATEGORIES.join(', ')}`)
      }
      const supported = CDH_ACTIONS[category as (typeof CDH_CATEGORIES)[number]]
      if (!supported.includes(action)) {
        throw new Error(`分类 ${category} 不支持 action="${action}"。可选：${supported.join(', ')}`)
      }

      const payload: Record<string, unknown> =
        typeof args.args === 'object' && args.args !== null ? { ...(args.args as Record<string, unknown>) } : {}

      try {
        const value = await dispatch(category, action, payload)
        let json = JSON.stringify(value, null, 2) ?? 'null'
        if (json.length > OUTPUT_LIMIT) {
          json = `${json.slice(0, OUTPUT_LIMIT)}\n…[已截断 ${json.length - OUTPUT_LIMIT} 字符]`
        }
        return { category, action, ok: true, result: json }
      } catch (err) {
        // 错误也走结构化返回（ok:false），模型能读到完整错误消息并自行纠正参数。
        return {
          category,
          action,
          ok: false,
          result: err instanceof Error ? err.message : String(err),
        }
      }
    },
  })
}
