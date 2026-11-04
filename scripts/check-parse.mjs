/**
 * 冒烟：纯逻辑（分析层）单元校验，不联网、不依赖 cordis。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const analysis = await import('../lib/analysis.js')

// parseSeverity
assert.equal(analysis.parseSeverity('GOOD'), 'GOOD')
assert.equal(analysis.parseSeverity('concerning'), 'CONCERNING')
assert.equal(analysis.parseSeverity('CRITICAL'), 'BAD')
assert.equal(analysis.parseSeverity('weird'), 'UNKNOWN')

// analyzeHealthChecks
const health = analysis.analyzeHealthChecks({
  healthSummary: 'BAD',
  healthChecks: [
    { name: 'HDFS_DFS_CAPACITY', summary: 'BAD', explanation: '容量不足' },
    { name: 'HDFS_FREE_SPACE', summary: 'GOOD', explanation: '充足' },
  ],
})
assert.equal(health.healthSummary, 'BAD')
assert.equal(health.problemCount, 1)
assert.equal(health.problems[0].name, 'HDFS_DFS_CAPACITY')

// itemsOf / metricLatest
assert.equal(analysis.itemsOf({ items: [1, 2, 3] }).length, 3)
assert.equal(analysis.itemsOf({}).length, 0)
assert.equal(
  analysis.metricLatest({ items: [{ metricName: 'dfs_capacity', data: [{ value: 1 }, { value: 42 }] }] }, 'dfs_capacity'),
  42,
)

// ratioPercent
assert.equal(analysis.ratioPercent(50, 100), 50)
assert.equal(analysis.ratioPercent(1, 0), undefined)

// runStateIssue：无状态组件 / 手动停止 / CM 判定 DOWN
// 无状态（serviceState=NA，如纯 client 组件）不期待 STARTED
assert.equal(analysis.runStateIssue({ serviceState: 'NA' }, 'service'), undefined)
// 手动停止：entityStatus=STOPPED（按预期停止）不报；CM 判定应运行（DOWN）才报
assert.equal(analysis.runStateIssue({ serviceState: 'STOPPED', entityStatus: 'STOPPED' }, 'service'), undefined)
assert.match(analysis.runStateIssue({ serviceState: 'STOPPED', entityStatus: 'DOWN' }, 'service'), /DOWN/)
// 无状态角色（gateway/client，roleState=NA 或 entityStatus=NONE）不期待 STARTED
assert.equal(analysis.runStateIssue({ roleState: 'NA', type: 'HDFS_GATEWAY' }, 'role'), undefined)
assert.equal(analysis.runStateIssue({ roleState: 'STOPPED', entityStatus: 'NONE' }, 'role'), undefined)
// 手动停服务后其角色（entityStatus=STOPPED）不报；服务 STARTED 而角色 STOPPED（DOWN）必报
assert.equal(analysis.runStateIssue({ roleState: 'STOPPED', entityStatus: 'STOPPED' }, 'role'), undefined)
assert.match(analysis.runStateIssue({ roleState: 'STOPPED', entityStatus: 'DOWN' }, 'role'), /角色状态/)
// entityStatus 缺失时回退：STOPPED/NA 不报，其余非 STARTED/BUSY 仍报
assert.equal(analysis.runStateIssue({ serviceState: 'STOPPED' }, 'service'), undefined)
assert.equal(analysis.runStateIssue({ roleState: 'BUSY' }, 'role'), undefined)
assert.match(analysis.runStateIssue({ roleState: 'STOPPING' }, 'role'), /STOPPING/)

// hostStatusIssue：ApiHost 无 status 字段，状态判定只认 entityStatus
assert.equal(analysis.hostStatusIssue({ entityStatus: 'GOOD_HEALTH' }), undefined)
assert.equal(analysis.hostStatusIssue({ entityStatus: 'STOPPED' }), undefined)
assert.equal(analysis.hostStatusIssue({}), undefined)
assert.match(analysis.hostStatusIssue({ entityStatus: 'DOWN' }), /Agent/)

// 事件查询语法规范化（与参考实现 events.rs 的单测对齐）
const cases = [
  ['category=IMPALA_EVENT', 'category==IMPALA_EVENT'],
  ['category==IMPALA_EVENT', 'category==IMPALA_EVENT'],
  ['a>=1 and b<=2', 'a>=1 and b<=2'],
  ['severity!=ERROR', 'severity!=ERROR'],
  ['x<>y', 'x<>y'],
  ['a=b and c==d', 'a==b and c==d'],
  ['severity==CRITICAL,severity==ERROR', 'severity==CRITICAL ERROR'],
  ['severity==CRITICAL, severity==ERROR', 'severity==CRITICAL ERROR'],
  ['severity==CRITICAL,severity==ERROR,severity==WARN', 'severity==CRITICAL ERROR WARN'],
  ['a==1, b==2', 'a==1, b==2'],
  ['category==IMPALA_EVENT ; severity==ERROR', 'category==IMPALA_EVENT;severity==ERROR'],
  ['category==IMPALA_EVENT; severity==ERROR', 'category==IMPALA_EVENT;severity==ERROR'],
  ['timeReceived=ge=2024-01-01T00:00:00Z', 'timeReceived=ge=2024-01-01T00:00:00Z'],
]
for (const [input, expected] of cases) {
  assert.equal(analysis.normalizeEventQuery(input), expected, `normalizeEventQuery(${input})`)
}

// buildEventQuery：结构化拼装 + 非法 severity 教学式报错
const built = analysis.buildEventQuery({ severities: ['critical', 'ERROR'], hours: 24 })
assert.equal(built.query, 'severity==CRITICAL ERROR')
assert.ok(built.startTime, 'hours 应解析出 startTime')
assert.throws(() => analysis.buildEventQuery({ severities: ['FATAL'] }), /取值非法/)

// 分类/动作表自洽
const service = await import('../lib/service.js')
const actions = service.describeCategories()
assert.deepEqual(Object.keys(actions), [
  'connection',
  'cluster',
  'service',
  'host',
  'role',
  'events',
  'metrics',
  'diagnosis',
])
assert.ok(actions.diagnosis.includes('impala'))

// 未配置主机时给出可读错误（不联网）
const dispatch = service.createDispatcher(() => ({
  host: '',
  port: 7180,
  username: 'admin',
  password: '',
  useTls: false,
  apiVersion: 'v41',
  timeoutMs: 30000,
  defaultCluster: '',
}))
await assert.rejects(() => dispatch('connection', 'test', {}), /未配置 Cloudera Manager 连接/)

// 内置 skill：名称/描述是纯常量，正文 md 是发布物且覆盖关键纠错点
const skill = await import('../lib/skill.js')
assert.equal(skill.CDH_TSQUERY_SKILL, 'cdh-tsquery')
assert.ok(skill.CDH_TSQUERY_SKILL_DESCRIPTION.length > 0)
assert.ok(skill.CDH_TSQUERY_SKILL_DESCRIPTION.length <= 500, 'catalog 描述会被 500 字符截断')
const md = readFileSync(new URL('../skills/cdh-tsquery.md', import.meta.url), 'utf8')
for (const must of [
  'SELECT <metric expression>', // 语法骨架
  'events/query', // 与事件查询语法的区分
  'from', // 时间窗口走独立参数
  'metrics/list', // 指标名先查
  'rlike', // 谓词
  'under_replicated_blocks', // CDH 7 改名
]) {
  assert.ok(md.includes(must), `skill 正文缺少关键点: ${must}`)
}

console.log('check-parse: ok')
