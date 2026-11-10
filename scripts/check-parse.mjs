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

// YARN 日志纯函数：HTML 反转义 / <pre> 提取 / 错误行 / attempt 解析 / logsLink 解析
assert.equal(analysis.unescapeHtml('a &lt;b&gt; &amp; &quot;c&quot; &#39;d&#39; &#x41;'), 'a <b> & "c" \'d\' A')
assert.equal(analysis.unescapeHtml('&amp;lt;'), '&lt;', '单遍反转义，不应把 &amp;lt; 二次解成 <')
const extracted = analysis.extractLogText('<html><body><h1>Logs</h1><pre>line1\njava.lang.Exception: boom\nCaused by: x</pre></body></html>')
assert.equal(extracted.source, 'pre')
assert.match(extracted.text, /java\.lang\.Exception: boom/)
const fallback = analysis.extractLogText('<html><body><h1>Aggregation is not enabled. Try the nodemanager</h1></body></html>')
assert.equal(fallback.source, 'fallback')
assert.match(fallback.text, /Aggregation is not enabled/)
const errLines = analysis.extractErrorLines('INFO ok\nERROR bad thing\njava.lang.OutOfMemoryError: Java heap space\nCaused by: root\nINFO fine')
assert.equal(errLines.length, 3)
assert.match(errLines[0], /ERROR bad thing/)
assert.deepEqual(analysis.rmAppAttempts({ appAttempts: { appAttempt: [{ id: 1 }, { id: 2 }] } }).length, 2)
assert.deepEqual(analysis.rmAppAttempts({ appAttempts: { appAttempt: { id: 1 } } }), [{ id: 1 }], '单对象 attempt 也兼容')
assert.equal(analysis.latestAttempt([{ id: 1, containerId: 'a' }, { id: 2, containerId: 'b' }]).containerId, 'b')
assert.equal(analysis.latestAttempt([]), undefined)
const parsed = analysis.parseAggregatedLogsPath('http://jhs:19888/jobhistory/logs/nm1:8041/container_123_01_000001/container_123_01_000001/hive')
assert.deepEqual(parsed, { nodeId: 'nm1:8041', containerId: 'container_123_01_000001', entity: 'container_123_01_000001', user: 'hive' })
assert.equal(analysis.parseAggregatedLogsPath('http://nm:8042/node/containerlogs/container_x/hive'), undefined, '运行态 NM 链接不是 JHS 路径')

// yarn-site.xml 推导纯函数：XML 解析 / 绑定地址替换 / HA 与 JHS 提取
const props = analysis.parseHadoopConfigXml(
  '<configuration><property><name>yarn.resourcemanager.webapp.address</name><value>rm1:8088</value></property>' +
    '<property><name>yarn.log.server.url</name><value>http://jhs1:19888/jobhistory/logs</value></property>' +
    '<property><name>escaped</name><value>a &amp; b</value></property></configuration>',
)
assert.equal(props.get('yarn.resourcemanager.webapp.address'), 'rm1:8088')
assert.equal(props.get('yarn.log.server.url'), 'http://jhs1:19888/jobhistory/logs')
assert.equal(props.get('escaped'), 'a & b', 'XML 实体应反转义')
assert.equal(analysis.webappAddressToUrl('rm1:8088'), 'http://rm1:8088')
assert.equal(analysis.webappAddressToUrl('0.0.0.0:8088'), '', '绑定地址缺主机名时返回空')
assert.equal(analysis.webappAddressToUrl('0.0.0.0:8088', 'rmhost'), 'http://rmhost:8088')
assert.equal(analysis.webappAddressToUrl('localhost:8088', 'rmhost'), 'http://rmhost:8088')
assert.equal(analysis.webappAddressToUrl(''), '')
const derived = analysis.deriveYarnUrlsFromProps(props)
assert.equal(derived.rmUrl, 'http://rm1:8088')
assert.equal(derived.jhsUrl, 'http://jhs1:19888/jobhistory/logs')
assert.equal(derived.ha, false)
assert.equal(derived.needsHostname, false)
const bindDerived = analysis.deriveYarnUrlsFromProps(new Map([['yarn.resourcemanager.webapp.address', '0.0.0.0:8088']]))
assert.equal(bindDerived.rmUrl, '')
assert.equal(bindDerived.needsHostname, true, '绑定地址需角色主机名替换')
assert.equal(analysis.webappAddressToUrl(bindDerived.rmAddrRaw, 'rmhost'), 'http://rmhost:8088')
const haDerived = analysis.deriveYarnUrlsFromProps(
  new Map([
    ['yarn.resourcemanager.ha.enabled', 'true'],
    ['yarn.resourcemanager.ha.rm-ids', 'rm1,rm2'],
    ['yarn.resourcemanager.webapp.address.rm1', 'rm1host:8088'],
    ['yarn.resourcemanager.webapp.address.rm2', 'rm2host:8088'],
  ]),
)
assert.equal(haDerived.ha, true)
assert.equal(haDerived.rmId, 'rm1')
assert.equal(haDerived.rmUrl, 'http://rm1host:8088', 'HA 取第一个 rm-id')

// 引擎原生日志纯函数：Flink 文件/ TM 清单、Spark executorLogs、容器日志尾部 URL
assert.deepEqual(
  analysis.flinkLogFiles({ logs: [{ name: 'jobmanager.log', size: 12, mtime: 1 }, { name: '' }] }),
  [{ name: 'jobmanager.log', size: 12, mtime: 1 }],
)
assert.deepEqual(analysis.flinkLogFiles([{ name: 'taskmanager.err' }]), [{ name: 'taskmanager.err', size: null, mtime: null }])
assert.deepEqual(analysis.flinkTaskManagerIds([{ id: 'tm-1' }, { id: 'tm-2' }, { id: 'tm-1' }]), ['tm-1', 'tm-2'])
assert.deepEqual(analysis.flinkTaskManagerIds({ taskmanagers: [{ id: 'tm-9' }] }), ['tm-9'])
const sparkExec = analysis.sparkExecutors([
  { id: 'driver', hostPort: 'h1:1', isActive: true, executorLogs: { stderr: 'http://nm:8042/node/containerlogs/c1/u/stderr' } },
  { id: '1', hostPort: 'h2:2', isActive: false, executorLogs: { stdout: 'http://nm:8042/node/containerlogs/c2/u/stdout', stderr: '' } },
])
assert.equal(sparkExec.length, 2)
assert.deepEqual(sparkExec[0].logs, { stderr: 'http://nm:8042/node/containerlogs/c1/u/stderr' })
assert.equal(sparkExec[1].active, false)
const tailUrl = new URL(analysis.containerLogTailUrl('http://nm:8042/node/containerlogs/c1/u/stderr?start=-1', 4096, 'alice'))
assert.equal(tailUrl.searchParams.get('start'), '-4096', 'start 应被覆盖为请求的尾部字节数')
assert.equal(tailUrl.searchParams.get('user.name'), 'alice', '非安全模式需补 user.name')
assert.equal(analysis.containerLogTailUrl('not a url', 1, 'u'), 'not a url')

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
  'yarn',
])
assert.ok(actions.diagnosis.includes('impala'))
assert.deepEqual([...actions.yarn], ['apps', 'app', 'attempts', 'logs', 'flink_logs', 'spark_logs', 'diagnose'])

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

// yarn 地址推导需读 CM，冒烟离线：桩 globalThis.fetch。
// 先验证推导失败（fetch 拒绝）时降级仍给可读纠正提示。
const realFetch = globalThis.fetch
globalThis.fetch = async () => {
  throw new Error('offline smoke: network disabled')
}
const dispatchYarn = service.createDispatcher(() => ({
  host: 'cm.example.com',
  port: 7180,
  username: 'admin',
  password: '',
  useTls: false,
  apiVersion: 'v41',
  timeoutMs: 30000,
  defaultCluster: '',
  yarnRmUrl: '',
  yarnJhsUrl: '',
  sparkHistoryUrl: '',
}))
await assert.rejects(() => dispatchYarn('yarn', 'logs', { application_id: 'application_x' }), /yarnJhsUrl/)
await assert.rejects(() => dispatchYarn('yarn', 'attempts', { application_id: 'application_x' }), /yarnRmUrl/)
await assert.rejects(() => dispatchYarn('yarn', 'nope', {}), /不支持 action/)

// 再离线端到端验证自动推导：桩 fetch 路由 CM roles/configFiles 与 RM REST，
// 留空 yarnRmUrl/yarnJhsUrl 时应读 yarn-site.xml 补齐 RM 地址并用它发请求。
const yarnSiteXml =
  '<?xml version="1.0"?>\n<configuration>\n' +
  '<property><name>yarn.resourcemanager.webapp.address</name><value>rm1.example.com:8088</value></property>\n' +
  '<property><name>yarn.log.server.url</name><value>http://jhs1.example.com:19888/jobhistory/logs</value></property>\n' +
  '</configuration>'
const jsonResponse = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
const seenUrls = []
globalThis.fetch = async (url) => {
  const u = String(url)
  seenUrls.push(u)
  const path = new URL(u).pathname
  if (path.endsWith('/services')) return jsonResponse({ items: [{ type: 'YARN', name: 'yarn1' }] })
  if (path.endsWith('/roles')) {
    return jsonResponse({ items: [{ type: 'RESOURCEMANAGER', name: 'yarn-RM-1', hostRef: { hostId: 'h1' } }] })
  }
  if (path.endsWith('/configFiles/yarn-site.xml')) return new Response(yarnSiteXml, { status: 200 })
  if (path === '/ws/v1/cluster/apps/application_x/appattempts') {
    assert.equal(new URL(u).host, 'rm1.example.com:8088', '应用推导出的 RM 地址')
    return jsonResponse({
      appAttempts: {
        appAttempt: [{ id: 1, appAttemptId: 'appattempt_x_000001', containerId: 'container_x_01_000001', nodeId: 'nm1:8041', appAttemptState: 'FINISHED' }],
      },
    })
  }
  throw new Error(`offline smoke: unexpected fetch ${u}`)
}
const dispatchDerived = service.createDispatcher(() => ({
  host: 'cm.example.com',
  port: 7180,
  username: 'admin',
  password: '',
  useTls: false,
  apiVersion: 'v41',
  timeoutMs: 30000,
  defaultCluster: 'cluster1',
  yarnRmUrl: '',
  yarnJhsUrl: '',
  sparkHistoryUrl: '',
}))
const attemptsResult = await dispatchDerived('yarn', 'attempts', { application_id: 'application_x', service_name: 'yarn1' })
assert.equal(attemptsResult.attemptCount, 1)
assert.equal(attemptsResult.latest.containerId, 'container_x_01_000001')
assert.ok(seenUrls.some((u) => u.includes('/configFiles/yarn-site.xml')), '应读 yarn-site.xml 推导地址')

// 离线验证引擎原生日志拆分：Flink JobManager/TaskManager、Spark driver/executor。
// 大文件用超长内容验证滚动尾部（只保留末尾字节，不把整文件堆进内存/结果）。
const longTail = `HEAD_MARKER\n${'x'.repeat(70000)}\nTAIL_MARKER\n`
globalThis.fetch = async (url) => {
  const u = String(url)
  seenUrls.push(u)
  const parsed = new URL(u)
  const path = parsed.pathname
  if (path === '/ws/v1/cluster/apps/application_flink_0001') {
    return jsonResponse({
      app: {
        id: 'application_flink_0001',
        applicationType: 'FLINK',
        state: 'RUNNING',
        finalStatus: 'UNDEFINED',
        trackingUrl: 'http://rm1.example.com:8088/proxy/application_flink_0001/',
        user: 'flinkuser',
      },
    })
  }
  if (path === '/proxy/application_flink_0001/jobmanager/logs') {
    return jsonResponse({ logs: [{ name: 'jobmanager.log', size: 10 }, { name: 'jobmanager.out', size: 1 }] })
  }
  if (path === '/proxy/application_flink_0001/jobmanager/logs/jobmanager.log') {
    return new Response('2026-01-01 INFO start\n2026-01-01 ERROR boom\n', { status: 200 })
  }
  if (path === '/proxy/application_flink_0001/taskmanagers') {
    return jsonResponse([{ id: 'tm-1' }, { id: 'tm-2' }])
  }
  if (path.startsWith('/proxy/application_flink_0001/taskmanagers/') && path.endsWith('/logs')) {
    return jsonResponse({ logs: [{ name: 'taskmanager.log' }] })
  }
  if (path === '/proxy/application_flink_0001/taskmanagers/tm-2/logs/taskmanager.log') {
    return new Response(longTail, { status: 200 })
  }
  if (path.startsWith('/proxy/application_flink_0001/taskmanagers/') && path.endsWith('/logs/taskmanager.log')) {
    return new Response('tm log line\n', { status: 200 })
  }
  if (path === '/ws/v1/cluster/apps/application_spark_0001') {
    return jsonResponse({
      app: {
        id: 'application_spark_0001',
        applicationType: 'SPARK',
        state: 'FINISHED',
        finalStatus: 'FAILED',
        trackingUrl: 'http://rm1.example.com:8088/proxy/application_spark_0001/',
        user: 'sparkuser',
      },
    })
  }
  if (path === '/api/v1/applications/application_spark_0001/executors') {
    assert.equal(parsed.host, 'shs.example.com:18080', '已完成作业应走 Spark History Server')
    return jsonResponse([
      {
        id: '1',
        hostPort: 'n1:1',
        isActive: false,
        executorLogs: { stderr: 'http://nm1.example.com:8042/node/containerlogs/c1/sparkuser/stderr' },
      },
      {
        id: 'driver',
        hostPort: 'n0:0',
        isActive: false,
        executorLogs: { stderr: 'http://nm0.example.com:8042/node/containerlogs/c0/sparkuser/stderr' },
      },
      {
        id: '2',
        hostPort: 'n2:2',
        isActive: false,
        executorLogs: { stdout: 'http://nm2.example.com:8042/node/containerlogs/c2/sparkuser/stdout' },
      },
    ])
  }
  if (path.startsWith('/node/containerlogs/')) {
    assert.equal(parsed.searchParams.get('user.name'), 'sparkuser', '容器日志应补 user.name')
    assert.ok(parsed.searchParams.get('start').startsWith('-'), '容器日志应带负 start 取尾部')
    return new Response('<html><body><pre>ERROR executor failed\nstack line</pre></body></html>', { status: 200 })
  }
  throw new Error(`offline smoke: unexpected fetch ${u}`)
}
const dispatchEngine = service.createDispatcher(() => ({
  host: 'cm.example.com',
  port: 7180,
  username: 'admin',
  password: '',
  useTls: false,
  apiVersion: 'v41',
  timeoutMs: 30000,
  defaultCluster: '',
  yarnRmUrl: 'http://rm1.example.com:8088',
  yarnJhsUrl: 'http://jhs1.example.com:19888',
  sparkHistoryUrl: 'http://shs.example.com:18080',
}))
const flinkResult = await dispatchEngine('yarn', 'flink_logs', {
  application_id: 'application_flink_0001',
  lines: 5,
})
assert.equal(flinkResult.engine, 'flink')
assert.equal(flinkResult.jobManager.fetchedFileCount, 1, '默认只取 *.log，跳过 .out')
assert.ok(flinkResult.jobManager.files[0].log.includes('ERROR boom'))
assert.equal(flinkResult.taskManagerCount, 2)
assert.equal(flinkResult.taskManagers.length, 2)
assert.ok(flinkResult.taskManagers[1].files[0].log.includes('TAIL_MARKER'), '滚动缓冲应保留文件末尾')
assert.ok(!flinkResult.taskManagers[1].files[0].log.includes('HEAD_MARKER'), '滚动缓冲应丢弃超大文件头部')

const sparkResult = await dispatchEngine('yarn', 'spark_logs', {
  application_id: 'application_spark_0001',
  lines: 5,
})
assert.equal(sparkResult.engine, 'spark')
assert.equal(sparkResult.source, 'spark-history-server')
assert.equal(sparkResult.executorCount, 3)
assert.equal(sparkResult.executors[0].id, 'driver', 'driver 应排在最前')
assert.ok(sparkResult.executors[0].log.includes('ERROR executor failed'))
assert.ok(
  sparkResult.executors.some((item) => typeof item.error === 'string' && item.error.includes('stdout')),
  '缺 stderr 的 executor 应给出可读 error',
)
const filteredSpark = await dispatchEngine('yarn', 'spark_logs', {
  application_id: 'application_spark_0001',
  executor_id: 'driver',
})
assert.equal(filteredSpark.fetchedExecutorCount, 1)
globalThis.fetch = realFetch

// 内置 skills：注册清单是事实来源，名称/描述合法、正文 md 是发布物且覆盖关键纠错点
const skill = await import('../lib/skill.js')
assert.equal(skill.CDH_TSQUERY_SKILL, 'cdh-tsquery')
assert.ok(skill.CDH_TSQUERY_SKILL_DESCRIPTION.length > 0)
assert.ok(skill.CDH_TSQUERY_SKILL_DESCRIPTION.length <= 500, 'catalog 描述会被 500 字符截断')
assert.ok(Array.isArray(skill.BUILTIN_SKILLS))
assert.equal(
  skill.BUILTIN_SKILLS.length,
  7,
  '新增/删除内置 skill 时本断言与 check-plugin.mjs 的 EXPECTED_SKILLS 必须同步',
)
const skillNames = skill.BUILTIN_SKILLS.map((s) => s.name)
assert.equal(new Set(skillNames).size, skillNames.length, 'skill 名不得重复')
for (const def of skill.BUILTIN_SKILLS) {
  assert.match(def.name, /^[a-z][a-z0-9-]*$/, `skill 名须 kebab-case: ${def.name}`)
  assert.ok(def.description.length > 0, `${def.name} 需要 description`)
  assert.ok(def.description.length <= 500, `${def.name} catalog 描述会被 500 字符截断`)
  assert.match(def.file, /^cdh-[a-z-]+\.md$/, `${def.name} 正文文件名`)
  const md = readFileSync(new URL(`../skills/${def.file}`, import.meta.url), 'utf8')
  assert.ok(md.length > 500, `${def.name} 正文过短`)
  assert.match(md, /^# /, `${def.name} 正文应有标题`)
  assert.match(md, /cdh/, `${def.name} 正文应含 cdh 调用示例`)
}
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

const yarnJobsMd = readFileSync(new URL('../skills/cdh-yarn-jobs.md', import.meta.url), 'utf8')
for (const must of [
  'yarn/apps', // 取证序列起点
  'yarn/logs', // 容器日志取证
  'diagnostics', // 失败摘要
  'jobmanager.log', // Flink 日志文件分流
  'yarnRmUrl', // 配置前提
  'SPNEGO', // Kerberos 限制
  'yarn-site.xml', // 地址自动推导来源
  '自动推导', // 手动优先、CM 兜底
  'flink_logs', // Flink 按 JobManager/TaskManager 拆分
  'spark_logs', // Spark 按 driver/executor 拆分
  'sparkHistoryUrl', // 已完成 Spark 作业的 History Server 前提
  'executorLogs', // Spark REST 日志 URL 来源
]) {
  assert.ok(yarnJobsMd.includes(must), `cdh-yarn-jobs 正文缺少关键点: ${must}`)
}

console.log('check-parse: ok')
