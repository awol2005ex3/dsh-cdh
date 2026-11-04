# cdh-tsquery · 编写 Cloudera Manager tsquery

适用：调用 `cdh` 工具的 `{category:"metrics",action:"query"}` 编写 `tsquery` 参数前，
以及需要先检索指标名（`metrics/list`）、或排查 CM 返回的 tsquery 解析错误时。
本 skill 只讲 `metrics/*` 的 tsquery；`events/query` 是另一套语法，不要混用。

## 1. tsquery 不是 SQL

语法只有一条：`SELECT <metric expression> [WHERE <predicate>]`
没有 FROM / JOIN / GROUP BY / ORDER BY / LIMIT / AS / 子查询 / 注释。
token 大小写不敏感；多条语句用分号 `;` 串接（是「多语句」分隔符，不是 AND）。

- 具名指标可以省略 WHERE：`select jvm_total_threads, jvm_blocked_threads`
- `select *` 必须带 WHERE，否则非法：`select * where roleType = DATANODE`
- 逻辑与要写 `and`，别用 `;`

## 2. 最容易踩的坑：和 events/query 语法混淆

同一个 `cdh` 工具的 `events/query` 用 CM 事件查询语法（`==`、空格/逗号表示 OR、`;` 表示 AND）；
tsquery 完全相反：

| 用途 | tsquery（metrics/query） | 事件查询（events/query） |
| --- | --- | --- |
| 相等 | `category = HOST`（单个 `=`） | `category==HOST`（`==`） |
| OR | `or` 关键字，可配括号 | 空格/逗号分隔多值 |
| AND | `and` 关键字 | `;` 连接 |
| 不等于 | `!=`（仅用于标量谓词） | `!=` |
| 正则 | `rlike "regex"` | 无 |

把 `==`、逗号 OR、`;` AND 写进 tsquery 会直接报解析错误。

## 3. 时间范围不写在 tsquery 里

时间窗口由 `{category:"metrics",action:"query"}` 的 `from` / `to` **独立参数**传入
（ISO-8601，如 `2026-11-04T00:00:00Z`；省略则用 CM 默认窗口）。
tsquery 里没有时间范围谓词；`day in (1,2,3,4,5)` / `hour in [9:17]` 只是「按星期/小时周期性过滤」，
写在 WHERE 之后且**不加 AND**，与 `from`/`to` 是两回事。

## 4. 指标名必须先查，别凭空编

写 `select` 前先：
`{category:"metrics",action:"list",args:{filter:"cpu",context:"HOST"}}`
（`filter` 支持子串，`regex:true` 时按正则；`context` 对应 category，如 HOST / ROLE / SERVICE / DISK）。
指标名以 `/timeseries/schema` 的实际返回为准。CDH 7 / CM 7 常见改名：

- `dfs_under_replicated` → `under_replicated_blocks`
- `dfs_missing_blocks` → `missing_blocks`
- `yarn_allocated_memory_mb` → `yarn_reports_containers_allocated_memory`
- `yarn_allocated_vcores` → `yarn_reports_containers_allocated_vcores`
- 容量类 `dfs_capacity` / `dfs_capacity_used` / `dfs_capacity_used_non_hdfs` 保留原名

查询失败先看返回里的 `warnings` 字段，再回 `metrics/list` 核对名字。

## 5. WHERE 谓词

形式一：`time_series_attribute  operator  value`，operator 只有 `=` 和 `rlike`
（`<` `<=` `=` `!=` `>=` `>` 只用于下面的标量谓词）。

- 值含空格、或属性是 `xxxName` 类（entityName / serviceName / roleName / ...）的值 → 加双引号
- `rlike` 的值必须加引号，正则按 Java Pattern：`hostname rlike "dn[0-9]+.*"`
- 属性名和大多数值大小写不敏感；但 `displayName`、`serviceType` 的**值**大小写敏感
- 复合谓词用 `and` / `or` + 括号：
  `(roleType = DATANODE or roleType = TASKTRACKER) and hostname = "host1"`

形式二：`scalar_function(metric_expression) comparator number`
`select jvm_gc_count where last(jvm_gc_count) > 10`
comparator 为 `<` `<=` `=` `!=` `>=` `>`；数字可带单位：`5mb` / `5s` / `5kbps` / `500Mb`。

常用属性：`category`（HOST / ROLE / SERVICE / DISK / CLUSTER / DIRECTORY / FILESYSTEM / USER / ...）、
`entityName`（显示名+唯一 ID，不是纯服务名）、`hostname`、`hostId`、`serviceName`、
`serviceType`（值大小写敏感：HDFS / YARN / IMPALA / HBASE / ...）、
`roleType`（DATANODE / NAMENODE / NODEMANAGER / ...）、`roleName`、`roleState`、
`clusterDisplayName`、`active`（默认 true；查已删除实体用 `false`）、
`queueName`、`device`、`mountpoint`。

## 6. metric expression

逗号分隔；支持 `+ - * /` 与标量常量（用于画阈值线）：
`select await_time, await_read_time, 250 where category = DISK`
函数：`avg` `max` `min` `sum` `last`（返回标量，只用于 heatmap，别当时间序列期望）、
`dt` / `dt0`（每秒变化率；单调递增计数器用 dt0 跳过计数器重置产生的负速率）、
`integral` / `counter_delta`、`moving_avg(expr, seconds)`、
`stats(expr, max|min|avg|std_dev|sample|counter)`、`greatest` / `least`、
`getHostFact(numCores, 2)` / `getClusterFact(numCores, 2)` / `count_service_roles(...)`。
例：`select dt0(total_cpu_user)/getHostFact(numCores,1)*100 where category = ROLE`

## 7. 结果上限

指标太多会触发 `partial results` 警告：减少 `select` 的指标数，或用 `rlike` 缩小实体集合，
不要无限放宽。

## 8. 可直接套用的 cdh 调用

示例为参数示意（沿用 `cdh` 工具描述的 `{category:...}` 写法，tsquery 值用单引号包住以便内部双引号不转义；
实际按 JSON 传参）。

```
{category:"metrics",action:"list",args:{filter:"dfs_capacity",context:"SERVICE"}}   // 先找指标名
{category:"metrics",action:"query",args:{tsquery:'select cpu_percent where category = HOST',from:"2026-11-04T00:00:00Z",to:"2026-11-04T13:00:00Z"}}
{category:"metrics",action:"query",args:{tsquery:'select dfs_capacity, dfs_capacity_used where entityName = "hdfs1"'}}
{category:"metrics",action:"query",args:{tsquery:'select * where (roleType = DATANODE or roleType = TASKTRACKER) and hostname = "host1.example.com"'}}
{category:"metrics",action:"query",args:{tsquery:'select total_cpu_user where category = ROLE and hostname rlike "dn[0-9]+.*"'}}
```

若 CM 报 tsquery 解析错误，按顺序自查：① 是否混入了 `==` / 逗号 OR / `;` AND；
② `select *` 是否漏了 WHERE；③ 引号是否补齐（含空格 / xxxName / rlike）；
④ 指标名是否真实存在（回 `metrics/list` 核对）。
