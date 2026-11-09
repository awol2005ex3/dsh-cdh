# cdh-yarn-jobs · 排查 Spark / Flink / Hive on YARN 作业失败

适用：Spark on YARN、Flink on YARN、Hive on YARN（MR / Tez / Spark）作业失败、被 KILL、
长时间 ACCEPTED 不运行，需要取**作业 diagnostics** 与**容器日志正文**定位根因时加载。

> 插件只读：CM 侧走 `cdh` 工具，YARN 侧只发 HTTP GET（ResourceManager REST + JobHistory Server 聚合日志）。
> 不能登录主机、不能 `yarn logs` / 读 HDFS、不能 kill/重跑作业——这些交运维（第 6 节）。

## 0. 配置前提（先确认，否则后面会降级）

| 配置（设置 → 插件 → CDH） | 作用 | 留空时 |
| --- | --- | --- |
| `host`/账号/密码 | CM REST | 全部不可用 |
| `yarnRmUrl`（如 `http://rm:8088`） | RM REST：作业 `diagnostics`、AM 容器 `nodeId`/`containerId` | 自动从 CM 推导；推导失败才退回 CM 元数据（无 diagnostics）、`yarn/logs` 无法自动定位容器 |
| `yarnJhsUrl`（如 `http://jhs:19888`，可粘贴 `yarn.log.server.url`） | JHS 聚合容器日志正文 | 自动从 CM 推导；推导失败则 `yarn/logs` / `yarn/diagnose` 取不到日志正文 |

**地址自动推导（手动优先）**：`yarnRmUrl`/`yarnJhsUrl` 留空时，插件读一个 RESOURCEMANAGER 角色下发的
`yarn-site.xml`，取 `yarn.resourcemanager.webapp.address`（RM）与 `yarn.log.server.url`（JHS）自动补齐，
常见情况零额外配置。绑定地址 `0.0.0.0` 会用该角色主机名替换；HA 集群取第一个 rm-id 的地址并提示
「若指向 standby 请手动设 active RM」。推导过程与结果写在回包 `warnings` 里；推导失败降级为仅手动配置。
手动填的值永远优先，不会被推导覆盖。

**只支持免 Kerberos（SPNEGO）的 HTTP 端点**：零第三方依赖做不了 SPNEGO。Kerberos 集群要么把
`yarnRmUrl`/`yarnJhsUrl` 指向免认证反向代理，要么只用 `yarn/apps`（CM 侧）+ 运维 `yarn logs`。
`yarnRmUrl`/`yarnJhsUrl` 会自动忽略 URL 路径部分（粘贴带 `/jobhistory/logs` 的也能用）。

## 1. 固定取证序列

1. **找失败作业**（走 CM，无需额外配置；先用真实集群/服务名）：
   ```
   {category:"connection",action:"test"}
   {category:"yarn",action:"apps",args:{only_failed:true,limit:200}}
   {category:"yarn",action:"apps",args:{application_type:"SPARK",user:"hive",only_failed:true,from:"2026-11-08T00:00:00Z",to:"2026-11-09T00:00:00Z"}}
   ```
   `application_type` 常见值：`SPARK` / `MAPREDUCE` / `TEZ` / `FLINK`（以 CM 实际返回为准）。
   时间窗口用 `from`/`to`（ISO 8601），省略时默认最近 24 小时。
   `only_failed` 按 `finalStatus=FAILED` 或 `state=FAILED` 过滤；要含被杀作业用 `final_status:"KILLED"`。
   拿到 `applicationId`（形如 `application_1700000000000_0001`）后进下一步。
2. **取作业失败摘要 diagnostics**（最关键的一句根因往往在这里）：
   ```
   {category:"yarn",action:"app",args:{application_id:"application_xxx"}}
   ```
   有 RM 地址（手动配置或自动推导）时返回 `diagnostics` / `finalStatus` / `amContainerLogs` / `amHostHttpAddress`；
   两者都缺则退回 CM 元数据并给出 warning（此时 diagnostics 不可用，直接看第 4 步日志）。
3. **定位 AM 容器**（driver / JobManager / MR·Tez AM 所在容器）：
   ```
   {category:"yarn",action:"attempts",args:{application_id:"application_xxx"}}
   ```
   看 `latest`（最新 attempt）的 `containerId` / `nodeId`（host:8041）/ `logsLink`。
   多次重试的作业每个 attempt 各有一个 AM 容器，失败原因可能在不同 attempt。
4. **取容器日志正文**（默认自动用最新 attempt 的 AM 容器 + stderr）：
   ```
   {category:"yarn",action:"logs",args:{application_id:"application_xxx",file:"stderr",lines:300}}
   {category:"yarn",action:"logs",args:{application_id:"application_xxx",file:"jobmanager.log",lines:300}}
   {category:"yarn",action:"logs",args:{application_id:"application_xxx",container_id:"container_xxx",node:"nm1:8041",user:"hive",file:"syslog",lines:300}}
   ```
   `file` 按引擎选（第 2 节）；`lines` 最大 5000。显式传 `container_id`/`node`/`user` 可取**任意容器**
   （如某个 executor / TaskManager），不传则自动定位 AM 容器（需 `yarnRmUrl`）。
5. **一键作业诊断**（diagnostics + AM 日志摘要 + 错误关键行，自动降级）：
   ```
   {category:"yarn",action:"diagnose",args:{application_id:"application_xxx",lines:300}}
   ```
   返回 `overallHealth` / `diagnostics` / `amContainer` / `errorLines` / `logTail` / `findings` / `warnings`。

## 2. 按引擎选日志文件（`file` 参数）

| 引擎 | AM 容器里优先读 | 说明 |
| --- | --- | --- |
| Spark on YARN（cluster 模式） | `stderr` / `stdout` | driver 跑在 AM 里，异常栈通常在 stderr；`stdout` 看打印输出 |
| Spark on YARN（client 模式） | AM 是 executor，driver 在提交机 | AM 日志只有 executor 信息；driver 日志需要运维在提交机/HS2 侧取 |
| Flink on YARN | `jobmanager.log` / `jobmanager.out` | JobManager 在 AM 里；TaskManager 日志要取对应 TM 容器（`container_id` 指定） |
| Hive on MR | `syslog` / `stderr` | MR AM（MRAppMaster）日志在 syslog |
| Hive on Tez | `syslog` / `stderr` | Tez AM（DAGAppMaster）日志在 syslog；看 DAG 失败 vertex |
| Hive on Spark | 同 Spark | HS2 侧另有 HiveServer2 角色日志（`role/logs`） |

> 不确定有哪些文件时，先取 `file:"stderr"`；JHS 页面列出的文件名（stdout/syslog/jobmanager.log/
> taskmanager.log 等）会体现在返回里。executor/TaskManager 级失败要用 `yarn/attempts` 拿不到——
> 它们不是 AM 容器，需要运维从 RM UI / `yarn logs` 拿到具体 `container_id` 后再显式传给 `yarn/logs`。

## 3. 判读要点

- **diagnostics 常见句**：
  - `Application application_xxx failed 2 times due to AM Container for appattempt_xxx exited with exitCode: 1`
    → AM（driver/JobManager）自身异常退出，读 AM 容器 stderr/jobmanager.log 找异常栈。
  - `... exited with exitCode: 137 / 143` → 被 SIGKILL(137)/SIGTERM(143)，常见**物理内存超 cgroup 限额被 NM 杀**
    或人为 kill；看 `pmem`/`vmem` 超限提示，转 `cdh-host-memory`。
  - `... is running beyond physical memory limits` / ` Killing container` → 容器内存超 `spark.executor.memoryOverhead`
    / `mapreduce.map.memory.mb` 等，调内存或 overhead。
  - `Queue's AM resource limit exceeded` / `User's AM resource limit exceeded` → 队列 AM 资源上限，作业卡在 ACCEPTED。
  - `Permission denied` / `AccessControlException` → HDFS/队列权限，核对提交用户与队列 ACL。
- **AM 日志关键行**：`Caused by:` 是根因链最底层；`OutOfMemoryError` 转 `cdh-jvm-oom`；
  `ClassNotFoundException` / `NoSuchMethodError` 多为依赖/版本冲突；`FileNotFoundException` / `Input path does not exist`
  多为输入数据缺失；`Container killed by YARN for exceeding memory limits` 是内存超限。
- **数据倾斜 vs 资源不足**：个别 executor/task 反复失败而多数成功 → 倾斜（看失败 container 的输入分片）；
  全部 pending/ACCEPTED → 队列容量不足（`diagnosis/yarn` 看 apps_pending）。

## 4. 降级与常见误判

- **作业仍在运行**：日志聚合未完成，JHS 取不到（返回页面文本而非 `<pre>`，`source:"fallback"` + warning）。
  运行中作业要看实时日志，需运维用 NM containerlogs 或 RM proxy UI；本插件只取**已聚合**日志。
- **`Logs not available ... Aggregation may not be complete`**：聚合还没落 HDFS，稍后重试；或该 NM 的聚合失败。
- **`Aggregation is not enabled`**：集群没开 `yarn.log-aggregation-enable`，JHS 无日志，只能运维上 NM 本地目录取。
- **ACL 拒绝 / 空正文**：JHS 按 app owner 做 VIEW_APP ACL；非安全模式插件已带 `user.name`，仍拒绝多为 Kerberos 或 ACL 配置。
- **nodeId 端口**：JHS 路径用的是 NM 的 `nodeId`（host:**8041**），不是 HTTP 地址（host:8042）；
  插件优先从 RM `logsLink` 解析准确值，显式传 `node` 时别填成 8042。
- **diagnostics 为空但作业 FAILED**：RM 未记录或 CM 退回模式；直接读 AM 容器日志（第 4 步）。

## 5. 与相邻 skill / 分类的分流

- YARN **服务级**健康（ResourceManager/NodeManager 角色 DOWN、资源争抢）→ `diagnosis/yarn`、`role/diagnose`，不是本卡。
- AM/executor 里出现 `OutOfMemoryError`、GC 停顿 → 本卡定位到容器后转 `cdh-jvm-oom` 读 JVM 参数与堆指标。
- 容器被 137 杀、主机内存水位高、swap 换页 → `cdh-host-memory`；CPU/load 高 → `cdh-host-cpu`。
- 角色（HS2/NameNode 等）自身日志 → `role/logs`；本卡只取 **YARN 容器**聚合日志。

## 6. 交给运维在主机执行的命令（插件不能执行）

```bash
# 作业状态与完整聚合日志（最权威，含所有容器）
yarn application -status application_xxx
yarn logs -applicationId application_xxx                      # 全部容器日志
yarn logs -applicationId application_xxx -am 1                # 只看 AM（driver/JobManager）
yarn logs -applicationId application_xxx -containerId container_xxx   # 指定 executor/TM 容器
yarn logs -applicationId application_xxx -log_files stderr    # 只看某类文件

# 运行中作业（聚合未完成）的实时日志
yarn node -list -all                                          # 找 NM
# 浏览器：RM http://rm:8088/cluster/app/application_xxx → Attempts → logs（NM containerlogs）

# 聚合日志在 HDFS 的落盘位置（核对是否聚合成功）
hdfs dfs -ls /tmp/logs/<user>/logs/application_xxx            # 远程聚合目录（看 yarn.nodemanager.remote-app-log-dir）

# Kerberos 集群：先 kinit 再 yarn logs（插件零依赖做不了 SPNEGO）
kinit -kt /path/to/user.keytab user@REALM
```

判读：`yarn logs -am 1` 的异常栈与插件 `yarn/logs` 取到的 AM 正文应一致；若插件取不到而 CLI 能取，
多半是 `yarnJhsUrl` 配错、聚合未完成或 Kerberos——按第 0/4 节排查。